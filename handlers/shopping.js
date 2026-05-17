// handlers/shopping.js
// Free-chat-first handler לבוט הקניות.
// States: SHOPPING_CHAT (main loop), SHOPPING_CLEAR_CONFIRM (אישור איפוס).
const shoppingList = require('../sheets/shopping');
const shoppingHistory = require('../sheets/shoppingHistory');
const sessions = require('../sheets/sessions');
const { runShoppingChat } = require('../ai/shoppingChat');
const { normalizePhone } = require('../sheets/helpers');

function formatListForUser(items) {
    if (!items.length) return '🛒 הרשימה ריקה כרגע.';
    const lines = items.map(it => {
        const qty = it.quantity ? ` (${it.quantity})` : '';
        const who = it.addedBy ? ` — ${it.addedBy}` : '';
        return `• ${it.name}${qty}${who}`;
    });
    return `🛒 *רשימת הקניות הפעילה:*\n${lines.join('\n')}`;
}

async function handleShoppingChat(client, msg, phone, userName) {
    const from = msg.from;
    const text = msg.body?.trim();
    if (!text) return;

    // טוענים את הרשימה הפעילה כקונטקסט ל-AI
    let activeItems = [];
    try {
        activeItems = await shoppingList.getActiveItems();
    } catch (e) {
        console.error('❌ shopping chat load failed:', e.message);
    }

    // שומרים סשן SHOPPING_CHAT לפני הקריאה ל-AI
    await sessions.saveSession(phone, 'SHOPPING_CHAT', '');

    const history = shoppingHistory.getRecentHistory(phone, 10);
    const result = await runShoppingChat({ text, history, activeItems, userName });

    if (!result) {
        const fallback = 'מצטער, לא הצלחתי להבין. אפשר לנסח שוב?';
        await client.sendMessage(from, fallback);
        shoppingHistory.appendTurn(phone, 'bot', fallback, 'SHOPPING_CHAT', userName);
        return;
    }

    if (result.tool === 'answer_question') {
        const reply = result.input?.text || 'מצטער, לא הצלחתי לנסח תשובה.';
        await client.sendMessage(from, reply);
        shoppingHistory.appendTurn(phone, 'bot', reply, 'SHOPPING_CHAT', userName);
        return;
    }

    if (result.tool === 'view_list') {
        const reply = formatListForUser(activeItems);
        await client.sendMessage(from, reply);
        shoppingHistory.appendTurn(phone, 'bot', reply, 'SHOPPING_CHAT', userName);
        return;
    }

    if (result.tool === 'add_items') {
        const items = Array.isArray(result.input?.items) ? result.input.items : [];
        const cleaned = items.filter(it => it && it.name && String(it.name).trim());
        if (!cleaned.length) {
            const reply = 'לא זיהיתי איזה פריט להוסיף. אפשר לנסח שוב?';
            await client.sendMessage(from, reply);
            shoppingHistory.appendTurn(phone, 'bot', reply, 'SHOPPING_CHAT', userName);
            return;
        }
        try {
            const added = await shoppingList.addItems(cleaned, userName, phone);
            const names = cleaned.map(it => it.quantity ? `${it.name} (${it.quantity})` : it.name).join(', ');
            const reply = `✅ הוספתי: ${names}`;
            await client.sendMessage(from, reply);
            shoppingHistory.appendTurn(phone, 'bot', reply, 'SHOPPING_CHAT', userName);
        } catch (err) {
            console.error('❌ addItems error:', err.message);
            const reply = '❌ הייתה תקלה בכתיבה לרשימה. נסה שוב בעוד כמה שניות.';
            await client.sendMessage(from, reply);
            shoppingHistory.appendTurn(phone, 'bot', reply, 'SHOPPING_CHAT', userName);
        }
        return;
    }

    if (result.tool === 'remove_items') {
        const idx = Array.isArray(result.input?.row_indices) ? result.input.row_indices.map(Number).filter(n => !isNaN(n)) : [];
        if (!idx.length) {
            const reply = 'לא זיהיתי איזה פריט להסיר. נסה לפי שם או תכתוב "מה ברשימה" כדי לראות.';
            await client.sendMessage(from, reply);
            shoppingHistory.appendTurn(phone, 'bot', reply, 'SHOPPING_CHAT', userName);
            return;
        }
        try {
            // שמירת שמות לפני העדכון להצגה למשתמש
            const removedNames = activeItems
                .filter(it => idx.includes(it.rowIndex))
                .map(it => it.name);
            const count = await shoppingList.markBought(idx, userName);
            if (count === 0) {
                const reply = 'לא נמצאו פריטים פעילים בשורות האלה.';
                await client.sendMessage(from, reply);
                shoppingHistory.appendTurn(phone, 'bot', reply, 'SHOPPING_CHAT', userName);
                return;
            }
            const reply = `✅ סימנתי כנקנה: ${removedNames.length ? removedNames.join(', ') : `${count} פריטים`}`;
            await client.sendMessage(from, reply);
            shoppingHistory.appendTurn(phone, 'bot', reply, 'SHOPPING_CHAT', userName);
        } catch (err) {
            console.error('❌ markBought error:', err.message);
            const reply = '❌ הייתה תקלה בעדכון. נסה שוב.';
            await client.sendMessage(from, reply);
            shoppingHistory.appendTurn(phone, 'bot', reply, 'SHOPPING_CHAT', userName);
        }
        return;
    }

    if (result.tool === 'clear_list_request') {
        if (!activeItems.length) {
            const reply = '🛒 הרשימה כבר ריקה.';
            await client.sendMessage(from, reply);
            shoppingHistory.appendTurn(phone, 'bot', reply, 'SHOPPING_CHAT', userName);
            return;
        }
        await sessions.saveSession(phone, 'SHOPPING_CLEAR_CONFIRM', '');
        const reply = `⚠️ לאפס את כל הרשימה (${activeItems.length} פריטים)? כתוב "כן" לאישור או "לא" לביטול.`;
        await client.sendMessage(from, reply);
        shoppingHistory.appendTurn(phone, 'bot', reply, 'SHOPPING_CLEAR_CONFIRM', userName);
        return;
    }

    if (result.tool === 'end_chat') {
        const bye = 'בכיף 😊';
        await client.sendMessage(from, bye);
        shoppingHistory.appendTurn(phone, 'bot', bye, 'SHOPPING_CHAT', userName);
        await sessions.clearSession(phone);
        shoppingHistory.clearHistory(phone);
        return;
    }

    // כלי לא צפוי
    const fb = 'מצטער, התבלבלתי. נסה לנסח אחרת.';
    await client.sendMessage(from, fb);
    shoppingHistory.appendTurn(phone, 'bot', fb, 'SHOPPING_CHAT', userName);
}

/* ===================== אישור איפוס ===================== */
async function handleShoppingClearConfirm(client, msg, phone, userName) {
    const from = msg.from;
    const text = (msg.body || '').trim();

    const YES_RE = /^(כן|אישור|אשר|בטח|אוקיי|אוקי|yes|y|ok|תאפס|תאפסי|אפס)\s*[!.?]*$/i;
    const NO_RE = /^(לא|ביטול|תבטל|בטל|תשכח|no|n)\s*[!.?]*$/i;

    if (YES_RE.test(text)) {
        try {
            const count = await shoppingList.clearActiveList(userName);
            const reply = `✅ אופסה הרשימה (${count} פריטים סומנו כנקנה).`;
            await client.sendMessage(from, reply);
            shoppingHistory.appendTurn(phone, 'bot', reply, 'SHOPPING_CLEAR_CONFIRM', userName);
        } catch (err) {
            console.error('❌ clearActiveList error:', err.message);
            const reply = '❌ הייתה תקלה באיפוס. נסה שוב.';
            await client.sendMessage(from, reply);
            shoppingHistory.appendTurn(phone, 'bot', reply, 'SHOPPING_CLEAR_CONFIRM', userName);
        }
        await sessions.saveSession(phone, 'SHOPPING_CHAT', '');
        return;
    }

    if (NO_RE.test(text)) {
        const reply = 'בוטל. הרשימה לא השתנתה.';
        await client.sendMessage(from, reply);
        shoppingHistory.appendTurn(phone, 'bot', reply, 'SHOPPING_CLEAR_CONFIRM', userName);
        await sessions.saveSession(phone, 'SHOPPING_CHAT', '');
        return;
    }

    // לא ברור — מבקשים שוב
    const reply = 'לא הבנתי. תכתוב "כן" כדי לאפס את כל הרשימה, או "לא" לביטול.';
    await client.sendMessage(from, reply);
    shoppingHistory.appendTurn(phone, 'bot', reply, 'SHOPPING_CLEAR_CONFIRM', userName);
}

module.exports = { handleShoppingChat, handleShoppingClearConfirm };
