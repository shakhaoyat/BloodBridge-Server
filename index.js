const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
require("dotenv").config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection Setup
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

async function run() {
      try {
            // Connect to the "BloodBridge" database matching your auth.js configuration
            const db = client.db("BloodBridge");

            // Collections
            const usersCollection = db.collection("user");
            const donationRequestsCollection = db.collection("donationRequests");
            const fundingsCollection = db.collection("fundings"); // Optional: for funding statistics

            console.log("Successfully synchronized connection to MongoDB (BloodBridge).");

            // Helper: validate Mongo ObjectId and respond 400 if invalid.
            // Returns the ObjectId on success, or null after already sending a response.
            const parseObjectId = (id, res) => {
                  if (!ObjectId.isValid(id)) {
                        res.status(400).send({ message: "Invalid id." });
                        return null;
                  }
                  return new ObjectId(id);
            };

            app.get('/api/dashboard/stats', async (req, res) => {
                  try {
                        const totalDonors = await usersCollection.countDocuments({ role: "Donor" });
                        const totalRequests = await donationRequestsCollection.countDocuments();

                        // Total funding aggregator (sums all micro-donations received)
                        const fundingAggregation = await fundingsCollection.aggregate([
                              { $group: { _id: null, total: { $sum: "$amount" } } }
                        ]).toArray();
                        const totalFunding = fundingAggregation[0]?.total || 0;

                        res.send({ totalDonors, totalFunding, totalRequests });
                  } catch (error) {
                        console.error('[/api/dashboard/stats] error:', error);
                        res.status(500).send({ message: "Failed to load dashboard metrics.", error: error.message });
                  }
            });

            // Escapes regex special characters so values like "A+" or "AB-" are
            // matched literally instead of being interpreted as regex syntax.
            const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            app.get('/api/users', async (req, res) => {
                  try {
                        const { status, role } = req.query;
                        let query = {};
                        if (status && status !== 'all') {
                              // Case-insensitive match so "active"/"Active"/"ACTIVE" all work
                              query.status = { $regex: `^${escapeRegex(status)}$`, $options: 'i' };
                        }
                        if (role) {
                              query.role = { $regex: `^${escapeRegex(role)}$`, $options: 'i' };
                        }
                        const result = await usersCollection.find(query).toArray();
                        res.send(result);
                  } catch (error) {
                        console.error('[/api/users GET] error:', error);
                        res.status(500).send({ message: "Failed to retrieve user accounts.", error: error.message });
                  }
            });

            // Public donor/volunteer search — used by the "Search Donors" page.
            // Matches users whose role is Donor or Volunteer, status Active,
            // with optional name / bloodGroup / district / upazila filters.
            app.get('/api/donors', async (req, res) => {
                  try {
                        const { name, bloodGroup, district, upazila } = req.query;

                        const query = {
                              role: { $in: [/^donor$/i, /^volunteer$/i] },
                              status: { $regex: '^active$', $options: 'i' },
                        };

                        if (name) {
                              query.name = { $regex: escapeRegex(name), $options: 'i' };
                        }
                        if (bloodGroup) {
                              query.bloodGroup = { $regex: `^${escapeRegex(bloodGroup)}$`, $options: 'i' };
                        }
                        if (district) {
                              query.district = { $regex: `^${escapeRegex(district)}$`, $options: 'i' };
                        }
                        if (upazila) {
                              query.upazila = { $regex: `^${escapeRegex(upazila)}$`, $options: 'i' };
                        }

                        const result = await usersCollection.find(query).toArray();
                        res.send(result);
                  } catch (error) {
                        console.error('[/api/donors] error:', error);
                        res.status(500).send({ message: "Failed to search donors.", error: error.message });
                  }
            });

            // ── Self-service profile update ──────────────────────────────────
            // Used by the logged-in user's own "My Profile" page to update their
            // own name / avatar / blood group / district / upazila.
            // Intentionally does NOT allow changing `role` or `status` — that's
            // handled separately below via the admin-only route, so a user can't
            // promote themselves to Admin by hitting this endpoint.
            app.patch('/api/users/:id', async (req, res) => {
                  try {
                        const id = parseObjectId(req.params.id, res);
                        if (!id) return;

                        const allowedFields = ['name', 'avatar', 'bloodGroup', 'district', 'upazila'];
                        const updateDoc = { $set: {} };
                        for (const key of allowedFields) {
                              if (req.body[key] !== undefined) {
                                    updateDoc.$set[key] = req.body[key];
                              }
                        }

                        if (Object.keys(updateDoc.$set).length === 0) {
                              return res.status(400).send({ message: "No valid profile fields provided." });
                        }

                        const result = await usersCollection.updateOne({ _id: id }, updateDoc);

                        if (result.matchedCount === 0) {
                              return res.status(404).send({ message: "User not found." });
                        }

                        res.send(result);
                  } catch (error) {
                        console.error('[/api/users/:id PATCH] error:', error);
                        res.status(500).send({ message: "Profile update failed.", error: error.message });
                  }
            });

            // ── Admin: role / status management ──────────────────────────────
            // TODO: protect this route with admin-only auth middleware before
            // going to production — currently anyone who can reach this server
            // can promote/demote/block any user.
            app.patch('/api/users/:id/admin', async (req, res) => {
                  try {
                        const id = parseObjectId(req.params.id, res);
                        if (!id) return;

                        const { status, role } = req.body;
                        const updateDoc = { $set: {} };
                        if (status) updateDoc.$set.status = status;
                        if (role) updateDoc.$set.role = role;

                        if (Object.keys(updateDoc.$set).length === 0) {
                              return res.status(400).send({ message: "No valid fields (status/role) provided." });
                        }

                        const result = await usersCollection.updateOne({ _id: id }, updateDoc);

                        if (result.matchedCount === 0) {
                              return res.status(404).send({ message: "User not found." });
                        }

                        res.send(result);
                  } catch (error) {
                        console.error('[/api/users/:id/admin PATCH] error:', error);
                        res.status(500).send({ message: "Administrative privilege update failed.", error: error.message });
                  }
            });

            // ── Funding: list all funds (admin/volunteer view) ─────────────────
            // Returns every funding record, newest first, with donor name/amount/date.
            app.get('/api/fundings', async (req, res) => {
                  try {
                        const result = await fundingsCollection.find().sort({ createdAt: -1 }).toArray();
                        res.send(result);
                  } catch (error) {
                        console.error('[/api/fundings GET] error:', error);
                        res.status(500).send({ message: "Failed to load funding records.", error: error.message });
                  }
            });

            // ── Funding: total amount raised ────────────────────────────────────
            // Lightweight endpoint for dashboard cards — avoids shipping every
            // funding row just to show one number.
            app.get('/api/fundings/total', async (req, res) => {
                  try {
                        const agg = await fundingsCollection.aggregate([
                              { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }
                        ]).toArray();
                        res.send({
                              totalFunding: agg[0]?.total || 0,
                              totalDonations: agg[0]?.count || 0,
                        });
                  } catch (error) {
                        console.error('[/api/fundings/total] error:', error);
                        res.status(500).send({ message: "Failed to calculate total funding.", error: error.message });
                  }
            });

            // ── Funding: create a Stripe PaymentIntent ──────────────────────────
            // Client sends a USD amount in dollars; we convert to cents server-side
            // so the client can never tamper with what Stripe actually charges.
            app.post('/api/fundings/create-payment-intent', async (req, res) => {
                  try {
                        const { amount } = req.body;
                        const numericAmount = Number(amount);

                        if (!numericAmount || numericAmount <= 0) {
                              return res.status(400).send({ message: "Enter an amount greater than 0." });
                        }
                        // Stripe minimum charge is $0.50 USD.
                        if (numericAmount < 0.5) {
                              return res.status(400).send({ message: "Minimum donation is $0.50." });
                        }

                        const amountInCents = Math.round(numericAmount * 100);

                        const paymentIntent = await stripe.paymentIntents.create({
                              amount: amountInCents,
                              currency: 'usd',
                              automatic_payment_methods: { enabled: true },
                        });

                        res.send({ clientSecret: paymentIntent.client_secret });
                  } catch (error) {
                        console.error('[/api/fundings/create-payment-intent] error:', error);
                        res.status(500).send({ message: "Could not start payment.", error: error.message });
                  }
            });

            // ── Funding: record a completed donation ────────────────────────────
            // Called by the client once Stripe confirms the PaymentIntent succeeded.
            // Re-verifies the PaymentIntent with Stripe directly rather than trusting
            // the client's word, so a forged request can't fabricate a funding row.
            app.post('/api/fundings', async (req, res) => {
                  try {
                        const { paymentIntentId, name, email } = req.body;

                        if (!paymentIntentId) {
                              return res.status(400).send({ message: "Missing payment reference." });
                        }

                        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

                        if (paymentIntent.status !== 'succeeded') {
                              return res.status(400).send({ message: "Payment has not completed yet." });
                        }

                        // Avoid double-recording if the client retries the request.
                        const existing = await fundingsCollection.findOne({ paymentIntentId });
                        if (existing) {
                              return res.send(existing);
                        }

                        const fundingDoc = {
                              name: name || 'Anonymous',
                              email: email || null,
                              amount: paymentIntent.amount / 100,
                              currency: paymentIntent.currency,
                              paymentIntentId,
                              createdAt: new Date(),
                        };

                        const result = await fundingsCollection.insertOne(fundingDoc);
                        res.send({ ...fundingDoc, _id: result.insertedId });
                  } catch (error) {
                        console.error('[/api/fundings POST] error:', error);
                        res.status(500).send({ message: "Failed to record funding.", error: error.message });
                  }
            });

            app.post('/api/donation-requests', async (req, res) => {
                  try {
                        const requestPayload = req.body;

                        // Safety lock check: Ensure user isn't blocked right before creation
                        const activeUserCheck = await usersCollection.findOne({ email: requestPayload.requesterEmail });
                        if (activeUserCheck && activeUserCheck.status === "Blocked") {
                              return res.status(403).send({ message: "Operation barred. Blocked users cannot create donation requests." });
                        }

                        // Enforce systematic default values
                        const finalDocument = {
                              ...requestPayload,
                              donationStatus: "pending",
                              createdAt: new Date()
                        };

                        const result = await donationRequestsCollection.insertOne(finalDocument);
                        res.send(result);
                  } catch (error) {
                        console.error('[/api/donation-requests POST] error:', error);
                        res.status(500).send({ message: "Failed to create donation request entry.", error: error.message });
                  }
            });

            app.get('/api/donation-requests', async (req, res) => {
                  try {
                        const { email, status } = req.query;
                        let query = {};

                        if (email) query.requesterEmail = email;
                        if (status && status !== 'all') query.donationStatus = status;

                        const result = await donationRequestsCollection.find(query).sort({ createdAt: -1 }).toArray();
                        res.send(result);
                  } catch (error) {
                        console.error('[/api/donation-requests GET] error:', error);
                        res.status(500).send({ message: "Failed to fetch blood requests matrix.", error: error.message });
                  }
            });

            app.get('/api/donation-requests/:id', async (req, res) => {
                  try {
                        const id = parseObjectId(req.params.id, res);
                        if (!id) return;

                        const result = await donationRequestsCollection.findOne({ _id: id });

                        if (!result) {
                              return res.status(404).send({ message: "Donation request not found." });
                        }

                        res.send(result);
                  } catch (error) {
                        console.error('[/api/donation-requests/:id GET] error:', error);
                        res.status(500).send({ message: "Failed to find requested target profile record.", error: error.message });
                  }
            });

            app.put('/api/donation-requests/:id', async (req, res) => {
                  try {
                        const id = parseObjectId(req.params.id, res);
                        if (!id) return;

                        const updatedFields = { ...req.body };
                        // Never allow the client to overwrite immutable/system fields.
                        delete updatedFields._id;
                        delete updatedFields.createdAt;

                        if (Object.keys(updatedFields).length === 0) {
                              return res.status(400).send({ message: "No valid fields provided." });
                        }

                        const result = await donationRequestsCollection.updateOne(
                              { _id: id },
                              { $set: updatedFields }
                        );

                        if (result.matchedCount === 0) {
                              return res.status(404).send({ message: "Donation request not found." });
                        }

                        res.send(result);
                  } catch (error) {
                        console.error('[/api/donation-requests/:id PUT] error:', error);
                        res.status(500).send({ message: "Failed to rewrite ledger fields.", error: error.message });
                  }
            });

            app.delete('/api/donation-requests/:id', async (req, res) => {
                  try {
                        const id = parseObjectId(req.params.id, res);
                        if (!id) return;

                        const result = await donationRequestsCollection.deleteOne({ _id: id });

                        if (result.deletedCount === 0) {
                              return res.status(404).send({ message: "Donation request not found." });
                        }

                        res.send(result);
                  } catch (error) {
                        console.error('[/api/donation-requests/:id DELETE] error:', error);
                        res.status(500).send({ message: "Critical error encountered deleting entry document.", error: error.message });
                  }
            });

      } catch (err) {
            console.error("Initialization anomaly encountered inside database engine:", err);
      }
}

run().catch(console.dir);

app.get('/', (req, res) => {
      res.send('BloodBridge Core Platform Server Engine Active');
});

app.listen(port, () => {
      console.log(`BloodBridge microservices running securely on port ${port}`);
});