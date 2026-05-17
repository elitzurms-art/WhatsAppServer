// conversationHistory.js
// Hybrid: in-memory לאחזור מהיר (20 תורות אחרונות, TTL 30 דק') + ארכיון מלא לטאב בשיטס.
const { getDoc, normalizePhone } = require('./helpers');

const HISTORY_TTL_MS = 30 * 60 * 1000;
const MAX_TURNS_IN_MEMORY = 20;
const MAX_CONTENT_CHARS = 2000;

const history = {}; // { phone: { turns: [{role, content, timestamp}], timeout } }

const SHEET_TITLE = 'היסטוריית שיחה';
const HEADERS = ['חותמת זמן', 'טלפון', 'שם', 'תפקיד', 'מצב', 'תוכן'];
let sheetPromise = null;

async function ensureSheet() {
    if (sheetPromise) return sheetPromise;
    sheetPromise = (async () => {
        const doc = await getDoc();
        let sheet = doc.sheetsByTitle[SHEET_TITLE];
        if (!sheet) {
            sheet = await doc.addSheet({ title: SHEET_TITLE, headerValues: HEADERS });
            console.log(`📝 נוצר טאב חדש: "${SHEET_TITLE}"`);
        } else {
            try {
                await sheet.loadHeaderRow();
                if (!sheet.headerValues || sheet.headerValues.length === 0) {
                    await sheet.setHeaderRow(HEADERS);
                }
            } catch {
                await sheet.setHeaderRow(HEADERS);
            }
        }
        return sheet;
    })().catch(err => {
        console.error('❌ history ensureSheet error:', err.message);
        sheetPromise = null;
        throw err;
    });
    return sheetPromise;
}

function resetTtl(p) {
    if (history[p].timeout) clearTimeout(history[p].timeout);
    history[p].timeout = setTimeout(() => {
        delete history[p];
        console.log(`[History] cleared (TTL) for ${p}`);
    }, HISTORY_TTL_MS);
}

/**
 * מוסיף תור לזיכרון + מתזמן כתיבה לארכיון (לא חוסם).
 * role: 'user' | 'bot'
 */
function appendTurn(phone, role, content, state = '', userName = '') {
    if (!content) return;
    const p = normalizePhone(phone);
    if (!p) return;

    const text = String(content).slice(0, MAX_CONTENT_CHARS);

    if (!history[p]) history[p] = { turns: [] };
    history[p].turns.push({ role, content: text, timestamp: Date.now() });
    if (history[p].turns.length > MAX_TURNS_IN_MEMORY) {
        history[p].turns.shift();
    }
    resetTtl(p);

    archive(p, role, text, state, userName).catch(err =>
        console.error('❌ history archive error:', err.message)
    );
}

async function archive(phone, role, content, state, userName) {
    const sheet = await ensureSheet();
    await sheet.addRow({
        'חותמת זמן': new Date().toISOString(),
        'טלפון': phone,
        'שם': userName || '',
        'תפקיד': role,
        'מצב': state || '',
        'תוכן': content
    });
}

function getRecentHistory(phone, limit = 10) {
    const p = normalizePhone(phone);
    if (!history[p]) return [];
    return history[p].turns.slice(-limit);
}

function clearHistory(phone) {
    const p = normalizePhone(phone);
    if (history[p]) {
        if (history[p].timeout) clearTimeout(history[p].timeout);
        delete history[p];
        console.log(`[History] cleared for ${p}`);
    }
}

module.exports = { appendTurn, getRecentHistory, clearHistory };
