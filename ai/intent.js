// ai/intent.js
// הוצאת כוונה (intent) מהודעת משתמש באמצעות Google Gemini עם function calling.
// נקרא רק כשהמטפל הקשיח (rigid) לא מצליח לפרש את ההודעה.

require('dotenv').config();
const { GoogleGenAI, Type, FunctionCallingConfigMode } = require('@google/genai');

const MODEL = 'gemini-2.5-flash';
const MAX_TOKENS = 512;
const TIMEOUT_MS = 12_000;

let client = null;
function getClient() {
    if (client) return client;
    if (!process.env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is not set in .env');
    }
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    return client;
}

// ===============================
// הגדרות פונקציות (tools ב-Gemini)
// ===============================
const FN_DEFS = {
    menu_choice: {
        name: 'menu_choice',
        description: 'המשתמש בחר אופציה בתפריט הראשי: שאילה, החזרה/ביטול שריון, שריון, או ביטול.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                choice: {
                    type: Type.STRING,
                    enum: ['borrow', 'return', 'reserve', 'cancel'],
                    description: 'borrow=שאילה, return=החזרה או ביטול שריון, reserve=שריון, cancel=ביטול התהליך'
                }
            },
            required: ['choice']
        }
    },
    select_items: {
        name: 'select_items',
        description: 'המשתמש בחר פריט/ים. אם המשתמש ציין תיאור במקום מספר (למשל "המעיל האדום בגודל L"), זהה את המזהה/ים המתאים/ים מרשימת הפריטים שסופקה לך. החזר רק מזהים בני 3 ספרות שקיימים ברשימה.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                item_ids: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'רשימת מזהי פריטים (3 ספרות) שהמשתמש בחר'
                }
            },
            required: ['item_ids']
        }
    },
    select_all: {
        name: 'select_all',
        description: 'המשתמש רוצה להחזיר את כל הפריטים שלו. משתמשים בזה רק בהחזרה.',
        parameters: { type: Type.OBJECT, properties: {} }
    },
    set_dates: {
        name: 'set_dates',
        description: 'המשתמש ציין תאריכי שריון (התחלה וסיום) בצורה שאינה בפורמט תקני. החזר בפורמט DD/MM/YYYY.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                from_date: { type: Type.STRING, description: 'DD/MM/YYYY' },
                to_date: { type: Type.STRING, description: 'DD/MM/YYYY' }
            },
            required: ['from_date', 'to_date']
        }
    },
    confirm: {
        name: 'confirm',
        description: 'המשתמש אישר את הפעולה (כן, אוקיי, אישור, בסדר, סבבה, בטח, מאשר, כן בבקשה וכו׳).',
        parameters: { type: Type.OBJECT, properties: {} }
    },
    cancel: {
        name: 'cancel',
        description: 'המשתמש מבטל את התהליך הנוכחי (לא, ביטול, עזוב, די, תשכח מזה וכו׳).',
        parameters: { type: Type.OBJECT, properties: {} }
    },
    clarify: {
        name: 'clarify',
        description: 'אין מספיק מידע או שהבקשה דו-משמעית. שאל שאלת הבהרה קצרה בעברית טבעית.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                question: { type: Type.STRING, description: 'שאלת הבהרה קצרה בעברית (משפט אחד)' }
            },
            required: ['question']
        }
    },
    none: {
        name: 'none',
        description: 'ההודעה לא קשורה לתהליך (סתם שיחה / ברכות / הודעה מוטעית שלא אמורה להשפיע). אל תעשה כלום.',
        parameters: { type: Type.OBJECT, properties: {} }
    }
};

const STATE_TOOLS = {
    BORROW_RETURN_SELECT:   ['menu_choice', 'cancel', 'clarify', 'none'],
    BORROW_SELECT:          ['select_items', 'cancel', 'clarify', 'none'],
    RETURN_SELECT:          ['select_items', 'select_all', 'cancel', 'clarify', 'none'],
    RESERVE_SELECT:         ['select_items', 'cancel', 'clarify', 'none'],
    RESERVE_DATE:           ['confirm', 'cancel', 'clarify', 'none'],
    RESERVE_DATES_CONFIRM:  ['set_dates', 'cancel', 'clarify', 'none'],
    BORROW_CONFIRM:         ['confirm', 'cancel', 'clarify', 'none'],
    RETURN_CONFIRM:         ['confirm', 'cancel', 'clarify', 'none'],
    RESERVE_CONFIRM:        ['confirm', 'cancel', 'clarify', 'none']
};

// ===============================
// בניית system instruction
// ===============================
function buildSystemInstruction() {
    return [
        'אתה עוזר הבנה (NLU) לבוט וואטסאפ של "גמ"ח סקי בגולן" — שירות השאלת ציוד סקי (מעילים, מכנסיים, גוגלס, כפפות, נעליים, חרמוניות, קסדות וכו׳).',
        'המשתמשים מתכתבים בעברית, לפעמים עם שגיאות כתיב / סלנג / הודעות חופשיות.',
        '',
        'תפקידך: להבין את כוונת המשתמש במצב הנוכחי של השיחה ולהחזיר קריאת פונקציה (function call) מתאימה.',
        '',
        '## מצבי השיחה:',
        '- BORROW_RETURN_SELECT — המשתמש בתפריט הראשי ובוחר מה לעשות (שאילה / החזרה / שריון / ביטול).',
        '- BORROW_SELECT — המשתמש בוחר פריט/ים לשאול מרשימת הפריטים הזמינים.',
        '- RETURN_SELECT — המשתמש בוחר פריט/ים להחזיר מרשימת הפריטים שלו (יכול גם לבחור את כולם).',
        '- RESERVE_SELECT — המשתמש בוחר פריט/ים לשריין לעתיד.',
        '- RESERVE_DATE — המשתמש מתבקש לאשר התחלה של שלב בחירת תאריכי שריון.',
        '- RESERVE_DATES_CONFIRM — המשתמש נותן 2 תאריכים (התחלה וסיום) לשריון בפורמט DD/MM/YYYY.',
        '- BORROW_CONFIRM / RETURN_CONFIRM / RESERVE_CONFIRM — המשתמש מתבקש לאשר את הפעולה הסופית.',
        '',
        '## כללים:',
        '1. השתמש תמיד באחת הפונקציות שסופקו למצב הנוכחי. אסור לענות בטקסט חופשי בלי function call.',
        '2. אם ההודעה ברורה — קרא לפונקציה המתאימה.',
        '3. אם ההודעה דו-משמעית או חסרה — קרא ל-clarify עם שאלת הבהרה קצרה וטבעית בעברית.',
        '4. אם ההודעה אינה קשורה לתהליך (ברכה / ספאם / טעות) — קרא ל-none.',
        '5. עבור select_items: החזר רק מזהים שקיימים ברשימה שסופקה. אם המשתמש ציין תיאור ("המעיל האדום"), זהה את המזהה לפי הרשימה.',
        '6. עבור set_dates: פענח תאריכים בכל פורמט אפשרי (12.2, "לשבת", "בעוד שבועיים" וכו׳) והחזר DD/MM/YYYY. אם לא ברור — clarify.',
        '7. היה סלחני לשגיאות כתיב ולסלנג. עברית בלבד בתשובות של clarify.',
        '8. קצר ותכליתי. אל תוסיף הסברים.'
    ].join('\n');
}

function buildContextText({ state, inventorySnapshot, sessionPayload, text, history }) {
    const parts = [`## מצב נוכחי: ${state}`];

    if (sessionPayload) {
        parts.push('', '## פריטים שכבר נבחרו בסשן זה:');
        const [idsPart, namesPart] = String(sessionPayload).split('##');
        if (namesPart) {
            parts.push(namesPart.split(' | ').map(n => `- ${n}`).join('\n'));
        } else if (idsPart) {
            parts.push(idsPart);
        }
    }

    if (inventorySnapshot && inventorySnapshot.length) {
        parts.push('', '## רשימת פריטים רלוונטית:');
        inventorySnapshot.forEach(it => {
            parts.push(`- ${it.id}: ${it.name}${it.status && it.status !== 'במלאי' ? ` (${it.status})` : ''}`);
        });
    }

    if (history && history.length) {
        parts.push('', '## היסטוריית שיחה אחרונה (מהישנה לחדשה):');
        history.forEach(t => parts.push(`${t.role === 'user' ? 'משתמש' : 'בוט'}: ${t.content}`));
    }

    parts.push('', '## הודעת המשתמש:', `"${String(text || '').slice(0, 1000)}"`);
    return parts.join('\n');
}

// ===============================
// API call עם timeout
// ===============================
function withTimeout(promise, ms) {
    let t;
    const timeout = new Promise((_, rej) => {
        t = setTimeout(() => rej(new Error(`AI call timed out after ${ms}ms`)), ms);
    });
    return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(t)), timeout]);
}

/**
 * מחלץ כוונה מהודעת משתמש.
 * @returns {Promise<{tool: string, input: object, reasoning?: string}|null>}
 */
async function extractIntent(ctx) {
    const { state } = ctx;
    const toolNames = STATE_TOOLS[state];
    if (!toolNames) return null;

    const functionDeclarations = toolNames.map(n => FN_DEFS[n]);
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
                        allowedFunctionNames: toolNames
                    }
                },
                temperature: 0,
                maxOutputTokens: MAX_TOKENS
            }
        });

        const response = await withTimeout(call, TIMEOUT_MS);

        // gemini מחזיר את ה-function call דרך response.functionCalls (convenience)
        // או דרך response.candidates[0].content.parts[].functionCall
        const fnCall = response.functionCalls?.[0]
            || response.candidates?.[0]?.content?.parts?.find(p => p.functionCall)?.functionCall;

        if (!fnCall) return null;

        const textPart = response.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
        return {
            tool: fnCall.name,
            input: fnCall.args || {},
            reasoning: textPart
        };
    } catch (err) {
        console.error('❌ extractIntent error:', err.message);
        return null;
    }
}

module.exports = { extractIntent, STATE_TOOLS };
