/*
 * Driver Ride Picker backend. (FINAL - NO FORCED UPDATE, ALL VERSIONS ALLOWED)
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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Firebase-AppCheck', 'X-Tracker-Admin-Key']
}));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '1mb' }));

// ============================================================
// SPEED CACHES
// ============================================================
let rideConfigCache = { at: 0, body: null };
const RIDE_CONFIG_CACHE_MS = 5 * 60 * 1000; // 5 min per warm server instance
function clearRideConfigCache() { rideConfigCache = { at: 0, body: null }; }

const userByUidCache = new Map();
const USER_CACHE_MS = 60000;

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

// ✅ NO FORCED UPDATE: koi bhi app version chalega, update kabhi nahi maangega.
// Ye values sirf info ke liye hain. /api/app/update hamesha "update nahi chahiye" bhejta hai.
const APP_LATEST_VERSION = '1.19.8';
const APP_APK_URL = 'https://github.com/kingocta472-cpu/driver-backend/releases/download/v1.19.8/app-release.apk';
const APP_UPDATE_TITLE = 'Driver Ride Picker';
const APP_UPDATE_MESSAGE = 'Aap latest version use kar rahe hain.';
const APP_RELEASE_NOTES = 'All app versions are supported.';

const INSTALL_ID_MAX_LENGTH = 200;
const REFERRAL_CODE_LENGTH = 8;
const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const TRIAL_IP_LIMIT = 3;
const TRIAL_IP_WINDOW_SECONDS = 86400;

const FAKE_PHONE_PATTERNS = [ /^(\d)\1{9}$/, /^9999\d{6}$/, /^1234\d{6}$/, /^(\d{2})\1{4}$/, /^9876\d{6}$/, /^0000\d{6}$/ ];
function isFakePhone(phone) { return FAKE_PHONE_PATTERNS.some(p => p.test(phone)); }

const CONFIG_VERSION_FROM_ENV = Number(process.env.RIDE_BOT_CONFIG_VERSION || 3);
const RIDE_BOT_CONFIG_VERSION_FALLBACK =
    Number.isSafeInteger(CONFIG_VERSION_FROM_ENV) && CONFIG_VERSION_FROM_ENV > 0
        ? CONFIG_VERSION_FROM_ENV
        : 3;
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

// ============================================================
// CONFIG MERGE
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
    merged.controls = { ...(base.controls || {}), ...(override.controls || {}) };
    merged.strategies = mergeStrategies(base.strategies, override.strategies);
    return merged;
}

// ============================================================
// VALIDATOR
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
            if (!['Uber', 'Ola', 'Rapido', 'Namma Yatri', 'CityRide', 'Odisha Yatri'].includes(name)) throw new Error(`Unknown platform: ${name}`);
            if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`platforms.${name} must be an object.`);
            const p = {};
            for (const [key, value] of Object.entries(cfg)) {
                if (key === 'enabled') {
                    if (typeof value !== 'boolean') throw new Error(`${name}.enabled must be a boolean.`);
                    p.enabled = value;
                }
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
                if (['attempts', 'attemptsSlow', 'attempts_slow'].includes(key)) s[key] = Math.round(num(value, 1, 30, `${name}.${key}`));
                else if (['tapIntervalMs', 'tap_interval_ms', 'verifyDelayMs', 'verify_delay_ms', 'verifyDelaySlowMs', 'verify_delay_slow_ms'].includes(key)) s[key] = Math.round(num(value, 1, 1000, `${name}.${key}`));
                else if (key === 'tapMode') {
                    const mode = String(value).toUpperCase();
                    if (!['CENTER', 'GHOST'].includes(mode)) throw new Error('tapMode must be CENTER or GHOST.');
                    s.tapMode = mode;
                } else throw new Error(`Unsupported strategy setting: ${name}.${key}`);
            }
            out.strategies[name] = s;
        }
    }

    if (input.controls !== undefined) {
        if (typeof input.controls !== 'object' || Array.isArray(input.controls) || !input.controls) {
            throw new Error('controls must be an object.');
        }
        out.controls = {};
        for (const [key, value] of Object.entries(input.controls)) {
            if (!KEY_RE.test(key)) throw new Error(`Invalid controls key: ${key}`);
            if (typeof value !== 'boolean') throw new Error(`controls.${key} must be a boolean.`);
            out.controls[key] = value;
        }
    }

    return out;
}

const RIDE_BOT_CONFIG_DATA_KEY = 'ride-bot-config-data';
const BLOCKED_DRIVER_PACKAGE_IDS = new Set([
    'in.juspay.nammayatri',
    'com.ubercab', 'com.ubercab.eats', 'com.postmates.android', 'com.uber.restaurants', 'com.uber.restaurantmanager',
    'com.olacabs.customer', 'com.olacabs.olamoney',
    'com.rapido.rider',
    'in.mobility.keralasavaariconsumer', 'com.mobility.movingtech', 'net.openkochi.yatri'
]);

// Known driver packages must never be auto-assigned to a different platform.
const KNOWN_DRIVER_PACKAGE_PLATFORM = Object.freeze({
    'in.mobility.odishayatripartner': 'Odisha Yatri'
});

const DEFAULT_RIDE_BOT_CONFIG = {
    platforms: {
        Uber: {
            enabled: true,
            package_names: ["com.ubercab.driver"],
            accept_keywords: ["Match", "Accept", "Accept Ride", "Accept Trip", "Confirm"],
            success_signals: [
                "start ride", "start trip", "begin trip", "trip started", "ride started",
                "trip in progress", "on trip", "go to pickup", "going to pickup",
                "navigate to pickup", "arrived at pickup", "reached pickup",
                "waiting for rider", "waiting for customer", "waiting for passenger",
                "enter otp", "verify otp", "otp verification", "share otp", "confirm otp", "otp submit",
                "call rider", "call customer", "call passenger",
                "chat with rider", "message rider", "chat with customer",
                "you have accepted", "ride accepted", "trip accepted",
                "accepted the ride", "booking accepted", "order accepted"
            ],
            view_id_patterns: ["accept", "match", "confirm"]
        },
        Ola: {
            enabled: true,
            package_names: ["com.olacabs.driver", "com.olacabs.oladriver"],
            accept_keywords: ["Match", "Accept", "Accept Ride", "Accept Trip", "Confirm"],
            success_signals: [
                "start ride", "start trip", "begin trip", "trip started", "ride started",
                "trip in progress", "on trip", "go to pickup", "going to pickup",
                "navigate to pickup", "arrived at pickup", "reached pickup",
                "waiting for rider", "waiting for customer", "waiting for passenger",
                "enter otp", "verify otp", "otp verification", "share otp", "confirm otp", "otp submit",
                "call rider", "call customer", "call passenger",
                "chat with rider", "message rider", "chat with customer",
                "you have accepted", "ride accepted", "trip accepted",
                "accepted the ride", "booking accepted", "order accepted"
            ],
            view_id_patterns: ["accept", "confirm"]
        },
        Rapido: {
            enabled: true,
            package_names: ["com.rapido.driver"],
            accept_keywords: ["Accept Order", "Accept", "Accept Ride", "Accept Trip", "Confirm", "Match"],
            success_signals: [
                "start ride", "start trip", "begin trip", "trip started", "ride started",
                "trip in progress", "on trip", "go to pickup", "going to pickup",
                "navigate to pickup", "arrived at pickup", "reached pickup",
                "waiting for rider", "waiting for customer", "waiting for passenger",
                "enter otp", "verify otp", "otp verification", "share otp", "confirm otp", "otp submit",
                "call rider", "call customer", "call passenger",
                "chat with rider", "message rider", "chat with customer",
                "you have accepted", "ride accepted", "trip accepted",
                "accepted the ride", "booking accepted", "order accepted"
            ],
            view_id_patterns: ["accept", "order"]
        },
        "Namma Yatri": {
            enabled: true,
            package_names: ["net.openkochi.yatripartner", "in.juspay.nammayatripartner", "in.mobility.manayatripartner", "com.nammayatri", "com.mobility.movingtechdriver"],
            accept_keywords: ["Confirm", "Accept", "Accept Ride", "Accept Trip", "Match"],
            success_signals: [
                "start ride", "start trip", "begin trip", "trip started", "ride started",
                "trip in progress", "on trip", "go to pickup", "going to pickup",
                "navigate to pickup", "arrived at pickup", "reached pickup",
                "waiting for rider", "waiting for customer", "waiting for passenger",
                "enter otp", "verify otp", "otp verification", "share otp", "confirm otp", "otp submit",
                "call rider", "call customer", "call passenger",
                "chat with rider", "message rider", "chat with customer",
                "you have accepted", "ride accepted", "trip accepted",
                "accepted the ride", "booking accepted", "order accepted"
            ],
            view_id_patterns: ["accept", "confirm"]
        },
        CityRide: {
            enabled: true,
            package_names: ["in.cityride.driver"],
            accept_keywords: ["Accept Ride", "Accept", "Accept Trip", "Confirm"],
            success_signals: [
                "start ride", "start trip", "begin trip", "trip started", "ride started",
                "trip in progress", "on trip", "go to pickup", "going to pickup",
                "navigate to pickup", "arrived at pickup", "reached pickup",
                "waiting for rider", "waiting for customer", "waiting for passenger",
                "enter otp", "verify otp", "otp verification", "share otp", "confirm otp", "otp submit",
                "call rider", "call customer", "call passenger",
                "chat with rider", "message rider", "chat with customer",
                "you have accepted", "ride accepted", "trip accepted",
                "accepted the ride", "booking accepted", "order accepted"
            ],
            view_id_patterns: ["accept", "confirm"]
        },
        "Odisha Yatri": {
            enabled: true,
            package_names: ["in.mobility.odishayatripartner"],
            accept_keywords: ["Accept", "Accept Ride", "Accept Trip", "Accept Request", "Accept Booking", "Confirm"],
            success_signals: [
                "start ride", "start trip", "begin trip", "trip started", "ride started",
                "trip in progress", "on trip", "go to pickup", "going to pickup",
                "navigate to pickup", "arrived at pickup", "reached pickup",
                "waiting for rider", "waiting for customer", "waiting for passenger",
                "enter otp", "verify otp", "otp verification", "share otp", "confirm otp", "otp submit",
                "call rider", "call customer", "call passenger",
                "chat with rider", "message rider", "chat with customer",
                "you have accepted", "ride accepted", "trip accepted",
                "accepted the ride", "booking accepted", "order accepted"
            ],
            view_id_patterns: ["accept", "confirm", "request", "booking"]
        }
    },
    global: {
        bot_enabled: true,
        auto_accept_enabled: true,
        // Keep the accept cycle alive for slower/older devices.
        // These values match the Android service's safe fallback timings.
        max_ride_cycle_duration_ms: 8000,
        maxRideCycleDurationMs: 8000,
        watchdog_interval_ms: 2000,
        watchdogIntervalMs: 2000,
        config_refresh_interval_ms: 300000,
        configRefreshIntervalMs: 300000,
        health_check_interval_ms: 300000,
        healthCheckIntervalMs: 300000,
        node_null_delay_ms: 20,
        nodeNullDelayMs: 20,
        debounce_normal_ms: 5,
        debounceNormalMs: 5,
        debounce_slow_ms: 20,
        debounceSlowMs: 20,
        location_min_time_ms: 5000,
        locationMinTimeMs: 5000,
        location_min_distance_m: 50,
        locationMinDistanceM: 50,
        plan_offline_grace_ms: 1800000,
        planOfflineGraceMs: 1800000
    },
    controls: {
        bot_enabled: true,
        auto_accept_enabled: true
    },
    strategies: {
        normal: { attempts: 10, tapIntervalMs: 5, tap_interval_ms: 5, verifyDelayMs: 30, verify_delay_ms: 30, tapMode: 'CENTER' },
        medium: { attempts: 15, tapIntervalMs: 5, tap_interval_ms: 5, verifyDelayMs: 25, verify_delay_ms: 25, tapMode: 'GHOST' },
        high_speed: { attempts: 15, attemptsSlow: 15, attempts_slow: 15, tapIntervalMs: 5, tap_interval_ms: 5, verifyDelayMs: 20, verify_delay_ms: 20, verifyDelaySlowMs: 40, verify_delay_slow_ms: 40, tapMode: 'GHOST' }
    },
    filters: {
        enabled: true,
        keyword_mode: "ANY",
        minimum_fare: 0,
        minimumFare: 0,
        maximum_fare: 0,
        maximumFare: 0,
        maximum_pickup_distance_km: 0,
        maximumPickupDistanceKm: 0,
        maximum_drop_distance_km: 0,
        maximumDropDistanceKm: 0,
        maximum_trip_distance_km: 0,
        maximumTripDistanceKm: 0,
        minimum_trip_distance_km: 0,
        minimumTripDistanceKm: 0,
        work_zone_radius_km: 5,
        workZoneRadiusKm: 5,
        allowed_vehicles: ["AUTO", "CAR", "BIKE"],
        allowedVehicles: ["AUTO", "CAR", "BIKE"],
        target_areas: [],
        targetAreas: [],
        blocked_areas: [],
        blockedAreas: [],
        required_keywords: [],
        requiredKeywords: [],
        blocked_keywords: [
            "close drawer", "earnings", "trips", "preferences", "plans", "benefits", 
            "aarokya", "store", "help", "open data", "about", "google maps", 
            "bottom sheet backdrop", "bottom sheet", "permissions required", 
            "draw over other apps", "receive ride requests when the app is",
            "1 order", "go to home", "orders missed", "you missed the order", 
            "sorry, this order was accepted by another captain", 
            "confirm your detected location", "confirm google map", "go to location"
        ],
        blockedKeywords: [
            "close drawer", "earnings", "trips", "preferences", "plans", "benefits", 
            "aarokya", "store", "help", "open data", "about", "google maps", 
            "bottom sheet backdrop", "bottom sheet", "permissions required", 
            "draw over other apps", "receive ride requests when the app is",
            "1 order", "go to home", "orders missed", "you missed the order", 
            "sorry, this order was accepted by another captain", 
            "confirm your detected location", "confirm google map", "go to location"
        ]
    }
};

// Normalize only safety-critical runtime timings. This does not touch
// account, plan, trial, referral, payment, or driver-specific filter data.
function normalizeRideBotConfig(config) {
    const normalized = JSON.parse(JSON.stringify(config || DEFAULT_RIDE_BOT_CONFIG));
    if (!normalized.global || typeof normalized.global !== 'object' || Array.isArray(normalized.global)) {
        normalized.global = {};
    }
    const globalConfig = normalized.global;

    const configuredCycle = Number(
        globalConfig.max_ride_cycle_duration_ms ??
        globalConfig.maxRideCycleDurationMs ??
        8000
    );
    const safeCycle = Number.isFinite(configuredCycle)
        ? Math.min(30000, Math.max(8000, configuredCycle))
        : 8000;

    const configuredWatchdog = Number(
        globalConfig.watchdog_interval_ms ??
        globalConfig.watchdogIntervalMs ??
        2000
    );
    const safeWatchdog = Number.isFinite(configuredWatchdog)
        ? Math.min(15000, Math.max(500, configuredWatchdog))
        : 2000;

    globalConfig.max_ride_cycle_duration_ms = safeCycle;
    globalConfig.maxRideCycleDurationMs = safeCycle;
    globalConfig.watchdog_interval_ms = safeWatchdog;
    globalConfig.watchdogIntervalMs = safeWatchdog;

    return normalized;
}

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

        let cachedUser = userByUidCache.get(decoded.uid);
        if (!cachedUser || Date.now() - cachedUser.at > USER_CACHE_MS) {
            const db = getDB();
            const snapshot = await db.collection('users').where('firebaseUid', '==', decoded.uid).limit(1).get();
            if (snapshot.empty) return res.status(401).json({ success: false, message: 'Driver account authentication required.' });
            const doc = snapshot.docs[0];
            cachedUser = { at: Date.now(), id: doc.id, data: doc.data() || {} };
            userByUidCache.set(decoded.uid, cachedUser);
            if (userByUidCache.size > 5000) userByUidCache.clear();
        }
        const userDoc = { id: cachedUser.id };
        const userData = cachedUser.data;
        req.firebaseUser = { uid: decoded.uid, phone: normalizePhone(userData.phone || userDoc.id), decodedToken: decoded, userData };
        req.driverUser = userData;

        // Driver activity writes disabled to reduce Firestore write load.
        // Authentication and all protected business routes remain unchanged.
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

// ✅ NO UPDATE REQUIRED FOR ANY VERSION
// Backend hamesha bolta hai: "update available = false, force update = false".
// latestVersion = jo version app ne bheja wahi wapas bheja jata hai, taaki app
// khud compare kare to bhi "latest" hi nikle. Minimum version 0.0.0 hai.
app.get('/api/app/update', (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache'); res.set('Expires', '0');
        const currentVersion = String(req.query.currentVersion || req.query.version || req.query.appVersion || '').trim();
        const effectiveVersion = currentVersion || APP_LATEST_VERSION;
        return res.json({
            success: true,
            latestVersion: effectiveVersion,
            minimumVersion: '0.0.0',
            forceUpdate: false,
            updateAvailable: false,
            updateRequired: false,
            mandatory: false,
            updateMessage: APP_UPDATE_MESSAGE,
            message: APP_UPDATE_MESSAGE,
            title: APP_UPDATE_TITLE,
            releaseNotes: APP_RELEASE_NOTES,
            downloadUrl: APP_APK_URL,
            apkUrl: APP_APK_URL,
            currentVersion: currentVersion || null
        });
    } catch (error) { return res.status(500).json({ success: false, message: 'Unable to check app update status.' }); }
});

app.get('/api/config/ride-bot', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
        if (rideConfigCache.body && Date.now() - rideConfigCache.at < RIDE_CONFIG_CACHE_MS) {
            return res.status(200).json(rideConfigCache.body);
        }
        const [version, stored] = await Promise.all([
            getRideBotConfigVersion(),
            redis.get(RIDE_BOT_CONFIG_DATA_KEY).catch(() => null)
        ]);
        let config = DEFAULT_RIDE_BOT_CONFIG;
        if (stored) {
            try {
                const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
                config = mergeConfigObjects(config, parsed);
            } catch (configError) { console.error('REMOTE RIDE CONFIG READ ERROR:', configError.message || configError); }
        }
        config = normalizeRideBotConfig(config);
        const body = { version, updatedAt: new Date().toISOString(), ...config };
        rideConfigCache = { at: Date.now(), body };
        return res.status(200).json(body);
    } catch (error) { return res.status(500).json({ success: false, message: 'Unable to load ride bot config.' }); }
});

app.post('/api/admin/config/ride-bot', async (req, res) => {
    if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    try {
        const clean = validateRemoteRideConfig(req.body?.config || req.body);
        const previousStored = await redis.get(RIDE_BOT_CONFIG_DATA_KEY);
        const previous = previousStored ? (typeof previousStored === 'string' ? JSON.parse(previousStored) : previousStored) : {};
        const merged = normalizeRideBotConfig(
            mergeConfigObjects(mergeConfigObjects(DEFAULT_RIDE_BOT_CONFIG, previous), clean)
        );
        await redis.set(RIDE_BOT_CONFIG_DATA_KEY, JSON.stringify(merged));
        const previousVersion = await getRideBotConfigVersion();
        const newVersion = previousVersion + 1;
        await redis.set(RIDE_BOT_CONFIG_VERSION_KEY, String(newVersion));
        clearRideConfigCache();
        return res.json({ success: true, previousVersion, newVersion, config: merged });
    } catch (error) { return res.status(400).json({ success: false, message: error.message || 'Unable to save remote config.' }); }
});

app.post('/api/admin/config/reset', async (req, res) => {
    if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    try {
        await redis.del(RIDE_BOT_CONFIG_DATA_KEY);
        const newVersion = (await getRideBotConfigVersion()) + 1;
        await redis.set(RIDE_BOT_CONFIG_VERSION_KEY, String(newVersion));
        clearRideConfigCache();
        return res.json({ success: true, newVersion, message: 'Stored config cleared. Code defaults are now active.' });
    } catch (e) { return res.status(500).json({ success: false, message: 'Reset failed.' }); }
});

app.post('/api/admin/platform/package/add', async (req, res) => {
    if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    try {
        const platformName = String(req.body?.platform || '').trim();
        const packageName = String(req.body?.packageName || '').trim();
        const allowedPlatforms = ['Uber', 'Ola', 'Rapido', 'Namma Yatri', 'CityRide', 'Odisha Yatri'];
        const packagePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
        if (!allowedPlatforms.includes(platformName)) return res.status(400).json({ success: false, message: 'Invalid platform. Use Uber, Ola, Rapido, Namma Yatri, CityRide, or Odisha Yatri.' });
        if (!packagePattern.test(packageName) || packageName.length > 180) return res.status(400).json({ success: false, message: 'Invalid Android package name.' });
        if (BLOCKED_DRIVER_PACKAGE_IDS.has(packageName)) return res.status(400).json({ success: false, message: 'Passenger application package cannot be approved as a driver app.' });
        const knownOwner = KNOWN_DRIVER_PACKAGE_PLATFORM[packageName];
        if (knownOwner && knownOwner !== platformName) {
            return res.status(400).json({ success: false, message: `This package is assigned to ${knownOwner}.` });
        }

        const stored = await redis.get(RIDE_BOT_CONFIG_DATA_KEY);
        const previous = stored ? (typeof stored === 'string' ? JSON.parse(stored) : stored) : {};
        const merged = mergeConfigObjects(DEFAULT_RIDE_BOT_CONFIG, previous);
        const platformConfig = { ...(merged.platforms?.[platformName] || {}) };
        const current = Array.isArray(platformConfig.package_names) ? platformConfig.package_names : [];
        const alreadyPresent = current.includes(packageName);
        platformConfig.package_names = [...new Set([...current, packageName])];
        merged.platforms = { ...merged.platforms, [platformName]: platformConfig };
        const safeMerged = normalizeRideBotConfig(merged);

        if (!alreadyPresent) {
            await redis.set(RIDE_BOT_CONFIG_DATA_KEY, JSON.stringify(safeMerged));
            const previousVersion = await getRideBotConfigVersion();
            const newVersion = previousVersion + 1;
            await redis.set(RIDE_BOT_CONFIG_VERSION_KEY, String(newVersion));
            clearRideConfigCache();
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
        clearRideConfigCache();
        return res.json({ success: true, previousVersion: current, newVersion: next, message: `Config version bumped to ${next}.` });
    } catch (error) { return res.status(500).json({ success: false, message: 'Unable to bump config version.' }); }
});

app.post('/api/admin/config/set', async (req, res) => {
    if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    try {
        const requested = Number(req.body.version);
        if (!Number.isFinite(requested) || requested <= 0 || !Number.isInteger(requested)) return res.status(400).json({ success: false, message: 'version must be a positive integer.' });
        await redis.set(RIDE_BOT_CONFIG_VERSION_KEY, String(requested));
        clearRideConfigCache();
        return res.json({ success: true, newVersion: requested });
    } catch (error) { return res.status(500).json({ success: false, message: 'Unable to set config version.' }); }
});

app.post('/api/health/report', (req, res) => {
    // Optional diagnostics disabled to reduce Redis writes.
    // Keep a fast 200 response for installed APK compatibility.
    return res.status(200).json({ success: true, accepted: false, disabled: true });
});

app.get('/api/admin/dashboard', (req, res) => {
    if (!verifyAdminToken(req)) return res.status(401).json({ error: 'Unauthorized' });
    return res.status(200).json({ success: true, disabled: true, message: 'Telemetry dashboard is disabled.' });
});

app.get('/api/admin/tracker', (req, res) => {
    return res.status(200).json({ success: true, disabled: true, message: 'Driver activity tracking is disabled.' });
});
app.get('/api/test', (req, res) => { res.json({ success: true, message: 'Android app successfully connected to Firebase backend!', timestamp: new Date().toISOString() }); });

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


        userByUidCache.delete(driverFirebaseUid);

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

        // Referral count is not required for plan validation. Avoid an extra
        // Firestore aggregate query on every balance/plan check.
        const referralCount = Number(data.referralCount || 0);
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
        let userData = req.driverUser || {};
        if (Number(userData.planExpiry || 0) <= Date.now()) {
            const fresh = await getDB().collection('users').doc(phone).get();
            if (!fresh.exists) return res.status(404).json({ success: false, message: 'Driver account not found.' });
            userData = fresh.data() || {};
            userByUidCache.delete(req.firebaseUser.uid);
            if (Number(userData.planExpiry || 0) <= Date.now()) {
                return res.status(402).json({ success: false, message: 'Plan expired. Please recharge to continue.' });
            }
        }
        // Time-based plan validation only. No per-ride Firestore counter write.
        const activePlanType = getActivePlanType(userData);
        return res.json({ success: true, alreadyProcessed: false, ridesDeducted: 0, unlimited: true, planType: activePlanType, message: `Unlimited ${activePlanType} plan active. No deduction.` });
    } catch (error) { return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Unable to process ride.' }); }
});

app.post('/api/ride/refund-credit', verifyFirebaseToken, async (req, res) => {
    return res.json({ success: true, refunded: false, alreadyRefunded: false, message: 'Refund not applicable in time-based system.' });
});

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
        userByUidCache.clear();
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
        userByUidCache.delete(req.firebaseUser.uid);
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

app.post('/api/telemetry/summary', (req, res) => {
    return res.status(200).json({ success: true, accepted: false, disabled: true });
});

app.post('/api/telemetry/alert', (req, res) => {
    return res.status(200).json({ success: true, accepted: false, disabled: true });
});

app.post('/api/telemetry/compatibility', (req, res) => {
    return res.status(200).json({ success: true, accepted: false, disabled: true });
});

app.get('/api/cron/play-store-package-discovery', (req, res) => {
    return res.status(200).json({ success: true, disabled: true, message: 'Automatic Play Store discovery is disabled.' });
});
app.post('/api/admin/play-store-package-discovery/run', (req, res) => {
    if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    return res.status(200).json({ success: true, disabled: true, message: 'Automatic Play Store discovery is disabled.' });
});

app.get('/api/cron/hourly-summary', (req, res) => {
    return res.status(200).json({ success: true, disabled: true, message: 'Automated reports are disabled.' });
});


app.get('/api/cron/half-hour-summary', (req, res) => {
    return res.status(200).json({ success: true, disabled: true, message: 'Automated reports are disabled.' });
});

app.post('/api/admin/telegram/test', (req, res) => {
    if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    return res.status(200).json({ success: true, sent: false, disabled: true });
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
        userByUidCache.delete(req.firebaseUser.uid);

        return res.json({ success: true, alreadyProcessed: false, planType, planExpiry: newPlanExpiry, planExpiryIso: new Date(newPlanExpiry).toISOString(), message: `${planType} plan activated successfully.` });
    } catch (error) { return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Unable to verify payment.' }); }
});

app.post('/api/telegram/webhook', (req, res) => {
    // Telegram automation disabled. Acknowledge webhook delivery without work.
    return res.status(200).send('OK');
});

module.exports = app;
