// =====================================================================
// accounts.js — ניהול ריבוי חשבונות WhatsApp (סשן נפרד לכל משתמש)
//
// כל חשבון = Client נפרד של whatsapp-web.js עם LocalAuth(clientId) משלו.
// חיסכון ב-RAM (השרת עם 1GB בלבד): חשבון מקושר לא רץ כל הזמן —
// הוא עולה על פי דרישה (שליחה / קישור) ונכבה אוטומטית אחרי חוסר פעילות.
// החשבון הראשי (הבוט הקיים ב-bot.js) לא מנוהל כאן ונשאר תמיד דלוק.
// =====================================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Client, LocalAuth } = require('whatsapp-web.js');

const REGISTRY_FILE = path.join(__dirname, 'accounts.json');
const AUTH_DIR = path.join(__dirname, '.wwebjs_auth');
const IDLE_STOP_MS = 5 * 60 * 1000;        // כיבוי אחרי 5 דקות בלי שליחה
const MAX_LIVE_ACCOUNTS = 1;              // כמה סשנים אישיים מותר להריץ במקביל
const READY_TIMEOUT_MS = 90 * 1000;       // המתנה מקסימלית לעליית סשן מקושר

// qrcode אופציונלי — אם לא מותקן, נחזיר רק את המחרוזת בלי תמונה
let QRCode = null;
try { QRCode = require('qrcode'); } catch {}

// ---------- רישום מתמיד ----------

function loadRegistry() {
    try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); }
    catch { return { accounts: {} }; }
}

function saveRegistry(reg) {
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
}

const registry = loadRegistry();

// ---------- מצב ריצה (לא מתמיד) ----------
// id → { client, status, qr, info, idleTimer, readyPromise }
const live = new Map();

const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;

function sanitizeId(id) {
    return VALID_ID.test(String(id || '')) ? String(id) : null;
}

function authDirFor(id) {
    // LocalAuth שומר תחת .wwebjs_auth/session-<clientId>
    return path.join(AUTH_DIR, `session-acct_${id}`);
}

// ---------- מחזור חיים של סשן ----------

// Chrome נועל את תיקיית הסשן. אם התהליך הקודם מת בלי לסגור כמו שצריך
// (קריסה, initialize שנכשל באמצע) — נשארים קובצי Singleton* ולעיתים תהליך
// יתום, וכל ניסיון עלייה הבא נכשל ב-"The browser is already running".
// לכן מנקים לפני כל עלייה של סשן שאינו חי, וגם אחרי כישלון.
function clearStaleSession(id) {
    const dir = authDirFor(id);
    try { execSync(`pkill -9 -f "user-data-dir=${dir}"`, { stdio: 'ignore' }); } catch {}
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
}

function touch(id) {
    const s = live.get(id);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => stopAccount(id).catch(() => {}), IDLE_STOP_MS);
}

async function startAccount(id) {
    id = sanitizeId(id);
    if (!id) throw new Error('invalid-account-id');
    if (!registry.accounts[id]) throw new Error('unknown-account');

    const existing = live.get(id);
    if (existing && existing.status !== 'failed' && existing.status !== 'stopped') {
        touch(id);
        return existing;
    }

    // אין סשן חי לחשבון הזה — לוודא שלא נשארו נעילות/תהליך יתום מריצה קודמת
    clearStaleSession(id);
    await enforceLiveLimit(id);

    const state = { client: null, status: 'starting', qr: null, info: null, idleTimer: null, readyPromise: null };
    live.set(id, state);

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: `acct_${id}` }),
        autoMarkSeen: false,
        puppeteer: {
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-session-crashed-bubble',
                '--disable-gpu',
                '--disable-infobars',
                '--noerrdialogs',
                '--no-first-run',
                '--no-zygote',
                '--lang=en-US',
                // חיסכון בזיכרון — הדרופלט צר, ראה enforceLiveLimit
                '--renderer-process-limit=1',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-breakpad',
                '--disable-crash-reporter',
            ],
        },
    });
    state.client = client;

    state.readyPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ready-timeout')), READY_TIMEOUT_MS);

        client.on('qr', (qr) => {
            state.status = 'qr';
            state.qr = qr;
            // QR נוצר למרות auth שמור = ה-auth כבר לא תקף (נותק מהטלפון / פג).
            // בלי לעדכן את הרישום, הלקוח ממשיך להאמין שהחשבון מקושר,
            // מציג "מחובר" ולא מציע קישור מחדש — והמשתמש תקוע.
            if (registry.accounts[id].linked) {
                registry.accounts[id].linked = false;
                saveRegistry(registry);
                console.log(`⚠️ [acct:${id}] ה-auth השמור לא תקף עוד — סומן כלא מקושר`);
            }
            console.log(`🔗 [acct:${id}] QR חדש נוצר`);
        });

        client.on('authenticated', () => {
            state.status = 'authenticated';
            state.qr = null;
        });

        client.on('ready', () => {
            clearTimeout(timer);
            state.status = 'ready';
            state.qr = null;
            state.info = {
                number: client.info?.wid?.user || null,
                pushname: client.info?.pushname || null,
            };
            registry.accounts[id].linked = true;
            registry.accounts[id].number = state.info.number;
            registry.accounts[id].pushname = state.info.pushname;
            saveRegistry(registry);
            console.log(`✅ [acct:${id}] מוכן (${state.info.number})`);
            resolve();
        });

        client.on('auth_failure', (msg) => {
            clearTimeout(timer);
            state.status = 'failed';
            console.error(`❌ [acct:${id}] auth_failure: ${msg}`);
            reject(new Error('auth-failure'));
        });

        client.on('disconnected', (reason) => {
            console.log(`🔌 [acct:${id}] נותק: ${reason}`);
            // LOGOUT = המשתמש ניתק מהטלפון — הסשן כבר לא תקף
            if (String(reason).toUpperCase().includes('LOGOUT')) {
                registry.accounts[id].linked = false;
                saveRegistry(registry);
            }
            stopAccount(id).catch(() => {});
        });
    });
    // מונע unhandled rejection כשאף אחד לא מחכה ל-readyPromise (למשל בזמן קישור QR)
    state.readyPromise.catch(() => {});

    await client.initialize().catch(async (e) => {
        state.status = 'failed';
        live.delete(id);                        // הניסיון הבא יתחיל מאפס
        try { await client.destroy(); } catch {} // לא להשאיר Chrome יתום
        clearStaleSession(id);
        throw e;
    });

    touch(id);
    return state;
}

// הדרופלט (1GB) כבר מחזיק את ה-Chrome של החשבון הראשי. ב-19/08 סשן אישי
// שעלה לצידו הקפיץ את ה-cgroup מעבר ל-MemorySwapMax, ה-OOM killer הרג את
// השירות ושני הסשנים איבדו את ה-auth שלהם. לכן: סשן אישי אחד בכל רגע.
async function enforceLiveLimit(exceptId) {
    const others = [...live.keys()].filter((k) => k !== exceptId);
    while (others.length >= MAX_LIVE_ACCOUNTS) {
        const victim = others.shift();
        console.log(`♻️ [acct:${victim}] מכובה כדי לפנות זיכרון לסשן אחר`);
        await stopAccount(victim).catch(() => {});
    }
}

async function stopAccount(id) {
    const s = live.get(id);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    live.delete(id);
    try { await s.client?.destroy(); } catch {}
    console.log(`💤 [acct:${id}] סשן כובה (auth נשמר)`);
}

// ---------- API ציבורי של המודול ----------

function listAccounts() {
    return Object.entries(registry.accounts).map(([id, meta]) => {
        const s = live.get(id);
        return {
            id,
            label: meta.label || null,
            linked: !!meta.linked,
            number: meta.number || null,
            pushname: meta.pushname || null,
            status: s ? s.status : (meta.linked ? 'stopped' : 'unlinked'),
        };
    });
}

function getAccount(id) {
    id = sanitizeId(id);
    if (!id || !registry.accounts[id]) return null;
    const meta = registry.accounts[id];
    const s = live.get(id);
    return {
        id,
        label: meta.label || null,
        linked: !!meta.linked,
        number: meta.number || null,
        pushname: meta.pushname || null,
        status: s ? s.status : (meta.linked ? 'stopped' : 'unlinked'),
        qr: s?.qr || null,
    };
}

async function createAccount(id, label) {
    id = sanitizeId(id);
    if (!id) throw new Error('invalid-account-id');
    if (!registry.accounts[id]) {
        registry.accounts[id] = { label: label || null, linked: false, createdAt: new Date().toISOString() };
        saveRegistry(registry);
    } else if (label && registry.accounts[id].label !== label) {
        registry.accounts[id].label = label;
        saveRegistry(registry);
    }
    return registry.accounts[id];
}

async function getQr(id) {
    id = sanitizeId(id);
    if (!id || !registry.accounts[id]) throw new Error('unknown-account');
    let s = live.get(id);
    if (!s || s.status === 'stopped' || s.status === 'failed') s = await startAccount(id);
    if (s.status === 'ready') return { status: 'ready' };
    if (!s.qr) return { status: s.status }; // עדיין נטען — הלקוח יעשה polling
    touch(id);
    const out = { status: 'qr', qr: s.qr };
    if (QRCode) out.imageDataUrl = await QRCode.toDataURL(s.qr, { margin: 2, width: 400 });
    return out;
}

async function ensureReady(id) {
    id = sanitizeId(id);
    if (!id || !registry.accounts[id]) throw new Error('unknown-account');
    if (!registry.accounts[id].linked) throw new Error('not-linked');
    let s = live.get(id);
    if (!s || s.status === 'stopped' || s.status === 'failed') s = await startAccount(id);
    if (s.status !== 'ready') await s.readyPromise;
    touch(id);
    return s.client;
}

async function sendFromAccount(id, chatId, message) {
    const client = await ensureReady(id);
    const sent = await client.sendMessage(chatId, message);
    touch(id);
    return sent;
}

async function logoutAccount(id) {
    id = sanitizeId(id);
    if (!id || !registry.accounts[id]) throw new Error('unknown-account');
    const s = live.get(id);
    if (s?.client) {
        try { await s.client.logout(); } catch {}
    }
    await stopAccount(id);
    // מחיקת קבצי הסשן כדי שקישור הבא יתחיל נקי
    try { fs.rmSync(authDirFor(id), { recursive: true, force: true }); } catch {}
    registry.accounts[id].linked = false;
    registry.accounts[id].number = null;
    registry.accounts[id].pushname = null;
    saveRegistry(registry);
}

async function deleteAccount(id) {
    id = sanitizeId(id);
    if (!id || !registry.accounts[id]) return;
    await logoutAccount(id).catch(() => {});
    delete registry.accounts[id];
    saveRegistry(registry);
}

function runningCount() {
    return [...live.values()].filter((s) => ['starting', 'qr', 'authenticated', 'ready'].includes(s.status)).length;
}

module.exports = {
    listAccounts, getAccount, createAccount, getQr,
    ensureReady, sendFromAccount, logoutAccount, deleteAccount,
    stopAccount, runningCount,
};
