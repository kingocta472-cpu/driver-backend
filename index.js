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
const MAX_RECHARGE_RUPEES = 100000;
const CREDIT_PER_RUPEE = 1;

const PIN_LENGTH = 6;
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

const INSTALL_ID_MAX_LENGTH = 200;

const REFERRAL_CODE_LENGTH = 8;
const REFERRAL_CODE_ALPHABET =
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ============================================================
// FIREBASE INIT
// ============================================================

let cached = global.firebaseCache;

if (!cached) {
    cached = global.firebaseCache = {
        db: null
    };
}

function initializeFirebaseAdmin() {
    if (admin.apps.length > 0) {
        return admin;
    }

    const projectId =
        process.env.FIREBASE_PROJECT_ID;

    const clientEmail =
        process.env.FIREBASE_CLIENT_EMAIL;

    const privateKeyRaw =
        process.env.FIREBASE_PRIVATE_KEY;

    if (
        !projectId ||
        !clientEmail ||
        !privateKeyRaw
    ) {
        throw new Error(
            'Firebase Admin credentials are missing. Add FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in Vercel Environment Variables.'
        );
    }

    const privateKey =
        String(
            privateKeyRaw
        ).replace(
            /\\n/g,
            '\n'
        );

    admin.initializeApp({
        credential:
            admin.credential.cert({
                projectId:
                    projectId,

                clientEmail:
                    clientEmail,

                privateKey:
                    privateKey
            })
    });

    return admin;
}

function getDB() {
    initializeFirebaseAdmin();

    if (cached.db) {
        return cached.db;
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
        key_id:
            keyId,

        key_secret:
            keySecret
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
            .replace(
                /\D/g,
                ''
            );

    if (
        digits.length === 10 &&
        /^[6-9]/.test(
            digits
        )
    ) {
        return digits;
    }

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
            MIN_RECHARGE_RUPEES &&
        amount <=
            MAX_RECHARGE_RUPEES
    );
}

function isValidPin(
    pin
) {
    return new RegExp(
        `^\\d{${PIN_LENGTH}}$`
    ).test(
        String(
            pin || ''
        ).trim()
    );
}

// ============================================================
// REFERRAL CODE GENERATOR
// ============================================================

function generateReferralCode() {
    const bytes =
        crypto.randomBytes(
            REFERRAL_CODE_LENGTH
        );

    let code = '';

    for (
        let i = 0;
        i < REFERRAL_CODE_LENGTH;
        i++
    ) {
        code +=
            REFERRAL_CODE_ALPHABET[
                bytes[i] %
                REFERRAL_CODE_ALPHABET.length
            ];
    }

    return code;
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
        crypto
            .scryptSync(
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
        pinSalt:
            salt,

        pinHash:
            hash
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
            crypto
                .scryptSync(
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
        Buffer.from(
            generated,
            'utf8'
        ),
        Buffer.from(
            signature,
            'utf8'
        )
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

    initializeFirebaseAdmin();

    return admin
        .auth()
        .verifyIdToken(
            idToken
        );
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
                success:
                    false,

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

        return res.status(
            error.statusCode ||
            401
        ).json({
            success:
                false,

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
        const decoded =
            await decodeFirebaseToken(
                req
            );

        if (!decoded.uid) {
            return res.status(401).json({
                success:
                    false,

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

        if (
            signInProvider ===
            'anonymous'
        ) {
            return res.status(401).json({
                success:
                    false,

                message:
                    'Driver PIN authentication required.'
            });
        }

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
                success:
                    false,

                message:
                    'Driver account authentication required.'
            });
        }

        const userDoc =
            snapshot.docs[0];

        const userData =
            userDoc.data() ||
            {};

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

        return res.status(401).json({
            success:
                false,

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
            locked:
                false,

            lockedUntilMs:
                0
        };
    }

    const data =
        snapshot.data() ||
        {};

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
        failures:
            1,

        locked:
            false,

        lockedUntilMs:
            0
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
                    failures,

                    lockedUntilMs,

                    lastFailedAt:
                        admin.firestore
                            .FieldValue
                            .serverTimestamp()
                },
                {
                    merge:
                        true
                }
            );

            result = {
                failures,

                locked,

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
                .doc(
                    code
                );

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
    verifyFirebaseIdentity,
    async (req, res) => {
        try {
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

            const deviceId =
                normalizeInstallId(
                    req.body.deviceId
                );

            const trialDeviceId =
                deviceId ||
                installId;

            if (!phone) {
                return res.status(400).json({
                    success:
                        false,

                    message:
                        'Please enter a valid 10-digit Indian mobile number.'
                });
            }

            if (
                !isValidPin(
                    pin
                )
            ) {
                return res.status(400).json({
                    success:
                        false,

                    message:
                        'PIN must be exactly 6 digits.'
                });
            }

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
                                lockState
                                    .lockedUntilMs -
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

            if (
                existingUserDoc.exists
            ) {
                userData =
                    existingUserDoc.data() ||
                    {};

                const updates =
                    {};

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

                if (
                    typeof userData
                        .credits !==
                    'number'
                ) {
                    updates.credits =
                        Number(
                            userData.credits ||
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
                            userData.totalRides ||
                            0
                        );
                }

                updates.firebaseUid =
                    driverFirebaseUid;

                updates.authMethod =
                    'pin';

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
                isNewUser =
                    true;

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

                        const possibleReferrerPhone =
                            normalizePhone(
                                referralData
                                    .userId ||
                                ''
                            );

                        if (
                            possibleReferrerPhone &&
                            possibleReferrerPhone !==
                                phone
                        ) {
                            const referrerUserRef =
                                db
                                    .collection(
                                        'users'
                                    )
                                    .doc(
                                        possibleReferrerPhone
                                    );

                            const referrerDoc =
                                await referrerUserRef
                                    .get();

                            if (
                                referrerDoc.exists
                            ) {
                                referralApplied =
                                    true;

                                referrerPhone =
                                    possibleReferrerPhone;

                                referralLedgerRef =
                                    db
                                        .collection(
                                            'referralRewards'
                                        )
                                        .doc(
                                            `${referrerPhone}_${phone}`
                                        );
                            }
                        }
                    }
                }

                const pinData =
                    createPinHash(
                        pin
                    );

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

                const deviceTrialClaimRef =
                    db
                        .collection(
                            'deviceTrialClaims'
                        )
                        .doc(
                            hashInstallId(
                                trialDeviceId
                            )
                        );

                const transactionResult =
                    await db.runTransaction(
                        async transaction => {
                            const freshUser =
                                await transaction.get(
                                    userRef
                                );

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

                            const deviceTrialDoc =
                                await transaction.get(
                                    deviceTrialClaimRef
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
                                !trialDoc.exists &&
                                !deviceTrialDoc.exists;

                            const startingCredits =
                                trialGranted
                                    ? FREE_START_CREDITS
                                    : 0;

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

                                    deviceIdHash:
                                        hashInstallId(
                                            trialDeviceId
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

                                transaction.set(
                                    deviceTrialClaimRef,
                                    {
                                        deviceIdHash:
                                            hashInstallId(
                                                trialDeviceId
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

                if (
                    !transactionResult
                        .created
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

                    trialCreditsAdded =
                        0;

                    isNewUser =
                        false;
                } else {
                    trialCreditsAdded =
                        transactionResult
                            .trialGranted
                            ? FREE_START_CREDITS
                            : 0;

                    const createdUserDoc =
                        await userRef.get();

                    userData =
                        createdUserDoc.data() ||
                        {};

                    if (
                        referralApplied &&
                        referralLedgerRef
                    ) {
                        await db.runTransaction(
                            async transaction => {
                                const freshLedger =
                                    await transaction.get(
                                        referralLedgerRef
                                    );

                                if (
                                    !freshLedger.exists
                                ) {
                                    return;
                                }

                                const ledgerData =
                                    freshLedger.data() ||
                                    {};

                                if (
                                    ledgerData.status !==
                                    'pending'
                                ) {
                                    return;
                                }

                                const referrerRef =
                                    db
                                        .collection(
                                            'users'
                                        )
                                        .doc(
                                            referrerPhone
                                        );

                                const referrerDoc =
                                    await transaction.get(
                                        referrerRef
                                    );

                                if (
                                    !referrerDoc.exists
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

            await clearPinFailures(
                db,
                phone
            );

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
// AUTHENTICATED USER BALANCE
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
                        'You can only access your own account.'
                });
            }

            const snapshot =
                await getDB()
                    .collection(
                        'users'
                    )
                    .doc(
                        phone
                    )
                    .get();

            if (
                !snapshot.exists
            ) {
                return res.status(404).json({
                    success:
                        false,

                    message:
                        'Driver account not found.'
                });
            }

            const data =
                snapshot.data() ||
                {};

            return res.json({
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
                    '',

                referralCount:
                    Number(
                        data.referralCount ||
                        0
                    )
            });
        } catch (error) {
            console.error(
                'BALANCE ERROR:',
                error
            );

            return res.status(500).json({
                success:
                    false,

                message:
                    'Unable to load balance.'
            });
        }
    }
);

// ============================================================
// DEDUCT ONE CREDIT FOR SUCCESSFUL RIDE
// ============================================================

app.post(
    '/api/ride/deduct-credit',
    verifyFirebaseToken,
    async (req, res) => {
        try {
            const phone =
                normalizePhone(
                    req.body.phone
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
                        'You can only use your own account.'
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

            let remainingCredits =
                0;

            await db.runTransaction(
                async transaction => {
                    const snapshot =
                        await transaction.get(
                            userRef
                        );

                    if (
                        !snapshot.exists
                    ) {
                        const error =
                            new Error(
                                'Driver account not found.'
                            );

                        error.statusCode =
                            404;

                        throw error;
                    }

                    const data =
                        snapshot.data() ||
                        {};

                    const currentCredits =
                        Number(
                            data.credits ||
                            0
                        );

                    if (
                        currentCredits <=
                        0
                    ) {
                        const error =
                            new Error(
                                'Insufficient credits.'
                            );

                        error.statusCode =
                            402;

                        throw error;
                    }

                    remainingCredits =
                        currentCredits - 1;

                    transaction.update(
                        userRef,
                        {
                            credits:
                                remainingCredits,

                            totalRides:
                                Number(
                                    data.totalRides ||
                                    0
                                ) + 1,

                            updatedAt:
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp()
                        }
                    );
                }
            );

            return res.json({
                success:
                    true,

                message:
                    'Ride credit deducted.',

                remainingCredits:
                    remainingCredits
            });
        } catch (error) {
            console.error(
                'DEDUCT CREDIT ERROR:',
                error
            );

            return res.status(
                error.statusCode ||
                500
            ).json({
                success:
                    false,

                message:
                    error.message ||
                    'Unable to deduct credit.'
            });
        }
    }
);

// ============================================================
// CREATE RAZORPAY ORDER
// ============================================================

app.post(
    '/api/payment/create-order',
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
                return res.status(401).json({
                    success:
                        false,

                    message:
                        'Authenticated driver required.'
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
                        `Recharge must be an integer amount between ₹${MIN_RECHARGE_RUPEES} and ₹${MAX_RECHARGE_RUPEES}.`
                });
            }

            const credits =
                amountRupees *
                CREDIT_PER_RUPEE;

            const receipt =
                generateReceipt();

            const razorpay =
                getRazorpay();

            const order =
                await razorpay.orders.create({
                    amount:
                        amountRupees *
                        100,

                    currency:
                        'INR',

                    receipt:
                        receipt,

                    partial_payment:
                        false,

                    notes: {
                        app:
                            'Driver Ride Picker',

                        phone:
                            phone,

                        credits:
                            String(
                                credits
                            )
                    }
                });

            await getDB()
                .collection(
                    'paymentOrders'
                )
                .doc(
                    order.id
                )
                .set({
                    orderId:
                        order.id,

                    phone:
                        phone,

                    amountRupees:
                        amountRupees,

                    amountPaise:
                        amountRupees *
                        100,

                    credits:
                        credits,

                    currency:
                        'INR',

                    status:
                        'created',

                    receipt:
                        receipt,

                    createdAt:
                        admin.firestore
                            .FieldValue
                            .serverTimestamp()
                });

            return res.json({
                success:
                    true,

                keyId:
                    process.env
                        .RAZORPAY_KEY_ID,

                orderId:
                    order.id,

                amount:
                    order.amount,

                currency:
                    order.currency,

                credits:
                    credits
            });
        } catch (error) {
            console.error(
                'RAZORPAY CREATE ORDER ERROR:',
                error
            );

            return res.status(500).json({
                success:
                    false,

                message:
                    error.message ||
                    'Unable to create Razorpay order.'
            });
        }
    }
);

// ============================================================
// VERIFY RAZORPAY PAYMENT + ADD CREDITS
// ============================================================

app.post(
    '/api/payment/verify',
    verifyFirebaseToken,
    async (req, res) => {
        try {
            const phone =
                getAuthenticatedPhone(
                    req
                );

            const orderId =
                String(
                    req.body.orderId ||
                    ''
                ).trim();

            const paymentId =
                String(
                    req.body.paymentId ||
                    ''
                ).trim();

            const signature =
                String(
                    req.body.signature ||
                    ''
                ).trim();

            if (
                !phone ||
                !orderId ||
                !paymentId ||
                !signature
            ) {
                return res.status(400).json({
                    success:
                        false,

                    message:
                        'Payment verification data is incomplete.'
                });
            }

            const db =
                getDB();

            const orderRef =
                db
                    .collection(
                        'paymentOrders'
                    )
                    .doc(
                        orderId
                    );

            const orderSnapshot =
                await orderRef.get();

            if (
                !orderSnapshot.exists
            ) {
                return res.status(404).json({
                    success:
                        false,

                    message:
                        'Payment order not found.'
                });
            }

            const orderData =
                orderSnapshot.data() ||
                {};

            if (
                normalizePhone(
                    orderData.phone
                ) !== phone
            ) {
                return res.status(403).json({
                    success:
                        false,

                    message:
                        'Payment order does not belong to this account.'
                });
            }

            if (
                !verifyRazorpaySignature(
                    orderId,
                    paymentId,
                    signature
                )
            ) {
                return res.status(400).json({
                    success:
                        false,

                    message:
                        'Invalid Razorpay payment signature.'
                });
            }

            if (
                orderData.status ===
                'paid'
            ) {
                return res.json({
                    success:
                        true,

                    alreadyProcessed:
                        true,

                    creditsAdded:
                        Number(
                            orderData
                                .credits ||
                            0
                        ),

                    message:
                        'Payment already processed.'
                });
            }

            const razorpay =
                getRazorpay();

            const payment =
                await razorpay
                    .payments
                    .fetch(
                        paymentId
                    );

            if (
                String(
                    payment.order_id ||
                    ''
                ) !== orderId
            ) {
                return res.status(400).json({
                    success:
                        false,

                    message:
                        'Payment/order mismatch.'
                });
            }

            if (
                String(
                    payment.status ||
                    ''
                ).toLowerCase() !==
                'captured'
            ) {
                return res.status(400).json({
                    success:
                        false,

                    message:
                        `Payment is not captured yet. Current status: ${payment.status || 'unknown'}`
                });
            }

            const paidPaise =
                Number(
                    payment.amount ||
                    0
                );

            if (
                paidPaise !==
                Number(
                    orderData.amountPaise ||
                    0
                )
            ) {
                return res.status(400).json({
                    success:
                        false,

                    message:
                        'Payment amount mismatch.'
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

            const creditsToAdd =
                Number(
                    orderData.credits ||
                    0
                );

            let newBalance =
                0;

            await db.runTransaction(
                async transaction => {
                    const freshOrder =
                        await transaction.get(
                            orderRef
                        );

                    const freshUser =
                        await transaction.get(
                            userRef
                        );

                    if (
                        !freshUser.exists
                    ) {
                        const error =
                            new Error(
                                'Driver account not found.'
                            );

                        error.statusCode =
                            404;

                        throw error;
                    }

                    const freshOrderData =
                        freshOrder.data() ||
                        {};

                    const currentCredits =
                        Number(
                            freshUser
                                .data()
                                ?.credits ||
                            0
                        );

                    if (
                        freshOrderData.status ===
                        'paid'
                    ) {
                        newBalance =
                            currentCredits;

                        return;
                    }

                    newBalance =
                        currentCredits +
                        creditsToAdd;

                    transaction.update(
                        userRef,
                        {
                            credits:
                                newBalance,

                            updatedAt:
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp()
                        }
                    );

                    transaction.update(
                        orderRef,
                        {
                            status:
                                'paid',

                            paymentId:
                                paymentId,

                            signature:
                                signature,

                            paidAt:
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp()
                        }
                    );
                }
            );

            return res.json({
                success:
                    true,

                alreadyProcessed:
                    false,

                creditsAdded:
                    creditsToAdd,

                newBalance:
                    newBalance,

                paymentId:
                    paymentId,

                orderId:
                    orderId,

                message:
                    `${creditsToAdd} credits added successfully.`
            });
        } catch (error) {
            console.error(
                'RAZORPAY VERIFY ERROR:',
                error
            );

            return res.status(
                error.statusCode ||
                500
            ).json({
                success:
                    false,

                message:
                    error.message ||
                    'Unable to verify Razorpay payment.'
            });
        }
    }
);

// ============================================================
// VERCEL SERVERLESS ENTRYPOINT
// ============================================================

module.exports = app;
