const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const MONGODB_URI = "mongodb://kingocta472_db_user:B9rIexKrt0vCX4VL@ac-73kqdqc-shard-00-00.fprt86u.mongodb.net:27017,ac-73kqdqc-shard-00-01.fprt86u.mongodb.net:27017,ac-73kqdqc-shard-00-02.fprt86u.mongodb.net:27017/?ssl=true&replicaSet=atlas-13l5ac-shard-0&authSource=admin&appName=Cluster0";

// VERCEL-SAFE MONGODB CONNECTION
let cached = global.mongoose;
if (!cached) {
    cached = global.mongoose = { conn: null, promise: null };
}

async function connectDB() {
    if (cached.conn) {
        return cached.conn;
    }
    if (!cached.promise) {
        cached.promise = mongoose.connect(MONGODB_URI, {
            bufferCommands: false,
            serverSelectionTimeoutMS: 30000,
            socketTimeoutMS: 45000,
        });
    }
    try {
        cached.conn = await cached.promise;
    } catch (e) {
        cached.promise = null;
        throw e;
    }
    return cached.conn;
}

// USER MODEL
const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    credits: { type: Number, default: 10 },
    createdAt: { type: Date, default: Date.now },
    totalRides: { type: Number, default: 0 }
});

const User = mongoose.models.User || mongoose.model('User', userSchema);

// HOME ROUTE
app.get('/', (req, res) => {
    res.send('Driver Ride Picker Backend is Running!');
});

// TEST API
app.get('/api/test', (req, res) => {
    res.json({ success: true, message: 'Android app successfully connected to backend!', timestamp: new Date().toISOString() });
});

// DB TEST API
app.get('/api/dbtest', async (req, res) => {
    try {
        await connectDB();
        const count = await User.countDocuments();
        res.json({ success: true, message: 'MongoDB connected!', userCount: count });
    } catch (e) {
        res.json({ success: false, message: 'DB Error: ' + e.message });
    }
});

// LOGIN / REGISTER API
app.post('/api/auth/login', async (req, res) => {
    try {
        const { phone } = req.body;

        if (!phone || phone.length < 10) {
            return res.json({ success: false, message: 'Invalid phone number' });
        }

        await connectDB();

        let user = await User.findOne({ phone });
        let isNewUser = false;

        if (!user) {
            user = new User({ phone, credits: 10 });
            await user.save();
            isNewUser = true;
        }

        res.json({
            success: true,
            isNewUser: isNewUser,
            message: isNewUser ? 'Welcome! 10 free credits added.' : 'Welcome back!',
            user: {
                phone: user.phone,
                credits: user.credits,
                totalRides: user.totalRides
            }
        });
    } catch (error) {
        res.json({ success: false, message: 'Server error: ' + error.message });
    }
});

// BALANCE CHECK API
app.get('/api/user/balance/:phone', async (req, res) => {
    try {
        await connectDB();
        const user = await User.findOne({ phone: req.params.phone });
        if (!user) {
            return res.json({ success: false, message: 'User not found' });
        }
        res.json({ success: true, credits: user.credits, totalRides: user.totalRides });
    } catch (error) {
        res.json({ success: false, message: 'Server error: ' + error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
