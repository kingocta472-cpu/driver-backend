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
const TRIAL_DURATION_MS = 24 * 60 * 60 * 1000;
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

// ✅ UPDATED: New version and link applied
const APP_LATEST_VERSION = '1.19.5';
const APP_MINIMUM_VERSION = '1.19.5';
const APP_APK_URL = 'https://github.com/kingocta472-cpu/driver-backend/releases/download/v1.19.5/app-release.apk'; 
const APP_UPDATE_TITLE = 'New Update Available';
const APP_UPDATE_MESSAGE = 'Driver Ride Picker ka naya version (v1.19.5) install karein.';
const APP_RELEASE_NOTES = 'v1.19.5: Bug fixes, performance improvements, 24 Hours Free Trial for new users only, +3 Hours Referral Bonus, Smart Auto-Accept Fix, Time-based plans'; 

const INSTALL_ID_MAX_LENGTH = 200;
const REFERRAL_CODE_LENGTH = 8;
const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const TRIAL_IP_LIMIT = 3;
const TRIAL_IP_WINDOW_SECONDS = 86400;

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

    const payload = { chat_id: chatId, text: message, disable_web_page_preview: true };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true) throw new Error(data.description || `Telegram HTTP ${response.status}`);
    return { sent: true };
}
function maskedPhoneForMessage(phone) {
    const normalized = normalizePhone(phone);
    return normalized ? `${normalized.slice(0, 2)}******${normalized.slice(-2)}` : '**********';
}
async function notifyNewRegistrationIfNeeded(phone, isNewUser) {
    if (!isNewUser) return;
    try {
        const eventRef = getDB().collection('telegramEvents').doc(`registration_${hashPhoneForAuth(phone)}`);
        await eventRef.set({
            type: 'new_registration',
            phoneHash: hashPhoneForAuth(phone),
            status: 'queued_for_digest',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (error) {
        console.error('REGISTRATION DIGEST QUEUE ERROR:', error.message || error);
    }
}

// ============================================================
// FIX 2: mergeStrategies helper (defined before mergeConfigObjects)
// ============================================================
function mergeStrategies(baseStrategies, overrideStrategies) {
    const result = {};
    const names = new Set([...Object.keys(baseStrategies || {}), ...Object.keys(overrideStrategies || {})]);
    for (const name of names) {
        result[name] = { ...((baseStrategies || {})[name] || {}), ...((overrideStrategies || {})[name] || {}) };
    }
    return result;
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
    // FIX 2: properly merge strategies (including `normal`) instead of ignoring override.normal.
    merged.strategies = mergeStrategies(base.strategies, override.strategies);
    return merged;
}

// ============================================================
// FIX 1: validateRemoteRideConfig — required by /api/admin/config/ride-bot
// ============================================================
const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;

function validateRemoteRideConfig(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Config must be a JSON object.');
    const out = {};
    const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
    const num = (value, min, max, name) => {
        const n = Number(value);
        if (value === null || value === '' || !Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max}.`);
        return n;
    };
    const strList = (value, name, maxItems = 60) => {
        if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} must be a list with at most ${maxItems} items.`);
        return value.map(item => {
            const s = String(item).trim();
            if (!s || s.length > 100) throw new Error(`${name} has an empty or too long item.`);
            return s;
        });
    };

    if (input.platforms !== undefined) {
        if (typeof input.platforms !== 'object' || Array.isArray(input.platforms) || !input.platforms) throw new Error('platforms must be an object.');
        out.platforms = {};
        for (const [name, cfg] of Object.entries(input.platforms)) {
            if (!['Uber', 'Ola', 'Rapido', 'Namma Yatri'].includes(name)) throw new Error(`Unknown platform: ${name}`);
            if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`platforms.${name} must be an object.`);
            const p = {};
            for (const [key, value] of Object.entries(cfg)) {
                if (key === 'enabled') p.enabled = Boolean(value);
                else if (key === 'package_names') {
                    const list = strList(value, `${name}.package_names`, 30);
                    for (const pkg of list) {
                        if (!PKG_RE.test(pkg) || pkg.length > 180) throw new Error(`Invalid package name: ${pkg}`);
                        if (BLOCKED_DRIVER_PACKAGE_IDS.has(pkg)) throw new Error('Passenger application package cannot be used as a driver app.');
                    }
                    p.package_names = [...new Set(list)];
                } else if (['accept_keywords', 'acceptKeywords', 'success_signals', 'successSignals', 'view_id_patterns', 'viewIdPatterns'].includes(key)) {
                    p[key] = strList(value, `${name}.${key}`);
                } else throw new Error(`Unsupported platform setting: ${name}.${key}`);
            }
            out.platforms[name] = p;
        }
    }

    if (input.global !== undefined) {
        if (typeof input.global !== 'object' || Array.isArray(input.global) || !input.global) throw new Error('global must be an object.');
        out.global = {};
        for (const [key, value] of Object.entries(input.global)) {
            if (!KEY_RE.test(key)) throw new Error(`Invalid global key: ${key}`);
            // ✅ FIX: bot_enabled / auto_accept_enabled jaise true/false switches ab save ho sakte hain.
            // Pehle boolean ko number bana diya jata tha (true -> 1) ya false par error aata tha,
            // aur Android app us 1 ko boolean nahi padhta.
            if (typeof value === 'boolean') out.global[key] = value;
            else out.global[key] = num(value, 1, 86400000, `global.${key}`);
        }
    }

    if (input.filters !== undefined) {
        if (typeof input.filters !== 'object' || Array.isArray(input.filters) || !input.filters) throw new Error('filters must be an object.');
        out.filters = {};
        for (const [key, value] of Object.entries(input.filters)) {
            if (!KEY_RE.test(key)) throw new Error(`Invalid filter key: ${key}`);
            if (typeof value === 'boolean') out.filters[key] = value;
            else if (value === null) out.filters[key] = null;
            else if (typeof value === 'number') out.filters[key] = num(value, 0, 1000000, `filters.${key}`);
            else if (typeof value === 'string') {
                if (value.length > 40) throw new Error(`filters.${key} is too long.`);
                out.filters[key] = value;
            } else if (Array.isArray(value)) out.filters[key] = strList(value, `filters.${key}`);
            else throw new Error(`Unsupported filter value for ${key}.`);
        }
    }

    if (input.strategies !== undefined) {
        if (typeof input.strategies !== 'object' || Array.isArray(input.strategies) || !input.strategies) throw new Error('strategies must be an object.');
        out.strategies = {};
        for (const [name, cfg] of Object.entries(input.strategies)) {
            if (!['normal', 'medium', 'high_speed'].includes(name)) throw new Error(`Unknown strategy: ${name}`);
            if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`strategies.${name} must be an object.`);
            const s = {};
            for (const [key, value] of Object.entries(cfg)) {
                if (['attempts', 'attemptsSlow', 'attempts_slow'].includes(key)) s[key] = Math.round(num(value, 1, 20, `${name}.${key}`));
                else if (['tapIntervalMs', 'tap_interval_ms', 'verifyDelayMs', 'verify_delay_ms', 'verifyDelaySlowMs', 'verify_delay_slow_ms'].includes(key)) s[key] = Math.round(num(value, 5, 1000, `${name}.${key}`));
                else if (key === 'tapMode') {
                    const mode = String(value).toUpperCase();
                    if (!['CENTER', 'GHOST'].includes(mode)) throw new Error('tapMode must be CENTER or GHOST.');
                    s.tapMode = mode;
                } else throw new Error(`Unsupported strategy setting: ${name}.${key}`);
            }
            out.strategies[name] = s;
        }
    }
    return out;
}

// ✅ STRATEGY UPDATED: Normal 8, Medium 12
const RIDE_BOT_CONFIG_DATA_KEY = 'ride-bot-config-data';
// 🛑 BLOCKED PACKAGES (Passenger & Wallet apps)
const BLOCKED_DRIVER_PACKAGE_IDS = new Set([
    'in.juspay.nammayatri',
    // Uber
    'com.ubercab', 'com.ubercab.eats', 'com.postmates.android', 'com.uber.restaurants', 'com.uber.restaurantmanager',
    // Ola
    'com.olacabs.customer', 'com.olacabs.olamoney',
    // Rapido
    'com.rapido.rider',
    // Namma Yatri
    'in.mobility.keralasavaariconsumer', 'com.mobility.movingtech', 'net.openkochi.yatri'
]);

const DEFAULT_RIDE_BOT_CONFIG = {
    platforms: {
        Uber: { package_names: ["com.ubercab.driver"], accept_keywords: ["Match", "Accept", "Accept Ride", "Accept Trip", "Confirm"], success_signals: ["start ride", "go to pickup", "going to pickup", "picking up", "pick up location", "navigate", "pickup", "confirm otp", "enter otp", "verify otp", "otp", "arrived", "reached", "waiting", "trip started", "start trip", "rider details", "customer details", "driver details", "you have accepted", "ride accepted", "accepted the ride", "you're on your way", "on the way"], view_id_patterns: ["accept", "match", "confirm"] },
        Ola: { package_names: ["com.olacabs.driver", "com.olacabs.oladriver"], accept_keywords: ["Accept", "Accept Ride", "Accept Trip", "Confirm"], success_signals: ["start ride", "go to pickup", "going to pickup", "picking up", "pick up location", "otp submit", "navigate", "pickup", "confirm otp", "enter otp", "verify otp", "otp", "arrived", "reached", "waiting", "trip started", "start trip", "rider details", "customer details", "driver details", "you have accepted", "ride accepted", "accepted the ride", "you're on your way", "on the way"], view_id_patterns: ["accept", "confirm"] },
        Rapido: { package_names: ["com.rapido.driver"], accept_keywords: ["Accept Order", "Accept", "Accept Ride", "Confirm"], success_signals: ["start ride", "go to pickup", "going to pickup", "picking up", "pick up location", "client located", "navigate", "pickup", "confirm otp", "enter otp", "verify otp", "otp", "arrived", "reached", "waiting", "trip started", "start trip", "rider details", "customer details", "driver details", "you have accepted", "ride accepted", "accepted the ride", "you're on your way", "on the way"], view_id_patterns: ["accept", "order"] },
        "Namma Yatri": { package_names: ["net.openkochi.yatripartner", "in.juspay.nammayatripartner", "in.mobility.manayatripartner", "com.nammayatri", "com.mobility.movingtechdriver"], accept_keywords: ["Confirm", "Accept", "Accept Ride"], success_signals: ["start ride", "go to pickup", "going to pickup", "picking up", "pick up location", "navigate", "pickup", "confirm otp", "enter otp", "verify otp", "otp", "arrived", "reached", "waiting", "trip started", "start trip", "rider details", "customer details", "driver details", "you have accepted", "ride accepted", "accepted the ride", "you're on your way", "on the way"], view_id_patterns: ["accept", "confirm"] }
    },
    // ✅ FIXED: config_refresh_interval_ms 60000 → 900000 (15 minutes). Har 60s pe cache clear hona band.
    global: { max_ride_cycle_duration_ms: 8000, watchdog_interval_ms: 2000, health_check_interval_ms: 300000, config_refresh_interval_ms: 900000, maxRideCycleDurationMs: 8000, watchdogIntervalMs: 2000, healthCheckIntervalMs: 300000, configRefreshIntervalMs: 900000 },
    strategies: {
        normal: { attempts: 8, tapIntervalMs: 45, verifyDelayMs: 60, tapMode: 'CENTER' },
        medium: { attempts: 12, tapIntervalMs: 45, verifyDelayMs: 60, tapMode: 'CENTER' },
        // ✅ FIXED: high_speed verifyDelayMs 60 → 15. Slow-mode fallbacks (attemptsSlow, verifyDelaySlowMs) bhi add.
        high_speed: { attempts: 10, attemptsSlow: 12, tapIntervalMs: 15, verifyDelayMs: 15, verifyDelaySlowMs: 25, tapMode: 'GHOST' }
    }
};

async function decodeFirebaseToken(req) {
    const authorization = String(req.headers.authorization || '');
    if (!authorization.startsWith('Bearer ')) { const error = new Error('Firebase authentication token required.'); error.statusCode = 401; throw error; }
    const idToken = authorization.substring(7).trim();
    if (!idToken) { const error = new Error('Firebase authentication token required.'); error.statusCode = 401; throw error; }
    initializeFirebaseAdmin();
    return admin.auth().verifyIdToken(idToken);
}

async function verifyAppCheck(req, res, next) {
    const enforce = process.env.APP_CHECK_ENFORCE === 'true';
    const appCheckToken = req.headers['x-firebase-appcheck'];
    if (!appCheckToken) {
        if (enforce) return res.status(403).json({ success: false, message: 'Access Denied: Missing App Check Token.' });
        else return next();
    }
    try {
        initializeFirebaseAdmin();
        await admin.appCheck().verifyToken(appCheckToken);
        next();
    } catch (error) {
        if (enforce) return res.status(403).json({ success: false, message: 'Access Denied: Invalid App Check Token.' });
        else return next();
    }
}

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

        try { Promise.resolve(recordDriverActivity({ phone: req.firebaseUser.phone, uid: req.firebaseUser.uid, method: req.method, endpoint: req.originalUrl })).catch(trackerError => console.error('TRACKER ERROR:', trackerError)); } catch (trackerError) { console.error('TRACKER ERROR:', trackerError); }
        next();
    } catch (error) {
        console.error('FIREBASE TOKEN ERROR:', error);
        return res.status(401).json({ success: false, message: error.message || 'Invalid or expired Firebase authentication token.' });
    }
}

function getAuthenticatedPhone(req) { return normalizePhone(req.firebaseUser?.phone || ''); }
function phoneMatchesAuthenticatedUser(req, suppliedPhone) {
    const authenticatedPhone = getAuthenticatedPhone(req); const phone = normalizePhone(suppliedPhone);
    return Boolean(authenticatedPhone && phone && authenticatedPhone === phone);
}
async function getPinLockState(db, phone) {
    const ref = db.collection('authAttempts').doc(hashPhoneForAuth(phone));
    const snapshot = await ref.get();
    if (!snapshot.exists) return { locked: false, lockedUntilMs: 0 };
    const data = snapshot.data() || {};
    const lockedUntilMs = Number(data.lockedUntilMs || 0);
    return { locked: lockedUntilMs > Date.now(), lockedUntilMs };
}
async function recordPinFailure(db, phone) {
    const ref = db.collection('authAttempts').doc(hashPhoneForAuth(phone));
    let result = { failures: 1, locked: false, lockedUntilMs: 0 };
    await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        const data = snapshot.exists ? (snapshot.data() || {}) : {};
        const now = Date.now();
        const existingLockUntil = Number(data.lockedUntilMs || 0);
        if (existingLockUntil > now) { result = { failures: Number(data.failures || 0), locked: true, lockedUntilMs: existingLockUntil }; return; }
        const failures = Number(data.failures || 0) + 1;
        const locked = failures >= PIN_MAX_ATTEMPTS;
        const lockedUntilMs = locked ? (now + PIN_LOCK_MINUTES * 60 * 1000) : 0;
        transaction.set(ref, { failures, lockedUntilMs, lastFailedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        result = { failures, locked, lockedUntilMs };
    });
    return result;
}
async function clearPinFailures(db, phone) { await db.collection('authAttempts').doc(hashPhoneForAuth(phone)).delete(); }

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
        return res.json({
            success: true, latestVersion: APP_LATEST_VERSION, minimumVersion: APP_MINIMUM_VERSION,
            forceUpdate, updateMessage: APP_UPDATE_MESSAGE, downloadUrl: APP_APK_URL,
            updateAvailable, apkUrl: APP_APK_URL, message: APP_UPDATE_MESSAGE,
            title: APP_UPDATE_TITLE, releaseNotes: APP_RELEASE_NOTES, currentVersion: currentVersion || null
        });
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
            if (stored) {
                const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
                config = mergeConfigObjects(config, parsed);
            }
        } catch (configError) { console.error('REMOTE RIDE CONFIG READ ERROR:', configError.message || configError); }
        return res.status(200).json({ version, updatedAt: new Date().toISOString(), ...config });
    } catch (error) { return res.status(500).json({ success: false, message: 'Unable to load ride bot config.' }); }
});

app.post('/api/admin/config/ride-bot', async (req, res) => {
    if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    try {
        const clean = validateRemoteRideConfig(req.body?.config || req.body);
        const previousStored = await redis.get(RIDE_BOT_CONFIG_DATA_KEY);
        const previous = previousStored ? (typeof previousStored === 'string' ? JSON.parse(previousStored) : previousStored) : {};
        const merged = mergeConfigObjects(mergeConfigObjects(DEFAULT_RIDE_BOT_CONFIG, previous), clean);
        await redis.set(RIDE_BOT_CONFIG_DATA_KEY, JSON.stringify(merged));
        const previousVersion = await getRideBotConfigVersion();
        const newVersion = previousVersion + 1;
        await redis.set(RIDE_BOT_CONFIG_VERSION_KEY, String(newVersion));
        return res.json({ success: true, previousVersion, newVersion, config: merged });
    } catch (error) { return res.status(400).json({ success: false, message: error.message || 'Unable to save remote config.' }); }
});

app.post('/api/admin/platform/package/add', async (req, res) => {
    if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    try {
        const platformName = String(req.body?.platform || '').trim();
        const packageName = String(req.body?.packageName || '').trim();
        const allowedPlatforms = ['Uber', 'Ola', 'Rapido', 'Namma Yatri'];
        const packagePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
        if (!allowedPlatforms.includes(platformName)) return res.status(400).json({ success: false, message: 'Invalid platform. Use Uber, Ola, Rapido, or Namma Yatri.' });
        if (!packagePattern.test(packageName) || packageName.length > 180) return res.status(400).json({ success: false, message: 'Invalid Android package name.' });
        if (BLOCKED_DRIVER_PACKAGE_IDS.has(packageName)) return res.status(400).json({ success: false, message: 'Passenger application package cannot be approved as a driver app.' });

        const stored = await redis.get(RIDE_BOT_CONFIG_DATA_KEY);
        const previous = stored ? (typeof stored === 'string' ? JSON.parse(stored) : stored) : {};
        const merged = mergeConfigObjects(DEFAULT_RIDE_BOT_CONFIG, previous);
        const platformConfig = { ...(merged.platforms?.[platformName] || {}) };
        const current = Array.isArray(platformConfig.package_names) ? platformConfig.package_names : [];
        const alreadyPresent = current.includes(packageName);
        platformConfig.package_names = [...new Set([...current, packageName])];
        merged.platforms = { ...merged.platforms, [platformName]: platformConfig };

        if (!alreadyPresent) {
            await redis.set(RIDE_BOT_CONFIG_DATA_KEY, JSON.stringify(merged));
            const previousVersion = await getRideBotConfigVersion();
            const newVersion = previousVersion + 1;
            await redis.set(RIDE_BOT_CONFIG_VERSION_KEY, String(newVersion));
            return res.json({ success: true, added: true, platform: platformName, packageName, previousVersion, newVersion, message: 'Package added. Compatible installed APKs will receive it on their next remote-config refresh.' });
        }
        return res.json({ success: true, added: false, platform: platformName, packageName, version: await getRideBotConfigVersion(), message: 'Package already exists in remote config.' });
    } catch (error) {
        console.error('PLATFORM PACKAGE ADD ERROR:', error.message || error);
        return res.status(500).json({ success: false, message: 'Unable to add platform package.' });
    }
});

app.get('/api/admin/config/version', async (req, res) => {
    if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    try { return res.json({ success: true, version: await getRideBotConfigVersion(), source: 'redis-or-env-fallback' }); }
    catch (error) { return res.status(500).json({ success: false, message: 'Unable to read config version.' }); }
});

app.post('/api/admin/config/bump', async (req, res) => {
    if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    try {
        const current = await getRideBotConfigVersion(); const next = current + 1;
        await redis.set(RIDE_BOT_CONFIG_VERSION_KEY, String(next));
        return res.json({ success: true, previousVersion: current, newVersion: next, message: `Config version bumped to ${next}.` });
    } catch (error) { return res.status(500).json({ success: false, message: 'Unable to bump config version.' }); }
});

app.post('/api/admin/config/set', async (req, res) => {
    if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    try {
        const requested = Number(req.body.version);
        if (!Number.isFinite(requested) || requested <= 0 || !Number.isInteger(requested)) return res.status(400).json({ success: false, message: 'version must be a positive integer.' });
        await redis.set(RIDE_BOT_CONFIG_VERSION_KEY, String(requested));
        return res.json({ success: true, newVersion: requested });
    } catch (error) { return res.status(500).json({ success: false, message: 'Unable to set config version.' }); }
});

app.post('/api/health/report', verifyAppCheck, async (req, res) => {
    try {
        const type = String(req.body?.type || 'UNKNOWN').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 50) || 'UNKNOWN';
        const platform = String(req.body?.platform || 'UNKNOWN').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 40) || 'UNKNOWN';
        const appVersion = String(req.body?.appVersion || '').trim().slice(0, 30);
        const deviceModel = String(req.body?.deviceModel || '').trim().slice(0, 80);
        const androidVersion = String(req.body?.androidVersion || '').trim().slice(0, 30);
        const timestamp = String(req.body?.timestamp || '').slice(0, 40);
        const reportId = `report:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`;
        const today = new Date().toISOString().slice(0, 10);
        const report = { type, platform, appVersion, deviceModel, androidVersion, timestamp, receivedAt: new Date().toISOString() };
        await redis.setex(reportId, 7 * 24 * 60 * 60, JSON.stringify(report));
        await redis.incr(`counter:${platform}:${type}:${today}`);
        await redis.incr(`counter:total:${today}`);
        return res.status(200).json({ success: true, reportId });
    } catch (error) {
        console.error('HEALTH REPORT ERROR:', error.message || error);
        return res.status(500).json({ success: false, error: 'Failed to save report' });
    }
});

app.get('/api/admin/dashboard', async (req, res) => {
    if (!verifyAdminToken(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const today = new Date().toISOString().slice(0, 10); const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const platforms = ['Ola', 'Rapido', 'Uber', 'Namma Yatri']; const types = ['NO_RIDE_DETECTED_5MIN', 'ACCEPT_FAILED', 'SUCCESS_TIMEOUT', 'CREDIT_FAILED'];
        const stats = {};
        for (const platform of platforms) {
            stats[platform] = {};
            for (const type of types) {
                const todayCount = parseInt(await redis.get(`counter:${platform}:${type}:${today}`) || 0);
                const yesterdayCount = parseInt(await redis.get(`counter:${platform}:${type}:${yesterday}`) || 0);
                stats[platform][type] = { today: todayCount, yesterday: yesterdayCount, change: todayCount - yesterdayCount };
            }
        }
        const totalToday = parseInt(await redis.get(`counter:total:${today}`) || 0); const totalYesterday = parseInt(await redis.get(`counter:total:${yesterday}`) || 0);
        let totalErrors = 0; for (const p of Object.keys(stats)) { for (const t of Object.keys(stats[p])) totalErrors += stats[p][t].today; }
        const healthScore = Math.max(0, 100 - Math.floor(totalErrors / 100));
        return res.status(200).json({ date: today, totalReports: totalToday, yesterdayReports: totalYesterday, healthScore, platforms: stats, alert: healthScore < 90 ? "Platform issue detected" : "All systems normal" });
    } catch (error) { return res.status(500).json({ error: 'Dashboard failed' }); }
});

app.get('/api/admin/tracker', async (req, res) => { return handleDriverTrackerAdmin(req, res); });
app.get('/api/test', (req, res) => { res.json({ success: true, message: 'Android app successfully connected to Firebase backend!', timestamp: new Date().toISOString() }); });

// ============================================================
// LOGIN / REGISTER ✅ APP CHECK VERIFIED
// ============================================================
app.post('/api/auth/login', verifyAppCheck, async (req, res) => {
    try {
        const phone = normalizePhone(req.body.phone);
        const pin = String(req.body.pin || '').trim();
        const referralCode = normalizeReferralCode(req.body.referralCode);
        const installId = normalizeInstallId(req.body.installId);
        const deviceId = normalizeInstallId(req.body.deviceId);
        const trialDeviceId = deviceId || installId;

        if (!phone) return res.status(400).json({ success: false, message: 'Please enter a valid 10-digit Indian mobile number.' });
        if (isFakePhone(phone)) return res.status(400).json({ success: false, message: 'Please enter a real mobile number.' });
        if (!isValidPin(pin)) return res.status(400).json({ success: false, message: 'PIN must be exactly 6 digits.' });
        if (!installId) return res.status(400).json({ success: false, message: 'App installation identity required.' });

        const db = getDB();
        const lockState = await getPinLockState(db, phone);

        if (lockState.locked) {
            const remainingMinutes = Math.max(1, Math.ceil((lockState.lockedUntilMs - Date.now()) / (60 * 1000)));
            return res.status(429).json({ success: false, message: `Too many wrong PIN attempts. Try again in ${remainingMinutes} minute(s).` });
        }

        const userRef = db.collection('users').doc(phone);
        const existingUserDoc = await userRef.get();
        const driverFirebaseUid = generateDriverFirebaseUid(phone);

        let isNewUser = false; let trialAdded = false; let pinWasCreated = false; let userData = null;

        if (existingUserDoc.exists) {
            userData = existingUserDoc.data() || {};
            const updates = {};

            if (userData.pinHash && userData.pinSalt) {
                if (!verifyPinHash(pin, userData.pinSalt, userData.pinHash)) {
                    const failure = await recordPinFailure(db, phone);
                    if (failure.locked) return res.status(429).json({ success: false, message: `Too many wrong PIN attempts. Try again in ${PIN_LOCK_MINUTES} minutes.` });
                    return res.status(401).json({ success: false, message: 'Invalid mobile number or PIN.' });
                }
            } else {
                const pinData = createPinHash(pin);
                updates.pinSalt = pinData.pinSalt; updates.pinHash = pinData.pinHash; updates.pinCreatedAt = admin.firestore.FieldValue.serverTimestamp(); pinWasCreated = true;
            }

            if (!userData.migratedToTimeSystem) {
                updates.migratedToTimeSystem = true;
            }

            if (!userData.v18PromoClaimed) {
                updates.v18PromoClaimed = true;
            }

            if (typeof userData.activePlan !== 'string') updates.activePlan = PLAN_TYPE_NONE;
            if (typeof userData.planExpiry !== 'number') updates.planExpiry = updates.planExpiry || 0;
            if (typeof userData.totalRides !== 'number') updates.totalRides = Number(userData.totalRides || 0);

            updates.firebaseUid = driverFirebaseUid; updates.authMethod = 'pin';
            if (!userData.referralCode) updates.referralCode = await createUniqueReferralCode(db, userRef);
            updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

            await userRef.update(updates);
            userData = { ...userData, ...updates };
        } else {
            try {
                const clientIp = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
                if (clientIp && clientIp !== 'unknown' && clientIp !== '::1' && clientIp !== '127.0.0.1') {
                    const ipKey = `trial:ip:${clientIp}`; const currentCount = parseInt(await redis.get(ipKey) || '0', 10);
                    if (currentCount >= TRIAL_IP_LIMIT) return res.status(429).json({ success: false, message: 'Is network se bahut zyada naye account bane hain. Kripya kal try karein.' });
                    // ✅ FIX: expire ab incr ke result par lagta hai, taaki key kabhi bina expiry ke na rahe
                    // (pehle expire sirf stale 'currentCount === 0' par lagta tha).
                    const newCount = await redis.incr(ipKey);
                    if (newCount === 1) await redis.expire(ipKey, TRIAL_IP_WINDOW_SECONDS);
                }
            } catch (ipError) { console.error('IP RATE LIMIT ERROR:', ipError); }

            isNewUser = true;
            const newReferralCode = await createUniqueReferralCode(db, userRef);
            let referralApplied = false; let referrerPhone = ''; let referralLedgerRef = null;

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
                            referralApplied = true; referrerPhone = possibleReferrerPhone;
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
                if (freshUser.exists) return { created: false, trialGranted: false };

                const trialDoc = await transaction.get(trialClaimRef);
                const deviceTrialDoc = await transaction.get(deviceTrialClaimRef);
                let ledgerDoc = null;
                if (referralLedgerRef) ledgerDoc = await transaction.get(referralLedgerRef);

                const trialGranted = !trialDoc.exists && !deviceTrialDoc.exists;
                const startingExpiry = trialGranted ? (Date.now() + TRIAL_DURATION_MS) : 0;

                transaction.set(userRef, {
                    phone, firebaseUid: driverFirebaseUid, activePlan: PLAN_TYPE_NONE, planExpiry: startingExpiry,
                    totalRides: 0, referralCode: newReferralCode, referredBy: referralApplied ? referrerPhone : null,
                    referralApplied, pinSalt: pinData.pinSalt, pinHash: pinData.pinHash, authMethod: 'pin',
                    trialClaimed: trialGranted, trialInstallIdHash: hashInstallId(installId), deviceIdHash: hashInstallId(trialDeviceId),
                    migratedToTimeSystem: true,
                    v18PromoClaimed: true,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    pinCreatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                if (trialGranted) {
                    transaction.set(trialClaimRef, { installIdHash: hashInstallId(installId), firstPhone: phone, hoursGranted: 24, createdAt: admin.firestore.FieldValue.serverTimestamp() });
                    transaction.set(deviceTrialClaimRef, { deviceIdHash: hashInstallId(trialDeviceId), firstPhone: phone, hoursGranted: 24, createdAt: admin.firestore.FieldValue.serverTimestamp() });
                }

                if (referralApplied && referralLedgerRef && (!ledgerDoc || !ledgerDoc.exists)) {
                    transaction.set(referralLedgerRef, { referrerPhone, referredPhone: phone, bonusHours: 3, status: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp() });
                }

                return { created: true, trialGranted };
            });

            if (!transactionResult.created) {
                const racedUser = await userRef.get();
                if (!racedUser.exists) return res.status(409).json({ success: false, message: 'Account creation conflict. Please try again.' });
                userData = racedUser.data() || {};
                if (userData.pinHash && userData.pinSalt) {
                    if (!verifyPinHash(pin, userData.pinSalt, userData.pinHash)) {
                        const failure = await recordPinFailure(db, phone);
                        if (failure.locked) return res.status(429).json({ success: false, message: `Too many wrong PIN attempts. Try again in ${PIN_LOCK_MINUTES} minutes.` });
                        return res.status(401).json({ success: false, message: 'Invalid mobile number or PIN.' });
                    }
                }
                trialAdded = false; isNewUser = false;
            } else {
                trialAdded = transactionResult.trialGranted;
                const createdUserDoc = await userRef.get();
                userData = createdUserDoc.data() || {};

                if (referralApplied && referralLedgerRef) {
                    await db.runTransaction(async transaction => {
                        const freshLedger = await transaction.get(referralLedgerRef);
                        if (!freshLedger.exists) return;
                        const ledgerData = freshLedger.data() || {};
                        if (ledgerData.status !== 'pending') return;
                        const referrerRef = db.collection('users').doc(referrerPhone);
                        const referrerDoc = await transaction.get(referrerRef);
                        if (!referrerDoc.exists) return;
                        const referrerData = referrerDoc.data() || {};
                        let refExpiry = Number(referrerData.planExpiry || 0);
                        const now = Date.now();
                        if (refExpiry < now) refExpiry = now;
                        const updatedExpiry = refExpiry + REFERRAL_BONUS_MS;
                        transaction.update(referrerRef, { planExpiry: updatedExpiry, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                        transaction.update(referralLedgerRef, { status: 'rewarded', rewardedAt: admin.firestore.FieldValue.serverTimestamp() });
                    });
                }
                const finalUserDoc = await userRef.get();
                userData = finalUserDoc.data() || {};
            }
        }

        await clearPinFailures(db, phone);
        const firebaseCustomToken = await admin.auth().createCustomToken(driverFirebaseUid, { driver: true });

        let referralCount = 0;
        try {
            const referralCountSnapshot = await db.collection('referralRewards').where('referrerPhone', '==', phone).where('status', '==', 'rewarded').count().get();
            referralCount = Number(referralCountSnapshot.data().count || 0);
        } catch (_) { referralCount = 0; }

        const planExpiry = Number(userData.planExpiry || 0);
        const activePlan = getActivePlanType(userData);
        const isUnlimited = planExpiry > Date.now();

        let welcomeMessage;
        if (isNewUser) {
            welcomeMessage = trialAdded ? `Welcome! 24 Hours Free Trial activated.` : 'Account created. This installation has already used the free trial.';
        } else {
            welcomeMessage = pinWasCreated ? 'PIN created successfully. Welcome back!' : 'Welcome back!';
        }

        await notifyNewRegistrationIfNeeded(phone, isNewUser);

        return res.json({
            success: true, isNewUser, trialPlanAdded: trialAdded, pinWasCreated, authMethod: 'pin',
            firebaseCustomToken, message: welcomeMessage,
            user: {
                phone: userData.phone || phone, firebaseUid: driverFirebaseUid, activePlan, planExpiry, isUnlimited,
                totalRides: Number(userData.totalRides || 0), referralCode: userData.referralCode || '', referralCount
            }
        });
    } catch (error) {
        console.error('PIN LOGIN ERROR:', error);
        return res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

app.get('/api/user/balance/:phone', verifyFirebaseToken, async (req, res) => {
    try {
        const phone = normalizePhone(req.params.phone);
        if (!phoneMatchesAuthenticatedUser(req, phone)) return res.status(403).json({ success: false, message: 'You can only access your own account.' });
        const snapshot = await getDB().collection('users').doc(phone).get();
        if (!snapshot.exists) return res.status(404).json({ success: false, message: 'Driver account not found.' });
        const data = snapshot.data() || {};

        let referralCount = 0;
        try {
            const referralCountSnapshot = await getDB().collection('referralRewards').where('referrerPhone', '==', phone).where('status', '==', 'rewarded').count().get();
            referralCount = Number(referralCountSnapshot.data().count || 0);
        } catch (_) { referralCount = Number(data.referralCount || 0); }

        const planExpiry = Number(data.planExpiry || 0);
        const activePlan = getActivePlanType(data);
        const isUnlimited = planExpiry > Date.now();

        return res.json({
            success: true, activePlan, planExpiry,
            planExpiryIso: planExpiry > 0 ? new Date(planExpiry).toISOString() : null,
            isUnlimited, totalRides: Number(data.totalRides || 0), referralCode: data.referralCode || '', referralCount
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Unable to load balance.' });
    }
});

app.get('/api/referral/me', verifyFirebaseToken, async (req, res) => {
    try {
        const phone = getAuthenticatedPhone(req);
        if (!phone) return res.status(401).json({ success: false, message: 'Authenticated driver required.' });
        const db = getDB();
        const userSnapshot = await db.collection('users').doc(phone).get();
        if (!userSnapshot.exists) return res.status(404).json({ success: false, message: 'Driver account not found.' });
        const userData = userSnapshot.data() || {};
        const referralCode = String(userData.referralCode || '').trim();

        let successfulReferrals = 0; let hoursEarned = 0;
        try {
            const rewardedSnapshot = await db.collection('referralRewards').where('referrerPhone', '==', phone).where('status', '==', 'rewarded').get();
            successfulReferrals = rewardedSnapshot.size; hoursEarned = successfulReferrals * 3;
        } catch (referralError) {
            successfulReferrals = Number(userData.referralCount || 0); hoursEarned = successfulReferrals * 3;
        }
        return res.json({ success: true, referralCode, successfulReferrals, hoursEarned, bonusHoursPerReferral: 3, message: 'Referral details loaded.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Unable to load referral details.' });
    }
});

app.post('/api/ride/deduct-credit', verifyFirebaseToken, async (req, res) => {
    try {
        const phone = normalizePhone(req.body.phone);
        if (!phoneMatchesAuthenticatedUser(req, phone)) return res.status(403).json({ success: false, message: 'You can only use your own account.' });
        const db = getDB();
        const userRef = db.collection('users').doc(phone);
        const userSnapshot = await userRef.get();
        if (!userSnapshot.exists) return res.status(404).json({ success: false, message: 'Driver account not found.' });
        const userData = userSnapshot.data() || {};
        const planExpiry = Number(userData.planExpiry || 0);
        const isUnlimited = planExpiry > Date.now();
        const activePlanType = getActivePlanType(userData);

        if (isUnlimited) {
            const totalRides = Number(userData.totalRides || 0) + 1;
            await userRef.update({ totalRides, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            return res.json({ success: true, alreadyProcessed: false, ridesDeducted: 0, unlimited: true, planType: activePlanType, message: `Unlimited ${activePlanType} plan active. No deduction.` });
        } else {
            return res.status(402).json({ success: false, message: 'Plan expired. Please recharge to continue.' });
        }
    } catch (error) { return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Unable to process ride.' }); }
});

app.post('/api/ride/refund-credit', verifyFirebaseToken, async (req, res) => {
    return res.json({ success: true, refunded: false, alreadyRefunded: false, message: 'Refund not applicable in time-based system.' });
});

// ------------------------------------------------------------
// PAYU HOSTED CHECKOUT (Razorpay routes below remain unchanged)
// ------------------------------------------------------------
app.get('/api/payment/providers', verifyFirebaseToken, async (req, res) => {
    const razorpayEnabled = Boolean(
        String(process.env.RAZORPAY_KEY_ID || '').trim() &&
        String(process.env.RAZORPAY_KEY_SECRET || '').trim()
    );
    const payuBaseUrl = String(process.env.PUBLIC_BACKEND_URL || process.env.APP_BASE_URL || '').trim();
    const payuEnabled = Boolean(
        String(process.env.PAYU_KEY || '').trim() &&
        String(process.env.PAYU_SALT || '').trim() &&
        /^https:\/\//i.test(payuBaseUrl)
    );

    const providers = [
        { id: 'RAZORPAY', name: 'Razorpay', enabled: razorpayEnabled },
        { id: 'PAYU', name: 'PayU', enabled: payuEnabled }
    ];
    const defaultProvider = razorpayEnabled ? 'RAZORPAY' : (payuEnabled ? 'PAYU' : 'NONE');

    return res.json({ success: true, providers, defaultProvider });
});
app.post('/api/payment/payu/create-order', verifyFirebaseToken, async (req, res) => {
    try {
        const phone = getAuthenticatedPhone(req);
        const amountRupees = Number(req.body.amountRupees);
        const email = String(req.body.email || '').trim().toLowerCase();
        const firstName = String(req.body.firstName || 'Driver').trim().replace(/[<>|]/g, '').slice(0, 50) || 'Driver';
        if (!phone) return res.status(401).json({ success: false, message: 'Authenticated driver required.' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return res.status(400).json({ success: false, message: 'Valid email address is required for PayU checkout.' });
        const planConfig = PLAN_CONFIG_BY_AMOUNT[amountRupees];
        if (!planConfig) return res.status(400).json({ success: false, message: 'Invalid plan amount.' });
        const cfg = getPayUConfig();
        const baseUrl = getPublicBackendUrl();
        const txnid = `drp${Date.now()}${crypto.randomBytes(4).toString('hex')}`.slice(0, 25);
        const amount = amountRupees.toFixed(2);
        const productinfo = `Driver Ride Picker ${planConfig.label}`;
        const params = {
            key: cfg.key, txnid, amount, productinfo, firstname: firstName, email, phone,
            udf1: phone, udf2: '', udf3: '', udf4: '', udf5: '',
            surl: `${baseUrl}/api/payment/payu/return`, furl: `${baseUrl}/api/payment/payu/return`,
            curl: `${baseUrl}/api/payment/payu/return`
        };
        params.hash = generatePayURequestHash(params, cfg.salt);
        const orderRef = getDB().collection('paymentOrders').doc(`payu_${txnid}`);
        await orderRef.set({
            orderId: txnid, txnid, paymentGateway: 'PAYU', phone, amountRupees, amountPaise: amountRupees * 100,
            planType: planConfig.type, planDurationMs: planConfig.durationMs, currency: 'INR', status: 'created',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return res.json({
            success: true,
            provider: 'PAYU',
            txnid,
            orderId: txnid,
            amount,
            currency: 'INR',
            planType: planConfig.type,
            planDurationMs: planConfig.durationMs,
            checkoutUrl: cfg.paymentUrl,
            formData: params
        });
    } catch (error) { return res.status(500).json({ success: false, message: error.message || 'Unable to create PayU order.' }); }
});

app.post('/api/payment/payu/return', async (req, res) => {
    const body = req.body || {};
    const txnid = String(body.txnid || '').trim();
    const failPage = (message) => res.status(200).type('html').send(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Status</title><body style="font-family:Arial;padding:24px;text-align:center"><h2>Payment not confirmed</h2><p>${String(message).replace(/[<>]/g, '')}</p><p>Return to Driver Ride Picker and check your plan status.</p></body></html>`);
    const successPage = () => res.status(200).type('html').send('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Verified</title><body style="font-family:Arial;padding:24px;text-align:center"><h2>Payment verified</h2><p>Your plan has been activated. Return to Driver Ride Picker and refresh your balance.</p></body></html>');
    try {
        if (!txnid) return failPage('Transaction reference missing.');
        const cfg = getPayUConfig();
        if (String(body.key || '') !== cfg.key || !verifyPayUResponseHash(body, cfg.salt)) return failPage('Payment response could not be authenticated.');
        const orderRef = getDB().collection('paymentOrders').doc(`payu_${txnid}`);
        const orderSnapshot = await orderRef.get();
        if (!orderSnapshot.exists) return failPage('Payment order not found.');
        const orderData = orderSnapshot.data() || {};
        if (String(body.status || '').toLowerCase() !== 'success') {
            await orderRef.set({ status: 'failed', payuStatus: String(body.status || 'unknown'), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            return failPage('The payment provider reported an unsuccessful payment.');
        }
        if (normalizePhone(body.udf1 || '') !== normalizePhone(orderData.phone || '')) return failPage('Payment driver reference mismatch.');
        if (Number(Number(body.amount).toFixed(2)) !== Number(Number(orderData.amountRupees).toFixed(2))) return failPage('Payment amount mismatch.');
        if (orderData.status === 'paid') return successPage();

        const verified = await verifyPayUTransaction(txnid, cfg);
        const verifiedStatus = String(verified.status || '').toLowerCase();
        const verifiedAmount = Number(verified.amount || verified.transaction_amount || 0);
        if (verifiedStatus !== 'success' || Number(verifiedAmount.toFixed(2)) !== Number(Number(orderData.amountRupees).toFixed(2))) {
            return failPage('PayU verification did not confirm the expected amount and success status.');
        }
        if (String(verified.txnid || txnid) !== txnid) return failPage('PayU transaction reference mismatch.');

        const db = getDB();
        const userRef = db.collection('users').doc(normalizePhone(orderData.phone));
        let newPlanExpiry = 0;
        await db.runTransaction(async transaction => {
            const freshOrder = await transaction.get(orderRef);
            const freshUser = await transaction.get(userRef);
            if (!freshUser.exists) throw new Error('Driver account not found.');
            if (freshOrder.data()?.status === 'paid') { newPlanExpiry = Number(freshUser.data()?.planExpiry || 0); return; }
            const planType = String(orderData.planType || '').toUpperCase();
            const duration = Number(orderData.planDurationMs || 0);
            if (!VALID_PLAN_TYPES.includes(planType) || duration <= 0) throw new Error('Invalid stored PayU plan details.');
            const now = Date.now();
            const currentExpiry = Number(freshUser.data()?.planExpiry || 0);
            newPlanExpiry = (currentExpiry > now ? currentExpiry : now) + duration;
            transaction.update(userRef, { activePlan: planType, planExpiry: newPlanExpiry, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            transaction.update(orderRef, { status: 'paid', paymentGateway: 'PAYU', paymentId: String(verified.mihpayid || body.mihpayid || ''), payuStatus: verifiedStatus, activatedPlan: planType, planExpiry: newPlanExpiry, paidAt: admin.firestore.FieldValue.serverTimestamp() });
        });
        return successPage();
    } catch (error) {
        console.error('PAYU RETURN/VERIFY ERROR:', error.message || error);
        return failPage('We could not verify this payment yet. Please reopen the app and check your plan status.');
    }
});

app.post('/api/payment/payu/verify', verifyFirebaseToken, async (req, res) => {
    try {
        const phone = getAuthenticatedPhone(req);
        const txnid = String(req.body.txnid || '').trim();
        if (!phone || !/^[A-Za-z0-9_-]{8,40}$/.test(txnid)) return res.status(400).json({ success: false, message: 'Valid transaction reference is required.' });
        const db = getDB();
        const orderRef = db.collection('paymentOrders').doc(`payu_${txnid}`);
        const orderSnapshot = await orderRef.get();
        if (!orderSnapshot.exists) return res.status(404).json({ success: false, message: 'Payment order not found.' });
        const orderData = orderSnapshot.data() || {};
        if (normalizePhone(orderData.phone) !== phone) return res.status(403).json({ success: false, message: 'Payment order mismatch.' });
        if (orderData.status === 'paid') return res.json({ success: true, alreadyProcessed: true, provider: 'PAYU', planType: orderData.planType || PLAN_TYPE_NONE, planExpiry: Number(orderData.planExpiry || 0), message: 'Payment already processed.' });
        const cfg = getPayUConfig();
        const verified = await verifyPayUTransaction(txnid, cfg);
        const verifiedStatus = String(verified.status || '').toLowerCase();
        const verifiedAmount = Number(verified.amount || verified.transaction_amount || 0);
        if (verifiedStatus !== 'success') return res.status(202).json({ success: false, alreadyProcessed: false, provider: 'PAYU', status: verifiedStatus || 'pending', planType: PLAN_TYPE_NONE, planExpiry: 0, message: 'Payment is not confirmed yet. Please check again shortly.' });
        if (Number(verifiedAmount.toFixed(2)) !== Number(Number(orderData.amountRupees).toFixed(2)) || String(verified.txnid || txnid) !== txnid) return res.status(400).json({ success: false, message: 'PayU transaction amount or reference mismatch.' });
        let planExpiry = 0;
        await db.runTransaction(async transaction => {
            const freshOrder = await transaction.get(orderRef);
            const userRef = db.collection('users').doc(phone);
            const freshUser = await transaction.get(userRef);
            if (!freshUser.exists) throw new Error('Driver account not found.');
            if (freshOrder.data()?.status === 'paid') { planExpiry = Number(freshOrder.data()?.planExpiry || freshUser.data()?.planExpiry || 0); return; }
            const planType = String(orderData.planType || '').toUpperCase();
            const duration = Number(orderData.planDurationMs || 0);
            if (!VALID_PLAN_TYPES.includes(planType) || duration <= 0) throw new Error('Invalid stored PayU plan details.');
            const now = Date.now();
            const currentExpiry = Number(freshUser.data()?.planExpiry || 0);
            planExpiry = (currentExpiry > now ? currentExpiry : now) + duration;
            transaction.update(userRef, { activePlan: planType, planExpiry, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            transaction.update(orderRef, { status: 'paid', paymentGateway: 'PAYU', paymentId: String(verified.mihpayid || ''), payuStatus: verifiedStatus, activatedPlan: planType, planExpiry, paidAt: admin.firestore.FieldValue.serverTimestamp() });
        });
        return res.json({ success: true, alreadyProcessed: false, provider: 'PAYU', status: 'success', planType: orderData.planType, planExpiry, planExpiryIso: planExpiry ? new Date(planExpiry).toISOString() : null, message: 'Payment verified and plan activated.' });
    } catch (error) {
        console.error('PAYU APP VERIFY ERROR:', error.message || error);
        return res.status(500).json({ success: false, message: 'Unable to verify PayU payment right now.' });
    }
});

app.get('/api/payment/payu/status/:txnid', verifyFirebaseToken, async (req, res) => {
    try {
        const phone = getAuthenticatedPhone(req);
        const txnid = String(req.params.txnid || '').trim();
        if (!/^[A-Za-z0-9_-]{8,40}$/.test(txnid)) return res.status(400).json({ success: false, message: 'Invalid transaction reference.' });
        const snapshot = await getDB().collection('paymentOrders').doc(`payu_${txnid}`).get();
        if (!snapshot.exists) return res.status(404).json({ success: false, message: 'Payment order not found.' });
        const data = snapshot.data() || {};
        if (normalizePhone(data.phone) !== phone) return res.status(403).json({ success: false, message: 'Payment order mismatch.' });
        return res.json({ success: true, txnid, status: data.status || 'unknown', planType: data.planType || PLAN_TYPE_NONE, planExpiry: Number(data.planExpiry || 0) });
    } catch (error) { return res.status(500).json({ success: false, message: 'Unable to load PayU payment status.' }); }
});

app.post('/api/telemetry/summary', verifyFirebaseToken, async (req, res) => {
    try {
        const phone = normalizePhone(req.body.phone);
        if (!phoneMatchesAuthenticatedUser(req, phone)) return res.status(403).json({ success: false, message: 'You can only submit telemetry for your own account.' });
        let successCount = Number(req.body.successCount || 0);
        let failCount = Number(req.body.failCount || 0);
        if (req.body.totalRides !== undefined && req.body.successPercent !== undefined && req.body.failPercent !== undefined) {
            const total = Number(req.body.totalRides);
            const successPercent = Number(req.body.successPercent);
            const failPercent = Number(req.body.failPercent);
            if (!Number.isSafeInteger(total) || total < 0 || total > 100000 || !Number.isFinite(successPercent) || !Number.isFinite(failPercent) || successPercent < 0 || successPercent > 100 || failPercent < 0 || failPercent > 100) return res.status(400).json({ success: false, message: 'Invalid telemetry summary.' });
            successCount = Math.round(total * successPercent / 100);
            failCount = Math.max(0, total - successCount);
        }
        if (!Number.isSafeInteger(successCount) || successCount < 0 || successCount > 100000 || !Number.isSafeInteger(failCount) || failCount < 0 || failCount > 100000) return res.status(400).json({ success: false, message: 'Invalid telemetry counts.' });
        const driverKey = hashPhoneForAuth(phone);
        const reasons = Array.isArray(req.body.failReasons) ? req.body.failReasons.slice(0, 10).map(x => String(x).slice(0, 120)) : (typeof req.body.failReasons === 'string' && req.body.failReasons.trim() ? [req.body.failReasons.trim().slice(0, 1200)] : []);
        const suppliedPeriodStart = Number(req.body.periodStartMs || 0);
        if (Number.isSafeInteger(suppliedPeriodStart) && suppliedPeriodStart > 0 && suppliedPeriodStart <= Date.now() && Date.now() - suppliedPeriodStart <= 2 * 60 * 60 * 1000) {
            const bucketStartMs = Math.floor(suppliedPeriodStart / (30 * 60 * 1000)) * (30 * 60 * 1000);
            const halfHourKey = new Date(bucketStartMs).toISOString();
            const reportRef = getDB().collection('driverHalfHourlyTelemetry').doc(`${driverKey}_${bucketStartMs}`);
            await reportRef.set({ driverKey, halfHourKey, periodStartMs: bucketStartMs, successCount, failCount, failReasons: reasons, deviceInfo: String(req.body.deviceInfo || '').slice(0, 120), receivedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            return res.json({ success: true, accepted: true, halfHourKey });
        }
        const hourStart = new Date(); hourStart.setUTCMinutes(0, 0, 0);
        const hourKey = hourStart.toISOString();
        const reportRef = getDB().collection('driverHourlyTelemetry').doc(`${driverKey}_${hourKey.replace(/[^0-9A-Za-z]/g, '')}`);
        await reportRef.set({ driverKey, hourKey, successCount, failCount, failReasons: reasons, deviceInfo: String(req.body.deviceInfo || '').slice(0, 120), receivedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        return res.json({ success: true, accepted: true, hourKey });
    } catch (error) { return res.status(500).json({ success: false, message: 'Unable to save telemetry summary.' }); }
});

app.post('/api/telemetry/alert', verifyFirebaseToken, async (req, res) => {
    try {
        const platform = String(req.body.platform || '').trim();
        const type = String(req.body.type || req.body.eventType || '').trim().toUpperCase();
        const allowedPlatforms = ['UBER', 'OLA', 'RAPIDO', 'NAMMA YATRI', 'UNKNOWN'];
        const allowedTypes = ['SUCCESS', 'FAILURE', 'ACCEPT_FAILED', 'SUCCESS_TIMEOUT', 'NO_RIDE_DETECTED_5MIN', 'CREDIT_FAILED', 'BOT_FAILURE', 'CUSTOM_ALERT'];
        if (!allowedPlatforms.includes(platform.toUpperCase()) || !allowedTypes.includes(type)) return res.status(400).json({ success: false, message: 'Unsupported telemetry alert.' });
        const phone = getAuthenticatedPhone(req);
        const suppliedEventId = String(req.body.eventId || '').trim().slice(0, 100);
        const eventId = suppliedEventId || crypto.createHash('sha256').update(`${req.firebaseUser.uid}|${platform}|${type}|${Math.floor(Date.now() / 60000)}`).digest('hex');
        const ref = getDB().collection('driverTelemetryEvents').doc(crypto.createHash('sha256').update(`${req.firebaseUser.uid}|${eventId}`).digest('hex'));
        await getDB().runTransaction(async transaction => {
            const existing = await transaction.get(ref);
            if (existing.exists) return;
            transaction.create(ref, { driverKey: hashPhoneForAuth(phone), platform: platform.slice(0, 30), type, eventId, createdAt: admin.firestore.FieldValue.serverTimestamp(), eventDay: new Date().toISOString().slice(0, 10) });
        });
        return res.json({ success: true, accepted: true });
    } catch (error) { return res.status(500).json({ success: false, message: 'Unable to record telemetry alert.' }); }
});

app.post('/api/telemetry/compatibility', verifyFirebaseToken, async (req, res) => {
    try {
        const issueType = String(req.body.issueType || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 40);
        const allowedIssueTypes = ['UNKNOWN_PACKAGE', 'UI_MISMATCH', 'BOT_FAILURE', 'ACCEPT_FAILED', 'SUCCESS_TIMEOUT', 'CONFIG_LOAD_FAILED', 'CUSTOM_ALERT'];
        if (!allowedIssueTypes.includes(issueType)) {
            return res.status(400).json({ success: false, message: 'Unsupported compatibility issue type.' });
        }

        const allowedPlatforms = ['UBER', 'OLA', 'RAPIDO', 'NAMMA YATRI', 'UNKNOWN'];
        const platform = String(req.body.platform || 'UNKNOWN').trim().toUpperCase().slice(0, 40);
        if (!allowedPlatforms.includes(platform)) {
            return res.status(400).json({ success: false, message: 'Unsupported platform.' });
        }

        const packageName = String(req.body.packageName || '').trim().replace(/[^A-Za-z0-9._]/g, '').slice(0, 180) || 'unknown';
        const appVersion = String(req.body.appVersion || '').trim().slice(0, 30) || 'unknown';
        const deviceModel = String(req.body.deviceModel || '').trim().replace(/[\r\n]/g, ' ').slice(0, 100) || 'unknown';
        const androidVersion = String(req.body.androidVersion || '').trim().slice(0, 30) || 'unknown';
        const androidSdk = Number(req.body.androidSdk || 0);
        const configVersion = Number(req.body.configVersion || 0);
        
        // ✅ Increase reason limit to 1000 to accommodate SCREEN TEXT
        const reason = String(req.body.reason || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 1000) || 'No detailed reason supplied.';
        const recommendedAction = String(req.body.recommendedAction || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 500) || 'Review the app compatibility and update remote config or APK as required.';
        const suppliedErrorId = String(req.body.errorId || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
        const errorId = suppliedErrorId || `DRP-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

        let unknownPackageAutoApproval = null;
        if (issueType === 'UNKNOWN_PACKAGE' && platform === 'UNKNOWN' && packageName !== 'unknown') {
            try { unknownPackageAutoApproval = await tryAutoApproveReportedUnknownPackage(packageName); }
            catch (verificationError) {
                unknownPackageAutoApproval = { status: 'verification_failed', reason: String(verificationError.message || verificationError).slice(0, 160) };
                console.error('UNKNOWN PACKAGE AUTO-VERIFICATION ERROR:', verificationError.message || verificationError);
            }
        }

        const now = Date.now();
        const windowBucket = Math.floor(now / (30 * 60 * 1000));
        const deviceKey = crypto.createHash('sha256').update(`${deviceModel}|${appVersion}`).digest('hex').slice(0, 20);
        const dedupeId = crypto.createHash('sha256')
            .update(`${packageName}|${issueType}|${deviceKey}|${windowBucket}`)
            .digest('hex');
        const reportRef = getDB().collection('compatibilityReports').doc(dedupeId);
        
        // ✅ FIX: Instant Telegram alerts disabled to prevent spam. 
        // Reports will be silently saved and included in the 30-minute digest.
        let shouldSendTelegram = false;

        // Database mein save karo (hamesha 30 min ka bucket rahega)
        await getDB().runTransaction(async transaction => {
            const snapshot = await transaction.get(reportRef);
            if (!snapshot.exists) {
                transaction.create(reportRef, {
                    issueId: errorId,
                    issueType,
                    platform,
                    packageName,
                    appVersion,
                    deviceModel,
                    androidVersion,
                    androidSdk: Number.isFinite(androidSdk) ? androidSdk : 0,
                    configVersion: Number.isFinite(configVersion) ? configVersion : 0,
                    reason,
                    recommendedAction,
                    driverKey: hashPhoneForAuth(getAuthenticatedPhone(req)),
                    reportedCount: 1,
                    telegramStatus: shouldSendTelegram ? 'sending' : 'queued_for_digest',
                    telegramLeaseUntilMs: shouldSendTelegram ? now + 90000 : 0,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    lastReportedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                return;
            }

            const data = snapshot.data() || {};
            transaction.update(reportRef, {
                reportedCount: Number(data.reportedCount || 0) + 1,
                lastReportedAt: admin.firestore.FieldValue.serverTimestamp(),
                ...(shouldSendTelegram ? { telegramStatus: 'sending', telegramLeaseUntilMs: now + 90000 } : {})
            });
        });

        // Since shouldSendTelegram is false, this block will never run
        if (shouldSendTelegram) {
            const message = [
                '🚨 DRIVER RIDE PICKER — INSTANT COMPATIBILITY ALERT',
                `Issue ID: ${errorId}`,
                `Issue: ${issueType}`,
                `Platform: ${platform}`,
                `Package: ${packageName}`,
                `APK version: ${appVersion}`,
                `Device: ${deviceModel}`,
                `Android: ${androidVersion} (SDK ${Number.isFinite(androidSdk) ? androidSdk : 0})`,
                `Remote config version: ${Number.isFinite(configVersion) ? configVersion : 0}`,
                `Exact reason: ${reason}`,
                `Required action: ${recommendedAction}`,
                ...(issueType === 'UNKNOWN_PACKAGE' ? [
                    'PACKAGE AUTO-RECOVERY RESULT:',
                    unknownPackageAutoApproval?.status === 'auto_approved' || unknownPackageAutoApproval?.status === 'already_present'
                        ? `Verified on Google Play and ${unknownPackageAutoApproval.status === 'auto_approved' ? 'added automatically' : 'already present'}: ${unknownPackageAutoApproval.platform || ''} / ${packageName} / config v${unknownPackageAutoApproval.configVersion || ''}`
                        : `Not auto-approved: ${unknownPackageAutoApproval?.status || 'manual_review_required'}. No unverified package was added.`,
                    ...(unknownPackageAutoApproval?.status === 'auto_approved' || unknownPackageAutoApproval?.status === 'already_present' ? [] : [
                        'After manual verification, call POST /api/admin/platform/package/add',
                        `JSON body: {\"platform\":\"<Uber|Ola|Rapido|Namma Yatri>\",\"packageName\":\"${packageName}\"}`,
                        'Authorization: Bearer <ADMIN_TOKEN> (keep token private).'
                    ])
                ] : []),
                `Time: ${new Date().toISOString()}`
            ].join('\n');

            try {
                const result = await sendTelegramMessage(message);
                if (!result.sent) throw new Error(result.reason || 'Telegram is not configured.');
                await reportRef.set({
                    telegramStatus: 'sent',
                    telegramSentAt: admin.firestore.FieldValue.serverTimestamp(),
                    telegramLeaseUntilMs: 0
                }, { merge: true });
            } catch (telegramError) {
                await reportRef.set({
                    telegramStatus: 'pending',
                    telegramLeaseUntilMs: 0,
                    telegramLastError: String(telegramError.message || telegramError).slice(0, 200)
                }, { merge: true });
                console.error('COMPATIBILITY TELEGRAM ERROR:', telegramError.message || telegramError);
            }
        }

        return res.json({ success: true, accepted: true, errorId, telegramAttempted: shouldSendTelegram });
    } catch (error) {
        console.error('COMPATIBILITY REPORT ERROR:', error.message || error);
        return res.status(500).json({ success: false, message: 'Unable to record compatibility report.' });
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
    // 🛑 Yahan Blocklist Check ho raha hai. Passenger apps yahin reject ho jayenge.
    if (BLOCKED_DRIVER_PACKAGE_IDS.has(String(candidate?.packageName || '').trim())) {
        return { ...candidate, verified: false, titleMatch: false, publisherMatch: false, reason: 'known_passenger_app_package' };
    }
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
    await redis.set(`play-package-verified:${platformName}:${packageName}`, JSON.stringify({
        ...verification, verifiedAt: new Date().toISOString(), configVersion: version
    }), { ex: 31536000 });
    return { added: true, previousVersion, version };
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

    // Filter out blocked packages so they don't even show up in the approval message
    const filteredEvidence = evidence.filter(item => !BLOCKED_DRIVER_PACKAGE_IDS.has(String(item.packageName || '').trim()));

    let candidatePackage = "unknown";
    for (let item of filteredEvidence) {
        if (item.packageName && item.packageName !== 'unknown') {
            candidatePackage = item.packageName;
            break;
        }
    }

    const candidates = filteredEvidence.slice(0, 12).map(item =>
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

    const approveData = `approve_pkg|${platformName}|${candidatePackage}`;
    const canApprove = candidatePackage !== 'unknown' && Buffer.byteLength(approveData, 'utf8') <= 64;
    const replyMarkup = canApprove ? {
        inline_keyboard: [[
            { text: "✅ Approve & Add", callback_data: approveData },
            { text: "❌ Ignore", callback_data: 'ignore_pkg' }
        ]]
    } : null;

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
                const possible = checks.filter(item => !BLOCKED_DRIVER_PACKAGE_IDS.has(item.packageName) && (item.publisherMatch || (item.titleMatch && titleLooksLikePlatformDriverApp(item.title, setting.brandTokens))));
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

app.get('/api/cron/hourly-summary', async (req, res) => {
    const expected = String(process.env.CRON_SECRET || '');
    const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!expected || !supplied || !safeEqualHex(sha512(expected), sha512(supplied))) return res.status(401).json({ success: false, message: 'Unauthorized cron request.' });
    try {
        const db = getDB();
        const now = new Date(); now.setUTCMinutes(0, 0, 0);
        const processed = [];
        for (let offset = 1; offset <= 3; offset++) {
            const bucket = new Date(now.getTime() - offset * 60 * 60 * 1000);
            const hourKey = bucket.toISOString();
            const reportsSnapshot = await db.collection('driverHourlyTelemetry').where('hourKey', '==', hourKey).get();
            if (reportsSnapshot.empty) continue;
            const runRef = db.collection('hourlySummaryRuns').doc(hourKey.replace(/[^0-9A-Za-z]/g, ''));
            let claimed = false;
            await db.runTransaction(async transaction => {
                const runSnapshot = await transaction.get(runRef);
                const data = runSnapshot.exists ? (runSnapshot.data() || {}) : {};
                if (data.status === 'sent' || Number(data.leaseUntilMs || 0) > Date.now()) return;
                transaction.set(runRef, { status: 'sending', hourKey, leaseUntilMs: Date.now() + 120000, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
                claimed = true;
            });
            if (!claimed) continue;
            let success = 0, failed = 0;
            reportsSnapshot.forEach(doc => { const data = doc.data() || {}; success += Math.max(0, Number(data.successCount || 0)); failed += Math.max(0, Number(data.failCount || 0)); });
            const totalRides = success + failed;
            const successPct = totalRides ? (success * 100 / totalRides) : 0;
            const failPct = totalRides ? (failed * 100 / totalRides) : 0;
            const totalUsers = await db.collection('users').count().get();
            const activeCutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 5 * 60 * 1000);
            const activeUsers = await db.collection(TRACKER_COLLECTION).where('lastSeenAt', '>=', activeCutoff).count().get();
            const message = [
                '📊 Driver Ride Picker — Hourly Report',
                `Window (UTC): ${hourKey} - ${new Date(bucket.getTime() + 3600000).toISOString()}`,
                `Total registered drivers: ${Number(totalUsers.data().count || 0)}`,
                `Active drivers now (last 5 min): ${Number(activeUsers.data().count || 0)}`,
                `Drivers reporting this hour: ${reportsSnapshot.size}`,
                `Total ride outcomes: ${totalRides}`,
                `Successful: ${success} (${successPct.toFixed(1)}%)`,
                `Failed: ${failed} (${failPct.toFixed(1)}%)`,
                'Cancelled: Not reported separately by current APK'
            ].join('\n');
            try {
                const telegramResult = await sendTelegramMessage(message);
                if (!telegramResult.sent) throw new Error(telegramResult.reason || 'Telegram is not configured.');
                await runRef.set({ status: 'sent', sentAt: admin.firestore.FieldValue.serverTimestamp(), leaseUntilMs: 0, successCount: success, failCount: failed }, { merge: true });
                processed.push({ hourKey, sent: true, totalRides });
            } catch (telegramError) {
                await runRef.set({ status: 'pending', leaseUntilMs: 0, lastError: String(telegramError.message || telegramError).slice(0, 200) }, { merge: true });
                processed.push({ hourKey, sent: false, error: String(telegramError.message || telegramError).slice(0, 120) });
            }
        }
        return res.json({ success: true, processed });
    } catch (error) { console.error('HOURLY SUMMARY CRON ERROR:', error); return res.status(500).json({ success: false, message: 'Unable to generate hourly summary.' }); }
});


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
        const onlineSnap = await db.collection(TRACKER_COLLECTION).where('lastSeenAt', '>=', cutoff).count().get();
        const online = Math.min(totalDrivers, Math.max(0, Number(onlineSnap.data().count || 0)));
        const offline = Math.max(0, totalDrivers - online);

        const startTs = admin.firestore.Timestamp.fromMillis(bucketStartMs);
        const endTs = admin.firestore.Timestamp.fromMillis(bucketStartMs + 1800000);
        const issues = await db.collection('compatibilityReports').where('createdAt', '>=', startTs).where('createdAt', '<', endTs).get();
        const issueCounts = {};
        const uiMismatchDetails = [];
        
        issues.forEach(doc => {
            const d = doc.data() || {};
            const k = String(d.issueType || 'OTHER');
            issueCounts[k] = (issueCounts[k] || 0) + Math.max(1, Number(d.reportedCount || 1));
            
            if (k === 'UI_MISMATCH' && d.reason) {
                // Extract just the SCREEN TEXT part if available
                let reasonText = d.reason;
                const screenTextIdx = reasonText.indexOf('SCREEN TEXT:');
                if (screenTextIdx !== -1) {
                    reasonText = reasonText.substring(screenTextIdx, screenTextIdx + 150);
                } else {
                    reasonText = reasonText.substring(0, 150);
                }
                uiMismatchDetails.push(`- ${d.platform}: ${reasonText}...`);
            }
        });
        
        const issueText = Object.entries(issueCounts).map(([k,v]) => `${k}: ${v}`).join(', ') || 'None';
        const issueDetailsText = uiMismatchDetails.length > 0 ? `\n\n🔍 UI Mismatch Details (Fix via Backend Config):\n${uiMismatchDetails.slice(0, 3).join('\n')}` : '';

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
            `🔧 Compatibility issues: ${issueText}${issueDetailsText}`,
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

app.post('/api/admin/telegram/test', async (req, res) => {
    if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    try { const result = await sendTelegramMessage('✅ Driver Ride Picker Telegram connection test.'); return res.json({ success: true, ...result }); }
    catch (error) { return res.status(502).json({ success: false, message: error.message || 'Telegram test failed.' }); }
});

app.post('/api/payment/create-order', verifyFirebaseToken, async (req, res) => {
    try {
        const phone = getAuthenticatedPhone(req);
        const amountRupees = Number(req.body.amountRupees);
        if (!phone) return res.status(401).json({ success: false, message: 'Authenticated driver required.' });
        const planConfig = PLAN_CONFIG_BY_AMOUNT[amountRupees];
        if (!planConfig) return res.status(400).json({ success: false, message: 'Invalid plan amount.' });

        const planType = planConfig.type; const planDurationMs = planConfig.durationMs;
        const receipt = generateReceipt(); const razorpay = getRazorpay();

        const order = await razorpay.orders.create({
            amount: amountRupees * 100, currency: 'INR', receipt,
            partial_payment: false, notes: { app: 'Driver Ride Picker', phone, planType, planDurationMs: String(planDurationMs) }
        });

        await getDB().collection('paymentOrders').doc(order.id).set({
            orderId: order.id, phone, amountRupees, amountPaise: amountRupees * 100,
            planType, planDurationMs, currency: 'INR', status: 'created',
            receipt, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json({ success: true, keyId: process.env.RAZORPAY_KEY_ID, orderId: order.id, amount: order.amount, currency: order.currency, planType, planDurationMs });
    } catch (error) { return res.status(500).json({ success: false, message: error.message || 'Unable to create Razorpay order.' }); }
});

app.post('/api/payment/verify', verifyFirebaseToken, async (req, res) => {
    try {
        const phone = getAuthenticatedPhone(req);
        const orderId = String(req.body.orderId || '').trim(); const paymentId = String(req.body.paymentId || '').trim(); const signature = String(req.body.signature || '').trim();
        if (!phone || !orderId || !paymentId || !signature) return res.status(400).json({ success: false, message: 'Payment data incomplete.' });

        const db = getDB(); const orderRef = db.collection('paymentOrders').doc(orderId); const orderSnapshot = await orderRef.get();
        if (!orderSnapshot.exists) return res.status(404).json({ success: false, message: 'Payment order not found.' });
        const orderData = orderSnapshot.data() || {};
        if (normalizePhone(orderData.phone) !== phone) return res.status(403).json({ success: false, message: 'Payment order mismatch.' });
        if (!verifyRazorpaySignature(orderId, paymentId, signature)) return res.status(400).json({ success: false, message: 'Invalid signature.' });
        if (orderData.status === 'paid') return res.json({ success: true, alreadyProcessed: true, planType: orderData.planType || PLAN_TYPE_NONE, message: 'Payment already processed.' });

        const razorpay = getRazorpay(); const payment = await razorpay.payments.fetch(paymentId);
        if (String(payment.order_id || '') !== orderId || String(payment.status || '').toLowerCase() !== 'captured') {
            return res.status(400).json({ success: false, message: `Payment not captured. Status: ${payment.status}` });
        }
        if (Number(payment.amount || 0) !== Number(orderData.amountPaise || 0)) return res.status(400).json({ success: false, message: 'Payment amount mismatch.' });

        const planType = String(orderData.planType || '').toUpperCase(); const planDurationMs = Number(orderData.planDurationMs || 0);
        if (!VALID_PLAN_TYPES.includes(planType) || planDurationMs <= 0) return res.status(400).json({ success: false, message: 'Invalid plan data.' });

        const userRef = db.collection('users').doc(phone); let newPlanExpiry = 0;

        await db.runTransaction(async transaction => {
            const freshOrder = await transaction.get(orderRef); const freshUser = await transaction.get(userRef);
            if (!freshUser.exists) throw new Error('Driver account not found.');
            if (freshOrder.data()?.status === 'paid') { newPlanExpiry = Number(freshUser.data()?.planExpiry || 0); return; }

            const now = Date.now(); const currentExpiry = Number(freshUser.data()?.planExpiry || 0);
            newPlanExpiry = (currentExpiry > now ? currentExpiry : now) + planDurationMs;

            transaction.update(userRef, { activePlan: planType, planExpiry: newPlanExpiry, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            transaction.update(orderRef, { status: 'paid', paymentId, signature, activatedPlan: planType, planExpiry: newPlanExpiry, paidAt: admin.firestore.FieldValue.serverTimestamp() });
        });

        return res.json({ success: true, alreadyProcessed: false, planType, planExpiry: newPlanExpiry, planExpiryIso: new Date(newPlanExpiry).toISOString(), message: `${planType} plan activated successfully.` });
    } catch (error) { return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Unable to verify payment.' }); }
});

// ============================================================
// TELEGRAM WEBHOOK FOR INLINE BUTTONS
// ============================================================
app.post('/api/telegram/webhook', async (req, res) => {
    try {
        const webhookSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '');
        const suppliedSecret = String(req.headers['x-telegram-bot-api-secret-token'] || '');
        if (!webhookSecret || !safeEqualHex(sha512(webhookSecret), sha512(suppliedSecret))) {
            return res.status(403).json({ ok: false });
        }

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

                if (!PLAY_STORE_PLATFORMS.includes(platformName) || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(packageName) || BLOCKED_DRIVER_PACKAGE_IDS.has(packageName)) {
                    return res.status(200).send('OK');
                }

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
// EXPORT APP
// ============================================================
module.exports = app;
