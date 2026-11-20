/*
 * Driver Ride Picker backend. (ULTRA FAST PAYMENT + 100% ACTIVATION)
 */

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { promisify } = require('util');
const { Redis } = require('@upstash/redis');

const scryptAsync = promisify(crypto.scrypt);

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
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

// ============================================================
// SPEED CACHES
// ============================================================
let rideConfigCache = { at: 0, body: null };
const RIDE_CONFIG_CACHE_MS = 60 * 60 * 1000; 
function clearRideConfigCache() { rideConfigCache = { at: 0, body: null }; }

const userByUidCache = new Map();
// Short per-phone cache for GET /api/user/balance (saves a Firestore read per call).
const balanceCache = new Map();
const BALANCE_CACHE_MS = 30000;
function invalidateBalanceCache(phone) { if (phone) balanceCache.delete(phone); else balanceCache.clear(); }
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
let razorpayClientCache = { keyId: '', keySecret: '', client: null };

function withTimeout(promise, timeoutMs, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function isAlreadyExistsError(error) {
    return error && (error.code === 6 || error.code === 'already-exists' || error.code === 'ALREADY_EXISTS');
}

async function createOrReadPaymentOrder(orderRef, data, validateExisting) {
    try {
        await orderRef.create(data);
        return data;
    } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        const existing = await orderRef.get();
        if (!existing.exists) throw error;
        const existingData = existing.data() || {};
        validateExisting(existingData);
        return existingData;
    }
}

function getRazorpay() {
    const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
    const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
    if (!keyId || !keySecret) throw new Error('Razorpay keys are missing.');

    // Reuse the SDK client across warm serverless invocations.
    if (razorpayClientCache.client &&
        razorpayClientCache.keyId === keyId &&
        razorpayClientCache.keySecret === keySecret) {
        return razorpayClientCache.client;
    }

    const client = new Razorpay({ key_id: keyId, key_secret: keySecret });
    razorpayClientCache = { keyId, keySecret, client };
    return client;
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
async function createPinHash(pin) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await scryptAsync(String(pin).trim(), salt, 64, {
        N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024
    });
    return { pinSalt: salt, pinHash: Buffer.from(hash).toString('hex') };
}
async function verifyPinHash(pin, salt, expectedHash) {
    if (!isValidPin(pin) || !salt || !expectedHash) return false;
    try {
        const actual = await scryptAsync(String(pin).trim(), String(salt), 64, {
            N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024
        });
        const expected = Buffer.from(String(expectedHash), 'hex');
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch (error) {
        console.error('ASYNC PIN HASH ERROR:', error.message || error);
        return false;
    }
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
    const response = await fetch(cfg.verifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) throw new Error(`PayU verification HTTP ${response.status}`);
    const result = await response.json();
    const transaction = result?.transaction_details?.[txnid];
    if (!transaction) throw new Error('PayU did not return transaction details.');
    return transaction;
}

// ============================================================
// CORE ACTIVATION LOGIC (Used by both API and Webhook)
// ============================================================
async function processPlanActivation(orderId, paymentId, paymentGateway) {
    const db = getDB();
    const orderRef = db.collection('paymentOrders').doc(orderId);
    const orderSnapshot = await orderRef.get();
    if (!orderSnapshot.exists) throw new Error('Order not found');
    
    const orderData = orderSnapshot.data() || {};
    if (orderData.status === 'paid') return { alreadyProcessed: true, planType: orderData.planType, planExpiry: orderData.planExpiry };

    let planType = String(orderData.planType || '').toUpperCase(); 
    let planDurationMs = Number(orderData.planDurationMs || 0);
    
    if (!VALID_PLAN_TYPES.includes(planType) || planDurationMs <= 0) {
        const fallback = PLAN_CONFIG_BY_AMOUNT[orderData.amountRupees];
        if (fallback) {
            planType = fallback.type;
            planDurationMs = fallback.durationMs;
        } else {
            throw new Error('Invalid plan data');
        }
    }

    const userRef = db.collection('users').doc(normalizePhone(orderData.phone));
    let newPlanExpiry = 0;

    await db.runTransaction(async transaction => {
        const freshOrder = await transaction.get(orderRef); 
        const freshUser = await transaction.get(userRef);
        
        if (!freshUser.exists) throw new Error('Driver account not found.');
        if (freshOrder.data()?.status === 'paid') { 
            newPlanExpiry = Number(freshUser.data()?.planExpiry || 0); 
            return; 
        }

        const now = Date.now(); 
        const currentExpiry = Number(freshUser.data()?.planExpiry || 0);
        newPlanExpiry = (currentExpiry > now ? currentExpiry : now) + planDurationMs;

        transaction.update(userRef, { activePlan: planType, planExpiry: newPlanExpiry, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        transaction.update(orderRef, { 
            status: 'paid', 
            paymentId: paymentId, 
            paymentGateway: paymentGateway,
            activatedPlan: planType, 
            planExpiry: newPlanExpiry, 
            paidAt: admin.firestore.FieldValue.serverTimestamp() 
        });
    });
    
    userByUidCache.clear();
    invalidateBalanceCache(normalizePhone(orderData.phone)); // payment done => next balance call is fresh
    return { alreadyProcessed: false, planType, planExpiry: newPlanExpiry };
}

// ============================================================
// VERIFIED PAYMENT ORDER RECOVERY
// Payment checkout creation must not wait for a Firestore write.
// Unpaid orders are reconstructed from signed/provider-verified metadata
// only when a payment is being verified or a trusted webhook arrives.
// ============================================================
async function ensureRazorpayOrderRecord(orderId, expectedPhone = '', suppliedOrder = null) {
    if (!orderId || typeof orderId !== 'string') throw new Error('Invalid Razorpay order reference.');
    const db = getDB();
    const orderRef = db.collection('paymentOrders').doc(orderId);
    const existing = await orderRef.get();
    if (existing.exists) {
        const data = existing.data() || {};
        if (expectedPhone && normalizePhone(data.phone) !== normalizePhone(expectedPhone)) {
            throw new Error('Payment order does not belong to this driver.');
        }
        return data;
    }

    const razorpayOrder = suppliedOrder || await withTimeout(
        getRazorpay().orders.fetch(orderId), 12000, 'Razorpay order lookup'
    );
    if (String(razorpayOrder.id || '') !== orderId) throw new Error('Razorpay order reference mismatch.');
    if (String(razorpayOrder.currency || '').toUpperCase() !== 'INR') throw new Error('Unsupported Razorpay order currency.');

    const amountPaise = Number(razorpayOrder.amount || 0);
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0 || amountPaise % 100 !== 0) {
        throw new Error('Invalid Razorpay order amount.');
    }
    const amountRupees = amountPaise / 100;
    const planConfig = PLAN_CONFIG_BY_AMOUNT[amountRupees];
    const notes = razorpayOrder.notes || {};
    const phone = normalizePhone(notes.phone || '');
    const planType = String(notes.planType || '').toUpperCase();
    const planDurationMs = Number(notes.planDurationMs || 0);

    if (!planConfig || !phone || String(notes.app || '') !== 'Driver Ride Picker') {
        throw new Error('Razorpay order metadata could not be verified.');
    }
    if (expectedPhone && phone !== normalizePhone(expectedPhone)) {
        throw new Error('Payment order does not belong to this driver.');
    }
    if (planType !== planConfig.type || planDurationMs !== planConfig.durationMs) {
        throw new Error('Razorpay plan metadata mismatch.');
    }

    const data = {
        orderId,
        phone,
        amountRupees,
        amountPaise,
        planType: planConfig.type,
        planDurationMs: planConfig.durationMs,
        currency: 'INR',
        status: 'created',
        receipt: String(razorpayOrder.receipt || ''),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        recoveredFromProvider: true
    };
    return createOrReadPaymentOrder(orderRef, data, existingData => {
        if (normalizePhone(existingData.phone) !== phone ||
            Number(existingData.amountPaise) !== amountPaise ||
            String(existingData.planType || '').toUpperCase() !== planConfig.type) {
            throw new Error('Existing Razorpay order data does not match provider records.');
        }
    });
}

async function ensurePayUOrderRecord(txnid, trustedTransaction, expectedPhone = '') {
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(txnid || ''))) throw new Error('Invalid PayU transaction reference.');
    const db = getDB();
    const orderRef = db.collection('paymentOrders').doc(`payu_${txnid}`);
    const existing = await orderRef.get();
    if (existing.exists) {
        const data = existing.data() || {};
        if (expectedPhone && normalizePhone(data.phone) !== normalizePhone(expectedPhone)) {
            throw new Error('PayU order does not belong to this driver.');
        }
        return data;
    }

    const verifiedTxnId = String(trustedTransaction.txnid || txnid);
    const phone = normalizePhone(trustedTransaction.udf1 || trustedTransaction.phone || '');
    const amount = Number(trustedTransaction.amount || trustedTransaction.transaction_amount || 0);
    const amountRupees = Number(amount.toFixed(2));
    const planConfig = PLAN_CONFIG_BY_AMOUNT[amountRupees];
    if (verifiedTxnId !== txnid || !phone || !planConfig) {
        throw new Error('PayU transaction metadata could not be verified.');
    }
    if (expectedPhone && phone !== normalizePhone(expectedPhone)) {
        throw new Error('PayU transaction does not belong to this driver.');
    }

    const data = {
        orderId: txnid,
        txnid,
        paymentGateway: 'PAYU',
        phone,
        amountRupees,
        amountPaise: amountRupees * 100,
        planType: planConfig.type,
        planDurationMs: planConfig.durationMs,
        currency: 'INR',
        status: 'created',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        recoveredFromProvider: true
    };
    return createOrReadPaymentOrder(orderRef, data, existingData => {
        if (normalizePhone(existingData.phone) !== phone ||
            Number(existingData.amountRupees) !== amountRupees ||
            String(existingData.planType || '').toUpperCase() !== planConfig.type) {
            throw new Error('Existing PayU order data does not match provider records.');
        }
    });
}

// ============================================================
// CONFIG MERGE & VALIDATOR (Same as before)
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

const KNOWN_DRIVER_PACKAGE_PLATFORM = Object.freeze({
    'in.mobility.odishayatripartner': 'Odisha Yatri'
});

const DEFAULT_RIDE_BOT_CONFIG = {
    platforms: {
        Uber: { enabled: true, package_names: ["com.ubercab.driver"], accept_keywords: ["Match", "Accept", "Accept Ride", "Accept Trip", "Confirm"], success_signals: ["start ride", "start trip", "begin trip", "trip started", "ride started", "trip in progress", "on trip", "go to pickup", "going to pickup", "navigate to pickup", "arrived at pickup", "reached pickup", "waiting for rider", "waiting for customer", "waiting for passenger", "enter otp", "verify otp", "otp verification", "share otp", "confirm otp", "otp submit", "call rider", "call customer", "call passenger", "chat with rider", "message rider", "chat with customer", "you have accepted", "ride accepted", "trip accepted", "accepted the ride", "booking accepted", "order accepted"], view_id_patterns: ["accept", "match", "confirm"] },
        Ola: { enabled: true, package_names: ["com.olacabs.driver", "com.olacabs.oladriver"], accept_keywords: ["Match", "Accept", "Accept Ride", "Accept Trip", "Confirm"], success_signals: ["start ride", "start trip", "begin trip", "trip started", "ride started", "trip in progress", "on trip", "go to pickup", "going to pickup", "navigate to pickup", "arrived at pickup", "reached pickup", "waiting for rider", "waiting for customer", "waiting for passenger", "enter otp", "verify otp", "otp verification", "share otp", "confirm otp", "otp submit", "call rider", "call customer", "call passenger", "chat with rider", "message rider", "chat with customer", "you have accepted", "ride accepted", "trip accepted", "accepted the ride", "booking accepted", "order accepted"], view_id_patterns: ["accept", "confirm"] },
        Rapido: { enabled: true, package_names: ["com.rapido.driver"], accept_keywords: ["Accept Order", "Accept", "Accept Ride", "Accept Trip", "Confirm", "Match"], success_signals: ["start ride", "start trip", "begin trip", "trip started", "ride started", "trip in progress", "on trip", "go to pickup", "going to pickup", "navigate to pickup", "arrived at pickup", "reached pickup", "waiting for rider", "waiting for customer", "waiting for passenger", "enter otp", "verify otp", "otp verification", "share otp", "confirm otp", "otp submit", "call rider", "call customer", "call passenger", "chat with rider", "message rider", "chat with customer", "you have accepted", "ride accepted", "trip accepted", "accepted the ride", "booking accepted", "order accepted"], view_id_patterns: ["accept", "order"] },
        "Namma Yatri": { enabled: true, package_names: ["net.openkochi.yatripartner", "in.juspay.nammayatripartner", "in.mobility.manayatripartner", "com.nammayatri", "com.mobility.movingtechdriver"], accept_keywords: ["Confirm", "Accept", "Accept Ride", "Accept Trip", "Match"], success_signals: ["start ride", "start trip", "begin trip", "trip started", "ride started", "trip in progress", "on trip", "go to pickup", "going to pickup", "navigate to pickup", "arrived at pickup", "reached pickup", "waiting for rider", "waiting for customer", "waiting for passenger", "enter otp", "verify otp", "otp verification", "share otp", "confirm otp", "otp submit", "call rider", "call customer", "call passenger", "chat with rider", "message rider", "chat with customer", "you have accepted", "ride accepted", "trip accepted", "accepted the ride", "booking accepted", "order accepted"], view_id_patterns: ["accept", "confirm"] },
        CityRide: { enabled: true, package_names: ["in.cityride.driver"], accept_keywords: ["Accept Ride", "Accept", "Accept Trip", "Confirm"], success_signals: ["start ride", "start trip", "begin trip", "trip started", "ride started", "trip in progress", "on trip", "go to pickup", "going to pickup", "navigate to pickup", "arrived at pickup", "reached pickup", "waiting for rider", "waiting for customer", "waiting for passenger", "enter otp", "verify otp", "otp verification", "share otp", "confirm otp", "otp submit", "call rider", "call customer", "call passenger", "chat with rider", "message rider", "chat with customer", "you have accepted", "ride accepted", "trip accepted", "accepted the ride", "booking accepted", "order accepted"], view_id_patterns: ["accept", "confirm"] },
        "Odisha Yatri": { enabled: true, package_names: ["in.mobility.odishayatripartner"], accept_keywords: ["Accept", "Accept Ride", "Accept Trip", "Accept Request", "Accept Booking", "Confirm"], success_signals: ["start ride", "start trip", "begin trip", "trip started", "ride started", "trip in progress", "on trip", "go to pickup", "going to pickup", "navigate to pickup", "arrived at pickup", "reached pickup", "waiting for rider", "waiting for customer", "waiting for passenger", "enter otp", "verify otp", "otp verification", "share otp", "confirm otp", "otp submit", "call rider", "call customer", "call passenger", "chat with rider", "message rider", "chat with customer", "you have accepted", "ride accepted", "trip accepted", "accepted the ride", "booking accepted", "order accepted"], view_id_patterns: ["accept", "confirm", "request", "booking"] }
    },
    global: { bot_enabled: true, auto_accept_enabled: true, max_ride_cycle_duration_ms: 8000, maxRideCycleDurationMs: 8000, watchdog_interval_ms: 2000, watchdogIntervalMs: 2000, config_refresh_interval_ms: 3600000, configRefreshIntervalMs: 3600000, health_check_interval_ms: 3600000, healthCheckIntervalMs: 3600000, node_null_delay_ms: 20, nodeNullDelayMs: 20, debounce_normal_ms: 5, debounceNormalMs: 5, debounce_slow_ms: 20, debounceSlowMs: 20, location_min_time_ms: 5000, locationMinTimeMs: 5000, location_min_distance_m: 50, locationMinDistanceM: 50, plan_offline_grace_ms: 1800000, planOfflineGraceMs: 1800000 },
    controls: { bot_enabled: true, auto_accept_enabled: true },
    // Conservative remote timing profile.
    // Strategy order remains: normal (original/default) -> medium (fallback) -> high_speed (last fallback).
    // Both camelCase and snake_case keys are sent for compatibility with existing APK builds.
    strategies: {
        normal: {
            attempts: 6,
            tapIntervalMs: 45, tap_interval_ms: 45,
            verifyDelayMs: 60, verify_delay_ms: 60,
            tapMode: 'CENTER'
        },
        medium: {
            attempts: 10,
            tapIntervalMs: 45, tap_interval_ms: 45,
            verifyDelayMs: 60, verify_delay_ms: 60,
            tapMode: 'CENTER'
        },
        high_speed: {
            attempts: 15, attemptsSlow: 15, attempts_slow: 15,
            tapIntervalMs: 30, tap_interval_ms: 30,
            verifyDelayMs: 60, verify_delay_ms: 60,
            verifyDelaySlowMs: 80, verify_delay_slow_ms: 80,
            tapMode: 'GHOST'
        }
    },
    filters: { enabled: true, keyword_mode: "ANY", minimum_fare: 0, minimumFare: 0, maximum_fare: 0, maximumFare: 0, maximum_pickup_distance_km: 0, maximumPickupDistanceKm: 0, maximum_drop_distance_km: 0, maximumDropDistanceKm: 0, maximum_trip_distance_km: 0, maximumTripDistanceKm: 0, minimum_trip_distance_km: 0, minimumTripDistanceKm: 0, work_zone_radius_km: 5, workZoneRadiusKm: 5, allowed_vehicles: ["AUTO", "CAR", "BIKE"], allowedVehicles: ["AUTO", "CAR", "BIKE"], target_areas: [], targetAreas: [], blocked_areas: [], blockedAreas: [], required_keywords: [], requiredKeywords: [], blocked_keywords: ["close drawer", "earnings", "trips", "preferences", "plans", "benefits", "aarokya", "store", "help", "open data", "about", "google maps", "bottom sheet backdrop", "bottom sheet", "permissions required", "draw over other apps", "receive ride requests when the app is", "1 order", "go to home", "orders missed", "you missed the order", "sorry, this order was accepted by another captain", "confirm your detected location", "confirm google map", "go to location"], blockedKeywords: ["close drawer", "earnings", "trips", "preferences", "plans", "benefits", "aarokya", "store", "help", "open data", "about", "google maps", "bottom sheet backdrop", "bottom sheet", "permissions required", "draw over other apps", "receive ride requests when the app is", "1 order", "go to home", "orders missed", "you missed the order", "sorry, this order was accepted by another captain", "confirm your detected location", "confirm google map", "go to location"] }
};

function normalizeRideBotConfig(config) {
    const normalized = JSON.parse(JSON.stringify(config || DEFAULT_RIDE_BOT_CONFIG));
    if (!normalized.global || typeof normalized.global !== 'object' || Array.isArray(normalized.global)) { normalized.global = {}; }
    const globalConfig = normalized.global;
    const configuredCycle = Number(globalConfig.max_ride_cycle_duration_ms ?? globalConfig.maxRideCycleDurationMs ?? 8000);
    const safeCycle = Number.isFinite(configuredCycle) ? Math.min(30000, Math.max(8000, configuredCycle)) : 8000;
    const configuredWatchdog = Number(globalConfig.watchdog_interval_ms ?? globalConfig.watchdogIntervalMs ?? 2000);
    const safeWatchdog = Number.isFinite(configuredWatchdog) ? Math.min(15000, Math.max(500, configuredWatchdog)) : 2000;
    globalConfig.max_ride_cycle_duration_ms = safeCycle; globalConfig.maxRideCycleDurationMs = safeCycle;
    globalConfig.watchdog_interval_ms = safeWatchdog; globalConfig.watchdogIntervalMs = safeWatchdog;

    // Normalize strategy timing on the server so old Redis overrides cannot
    // re-introduce extremely short 5-20ms tap/verification loops.
    // The Android APK still decides whether and how it executes these strategies.
    if (!normalized.strategies || typeof normalized.strategies !== 'object' || Array.isArray(normalized.strategies)) {
        normalized.strategies = {};
    }

    const strategyProfiles = {
        normal: {
            attempts: 6, tapIntervalMs: 45, tap_interval_ms: 45,
            verifyDelayMs: 60, verify_delay_ms: 60, tapMode: 'CENTER'
        },
        medium: {
            attempts: 10, tapIntervalMs: 45, tap_interval_ms: 45,
            verifyDelayMs: 60, verify_delay_ms: 60, tapMode: 'CENTER'
        },
        high_speed: {
            attempts: 15, attemptsSlow: 15, attempts_slow: 15,
            tapIntervalMs: 30, tap_interval_ms: 30,
            verifyDelayMs: 60, verify_delay_ms: 60,
            verifyDelaySlowMs: 80, verify_delay_slow_ms: 80,
            tapMode: 'GHOST'
        }
    };

    // Keep the known Strategy 1 and Strategy 2 profiles intact.
    // Strategy 3 remains the final fallback and is less aggressive than the old 5ms profile.
    normalized.strategies.normal = { ...strategyProfiles.normal };
    normalized.strategies.medium = { ...strategyProfiles.medium };
    normalized.strategies.high_speed = { ...strategyProfiles.high_speed };

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
        initializeFirebaseAdmin(); await admin.appCheck().verifyToken(appCheckToken); next();
    } catch (error) {
        if (enforce) return res.status(403).json({ success: false, message: 'Access Denied: Invalid App Check Token.' }); else return next();
    }
}

async function verifyFirebaseToken(req, res, next) {
    try {
        const decoded = await decodeFirebaseToken(req);
        if (!decoded.uid) return res.status(401).json({ success: false, message: 'Invalid Firebase user.' });

        // 🔥 FAST PATH: Use phone from token claims if available
        if (decoded.phone) {
            req.firebaseUser = { uid: decoded.uid, phone: normalizePhone(decoded.phone), decodedToken: decoded };
            return next();
        }

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

// Compatibility-only endpoint for older APKs.
// This does NOT check versions, read Redis, or force an update.
// To stop the request itself, the APK must stop calling this endpoint.
app.get('/api/app/update', (req, res) => {
    // s-maxage => Vercel CDN answers repeat calls WITHOUT running the function (no CPU).
    res.set('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({
        success: true,
        latestVersion: '0.0.0',
        minimumVersion: '0.0.0',
        forceUpdate: false,
        updateAvailable: false,
        updateRequired: false,
        mandatory: false,
        updateMessage: 'Version checking is disabled.',
        message: 'Version checking is disabled.',
        title: APP_UPDATE_TITLE,
        releaseNotes: 'Version checking disabled; installed versions remain supported.',
        downloadUrl: '',
        apkUrl: ''
    });
});

// APK compatibility endpoint.
// Serve the in-code defaults from the warm-instance cache only.
// No Redis read, config-version lookup, or remote strategy override is done here.
// Existing strategy profiles are retained in DEFAULT_RIDE_BOT_CONFIG for old APK compatibility.
app.get('/api/config/ride-bot', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400');
    res.set('Access-Control-Allow-Origin', '*');
    try {
        if (rideConfigCache.body && Date.now() - rideConfigCache.at < RIDE_CONFIG_CACHE_MS) {
            return res.status(200).json(rideConfigCache.body);
        }
        const config = normalizeRideBotConfig(DEFAULT_RIDE_BOT_CONFIG);
        const body = {
            version: 0,
            updatedAt: 'static-default',
            ...config
        };
        rideConfigCache = { at: Date.now(), body };
        return res.status(200).json(body);
    } catch (error) {
        console.error('STATIC RIDE CONFIG ERROR:', error.message || error);
        return res.status(200).json({
            version: 0,
            updatedAt: 'static-default',
            ...normalizeRideBotConfig(DEFAULT_RIDE_BOT_CONFIG)
        });
    }
});

app.post('/api/admin/config/ride-bot', async (req, res) => {
    if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    try {
        const clean = validateRemoteRideConfig(req.body?.config || req.body);
        const previousStored = await redis.get(RIDE_BOT_CONFIG_DATA_KEY);
        const previous = previousStored ? (typeof previousStored === 'string' ? JSON.parse(previousStored) : previousStored) : {};
        const merged = normalizeRideBotConfig(mergeConfigObjects(mergeConfigObjects(DEFAULT_RIDE_BOT_CONFIG, previous), clean));
        await redis.set(RIDE_BOT_CONFIG_DATA_KEY, JSON.stringify(merged));
        const previousVersion = await getRideBotConfigVersion(); const newVersion = previousVersion + 1;
        await redis.set(RIDE_BOT_CONFIG_VERSION_KEY, String(newVersion));
        clearRideConfigCache();
        return res.json({ success: true, previousVersion, newVersion, config: merged });
    } catch (error) { return res.status(400).json({ success: false, message: error.message || 'Unable to save remote config.' }); }
});

app.post('/api/admin/config/reset', async (req, res) => {
    if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    try { await redis.del(RIDE_BOT_CONFIG_DATA_KEY); const newVersion = (await getRideBotConfigVersion()) + 1; await redis.set(RIDE_BOT_CONFIG_VERSION_KEY, String(newVersion)); clearRideConfigCache(); return res.json({ success: true, newVersion, message: 'Stored config cleared. Code defaults are now active.' }); }
    catch (e) { return res.status(500).json({ success: false, message: 'Reset failed.' }); }
});

app.post('/api/admin/platform/package/add', async (req, res) => {
    if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    try {
        const platformName = String(req.body?.platform || '').trim(); const packageName = String(req.body?.packageName || '').trim();
        const allowedPlatforms = ['Uber', 'Ola', 'Rapido', 'Namma Yatri', 'CityRide', 'Odisha Yatri']; const packagePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
        if (!allowedPlatforms.includes(platformName)) return res.status(400).json({ success: false, message: 'Invalid platform.' });
        if (!packagePattern.test(packageName) || packageName.length > 180) return res.status(400).json({ success: false, message: 'Invalid Android package name.' });
        if (BLOCKED_DRIVER_PACKAGE_IDS.has(packageName)) return res.status(400).json({ success: false, message: 'Passenger application package cannot be approved as a driver app.' });
        const knownOwner = KNOWN_DRIVER_PACKAGE_PLATFORM[packageName];
        if (knownOwner && knownOwner !== platformName) { return res.status(400).json({ success: false, message: `This package is assigned to ${knownOwner}.` }); }
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
            const previousVersion = await getRideBotConfigVersion(); const newVersion = previousVersion + 1;
            await redis.set(RIDE_BOT_CONFIG_VERSION_KEY, String(newVersion));
            clearRideConfigCache();
            return res.json({ success: true, added: true, platform: platformName, packageName, previousVersion, newVersion, message: 'Package added.' });
        }
        return res.json({ success: true, added: false, platform: platformName, packageName, version: await getRideBotConfigVersion(), message: 'Package already exists.' });
    } catch (error) { return res.status(500).json({ success: false, message: 'Unable to add platform package.' }); }
});

app.get('/api/admin/config/version', async (req, res) => { if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' }); try { return res.json({ success: true, version: await getRideBotConfigVersion(), source: 'redis-or-env-fallback' }); } catch (error) { return res.status(500).json({ success: false, message: 'Unable to read config version.' }); } });
app.post('/api/admin/config/bump', async (req, res) => { if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' }); try { const current = await getRideBotConfigVersion(); const next = current + 1; await redis.set(RIDE_BOT_CONFIG_VERSION_KEY, String(next)); clearRideConfigCache(); return res.json({ success: true, previousVersion: current, newVersion: next, message: `Config version bumped to ${next}.` }); } catch (error) { return res.status(500).json({ success: false, message: 'Unable to bump config version.' }); } });
app.post('/api/admin/config/set', async (req, res) => { if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' }); try { const requested = Number(req.body.version); if (!Number.isFinite(requested) || requested <= 0 || !Number.isInteger(requested)) return res.status(400).json({ success: false, message: 'version must be a positive integer.' }); await redis.set(RIDE_BOT_CONFIG_VERSION_KEY, String(requested)); clearRideConfigCache(); return res.json({ success: true, newVersion: requested }); } catch (error) { return res.status(500).json({ success: false, message: 'Unable to set config version.' }); } });
// Compatibility no-op: health telemetry is disabled; no DB/Redis writes.
app.post('/api/health/report', (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, accepted: false, disabled: true });
});
app.get('/api/admin/dashboard', (req, res) => { if (!verifyAdminToken(req)) return res.status(401).json({ error: 'Unauthorized' }); return res.status(200).json({ success: true, disabled: true, message: 'Telemetry dashboard is disabled.' }); });
app.get('/api/admin/tracker', (req, res) => { return res.status(200).json({ success: true, disabled: true, message: 'Driver activity tracking is disabled.' }); });
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
        const userRef = db.collection('users').doc(phone);

        // Run independent Firestore reads together to reduce login round trips.
        const [lockState, existingUserDoc] = await Promise.all([
            getPinLockState(db, phone),
            userRef.get()
        ]);

        if (lockState.locked) {
            const remainingMinutes = Math.max(1, Math.ceil((lockState.lockedUntilMs - Date.now()) / (60 * 1000)));
            return res.status(429).json({ success: false, message: `Too many wrong PIN attempts. Try again in ${remainingMinutes} minute(s).` });
        }
        const driverFirebaseUid = generateDriverFirebaseUid(phone);

        let isNewUser = false; let trialAdded = false; let pinWasCreated = false; let userData = null;

        if (existingUserDoc.exists) {
            userData = existingUserDoc.data() || {};
            const updates = {};

            if (userData.pinHash && userData.pinSalt) {
                if (!(await verifyPinHash(pin, userData.pinSalt, userData.pinHash))) {
                    const failure = await recordPinFailure(db, phone);
                    if (failure.locked) return res.status(429).json({ success: false, message: `Too many wrong PIN attempts. Try again in ${PIN_LOCK_MINUTES} minutes.` });
                    return res.status(401).json({ success: false, message: 'Invalid mobile number or PIN.' });
                }
            } else {
                const pinData = await createPinHash(pin);
                updates.pinSalt = pinData.pinSalt; updates.pinHash = pinData.pinHash; updates.pinCreatedAt = admin.firestore.FieldValue.serverTimestamp(); pinWasCreated = true;
            }

            if (!userData.migratedToTimeSystem) { updates.migratedToTimeSystem = true; }
            if (!userData.v18PromoClaimed) { updates.v18PromoClaimed = true; }
            if (typeof userData.activePlan !== 'string') updates.activePlan = PLAN_TYPE_NONE;
            if (typeof userData.planExpiry !== 'number') updates.planExpiry = updates.planExpiry || 0;
            if (typeof userData.totalRides !== 'number') updates.totalRides = Number(userData.totalRides || 0);

            if (userData.firebaseUid !== driverFirebaseUid) updates.firebaseUid = driverFirebaseUid;
            if (userData.authMethod !== 'pin') updates.authMethod = 'pin';
            if (!userData.referralCode) updates.referralCode = await createUniqueReferralCode(db, userRef);

            // Avoid a Firestore write on every normal login when nothing changed.
            if (Object.keys(updates).length > 0) {
                updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
                await userRef.update(updates);
                userData = { ...userData, ...updates };
            }
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

            const pinData = await createPinHash(pin);
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
                    migratedToTimeSystem: true, v18PromoClaimed: true, createdAt: admin.firestore.FieldValue.serverTimestamp(),
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
                    if (!(await verifyPinHash(pin, userData.pinSalt, userData.pinHash))) {
                        const failure = await recordPinFailure(db, phone);
                        if (failure.locked) return res.status(429).json({ success: false, message: `Too many wrong PIN attempts. Try again in ${PIN_LOCK_MINUTES} minutes.` });
                        return res.status(401).json({ success: false, message: 'Invalid mobile number or PIN.' });
                    }
                }
                trialAdded = false; isNewUser = false;
            } else {
                trialAdded = transactionResult.trialGranted;
                userData = {
                    phone,
                    firebaseUid: driverFirebaseUid,
                    activePlan: PLAN_TYPE_NONE,
                    planExpiry: trialAdded ? (Date.now() + TRIAL_DURATION_MS) : 0,
                    totalRides: 0,
                    referralCode: newReferralCode,
                    referralCount: 0
                };

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
            }
        }

        await clearPinFailures(db, phone);
        
        // 🔥 FAST PATH: Include phone in custom token so app doesn't need DB later
        const firebaseCustomToken = await admin.auth().createCustomToken(driverFirebaseUid, { driver: true, phone: phone });

        let referralCount = 0;
        try {
            const referralCountSnapshot = await db.collection('referralRewards').where('referrerPhone', '==', phone).where('status', '==', 'rewarded').count().get();
            referralCount = Number(referralCountSnapshot.data().count || 0);
        } catch (_) { referralCount = 0; }

        const planExpiry = Number(userData.planExpiry || 0);
        const activePlan = getActivePlanType(userData);
        const isUnlimited = planExpiry > Date.now();

        let welcomeMessage;
        if (isNewUser) { welcomeMessage = trialAdded ? `Welcome! 24 Hours Free Trial activated.` : 'Account created. This installation has already used the free trial.'; }
        else { welcomeMessage = pinWasCreated ? 'PIN created successfully. Welcome back!' : 'Welcome back!'; }

        userByUidCache.delete(driverFirebaseUid);

        return res.json({
            success: true, isNewUser, trialPlanAdded: trialAdded, pinWasCreated, authMethod: 'pin',
            firebaseCustomToken, message: welcomeMessage,
            user: { phone: userData.phone || phone, firebaseUid: driverFirebaseUid, activePlan, planExpiry, isUnlimited, totalRides: Number(userData.totalRides || 0), referralCode: userData.referralCode || '', referralCount }
        });
    } catch (error) { console.error('PIN LOGIN ERROR:', error); return res.status(500).json({ success: false, message: 'Server error: ' + error.message }); }
});

// Do not cache plan validity for 30 minutes here. Payment activation/expiry
// must be visible immediately after verified payment. Reduce polling in the APK.
app.get('/api/user/balance/:phone', verifyFirebaseToken, async (req, res) => {
    try {
        const phone = normalizePhone(req.params.phone);
        if (!phoneMatchesAuthenticatedUser(req, phone)) return res.status(403).json({ success: false, message: 'You can only access your own account.' });
        res.set('Cache-Control', 'private, no-store');
        const hit = balanceCache.get(phone);
        if (hit && Date.now() - hit.at < BALANCE_CACHE_MS) return res.json(hit.body);
        const snapshot = await getDB().collection('users').doc(phone).get();
        if (!snapshot.exists) return res.status(404).json({ success: false, message: 'Driver account not found.' });
        const data = snapshot.data() || {};
        const referralCount = Number(data.referralCount || 0); const planExpiry = Number(data.planExpiry || 0);
        const activePlan = getActivePlanType(data); const isUnlimited = planExpiry > Date.now();
        const body = { success: true, activePlan, planExpiry, planExpiryIso: planExpiry > 0 ? new Date(planExpiry).toISOString() : null, isUnlimited, totalRides: Number(data.totalRides || 0), referralCode: data.referralCode || '', referralCount };
        balanceCache.set(phone, { at: Date.now(), body });
        if (balanceCache.size > 5000) balanceCache.clear();
        return res.json(body);
    } catch (error) { return res.status(500).json({ success: false, message: 'Unable to load balance.' }); }
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
        try { const rewardedSnapshot = await db.collection('referralRewards').where('referrerPhone', '==', phone).where('status', '==', 'rewarded').get(); successfulReferrals = rewardedSnapshot.size; hoursEarned = successfulReferrals * 3; } catch (referralError) { successfulReferrals = Number(userData.referralCount || 0); hoursEarned = successfulReferrals * 3; }
        return res.json({ success: true, referralCode, successfulReferrals, hoursEarned, bonusHoursPerReferral: 3, message: 'Referral details loaded.' });
    } catch (error) { return res.status(500).json({ success: false, message: 'Unable to load referral details.' }); }
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
            if (Number(userData.planExpiry || 0) <= Date.now()) return res.status(402).json({ success: false, message: 'Plan expired. Please recharge to continue.' });
        }
        const activePlanType = getActivePlanType(userData);
        return res.json({ success: true, alreadyProcessed: false, ridesDeducted: 0, unlimited: true, planType: activePlanType, message: `Unlimited ${activePlanType} plan active. No deduction.` });
    } catch (error) { return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Unable to process ride.' }); }
});

app.post('/api/ride/refund-credit', verifyFirebaseToken, async (req, res) => { return res.json({ success: true, refunded: false, alreadyRefunded: false, message: 'Refund not applicable in time-based system.' }); });

app.get('/api/payment/providers', verifyFirebaseToken, async (req, res) => {
    // 🔥 FAST PATH: Add caching headers
    res.set('Cache-Control', 'public, max-age=3600');
    const razorpayEnabled = Boolean(String(process.env.RAZORPAY_KEY_ID || '').trim() && String(process.env.RAZORPAY_KEY_SECRET || '').trim());
    const payuBaseUrl = String(process.env.PUBLIC_BACKEND_URL || process.env.APP_BASE_URL || '').trim();
    const payuEnabled = Boolean(String(process.env.PAYU_KEY || '').trim() && String(process.env.PAYU_SALT || '').trim() && /^https:\/\//i.test(payuBaseUrl));
    const providers = [{ id: 'RAZORPAY', name: 'Razorpay', enabled: razorpayEnabled }, { id: 'PAYU', name: 'PayU', enabled: payuEnabled }];
    const defaultProvider = razorpayEnabled ? 'RAZORPAY' : (payuEnabled ? 'PAYU' : 'NONE');
    return res.json({ success: true, providers, defaultProvider });
});

app.post('/api/payment/webhook/razorpay', async (req, res) => {
    try {
        const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
        if (!secret) { console.warn('RAZORPAY_WEBHOOK_SECRET is not set.'); return res.status(200).send('Webhook secret not configured'); }
        const signature = String(req.headers['x-razorpay-signature'] || '');
        const expectedSignature = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
        if (!signature || expectedSignature.length !== signature.length ||
            !crypto.timingSafeEqual(Buffer.from(expectedSignature, 'utf8'), Buffer.from(signature, 'utf8'))) {
            console.error('Razorpay webhook signature mismatch.');
            return res.status(400).send('Invalid signature');
        }
        const event = req.body.event;
        if (event === 'payment.captured' || event === 'order.paid') {
            const paymentEntity = req.body?.payload?.payment?.entity || null;
            const orderEntity = req.body?.payload?.order?.entity || null;
            const orderId = String(paymentEntity?.order_id || orderEntity?.id || '').trim();
            const paymentId = String(paymentEntity?.id || '').trim();
            if (!orderId || !paymentId) return res.status(200).send('Payment details not present; ignored');
            // Recovery handles the race where checkout returned before the order
            // record was created; it trusts only the signed webhook + Razorpay order.
            await ensureRazorpayOrderRecord(orderId);
            await processPlanActivation(orderId, paymentId, 'RAZORPAY_WEBHOOK');
        }
        return res.status(200).send('OK');
    } catch (error) {
        console.error('RAZORPAY WEBHOOK ERROR:', error.message || error);
        return res.status(500).send('Webhook error');
    }
});

app.post('/api/payment/payu/create-order', verifyFirebaseToken, async (req, res) => {
    const startedAt = Date.now();
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
        const params = { key: cfg.key, txnid, amount, productinfo, firstname: firstName, email, phone, udf1: phone, udf2: '', udf3: '', udf4: '', udf5: '', surl: `${baseUrl}/api/payment/payu/return`, furl: `${baseUrl}/api/payment/payu/return`, curl: `${baseUrl}/api/payment/payu/return` };
        params.hash = generatePayURequestHash(params, cfg.salt);

        // PayU checkout parameters are generated locally. Do not block gateway
        // launch on Firestore: the signed PayU return / verification API will
        // create the durable order record before any plan activation.
        console.info('PAYU_CHECKOUT_READY', { elapsedMs: Date.now() - startedAt });
        return res.json({ success: true, provider: 'PAYU', txnid, orderId: txnid, amount, currency: 'INR', planType: planConfig.type, planDurationMs: planConfig.durationMs, checkoutUrl: cfg.paymentUrl, formData: params });
    } catch (error) {
        console.error('PAYU CREATE ORDER ERROR:', error.message || error);
        return res.status(500).json({ success: false, message: error.message || 'Unable to create PayU order.' });
    }
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
        if (String(body.status || '').toLowerCase() !== 'success') {
            const existing = await orderRef.get();
            if (existing.exists) await orderRef.set({ status: 'failed', payuStatus: String(body.status || 'unknown'), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            return failPage('The payment provider reported an unsuccessful payment.');
        }

        const signedPhone = normalizePhone(body.udf1 || '');
        const signedAmount = Number(Number(body.amount).toFixed(2));
        const planConfig = PLAN_CONFIG_BY_AMOUNT[signedAmount];
        if (!signedPhone || !planConfig) return failPage('Payment driver or plan details could not be verified.');

        let orderData;
        try {
            orderData = await ensurePayUOrderRecord(txnid, {
                txnid,
                udf1: signedPhone,
                amount: signedAmount
            }, signedPhone);
        } catch (orderError) {
            console.error('PAYU ORDER RECOVERY ERROR:', orderError.message || orderError);
            return failPage('Payment order could not be securely recovered.');
        }

        if (normalizePhone(orderData.phone) !== signedPhone || Number(orderData.amountRupees) !== signedAmount) return failPage('Payment amount or driver reference mismatch.');
        if (orderData.status === 'paid') return successPage();

        let verifiedStatus = String(body.status || '').toLowerCase();
        let verifiedAmount = Number(body.amount || 0);
        let mihpayid = String(body.mihpayid || '');
        try {
            const verified = await verifyPayUTransaction(txnid, cfg);
            verifiedStatus = String(verified.status || '').toLowerCase();
            verifiedAmount = Number(verified.amount || verified.transaction_amount || 0);
            mihpayid = String(verified.mihpayid || mihpayid);
            if (normalizePhone(verified.udf1 || signedPhone) !== signedPhone || String(verified.txnid || txnid) !== txnid) {
                return failPage('PayU transaction ownership could not be verified.');
            }
        } catch (e) {
            console.error('PayU verify API delayed; authenticated response hash retained:', e.message || e);
        }
        if (verifiedStatus !== 'success') return failPage('PayU verification did not confirm success status.');
        if (Number(verifiedAmount.toFixed(2)) !== Number(Number(orderData.amountRupees).toFixed(2))) return failPage('PayU verification amount mismatch.');

        await processPlanActivation(`payu_${txnid}`, mihpayid, 'PAYU');
        return successPage();
    } catch (error) {
        console.error('PAYU RETURN/VERIFY ERROR:', error.message || error);
        return failPage('We could not verify this payment yet.');
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
        let orderData = orderSnapshot.exists ? (orderSnapshot.data() || {}) : null;
        if (orderData && normalizePhone(orderData.phone) !== phone) return res.status(403).json({ success: false, message: 'Payment order mismatch.' });
        if (orderData?.status === 'paid') return res.json({ success: true, alreadyProcessed: true, provider: 'PAYU', planType: orderData.planType || PLAN_TYPE_NONE, planExpiry: Number(orderData.planExpiry || 0), message: 'Payment already processed.' });

        const cfg = getPayUConfig();
        let verified;
        try {
            verified = await verifyPayUTransaction(txnid, cfg);
        } catch (error) {
            return res.status(202).json({ success: false, alreadyProcessed: false, provider: 'PAYU', status: 'pending', planType: PLAN_TYPE_NONE, planExpiry: 0, message: 'Payment verification pending. Please check again shortly.' });
        }
        const verifiedStatus = String(verified.status || '').toLowerCase();
        if (verifiedStatus !== 'success') return res.status(202).json({ success: false, alreadyProcessed: false, provider: 'PAYU', status: verifiedStatus || 'pending', planType: PLAN_TYPE_NONE, planExpiry: 0, message: 'Payment is not confirmed yet.' });
        if (String(verified.txnid || txnid) !== txnid) return res.status(400).json({ success: false, message: 'PayU transaction reference mismatch.' });

        const verifiedPhone = normalizePhone(verified.udf1 || verified.phone || '');
        if (!verifiedPhone || verifiedPhone !== phone) return res.status(403).json({ success: false, message: 'PayU transaction ownership could not be verified.' });

        const verifiedAmount = Number(verified.amount || verified.transaction_amount || 0);
        const amountRupees = Number(verifiedAmount.toFixed(2));
        const planConfig = PLAN_CONFIG_BY_AMOUNT[amountRupees];
        if (!planConfig) return res.status(400).json({ success: false, message: 'PayU transaction amount does not match an available plan.' });

        if (!orderData) {
            orderData = await ensurePayUOrderRecord(txnid, verified, phone);
        } else if (Number(verifiedAmount.toFixed(2)) !== Number(Number(orderData.amountRupees).toFixed(2))) {
            return res.status(400).json({ success: false, message: 'PayU transaction amount mismatch.' });
        }

        const result = await processPlanActivation(`payu_${txnid}`, String(verified.mihpayid || ''), 'PAYU');
        return res.json({ success: true, alreadyProcessed: false, provider: 'PAYU', status: 'success', planType: result.planType, planExpiry: result.planExpiry, planExpiryIso: result.planExpiry ? new Date(result.planExpiry).toISOString() : null, message: 'Payment verified and plan activated.' });
    } catch (error) {
        console.error('PAYU VERIFY ERROR:', error.message || error);
        return res.status(500).json({ success: false, message: 'Unable to verify PayU payment right now.' });
    }
});

app.get('/api/payment/payu/status/:txnid', verifyFirebaseToken, async (req, res) => {
    try {
        const phone = getAuthenticatedPhone(req); const txnid = String(req.params.txnid || '').trim();
        if (!/^[A-Za-z0-9_-]{8,40}$/.test(txnid)) return res.status(400).json({ success: false, message: 'Invalid transaction reference.' });
        const snapshot = await getDB().collection('paymentOrders').doc(`payu_${txnid}`).get();
        if (!snapshot.exists) return res.status(404).json({ success: false, message: 'Payment order not found.' });
        const data = snapshot.data() || {};
        if (normalizePhone(data.phone) !== phone) return res.status(403).json({ success: false, message: 'Payment order mismatch.' });
        return res.json({ success: true, txnid, status: data.status || 'unknown', planType: data.planType || PLAN_TYPE_NONE, planExpiry: Number(data.planExpiry || 0) });
    } catch (error) { return res.status(500).json({ success: false, message: 'Unable to load PayU payment status.' }); }
});

app.post('/api/telemetry/summary', (req, res) => { return res.status(200).json({ success: true, accepted: false, disabled: true }); });
app.post('/api/telemetry/alert', (req, res) => { return res.status(200).json({ success: true, accepted: false, disabled: true }); });
app.post('/api/telemetry/compatibility', (req, res) => { return res.status(200).json({ success: true, accepted: false, disabled: true }); });
app.get('/api/cron/play-store-package-discovery', (req, res) => { return res.status(200).json({ success: true, disabled: true, message: 'Automatic Play Store discovery is disabled.' }); });
app.post('/api/admin/play-store-package-discovery/run', (req, res) => { if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' }); return res.status(200).json({ success: true, disabled: true, message: 'Automatic Play Store discovery is disabled.' }); });
app.get('/api/cron/hourly-summary', (req, res) => { return res.status(200).json({ success: true, disabled: true, message: 'Automated reports are disabled.' }); });
app.get('/api/cron/half-hour-summary', (req, res) => { return res.status(200).json({ success: true, disabled: true, message: 'Automated reports are disabled.' }); });
app.post('/api/admin/telegram/test', (req, res) => { if (!verifyAdminToken(req)) return res.status(401).json({ success: false, message: 'Unauthorized.' }); return res.status(200).json({ success: true, sent: false, disabled: true }); });

app.post('/api/payment/create-order', verifyFirebaseToken, async (req, res) => {
    const startedAt = Date.now();
    try {
        const phone = getAuthenticatedPhone(req);
        const amountRupees = Number(req.body.amountRupees);
        if (!phone) return res.status(401).json({ success: false, message: 'Authenticated driver required.' });
        const planConfig = PLAN_CONFIG_BY_AMOUNT[amountRupees];
        if (!planConfig) return res.status(400).json({ success: false, message: 'Invalid plan amount.' });

        const planType = planConfig.type;
        const planDurationMs = planConfig.durationMs;
        const receipt = generateReceipt();
        const razorpay = getRazorpay();

        // Critical path: call Razorpay with a bounded wait, but do not place a
        // Firestore write between order creation and returning checkout details.
        const order = await withTimeout(razorpay.orders.create({
            amount: amountRupees * 100,
            currency: 'INR',
            receipt,
            partial_payment: false,
            notes: { app: 'Driver Ride Picker', phone, planType, planDurationMs: String(planDurationMs) }
        }), 12000, 'Razorpay order creation');

        if (!order?.id || Number(order.amount) !== amountRupees * 100 || String(order.currency).toUpperCase() !== 'INR') {
            throw new Error('Razorpay returned incomplete order details.');
        }

        // Firestore is intentionally deferred until signed payment verification
        // or a signed webhook. The record is reconstructed from Razorpay's own
        // order notes, amount and currency before any plan can be activated.
        console.info('RAZORPAY_CHECKOUT_READY', { elapsedMs: Date.now() - startedAt });
        return res.json({ success: true, keyId: process.env.RAZORPAY_KEY_ID, orderId: order.id, amount: order.amount, currency: order.currency, planType, planDurationMs });
    } catch (error) {
        console.error('RAZORPAY CREATE ORDER ERROR:', error.message || error);
        const timedOut = /timed out/i.test(String(error.message || ''));
        return res.status(timedOut ? 504 : 502).json({ success: false, message: timedOut ? 'Razorpay is taking too long to respond. Please retry once; no payment has been started.' : (error.message || 'Unable to create Razorpay order.') });
    }
});

app.post('/api/payment/verify', verifyFirebaseToken, async (req, res) => {
    try {
        const phone = getAuthenticatedPhone(req);
        const orderId = String(req.body.orderId || '').trim();
        const paymentId = String(req.body.paymentId || '').trim();
        const signature = String(req.body.signature || '').trim();
        if (!phone || !orderId || !paymentId || !signature) return res.status(400).json({ success: false, message: 'Payment data incomplete.' });

        if (!verifyRazorpaySignature(orderId, paymentId, signature)) return res.status(400).json({ success: false, message: 'Invalid signature.' });

        const orderRef = getDB().collection('paymentOrders').doc(orderId);
        const orderSnapshot = await orderRef.get();
        let orderData = orderSnapshot.exists ? (orderSnapshot.data() || {}) : null;
        if (orderData && normalizePhone(orderData.phone) !== phone) return res.status(403).json({ success: false, message: 'Payment order mismatch.' });
        if (orderData?.status === 'paid') return res.json({ success: true, alreadyProcessed: true, planType: orderData.planType || PLAN_TYPE_NONE, planExpiry: Number(orderData.planExpiry || 0), message: 'Payment already processed.' });

        let payment;
        try {
            payment = await withTimeout(getRazorpay().payments.fetch(paymentId), 12000, 'Razorpay payment verification');
        } catch (fetchError) {
            console.error('RAZORPAY PAYMENT FETCH ERROR:', fetchError.message || fetchError);
            return res.status(503).json({ success: false, pending: true, message: 'Payment verification is temporarily delayed. Please check payment status again; do not pay twice.' });
        }

        if (String(payment.order_id || '') !== orderId) return res.status(400).json({ success: false, message: 'Payment order ID mismatch.' });
        const paymentStatus = String(payment.status || '').toLowerCase();
        const paymentAmount = Number(payment.amount || 0);
        if (paymentStatus !== 'captured' && paymentStatus !== 'authorized') return res.status(400).json({ success: false, message: `Payment not successful. Status: ${paymentStatus || 'unknown'}` });

        // If the fast checkout path did not create a Firestore document yet,
        // rebuild it from the provider order's signed notes and verify ownership.
        if (!orderData) {
            try {
                orderData = await ensureRazorpayOrderRecord(orderId, phone);
            } catch (recoveryError) {
                console.error('RAZORPAY ORDER RECOVERY ERROR:', recoveryError.message || recoveryError);
                return res.status(503).json({ success: false, pending: true, message: 'Payment received. Order details are being verified; do not pay again. Please check your plan status shortly.' });
            }
        }

        if (paymentAmount && Number(orderData.amountPaise) && paymentAmount !== Number(orderData.amountPaise)) return res.status(400).json({ success: false, message: 'Payment amount mismatch.' });

        const result = await processPlanActivation(orderId, paymentId, 'RAZORPAY');
        return res.json({ success: true, alreadyProcessed: false, planType: result.planType, planExpiry: result.planExpiry, planExpiryIso: new Date(result.planExpiry).toISOString(), message: `${result.planType} plan activated successfully.` });
    } catch (error) {
        console.error('RAZORPAY PAYMENT VERIFY ERROR:', error.message || error);
        return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Unable to verify payment.' });
    }
});

app.post('/api/telegram/webhook', (req, res) => { return res.status(200).send('OK'); });

module.exports = app;
