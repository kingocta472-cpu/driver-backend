const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const app = express();

const redis = new Redis({
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});

app.use(cors());
app.use(express.json());

// ============================================================
// DRIVER ACTIVITY TRACKER - INLINE
// ============================================================

const TRACKER_COLLECTION = 'driverActivity';
const TRACKER_WRITE_INTERVAL_MS = 5 * 60 * 1000;

let trackerCache = global.driverRidePickerTrackerCache;

if (!trackerCache) {
    trackerCache = global.driverRidePickerTrackerCache = {
        lastWriteByDriver: new Map()
    };
}

function trackerHashPhone(phone) {
    return crypto.createHash('sha256').update(`driver-ride-picker-tracker:${phone}`).digest('hex');
}

function trackerMaskPhone(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) {
        return '**********';
    }
    return normalized.slice(0, 2) + '******' + normalized.slice(-2);
}

function trackerShouldWrite(driverKey) {
    const now = Date.now();
    const lastWrite = trackerCache.lastWriteByDriver.get(driverKey) || 0;
    if (now - lastWrite < TRACKER_WRITE_INTERVAL_MS) {
        return false;
    }
    trackerCache.lastWriteByDriver.set(driverKey, now);
    if (trackerCache.lastWriteByDriver.size > 5000) {
        const cutoff = now - TRACKER_WRITE_INTERVAL_MS * 2;
        for (const [key, timestamp] of trackerCache.lastWriteByDriver) {
            if (timestamp < cutoff) {
                trackerCache.lastWriteByDriver.delete(key);
            }
        }
    }
    return true;
}

async function recordDriverActivity({ phone, uid, method, endpoint }) {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
        return;
    }
    const driverKey = trackerHashPhone(normalizedPhone);
    if (!trackerShouldWrite(driverKey)) {
        return;
    }
    try {
        const db = getDB();
        await db.collection(TRACKER_COLLECTION).doc(driverKey).set({
            driverId: driverKey,
            phoneMasked: trackerMaskPhone(normalizedPhone),
            firebaseUid: String(uid || ''),
            lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
            lastMethod: String(method || '').slice(0, 20),
            lastEndpoint: String(endpoint || '').slice(0, 200),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (error) {
        console.error('DRIVER ACTIVITY TRACKER WRITE ERROR:', error);
    }
}

function verifyTrackerAdminKey(req) {
    const configuredKey = String(process.env.TRACKER_ADMIN_KEY || '');
    const suppliedKey = String(req.headers['x-tracker-admin-key'] || '');
    if (!configuredKey || !suppliedKey) {
        return false;
    }
    const expected = Buffer.from(configuredKey, 'utf8');
    const supplied = Buffer.from(suppliedKey, 'utf8');
    if (expected.length !== supplied.length) {
        return false;
    }
    return crypto.timingSafeEqual(expected, supplied);
}

function getTrackerStatus(lastSeenMs) {
    const age = Date.now() - lastSeenMs;
    if (age <= 5 * 60 * 1000) {
        return 'active';
    }
    if (age <= 15 * 60 * 1000) {
        return 'recent';
    }
    return 'inactive';
}

function trackerTimestampToIso(timestamp) {
    if (!timestamp) {
        return null;
    }
    if (typeof timestamp.toDate === 'function') {
        return timestamp.toDate().toISOString();
    }
    return null;
}

async function getDriverTrackerSnapshot() {
    const db = getDB();
    const now = Date.now();
    const activeCutoff = now - 5 * 60 * 1000;
    const recentCutoff = now - 15 * 60 * 1000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const usersSnapshot = await db.collection('users').count().get();
    const activitySnapshot = await db.collection(TRACKER_COLLECTION).orderBy('lastSeenAt', 'desc').limit(200).get();

    let activeNow = 0;
    let active15Min = 0;
    let activeToday = 0;
    const drivers = [];

    activitySnapshot.forEach(doc => {
        const data = doc.data() || {};
        const lastSeen = data.lastSeenAt;
        const lastSeenMs = lastSeen && typeof lastSeen.toMillis === 'function' ? lastSeen.toMillis() : 0;
        const status = lastSeenMs ? getTrackerStatus(lastSeenMs) : 'inactive';

        if (lastSeenMs >= activeCutoff) {
            activeNow++;
        }
        if (lastSeenMs >= recentCutoff) {
            active15Min++;
        }
        if (lastSeenMs >= today.getTime()) {
            activeToday++;
        }

        drivers.push({
            driverId: String(data.driverId || doc.id),
            phone: String(data.phoneMasked || '**********'),
            status: status,
            lastSeenAt: trackerTimestampToIso(lastSeen),
            method: String(data.lastMethod || ''),
            endpoint: String(data.lastEndpoint || '')
        });
    });

    return {
        success: true,
        generatedAt: new Date().toISOString(),
        summary: {
            totalDrivers: Number(usersSnapshot.data().count || 0),
            activeNow: activeNow,
            active15Min: active15Min,
            activeToday: activeToday
        },
        drivers: drivers
    };
}

async function handleDriverTrackerAdmin(req, res) {
    if (!verifyTrackerAdminKey(req)) {
        return res.status(401).json({
            success: false,
            message: 'Unauthorized tracker access.'
        });
    }

    try {
        const data = await getDriverTrackerSnapshot();
        return res.json(data);
    } catch (error) {
        console.error('TRACKER SNAPSHOT ERROR:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to load driver activity tracker.'
        });
    }
}

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

const APP_LATEST_VERSION = String(process.env.APP_LATEST_VERSION || '1.0.0').trim();
const APP_MINIMUM_VERSION = String(process.env.APP_MINIMUM_VERSION || APP_LATEST_VERSION).trim();
const APP_APK_URL = String(process.env.APP_APK_URL || '').trim();
const APP_UPDATE_TITLE = String(process.env.APP_UPDATE_TITLE || 'New Update Available').trim();
const APP_UPDATE_MESSAGE = String(process.env.APP_UPDATE_MESSAGE || 'A new Driver Ride Picker update is available.').trim();
const APP_RELEASE_NOTES = String(process.env.APP_RELEASE_NOTES || 'Performance improvements and bug fixes.').trim();
const APP_PUBLISHED_AT = String(process.env.APP_PUBLISHED_AT || '').trim();

const INSTALL_ID_MAX_LENGTH = 200;
const RIDE_EVENT_ID_MAX_LENGTH = 200;
const REFERRAL_CODE_LENGTH = 8;
const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ============================================================
// RIDE BOT CONFIG VERSION (REDIS-BACKED)
// ============================================================
//
// Version is stored in Redis so admin can bump it without
// redeploying the whole backend. When version increases,
// the Android app's Accessibility service detects it and
// triggers the 20-minute "update in progress" timer UI.
//
// - Default fallback: env RIDE_BOT_CONFIG_VERSION or 3
// - Redis key: ride-bot-config-version
//
const RIDE_BOT_CONFIG_VERSION_FALLBACK = Number(process.env.RIDE_BOT_CONFIG_VERSION || 3);
const RIDE_BOT_CONFIG_VERSION_KEY = 'ride-bot-config-version';

async function getRideBotConfigVersion() {
    try {
        const fromRedis = await redis.get(RIDE_BOT_CONFIG_VERSION_KEY);
        const parsed = Number(fromRedis);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    } catch (error) {
        console.error('CONFIG VERSION REDIS READ ERROR:', error);
    }
    return RIDE_BOT_CONFIG_VERSION_FALLBACK;
}

function verifyAdminToken(req) {
    const expectedToken = String(process.env.ADMIN_TOKEN || '');
    const authHeader = String(req.headers.authorization || '');
    if (!expectedToken || !authHeader) {
        return false;
    }
    return authHeader === `Bearer ${expectedToken}`;
}

// ============================================================
// FIREBASE INIT
// ============================================================

let cached = global.firebaseCache;

if (!cached) {
    cached = global.firebaseCache = { db: null };
}

function initializeFirebaseAdmin() {
    if (admin.apps.length > 0) {
        return admin;
    }

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;

    if (!projectId || !clientEmail || !privateKeyRaw) {
        throw new Error('Firebase Admin credentials are missing. Add FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in Vercel Environment Variables.');
    }

    const privateKey = String(privateKeyRaw).replace(/\\n/g, '\n');

    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: projectId,
            clientEmail: clientEmail,
            privateKey: privateKey
        })
    });

    return admin;
}

function getDB() {
    initializeFirebaseAdmin();
    if (cached.db) {
        return cached.db;
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
        throw new Error('Razorpay keys are missing. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in Vercel Environment Variables.');
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
    const digits = String(phone).trim().replace(/\D/g, '');
    if (digits.length === 10 && /^[6-9]/.test(digits)) {
        return digits;
    }
    if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) {
        return digits.slice(2);
    }
    return '';
}

function normalizeInstallId(installId) {
    if (!installId) {
        return '';
    }
    return String(installId).trim().slice(0, INSTALL_ID_MAX_LENGTH);
}

function normalizeRideEventId(rideEventId) {
    if (rideEventId === undefined || rideEventId === null) {
        return '';
    }
    return String(rideEventId).trim();
}

function normalizeReferralCode(code) {
    if (!code) {
        return '';
    }
    return String(code).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isValidRechargeAmount(amount) {
    return (
        Number.isFinite(amount) &&
        Number.isInteger(amount) &&
        amount >= MIN_RECHARGE_RUPEES &&
        amount <= MAX_RECHARGE_RUPEES
    );
}

function isValidPin(pin) {
    return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(String(pin || '').trim());
}

function parseVersion(version) {
    const cleaned = String(version || '').trim().replace(/^v/i, '');
    if (!/^\d+(?:\.\d+){0,3}$/.test(cleaned)) {
        return null;
    }
    return cleaned.split('.').map(part => Number(part));
}

function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) {
        return null;
    }
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i++) {
        const av = a[i] || 0;
        const bv = b[i] || 0;
        if (av > bv) return 1;
        if (av < bv) return -1;
    }
    return 0;
}

function isValidHttpsUrl(value) {
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

function generateReferralCode() {
    const bytes = crypto.randomBytes(REFERRAL_CODE_LENGTH);
    let code = '';
    for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
        code += REFERRAL_CODE_ALPHABET[bytes[i] % REFERRAL_CODE_ALPHABET.length];
    }
    return code;
}

function createPinHash(pin) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(pin).trim(), salt, 64, {
        N: 16384,
        r: 8,
        p: 1,
        maxmem: 32 * 1024 * 1024
    }).toString('hex');
    return { pinSalt: salt, pinHash: hash };
}

function verifyPinHash(pin, salt, expectedHash) {
    if (!isValidPin(pin) || !salt || !expectedHash) {
        return false;
    }
    try {
        const actual = crypto.scryptSync(String(pin).trim(), String(salt), 64, {
            N: 16384,
            r: 8,
            p: 1,
            maxmem: 32 * 1024 * 1024
        });
        const expected = Buffer.from(String(expectedHash), 'hex');
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch (error) {
        console.error('PIN VERIFY ERROR:', error);
        return false;
    }
}

function hashInstallId(installId) {
    return crypto.createHash('sha256').update(`driver-ride-picker-install:${installId}`).digest('hex');
}

function hashPhoneForAuth(phone) {
    return crypto.createHash('sha256').update(`driver-ride-picker-auth:${phone}`).digest('hex');
}

function createRideEventDocumentId(phone, rideEventId) {
    return crypto.createHash('sha256').update(`driver-ride-picker-ride-event:${phone}:${rideEventId}`).digest('hex');
}

function generateDriverFirebaseUid(phone) {
    const projectId = process.env.FIREBASE_PROJECT_ID || 'driver-ride-picker';
    const digest = crypto.createHash('sha256').update(`driver:${projectId}:${phone}`).digest('hex');
    return `driver_${digest}`;
}

function generateReceipt() {
    const randomPart = crypto.randomBytes(6).toString('hex');
    return `drp_${Date.now()}_${randomPart}`.slice(0, 40);
}

function verifyRazorpaySignature(orderId, paymentId, signature) {
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
        throw new Error('Razorpay secret is not configured.');
    }
    const generated = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
    if (!signature || generated.length !== signature.length) {
        return false;
    }
    return crypto.timingSafeEqual(Buffer.from(generated, 'utf8'), Buffer.from(signature, 'utf8'));
}

async function decodeFirebaseToken(req) {
    const authorization = String(req.headers.authorization || '');
    if (!authorization.startsWith('Bearer ')) {
        const error = new Error('Firebase authentication token required.');
        error.statusCode = 401;
        throw error;
    }
    const idToken = authorization.substring(7).trim();
    if (!idToken) {
        const error = new Error('Firebase authentication token required.');
        error.statusCode = 401;
        throw error;
    }
    initializeFirebaseAdmin();
    return admin.auth().verifyIdToken(idToken);
}

async function verifyFirebaseIdentity(req, res, next) {
    try {
        const decoded = await decodeFirebaseToken(req);
        if (!decoded.uid) {
            return res.status(401).json({ success: false, message: 'Invalid Firebase user.' });
        }
        req.firebaseUser = {
            uid: decoded.uid,
            signInProvider: decoded.firebase && decoded.firebase.sign_in_provider ? String(decoded.firebase.sign_in_provider) : '',
            decodedToken: decoded
        };
        next();
    } catch (error) {
        console.error('FIREBASE IDENTITY ERROR:', error);
        return res.status(error.statusCode || 401).json({
            success: false,
            message: error.message || 'Invalid or expired Firebase authentication token.'
        });
    }
}

async function verifyFirebaseToken(req, res, next) {
    try {
        const decoded = await decodeFirebaseToken(req);
        if (!decoded.uid) {
            return res.status(401).json({ success: false, message: 'Invalid Firebase user.' });
        }
        const signInProvider = decoded.firebase && decoded.firebase.sign_in_provider ? String(decoded.firebase.sign_in_provider) : '';
        if (signInProvider === 'anonymous') {
            return res.status(401).json({ success: false, message: 'Driver PIN authentication required.' });
        }
        const db = getDB();
        const snapshot = await db.collection('users').where('firebaseUid', '==', decoded.uid).limit(1).get();
        if (snapshot.empty) {
            return res.status(401).json({ success: false, message: 'Driver account authentication required.' });
        }
        const userDoc = snapshot.docs[0];
        const userData = userDoc.data() || {};
        req.firebaseUser = {
            uid: decoded.uid,
            phone: normalizePhone(userData.phone || userDoc.id),
            signInProvider: signInProvider,
            decodedToken: decoded,
            userData: userData
        };
        req.driverUser = userData;

        try {
            Promise.resolve(recordDriverActivity({
                phone: req.firebaseUser.phone,
                uid: req.firebaseUser.uid,
                method: req.method,
                endpoint: req.originalUrl
            })).catch(trackerError => {
                console.error('DRIVER ACTIVITY TRACKER ERROR:', trackerError);
            });
        } catch (trackerError) {
            console.error('DRIVER ACTIVITY TRACKER ERROR:', trackerError);
        }

        next();
    } catch (error) {
        console.error('FIREBASE TOKEN ERROR:', error);
        return res.status(401).json({
            success: false,
            message: error.message || 'Invalid or expired Firebase authentication token.'
        });
    }
}

function getAuthenticatedPhone(req) {
    return normalizePhone(req.firebaseUser?.phone || '');
}

function phoneMatchesAuthenticatedUser(req, suppliedPhone) {
    const authenticatedPhone = getAuthenticatedPhone(req);
    const phone = normalizePhone(suppliedPhone);
    return Boolean(authenticatedPhone && phone && authenticatedPhone === phone);
}

async function getPinLockState(db, phone) {
    const ref = db.collection('authAttempts').doc(hashPhoneForAuth(phone));
    const snapshot = await ref.get();
    if (!snapshot.exists) {
        return { locked: false, lockedUntilMs: 0 };
    }
    const data = snapshot.data() || {};
    const lockedUntilMs = Number(data.lockedUntilMs || 0);
    return {
        locked: lockedUntilMs > Date.now(),
        lockedUntilMs: lockedUntilMs
    };
}

async function recordPinFailure(db, phone) {
    const ref = db.collection('authAttempts').doc(hashPhoneForAuth(phone));
    let result = { failures: 1, locked: false, lockedUntilMs: 0 };

    await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        const data = snapshot.exists ? (snapshot.data() || {}) : {};
        const now = Date.now();
        const existingLockUntil = Number(data.lockedUntilMs || 0);

        if (existingLockUntil > now) {
            result = {
                failures: Number(data.failures || 0),
                locked: true,
                lockedUntilMs: existingLockUntil
            };
            return;
        }

        const failures = Number(data.failures || 0) + 1;
        const locked = failures >= PIN_MAX_ATTEMPTS;
        const lockedUntilMs = locked ? (now + PIN_LOCK_MINUTES * 60 * 1000) : 0;

        transaction.set(ref, {
            failures: failures,
            lockedUntilMs: lockedUntilMs,
            lastFailedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        result = {
            failures: failures,
            locked: locked,
            lockedUntilMs: lockedUntilMs
        };
    });

    return result;
}

async function clearPinFailures(db, phone) {
    await db.collection('authAttempts').doc(hashPhoneForAuth(phone)).delete();
}

async function createUniqueReferralCode(db, userRef) {
    for (let attempt = 0; attempt < 10; attempt++) {
        const code = generateReferralCode();
        const codeRef = db.collection('referralCodes').doc(code);
        const existing = await codeRef.get();
        if (existing.exists) {
            continue;
        }

        try {
            await db.runTransaction(async transaction => {
                const freshCode = await transaction.get(codeRef);
                if (freshCode.exists) {
                    throw new Error('REFERRAL_CODE_COLLISION');
                }
                transaction.set(codeRef, {
                    code: code,
                    userId: userRef.id,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });
            return code;
        } catch (error) {
            if (error.message !== 'REFERRAL_CODE_COLLISION') {
                throw error;
            }
        }
    }

    throw new Error('Unable to generate unique referral code.');
}

// ============================================================
// HOME
// ============================================================

app.get('/', (req, res) => {
    res.send('Driver Ride Picker Backend is Running!');
});

// ============================================================
// APP UPDATE STATUS
// ============================================================

app.get('/api/app/update', (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');

        const currentVersion = String(req.query.currentVersion || '').trim();
        const latestVersionValid = Boolean(parseVersion(APP_LATEST_VERSION));
        const minimumVersionValid = Boolean(parseVersion(APP_MINIMUM_VERSION));

        if (!latestVersionValid || !minimumVersionValid) {
            return res.status(500).json({
                success: false,
                message: 'App update configuration contains an invalid version.'
            });
        }

        const latestVsMinimum = compareVersions(APP_LATEST_VERSION, APP_MINIMUM_VERSION);
        if (latestVsMinimum !== null && latestVsMinimum < 0) {
            return res.status(500).json({
                success: false,
                message: 'App update configuration is invalid: minimum version is newer than latest version.'
            });
        }

        const hasValidApkUrl = isValidHttpsUrl(APP_APK_URL);
        let updateAvailable = false;
        let forceUpdate = false;
        let currentVsLatest = null;
        let currentVsMinimum = null;

        if (currentVersion) {
            currentVsLatest = compareVersions(currentVersion, APP_LATEST_VERSION);
            currentVsMinimum = compareVersions(currentVersion, APP_MINIMUM_VERSION);
            updateAvailable = currentVsLatest !== null && currentVsLatest < 0 && hasValidApkUrl;
            forceUpdate = currentVsMinimum !== null && currentVsMinimum < 0 && hasValidApkUrl;
        }

        return res.json({
            success: true,
            currentVersion: currentVersion || null,
            latestVersion: APP_LATEST_VERSION,
            minimumVersion: APP_MINIMUM_VERSION,
            updateAvailable: updateAvailable,
            forceUpdate: forceUpdate,
            apkUrl: hasValidApkUrl ? APP_APK_URL : '',
            title: APP_UPDATE_TITLE,
            message: APP_UPDATE_MESSAGE,
            releaseNotes: APP_RELEASE_NOTES,
            publishedAt: APP_PUBLISHED_AT || null
        });
    } catch (error) {
        console.error('APP UPDATE STATUS ERROR:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to check app update status.'
        });
    }
});

// ============================================================
// RIDE BOT CONFIG API (REDIS-BACKED VERSION)
// ============================================================

app.get('/api/config/ride-bot', async (req, res) => {
    // 30s CDN cache, 60s stale-while-revalidate — matches Android
    // 15-min poll cycle so we get fresh config well within the window.
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
        const version = await getRideBotConfigVersion();

        res.status(200).json({
            version: version,
            updatedAt: new Date().toISOString(),
            platforms: {
                Uber: {
                    accept_keywords: ["Match", "Accept", "Accept Ride", "Accept Trip", "Confirm"],
                    success_signals: [
                        "start ride",
                        "go to pickup",
                        "going to pickup",
                        "picking up",
                        "pick up location",
                        "navigate",
                        "pickup",
                        "confirm otp",
                        "enter otp",
                        "verify otp",
                        "otp",
                        "arrived",
                        "reached",
                        "waiting",
                        "trip started",
                        "start trip",
                        "rider details",
                        "customer details",
                        "driver details",
                        "you have accepted",
                        "ride accepted",
                        "accepted the ride",
                        "you're on your way",
                        "on the way"
                    ],
                    view_id_patterns: ["accept", "match", "confirm"]
                },
                Ola: {
                    accept_keywords: ["Accept", "Accept Ride", "Accept Trip", "Confirm"],
                    success_signals: [
                        "start ride",
                        "go to pickup",
                        "going to pickup",
                        "picking up",
                        "pick up location",
                        "otp submit",
                        "navigate",
                        "pickup",
                        "confirm otp",
                        "enter otp",
                        "verify otp",
                        "otp",
                        "arrived",
                        "reached",
                        "waiting",
                        "trip started",
                        "start trip",
                        "rider details",
                        "customer details",
                        "driver details",
                        "you have accepted",
                        "ride accepted",
                        "accepted the ride",
                        "you're on your way",
                        "on the way"
                    ],
                    view_id_patterns: ["accept", "confirm"]
                },
                Rapido: {
                    accept_keywords: ["Accept Order", "Accept", "Accept Ride", "Confirm"],
                    success_signals: [
                        "start ride",
                        "go to pickup",
                        "going to pickup",
                        "picking up",
                        "pick up location",
                        "client located",
                        "navigate",
                        "pickup",
                        "confirm otp",
                        "enter otp",
                        "verify otp",
                        "otp",
                        "arrived",
                        "reached",
                        "waiting",
                        "trip started",
                        "start trip",
                        "rider details",
                        "customer details",
                        "driver details",
                        "you have accepted",
                        "ride accepted",
                        "accepted the ride",
                        "you're on your way",
                        "on the way"
                    ],
                    view_id_patterns: ["accept", "order"]
                },
                "Namma Yatri": {
                    accept_keywords: ["Confirm", "Accept", "Accept Ride"],
                    success_signals: [
                        "start ride",
                        "go to pickup",
                        "going to pickup",
                        "picking up",
                        "pick up location",
                        "navigate",
                        "pickup",
                        "confirm otp",
                        "enter otp",
                        "verify otp",
                        "otp",
                        "arrived",
                        "reached",
                        "waiting",
                        "trip started",
                        "start trip",
                        "rider details",
                        "customer details",
                        "driver details",
                        "you have accepted",
                        "ride accepted",
                        "accepted the ride",
                        "you're on your way",
                        "on the way"
                    ],
                    view_id_patterns: ["accept", "confirm"]
                }
            },
            global: {
                max_ride_cycle_duration_ms: 8000,
                watchdog_interval_ms: 2000,
                health_check_interval_ms: 300000
            }
        });
    } catch (error) {
        console.error('RIDE BOT CONFIG ERROR:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to load ride bot config.'
        });
    }
});

// ============================================================
// ADMIN: RIDE BOT CONFIG VERSION CONTROL
// ============================================================
//
// Usage:
//   GET  /api/admin/config/version   → current version
//   POST /api/admin/config/bump      → version = version + 1 (triggers Android update timer)
//   POST /api/admin/config/set       → { version: N } set explicit version
//
// Auth: Authorization: Bearer <ADMIN_TOKEN>
//
app.get('/api/admin/config/version', async (req, res) => {
    if (!verifyAdminToken(req)) {
        return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }
    try {
        const version = await getRideBotConfigVersion();
        return res.json({
            success: true,
            version: version,
            source: 'redis-or-env-fallback'
        });
    } catch (error) {
        console.error('ADMIN CONFIG VERSION ERROR:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to read config version.'
        });
    }
});

app.post('/api/admin/config/bump', async (req, res) => {
    if (!verifyAdminToken(req)) {
        return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }
    try {
        const current = await getRideBotConfigVersion();
        const next = current + 1;
        await redis.set(RIDE_BOT_CONFIG_VERSION_KEY, String(next));
        return res.json({
            success: true,
            previousVersion: current,
            newVersion: next,
            message: `Config version bumped to ${next}. Android clients will pick this up within ~15 min and show the update timer.`
        });
    } catch (error) {
        console.error('ADMIN CONFIG BUMP ERROR:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to bump config version.'
        });
    }
});

app.post('/api/admin/config/set', async (req, res) => {
    if (!verifyAdminToken(req)) {
        return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }
    try {
        const requested = Number(req.body.version);
        if (!Number.isFinite(requested) || requested <= 0 || !Number.isInteger(requested)) {
            return res.status(400).json({
                success: false,
                message: 'version must be a positive integer.'
            });
        }
        await redis.set(RIDE_BOT_CONFIG_VERSION_KEY, String(requested));
        return res.json({
            success: true,
            newVersion: requested
        });
    } catch (error) {
        console.error('ADMIN CONFIG SET ERROR:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to set config version.'
        });
    }
});

// ============================================================
// HEALTH REPORT API
// ============================================================

app.post('/api/health/report', async (req, res) => {
    try {
        const {
            type, platform, appVersion, deviceModel,
            androidVersion, accessibilitySnapshot,
            timestamp, driverPhoneHash
        } = req.body;

        const reportId = `report:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const today = new Date().toISOString().slice(0, 10);

        await redis.setex(reportId, 7 * 24 * 60 * 60, JSON.stringify({
            type, platform, appVersion, deviceModel, androidVersion,
            snapshot: accessibilitySnapshot?.substring(0, 5000),
            timestamp, driverPhoneHash
        }));

        await redis.incr(`counter:${platform}:${type}:${today}`);
        await redis.incr(`counter:total:${today}`);

        return res.status(200).json({ success: true, reportId });
    } catch (error) {
        console.error('Health report error:', error);
        return res.status(500).json({ success: false, error: 'Failed to save report' });
    }
});

// ============================================================
// ADMIN DASHBOARD API
// ============================================================

app.get('/api/admin/dashboard', async (req, res) => {
    if (!verifyAdminToken(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const today = new Date().toISOString().slice(0, 10);
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

        const platforms = ['Ola', 'Rapido', 'Uber', 'Namma Yatri'];
        const types = ['NO_RIDE_DETECTED_5MIN', 'ACCEPT_FAILED', 'SUCCESS_TIMEOUT', 'CREDIT_FAILED'];

        const stats = {};

        for (const platform of platforms) {
            stats[platform] = {};
            for (const type of types) {
                const todayCount = parseInt(await redis.get(`counter:${platform}:${type}:${today}`) || 0);
                const yesterdayCount = parseInt(await redis.get(`counter:${platform}:${type}:${yesterday}`) || 0);
                stats[platform][type] = {
                    today: todayCount,
                    yesterday: yesterdayCount,
                    change: todayCount - yesterdayCount
                };
            }
        }

        const totalToday = parseInt(await redis.get(`counter:total:${today}`) || 0);
        const totalYesterday = parseInt(await redis.get(`counter:total:${yesterday}`) || 0);

        let totalErrors = 0;
        for (const p of Object.keys(stats)) {
            for (const t of Object.keys(stats[p])) totalErrors += stats[p][t].today;
        }
        const healthScore = Math.max(0, 100 - Math.floor(totalErrors / 100));

        return res.status(200).json({
            date: today,
            totalReports: totalToday,
            yesterdayReports: totalYesterday,
            healthScore,
            platforms: stats,
            alert: healthScore < 90 ? "Platform issue detected" : "All systems normal"
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        return res.status(500).json({ error: 'Dashboard failed' });
    }
});

// ============================================================
// PRIVATE DRIVER TRACKER ADMIN ENDPOINT
// ============================================================

app.get('/api/admin/tracker', async (req, res) => {
    return handleDriverTrackerAdmin(req, res);
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
        const snapshot = await getDB().collection('users').limit(1).get();
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

app.post('/api/auth/login', verifyFirebaseIdentity, async (req, res) => {
    try {
        if (req.firebaseUser.signInProvider !== 'anonymous') {
            return res.status(401).json({
                success: false,
                message: 'Firebase anonymous authentication required.'
            });
        }

        const phone = normalizePhone(req.body.phone);
        const pin = String(req.body.pin || '').trim();
        const referralCode = normalizeReferralCode(req.body.referralCode);
        const installId = normalizeInstallId(req.body.installId);
        const deviceId = normalizeInstallId(req.body.deviceId);
        const trialDeviceId = deviceId || installId;

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Please enter a valid 10-digit Indian mobile number.'
            });
        }

        if (!isValidPin(pin)) {
            return res.status(400).json({
                success: false,
                message: 'PIN must be exactly 6 digits.'
            });
        }

        if (!installId) {
            return res.status(400).json({
                success: false,
                message: 'App installation identity required.'
            });
        }

        const db = getDB();
        const lockState = await getPinLockState(db, phone);

        if (lockState.locked) {
            const remainingMinutes = Math.max(1, Math.ceil((lockState.lockedUntilMs - Date.now()) / (60 * 1000)));
            return res.status(429).json({
                success: false,
                message: `Too many wrong PIN attempts. Try again in ${remainingMinutes} minute(s).`
            });
        }

        const userRef = db.collection('users').doc(phone);
        const existingUserDoc = await userRef.get();
        const driverFirebaseUid = generateDriverFirebaseUid(phone);

        let isNewUser = false;
        let trialCreditsAdded = 0;
        let pinWasCreated = false;
        let userData = null;

        if (existingUserDoc.exists) {
            userData = existingUserDoc.data() || {};
            const updates = {};

            if (userData.pinHash && userData.pinSalt) {
                const validPin = verifyPinHash(pin, userData.pinSalt, userData.pinHash);
                if (!validPin) {
                    const failure = await recordPinFailure(db, phone);
                    if (failure.locked) {
                        return res.status(429).json({
                            success: false,
                            message: `Too many wrong PIN attempts. Try again in ${PIN_LOCK_MINUTES} minutes.`
                        });
                    }
                    return res.status(401).json({
                        success: false,
                        message: 'Invalid mobile number or PIN.'
                    });
                }
            } else {
                const pinData = createPinHash(pin);
                updates.pinSalt = pinData.pinSalt;
                updates.pinHash = pinData.pinHash;
                updates.pinCreatedAt = admin.firestore.FieldValue.serverTimestamp();
                pinWasCreated = true;
            }

            if (typeof userData.credits !== 'number') {
                updates.credits = Number(userData.credits || 0);
            }
            if (typeof userData.totalRides !== 'number') {
                updates.totalRides = Number(userData.totalRides || 0);
            }

            updates.firebaseUid = driverFirebaseUid;
            updates.authMethod = 'pin';

            if (!userData.referralCode) {
                updates.referralCode = await createUniqueReferralCode(db, userRef);
            }

            updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

            await userRef.update(updates);
            userData = { ...userData, ...updates };
        } else {
            isNewUser = true;
            const newReferralCode = await createUniqueReferralCode(db, userRef);
            let referralApplied = false;
            let referrerPhone = '';
            let referralLedgerRef = null;

            if (referralCode) {
                const referralRef = db.collection('referralCodes').doc(referralCode);
                const referralDoc = await referralRef.get();

                if (referralDoc.exists) {
                    const referralData = referralDoc.data() || {};
                    const possibleReferrerPhone = normalizePhone(referralData.userId || '');

                    if (possibleReferrerPhone && possibleReferrerPhone !== phone) {
                        const referrerUserRef = db.collection('users').doc(possibleReferrerPhone);
                        const referrerDoc = await referrerUserRef.get();

                        if (referrerDoc.exists) {
                            referralApplied = true;
                            referrerPhone = possibleReferrerPhone;
                            referralLedgerRef = db.collection('referralRewards').doc(`${referrerPhone}_${phone}`);
                        }
                    }
                }
            }

            const pinData = createPinHash(pin);
            const trialClaimRef = db.collection('trialClaims').doc(hashInstallId(installId));
            const deviceTrialClaimRef = db.collection('deviceTrialClaims').doc(hashInstallId(trialDeviceId));

            const transactionResult = await db.runTransaction(async transaction => {
                const freshUser = await transaction.get(userRef);
                if (freshUser.exists) {
                    return { created: false, trialGranted: false };
                }

                const trialDoc = await transaction.get(trialClaimRef);
                const deviceTrialDoc = await transaction.get(deviceTrialClaimRef);
                let ledgerDoc = null;

                if (referralLedgerRef) {
                    ledgerDoc = await transaction.get(referralLedgerRef);
                }

                const trialGranted = !trialDoc.exists && !deviceTrialDoc.exists;
                const startingCredits = trialGranted ? FREE_START_CREDITS : 0;

                transaction.set(userRef, {
                    phone: phone,
                    firebaseUid: driverFirebaseUid,
                    credits: startingCredits,
                    totalRides: 0,
                    referralCode: newReferralCode,
                    referredBy: referralApplied ? referrerPhone : null,
                    referralApplied: referralApplied,
                    pinSalt: pinData.pinSalt,
                    pinHash: pinData.pinHash,
                    authMethod: 'pin',
                    trialClaimed: trialGranted,
                    trialInstallIdHash: hashInstallId(installId),
                    deviceIdHash: hashInstallId(trialDeviceId),
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    pinCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                if (trialGranted) {
                    transaction.set(trialClaimRef, {
                        installIdHash: hashInstallId(installId),
                        firstPhone: phone,
                        creditsGranted: FREE_START_CREDITS,
                        createdAt: admin.firestore.FieldValue.serverTimestamp()
                    });

                    transaction.set(deviceTrialClaimRef, {
                        deviceIdHash: hashInstallId(trialDeviceId),
                        firstPhone: phone,
                        creditsGranted: FREE_START_CREDITS,
                        createdAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                }

                if (referralApplied && referralLedgerRef && (!ledgerDoc || !ledgerDoc.exists)) {
                    transaction.set(referralLedgerRef, {
                        referrerPhone: referrerPhone,
                        referredPhone: phone,
                        bonusCredits: REFERRAL_BONUS_CREDITS,
                        status: 'pending',
                        createdAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                }

                return { created: true, trialGranted: trialGranted };
            });

            if (!transactionResult.created) {
                const racedUser = await userRef.get();
                if (!racedUser.exists) {
                    return res.status(409).json({
                        success: false,
                        message: 'Account creation conflict. Please try again.'
                    });
                }

                userData = racedUser.data() || {};

                if (userData.pinHash && userData.pinSalt) {
                    const validPin = verifyPinHash(pin, userData.pinSalt, userData.pinHash);
                    if (!validPin) {
                        const failure = await recordPinFailure(db, phone);
                        if (failure.locked) {
                            return res.status(429).json({
                                success: false,
                                message: `Too many wrong PIN attempts. Try again in ${PIN_LOCK_MINUTES} minutes.`
                            });
                        }
                        return res.status(401).json({
                            success: false,
                            message: 'Invalid mobile number or PIN.'
                        });
                    }
                }

                trialCreditsAdded = 0;
                isNewUser = false;
            } else {
                trialCreditsAdded = transactionResult.trialGranted ? FREE_START_CREDITS : 0;
                const createdUserDoc = await userRef.get();
                userData = createdUserDoc.data() || {};

                if (referralApplied && referralLedgerRef) {
                    await db.runTransaction(async transaction => {
                        const freshLedger = await transaction.get(referralLedgerRef);
                        if (!freshLedger.exists) {
                            return;
                        }

                        const ledgerData = freshLedger.data() || {};
                        if (ledgerData.status !== 'pending') {
                            return;
                        }

                        const referrerRef = db.collection('users').doc(referrerPhone);
                        const referrerDoc = await transaction.get(referrerRef);
                        if (!referrerDoc.exists) {
                            return;
                        }

                        const referrerData = referrerDoc.data() || {};
                        const currentCredits = Number(referrerData.credits || 0);
                        const updatedCredits = currentCredits + REFERRAL_BONUS_CREDITS;

                        transaction.update(referrerRef, {
                            credits: updatedCredits,
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        });

                        transaction.update(referralLedgerRef, {
                            status: 'rewarded',
                            rewardedAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                    });
                }

                const finalUserDoc = await userRef.get();
                userData = finalUserDoc.data() || {};
            }
        }

        await clearPinFailures(db, phone);

        const firebaseCustomToken = await admin.auth().createCustomToken(driverFirebaseUid, { driver: true });

        // Compute referral count for response consistency
        let referralCount = 0;
        try {
            const referralCountSnapshot = await db
                .collection('referralRewards')
                .where('referrerPhone', '==', phone)
                .where('status', '==', 'rewarded')
                .count()
                .get();
            referralCount = Number(referralCountSnapshot.data().count || 0);
        } catch (_) {
            referralCount = 0;
        }

        return res.json({
            success: true,
            isNewUser: isNewUser,
            trialCreditsAdded: trialCreditsAdded,
            pinWasCreated: pinWasCreated,
            authMethod: 'pin',
            firebaseCustomToken: firebaseCustomToken,
            message: isNewUser
                ? (trialCreditsAdded > 0
                    ? 'Welcome! 10 free credits added.'
                    : 'Account created. This installation has already used the free trial.')
                : (pinWasCreated
                    ? 'PIN created successfully. Welcome back!'
                    : 'Welcome back!'),
            user: {
                phone: userData.phone || phone,
                firebaseUid: driverFirebaseUid,
                credits: Number(userData.credits || 0),
                totalRides: Number(userData.totalRides || 0),
                referralCode: userData.referralCode || '',
                referralCount: referralCount
            }
        });
    } catch (error) {
        console.error('PIN LOGIN ERROR:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error: ' + error.message
        });
    }
});

// ============================================================
// AUTHENTICATED USER BALANCE
// ============================================================

app.get('/api/user/balance/:phone', verifyFirebaseToken, async (req, res) => {
    try {
        const phone = normalizePhone(req.params.phone);

        if (!phoneMatchesAuthenticatedUser(req, phone)) {
            return res.status(403).json({
                success: false,
                message: 'You can only access your own account.'
            });
        }

        const snapshot = await getDB().collection('users').doc(phone).get();

        if (!snapshot.exists) {
            return res.status(404).json({
                success: false,
                message: 'Driver account not found.'
            });
        }

        const data = snapshot.data() || {};

        // Compute live referral count from referralRewards collection
        let referralCount = 0;
        try {
            const referralCountSnapshot = await getDB()
                .collection('referralRewards')
                .where('referrerPhone', '==', phone)
                .where('status', '==', 'rewarded')
                .count()
                .get();
            referralCount = Number(referralCountSnapshot.data().count || 0);
        } catch (_) {
            referralCount = Number(data.referralCount || 0);
        }

        return res.json({
            success: true,
            credits: Number(data.credits || 0),
            totalRides: Number(data.totalRides || 0),
            referralCode: data.referralCode || '',
            referralCount: referralCount
        });
    } catch (error) {
        console.error('BALANCE ERROR:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to load balance.'
        });
    }
});

// ============================================================
// REFERRAL DETAILS (used by MainActivity ReferralScreen)
// ============================================================

app.get('/api/referral/me', verifyFirebaseToken, async (req, res) => {
    try {
        const phone = getAuthenticatedPhone(req);

        if (!phone) {
            return res.status(401).json({
                success: false,
                message: 'Authenticated driver required.'
            });
        }

        const db = getDB();
        const userSnapshot = await db.collection('users').doc(phone).get();

        if (!userSnapshot.exists) {
            return res.status(404).json({
                success: false,
                message: 'Driver account not found.'
            });
        }

        const userData = userSnapshot.data() || {};
        const referralCode = String(userData.referralCode || '').trim();

        let successfulReferrals = 0;
        let creditsEarned = 0;

        try {
            const rewardedSnapshot = await db
                .collection('referralRewards')
                .where('referrerPhone', '==', phone)
                .where('status', '==', 'rewarded')
                .get();

            successfulReferrals = rewardedSnapshot.size;
            creditsEarned = successfulReferrals * REFERRAL_BONUS_CREDITS;
        } catch (referralError) {
            console.error('REFERRAL COUNT ERROR:', referralError);
            successfulReferrals = Number(userData.referralCount || 0);
            creditsEarned = successfulReferrals * REFERRAL_BONUS_CREDITS;
        }

        return res.json({
            success: true,
            referralCode: referralCode,
            successfulReferrals: successfulReferrals,
            creditsEarned: creditsEarned,
            bonusPerReferral: REFERRAL_BONUS_CREDITS,
            message: 'Referral details loaded.'
        });
    } catch (error) {
        console.error('REFERRAL DETAILS ERROR:', error);
        return res.status(500).json({
            success: false,
            message: 'Unable to load referral details.'
        });
    }
});

// ============================================================
// DEDUCT ONE CREDIT FOR SUCCESSFUL RIDE
// ============================================================

app.post('/api/ride/deduct-credit', verifyFirebaseToken, async (req, res) => {
    try {
        const phone = normalizePhone(req.body.phone);

        if (!phoneMatchesAuthenticatedUser(req, phone)) {
            return res.status(403).json({
                success: false,
                message: 'You can only use your own account.'
            });
        }

        const rideEventId = normalizeRideEventId(req.body.rideEventId);

        if (!rideEventId) {
            return res.status(400).json({
                success: false,
                message: 'rideEventId is required for successful ride credit deduction.'
            });
        }

        if (rideEventId.length > RIDE_EVENT_ID_MAX_LENGTH) {
            return res.status(400).json({
                success: false,
                message: `rideEventId must be ${RIDE_EVENT_ID_MAX_LENGTH} characters or fewer.`
            });
        }

        const db = getDB();
        const userRef = db.collection('users').doc(phone);
        const rideEventRef = db.collection('rideCreditEvents').doc(createRideEventDocumentId(phone, rideEventId));

        let remainingCredits = 0;
        let alreadyProcessed = false;

        await db.runTransaction(async transaction => {
            const rideEventSnapshot = await transaction.get(rideEventRef);
            const userSnapshot = await transaction.get(userRef);

            if (rideEventSnapshot.exists) {
                if (!userSnapshot.exists) {
                    const error = new Error('Driver account not found.');
                    error.statusCode = 404;
                    throw error;
                }

                const currentUserData = userSnapshot.data() || {};
                remainingCredits = Number(currentUserData.credits || 0);
                alreadyProcessed = true;
                return;
            }

            if (!userSnapshot.exists) {
                const error = new Error('Driver account not found.');
                error.statusCode = 404;
                throw error;
            }

            const userData = userSnapshot.data() || {};
            const currentCredits = Number(userData.credits || 0);

            if (currentCredits <= 0) {
                const error = new Error('Insufficient credits.');
                error.statusCode = 402;
                throw error;
            }

            remainingCredits = currentCredits - 1;
            const totalRides = Number(userData.totalRides || 0) + 1;

            transaction.set(rideEventRef, {
                phone: phone,
                rideEventId: rideEventId,
                creditsDeducted: 1,
                remainingCredits: remainingCredits,
                totalRidesAfter: totalRides,
                status: 'processed',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            transaction.update(userRef, {
                credits: remainingCredits,
                totalRides: totalRides,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            alreadyProcessed = false;
        });

        if (alreadyProcessed) {
            return res.json({
                success: true,
                alreadyProcessed: true,
                creditsDeducted: 0,
                message: 'Ride credit already processed for this ride.',
                remainingCredits: remainingCredits
            });
        }

        return res.json({
            success: true,
            alreadyProcessed: false,
            creditsDeducted: 1,
            message: 'Ride credit deducted.',
            remainingCredits: remainingCredits
        });
    } catch (error) {
        console.error('DEDUCT CREDIT ERROR:', error);
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || 'Unable to deduct credit.'
        });
    }
});

// ============================================================
// CREATE RAZORPAY ORDER
// ============================================================

app.post('/api/payment/create-order', verifyFirebaseToken, async (req, res) => {
    try {
        const phone = getAuthenticatedPhone(req);
        const amountRupees = Number(req.body.amountRupees);

        if (!phone) {
            return res.status(401).json({
                success: false,
                message: 'Authenticated driver required.'
            });
        }

        if (!isValidRechargeAmount(amountRupees)) {
            return res.status(400).json({
                success: false,
                message: `Recharge must be an integer amount between ₹${MIN_RECHARGE_RUPEES} and ₹${MAX_RECHARGE_RUPEES}.`
            });
        }

        const credits = amountRupees * CREDIT_PER_RUPEE;
        const receipt = generateReceipt();
        const razorpay = getRazorpay();

        const order = await razorpay.orders.create({
            amount: amountRupees * 100,
            currency: 'INR',
            receipt: receipt,
            partial_payment: false,
            notes: {
                app: 'Driver Ride Picker',
                phone: phone,
                credits: String(credits)
            }
        });

        await getDB().collection('paymentOrders').doc(order.id).set({
            orderId: order.id,
            phone: phone,
            amountRupees: amountRupees,
            amountPaise: amountRupees * 100,
            credits: credits,
            currency: 'INR',
            status: 'created',
            receipt: receipt,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json({
            success: true,
            keyId: process.env.RAZORPAY_KEY_ID,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            credits: credits
        });
    } catch (error) {
        console.error('RAZORPAY CREATE ORDER ERROR:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Unable to create Razorpay order.'
        });
    }
});

// ============================================================
// VERIFY RAZORPAY PAYMENT + ADD CREDITS
// ============================================================

app.post('/api/payment/verify', verifyFirebaseToken, async (req, res) => {
    try {
        const phone = getAuthenticatedPhone(req);
        const orderId = String(req.body.orderId || '').trim();
        const paymentId = String(req.body.paymentId || '').trim();
        const signature = String(req.body.signature || '').trim();

        if (!phone || !orderId || !paymentId || !signature) {
            return res.status(400).json({
                success: false,
                message: 'Payment verification data is incomplete.'
            });
        }

        const db = getDB();
        const orderRef = db.collection('paymentOrders').doc(orderId);
        const orderSnapshot = await orderRef.get();

        if (!orderSnapshot.exists) {
            return res.status(404).json({
                success: false,
                message: 'Payment order not found.'
            });
        }

        const orderData = orderSnapshot.data() || {};

        if (normalizePhone(orderData.phone) !== phone) {
            return res.status(403).json({
                success: false,
                message: 'Payment order does not belong to this account.'
            });
        }

        if (!verifyRazorpaySignature(orderId, paymentId, signature)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid Razorpay payment signature.'
            });
        }

        if (orderData.status === 'paid') {
            return res.json({
                success: true,
                alreadyProcessed: true,
                creditsAdded: Number(orderData.credits || 0),
                message: 'Payment already processed.'
            });
        }

        const razorpay = getRazorpay();
        const payment = await razorpay.payments.fetch(paymentId);

        if (String(payment.order_id || '') !== orderId) {
            return res.status(400).json({
                success: false,
                message: 'Payment/order mismatch.'
            });
        }

        if (String(payment.status || '').toLowerCase() !== 'captured') {
            return res.status(400).json({
                success: false,
                message: `Payment is not captured yet. Current status: ${payment.status || 'unknown'}`
            });
        }

        const paidPaise = Number(payment.amount || 0);

        if (paidPaise !== Number(orderData.amountPaise || 0)) {
            return res.status(400).json({
                success: false,
                message: 'Payment amount mismatch.'
            });
        }

        const userRef = db.collection('users').doc(phone);
        const creditsToAdd = Number(orderData.credits || 0);
        let newBalance = 0;

        await db.runTransaction(async transaction => {
            const freshOrder = await transaction.get(orderRef);
            const freshUser = await transaction.get(userRef);

            if (!freshUser.exists) {
                const error = new Error('Driver account not found.');
                error.statusCode = 404;
                throw error;
            }

            const freshOrderData = freshOrder.data() || {};
            const currentCredits = Number(freshUser.data()?.credits || 0);

            if (freshOrderData.status === 'paid') {
                newBalance = currentCredits;
                return;
            }

            newBalance = currentCredits + creditsToAdd;

            transaction.update(userRef, {
                credits: newBalance,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            transaction.update(orderRef, {
                status: 'paid',
                paymentId: paymentId,
                signature: signature,
                paidAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        return res.json({
            success: true,
            alreadyProcessed: false,
            creditsAdded: creditsToAdd,
            newBalance: newBalance,
            paymentId: paymentId,
            orderId: orderId,
            message: `${creditsToAdd} credits added successfully.`
        });
    } catch (error) {
        console.error('RAZORPAY VERIFY ERROR:', error);
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || 'Unable to verify Razorpay payment.'
        });
    }
});

// ============================================================
// VERCEL SERVERLESS ENTRYPOINT
// ============================================================

module.exports = app;
