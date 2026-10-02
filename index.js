const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();

app.use(cors());
app.use(express.json());

// ============================================================
// CONFIG
// ============================================================

const FREE_START_CREDITS = 10;
const MIN_RECHARGE_RUPEES = 10;
const CREDIT_PER_RUPEE = 1;

// ============================================================
// FIREBASE INIT (Vercel-safe, cached)
// ============================================================

let cached = global.firebaseCache;

if (!cached) {
    cached = global.firebaseCache = {
        db: null
    };
}

function getDB() {
    if (cached.db) {
        return cached.db;
    }

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

// ============================================================
// RAZORPAY INIT
// ============================================================

function getRazorpay() {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
        throw new Error(
            'Razorpay keys are missing. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in Vercel Environment Variables.'
        );
    }

    return new Razorpay({
        key_id: keyId,
        key_secret: keySecret
    });
}

// ============================================================
// HELPERS
// ============================================================

function normalizePhone(phone) {
    if (!phone) return '';

    return String(phone)
        .trim()
        .replace(/\s+/g, '');
}

function isValidRechargeAmount(amount) {
    return (
        Number.isFinite(amount) &&
        Number.isInteger(amount) &&
        amount >= MIN_RECHARGE_RUPEES
    );
}

function generateReceipt() {
    const randomPart = crypto
        .randomBytes(6)
        .toString('hex');

    return `drp_${Date.now()}_${randomPart}`.slice(0, 40);
}

function verifyRazorpaySignature(
    orderId,
    paymentId,
    signature
) {
    const secret = process.env.RAZORPAY_KEY_SECRET;

    if (!secret) {
        throw new Error('Razorpay secret is not configured.');
    }

    const generatedSignature =
        crypto
            .createHmac('sha256', secret)
            .update(`${orderId}|${paymentId}`)
            .digest('hex');

    if (
        !signature ||
        generatedSignature.length !== signature.length
    ) {
        return false;
    }

    return crypto.timingSafeEqual(
        Buffer.from(generatedSignature),
        Buffer.from(signature)
    );
}

// ============================================================
// HOME
// ============================================================

app.get('/', (req, res) => {
    res.send('Driver Ride Picker Backend is Running!');
});

// ============================================================
// TEST API
// ============================================================

app.get('/api/test', (req, res) => {
    res.json({
        success: true,
        message: 'Android app successfully connected to Firebase backend!',
        timestamp: new Date().toISOString()
    });
});

// ============================================================
// DB TEST
// ============================================================

app.get('/api/dbtest', async (req, res) => {
    try {
        const db = getDB();

        const snapshot =
            await db.collection('users')
                .limit(1)
                .get();

        res.json({
            success: true,
            message: 'Firebase Firestore connected!',
            userCount: snapshot.size
        });

    } catch (error) {
        console.error('DB TEST ERROR:', error);

        res.status(500).json({
            success: false,
            message: 'DB Error: ' + error.message
        });
    }
});

// ============================================================
// LOGIN / REGISTER
// ============================================================

app.post('/api/auth/login', async (req, res) => {
    try {

        const phone =
            normalizePhone(req.body.phone);

        if (!phone || phone.length < 10) {
            return res.json({
                success: false,
                message: 'Invalid phone number'
            });
        }

        const db = getDB();

        const userRef =
            db.collection('users').doc(phone);

        const userDoc =
            await userRef.get();

        let userData;
        let isNewUser = false;

        if (!userDoc.exists) {

            // New user = 10 free credits
            userData = {
                phone: phone,
                credits: FREE_START_CREDITS,
                totalRides: 0,

                createdAt:
                    admin.firestore.FieldValue.serverTimestamp(),

                updatedAt:
                    admin.firestore.FieldValue.serverTimestamp()
            };

            await userRef.set(userData);

            isNewUser = true;

        } else {

            userData = userDoc.data();

            // Repair old/missing fields safely
            const updates = {};

            if (
                typeof userData.credits !== 'number'
            ) {
                updates.credits = Number(
                    userData.credits || 0
                );
            }

            if (
                typeof userData.totalRides !== 'number'
            ) {
                updates.totalRides = Number(
                    userData.totalRides || 0
                );
            }

            if (Object.keys(updates).length > 0) {
                updates.updatedAt =
                    admin.firestore.FieldValue.serverTimestamp();

                await userRef.update(updates);

                userData = {
                    ...userData,
                    ...updates
                };
            }
        }

        res.json({
            success: true,

            isNewUser: isNewUser,

            message:
                isNewUser
                    ? 'Welcome! 10 free credits added.'
                    : 'Welcome back!',

            user: {
                phone: userData.phone,
                credits: Number(
                    userData.credits || 0
                ),
                totalRides: Number(
                    userData.totalRides || 0
                )
            }
        });

    } catch (error) {

        console.error('LOGIN ERROR:', error);

        res.status(500).json({
            success: false,
            message: 'Server error: ' + error.message
        });
    }
});

// ============================================================
// BALANCE CHECK
// ============================================================

app.get('/api/user/balance/:phone', async (req, res) => {
    try {

        const phone =
            normalizePhone(req.params.phone);

        if (!phone) {
            return res.json({
                success: false,
                message: 'Phone required'
            });
        }

        const db = getDB();

        const userDoc =
            await db.collection('users')
                .doc(phone)
                .get();

        if (!userDoc.exists) {
            return res.json({
                success: false,
                message: 'User not found'
            });
        }

        const data =
            userDoc.data();

        res.json({
            success: true,

            credits: Number(
                data.credits || 0
            ),

            totalRides: Number(
                data.totalRides || 0
            )
        });

    } catch (error) {

        console.error('BALANCE ERROR:', error);

        res.status(500).json({
            success: false,
            message: 'Server error: ' + error.message
        });
    }
});

// ============================================================
// RECHARGE CONFIG
// ============================================================

app.get('/api/recharge/config', (req, res) => {

    res.json({
        success: true,

        minRechargeRupees:
            MIN_RECHARGE_RUPEES,

        rupeesPerCredit:
            1,

        creditsPerRupee:
            CREDIT_PER_RUPEE,

        examples: {
            '10': 10,
            '20': 20,
            '50': 50,
            '100': 100,
            '500': 500,
            '1000': 1000
        },

        message:
            '₹1 = 1 credit. Minimum recharge is ₹10.'
    });
});

// ============================================================
// CREATE RAZORPAY ORDER
// ============================================================
//
// Android sends:
//
// {
//     "phone": "9876543210",
//     "amountRupees": 100
// }
//
// ₹100 => 100 credits
// ₹10  => 10 credits
//
// IMPORTANT:
// Credits are NOT added here.
// They are added only after payment verification.
// ============================================================

app.post('/api/recharge/create-order', async (req, res) => {
    try {

        const phone =
            normalizePhone(req.body.phone);

        const amountRupees =
            Number(req.body.amountRupees);

        if (!phone || phone.length < 10) {
            return res.status(400).json({
                success: false,
                message: 'Valid phone number required'
            });
        }

        if (!isValidRechargeAmount(amountRupees)) {
            return res.status(400).json({
                success: false,
                message:
                    `Minimum recharge is ₹${MIN_RECHARGE_RUPEES} and amount must be a whole number.`
            });
        }

        const db = getDB();

        const userRef =
            db.collection('users').doc(phone);

        const userDoc =
            await userRef.get();

        if (!userDoc.exists) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // ====================================================
        // RUPEES -> PAISE
        // ====================================================

        const amountPaise =
            amountRupees * 100;

        const creditsToAdd =
            amountRupees * CREDIT_PER_RUPEE;

        const razorpay =
            getRazorpay();

        // ====================================================
        // CREATE ORDER
        // ====================================================

        const order =
            await razorpay.orders.create({
                amount: amountPaise,
                currency: 'INR',
                receipt: generateReceipt(),

                notes: {
                    phone: phone,
                    amountRupees:
                        String(amountRupees),
                    credits:
                        String(creditsToAdd)
                }
            });

        // ====================================================
        // STORE ORDER IN FIRESTORE
        // ====================================================

        await db
            .collection('rechargeOrders')
            .doc(order.id)
            .set({
                razorpayOrderId:
                    order.id,

                phone: phone,

                amountRupees:
                    amountRupees,

                amountPaise:
                    amountPaise,

                creditsToAdd:
                    creditsToAdd,

                status: 'created',

                createdAt:
                    admin.firestore.FieldValue.serverTimestamp(),

                updatedAt:
                    admin.firestore.FieldValue.serverTimestamp()
            });

        res.json({
            success: true,

            keyId:
                process.env.RAZORPAY_KEY_ID,

            orderId:
                order.id,

            amount:
                amountPaise,

            currency:
                'INR',

            amountRupees:
                amountRupees,

            creditsToAdd:
                creditsToAdd,

            message:
                'Razorpay order created successfully'
        });

    } catch (error) {

        console.error(
            'CREATE RAZORPAY ORDER ERROR:',
            error
        );

        res.status(500).json({
            success: false,
            message:
                'Unable to create payment order: ' +
                error.message
        });
    }
});

// ============================================================
// VERIFY RAZORPAY PAYMENT
// ============================================================
//
// Android sends:
//
// {
//   "phone": "9876543210",
//   "razorpayOrderId": "order_xxx",
//   "razorpayPaymentId": "pay_xxx",
//   "razorpaySignature": "xxxx"
// }
//
// Only after:
// 1. Correct stored order
// 2. Correct signature
// 3. Correct payment amount
// 4. Payment status = captured
// 5. Order is not already processed
//
// credits are added.
// ============================================================

app.post('/api/recharge/verify', async (req, res) => {
    try {

        const phone =
            normalizePhone(req.body.phone);

        const razorpayOrderId =
            String(
                req.body.razorpayOrderId || ''
            ).trim();

        const razorpayPaymentId =
            String(
                req.body.razorpayPaymentId || ''
            ).trim();

        const razorpaySignature =
            String(
                req.body.razorpaySignature || ''
            ).trim();

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Phone required'
            });
        }

        if (
            !razorpayOrderId ||
            !razorpayPaymentId ||
            !razorpaySignature
        ) {
            return res.status(400).json({
                success: false,
                message:
                    'Incomplete Razorpay payment details'
            });
        }

        const db = getDB();

        // ====================================================
        // GET SERVER-STORED ORDER
        // ====================================================

        const orderRef =
            db.collection('rechargeOrders')
                .doc(razorpayOrderId);

        const orderDoc =
            await orderRef.get();

        if (!orderDoc.exists) {
            return res.status(404).json({
                success: false,
                message:
                    'Payment order not found'
            });
        }

        const storedOrder =
            orderDoc.data();

        // ====================================================
        // PHONE CHECK
        // ====================================================

        if (
            normalizePhone(storedOrder.phone) !== phone
        ) {
            return res.status(403).json({
                success: false,
                message:
                    'Payment phone mismatch'
            });
        }

        // ====================================================
        // ALREADY PROCESSED
        // ====================================================

        if (storedOrder.status === 'paid') {

            const userDoc =
                await db
                    .collection('users')
                    .doc(phone)
                    .get();

            const userData =
                userDoc.exists
                    ? userDoc.data()
                    : {};

            return res.json({
                success: true,
                alreadyProcessed: true,

                message:
                    'Payment already processed',

                credits:
                    Number(
                        userData.credits || 0
                    )
            });
        }

        // ====================================================
        // VERIFY SIGNATURE
        // ====================================================

        const signatureValid =
            verifyRazorpaySignature(
                storedOrder.razorpayOrderId,
                razorpayPaymentId,
                razorpaySignature
            );

        if (!signatureValid) {
            return res.status(400).json({
                success: false,
                message:
                    'Invalid Razorpay signature'
            });
        }

        // ====================================================
        // FETCH PAYMENT FROM RAZORPAY
        // ====================================================

        const razorpay =
            getRazorpay();

        const payment =
            await razorpay.payments.fetch(
                razorpayPaymentId
            );

        // ====================================================
        // PAYMENT ORDER CHECK
        // ====================================================

        if (
            payment.order_id !==
            storedOrder.razorpayOrderId
        ) {
            return res.status(400).json({
                success: false,
                message:
                    'Payment order mismatch'
            });
        }

        // ====================================================
        // AMOUNT CHECK
        // ====================================================

        if (
            Number(payment.amount) !==
            Number(storedOrder.amountPaise)
        ) {
            return res.status(400).json({
                success: false,
                message:
                    'Payment amount mismatch'
            });
        }

        // ====================================================
        // CAPTURE CHECK
        // ====================================================

        if (payment.status !== 'captured') {

            return res.status(400).json({
                success: false,

                paymentStatus:
                    payment.status,

                message:
                    'Payment is not captured yet'
            });
        }

        // ====================================================
        // FIRESTORE TRANSACTION
        // ====================================================
        //
        // Prevents duplicate credit addition if Android
        // sends the verification request multiple times.
        // ====================================================

        const userRef =
            db.collection('users')
                .doc(phone);

        let finalCredits = 0;

        await db.runTransaction(
            async (transaction) => {

                const freshOrderDoc =
                    await transaction.get(
                        orderRef
                    );

                if (!freshOrderDoc.exists) {
                    throw new Error(
                        'Payment order not found'
                    );
                }

                const freshOrder =
                    freshOrderDoc.data();

                // Already paid by another request.
                if (
                    freshOrder.status === 'paid'
                ) {
                    const userDoc =
                        await transaction.get(
                            userRef
                        );

                    const data =
                        userDoc.data() || {};

                    finalCredits =
                        Number(
                            data.credits || 0
                        );

                    return;
                }

                const userDoc =
                    await transaction.get(
                        userRef
                    );

                if (!userDoc.exists) {
                    throw new Error(
                        'User not found'
                    );
                }

                const userData =
                    userDoc.data();

                const currentCredits =
                    Number(
                        userData.credits || 0
                    );

                const creditsToAdd =
                    Number(
                        freshOrder.creditsToAdd || 0
                    );

                const updatedCredits =
                    currentCredits +
                    creditsToAdd;

                // ============================================
                // ADD CREDITS
                // ============================================

                transaction.update(
                    userRef,
                    {
                        credits:
                            updatedCredits,

                        updatedAt:
                            admin.firestore.FieldValue
                                .serverTimestamp()
                    }
                );

                // ============================================
                // MARK PAYMENT AS PAID
                // ============================================

                transaction.update(
                    orderRef,
                    {
                        status: 'paid',

                        razorpayPaymentId:
                            razorpayPaymentId,

                        paymentStatus:
                            payment.status,

                        paidAt:
                            admin.firestore.FieldValue
                                .serverTimestamp(),

                        updatedAt:
                            admin.firestore.FieldValue
                                .serverTimestamp()
                    }
                );

                // ============================================
                // PAYMENT RECORD
                // ============================================

                const paymentRef =
                    db.collection('payments')
                        .doc(razorpayPaymentId);

                transaction.set(
                    paymentRef,
                    {
                        razorpayOrderId:
                            storedOrder.razorpayOrderId,

                        razorpayPaymentId:
                            razorpayPaymentId,

                        phone:
                            phone,

                        amountRupees:
                            Number(
                                storedOrder.amountRupees
                            ),

                        amountPaise:
                            Number(
                                storedOrder.amountPaise
                            ),

                        creditsAdded:
                            creditsToAdd,

                        status:
                            'captured',

                        createdAt:
                            admin.firestore.FieldValue
                                .serverTimestamp()
                    },
                    {
                        merge: true
                    }
                );

                finalCredits =
                    updatedCredits;
            }
        );

        res.json({
            success: true,

            message:
                `${storedOrder.creditsToAdd} credits added successfully`,

            amountRupees:
                storedOrder.amountRupees,

            creditsAdded:
                storedOrder.creditsToAdd,

            credits:
                finalCredits
        });

    } catch (error) {

        console.error(
            'RAZORPAY VERIFY ERROR:',
            error
        );

        res.status(500).json({
            success: false,
            message:
                'Payment verification failed: ' +
                error.message
        });
    }
});

// ============================================================
// DEDUCT CREDIT - SUCCESSFUL RIDE ONLY
// ============================================================
//
// 1 successful ride = 1 credit
//
// Matched ride:
//     NO deduction
//
// Rejected ride:
//     NO deduction
//
// Detected ride:
//     NO deduction
//
// Only call this endpoint AFTER the ride is actually
// confirmed as accepted.
// ============================================================

app.post('/api/ride/deduct-credit', async (req, res) => {
    try {

        const phone =
            normalizePhone(req.body.phone);

        if (!phone) {
            return res.json({
                success: false,
                message: 'Phone required'
            });
        }

        const db = getDB();

        const userRef =
            db.collection('users')
                .doc(phone);

        let result;

        await db.runTransaction(
            async (transaction) => {

                const userDoc =
                    await transaction.get(
                        userRef
                    );

                if (!userDoc.exists) {
                    throw new Error(
                        'User not found'
                    );
                }

                const data =
                    userDoc.data();

                const currentCredits =
                    Number(
                        data.credits || 0
                    );

                const totalRides =
                    Number(
                        data.totalRides || 0
                    );

                if (currentCredits <= 0) {
                    throw new Error(
                        'No credits left. Please recharge.'
                    );
                }

                const remainingCredits =
                    currentCredits - 1;

                const updatedTotalRides =
                    totalRides + 1;

                transaction.update(
                    userRef,
                    {
                        credits:
                            remainingCredits,

                        totalRides:
                            updatedTotalRides,

                        updatedAt:
                            admin.firestore.FieldValue
                                .serverTimestamp()
                    }
                );

                result = {
                    remainingCredits:
                        remainingCredits,

                    totalRides:
                        updatedTotalRides
                };
            }
        );

        res.json({
            success: true,

            message:
                '1 credit deducted for successful ride',

            remainingCredits:
                result.remainingCredits,

            totalRides:
                result.totalRides
        });

    } catch (error) {

        console.error(
            'DEDUCT CREDIT ERROR:',
            error
        );

        if (
            error.message ===
            'No credits left. Please recharge.'
        ) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        if (
            error.message ===
            'User not found'
        ) {
            return res.status(404).json({
                success: false,
                message: error.message
            });
        }

        res.status(500).json({
            success: false,
            message:
                'Server error: ' +
                error.message
        });
    }
});

// ============================================================
// SERVER
// ============================================================

const PORT =
    process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(
        `Server started on port ${PORT}`
    );
});
