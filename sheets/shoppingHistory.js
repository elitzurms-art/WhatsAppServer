// sheets/shoppingHistory.js
// In-memory history (20 turns/phone, TTL 30 דק') + ארכיון לטאב "היסטוריית שיחה" בגיליון הקניות.
// אותה תבנית של conversationHistory.js, אבל מבודד לשיחות בוט הקניות.
const { normalizePhone } = require('./helpers');
const { ensureHistorySheet } = require('./shopping');

const HISTORY_TTL_MS = 30 * 60 * 1000;
const MAX_TURNS_IN_MEMORY = 20;
const MAX_CONTENT_CHARS = 2000;

const history = {}; // { phone: { turns, timeout } }

function resetTtl(p) {
    if (history[p].timeout) clearTimeout(history[p].timeout);
    history[p].timeout = setTimeout(() => {
        delete history[p];
        console.log(`[ShoppingHistory] cleared (TTL) for ${p}`);
    }, HISTORY_TTL_MS);
}

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
        console.error('❌ shopping history archive error:', err.message)
    );
}

async function archive(phone, role, content, state, userName) {
    const sheet = await ensureHistorySheet();
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
        console.log(`[ShoppingHistory] cleared for ${p}`);
    }
}

module.exports = { appendTurn, getRecentHistory, clearHistory };
