// bot.js
console.log('📦 טוען מודולים...');
require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const { handleMessage } = require('./handlers');
const { getSession } = require('./sheets/sessions');
const { handleReminderResponse } = require('./handlers/reminderResponse');
const { apiSentIds, botSentIds, pendingBotSends } = require('./shared');
console.log('✅ כל המודולים נטענו');


// =======================
// מניעת קריסת התהליך
// =======================
process.on('unhandledRejection', (reason) => {
    if (reason?.message?.includes('Execution context was destroyed')) {
        console.log('⚠️ דף וואטסאפ התרענן, ממתין לטעינה מחדש...');
        return;
    }
    if (reason?.message?.includes('markedUnread')) {
        console.log('⚠️ באג פנימי של WhatsApp Web – דולג');
        return;
    }
    if (reason?.message?.includes('revoked') || reason?.message?.includes('deleted')) {
        console.log('⚠️ הודעה נמחקה באמצע הטיפול – דולג');
        return;
    }
    if (reason?.message?.includes('Message not found')) {
        console.log('⚠️ הודעה לא נמצאה – דולג');
        return;
    }
    // שגיאות רשת/הפעלה ראשונית — יוצאים כדי ש-start.sh ירים מחדש עם cleanup
    const fatalNet = [
        'ERR_INTERNET_DISCONNECTED',
        'ERR_NAME_NOT_RESOLVED',
        'ERR_NETWORK_CHANGED',
        'ERR_PROXY_CONNECTION_FAILED',
        'ERR_CONNECTION_REFUSED',
        'ERR_CONNECTION_TIMED_OUT',
        'browser is already running',
        'Target closed',
        'detached Frame',
        'auth timeout',
        'Authentication failure',
    ];
    if (fatalNet.some(s => reason?.message?.includes(s))) {
        console.error('💥 שגיאת רשת/דפדפן — יוצא לאתחול מלא ע"י start.sh:', reason?.message);
        process.exit(1);
    }
    console.error('💥 שגיאה לא מטופלת:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('💥 שגיאה קריטית:', error.message);
    console.error(error.stack);
});

// =======================
// יצירת לקוח WhatsApp
// =======================
console.log('🔧 יוצר Client...');
const client = new Client({
    authStrategy: new LocalAuth(),

	autoMarkSeen: false,


    puppeteer: {
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
			'--disable-session-crashed-bubble', // מבטל את הודעת ה-"Restore" שראית
            '--disable-gpu',
			'--disable-infobars',               // מבטל סרגלי התראות
            '--noerrdialogs',                   // משתיק דיאלוגים של שגיאות
            '--no-first-run',
            '--no-zygote',
            '--lang=en-US'
        ],
    },
});
console.log('✅ Client נוצר בהצלחה');

// עטיפת client.sendMessage כדי לעקוב אחר הודעות שהבוט שולח (לסינון message_create בקבוצות).
// משתמשים ב-pendingBotSends (chat_id:body) שמסומן *לפני* השליחה — שובר race עם message_create.
// בנוסף, רושמים את ה-ID ל-botSentIds אחרי שהוא ידוע (כגיבוי).
const _origSendMessage = client.sendMessage.bind(client);
client.sendMessage = async (...args) => {
    const [chatId, content] = args;
    const bodyStr = typeof content === 'string' ? content : (content?.body || '');
    const pendKey = bodyStr ? `${chatId}::${bodyStr}` : null;
    if (pendKey) {
        pendingBotSends.set(pendKey, Date.now());
        // ניקוי אחרי 30 שניות
        setTimeout(() => pendingBotSends.delete(pendKey), 30 * 1000);
    }
    const sent = await _origSendMessage(...args);
    try {
        const id = sent?.id?._serialized;
        if (id) {
            botSentIds.add(id);
            setTimeout(() => botSentIds.delete(id), 60 * 1000);
        }
    } catch {}
    return sent;
};

// =======================
// QR
// =======================
client.on('qr', (qr) => {
    console.log('סרוק את קוד ה-QR הבא:');
    qrcode.generate(qr, { small: true });
});

let readyWatchdog = null;
client.on('authenticated', () => {
    console.log('🔐 Authenticated!');
    // אם ready לא נורה תוך 3 דקות — יוצאים כדי ש-start.sh יפעיל מחדש עם cleanup
    if (readyWatchdog) clearTimeout(readyWatchdog);
    readyWatchdog = setTimeout(() => {
        console.error('💥 ready לא נורה תוך 3 דקות אחרי authenticated — יוצא לאתחול מלא');
        process.exit(1);
    }, 3 * 60 * 1000);
});

client.on('auth_failure', (msg) => {
    console.log('❌ Auth failure:', msg);
});

client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Loading ${percent}% - WhatsApp`);
});

client.on('change_state', (state) => {
    console.log('🔄 State changed to:', state);

    // אם נכנס למצב לא מחובר - אתחול מחדש
    if (state === 'CONFLICT' || state === 'UNLAUNCHED' || state === 'TIMEOUT') {
        console.log('⚠️ Bad state detected, restarting...');
        if (healthCheckInterval) clearInterval(healthCheckInterval);
        process.exit(1);
    }
});


// =======================
// Ready + Health Check
// =======================
let lastMessageTime = Date.now();
let healthCheckInterval = null;
let servicesStarted = false;

// שרת ה-API עולה מיד עם התהליך ולא מתוך 'ready': נתיבי /accounts (החשבונות
// האישיים של משתמשי הלו"ז) לא נשענים על הסשן הראשי, ואם הוא נפל או ממתין
// לסריקת QR — אסור שכל ה-API ייפול איתו. הנתיבים של החשבון הראשי יחזירו
// שגיאה עד שהוא יהיה ready, אבל השרת עצמו מאזין.
let apiServerStarted = false;
function startApiServerOnce() {
    if (apiServerStarted) return;
    if (!process.env.API_KEY) return;   // אופציונלי — רק אם הוגדר מפתח
    apiServerStarted = true;
    const { createApiServer } = require('./api-server');
    createApiServer(client);
    console.log('🌐 API Server started for Apps Script integration');
}

client.on('ready', () => {
    console.log('✅ Bot is ready!');
    if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }

    if (!servicesStarted) {
        servicesStarted = true;

        // שרת ה-API כבר עלה לפני initialize — כאן רק ה-bridge שדורש סשן ראשי חי
        startApiServerOnce();

        // הפעלת Chat App Bridge (אם מוגדר)
        if (process.env.CHAT_APP_URL) {
            const { initBridge } = require('./chat-bridge');
            initBridge(client);
            console.log('🌉 Chat App Bridge initialized');
        }
    } else {
        console.log('⚠️ ready נורה שוב - דולג על הפעלת שירותים (כבר פעילים)');
    }

    // הפעלת health check כל 2 דקות
    if (healthCheckInterval) clearInterval(healthCheckInterval);

    healthCheckInterval = setInterval(async () => {
        const now = Date.now();
        const timeSinceLastMessage = now - lastMessageTime;

        // אם עברו 5 דקות בלי הודעות - בדיקת סטטוס
        if (timeSinceLastMessage > 5 * 60 * 1000) {
            try {
                const state = await client.getState();
                console.log(`💓 Health check - State: ${state}, Last message: ${Math.floor(timeSinceLastMessage / 1000)}s ago`);

                // אם הסטטוס לא CONNECTED - ניסיון reconnect
                if (state !== 'CONNECTED') {
                    console.log('⚠️ Not connected! Attempting to restart...');
                    clearInterval(healthCheckInterval);
                    process.exit(1); // יאתחל מחדש
                }
            } catch (err) {
                console.log('❌ Health check failed:', err.message);
                console.log('🔄 Restarting...');
                clearInterval(healthCheckInterval);
                process.exit(1);
            }
        } else {
            console.log(`💓 Health check OK - Last message: ${Math.floor(timeSinceLastMessage / 1000)}s ago`);
        }
    }, 2 * 60 * 1000); // כל 2 דקות
});


// =======================
// Disconnected
// =======================
client.on('disconnected', (reason) => {
    console.log('⚠️ נותק:', reason);
    if (healthCheckInterval) clearInterval(healthCheckInterval);
    console.log('🔄 מאתחל מחדש...');
    process.exit(1); // תן ל-PM2 / nodemon להרים מחדש
});

// =======================
// הודעות שנמחקו
// =======================
client.on('message_revoke_everyone', async (msg, revoked_msg) => {
    console.log('🗑️ הודעה נמחקה על ידי השולח:', revoked_msg?.from || 'unknown');
});

client.on('message_revoke_me', async (msg) => {
    console.log('🗑️ הודעה נמחקה עבורי:', msg?.from || 'unknown');
});

// =======================
// הודעות נכנסות
// =======================

const SHOPPING_GROUP_ID = process.env.SHOPPING_GROUP_ID || '120363425150426466@g.us';

client.on('message', async (msg) => {
    // עדכון זמן הודעה אחרונה
    lastMessageTime = Date.now();

    // 1. חומת אש
    const isShoppingGroup = msg.from === SHOPPING_GROUP_ID;
    const isOtherGroup = msg.from?.endsWith('@g.us') && !isShoppingGroup;
    if (!msg || msg.fromMe || !msg.from || isOtherGroup || msg.from.endsWith('@broadcast') || (!msg.body && msg.type !== 'buttons_response')) {
		console.log('⛔ msg or body missing');
        return;
    }

    // התעלמות מהודעות שנמחקו
    if (msg.type === 'revoked' || msg.isRevoked) {
        console.log('🗑️ הודעה נמחקה - מתעלם');
        return;
    }

    const { normalizePhone } = require('./sheets/helpers');

    // קבלת מספר הטלפון הנכון מ-contact.number
    const contact = await msg.getContact();
    const phoneNumber = contact.number;
    const phone = normalizePhone(phoneNumber);

    // 2. קבלת סשן — בקבוצת קניות הסשן משותף לכל המשתתפים, נשמר לפי group ID
    const sessionKey = isShoppingGroup ? SHOPPING_GROUP_ID : phone;
    const session = await getSession(sessionKey);

    // 3. ניתוב לפי מצב הסשן (טריגר ו-FREE_CHAT נבדקים בתוך handleMessage)
    try {
        // א. סשן תזכורת — נשמר מסלול ייעודי
        if (session && session.state === 'REMINDER_PENDING') {
            await handleReminderResponse(client, msg, phone);
        }
        // ב. כל מצב אחר (כולל אין-סשן) — handleMessage מטפל:
        //    - טריגר → startSession
        //    - אין-טריגר ואין-סשן → FREE_CHAT (אם GEMINI_API_KEY מוגדר)
        //    - סשן פעיל → state machine + rescue
        else {
            await handleMessage(client, msg, session);
        }
    } catch (err) {
        // טיפול בשגיאות שעלולות לקרות כאשר הודעה נמחקת באמצע הטיפול
        if (err.message?.includes('revoked') ||
            err.message?.includes('deleted') ||
            err.message?.includes('Message not found')) {
            console.log('⚠️ הודעה נמחקה באמצע הטיפול - מתעלם');
            return;
        }
        // שגיאות אחרות - להעלות הלאה
        console.error('❌ שגיאה בטיפול בהודעה:', err);
        throw err;
    }
});


// =======================
// הודעות של משה עצמו לקבוצת הקניות — message_create כדי לתפוס fromMe
// =======================
client.on('message_create', async (msg) => {
    if (!msg.fromMe) return;
    // בהודעות fromMe: msg.from הוא ה-WID של השולח (משה), msg.to הוא היעד (הקבוצה).
    if (msg.to !== SHOPPING_GROUP_ID) return;
    if (!msg.body && msg.type !== 'buttons_response') return;

    // סינון הודעות שהבוט עצמו שלח: קודם לפי body (race-safe), אחר כך לפי ID.
    const pendKey = `${msg.to}::${msg.body || ''}`;
    if (pendingBotSends.has(pendKey)) {
        pendingBotSends.delete(pendKey);
        return;
    }
    if (botSentIds.delete(msg.id._serialized)) return;
    if (apiSentIds.delete(msg.id._serialized)) return;

    // משווים את msg.from לערך ה-chat ID של הקבוצה כדי שהראוטינג ב-handlers/index.js
    // והשליחה חזרה (client.sendMessage(msg.from)) יזהו את היעד הנכון.
    msg.from = SHOPPING_GROUP_ID;

    try {
        const session = await getSession(SHOPPING_GROUP_ID);
        await handleMessage(client, msg, session);
    } catch (err) {
        console.error('❌ שגיאה בטיפול בהודעת קבוצת קניות (משה):', err.message);
    }
});

// =======================
// העברת הקלטות ← אליעזר ← קלוד קוד
// =======================
const ELIEZER_CHAT_ID    = '972559571223@c.us';
const ELIEZER_LID        = '158360343175264@lid';
const CLAUDE_CODE_GROUP  = '120363425634481122@g.us';
const ELIEZER_REPLY_WINDOW_MS = 2 * 60 * 1000; // 2 דקות

let lastForwardedToEliezerAt = 0;

// שלב 1: הקלטה לעצמי → מעביר לאליעזר
client.on('message_create', async (msg) => {
    if (!msg.fromMe) return;
    if (msg.from !== msg.to) return;
    if (!['audio', 'ptt', 'voice'].includes(msg.type)) return;
    if (apiSentIds.delete(msg.id._serialized)) return; // הודעה שנשלחה ע"י ה-API — דלג

    console.log(`🎙️ הקלטה עצמית (${msg.type}), מעביר לאליעזר...`);
    try {
        const chat = await client.getChatById(ELIEZER_CHAT_ID);
        await msg.forward(chat);
        lastForwardedToEliezerAt = Date.now();
        console.log('✅ הועבר לאליעזר');
    } catch (err) {
        console.error('❌ שגיאה בהעברה לאליעזר:', err.message);
    }
});

// שלב 2: תשובה מאליעזר תוך 2 דקות → מעביר לקלוד קוד
client.on('message', async (msg) => {
    if (msg.fromMe) return;
    if (lastForwardedToEliezerAt === 0) return;
    if (Date.now() - lastForwardedToEliezerAt > ELIEZER_REPLY_WINDOW_MS) return;

    const isFromEliezer = msg.from === ELIEZER_CHAT_ID || msg.from === ELIEZER_LID;
    if (!isFromEliezer) return;

    console.log('📝 תמלול מאליעזר התקבל, מעביר לקלוד קוד...');
    lastForwardedToEliezerAt = 0;
    try {
        const group = await client.getChatById(CLAUDE_CODE_GROUP);
        await msg.forward(group);
        console.log('✅ הועבר לקלוד קוד');
    } catch (err) {
        console.error('❌ שגיאה בהעברה לקלוד קוד:', err.message);
    }
});


// =======================
// Start
// =======================
console.log('🚀 מתחיל להפעיל את הבוט...');
startApiServerOnce();
client.initialize();
