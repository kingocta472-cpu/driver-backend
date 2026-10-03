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
const REFERRAL_BONUS_CREDITS = 5;

const MIN_RECHARGE_RUPEES = 10;
const CREDIT_PER_RUPEE = 1;

// ============================================================
// FIREBASE INIT
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
        const privateKey =
            process.env.FIREBASE_PRIVATE_KEY;

        if (
            !process.env.FIREBASE_PROJECT_ID ||
            !process.env.FIREBASE_CLIENT_EMAIL ||
            !privateKey
        ) {
            throw new Error(
                'Firebase Admin environment variables are missing.'
            );
        }

        admin.initializeApp({
            credential: admin.credential.cert({
                projectId:
                    process.env.FIREBASE_PROJECT_ID,

                clientEmail:
                    process.env.FIREBASE_CLIENT_EMAIL,

                privateKey:
                    privateKey.replace(/\\n/g, '\n')
            })
        });
    }

    cached.db = admin.firestore();

    return cached.db;
}

// ============================================================
// RAZORPAY INIT
// ============================================================

function getRazorpay() {
    const keyId =
        process.env.RAZORPAY_KEY_ID;

    const keySecret =
        process.env.RAZORPAY_KEY_SECRET;

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

function normalizeReferralCode(code) {
    if (!code) return '';

    return String(code)
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
}

function isValidRechargeAmount(amount) {
    return (
        Number.isFinite(amount) &&
        Number.isInteger(amount) &&
        amount >= MIN_RECHARGE_RUPEES
    );
}

function generateReceipt() {
    const randomPart =
        crypto
            .randomBytes(6)
            .toString('hex');

    return `drp_${Date.now()}_${randomPart}`.slice(
        0,
        40
    );
}

function generateReferralCode() {
    const chars =
        'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

    let code = 'DRP';

    const bytes =
        crypto.randomBytes(7);

    for (let i = 0; i < 7; i++) {
        code +=
            chars[
                bytes[i] % chars.length
            ];
    }

    return code;
}

function verifyRazorpaySignature(
    orderId,
    paymentId,
    signature
) {
    const secret =
        process.env.RAZORPAY_KEY_SECRET;

    if (!secret) {
        throw new Error(
            'Razorpay secret is not configured.'
        );
    }

    const generatedSignature =
        crypto
            .createHmac('sha256', secret)
            .update(
                `${orderId}|${paymentId}`
            )
            .digest('hex');

    if (
        !signature ||
        generatedSignature.length !==
            signature.length
    ) {
        return false;
    }

    return crypto.timingSafeEqual(
        Buffer.from(generatedSignature),
        Buffer.from(signature)
    );
}

// ============================================================
// FIREBASE AUTHENTICATION
// ============================================================

async function verifyFirebaseToken(req, res, next) {
    try {
        const authorization =
            String(
                req.headers.authorization || ''
            );

        if (
            !authorization.startsWith(
                'Bearer '
            )
        ) {
            return res.status(401).json({
                success: false,
                message:
                    'Firebase authentication token required.'
            });
        }

        const idToken =
            authorization
                .substring(7)
                .trim();

        if (!idToken) {
            return res.status(401).json({
                success: false,
                message:
                    'Firebase authentication token required.'
            });
        }

        const decodedToken =
            await admin
                .auth()
                .verifyIdToken(idToken);

        const firebaseUid =
            decodedToken.uid;

        const firebasePhone =
            normalizePhone(
                decodedToken.phone_number
            );

        if (!firebaseUid) {
            return res.status(401).json({
                success: false,
                message:
                    'Invalid Firebase user.'
            });
        }

        if (!firebasePhone) {
            return res.status(401).json({
                success: false,
                message:
                    'Firebase phone number is missing.'
            });
        }

        req.firebaseUser = {
            uid: firebaseUid,
            phone: firebasePhone,
            decodedToken: decodedToken
        };

        next();

    } catch (error) {
        console.error(
            'FIREBASE TOKEN ERROR:',
            error
        );

        return res.status(401).json({
            success: false,
            message:
                'Invalid or expired Firebase authentication token.'
        });
    }
}

// ============================================================
// AUTHENTICATED PHONE CHECK
// ============================================================

function getAuthenticatedPhone(req) {
    if (
        !req.firebaseUser ||
        !req.firebaseUser.phone
    ) {
        return '';
    }

    return normalizePhone(
        req.firebaseUser.phone
    );
}

function phoneMatchesAuthenticatedUser(
    req,
    suppliedPhone
) {
    const authenticatedPhone =
        getAuthenticatedPhone(req);

    const phone =
        normalizePhone(suppliedPhone);

    return (
        authenticatedPhone &&
        phone &&
        authenticatedPhone === phone
    );
}

// ============================================================
// REFERRAL CODE RESERVATION
// ============================================================

async function createUniqueReferralCode(
    db,
    userRef
) {
    for (let attempt = 0; attempt < 10; attempt++) {
        const code =
            generateReferralCode();

        const codeRef =
            db
                .collection('referralCodes')
                .doc(code);

        const existing =
            await codeRef.get();

        if (existing.exists) {
            continue;
        }

        await db.runTransaction(
            async (transaction) => {
                const freshCode =
                    await transaction.get(
                        codeRef
                    );

                if (freshCode.exists) {
                    throw new Error(
                        'REFERRAL_CODE_COLLISION'
                    );
                }

                transaction.set(
                    codeRef,
                    {
                        code: code,
                        userId: userRef.id,
                        createdAt:
                            admin.firestore
                                .FieldValue
                                .serverTimestamp()
                    }
                );
            }
        );

        return code;
    }

    throw new Error(
        'Unable to generate unique referral code.'
    );
}

// ============================================================
// HOME
// ============================================================

app.get('/', (req, res) => {
    res.send(
        'Driver Ride Picker Backend is Running!'
    );
});

// ============================================================
// TEST API
// ============================================================

app.get('/api/test', (req, res) => {
    res.json({
        success: true,
        message:
            'Android app successfully connected to Firebase backend!',
        timestamp:
            new Date().toISOString()
    });
});

// ============================================================
// DB TEST
// ============================================================

app.get(
    '/api/dbtest',
    async (req, res) => {
        try {
            const db = getDB();

            const snapshot =
                await db
                    .collection('users')
                    .limit(1)
                    .get();

            res.json({
                success: true,
                message:
                    'Firebase Firestore connected!',
                userCount:
                    snapshot.size
            });

        } catch (error) {
            console.error(
                'DB TEST ERROR:',
                error
            );

            res.status(500).json({
                success: false,
                message:
                    'DB Error: ' +
                    error.message
            });
        }
    }
);

// ============================================================
// LOGIN / REGISTER
// ============================================================
// Firebase OTP authentication happens in Android.
// Backend verifies the Firebase ID token here.
//
// Optional:
// referralCode
//
// New driver:
// 10 free credits
//
// Valid referral:
// referrer +5 credits
// ============================================================

app.post(
    '/api/auth/login',
    verifyFirebaseToken,
    async (req, res) => {
        try {
            const phone =
                getAuthenticatedPhone(req);

            if (
                !phone ||
                phone.length < 10
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        'Invalid Firebase phone number.'
                });
            }

            const firebaseUid =
                req.firebaseUser.uid;

            const referralCode =
                normalizeReferralCode(
                    req.body.referralCode
                );

            const db = getDB();

            const userRef =
                db
                    .collection('users')
                    .doc(phone);

            const existingUserDoc =
                await userRef.get();

            let isNewUser = false;
            let userData;

            if (!existingUserDoc.exists) {
                // ====================================================
                // NEW USER
                // ====================================================

                let newReferralCode =
                    '';

                // Generate permanent unique referral code.
                newReferralCode =
                    await createUniqueReferralCode(
                        db,
                        userRef
                    );

                let referralApplied = false;
                let referrerPhone = '';

                if (referralCode) {
                    const referralRef =
                        db
                            .collection(
                                'referralCodes'
                            )
                            .doc(
                                referralCode
                            );

                    const referralDoc =
                        await referralRef.get();

                    if (referralDoc.exists) {
                        const referralData =
                            referralDoc.data();

                        referrerPhone =
                            normalizePhone(
                                referralData.userId
                            );

                        // Self-referral protection.
                        if (
                            referrerPhone &&
                            referrerPhone !==
                                phone
                        ) {
                            referralApplied =
                                true;
                        } else {
                            referrerPhone =
                                '';
                        }
                    }
                }

                const newUserData = {
                    phone: phone,

                    firebaseUid:
                        firebaseUid,

                    credits:
                        FREE_START_CREDITS,

                    totalRides: 0,

                    referralCode:
                        newReferralCode,

                    referredBy:
                        referralApplied
                            ? referrerPhone
                            : null,

                    referralApplied:
                        referralApplied,

                    createdAt:
                        admin.firestore
                            .FieldValue
                            .serverTimestamp(),

                    updatedAt:
                        admin.firestore
                            .FieldValue
                            .serverTimestamp()
                };

                const referralLedgerRef =
                    referralApplied
                        ? db
                            .collection(
                                'referralRewards'
                            )
                            .doc(
                                `${referrerPhone}_${phone}`
                            )
                        : null;

                await db.runTransaction(
                    async (transaction) => {
                        const freshUser =
                            await transaction.get(
                                userRef
                            );

                        if (
                            freshUser.exists
                        ) {
                            return;
                        }

                        transaction.set(
                            userRef,
                            newUserData
                        );

                        if (
                            referralApplied &&
                            referralLedgerRef
                        ) {
                            const freshLedger =
                                await transaction.get(
                                    referralLedgerRef
                                );

                            if (
                                !freshLedger.exists
                            ) {
                                transaction.set(
                                    referralLedgerRef,
                                    {
                                        referrerPhone:
                                            referrerPhone,

                                        referredPhone:
                                            phone,

                                        bonusCredits:
                                            REFERRAL_BONUS_CREDITS,

                                        status:
                                            'pending'
                                    }
                                );
                            }
                        }
                    }
                );

                // ====================================================
                // APPLY REFERRAL BONUS ATOMICALLY
                // ====================================================

                if (referralApplied) {
                    const referrerRef =
                        db
                            .collection('users')
                            .doc(
                                referrerPhone
                            );

                    const ledgerRef =
                        db
                            .collection(
                                'referralRewards'
                            )
                            .doc(
                                `${referrerPhone}_${phone}`
                            );

                    await db.runTransaction(
                        async (
                            transaction
                        ) => {
                            const [
                                referrerDoc,
                                ledgerDoc
                            ] =
                                await Promise.all([
                                    transaction.get(
                                        referrerRef
                                    ),
                                    transaction.get(
                                        ledgerRef
                                    )
                                ]);

                            if (
                                !referrerDoc.exists
                            ) {
                                return;
                            }

                            if (
                                !ledgerDoc.exists
                            ) {
                                return;
                            }

                            const ledgerData =
                                ledgerDoc.data();

                            if (
                                ledgerData.status ===
                                'rewarded'
                            ) {
                                return;
                            }

                            const referrerData =
                                referrerDoc.data();

                            const currentCredits =
                                Number(
                                    referrerData.credits ||
                                        0
                                );

                            const updatedCredits =
                                currentCredits +
                                REFERRAL_BONUS_CREDITS;

                            transaction.update(
                                referrerRef,
                                {
                                    credits:
                                        updatedCredits,

                                    updatedAt:
                                        admin
                                            .firestore
                                            .FieldValue
                                            .serverTimestamp()
                                }
                            );

                            transaction.update(
                                ledgerRef,
                                {
                                    status:
                                        'rewarded',

                                    rewardedAt:
                                        admin
                                            .firestore
                                            .FieldValue
                                            .serverTimestamp()
                                }
                            );
                        }
                    );
                }

                const finalUserDoc =
                    await userRef.get();

                userData =
                    finalUserDoc.data() ||
                    newUserData;

                isNewUser = true;

            } else {
                // ====================================================
                // EXISTING USER
                // ====================================================

                userData =
                    existingUserDoc.data();

                const updates = {};

                if (
                    typeof userData.credits !==
                    'number'
                ) {
                    updates.credits =
                        Number(
                            userData.credits ||
                                0
                        );
                }

                if (
                    typeof userData.totalRides !==
                    'number'
                ) {
                    updates.totalRides =
                        Number(
                            userData.totalRides ||
                                0
                        );
                }

                if (
                    !userData.firebaseUid
                ) {
                    updates.firebaseUid =
                        firebaseUid;
                }

                // Existing drivers get a referral code
                // if old account was created before
                // referral system.
                if (
                    !userData.referralCode
                ) {
                    const code =
                        await createUniqueReferralCode(
                            db,
                            userRef
                        );

                    updates.referralCode =
                        code;
                }

                if (
                    Object.keys(updates)
                        .length > 0
                ) {
                    updates.updatedAt =
                        admin.firestore
                            .FieldValue
                            .serverTimestamp();

                    await userRef.update(
                        updates
                    );

                    userData = {
                        ...userData,
                        ...updates
                    };
                }
            }

            res.json({
                success: true,

                isNewUser:
                    isNewUser,

                message:
                    isNewUser
                        ? 'Welcome! 10 free credits added.'
                        : 'Welcome back!',

                user: {
                    phone:
                        userData.phone,

                    firebaseUid:
                        userData.firebaseUid,

                    credits:
                        Number(
                            userData.credits ||
                                0
                        ),

                    totalRides:
                        Number(
                            userData.totalRides ||
                                0
                        ),

                    referralCode:
                        userData.referralCode ||
                        ''
                }
            });

        } catch (error) {
            console.error(
                'LOGIN ERROR:',
                error
            );

            res.status(500).json({
                success: false,
                message:
                    'Server error: ' +
                    error.message
            });
        }
    }
);

// ============================================================
// GET MY REFERRAL DETAILS
// ============================================================

app.get(
    '/api/referral/me',
    verifyFirebaseToken,
    async (req, res) => {
        try {
            const phone =
                getAuthenticatedPhone(req);

            const db = getDB();

            const userDoc =
                await db
                    .collection('users')
                    .doc(phone)
                    .get();

            if (!userDoc.exists) {
                return res.status(404).json({
                    success: false,
                    message:
                        'User not found'
                });
            }

            const data =
                userDoc.data();

            const referralCode =
                data.referralCode || '';

            const rewardsSnapshot =
                await db
                    .collection(
                        'referralRewards'
                    )
                    .where(
                        'referrerPhone',
                        '==',
                        phone
                    )
                    .where(
                        'status',
                        '==',
                        'rewarded'
                    )
                    .get();

            res.json({
                success: true,

                referralCode:
                    referralCode,

                successfulReferrals:
                    rewardsSnapshot.size,

                creditsEarned:
                    rewardsSnapshot.size *
                    REFERRAL_BONUS_CREDITS,

                bonusPerReferral:
                    REFERRAL_BONUS_CREDITS
            });

        } catch (error) {
            console.error(
                'REFERRAL DETAILS ERROR:',
                error
            );

            res.status(500).json({
                success: false,
                message:
                    'Server error: ' +
                    error.message
            });
        }
    }
);

// ============================================================
// BALANCE CHECK
// ============================================================

app.get(
    '/api/user/balance/:phone',
    verifyFirebaseToken,
    async (req, res) => {
        try {
            const phone =
                normalizePhone(
                    req.params.phone
                );

            if (
                !phoneMatchesAuthenticatedUser(
                    req,
                    phone
                )
            ) {
                return res.status(403).json({
                    success: false,
                    message:
                        'Phone does not match authenticated Firebase user.'
                });
            }

            const db = getDB();

            const userDoc =
                await db
                    .collection('users')
                    .doc(phone)
                    .get();

            if (!userDoc.exists) {
                return res.json({
                    success: false,
                    message:
                        'User not found'
                });
            }

            const data =
                userDoc.data();

            res.json({
                success: true,

                credits:
                    Number(
                        data.credits || 0
                    ),

                totalRides:
                    Number(
                        data.totalRides || 0
                    ),

                referralCode:
                    data.referralCode || ''
            });

        } catch (error) {
            console.error(
                'BALANCE ERROR:',
                error
            );

            res.status(500).json({
                success: false,
                message:
                    'Server error: ' +
                    error.message
            });
        }
    }
);

// ============================================================
// RECHARGE CONFIG
// ============================================================

app.get(
    '/api/recharge/config',
    (req, res) => {
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
    }
);

// ============================================================
// CREATE RAZORPAY ORDER
// ============================================================

app.post(
    '/api/recharge/create-order',
    verifyFirebaseToken,
    async (req, res) => {
        try {
            const phone =
                getAuthenticatedPhone(req);

            const amountRupees =
                Number(
                    req.body.amountRupees
                );

            if (
                !phone ||
                phone.length < 10
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        'Valid authenticated phone number required'
                });
            }

            if (
                !isValidRechargeAmount(
                    amountRupees
                )
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        `Minimum recharge is ₹${MIN_RECHARGE_RUPEES} and amount must be a whole number.`
                });
            }

            const db = getDB();

            const userRef =
                db
                    .collection('users')
                    .doc(phone);

            const userDoc =
                await userRef.get();

            if (!userDoc.exists) {
                return res.status(404).json({
                    success: false,
                    message:
                        'User not found'
                });
            }

            const amountPaise =
                amountRupees * 100;

            const creditsToAdd =
                amountRupees *
                CREDIT_PER_RUPEE;

            const razorpay =
                getRazorpay();

            const order =
                await razorpay.orders.create(
                    {
                        amount:
                            amountPaise,

                        currency:
                            'INR',

                        receipt:
                            generateReceipt(),

                        notes: {
                            phone:
                                phone,

                            amountRupees:
                                String(
                                    amountRupees
                                ),

                            credits:
                                String(
                                    creditsToAdd
                                )
                        }
                    }
                );

            await db
                .collection(
                    'rechargeOrders'
                )
                .doc(order.id)
                .set({
                    razorpayOrderId:
                        order.id,

                    phone:
                        phone,

                    amountRupees:
                        amountRupees,

                    amountPaise:
                        amountPaise,

                    creditsToAdd:
                        creditsToAdd,

                    status:
                        'created',

                    createdAt:
                        admin
                            .firestore
                            .FieldValue
                            .serverTimestamp(),

                    updatedAt:
                        admin
                            .firestore
                            .FieldValue
                            .serverTimestamp()
                });

            res.json({
                success: true,

                keyId:
                    process.env
                        .RAZORPAY_KEY_ID,

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
    }
);

// ============================================================
// VERIFY RAZORPAY PAYMENT
// ============================================================

app.post(
    '/api/recharge/verify',
    verifyFirebaseToken,
    async (req, res) => {
        try {
            const phone =
                getAuthenticatedPhone(req);

            const razorpayOrderId =
                String(
                    req.body
                        .razorpayOrderId ||
                        ''
                ).trim();

            const razorpayPaymentId =
                String(
                    req.body
                        .razorpayPaymentId ||
                        ''
                ).trim();

            const razorpaySignature =
                String(
                    req.body
                        .razorpaySignature ||
                        ''
                ).trim();

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

            const orderRef =
                db
                    .collection(
                        'rechargeOrders'
                    )
                    .doc(
                        razorpayOrderId
                    );

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

            if (
                normalizePhone(
                    storedOrder.phone
                ) !== phone
            ) {
                return res.status(403).json({
                    success: false,
                    message:
                        'Payment phone mismatch'
                });
            }

            if (
                storedOrder.status ===
                'paid'
            ) {
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

                    alreadyProcessed:
                        true,

                    message:
                        'Payment already processed',

                    credits:
                        Number(
                            userData.credits ||
                                0
                        )
                });
            }

            const signatureValid =
                verifyRazorpaySignature(
                    storedOrder
                        .razorpayOrderId,
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

            const razorpay =
                getRazorpay();

            const payment =
                await razorpay.payments.fetch(
                    razorpayPaymentId
                );

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

            if (
                Number(payment.amount) !==
                Number(
                    storedOrder.amountPaise
                )
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        'Payment amount mismatch'
                });
            }

            if (
                payment.status !==
                'captured'
            ) {
                return res.status(400).json({
                    success: false,

                    paymentStatus:
                        payment.status,

                    message:
                        'Payment is not captured yet'
                });
            }

            const userRef =
                db
                    .collection('users')
                    .doc(phone);

            let finalCredits = 0;

            await db.runTransaction(
                async (
                    transaction
                ) => {
                    const freshOrderDoc =
                        await transaction.get(
                            orderRef
                        );

                    if (
                        !freshOrderDoc.exists
                    ) {
                        throw new Error(
                            'Payment order not found'
                        );
                    }

                    const freshOrder =
                        freshOrderDoc.data();

                    const userDoc =
                        await transaction.get(
                            userRef
                        );

                    if (
                        !userDoc.exists
                    ) {
                        throw new Error(
                            'User not found'
                        );
                    }

                    const userData =
                        userDoc.data();

                    const currentCredits =
                        Number(
                            userData.credits ||
                                0
                        );

                    if (
                        freshOrder.status ===
                        'paid'
                    ) {
                        finalCredits =
                            currentCredits;

                        return;
                    }

                    const creditsToAdd =
                        Number(
                            freshOrder
                                .creditsToAdd ||
                                0
                        );

                    const updatedCredits =
                        currentCredits +
                        creditsToAdd;

                    transaction.update(
                        userRef,
                        {
                            credits:
                                updatedCredits,

                            updatedAt:
                                admin
                                    .firestore
                                    .FieldValue
                                    .serverTimestamp()
                        }
                    );

                    transaction.update(
                        orderRef,
                        {
                            status:
                                'paid',

                            razorpayPaymentId:
                                razorpayPaymentId,

                            paymentStatus:
                                payment.status,

                            paidAt:
                                admin
                                    .firestore
                                    .FieldValue
                                    .serverTimestamp(),

                            updatedAt:
                                admin
                                    .firestore
                                    .FieldValue
                                    .serverTimestamp()
                        }
                    );

                    const paymentRef =
                        db
                            .collection(
                                'payments'
                            )
                            .doc(
                                razorpayPaymentId
                            );

                    transaction.set(
                        paymentRef,
                        {
                            razorpayOrderId:
                                storedOrder
                                    .razorpayOrderId,

                            razorpayPaymentId:
                                razorpayPaymentId,

                            phone:
                                phone,

                            amountRupees:
                                Number(
                                    storedOrder
                                        .amountRupees
                                ),

                            amountPaise:
                                Number(
                                    storedOrder
                                        .amountPaise
                                ),

                            creditsAdded:
                                creditsToAdd,

                            status:
                                'captured',

                            createdAt:
                                admin
                                    .firestore
                                    .FieldValue
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
    }
);

// ============================================================
// DEDUCT CREDIT - SUCCESSFUL RIDE ONLY
// ============================================================
// 1 successful ride = 1 credit
//
// IMPORTANT:
// Android should call this endpoint ONLY after
// the ride has actually been accepted successfully.
//
// MATCHED / DETECTED / REJECTED:
// NO deduction.
// ============================================================

app.post(
    '/api/ride/deduct-credit',
    verifyFirebaseToken,
    async (req, res) => {
        try {
            const phone =
                getAuthenticatedPhone(req);

            const db = getDB();

            const userRef =
                db
                    .collection('users')
                    .doc(phone);

            let result;

            await db.runTransaction(
                async (
                    transaction
                ) => {
                    const userDoc =
                        await transaction.get(
                            userRef
                        );

                    if (
                        !userDoc.exists
                    ) {
                        throw new Error(
                            'User not found'
                        );
                    }

                    const data =
                        userDoc.data();

                    const currentCredits =
                        Number(
                            data.credits ||
                                0
                        );

                    const totalRides =
                        Number(
                            data.totalRides ||
                                0
                        );

                    if (
                        currentCredits <=
                        0
                    ) {
                        throw new Error(
                            'No credits left. Please recharge.'
                        );
                    }

                    const remainingCredits =
                        currentCredits -
                        1;

                    const updatedTotalRides =
                        totalRides +
                        1;

                    transaction.update(
                        userRef,
                        {
                            credits:
                                remainingCredits,

                            totalRides:
                                updatedTotalRides,

                            updatedAt:
                                admin
                                    .firestore
                                    .FieldValue
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
                    message:
                        error.message
                });
            }

            if (
                error.message ===
                'User not found'
            ) {
                return res.status(404).json({
                    success: false,
                    message:
                        error.message
                });
            }

            res.status(500).json({
                success: false,
                message:
                    'Server error: ' +
                    error.message
            });
        }
    }
);

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
