// ai/rescue.js
// גשר בין ה-AI (intent extractor) למטפלים הקשיחים (rigid handlers).
// הרעיון: אם המטפל הקשיח *ודאי* היה מצליח לפרש את ההודעה — עוברים ישר ללא AI.
// אחרת — קוראים ל-AI ומתרגמים את הפלט שלו לטקסט שהמטפל הקשיח כבר יודע לקבל.

const { extractIntent } = require('./intent');
const { logAiInvocation } = require('./learning');

// ===============================
// בדיקת heuristic: האם המטפל הקשיח יצליח?
// ===============================
function rigidWouldAccept(state, text) {
    const t = String(text || '').trim();
    if (!t) return false;

    switch (state) {
        case 'BORROW_RETURN_SELECT': {
            if (/^[1-4]$/.test(t)) return true;
            const exact = ['שאילה', 'החזרה', 'ביטול שריון', 'ביטול שיריון',
                           'החזרה / ביטול שיריון', 'שיריון', 'ביטול'];
            return exact.includes(t);
        }
        case 'BORROW_SELECT':
        case 'RESERVE_SELECT': {
            if (t === 'ביטול') return true;
            // מכיל לפחות מספר בן 3 ספרות
            return /\b\d{3}\b/.test(t);
        }
        case 'RETURN_SELECT': {
            if (t === 'ביטול') return true;
            if (/^(הכול|הכל|כולם|כלם|all)$/i.test(t)) return true;
            return /\b\d{3}\b/.test(t);
        }
        case 'RESERVE_DATE': {
            return t === '1' || t === '2' || t === 'אישור' || t === 'ביטול';
        }
        case 'RESERVE_DATES_CONFIRM': {
            if (t === 'ביטול' || t === '2') return true;
            // 2 תאריכים בפורמט DD/MM/YY(YY)
            const matches = t.match(/\d{1,2}[\/\\.]\d{1,2}[\/\\.]\d{2,4}/g) || [];
            return matches.length >= 2;
        }
        case 'BORROW_CONFIRM':
        case 'RETURN_CONFIRM':
        case 'RESERVE_CONFIRM': {
            return /^(1|2|אישור|ביטול|CONFIRM|CANCEL)$/i.test(t);
        }
        default:
            return false;
    }
}

// ===============================
// תרגום פלט AI לפקודה לבוט
// ===============================
function aiToRigidText(state, tool, input) {
    switch (tool) {
        case 'menu_choice': {
            const map = { borrow: '1', return: '2', reserve: '3', cancel: '4' };
            return map[input.choice] || null;
        }
        case 'select_items': {
            const ids = Array.isArray(input.item_ids) ? input.item_ids.filter(x => /^\d{3}$/.test(x)) : [];
            if (!ids.length) return null;
            return ids.join(',');
        }
        case 'select_all':
            return 'הכול';
        case 'set_dates': {
            if (!input.from_date || !input.to_date) return null;
            return `${input.from_date} עד ${input.to_date}`;
        }
        case 'confirm':
            return 'אישור';
        case 'cancel':
            return 'ביטול';
        default:
            return null;
    }
}

/**
 * מבצע rescue להודעה.
 * @returns {Promise<{action:'passthrough'|'rewrite'|'reply'|'cancel', newText?:string, message?:string}>}
 */
async function rescueMessage({ state, text, phone, userName, inventorySnapshot, sessionPayload, history, source = 'text' }) {
    if (rigidWouldAccept(state, text)) {
        return { action: 'passthrough' };
    }

    const intent = await extractIntent({ state, text, inventorySnapshot, sessionPayload, history });

    if (!intent) {
        // fallback — תן למטפל הקשיח להציג שגיאה כרגיל
        await logAiInvocation({
            phone, userName, state, rawText: text, source,
            aiTool: 'ERROR', finalAction: 'passthrough (AI failed)'
        });
        return { action: 'passthrough' };
    }

    let action;
    let newText = null;
    let message = null;

    switch (intent.tool) {
        case 'clarify':
            message = intent.input?.question || 'לא הבנתי, אפשר לנסח מחדש?';
            action = 'reply';
            break;
        case 'none':
            action = 'passthrough';
            break;
        case 'cancel':
            action = 'cancel';
            break;
        default:
            newText = aiToRigidText(state, intent.tool, intent.input || {});
            if (newText) {
                action = 'rewrite';
            } else {
                // לא הצלחנו לתרגם — הצג הבהרה
                message = 'לא הצלחתי להבין, אפשר לנסח מחדש או להשתמש באפשרויות מהתפריט?';
                action = 'reply';
            }
    }

    await logAiInvocation({
        phone, userName, state, rawText: text, source,
        aiTool: intent.tool,
        aiInput: intent.input,
        finalAction: action === 'rewrite' ? `rewrite → "${newText}"` : action === 'reply' ? `reply → "${(message||'').slice(0,80)}"` : action,
        notes: intent.reasoning?.slice(0, 200) || ''
    });

    return { action, newText, message };
}

module.exports = { rescueMessage, rigidWouldAccept };
