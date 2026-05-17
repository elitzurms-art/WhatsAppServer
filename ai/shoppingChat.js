// ai/shoppingChat.js
// Free-chat לבוט הקניות. משתמש ב-GEMINI_API_KEY_SHOPPING (עם fallback ל-GEMINI_API_KEY).
// 5 כלים: add_items, remove_items, view_list, clear_list_request, end_chat, answer_question.
require('dotenv').config();
const { GoogleGenAI, Type, FunctionCallingConfigMode } = require('@google/genai');

const MODEL = 'gemini-2.5-flash';
const MAX_TOKENS = 1024;
const TIMEOUT_MS = 15_000;

let client = null;
function getClient() {
    if (client) return client;
    const key = process.env.GEMINI_API_KEY_SHOPPING || process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY_SHOPPING (or GEMINI_API_KEY) is not set in .env');
    client = new GoogleGenAI({ apiKey: key });
    return client;
}

const FN_DEFS = {
    add_items: {
        name: 'add_items',
        description: 'הוספת פריט/ים חדשים לרשימת הקניות. השתמש בזה כשהמשתמש רוצה להוסיף ("תוסיף חלב", "צריך לקנות לחם וגבינה", "תרשום ביצים — תריסר").',
        parameters: {
            type: Type.OBJECT,
            properties: {
                items: {
                    type: Type.ARRAY,
                    description: 'רשימת פריטים להוספה. שם הפריט בעברית רגילה (בלי אימוג\'י בשם). כמות ואימוג\'י אופציונליים.',
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            name: { type: Type.STRING, description: 'שם הפריט (טקסט נקי, ללא אימוג\'י)' },
                            quantity: { type: Type.STRING, description: 'כמות אם צוינה (לדוגמה "2", "תריסר", "1 ק"ג"). השאר ריק אם לא צוין.' },
                            emoji: { type: Type.STRING, description: 'אימוג\'י יחיד שמתאים לפריט (חלב→🥛, ביצים→🥚, לחם→🍞, עוף→🐔, גבינה→🧀, תפוח→🍎, שמן→🛢️). אם אין אימוג\'י מתאים, החזר 🛒.' }
                        },
                        required: ['name']
                    }
                }
            },
            required: ['items']
        }
    },
    remove_items: {
        name: 'remove_items',
        description: 'סימון פריט/ים כ"נקנה". המשתמש אומר "קניתי X" / "תמחק Y" / "הסר Z מהרשימה". השתמש במספרים שראית ברשימה הפעילה.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                row_indices: {
                    type: Type.ARRAY,
                    description: 'מספרי השורה בגיליון (rowIndex) של הפריטים להסיר. רק שורות שראית ברשימה הפעילה.',
                    items: { type: Type.NUMBER }
                }
            },
            required: ['row_indices']
        }
    },
    view_list: {
        name: 'view_list',
        description: 'הצגת הרשימה הפעילה למשתמש. השתמש בזה כשמבקש "מה ברשימה?" / "תראה לי" / "מה צריך לקנות?".',
        parameters: { type: Type.OBJECT, properties: {} }
    },
    clear_list_request: {
        name: 'clear_list_request',
        description: 'בקשה לאיפוס הרשימה כולה (סימון כל הפעילים כ"נקנה"). כשהמשתמש אומר "קניתי הכל" / "תאפס הכל" / "סיימתי קניות". פעולה הרסנית — הבוט יבקש אישור מהמשתמש לפני ביצוע.',
        parameters: { type: Type.OBJECT, properties: {} }
    },
    end_chat: {
        name: 'end_chat',
        description: 'המשתמש סיים את השיחה (תודה, ביי, סבבה).',
        parameters: { type: Type.OBJECT, properties: {} }
    },
    answer_question: {
        name: 'answer_question',
        description: 'תשובה חופשית כשאין פעולה ספציפית (שיחה, שאלה, הבהרה).',
        parameters: {
            type: Type.OBJECT,
            properties: {
                text: { type: Type.STRING, description: 'תשובה בעברית טבעית' }
            },
            required: ['text']
        }
    }
};

const TOOL_NAMES = Object.keys(FN_DEFS);

function buildSystemInstruction() {
    return [
        'אתה בוט ניהול רשימת קניות משפחתית (משה, אשתו, וילדה). כל בני הבית יכולים להוסיף ולסמן פריטים.',
        '',
        '## הפעולות הזמינות:',
        '- add_items — הוספה לרשימה. תזהה שם פריט וכמות אם צוינה.',
        '- remove_items — סימון כ"נקנה" לפי מספרי שורה ברשימה הפעילה (rowIndex שראית).',
        '- view_list — להציג למשתמש את הרשימה.',
        '- clear_list_request — איפוס הכול. *פעולה הרסנית* — הבוט יבקש אישור מהמשתמש.',
        '- end_chat — המשתמש סיים.',
        '- answer_question — שיחה/הבהרה/תשובה חופשית.',
        '',
        '## כללים:',
        '1. כל תשובה חייבת לקרוא לאחת הפונקציות. אסור טקסט חופשי בלי function call.',
        '2. עבור add_items: הפרד פריטים ("לחם וגבינה" → 2 פריטים). אם נאמרה כמות, צרף אותה לאותו פריט. תמיד הוסף שדה emoji שמתאים לפריט (אימוג\'י יחיד, fallback 🛒 אם אין מתאים).',
        '3. עבור remove_items: השתמש *רק* ב-rowIndex שראית ברשימה. אם המשתמש אומר "תמחק חלב" ויש שני חלבים — תמחק את כולם או תשאל הבהרה.',
        '4. שיהיה ידידותי, קצר, וטבעי בעברית. תהיה גם נינוח עם משפחה.',
        '5. אם המשתמש שואל מה ברשימה — view_list (הבוט יעצב את הרשימה למשתמש; אתה לא צריך לכתוב אותה).'
    ].join('\n');
}

function formatActiveList(items) {
    if (!items.length) return '(הרשימה ריקה)';
    return items.map(it => {
        const emoji = it.emoji ? `${it.emoji} ` : '';
        const qty = it.quantity ? ` (${it.quantity})` : '';
        const who = it.addedBy ? ` — ${it.addedBy}` : '';
        return `[${it.rowIndex}] ${emoji}${it.name}${qty}${who}`;
    }).join('\n');
}

function buildContextText({ text, history, activeItems, userName }) {
    const parts = [];
    if (userName) parts.push(`## שם המשתמש שכותב כעת: ${userName}`, '');

    parts.push('## הרשימה הפעילה כעת (כל מספר בסוגריים הוא rowIndex לשימוש ב-remove_items):');
    parts.push(formatActiveList(activeItems));
    parts.push('');

    if (history && history.length) {
        parts.push('## היסטוריית שיחה אחרונה:');
        history.forEach(t => parts.push(`${t.role === 'user' ? 'משתמש' : 'בוט'}: ${t.content}`));
        parts.push('');
    }

    parts.push('## הודעת המשתמש הנוכחית:', `"${String(text || '').slice(0, 1000)}"`);
    return parts.join('\n');
}

function withTimeout(promise, ms) {
    let t;
    const timeout = new Promise((_, rej) => {
        t = setTimeout(() => rej(new Error(`shopping chat timed out after ${ms}ms`)), ms);
    });
    return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(t)), timeout]);
}

async function runShoppingChat(ctx) {
    const functionDeclarations = TOOL_NAMES.map(n => FN_DEFS[n]);
    const systemText = buildSystemInstruction();
    const userText = buildContextText(ctx);

    try {
        const api = getClient();
        const call = api.models.generateContent({
            model: MODEL,
            contents: [{ role: 'user', parts: [{ text: userText }] }],
            config: {
                systemInstruction: systemText,
                tools: [{ functionDeclarations }],
                toolConfig: {
                    functionCallingConfig: {
                        mode: FunctionCallingConfigMode.ANY,
                        allowedFunctionNames: TOOL_NAMES
                    }
                },
                temperature: 0.3,
                maxOutputTokens: MAX_TOKENS
            }
        });
        const response = await withTimeout(call, TIMEOUT_MS);
        const fnCall = response.functionCalls?.[0]
            || response.candidates?.[0]?.content?.parts?.find(p => p.functionCall)?.functionCall;
        if (!fnCall) return null;
        return { tool: fnCall.name, input: fnCall.args || {} };
    } catch (err) {
        console.error('❌ runShoppingChat error:', err.message);
        return null;
    }
}

module.exports = { runShoppingChat };
