const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
require("dotenv").config();

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
                        res.status(500).send({ message: "Failed to load dashboard metrics.", error });
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
                        res.status(500).send({ message: "Failed to retrieve user accounts.", error });
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

          
            app.patch('/api/users/:id', async (req, res) => {
                  try {
                        const id = req.params.id;
                        const { status, role } = req.body;

                        let updateDoc = { $set: {} };
                        if (status) updateDoc.$set.status = status; 
                        if (role) updateDoc.$set.role = role;      

                        const filter = { _id: new ObjectId(id) };
                        const result = await usersCollection.updateOne(filter, updateDoc);
                        res.send(result);
                  } catch (error) {
                        res.status(500).send({ message: "Administrative privilege update failed.", error });
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
                        res.status(500).send({ message: "Failed to create donation request entry.", error });
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
                        res.status(500).send({ message: "Failed to fetch blood requests matrix.", error });
                  }
            });

            app.get('/api/donation-requests/:id', async (req, res) => {
                  try {
                        const id = req.params.id;
                        const result = await donationRequestsCollection.findOne({ _id: new ObjectId(id) });
                        res.send(result);
                  } catch (error) {
                        res.status(500).send({ message: "Failed to find requested target profile record.", error });
                  }
            });

            app.put('/api/donation-requests/:id', async (req, res) => {
                  try {
                        const id = req.params.id;
                        const updatedFields = req.body;
                        const filter = { _id: new ObjectId(id) };

                        const updateDoc = {
                              $set: updatedFields
                        };

                        const result = await donationRequestsCollection.updateOne(filter, updateDoc);
                        res.send(result);
                  } catch (error) {
                        res.status(500).send({ message: "Failed to rewrite ledger fields.", error });
                  }
            });

            app.delete('/api/donation-requests/:id', async (req, res) => {
                  try {
                        const id = req.params.id;
                        const filter = { _id: new ObjectId(id) };
                        const result = await donationRequestsCollection.deleteOne(filter);
                        res.send(result);
                  } catch (error) {
                        res.status(500).send({ message: "Critical error encountered deleting entry document.", error });
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