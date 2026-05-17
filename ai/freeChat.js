// ai/freeChat.js
// מצב שיחה חופשי. מאפשר למשתמש לשאול שאלות חופשיות (זמינות, פריטים על שמו, מידע כללי)
// או לבטא כוונה לפעולה ("בא לי להחזיר") כדי לעבור לתהליך הקשיח.
require('dotenv').config();
const { GoogleGenAI, Type, FunctionCallingConfigMode } = require('@google/genai');

const MODEL = 'gemini-2.5-flash';
const MAX_TOKENS = 1024;
const TIMEOUT_MS = 15_000;

let client = null;
function getClient() {
    if (client) return client;
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set in .env');
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    return client;
}

const FN_DEFS = {
    answer_question: {
        name: 'answer_question',
        description: 'תשובה חופשית בעברית טבעית לשאלת המשתמש. מתאים כשהמשתמש שואל מידע, מנהל שיחה, או כשצריך לבקש הבהרה.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                text: {
                    type: Type.STRING,
                    description: 'התשובה הסופית בעברית, ידידותית, תמציתית.'
                }
            },
            required: ['text']
        }
    },
    start_action: {
        name: 'start_action',
        description: 'המשתמש רוצה להתחיל פעולה מוגדרת — שאילה, החזרה/ביטול שריון, או שריון עתידי.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                action: {
                    type: Type.STRING,
                    enum: ['borrow', 'return', 'reserve'],
                    description: 'borrow=שאילה, return=החזרה או ביטול שריון, reserve=שריון לעתיד'
                }
            },
            required: ['action']
        }
    },
    end_chat: {
        name: 'end_chat',
        description: 'המשתמש מסיים את השיחה (תודה, ביי, סבבה, סיימתי וכו׳).',
        parameters: { type: Type.OBJECT, properties: {} }
    }
};

const TOOL_NAMES = Object.keys(FN_DEFS);

function buildSystemInstruction() {
    return [
        'אתה הבוט של "גמ"ח סקי בגולן" — שירות השאלת ציוד סקי קהילתי (מעילים, מכנסיים, גוגלס, כפפות, נעליים, חרמוניות, קסדות).',
        'אתה במצב שיחה חופשי: המשתמש כתב הודעה שאינה פקודה מוגדרת מראש.',
        '',
        '## מה אתה יודע לעשות:',
        '1. לענות על שאלות מידע — מה זמין, מה רשום על המשתמש, איך זה עובד, מה האפשרויות.',
        '2. להציע למשתמש להתחיל תהליך (שאילה / החזרה / שריון) אם הוא מבטא כוונה כזו.',
        '3. לסיים שיחה בנימוס.',
        '',
        '## הפעולות שהמערכת יכולה לבצע (אם תקרא ל-start_action):',
        '- borrow = שאילה: פותח רשימה של פריטים זמינים והמשתמש בוחר מה לקחת.',
        '- return = החזרה או ביטול שריון: מציג את הפריטים שעל שם המשתמש.',
        '- reserve = שריון לעתיד: בחירת פריט + תאריכים (לפחות 3 ימים מהיום, עד 14 יום, עד 3 חודשים קדימה).',
        '',
        '## כללים קריטיים:',
        '- כל תשובה חייבת לעבור דרך אחת משלוש הפונקציות (answer_question / start_action / end_chat). אסור טקסט חופשי בלי function call.',
        '- כשהמשתמש שואל מידע → answer_question.',
        '- כשהמשתמש מבטא כוונה לפעולה ("בא לי לשאול", "אני רוצה להחזיר", "תפתח לי שריון", "כן" בתגובה להצעה שלך) → start_action.',
        '- כשהמשתמש מסיים → end_chat.',
        '- אל תמציא פריטים שלא ברשימת המלאי שסופקה. אם המשתמש שואל על פריט שלא ברשימה — אמור בכנות שאינו זמין כעת.',
        '- היה תמציתי, חם וטבעי. עברית רגילה, ללא ניסוחים פורמליים מדי.',
        '- אם אתה מציע פעולה ב-answer_question, פרט בקצרה אילו אפשרויות יש (לדוגמה: "רוצה לפתוח שאילה, החזרה או שריון?").',
        '- חשוב להשתמש בהיסטוריית השיחה — אם המשתמש אומר "כן" / "בטח" / "אוקיי" — תפרש זאת לאור ההצעה האחרונה שלך.',
        '- הבוט קיים גם בערוץ קשיח: המשתמש יכול תמיד לרשום "גמ"ח סקי" כדי לפתוח תפריט עם אפשרויות בחירה.'
    ].join('\n');
}

function summarizeItems(items, max = 30) {
    if (!Array.isArray(items) || !items.length) return '';
    return items.slice(0, max).map(it => {
        const statusSuffix = it.status && it.status !== 'במלאי' ? ` (${it.status})` : '';
        return `- ${it.id}: ${it.name}${statusSuffix}`;
    }).join('\n');
}

function buildContextText({ text, history, inventoryItems, userItems, userName }) {
    const parts = [];
    if (userName) parts.push(`## שם המשתמש: ${userName}`, '');

    const invSummary = summarizeItems(inventoryItems);
    if (invSummary) parts.push('## מלאי זמין כעת:', invSummary, '');

    const mySummary = summarizeItems(userItems);
    if (mySummary) parts.push('## פריטים על שם המשתמש (שאולים/משוריינים):', mySummary, '');

    if (history && history.length) {
        parts.push('## היסטוריית שיחה אחרונה (מהישנה לחדשה):');
        history.forEach(t => parts.push(`${t.role === 'user' ? 'משתמש' : 'בוט'}: ${t.content}`));
        parts.push('');
    }

    parts.push('## הודעת המשתמש הנוכחית:', `"${String(text || '').slice(0, 1000)}"`);
    return parts.join('\n');
}

function withTimeout(promise, ms) {
    let t;
    const timeout = new Promise((_, rej) => {
        t = setTimeout(() => rej(new Error(`free chat timed out after ${ms}ms`)), ms);
    });
    return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(t)), timeout]);
}

/**
 * @returns {Promise<{tool: string, input: object}|null>}
 */
async function runFreeChat(ctx) {
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
        console.error('❌ runFreeChat error:', err.message);
        return null;
    }
}

module.exports = { runFreeChat };
