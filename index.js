const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// ===== FIREBASE INIT (Vercel-safe, cached) =====
let cached = global.firebaseCache;
if (!cached) {
    cached = global.firebaseCache = { db: null };
}

function getDB() {
    if (cached.db) return cached.db;

    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            }),
        });
    }
    cached.db = admin.firestore();
    return cached.db;
}

// ===== HOME =====
app.get('/', (req, res) => {
    res.send('Driver Ride Picker Backend is Running!');
});

// ===== TEST API =====
app.get('/api/test', (req, res) => {
    res.json({
        success: true,
        message: 'Android app successfully connected to Firebase backend!',
        timestamp: new Date().toISOString()
    });
});

// ===== DB TEST =====
app.get('/api/dbtest', async (req, res) => {
    try {
        const db = getDB();
        const snapshot = await db.collection('users').limit(1).get();
        res.json({
            success: true,
            message: 'Firebase Firestore connected!',
            userCount: snapshot.size
        });
    } catch (e) {
        res.json({ success: false, message: 'DB Error: ' + e.message });
    }
});

// ===== LOGIN / REGISTER =====
app.post('/api/auth/login', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone || phone.length < 10) {
            return res.json({ success: false, message: 'Invalid phone number' });
        }

        const db = getDB();
        const userRef = db.collection('users').doc(phone);
        const userDoc = await userRef.get();

        let userData;
        let isNewUser = false;

        if (!userDoc.exists) {
            // Naya user - 10 free credits
            userData = {
                phone: phone,
                credits: 10,
                totalRides: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            };
            await userRef.set(userData);
            isNewUser = true;
        } else {
            userData = userDoc.data();
        }

        res.json({
            success: true,
            isNewUser: isNewUser,
            message: isNewUser ? 'Welcome! 10 free credits added.' : 'Welcome back!',
            user: {
                phone: userData.phone,
                credits: userData.credits,
                totalRides: userData.totalRides || 0
            }
        });
    } catch (error) {
        res.json({ success: false, message: 'Server error: ' + error.message });
    }
});

// ===== BALANCE CHECK =====
app.get('/api/user/balance/:phone', async (req, res) => {
    try {
        const db = getDB();
        const userDoc = await db.collection('users').doc(req.params.phone).get();

        if (!userDoc.exists) {
            return res.json({ success: false, message: 'User not found' });
        }
        const data = userDoc.data();
        res.json({
            success: true,
            credits: data.credits,
            totalRides: data.totalRides || 0
        });
    } catch (error) {
        res.json({ success: false, message: 'Server error: ' + error.message });
    }
});

// ===== DEDUCT CREDIT (Bot ke liye) =====
app.post('/api/ride/deduct-credit', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) {
            return res.json({ success: false, message: 'Phone required' });
        }

        const db = getDB();
        const userRef = db.collection('users').doc(phone);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            return res.json({ success: false, message: 'User not found' });
        }

        const data = userDoc.data();
        if (data.credits <= 0) {
            return res.json({ success: false, message: 'No credits left. Please recharge.' });
        }

        await userRef.update({
            credits: data.credits - 1,
            totalRides: (data.totalRides || 0) + 1
        });

        res.json({
            success: true,
            message: '1 credit deducted',
            remainingCredits: data.credits - 1
        });
    } catch (error) {
        res.json({ success: false, message: 'Server error: ' + error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
