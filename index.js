/*
 * Driver Ride Picker backend.
 */

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

app.use(cors({
    origin: '*',
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Firebase-AppCheck']
}));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '1mb' }));

// ============================================================
// DRIVER ACTIVITY TRACKER - INLINE
// ============================================================
const TRACKER_COLLECTION = 'driverActivity';
const TRACKER_WRITE_INTERVAL_MS = 5 * 60 * 1000;

let trackerCache = global.driverRidePickerTrackerCache;
if (!trackerCache) {
    trackerCache = global.driverRidePickerTrackerCache = { lastWriteByDriver: new Map() };
}

function trackerHashPhone(phone) { return crypto.createHash('sha256').update(`driver-ride-picker-tracker:${phone}`).digest('hex'); }
function trackerMaskPhone(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) return '**********';
    return normalized.slice(0, 2) + '******' + normalized.slice(-2);
}
function trackerShouldWrite(driverKey) {
    const now = Date.now();
    const lastWrite = trackerCache.lastWriteByDriver.get(driverKey) || 0;
    if (now - lastWrite < TRACKER_WRITE_INTERVAL_MS) return false;
    trackerCache.lastWriteByDriver.set(driverKey, now);
    if (trackerCache.lastWriteByDriver.size > 5000) {
        const cutoff = now - TRACKER_WRITE_INTERVAL_MS * 2;
        for (const [key, timestamp] of trackerCache.lastWriteByDriver) {
            if (timestamp < cutoff) trackerCache.lastWriteByDriver.delete(key);
        }
    }
    return true;
}
async function recordDriverActivity({ phone, uid, method, endpoint }) {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return;
    const driverKey = trackerHashPhone(normalizedPhone);
    if (!trackerShouldWrite(driverKey)) return;
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
    } catch (error) { console.error('DRIVER ACTIVITY TRACKER WRITE ERROR:', error); }
}
function verifyTrackerAdminKey(req) {
    const configuredKey = String(process.env.TRACKER_ADMIN_KEY || '');
    const suppliedKey = String(req.headers['x-tracker-admin-key'] || '');
    if (!configuredKey || !suppliedKey) return false;
    const expected = Buffer.from(configuredKey, 'utf8');
    const supplied = Buffer.from(suppliedKey, 'utf8');
    if (expected.length !== supplied.length) return false;
    return crypto.timingSafeEqual(expected, supplied);
}
function getTrackerStatus(lastSeenMs) {
    const age = Date.now() - lastSeenMs;
    if (age <= 5 * 60 * 1000) return 'active';
    if (age <= 15 * 60 * 1000) return 'recent';
    return 'inactive';
}
function trackerTimestampToIso(timestamp) {
    if (!timestamp) return null;
    if (typeof timestamp.toDate === 'function') return timestamp.toDate().toISOString();
    return null;
}
async function getDriverTrackerSnapshot() {
    const db = getDB();
    const now = Date.now();
    const activeCutoff = now - 5 * 60 * 1000;
    const recentCutoff = now - 15 * 60 * 1000;
    const today = new Date(); today.setHours(0, 0, 0, 0);

    const usersSnapshot = await db.collection('users').count().get();
    const activitySnapshot = await db.collection(TRACKER_COLLECTION).orderBy('lastSeenAt', 'desc').limit(200).get();
    let activeNow = 0, active15Min = 0, activeToday = 0;
    const drivers = [];

    activitySnapshot.forEach(doc => {
        const data = doc.data() || {};
        const lastSeen = data.lastSeenAt;
        const lastSeenMs = lastSeen && typeof lastSeen.toMillis === 'function' ? lastSeen.toMillis() : 0;
        const status = lastSeenMs ? getTrackerStatus(lastSeenMs) : 'inactive';
        if (lastSeenMs >= activeCutoff) activeNow++;
        if (lastSeenMs >= recentCutoff) active15Min++;
        if (lastSeenMs >= today.getTime()) activeToday++;
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
        success: true, generatedAt: new Date().toISOString(),
        summary: { totalDrivers: Number(usersSnapshot.data().count || 0), activeNow, active15Min, activeToday },
        drivers: drivers
    };
}
async function handleDriverTrackerAdmin(req, res) {
    if (!verifyTrackerAdminKey(req)) return res.status(401).json({ success: false, message: 'Unauthorized tracker access.' });
    try { return res.json(await getDriverTrackerSnapshot()); } 
    catch (error) { return res.status(500).json({ success: false, message: 'Unable to load driver activity tracker.' }); }
}

// ============================================================
// CONFIG ✅ TIME BASED SYSTEM
// ============================================================
const TRIAL_DURATION_MS = 24 * 60 * 60 * 1000; // 24 Hours — new users only
const REFERRAL_BONUS_MS = 3 * 60 * 60 * 1000;

const DAILY_PLAN_AMOUNT = 15;
const DAILY_PLAN_DURATION_MS = 24 * 60 * 60 * 1000;
const THREE_DAYS_PLAN_AMOUNT = 39;
const THREE_DAYS_PLAN_DURATION_MS = 3 * 24 * 60 * 60 * 1000;
const WEEKLY_PLAN_AMOUNT = 99;
const WEEKLY_PLAN_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const FIFTEEN_DAYS_PLAN_AMOUNT = 175;
const FIFTEEN_DAYS_PLAN_DURATION_MS = 15 * 24 * 60 * 60 * 1000;
const MONTHLY_PLAN_AMOUNT = 299;
const MONTHLY_PLAN_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

const PLAN_TYPE_DAILY = 'DAILY';
const PLAN_TYPE_THREE_DAYS = 'THREE_DAYS';
const PLAN_TYPE_WEEKLY = 'WEEKLY';
const PLAN_TYPE_FIFTEEN_DAYS = 'FIFTEEN_DAYS';
const PLAN_TYPE_MONTHLY = 'MONTHLY';
const PLAN_TYPE_NONE = 'NONE';

const PLAN_CONFIG_BY_AMOUNT = {
    [DAILY_PLAN_AMOUNT]: { type: PLAN_TYPE_DAILY, durationMs: DAILY_PLAN_DURATION_MS, label: 'Daily' },
    [THREE_DAYS_PLAN_AMOUNT]: { type: PLAN_TYPE_THREE_DAYS, durationMs: THREE_DAYS_PLAN_DURATION_MS, label: '3 Days' },
    [WEEKLY_PLAN_AMOUNT]: { type: PLAN_TYPE_WEEKLY, durationMs: WEEKLY_PLAN_DURATION_MS, label: 'Weekly' },
    [FIFTEEN_DAYS_PLAN_AMOUNT]: { type: PLAN_TYPE_FIFTEEN_DAYS, durationMs: FIFTEEN_DAYS_PLAN_DURATION_MS, label: '15 Days' },
    [MONTHLY_PLAN_AMOUNT]: { type: PLAN_TYPE_MONTHLY, durationMs: MONTHLY_PLAN_DURATION_MS, label: 'Monthly' }
};

const VALID_PLAN_TYPES = [PLAN_TYPE_DAILY, PLAN_TYPE_THREE_DAYS, PLAN_TYPE_WEEKLY, PLAN_TYPE_FIFTEEN_DAYS, PLAN_TYPE_MONTHLY];

const PIN_LENGTH = 6;
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

// ✅ UPDATE VERSION HERE - v1.18.0
const APP_LATEST_VERSION = '1.18.0';
const APP_MINIMUM_VERSION = '1.18.0';
const APP_APK_URL = 'https://github.com/kingocta472-cpu/driver-ride-picker-website/releases/download/v1.18.0/app-release.apk'; 
const APP_UPDATE_TITLE = 'New Update Available';
const APP_UPDATE_MESSAGE = 'Driver Ride Picker ka naya version (v1.18.0) install karein.';
const APP_RELEASE_NOTES = 'v1.18.0: Bug fixes, performance improvements, 24 Hours Free Trial for new users only, +3 Hours Referral Bonus, Smart Auto-Accept Fix, Time-based plans'; 

const INSTALL_ID_MAX_LENGTH = 200;
const REFERRAL_CODE_LENGTH = 8;
const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const TRIAL_IP_LIMIT = 3;
const TRIAL_IP_WINDOW_SECONDS = 86400; // 24 hours

const FAKE_PHONE_PATTERNS = [ /^(\d)\1{9}$/, /^9999\d{6}$/, /^1234\d{6}$/, /^(\d{2})\1{4}$/, /^9876\d{6}$/, /^0000\d{6}$/ ];
function isFakePhone(phone) { return FAKE_PHONE_PATTERNS.some(p => p.test(phone)); }

const RIDE_BOT_CONFIG_VERSION_FALLBACK = Number(process.env.RIDE_BOT_CONFIG_VERSION || 3);
const RIDE_BOT_CONFIG_VERSION_KEY = 'ride-bot-config-version';

async function getRideBotConfigVersion() {
    try {
        const fromRedis = await redis.get(RIDE_BOT_CONFIG_VERSION_KEY);
        const parsed = Number(fromRedis);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } catch (error) { console.error('CONFIG VERSION REDIS READ ERROR:', error); }
    return RIDE_BOT_CONFIG_VERSION_FALLBACK;
}

function verifyAdminToken(req) {
    const expectedToken = String(process.env.ADMIN_TOKEN || '');
    const authHeader = String(req.headers.authorization || '');
    const prefix = 'Bearer ';
    if (!expectedToken || !authHeader.startsWith(prefix)) return false;
    const suppliedToken = authHeader.slice(prefix.length).trim();
    const expected = Buffer.from(expectedToken, 'utf8');
    const supplied = Buffer.from(suppliedToken, 'utf8');
    return expected.length === supplied.length && expected.length > 0 && crypto.timingSafeEqual(expected, supplied);
}

// ============================================================
// FIREBASE INIT
// ============================================================
let cached = global.firebaseCache;
if (!cached) cached = global.firebaseCache = { db: null };

function initializeFirebaseAdmin() {
    if (admin.apps.length > 0) return admin;
    const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!serviceAccountRaw) throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is missing.');
    try {
        const serviceAccount = JSON.parse(serviceAccountRaw);
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        return admin;
    } catch (error) { throw new Error('Failed to initialize Firebase Admin.'); }
}

function getDB() {
    initializeFirebaseAdmin();
    if (cached.db) return cached.db;
    cached.db = admin.firestore();
    return cached.db;
}

// ============================================================
// RAZORPAY INIT
// ============================================================
function getRazorpay() {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) throw new Error('Razorpay keys are missing.');
    return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

// ============================================================
// HELPERS
// ============================================================
function normalizePhone(phone) {
    if (!phone) return '';
    const digits = String(phone).trim().replace(/\D/g, '');
    if (digits.length === 10 && /^[6-9]/.test(digits)) return digits;
    if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) return digits.slice(2);
    return '';
}
function normalizeInstallId(installId) { return installId ? String(installId).trim().slice(0, INSTALL_ID_MAX_LENGTH) : ''; }
function normalizeReferralCode(code) { return code ? String(code).trim().toUpperCase().replace(/[^A-Z0-9]/g, '') : ''; }
function isValidPin(pin) { return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(String(pin || '').trim()); }
function isPlanActive(userData) { return userData && Number(userData.planExpiry || 0) > Date.now(); }
function getActivePlanType(userData) { return isPlanActive(userData) ? String(userData.activePlan || PLAN_TYPE_NONE) : PLAN_TYPE_NONE; }

function parseVersion(version) {
    const cleaned = String(version || '').trim().replace(/^v/i, '');
    if (!/^\d+(?:\.\d+){0,3}$/.test(cleaned)) return null;
    return cleaned.split('.').map(part => Number(part));
}
function compareVersions(left, right) {
    const a = parseVersion(left); const b = parseVersion(right);
    if (!a || !b) return null;
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i++) {
        const av = a[i] || 0; const bv = b[i] || 0;
        if (av > bv) return 1; if (av < bv) return -1;
    }
    return 0;
}
function generateReferralCode() {
    const bytes = crypto.randomBytes(REFERRAL_CODE_LENGTH);
    let code = '';
    for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) code += REFERRAL_CODE_ALPHABET[bytes[i] % REFERRAL_CODE_ALPHABET.length];
    return code;
}
function createPinHash(pin) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(pin).trim(), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }).toString('hex');
    return { pinSalt: salt, pinHash: hash };
}
function verifyPinHash(pin, salt, expectedHash) {
    if (!isValidPin(pin) || !salt || !expectedHash) return false;
    try {
        const actual = crypto.scryptSync(String(pin).trim(), String(salt), 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
        const expected = Buffer.from(String(expectedHash), 'hex');
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch (error) { return false; }
}
function hashInstallId(installId) { return crypto.createHash('sha256').update(`driver-ride-picker-install:${installId}`).digest('hex'); }
function hashPhoneForAuth(phone) { return crypto.createHash('sha256').update(`driver-ride-picker-auth:${phone}`).digest('hex'); }
function generateDriverFirebaseUid(phone) {
    const projectId = process.env.FIREBASE_PROJECT_ID || 'driver-ride-picker';
    const digest = crypto.createHash('sha256').update(`driver:${projectId}:${phone}`).digest('hex');
    return `driver_${digest}`;
}
function generateReceipt() { return `drp_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`.slice(0, 40); }
function verifyRazorpaySignature(orderId, paymentId, signature) {
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) throw new Error('Razorpay secret is not configured.');
    const generated = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
    if (!signature || generated.length !== signature.length) return false;
    return crypto.timingSafeEqual(Buffer.from(generated, 'utf8'), Buffer.from(signature, 'utf8'));
}

function sha512(value) { return crypto.createHash('sha512').update(String(value), 'utf8').digest('hex'); }
function safeEqualHex(left, right) {
    const a = Buffer.from(String(left || '').toLowerCase(), 'utf8');
    const b = Buffer.from(String(right || '').toLowerCase(), 'utf8');
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
function getPayUConfig() {
    const key = String(process.env.PAYU_KEY || '').trim();
    const salt = String(process.env.PAYU_SALT || '').trim();
    if (!key || !salt) throw new Error('PayU is not configured.');
    return { key, salt, environment: 'production', paymentUrl: 'https://secure.payu.in/_payment', verifyUrl: 'https://info.payu.in/merchant/postservice.php?form=2' };
}
function getPublicBackendUrl() {
    const value = String(process.env.PUBLIC_BACKEND_URL || process.env.APP_BASE_URL || '').trim();
    if (!value || !/^https:\/\//i.test(value)) throw new Error('Set PUBLIC_BACKEND_URL to this backend HTTPS deployment URL.');
    return value.replace(/\/$/, '');
}
function generatePayURequestHash(params, salt) {
    const fields = [params.key, params.txnid, params.amount, params.productinfo, params.firstname, params.email,
        params.udf1 || '', params.udf2 || '', params.udf3 || '', params.udf4 || '', params.udf5 || '', '', '', '', '', '', salt];
    return sha512(fields.join('|'));
}
function verifyPayUResponseHash(body, salt) {
    const status = String(body.status || '');
    const reversed = [salt, status, '', '', '', '', '', body.udf5 || '', body.udf4 || '', body.udf3 || '', body.udf2 || '', body.udf1 || '', body.email || '', body.firstname || '', body.productinfo || '', body.amount || '', body.txnid || '', body.key || ''];
    let hashString = reversed.join('|');
    const additionalCharges = body.additionalCharges || body.additional_charges;
    if (additionalCharges) hashString = `${additionalCharges}|${hashString}`;
    return safeEqualHex(sha512(hashString), body.hash);
}
async function verifyPayUTransaction(txnid, cfg) {
    const requestHash = sha512(`${cfg.key}|verify_payment|${txnid}|${cfg.salt}`);
    const form = new URLSearchParams({ key: cfg.key, command: 'verify_payment', var1: txnid, hash: requestHash });
    const response = await fetch(cfg.verifyUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    if (!response.ok) throw new Error(`PayU verification HTTP ${response.status}`);
    const result = await response.json();
    const transaction = result?.transaction_details?.[txnid];
    if (!transaction) throw new Error('PayU did not return transaction details.');
    return transaction;
}
async function sendTelegramMessage(message, replyMarkup = null) {
    const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
    if (!token || !chatId) return { sent: false, reason: 'Telegram is not configured.' };
    
    const payload = { 
        chat_id: chatId, 
        text: message, 
        disable_web_page_preview: true 
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true) throw new Error(data.description || `Telegram HTTP ${response.status}`);
    return { sent: true };
}
async function notifyNewRegistrationIfNeeded(phone, isNewUser) {
    if (!isNewUser) return;
    try {
        const eventRef = getDB().collection('telegramEvents').doc(`registration_${hashPhoneForAuth(phone)}`);
        await eventRef.set({ type: 'new_registration', phoneHash: hashPhoneForAuth(phone), status: 'queued_for_digest', createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    } catch (error) { console.error('REGISTRATION DIGEST QUEUE ERROR:', error.message || error); }
}

function mergeConfigObjects(base, override) {
    if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
    const merged = { ...base, ...override };
    merged.platforms = { ...base.platforms, ...(override.platforms || {}) };
    for (const name of Object.keys(merged.platforms)) {
        const basePlatform = base.platforms[name] || {};
        const overridePlatform = override.platforms?.[name] || {};
        merged.platforms[name] = { ...basePlatform, ...overridePlatform };
        if (Array.isArray(basePlatform.package_names) || Array.isArray(overridePlatform.package_names)) {
            merged.platforms[name].package_names = [...new Set([
                ...(Array.isArray(basePlatform.package_names) ? basePlatform.package_names : []),
                ...(Array.isArray(overridePlatform.package_names) ? overridePlatform.package_names : [])
            ])].filter(packageName => !BLOCKED_DRIVER_PACKAGE_IDS.has(String(packageName).trim()));
        }
    }
    merged.global = { ...base.global, ...(override.global || {}) };
    merged.filters = { ...(base.filters || {}), ...(override.filters || {}) };
    merged.strategies = {
        ...base.strategies,
        ...(override.strategies || {}),
        normal: { ...(base.strategies?.normal || {}) }
    };
    return merged;
}

// ✅ STRATEGY UPDATED: Normal 8, Medium 12
const RIDE_BOT_CONFIG_DATA_KEY = 'ride-bot-config-data';
const BLOCKED_DRIVER_PACKAGE_IDS = new Set(['in.juspay.nammayatri']);
const DEFAULT_RIDE_BOT_CONFIG = {
    platforms: {
        Uber: { package_names: ["com.ubercab.driver"], accept_keywords: ["Match", "Accept", "Accept Ride", "Accept Trip", "Confirm"], success_signals: ["start ride", "go to pickup", "going to pickup", "picking up", "pick up location", "navigate", "pickup", "confirm otp", "enter otp", "verify otp", "otp", "arrived", "reached", "waiting", "trip started", "start trip", "rider details", "customer details", "driver details", "you have accepted", "ride accepted", "accepted the ride", "you're on your way", "on the way"], view_id_patterns: ["accept", "match", "confirm"] },
        Ola: { package_names: ["com.olacabs.driver", "com.olacabs.oladriver"], accept_keywords: ["Accept", "Accept Ride", "Accept Trip", "Confirm"], success_signals: ["start ride", "go to pickup", "going to pickup", "picking up", "pick up location", "otp submit", "navigate", "pickup", "confirm otp", "enter otp", "verify otp", "otp", "arrived", "reached", "waiting", "trip started", "start trip", "rider details", "customer details", "driver details", "you have accepted", "ride accepted", "accepted the ride", "you're on your way", "on the way"], view_id_patterns: ["accept", "confirm"] },
        Rapido: { package_names: ["com.rapido.driver", "com.rapido.rider"], accept_keywords: ["Accept Order", "Accept", "Accept Ride", "Confirm"], success_signals: ["start ride", "go to pickup", "going to pickup", "picking up", "pick up location", "client located", "navigate", "pickup", "confirm otp", "enter otp", "verify otp", "otp", "arrived", "reached", "waiting", "trip started", "start trip", "rider details", "customer details", "driver details", "you have accepted", "ride accepted", "accepted the ride", "you're on your way", "on the way"], view_id_patterns: ["accept", "order"] },
        "Namma Yatri": { package_names: ["net.openkochi.yatripartner", "in.juspay.nammayatripartner", "in.mobility.manayatripartner", "com.nammayatri", "com.mobility.movingtechdriver"], accept_keywords: ["Confirm", "Accept", "Accept Ride"], success_signals: ["start ride", "go to pickup", "going to pickup", "picking up", "pick up location", "navigate", "pickup", "confirm otp", "enter otp", "verify otp", "otp", "arrived", "reached", "waiting", "trip started", "start trip", "rider details", "customer details", "driver details", "you have accepted", "ride accepted", "accepted the ride", "you're on your way", "on the way"], view_id_patterns: ["accept", "confirm"] }
    },
    global: { max_ride_cycle_duration_ms: 8000, watchdog_interval_ms: 2000, health_check_interval_ms: 300000, config_refresh_interval_ms: 60000, maxRideCycleDurationMs: 8000, watchdogIntervalMs: 2000, healthCheckIntervalMs: 300000, configRefreshIntervalMs: 60000 },
    strategies: {
        normal: { attempts: 8, tapIntervalMs: 45, verifyDelayMs: 60, tapMode: 'CENTER' },
        medium: { attempts: 12, tapIntervalMs: 45, verifyDelayMs: 60, tapMode: 'CENTER' },
        high_speed: { attempts: 10, tapIntervalMs: 15, verifyDelayMs: 10, tapMode: 'GHOST' }
    }
};

// Add a verified official platform package to remote config without an APK release.
async function addVerifiedPackageToRemoteConfig(platformName, packageName, verification) {
    if (BLOCKED_DRIVER_PACKAGE_IDS.has(String(packageName || '').trim())) throw new Error('Passenger application package cannot be added to driver config.');
    const stored = await redis.get(RIDE_BOT_CONFIG_DATA_KEY);
    const previous = stored ? (typeof stored === 'string' ? JSON.parse(stored) : stored) : {};
    const merged = mergeConfigObjects(DEFAULT_RIDE_BOT_CONFIG, previous);
    const platformConfig = { ...(merged.platforms?.[platformName] || {}) };
    const current = Array.isArray(platformConfig.package_names) ? platformConfig.package_names : [];
    if (current.includes(packageName)) return { added: false, version: await getRideBotConfigVersion() };
    platformConfig.package_names = [...new Set([...current, packageName])];
    merged.platforms = { ...merged.platforms, [platformName]: platformConfig };
    await redis.set(RIDE_BOT_CONFIG_DATA_KEY, JSON.stringify(merged));
    const previousVersion = await getRideBotConfigVersion();
    const version = previousVersion + 1;
    await redis.set(RIDE_BOT_CONFIG_VERSION_KEY, String(version));
    return { added: true, previousVersion, version };
}

async function decodeFirebaseToken(req) {
    const authorization = String(req.headers.authorization || '');
    if (!authorization.startsWith('Bearer ')) { const error = new Error('Firebase authentication token required.'); error.statusCode = 401; throw error; }
    const idToken = authorization.substring(7).trim();
    if (!idToken) { const error = new Error('Firebase authentication token required.'); error.statusCode = 401; throw error; }
    initializeFirebaseAdmin();
    return admin.auth().verifyIdToken(idToken);
}

async function verifyAppCheck(req, res, next) { next(); }
async function verifyFirebaseToken(req, res, next) {
    try {
        const decoded = await decodeFirebaseToken(req);
        if (!decoded.uid) return res.status(401).json({ success: false, message: 'Invalid Firebase user.' });
        const db = getDB();
        const snapshot = await db.collection('users').where('firebaseUid', '==', decoded.uid).limit(1).get();
        if (snapshot.empty) return res.status(401).json({ success: false, message: 'Driver account authentication required.' });
        const userDoc = snapshot.docs[0];
        const userData = userDoc.data() || {};
        req.firebaseUser = { uid: decoded.uid, phone: normalizePhone(userData.phone || userDoc.id), decodedToken: decoded, userData };
        req.driverUser = userData;
        next();
    } catch (error) { return res.status(401).json({ success: false, message: error.message || 'Invalid token.' }); }
}

function getAuthenticatedPhone(req) { return normalizePhone(req.firebaseUser?.phone || ''); }
function phoneMatchesAuthenticatedUser(req, suppliedPhone) {
    const authenticatedPhone = getAuthenticatedPhone(req); const phone = normalizePhone(suppliedPhone);
    return Boolean(authenticatedPhone && phone && authenticatedPhone === phone);
}

async function createUniqueReferralCode(db, userRef) {
    for (let attempt = 0; attempt < 10; attempt++) {
        const code = generateReferralCode();
        const codeRef = db.collection('referralCodes').doc(code);
        const existing = await codeRef.get();
        if (existing.exists) continue;
        try {
            await db.runTransaction(async transaction => {
                const freshCode = await transaction.get(codeRef);
                if (freshCode.exists) throw new Error('REFERRAL_CODE_COLLISION');
                transaction.set(codeRef, { code, userId: userRef.id, createdAt: admin.firestore.FieldValue.serverTimestamp() });
            });
            return code;
        } catch (error) { if (error.message !== 'REFERRAL_CODE_COLLISION') throw error; }
    }
    throw new Error('Unable to generate unique referral code.');
}

// ============================================================
// TELEGRAM WEBHOOK FOR INLINE BUTTONS (Approval System)
// ============================================================
app.post('/api/telegram/webhook', async (req, res) => {
    try {
        const update = req.body;
        const expectedChatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();

        if (update.callback_query) {
            const callbackQuery = update.callback_query;
            const chatId = String(callbackQuery.message.chat.id);
            const data = callbackQuery.data;
            const messageId = callbackQuery.message.message_id;

            if (chatId !== expectedChatId) return res.status(403).json({ ok: false });

            if (data.startsWith("approve_pkg|")) {
                const parts = data.split("|");
                const platformName = parts[1];
                const packageName = parts[2];

                const saved = await addVerifiedPackageToRemoteConfig(platformName, packageName, {
                    source: 'telegram_admin_manual_approval',
                    approvedAt: new Date().toISOString()
                });

                const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
                await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        message_id: messageId,
                        text: `✅ APPROVED!\nPackage: ${packageName}\nPlatform: ${platformName}\nConfig Version: ${saved.version}\nAdded to remote config successfully.`,
                    })
                });
                
                await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ callback_query_id: callbackQuery.id, text: "Package Approved!" })
                });

            } else if (data === "ignore_pkg") {
                const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
                await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        message_id: messageId,
                        text: `❌ IGNORED.\nNo package was added.`,
                    })
                });
                await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ callback_query_id: callbackQuery.id, text: "Ignored" })
                });
            }
        }
        return res.status(200).send('OK');
    } catch (error) {
        console.error('TELEGRAM WEBHOOK ERROR:', error);
        return res.status(200).send('OK'); 
    }
});

// ============================================================
// ROUTES
// ============================================================
app.get('/', (req, res) => { res.send('Driver Ride Picker Backend is Running!'); });

app.get('/api/app/update', (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache'); res.set('Expires', '0');
        const currentVersion = String(req.query.currentVersion || '').trim();
        const currentVsLatest = compareVersions(currentVersion, APP_LATEST_VERSION);
        const currentVsMinimum = compareVersions(currentVersion, APP_MINIMUM_VERSION);
        const updateAvailable = currentVersion ? (currentVsLatest !== null && currentVsLatest < 0) : true;
        const forceUpdate = currentVersion ? (currentVsMinimum !== null && currentVsMinimum < 0) : false;
        return res.json({ success: true, latestVersion: APP_LATEST_VERSION, minimumVersion: APP_MINIMUM_VERSION, forceUpdate, updateMessage: APP_UPDATE_MESSAGE, downloadUrl: APP_APK_URL, updateAvailable, apkUrl: APP_APK_URL, message: APP_UPDATE_MESSAGE, title: APP_UPDATE_TITLE, releaseNotes: APP_RELEASE_NOTES, currentVersion: currentVersion || null });
    } catch (error) { return res.status(500).json({ success: false, message: 'Unable to check app update status.' }); }
});

app.get('/api/config/ride-bot', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
        const version = await getRideBotConfigVersion();
        let config = { ...DEFAULT_RIDE_BOT_CONFIG };
        try {
            const stored = await redis.get(RIDE_BOT_CONFIG_DATA_KEY);
            if (stored) { const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored; config = mergeConfigObjects(config, parsed); }
        } catch (configError) { console.error('REMOTE RIDE CONFIG READ ERROR:', configError.message || configError); }
        return res.status(200).json({ version, updatedAt: new Date().toISOString(), ...config });
    } catch (error) { return res.status(500).json({ success: false, message: 'Unable to load ride bot config.' }); }
});

// ------------------------------------------------------------
// TELEGRAM DETAILS FIX + MERGING HOURLY & HALF-HOURLY DATA
// ------------------------------------------------------------
app.get('/api/cron/half-hour-summary', async (req, res) => {
    const expected = String(process.env.CRON_SECRET || '');
    const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!expected || !supplied || !safeEqualHex(sha512(expected), sha512(supplied))) return res.status(401).json({ success: false, message: 'Unauthorized cron request.' });
    try {
        const db = getDB();
        const nowMs = Date.now();
        const bucketStartMs = Math.floor(nowMs / 1800000) * 1800000 - 1800000;
        const halfHourKey = new Date(bucketStartMs).toISOString();
        const hourKey = new Date(Math.floor(nowMs / 3600000) * 3600000).toISOString();
        
        const runRef = db.collection('halfHourlySummaryRuns').doc(String(bucketStartMs));
        let claimed = false;
        await db.runTransaction(async tx => {
            const snap = await tx.get(runRef);
            const data = snap.exists ? (snap.data() || {}) : {};
            if (data.status === 'sent' || Number(data.leaseUntilMs || 0) > nowMs) return;
            tx.set(runRef, { status: 'sending', halfHourKey, leaseUntilMs: nowMs + 120000, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            claimed = true;
        });
        if (!claimed) return res.json({ success: true, skipped: true, halfHourKey });

        const telemetryHalfHourly = await db.collection('driverHalfHourlyTelemetry').where('halfHourKey', '==', halfHourKey).get();
        const telemetryHourly = await db.collection('driverHourlyTelemetry').where('hourKey', '==', hourKey).get();

        let success = 0, failed = 0;
        let reasonsMap = {};
        let reportingDrivers = new Set();

        const addData = (docs) => {
            docs.forEach(doc => {
                const d = doc.data() || {};
                success += Math.max(0, Number(d.successCount || 0));
                failed += Math.max(0, Number(d.failCount || 0));
                reportingDrivers.add(d.driverKey);
                
                if (d.failReasons) {
                    let rArr = Array.isArray(d.failReasons) ? d.failReasons : String(d.failReasons).split(', ');
                    rArr.forEach(r => {
                        if (r && r !== 'None') {
                            let key = r.split(':')[0].trim();
                            reasonsMap[key] = (reasonsMap[key] || 0) + 1;
                        }
                    });
                }
            });
        };

        addData(telemetryHalfHourly.docs);
        addData(telemetryHourly.docs);

        const totalRides = success + failed;
        const successPct = totalRides ? success * 100 / totalRides : 0;
        const failPct = totalRides ? failed * 100 / totalRides : 0;

        const usersSnap = await db.collection('users').count().get();
        const totalDrivers = Math.max(0, Number(usersSnap.data().count || 0));
        const cutoff = admin.firestore.Timestamp.fromMillis(nowMs - 5 * 60 * 1000);
        const onlineSnap = await db.collection('driverActivity').where('lastSeenAt', '>=', cutoff).count().get();
        const online = Math.min(totalDrivers, Math.max(0, Number(onlineSnap.data().count || 0)));
        const offline = Math.max(0, totalDrivers - online);

        const startTs = admin.firestore.Timestamp.fromMillis(bucketStartMs);
        const endTs = admin.firestore.Timestamp.fromMillis(bucketStartMs + 1800000);
        const issues = await db.collection('compatibilityReports').where('createdAt', '>=', startTs).where('createdAt', '<', endTs).get();
        const issueCounts = {};
        issues.forEach(doc => { const d = doc.data() || {}; const k = String(d.issueType || 'OTHER'); issueCounts[k] = (issueCounts[k] || 0) + Math.max(1, Number(d.reportedCount || 1)); });
        const issueText = Object.entries(issueCounts).map(([k,v]) => `${k}: ${v}`).join(', ') || 'None';
        
        const registrationWindow = await db.collection('telegramEvents').where('createdAt', '>=', startTs).where('createdAt', '<', endTs).get();
        const newRegistrationCount = registrationWindow.docs.filter(doc => String((doc.data() || {}).type || '') === 'new_registration').length;

        const reasonsText = Object.entries(reasonsMap).map(([k,v]) => `  • ${k}: ${v}`).join('\n') || '  • None';

        const message = [
            '📊 DRIVER RIDE PICKER — 30 MINUTE REPORT',
            `Window (UTC): ${halfHourKey} — ${new Date(bucketStartMs + 1800000).toISOString()}`,
            '',
            '👥 DRIVER STATUS',
            `Total registered: ${totalDrivers}`,
            `🟢 Online (activity in last 5 min): ${online}`,
            `🔴 Offline / not recently active: ${offline}`,
            `🆕 New registrations in this window: ${newRegistrationCount}`,
            '',
            '🚕 RIDE PERFORMANCE',
            `Drivers reporting: ${reportingDrivers.size}`,
            `Total recorded outcomes: ${totalRides}`,
            `✅ Successful: ${success} (${successPct.toFixed(1)}%)`,
            `❌ Failed: ${failed} (${failPct.toFixed(1)}%)`,
            '',
            '⚠️ FAILURE REASONS (Why rides missed):',
            reasonsText,
            '',
            `🔧 Compatibility issues: ${issueText}`,
            'Note: Data is a mix of Hourly and 30-Min reports.'
        ].join('\n');
        
        try {
            const sent = await sendTelegramMessage(message);
            if (!sent.sent) throw new Error(sent.reason || 'Telegram is not configured.');
            await runRef.set({ status: 'sent', sentAt: admin.firestore.FieldValue.serverTimestamp(), leaseUntilMs: 0, successCount: success, failCount: failed, totalDrivers, onlineDrivers: online, offlineDrivers: offline, issueCounts }, { merge: true });
            return res.json({ success: true, sent: true, halfHourKey, totalRides, totalDrivers, online, offline });
        } catch (e) {
            await runRef.set({ status: 'pending', leaseUntilMs: 0, lastError: String(e.message || e).slice(0, 200) }, { merge: true });
            return res.status(502).json({ success: false, message: 'Telegram digest failed and can be retried.' });
        }
    } catch (error) {
        console.error('HALF-HOUR SUMMARY ERROR:', error);
        return res.status(500).json({ success: false, message: 'Unable to generate half-hour report.' });
    }
});

// ============================================================
// GOOGLE PLAY PACKAGE DISCOVERY + VERIFIED AUTO-APPROVAL
// ============================================================
const PLAY_STORE_PLATFORMS = ['Uber', 'Ola', 'Rapido', 'Namma Yatri'];
const PLAY_STORE_MONITOR_DEFAULTS = {
    Uber: {
        developerUrl: 'https://play.google.com/store/apps/dev?id=7908612043055486674',
        searchUrl: 'https://play.google.com/store/search?q=Uber%20Driver&c=apps',
        publisherAliases: ['Uber Technologies, Inc.'],
        titleGroups: [['uber', 'driver']],
        brandTokens: ['uber']
    },
    Ola: {
        developerUrl: 'https://play.google.com/store/apps/developer?id=Ola+%28ANI+TECHNOLOGIES+PRIVATE+LIMITED%29',
        searchUrl: 'https://play.google.com/store/search?q=Ola%20Driver&c=apps',
        publisherAliases: ['Ola (ANI TECHNOLOGIES PRIVATE LIMITED)', 'ANI TECHNOLOGIES PRIVATE LIMITED'],
        titleGroups: [['ola', 'driver']],
        brandTokens: ['ola']
    },
    Rapido: {
        developerUrl: 'https://play.google.com/store/apps/developer?id=Rapido+Bike+Taxi',
        searchUrl: 'https://play.google.com/store/search?q=Rapido%20Captain%20Driver&c=apps',
        publisherAliases: ['Rapido Bike Taxi', 'ROPPEN TRANSPORTATION SERVICES PRIVATE LIMITED'],
        titleGroups: [['rapido', 'captain'], ['rapido', 'driver']],
        brandTokens: ['rapido']
    },
    'Namma Yatri': {
        developerUrl: 'https://play.google.com/store/apps/dev?id=9166297176297744140',
        searchUrl: 'https://play.google.com/store/search?q=Namma%20Yatri%20Driver%20Partner&c=apps',
        publisherAliases: ['Moving Tech', 'MOVING TECH INNOVATIONS PRIVATE LIMITED'],
        titleGroups: [['yatri', 'driver'], ['namma', 'yatri', 'driver'], ['yatri', 'partner'], ['namma', 'yatri', 'partner'], ['mana', 'yatri', 'partner']],
        brandTokens: ['yatri', 'namma', 'mana']
    }
};

function parsePlayStoreMonitorConfig() {
    let overrides = {};
    try {
        const raw = String(process.env.PLAY_STORE_MONITOR_CONFIG || '').trim();
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) overrides = parsed;
            else console.error('PLAY_STORE_MONITOR_CONFIG must be a JSON object. Using built-in defaults.');
        }
    } catch (error) {
        console.error('PLAY_STORE_MONITOR_CONFIG JSON is invalid. Using built-in defaults:', error.message || error);
    }
    const result = {};
    for (const platformName of PLAY_STORE_PLATFORMS) {
        const defaults = PLAY_STORE_MONITOR_DEFAULTS[platformName];
        const override = overrides[platformName] && typeof overrides[platformName] === 'object' ? overrides[platformName] : {};
        result[platformName] = {
            ...defaults,
            ...override,
            publisherAliases: Array.isArray(override.publisherAliases) && override.publisherAliases.length
                ? override.publisherAliases.map(value => String(value).trim()).filter(Boolean)
                : defaults.publisherAliases,
            titleGroups: Array.isArray(override.titleGroups) && override.titleGroups.length
                ? override.titleGroups
                : defaults.titleGroups,
            brandTokens: Array.isArray(override.brandTokens) && override.brandTokens.length
                ? override.brandTokens.map(value => normalizePublisherText(value)).filter(Boolean)
                : defaults.brandTokens
        };
    }
    return result;
}

function htmlToPlainText(value) {
    return String(value || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'").replace(/&nbsp;/gi, ' ')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
        .replace(/\s+/g, ' ').trim();
}
function normalizePublisherText(value) {
    return htmlToPlainText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function safeGooglePlayUrl(value, allowedPaths) {
    try {
        const parsed = new URL(String(value || '').trim());
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'play.google.com') return null;
        if (!allowedPaths.some(path => parsed.pathname === path)) return null;
        return parsed.toString();
    } catch (_) { return null; }
}
function extractPlayStoreCandidates(html, sourceUrl) {
    const source = String(html || '').replace(/&amp;/g, '&').replace(/\\u0026/g, '&');
    const output = new Map();
    const re = /\/store\/apps\/details\?[^"'<>\s]*?\bid=([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)/gi;
    let match;
    while ((match = re.exec(source)) !== null) {
        const packageName = match[1];
        if (!output.has(packageName)) output.set(packageName, { packageName, sourceUrl: String(sourceUrl || '') });
        if (output.size >= 80) break;
    }
    return [...output.values()];
}
function extractTagText(html, tagName) {
    const match = String(html || '').match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
    return match ? htmlToPlainText(match[1]) : '';
}
function extractMetaContent(html, key) {
    const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
    for (const tag of tags) {
        const keyMatch = tag.match(/(?:property|name)=["']([^"']+)["']/i);
        const contentMatch = tag.match(/content=["']([^"']*)["']/i);
        if (keyMatch && contentMatch && keyMatch[1].toLowerCase() === String(key).toLowerCase()) {
            return htmlToPlainText(contentMatch[1]);
        }
    }
    return '';
}
function extractGooglePlayTitle(html) {
    return extractTagText(html, 'h1') || extractMetaContent(html, 'og:title') ||
        extractTagText(html, 'title').replace(/\s*-\s*Apps on Google Play$/i, '').trim();
}
function extractGooglePlayPublisher(html, publisherAliases) {
    const source = String(html || '');
    const h1 = source.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/i);
    const headerRegion = h1 ? source.slice(h1.index + h1[0].length, h1.index + h1[0].length + 5000) : source.slice(0, 7000);
    const linkPattern = /<a\b[^>]*href=["'][^"']*\/store\/apps\/(?:dev|developer)\?[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    const publisherLinks = [];
    let linkMatch;
    while ((linkMatch = linkPattern.exec(headerRegion)) !== null) {
        const label = htmlToPlainText(linkMatch[1]);
        if (label) publisherLinks.push(label);
    }
    const aliases = publisherAliases.map(value => normalizePublisherText(value)).filter(Boolean);
    for (const label of publisherLinks) {
        const normalized = normalizePublisherText(label);
        if (aliases.some(alias => normalized === alias || normalized.includes(alias))) return label;
    }
    if (publisherLinks.length > 0) return '';
    const pageText = normalizePublisherText(source);
    for (let i = 0; i < publisherAliases.length; i++) {
        if (aliases[i] && pageText.includes(aliases[i])) return publisherAliases[i];
    }
    return '';
}
function titleMatchesPlatform(title, titleGroups) {
    const normalized = normalizePublisherText(title);
    if (!normalized) return false;
    return titleGroups.some(group => Array.isArray(group) && group.length > 0 &&
        group.every(token => normalized.includes(normalizePublisherText(token))));
}
function titleLooksLikePlatformDriverApp(title, brandTokens) {
    const normalized = normalizePublisherText(title);
    const brandPresent = brandTokens.some(token => normalized.includes(token));
    const rolePresent = ['driver', 'captain', 'partner', 'fleet'].some(token => normalized.includes(token));
    return brandPresent && rolePresent;
}
async function fetchGooglePlayHtml(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'play.google.com') throw new Error('Only official HTTPS Google Play URLs are allowed.');
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; DriverRidePickerCompatibilityMonitor/1.1)',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-IN,en;q=0.9'
        },
        signal: AbortSignal.timeout(12000)
    });
    const finalUrl = new URL(response.url || url);
    if (finalUrl.hostname !== 'play.google.com') throw new Error('Google Play redirected outside play.google.com.');
    if (!response.ok) throw new Error(`Google Play returned HTTP ${response.status}.`);
    const html = await response.text();
    if (html.length < 500) throw new Error('Google Play returned an unexpectedly short page.');
    return html;
}
async function verifyPlayStoreCandidate(platformName, candidate, setting) {
    if (BLOCKED_DRIVER_PACKAGE_IDS.has(String(candidate?.packageName || '').trim())) return { ...candidate, verified: false, titleMatch: false, publisherMatch: false, reason: 'known_passenger_app_package' };
    const packageName = String(candidate.packageName || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(packageName)) {
        return { packageName, verified: false, reason: 'invalid_package_id' };
    }
    const detailUrl = `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}&hl=en_IN`;
    try {
        const html = await fetchGooglePlayHtml(detailUrl);
        const title = extractGooglePlayTitle(html);
        const publisher = extractGooglePlayPublisher(html, setting.publisherAliases);
        const titleMatch = titleMatchesPlatform(title, setting.titleGroups);
        const publisherMatch = !!publisher;
        return {
            packageName, title, publisher, titleMatch, publisherMatch,
            verified: titleMatch && publisherMatch,
            sourceUrl: candidate.sourceUrl,
            detailUrl,
            reason: titleMatch && publisherMatch ? 'exact_platform_title_and_publisher_match' :
                (!publisherMatch && titleMatch ? 'title_matches_but_publisher_does_not' :
                (publisherMatch && !titleMatch ? 'publisher_matches_but_title_needs_review' : 'title_and_publisher_not_verified'))
        };
    } catch (error) {
        return { packageName, verified: false, reason: `detail_page_check_failed: ${String(error.message || error).slice(0, 140)}`, sourceUrl: candidate.sourceUrl, detailUrl };
    }
}
async function tryAutoApproveReportedUnknownPackage(packageName) {
    const safePackage = String(packageName || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(safePackage)) return { status: 'invalid_package_id' };
    const cacheKey = `play-package-unknown-check:${safePackage}`;
    const cachedRaw = await redis.get(cacheKey);
    if (cachedRaw) {
        const cached = typeof cachedRaw === 'string' ? JSON.parse(cachedRaw) : cachedRaw;
        if (cached && Number(cached.checkedAtMs || 0) > Date.now() - 6 * 60 * 60 * 1000) {
            return { ...cached, cached: true };
        }
    }
    const monitor = parsePlayStoreMonitorConfig();
    const checks = await Promise.all(PLAY_STORE_PLATFORMS.map(platformName =>
        verifyPlayStoreCandidate(platformName, { packageName: safePackage, sourceUrl: 'android_unknown_package_telemetry' }, monitor[platformName])
    ));
    const matches = checks.filter(item => item.verified);
    let result;
    if (matches.length === 1) {
        const candidate = matches[0];
        const platformName = PLAY_STORE_PLATFORMS.find(name =>
            verifyPlayStoreTitleAndPublisherMatch(name, candidate, monitor[name])
        );
        if (!platformName) {
            result = { status: 'manual_review_required', packageName: safePackage, checks };
        } else {
            const saved = await addVerifiedPackageToRemoteConfig(platformName, safePackage, {
                source: 'android_unknown_package_telemetry_verified_on_google_play',
                publisher: candidate.publisher,
                title: candidate.title,
                detailUrl: candidate.detailUrl,
                verification: 'exact_platform_title_and_publisher_match'
            });
            result = { status: saved.added ? 'auto_approved' : 'already_present', platform: platformName, packageName: safePackage, configVersion: saved.version, title: candidate.title, publisher: candidate.publisher };
        }
    } else if (matches.length > 1) {
        result = { status: 'manual_review_required_multiple_platforms', packageName: safePackage, checks };
    } else {
        result = { status: 'manual_review_required', packageName: safePackage, checks };
    }
    result.checkedAtMs = Date.now();
    await redis.set(cacheKey, JSON.stringify(result), { ex: 21600 });
    return result;
}
function verifyPlayStoreTitleAndPublisherMatch(platformName, candidate, setting) {
    return !!setting && titleMatchesPlatform(candidate.title, setting.titleGroups) &&
        !!candidate.publisher && setting.publisherAliases.some(alias =>
            normalizePublisherText(candidate.publisher) === normalizePublisherText(alias) ||
            normalizePublisherText(candidate.publisher).includes(normalizePublisherText(alias))
        );
}

async function runWithConcurrency(items, limit, worker) {
    const output = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) return;
            output[index] = await worker(items[index], index);
        }
    });
    await Promise.all(workers);
    return output;
}
async function getCurrentPlatformPackageNames(platformName) {
    const stored = await redis.get(RIDE_BOT_CONFIG_DATA_KEY);
    const parsed = stored ? (typeof stored === 'string' ? JSON.parse(stored) : stored) : {};
    const merged = mergeConfigObjects(DEFAULT_RIDE_BOT_CONFIG, parsed);
    const values = merged.platforms?.[platformName]?.package_names;
    return new Set(Array.isArray(values) ? values.map(value => String(value).trim()) : []);
}
async function sendPlayStoreReviewAlert(platformName, setting, reason, evidence) {
    const key = `play-package-review:${platformName}`;
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ reason, evidence })).digest('hex');
    const oldRaw = await redis.get(key);
    const old = oldRaw ? (typeof oldRaw === 'string' ? JSON.parse(oldRaw) : oldRaw) : {};
    const now = Date.now();
    if (old.fingerprint === fingerprint && now - Number(old.lastAttemptAt || 0) < 24 * 60 * 60 * 1000) {
        return { sent: false, suppressed: true };
    }
    
    // Find the most likely driver package to offer for approval
    let candidatePackage = "unknown";
    for (let item of evidence) {
        if (item.packageName && item.packageName !== 'unknown' && !item.packageName.includes('consumer')) {
            candidatePackage = item.packageName;
            break;
        }
    }

    const candidates = evidence.slice(0, 12).map(item =>
        `${item.packageName || 'unknown'} | ${item.title || item.reason || 'title unavailable'} | publisher=${item.publisher || 'unverified'}`
    );
    const message = [
        '⚠️ DRIVER RIDE PICKER — GOOGLE PLAY PACKAGE REVIEW REQUIRED',
        `Platform: ${platformName}`,
        `Reason: ${reason}`,
        `Expected publisher: ${setting.publisherAliases.join(' OR ')}`,
        `Candidates:\n${candidates.join('\n') || 'No package candidates found.'}`,
        `\n👇 Niche diye gaye button se approve karein (Agar yeh sahi app hai)`
    ].join('\n');

    const replyMarkup = {
        inline_keyboard: [
            [
                { text: "✅ Approve & Add", callback_data: `approve_pkg|${platformName}|${candidatePackage}` },
                { text: "❌ Ignore", callback_data: `ignore_pkg` }
            ]
        ]
    };

    let result = { sent: false, reason: 'Telegram is not configured.' };
    try { 
        result = await sendTelegramMessage(message, replyMarkup); 
    }
    catch (error) { 
        result = { sent: false, reason: String(error.message || error).slice(0, 180) }; 
    }
    await redis.set(key, JSON.stringify({ fingerprint, lastAttemptAt: now, telegramSent: !!result.sent, reason }), { ex: 7776000 });
    return result;
}
async function runPlayStorePackageDiscovery() {
    const monitor = parsePlayStoreMonitorConfig();
    const results = [];
    for (const platformName of PLAY_STORE_PLATFORMS) {
        const setting = monitor[platformName];
        const developerUrl = safeGooglePlayUrl(setting.developerUrl, ['/store/apps/dev', '/store/apps/developer']);
        const searchUrl = safeGooglePlayUrl(setting.searchUrl, ['/store/search']);
        if (!developerUrl || !searchUrl || !setting.publisherAliases.length || !setting.titleGroups.length) {
            results.push({ platform: platformName, status: 'invalid_monitor_settings' });
            continue;
        }
        try {
            const sourceResults = await Promise.allSettled([fetchGooglePlayHtml(developerUrl), fetchGooglePlayHtml(searchUrl)]);
            const sourceErrors = sourceResults.filter(item => item.status === 'rejected').map(item => String(item.reason?.message || item.reason).slice(0, 150));
            const candidatesByPackage = new Map();
            for (let i = 0; i < sourceResults.length; i++) {
                const item = sourceResults[i];
                if (item.status !== 'fulfilled') continue;
                const url = i === 0 ? developerUrl : searchUrl;
                for (const candidate of extractPlayStoreCandidates(item.value, url)) {
                    if (!candidatesByPackage.has(candidate.packageName)) candidatesByPackage.set(candidate.packageName, candidate);
                }
            }
            const allCandidates = [...candidatesByPackage.values()];
            const currentPackages = await getCurrentPlatformPackageNames(platformName);
            const newCandidates = allCandidates.filter(item => !currentPackages.has(item.packageName)).slice(0, 16);
            if (newCandidates.length === 0) {
                if (sourceErrors.length === 2) {
                    const evidence = [{ packageName: '', reason: sourceErrors.join(' / ') }];
                    const telegram = await sendPlayStoreReviewAlert(platformName, setting, 'Both official Google Play source pages could not be read.', evidence);
                    results.push({ platform: platformName, status: 'source_check_failed', telegramSent: !!telegram.sent, errors: sourceErrors });
                } else {
                    results.push({ platform: platformName, status: 'no_change', candidateCount: allCandidates.length, sourceWarnings: sourceErrors });
                }
                continue;
            }
            const checks = await runWithConcurrency(newCandidates, 4, candidate => verifyPlayStoreCandidate(platformName, candidate, setting));
            const verified = checks.filter(item => item.verified);
            if (verified.length === 1) {
                const candidate = verified[0];
                const saved = await addVerifiedPackageToRemoteConfig(platformName, candidate.packageName, {
                    source: 'official_google_play_developer_and_search_pages',
                    publisher: candidate.publisher,
                    title: candidate.title,
                    sourceUrl: candidate.sourceUrl,
                    detailUrl: candidate.detailUrl,
                    verification: candidate.reason
                });
                const message = [
                    '✅ DRIVER RIDE PICKER — VERIFIED PACKAGE AUTO-ADDED',
                    `Platform: ${platformName}`,
                    `App: ${candidate.title}`,
                    `Publisher: ${candidate.publisher}`,
                    `New package ID: ${candidate.packageName}`,
                    `Remote config version: ${saved.version}`,
                    'Compatible installed APKs can receive this package on their next remote-config refresh.',
                    `Time: ${new Date().toISOString()}`
                ].join('\n');
                try { await sendTelegramMessage(message); } catch (error) { console.error('PLAY STORE SUCCESS TELEGRAM ERROR:', error.message || error); }
                results.push({ platform: platformName, packageName: candidate.packageName, status: saved.added ? 'auto_approved' : 'already_present', configVersion: saved.version, title: candidate.title, publisher: candidate.publisher });
            } else if (verified.length > 1) {
                const telegram = await sendPlayStoreReviewAlert(platformName, setting, 'More than one new listing passed title and publisher checks; automatic selection is unsafe.', verified);
                results.push({ platform: platformName, status: 'manual_review_required_multiple_verified', verifiedCount: verified.length, telegramSent: !!telegram.sent });
            } else {
                const possible = checks.filter(item => item.publisherMatch || (item.titleMatch && titleLooksLikePlatformDriverApp(item.title, setting.brandTokens)));
                if (possible.length > 0 || sourceErrors.length > 0) {
                    const reason = possible.length > 0
                        ? 'A possible replacement listing was found, but it did not pass both title and publisher checks.'
                        : 'Google Play source results were incomplete; no candidate could be verified.';
                    const telegram = await sendPlayStoreReviewAlert(platformName, setting, reason, possible.length ? possible : checks.slice(0, 12));
                    results.push({ platform: platformName, status: 'manual_review_required', reviewedCount: checks.length, telegramSent: !!telegram.sent, sourceWarnings: sourceErrors });
                } else {
                    results.push({ platform: platformName, status: 'no_verified_replacement', reviewedCount: checks.length, sourceWarnings: sourceErrors });
                }
            }
        } catch (error) {
            const evidence = [{ packageName: '', reason: String(error.message || error).slice(0, 160) }];
            let telegram = { sent: false };
            try { telegram = await sendPlayStoreReviewAlert(platformName, setting, 'The package discovery check failed unexpectedly.', evidence); } catch (_) {}
            results.push({ platform: platformName, status: 'check_failed', error: String(error.message || error).slice(0, 180), telegramSent: !!telegram.sent });
        }
    }
    return { success: true, checkedAt: new Date().toISOString(), results };
}
app.get('/api/cron/play-store-package-discovery', async (req, res) => {
    const expected = String(process.env.CRON_SECRET || '');
    const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!expected || !supplied || !safeEqualHex(sha512(expected), sha512(supplied))) {
        return res.status(401).json({ success: false, message: 'Unauthorized cron request.' });
    }
    try { return res.json(await runPlayStorePackageDiscovery()); }
    catch (error) {
        console.error('PLAY STORE PACKAGE DISCOVERY ERROR:', error.message || error);
        return res.status(500).json({ success: false, message: 'Play Store package discovery failed.' });
    }
});
app.post('/api/admin/play-store-package-discovery/run', async (req, res) => {
    if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    try { return res.json(await runPlayStorePackageDiscovery()); }
    catch (error) { return res.status(500).json({ success: false, message: 'Play Store package discovery failed.' }); }
});

// ============================================================
// EXPORT APP
// ============================================================
module.exports = app;
