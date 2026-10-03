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

// 6-DIGIT PIN AUTH
const PIN_LENGTH = 6;
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

// Installation identity
const INSTALL_ID_MAX_LENGTH = 200;

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
                    privateKey.replace(
                        /\\n/g,
                        '\n'
                    )
            })
        });
    }

    cached.db =
        admin.firestore();

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
    if (!phone) {
        return '';
    }

    const digits =
        String(phone)
            .trim()
            .replace(/\D/g, '');

    // 10 digit Indian number
    if (
        digits.length === 10 &&
        /^[6-9]/.test(digits)
    ) {
        return digits;
    }

    // +91XXXXXXXXXX / 91XXXXXXXXXX
    if (
        digits.length === 12 &&
        digits.startsWith('91') &&
        /^[6-9]/.test(
            digits.slice(2)
        )
    ) {
        return digits.slice(2);
    }

    return '';
}

function normalizeInstallId(
    installId
) {
    if (!installId) {
        return '';
    }

    return String(
        installId
    )
        .trim()
        .slice(
            0,
            INSTALL_ID_MAX_LENGTH
        );
}

function normalizeReferralCode(
    code
) {
    if (!code) {
        return '';
    }

    return String(code)
        .trim()
        .toUpperCase()
        .replace(
            /[^A-Z0-9]/g,
            ''
        );
}

function isValidRechargeAmount(
    amount
) {
    return (
        Number.isFinite(amount) &&
        Number.isInteger(amount) &&
        amount >=
            MIN_RECHARGE_RUPEES
    );
}

function isValidPin(pin) {
    return new RegExp(
        `^\\d{${PIN_LENGTH}}$`
    ).test(
        String(pin || '').trim()
    );
}

// ============================================================
// PIN HASH
// ============================================================

function createPinHash(
    pin
) {
    const salt =
        crypto
            .randomBytes(16)
            .toString('hex');

    const hash =
        crypto.scryptSync(
            String(pin).trim(),
            salt,
            64,
            {
                N: 16384,
                r: 8,
                p: 1,
                maxmem:
                    32 *
                    1024 *
                    1024
            }
        )
        .toString('hex');

    return {
        pinSalt: salt,
        pinHash: hash
    };
}

function verifyPinHash(
    pin,
    salt,
    expectedHash
) {
    if (
        !isValidPin(pin) ||
        !salt ||
        !expectedHash
    ) {
        return false;
    }

    try {
        const actual =
            crypto.scryptSync(
                String(pin).trim(),
                String(salt),
                64,
                {
                    N: 16384,
                    r: 8,
                    p: 1,
                    maxmem:
                        32 *
                        1024 *
                        1024
                }
            );

        const expected =
            Buffer.from(
                String(expectedHash),
                'hex'
            );

        return (
            actual.length ===
                expected.length &&
            crypto.timingSafeEqual(
                actual,
                expected
            )
        );

    } catch (error) {

        console.error(
            'PIN VERIFY ERROR:',
            error
        );

        return false;
    }
}

// ============================================================
// HASH HELPERS
// ============================================================

function hashInstallId(
    installId
) {
    return crypto
        .createHash('sha256')
        .update(
            `driver-ride-picker-install:${installId}`
        )
        .digest('hex');
}

function hashPhoneForAuth(
    phone
) {
    return crypto
        .createHash('sha256')
        .update(
            `driver-ride-picker-auth:${phone}`
        )
        .digest('hex');
}

// ============================================================
// STABLE DRIVER FIREBASE UID
// ============================================================

function generateDriverFirebaseUid(
    phone
) {
    const projectId =
        process.env.FIREBASE_PROJECT_ID ||
        'driver-ride-picker';

    const digest =
        crypto
            .createHash('sha256')
            .update(
                `driver:${projectId}:${phone}`
            )
            .digest('hex');

    return `driver_${digest}`;
}

// ============================================================
// RAZORPAY HELPERS
// ============================================================

function generateReceipt() {
    const randomPart =
        crypto
            .randomBytes(6)
            .toString('hex');

    return `drp_${Date.now()}_${randomPart}`
        .slice(
            0,
            40
        );
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

    const generated =
        crypto
            .createHmac(
                'sha256',
                secret
            )
            .update(
                `${orderId}|${paymentId}`
            )
            .digest('hex');

    if (
        !signature ||
        generated.length !==
            signature.length
    ) {
        return false;
    }

    return crypto.timingSafeEqual(
        Buffer.from(generated),
        Buffer.from(signature)
    );
}

// ============================================================
// FIREBASE APP CHECK
// ============================================================

function getAppCheckService() {

    if (
        typeof admin.appCheck ===
        'function'
    ) {
        return admin.appCheck();
    }

    const appCheckModule =
        require(
            'firebase-admin/app-check'
        );

    return appCheckModule
        .getAppCheck();
}

async function verifyAppCheckHeader(
    req
) {
    const appCheckToken =
        String(
            req.headers[
                'x-firebase-appcheck'
            ] || ''
        ).trim();

    if (!appCheckToken) {
        const error =
            new Error(
                'Firebase App Check token required.'
            );

        error.statusCode = 401;

        throw error;
    }

    return getAppCheckService()
        .verifyToken(
            appCheckToken
        );
}

// ============================================================
// FIREBASE ID TOKEN
// ============================================================

async function decodeFirebaseToken(
    req
) {
    const authorization =
        String(
            req.headers.authorization ||
            ''
        );

    if (
        !authorization.startsWith(
            'Bearer '
        )
    ) {
        const error =
            new Error(
                'Firebase authentication token required.'
            );

        error.statusCode = 401;

        throw error;
    }

    const idToken =
        authorization
            .substring(7)
            .trim();

    if (!idToken) {
        const error =
            new Error(
                'Firebase authentication token required.'
            );

        error.statusCode = 401;

        throw error;
    }

    return admin
        .auth()
        .verifyIdToken(
            idToken
        );
}

// ============================================================
// APP CHECK MIDDLEWARE
// ============================================================

async function verifyFirebaseAppCheck(
    req,
    res,
    next
) {
    try {

        req.appCheck =
            await verifyAppCheckHeader(
                req
            );

        next();

    } catch (error) {

        console.error(
            'FIREBASE APP CHECK ERROR:',
            error
        );

        res.status(401).json({
            success: false,
            message:
                error.message ||
                'Invalid or expired Firebase App Check token.'
        });
    }
}

// ============================================================
// FIREBASE IDENTITY MIDDLEWARE
// ============================================================

async function verifyFirebaseIdentity(
    req,
    res,
    next
) {
    try {

        const decoded =
            await decodeFirebaseToken(
                req
            );

        if (!decoded.uid) {
            return res.status(401).json({
                success: false,
                message:
                    'Invalid Firebase user.'
            });
        }

        req.firebaseUser = {
            uid:
                decoded.uid,

            signInProvider:
                decoded.firebase &&
                decoded.firebase
                    .sign_in_provider
                    ? String(
                        decoded.firebase
                            .sign_in_provider
                    )
                    : '',

            decodedToken:
                decoded
        };

        next();

    } catch (error) {

        console.error(
            'FIREBASE IDENTITY ERROR:',
            error
        );

        res.status(
            error.statusCode ||
            401
        ).json({
            success: false,
            message:
                error.message ||
                'Invalid or expired Firebase authentication token.'
        });
    }
}

// ============================================================
// AUTHENTICATED DRIVER MIDDLEWARE
// ============================================================

async function verifyFirebaseToken(
    req,
    res,
    next
) {
    try {

        // -------------------------
        // APP CHECK
        // -------------------------

        req.appCheck =
            await verifyAppCheckHeader(
                req
            );

        // -------------------------
        // FIREBASE ID TOKEN
        // -------------------------

        const decoded =
            await decodeFirebaseToken(
                req
            );

        if (!decoded.uid) {
            return res.status(401).json({
                success: false,
                message:
                    'Invalid Firebase user.'
            });
        }

        const signInProvider =
            decoded.firebase &&
            decoded.firebase
                .sign_in_provider
                ? String(
                    decoded.firebase
                        .sign_in_provider
                )
                : '';

        // Anonymous account is only
        // allowed for bootstrap login.
        if (
            signInProvider ===
            'anonymous'
        ) {
            return res.status(401).json({
                success: false,
                message:
                    'Driver PIN authentication required.'
            });
        }

        // -------------------------
        // FIND DRIVER
        // -------------------------

        const db =
            getDB();

        const snapshot =
            await db
                .collection(
                    'users'
                )
                .where(
                    'firebaseUid',
                    '==',
                    decoded.uid
                )
                .limit(1)
                .get();

        if (
            snapshot.empty
        ) {
            return res.status(401).json({
                success: false,
                message:
                    'Driver account authentication required.'
            });
        }

        const userDoc =
            snapshot.docs[0];

        const userData =
            userDoc.data() || {};

        req.firebaseUser = {

            uid:
                decoded.uid,

            phone:
                normalizePhone(
                    userData.phone ||
                    userDoc.id
                ),

            signInProvider:
                signInProvider,

            decodedToken:
                decoded,

            userData:
                userData
        };

        req.driverUser =
            userData;

        next();

    } catch (error) {

        console.error(
            'FIREBASE TOKEN ERROR:',
            error
        );

        res.status(401).json({
            success: false,
            message:
                error.message ||
                'Invalid or expired Firebase authentication token.'
        });
    }
}

// ============================================================
// AUTHENTICATED PHONE
// ============================================================

function getAuthenticatedPhone(
    req
) {
    return normalizePhone(
        req.firebaseUser?.phone ||
        ''
    );
}

function phoneMatchesAuthenticatedUser(
    req,
    suppliedPhone
) {
    const authenticatedPhone =
        getAuthenticatedPhone(
            req
        );

    const phone =
        normalizePhone(
            suppliedPhone
        );

    return Boolean(
        authenticatedPhone &&
        phone &&
        authenticatedPhone ===
            phone
    );
}

// ============================================================
// PIN LOCK
// ============================================================

async function getPinLockState(
    db,
    phone
) {
    const ref =
        db
            .collection(
                'authAttempts'
            )
            .doc(
                hashPhoneForAuth(
                    phone
                )
            );

    const snapshot =
        await ref.get();

    if (!snapshot.exists) {
        return {
            locked: false,
            lockedUntilMs: 0
        };
    }

    const data =
        snapshot.data() || {};

    const lockedUntilMs =
        Number(
            data.lockedUntilMs ||
            0
        );

    return {
        locked:
            lockedUntilMs >
            Date.now(),

        lockedUntilMs:
            lockedUntilMs
    };
}

async function recordPinFailure(
    db,
    phone
) {
    const ref =
        db
            .collection(
                'authAttempts'
            )
            .doc(
                hashPhoneForAuth(
                    phone
                )
            );

    let result = {
        failures: 1,
        locked: false,
        lockedUntilMs: 0
    };

    await db.runTransaction(
        async transaction => {

            const snapshot =
                await transaction.get(
                    ref
                );

            const data =
                snapshot.exists
                    ? (
                        snapshot.data() ||
                        {}
                    )
                    : {};

            const now =
                Date.now();

            const existingLockUntil =
                Number(
                    data.lockedUntilMs ||
                    0
                );

            if (
                existingLockUntil >
                now
            ) {

                result = {
                    failures:
                        Number(
                            data.failures ||
                            0
                        ),

                    locked:
                        true,

                    lockedUntilMs:
                        existingLockUntil
                };

                return;
            }

            const failures =
                Number(
                    data.failures ||
                    0
                ) + 1;

            const locked =
                failures >=
                PIN_MAX_ATTEMPTS;

            const lockedUntilMs =
                locked
                    ? (
                        now +
                        PIN_LOCK_MINUTES *
                        60 *
                        1000
                    )
                    : 0;

            transaction.set(
                ref,
                {
                    failures:
                        failures,

                    lockedUntilMs:
                        lockedUntilMs,

                    lastFailedAt:
                        admin.firestore
                            .FieldValue
                            .serverTimestamp()
                },
                {
                    merge: true
                }
            );

            result = {
                failures:
                    failures,

                locked:
                    locked,

                lockedUntilMs:
                    lockedUntilMs
            };
        }
    );

    return result;
}

async function clearPinFailures(
    db,
    phone
) {
    await db
        .collection(
            'authAttempts'
        )
        .doc(
            hashPhoneForAuth(
                phone
            )
        )
        .delete();
}

// ============================================================
// UNIQUE REFERRAL CODE
// ============================================================

async function createUniqueReferralCode(
    db,
    userRef
) {
    for (
        let attempt = 0;
        attempt < 10;
        attempt++
    ) {

        const code =
            generateReferralCode();

        const codeRef =
            db
                .collection(
                    'referralCodes'
                )
                .doc(code);

        const existing =
            await codeRef.get();

        if (
            existing.exists
        ) {
            continue;
        }

        try {

            await db.runTransaction(
                async transaction => {

                    const freshCode =
                        await transaction.get(
                            codeRef
                        );

                    if (
                        freshCode.exists
                    ) {
                        throw new Error(
                            'REFERRAL_CODE_COLLISION'
                        );
                    }

                    transaction.set(
                        codeRef,
                        {
                            code:
                                code,

                            userId:
                                userRef.id,

                            createdAt:
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp()
                        }
                    );
                }
            );

            return code;

        } catch (error) {

            if (
                error.message !==
                'REFERRAL_CODE_COLLISION'
            ) {
                throw error;
            }
        }
    }

    throw new Error(
        'Unable to generate unique referral code.'
    );
}

// ============================================================
// HOME
// ============================================================

app.get(
    '/',
    (req, res) => {
        res.send(
            'Driver Ride Picker Backend is Running!'
        );
    }
);

// ============================================================
// TEST API
// ============================================================

app.get(
    '/api/test',
    (req, res) => {

        res.json({
            success:
                true,

            message:
                'Android app successfully connected to Firebase backend!',

            timestamp:
                new Date()
                    .toISOString()
        });
    }
);

// ============================================================
// DB TEST
// ============================================================

app.get(
    '/api/dbtest',
    async (req, res) => {

        try {

            const snapshot =
                await getDB()
                    .collection(
                        'users'
                    )
                    .limit(1)
                    .get();

            res.json({
                success:
                    true,

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
                success:
                    false,

                message:
                    'DB Error: ' +
                    error.message
            });
        }
    }
);

// ============================================================
// LOGIN / REGISTER
// MOBILE NUMBER + 6-DIGIT PIN
// ============================================================

app.post(
    '/api/auth/login',
    verifyFirebaseAppCheck,
    verifyFirebaseIdentity,
    async (req, res) => {

        try {

            // --------------------------------
            // ONLY ANONYMOUS USER CAN BOOTSTRAP
            // --------------------------------

            if (
                req.firebaseUser
                    .signInProvider !==
                'anonymous'
            ) {
                return res.status(401).json({
                    success:
                        false,

                    message:
                        'Firebase anonymous authentication required.'
                });
            }

            // --------------------------------
            // REQUEST DATA
            // --------------------------------

            const phone =
                normalizePhone(
                    req.body.phone
                );

            const pin =
                String(
                    req.body.pin ||
                    ''
                ).trim();

            const referralCode =
                normalizeReferralCode(
                    req.body.referralCode
                );

            const installId =
                normalizeInstallId(
                    req.body.installId
                );

            // --------------------------------
            // VALIDATE PHONE
            // --------------------------------

            if (!phone) {
                return res.status(400).json({
                    success:
                        false,

                    message:
                        'Please enter a valid 10-digit Indian mobile number.'
                });
            }

            // --------------------------------
            // VALIDATE PIN
            // --------------------------------

            if (
                !isValidPin(pin)
            ) {
                return res.status(400).json({
                    success:
                        false,

                    message:
                        'PIN must be exactly 6 digits.'
                });
            }

            // --------------------------------
            // VALIDATE INSTALLATION ID
            // --------------------------------

            if (!installId) {
                return res.status(400).json({
                    success:
                        false,

                    message:
                        'App installation identity required.'
                });
            }

            const db =
                getDB();

            // --------------------------------
            // PIN LOCK CHECK
            // --------------------------------

            const lockState =
                await getPinLockState(
                    db,
                    phone
                );

            if (
                lockState.locked
            ) {

                const remainingMinutes =
                    Math.max(
                        1,
                        Math.ceil(
                            (
                                lockState.lockedUntilMs -
                                Date.now()
                            ) /
                            (
                                60 *
                                1000
                            )
                        )
                    );

                return res.status(429).json({
                    success:
                        false,

                    message:
                        `Too many wrong PIN attempts. Try again in ${remainingMinutes} minute(s).`
                });
            }

            // --------------------------------
            // USER
            // --------------------------------

            const userRef =
                db
                    .collection(
                        'users'
                    )
                    .doc(
                        phone
                    );

            const existingUserDoc =
                await userRef.get();

            const driverFirebaseUid =
                generateDriverFirebaseUid(
                    phone
                );

            let isNewUser =
                false;

            let trialCreditsAdded =
                0;

            let pinWasCreated =
                false;

            let userData =
                null;

            // ========================================================
            // EXISTING USER
            // ========================================================

            if (
                existingUserDoc.exists
            ) {

                userData =
                    existingUserDoc.data() ||
                    {};

                const updates =
                    {};

                // --------------------------------
                // EXISTING PIN
                // --------------------------------

                if (
                    userData.pinHash &&
                    userData.pinSalt
                ) {

                    const validPin =
                        verifyPinHash(
                            pin,
                            userData.pinSalt,
                            userData.pinHash
                        );

                    if (
                        !validPin
                    ) {

                        const failure =
                            await recordPinFailure(
                                db,
                                phone
                            );

                        if (
                            failure.locked
                        ) {

                            return res.status(429).json({
                                success:
                                    false,

                                message:
                                    `Too many wrong PIN attempts. Try again in ${PIN_LOCK_MINUTES} minutes.`
                            });
                        }

                        return res.status(401).json({
                            success:
                                false,

                            message:
                                'Invalid mobile number or PIN.'
                        });
                    }

                } else {

                    // --------------------------------
                    // OLD ACCOUNT WITHOUT PIN
                    // --------------------------------

                    const pinData =
                        createPinHash(
                            pin
                        );

                    updates.pinSalt =
                        pinData.pinSalt;

                    updates.pinHash =
                        pinData.pinHash;

                    updates.pinCreatedAt =
                        admin.firestore
                            .FieldValue
                            .serverTimestamp();

                    pinWasCreated =
                        true;
                }

                // --------------------------------
                // REPAIR OLD FIELDS
                // --------------------------------

                if (
                    typeof userData
                        .credits !==
                    'number'
                ) {
                    updates.credits =
                        Number(
                            userData
                                .credits ||
                            0
                        );
                }

                if (
                    typeof userData
                        .totalRides !==
                    'number'
                ) {
                    updates.totalRides =
                        Number(
                            userData
                                .totalRides ||
                            0
                        );
                }

                // --------------------------------
                // STABLE FIREBASE UID
                // --------------------------------

                updates.firebaseUid =
                    driverFirebaseUid;

                updates.authMethod =
                    'pin';

                // --------------------------------
                // OLD USER GETS REFERRAL CODE
                // --------------------------------

                if (
                    !userData.referralCode
                ) {

                    updates.referralCode =
                        await createUniqueReferralCode(
                            db,
                            userRef
                        );
                }

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

            } else {

                // ====================================================
                // NEW USER
                // ====================================================

                isNewUser =
                    true;

                // --------------------------------
                // UNIQUE REFERRAL CODE
                // --------------------------------

                const newReferralCode =
                    await createUniqueReferralCode(
                        db,
                        userRef
                    );

                let referralApplied =
                    false;

                let referrerPhone =
                    '';

                let referralLedgerRef =
                    null;

                // --------------------------------
                // REFERRAL CHECK
                // --------------------------------

                if (
                    referralCode
                ) {

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

                    if (
                        referralDoc.exists
                    ) {

                        const referralData =
                            referralDoc.data() ||
                            {};

                        referrerPhone =
                            normalizePhone(
                                referralData.userId
                            );

                        // SELF REFERRAL BLOCK
                        if (
                            referrerPhone &&
                            referrerPhone !==
                                phone
                        ) {

                            referralApplied =
                                true;

                            referralLedgerRef =
                                db
                                    .collection(
                                        'referralRewards'
                                    )
                                    .doc(
                                        `${referrerPhone}_${phone}`
                                    );

                        } else {

                            referrerPhone =
                                '';
                        }
                    }
                }

                // --------------------------------
                // CREATE PIN HASH
                // --------------------------------

                const pinData =
                    createPinHash(
                        pin
                    );

                // --------------------------------
                // ONE-TIME TRIAL
                // --------------------------------

                const trialClaimRef =
                    db
                        .collection(
                            'trialClaims'
                        )
                        .doc(
                            hashInstallId(
                                installId
                            )
                        );

                const transactionResult =
                    await db.runTransaction(
                        async transaction => {

                            const freshUser =
                                await transaction.get(
                                    userRef
                                );

                            // Race protection
                            if (
                                freshUser.exists
                            ) {
                                return {
                                    created:
                                        false,

                                    trialGranted:
                                        false
                                };
                            }

                            const trialDoc =
                                await transaction.get(
                                    trialClaimRef
                                );

                            let ledgerDoc =
                                null;

                            if (
                                referralLedgerRef
                            ) {
                                ledgerDoc =
                                    await transaction.get(
                                        referralLedgerRef
                                    );
                            }

                            const trialGranted =
                                !trialDoc.exists;

                            const startingCredits =
                                trialGranted
                                    ? FREE_START_CREDITS
                                    : 0;

                            // --------------------------------
                            // CREATE USER
                            // --------------------------------

                            transaction.set(
                                userRef,
                                {
                                    phone:
                                        phone,

                                    firebaseUid:
                                        driverFirebaseUid,

                                    credits:
                                        startingCredits,

                                    totalRides:
                                        0,

                                    referralCode:
                                        newReferralCode,

                                    referredBy:
                                        referralApplied
                                            ? referrerPhone
                                            : null,

                                    referralApplied:
                                        referralApplied,

                                    pinSalt:
                                        pinData.pinSalt,

                                    pinHash:
                                        pinData.pinHash,

                                    authMethod:
                                        'pin',

                                    trialClaimed:
                                        trialGranted,

                                    trialInstallIdHash:
                                        hashInstallId(
                                            installId
                                        ),

                                    createdAt:
                                        admin.firestore
                                            .FieldValue
                                            .serverTimestamp(),

                                    pinCreatedAt:
                                        admin.firestore
                                            .FieldValue
                                            .serverTimestamp(),

                                    updatedAt:
                                        admin.firestore
                                            .FieldValue
                                            .serverTimestamp()
                                }
                            );

                            // --------------------------------
                            // SAVE TRIAL CLAIM
                            // --------------------------------

                            if (
                                trialGranted
                            ) {

                                transaction.set(
                                    trialClaimRef,
                                    {
                                        installIdHash:
                                            hashInstallId(
                                                installId
                                            ),

                                        firstPhone:
                                            phone,

                                        creditsGranted:
                                            FREE_START_CREDITS,

                                        createdAt:
                                            admin.firestore
                                                .FieldValue
                                                .serverTimestamp()
                                    }
                                );
                            }

                            // --------------------------------
                            // REFERRAL LEDGER
                            // --------------------------------

                            if (
                                referralApplied &&
                                referralLedgerRef &&
                                (
                                    !ledgerDoc ||
                                    !ledgerDoc.exists
                                )
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
                                            'pending',

                                        createdAt:
                                            admin.firestore
                                                .FieldValue
                                                .serverTimestamp()
                                    }
                                );
                            }

                            return {
                                created:
                                    true,

                                trialGranted:
                                    trialGranted
                            };
                        }
                    );

                // ====================================================
                // RACE CONDITION
                // ====================================================

                if (
                    !transactionResult.created
                ) {

                    const racedUser =
                        await userRef.get();

                    if (
                        !racedUser.exists
                    ) {
                        return res.status(409).json({
                            success:
                                false,

                            message:
                                'Account creation conflict. Please try again.'
                        });
                    }

                    userData =
                        racedUser.data() ||
                        {};

                    // Existing race-created PIN
                    if (
                        userData.pinHash &&
                        userData.pinSalt
                    ) {

                        const validPin =
                            verifyPinHash(
                                pin,
                                userData.pinSalt,
                                userData.pinHash
                            );

                        if (
                            !validPin
                        ) {

                            const failure =
                                await recordPinFailure(
                                    db,
                                    phone
                                );

                            if (
                                failure.locked
                            ) {

                                return res.status(429).json({
                                    success:
                                        false,

                                    message:
                                        `Too many wrong PIN attempts. Try again in ${PIN_LOCK_MINUTES} minutes.`
                                });
                            }

                            return res.status(401).json({
                                success:
                                    false,

                                message:
                                    'Invalid mobile number or PIN.'
                            });
                        }
                    }

                    const updates = {
                        firebaseUid:
                            driverFirebaseUid,

                        authMethod:
                            'pin',

                        updatedAt:
                            admin.firestore
                                .FieldValue
                                .serverTimestamp()
                    };

                    await userRef.update(
                        updates
                    );

                    userData = {
                        ...userData,
                        ...updates
                    };

                    isNewUser =
                        false;

                } else {

                    // --------------------------------
                    // TRIAL CREDITS
                    // --------------------------------

                    if (
                        transactionResult
                            .trialGranted
                    ) {

                        trialCreditsAdded =
                            FREE_START_CREDITS;
                    }

                    // ================================================
                    // REFERRER +5 CREDIT
                    // ================================================

                    if (
                        referralApplied &&
                        referralLedgerRef
                    ) {

                        const referrerRef =
                            db
                                .collection(
                                    'users'
                                )
                                .doc(
                                    referrerPhone
                                );

                        await db.runTransaction(
                            async transaction => {

                                const referrerDoc =
                                    await transaction.get(
                                        referrerRef
                                    );

                                const ledgerDoc =
                                    await transaction.get(
                                        referralLedgerRef
                                    );

                                if (
                                    !referrerDoc.exists ||
                                    !ledgerDoc.exists
                                ) {
                                    return;
                                }

                                const ledgerData =
                                    ledgerDoc.data() ||
                                    {};

                                if (
                                    ledgerData.status ===
                                    'rewarded'
                                ) {
                                    return;
                                }

                                const referrerData =
                                    referrerDoc.data() ||
                                    {};

                                const currentCredits =
                                    Number(
                                        referrerData
                                            .credits ||
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
                                            admin.firestore
                                                .FieldValue
                                                .serverTimestamp()
                                    }
                                );

                                transaction.update(
                                    referralLedgerRef,
                                    {
                                        status:
                                            'rewarded',

                                        rewardedAt:
                                            admin.firestore
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
                        {};
                }
            }

            // --------------------------------
            // CLEAR FAILED ATTEMPTS
            // --------------------------------

            await clearPinFailures(
                db,
                phone
            );

            // --------------------------------
            // FIREBASE CUSTOM TOKEN
            // --------------------------------

            const firebaseCustomToken =
                await admin
                    .auth()
                    .createCustomToken(
                        driverFirebaseUid,
                        {
                            driver:
                                true
                        }
                    );

            // --------------------------------
            // FINAL RESPONSE
            // --------------------------------

            return res.json({

                success:
                    true,

                isNewUser:
                    isNewUser,

                trialCreditsAdded:
                    trialCreditsAdded,

                pinWasCreated:
                    pinWasCreated,

                authMethod:
                    'pin',

                firebaseCustomToken:
                    firebaseCustomToken,

                message:
                    isNewUser
                        ? (
                            trialCreditsAdded >
                            0
                                ? 'Welcome! 10 free credits added.'
                                : 'Account created. This installation has already used the free trial.'
                        )
                        : (
                            pinWasCreated
                                ? 'PIN created successfully. Welcome back!'
                                : 'Welcome back!'
                        ),

                user: {

                    phone:
                        userData.phone ||
                        phone,

                    firebaseUid:
                        driverFirebaseUid,

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
                'PIN LOGIN ERROR:',
                error
            );

            return res.status(500).json({
                success:
                    false,

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
                getAuthenticatedPhone(
                    req
                );

            const db =
                getDB();

            const userDoc =
                await db
                    .collection(
                        'users'
                    )
                    .doc(
                        phone
                    )
                    .get();

            if (
                !userDoc.exists
            ) {

                return res.status(404).json({
                    success:
                        false,

                    message:
                        'User not found'
                });
            }

            const data =
                userDoc.data() ||
                {};

            const referralCode =
                data.referralCode ||
                '';

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

                success:
                    true,

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
                success:
                    false,

                message:
                    'Server error: ' +
                    error.message
            });
        }
    }
);

// ============================================================
// BALANCE
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
                    success:
                        false,

                    message:
                        'Phone does not match authenticated Firebase user.'
                });
            }

            const userDoc =
                await getDB()
                    .collection(
                        'users'
                    )
                    .doc(
                        phone
                    )
                    .get();

            if (
                !userDoc.exists
            ) {

                return res.json({
                    success:
                        false,

                    message:
                        'User not found'
                });
            }

            const data =
                userDoc.data() ||
                {};

            res.json({

                success:
                    true,

                credits:
                    Number(
                        data.credits ||
                        0
                    ),

                totalRides:
                    Number(
                        data.totalRides ||
                        0
                    ),

                referralCode:
                    data.referralCode ||
                    ''
            });

        } catch (error) {

            console.error(
                'BALANCE ERROR:',
                error
            );

            res.status(500).json({
                success:
                    false,

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

            success:
                true,

            minRechargeRupees:
                MIN_RECHARGE_RUPEES,

            rupeesPerCredit:
                1,

            creditsPerRupee:
                CREDIT_PER_RUPEE,

            examples: {
                '10':
                    10,

                '20':
                    20,

                '50':
                    50,

                '100':
                    100,

                '500':
                    500,

                '1000':
                    1000
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
                getAuthenticatedPhone(
                    req
                );

            const amountRupees =
                Number(
                    req.body.amountRupees
                );

            if (!phone) {
                return res.status(400).json({
                    success:
                        false,

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
                    success:
                        false,

                    message:
                        `Minimum recharge is ₹${MIN_RECHARGE_RUPEES} and amount must be a whole number.`
                });
            }

            const db =
                getDB();

            const userRef =
                db
                    .collection(
                        'users'
                    )
                    .doc(
                        phone
                    );

            const userDoc =
                await userRef.get();

            if (
                !userDoc.exists
            ) {

                return res.status(404).json({
                    success:
                        false,

                    message:
                        'User not found'
                });
            }

            // ₹1 = 1 credit
            const amountPaise =
                amountRupees *
                100;

            const creditsToAdd =
                amountRupees *
                CREDIT_PER_RUPEE;

            const razorpay =
                getRazorpay();

            const order =
                await razorpay
                    .orders
                    .create({

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
                    });

            await db
                .collection(
                    'rechargeOrders'
                )
                .doc(
                    order.id
                )
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
                        admin.firestore
                            .FieldValue
                            .serverTimestamp(),

                    updatedAt:
                        admin.firestore
                            .FieldValue
                            .serverTimestamp()
                });

            res.json({

                success:
                    true,

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
                success:
                    false,

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
                getAuthenticatedPhone(
                    req
                );

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
                    success:
                        false,

                    message:
                        'Incomplete Razorpay payment details'
                });
            }

            const db =
                getDB();

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

            if (
                !orderDoc.exists
            ) {

                return res.status(404).json({
                    success:
                        false,

                    message:
                        'Payment order not found'
                });
            }

            const storedOrder =
                orderDoc.data() ||
                {};

            // --------------------------------
            // PHONE CHECK
            // --------------------------------

            if (
                normalizePhone(
                    storedOrder.phone
                ) !==
                phone
            ) {

                return res.status(403).json({
                    success:
                        false,

                    message:
                        'Payment phone mismatch'
                });
            }

            // --------------------------------
            // ALREADY PAID
            // --------------------------------

            if (
                storedOrder.status ===
                'paid'
            ) {

                const userDoc =
                    await db
                        .collection(
                            'users'
                        )
                        .doc(
                            phone
                        )
                        .get();

                const userData =
                    userDoc.exists
                        ? (
                            userDoc.data() ||
                            {}
                        )
                        : {};

                return res.json({

                    success:
                        true,

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

            // --------------------------------
            // SIGNATURE
            // --------------------------------

            const signatureValid =
                verifyRazorpaySignature(
                    storedOrder
                        .razorpayOrderId,

                    razorpayPaymentId,

                    razorpaySignature
                );

            if (
                !signatureValid
            ) {

                return res.status(400).json({
                    success:
                        false,

                    message:
                        'Invalid Razorpay signature'
                });
            }

            // --------------------------------
            // FETCH PAYMENT
            // --------------------------------

            const razorpay =
                getRazorpay();

            const payment =
                await razorpay
                    .payments
                    .fetch(
                        razorpayPaymentId
                    );

            // --------------------------------
            // ORDER CHECK
            // --------------------------------

            if (
                payment.order_id !==
                storedOrder
                    .razorpayOrderId
            ) {

                return res.status(400).json({
                    success:
                        false,

                    message:
                        'Payment order mismatch'
                });
            }

            // --------------------------------
            // AMOUNT CHECK
            // --------------------------------

            if (
                Number(
                    payment.amount
                ) !==
                Number(
                    storedOrder.amountPaise
                )
            ) {

                return res.status(400).json({
                    success:
                        false,

                    message:
                        'Payment amount mismatch'
                });
            }

            // --------------------------------
            // CAPTURE CHECK
            // --------------------------------

            if (
                payment.status !==
                'captured'
            ) {

                return res.status(400).json({
                    success:
                        false,

                    paymentStatus:
                        payment.status,

                    message:
                        'Payment is not captured yet'
                });
            }

            const userRef =
                db
                    .collection(
                        'users'
                    )
                    .doc(
                        phone
                    );

            let finalCredits =
                0;

            // --------------------------------
            // ATOMIC CREDIT ADD
            // --------------------------------

            await db.runTransaction(
                async transaction => {

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

                    const freshUserDoc =
                        await transaction.get(
                            userRef
                        );

                    if (
                        !freshUserDoc.exists
                    ) {

                        throw new Error(
                            'User not found'
                        );
                    }

                    const freshOrder =
                        freshOrderDoc.data() ||
                        {};

                    const userData =
                        freshUserDoc.data() ||
                        {};

                    const currentCredits =
                        Number(
                            userData
                                .credits ||
                            0
                        );

                    // --------------------------------
                    // DOUBLE PROCESS PROTECTION
                    // --------------------------------

                    if (
                        freshOrder.status ===
                        'paid'
                    ) {

                        finalCredits =
                            currentCredits;

                        return;
                    }

                    // --------------------------------
                    // CREDITS
                    // --------------------------------

                    const creditsToAdd =
                        Number(
                            freshOrder
                                .creditsToAdd ||
                            0
                        );

                    const updatedCredits =
                        currentCredits +
                        creditsToAdd;

                    // --------------------------------
                    // UPDATE USER
                    // --------------------------------

                    transaction.update(
                        userRef,
                        {
                            credits:
                                updatedCredits,

                            updatedAt:
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp()
                        }
                    );

                    // --------------------------------
                    // MARK ORDER PAID
                    // --------------------------------

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
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp(),

                            updatedAt:
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp()
                        }
                    );

                    // --------------------------------
                    // PAYMENT RECORD
                    // --------------------------------

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
                                freshOrder
                                    .razorpayOrderId,

                            razorpayPaymentId:
                                razorpayPaymentId,

                            phone:
                                phone,

                            amountRupees:
                                Number(
                                    freshOrder
                                        .amountRupees
                                ),

                            amountPaise:
                                Number(
                                    freshOrder
                                        .amountPaise
                                ),

                            creditsAdded:
                                creditsToAdd,

                            status:
                                'captured',

                            createdAt:
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp()
                        },
                        {
                            merge:
                                true
                        }
                    );

                    finalCredits =
                        updatedCredits;
                }
            );

            res.json({

                success:
                    true,

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
                success:
                    false,

                message:
                    'Payment verification failed: ' +
                    error.message
            });
        }
    }
);

// ============================================================
// DEDUCT CREDIT
// 1 SUCCESSFUL RIDE = 1 CREDIT
// ============================================================

app.post(
    '/api/ride/deduct-credit',
    verifyFirebaseToken,
    async (req, res) => {

        try {

            const phone =
                getAuthenticatedPhone(
                    req
                );

            const db =
                getDB();

            const userRef =
                db
                    .collection(
                        'users'
                    )
                    .doc(
                        phone
                    );

            let result =
                null;

            await db.runTransaction(
                async transaction => {

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
                        userDoc.data() ||
                        {};

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

                    // --------------------------------
                    // NO CREDIT
                    // --------------------------------

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

                    // --------------------------------
                    // UPDATE
                    // --------------------------------

                    transaction.update(
                        userRef,
                        {
                            credits:
                                remainingCredits,

                            totalRides:
                                updatedTotalRides,

                            updatedAt:
                                admin.firestore
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

                success:
                    true,

                message:
                    '1 credit deducted for successful ride',

                remainingCredits:
                    result
                        .remainingCredits,

                totalRides:
                    result
                        .totalRides
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
                    success:
                        false,

                    message:
                        error.message
                });
            }

            if (
                error.message ===
                'User not found'
            ) {

                return res.status(404).json({
                    success:
                        false,

                    message:
                        error.message
                });
            }

            res.status(500).json({
                success:
                    false,

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
    process.env.PORT ||
    5000;

app.listen(
    PORT,
    () => {
        console.log(
            `Server started on port ${PORT}`
        );
    }
);
