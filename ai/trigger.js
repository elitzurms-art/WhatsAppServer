// ai/trigger.js
// זיהוי הטריגר "גמ"ח סקי" על וריאציות מורחבות.
// - isTrigger: הודעה שכולה (כמעט) "גמ"ח סקי" → פותח תפריט.
// - containsGemachSki: הודעה שמזכירה גמ"ח סקי בכל מקום → FREE_CHAT.
// כל וריאציות הציטוטים נתמכות: " ׳ ״ ' (אסקי), " " ' ' (רגשי אייפון), רווחים, או בלי כלום.

// תווי ציטוט (כולל רגשיים של אייפון/אנדרואיד) + רווחים, בשימוש בין גמ ל-ח
const QUOTE_CLASS = '["״׳\'“”‘’]';
const QUOTE_OR_SPACE = '["״׳\'“”‘’\\s]';

// =======================
// טריגר מדויק — ההודעה כולה היא "גמ"ח סקי" (עם פתיח/סיומת אופציונליים)
// =======================
const TRIGGER_RE = new RegExp(
    '^\\s*' +
    // פתיח אופציונלי: שלום, היי, הי, hi, hello, אהלן, מה נשמע
    '(?:(?:שלום|היי|הי|הי\\!|אהלן|אהלן\\!|hi|hey|hello|מה\\s*נשמע|מה\\s*קורה)[\\s,\\.\\!-]*)?' +
    // "גמ"ח" — עם כמה תווי ציטוט/רווח אופציונליים, או "גמח" ישיר
    '(?:גמ' + QUOTE_OR_SPACE + '{0,4}ח|גמח)' +
    // ⇦ רווח/ים אופציונליים (לאפשר "גמחסקי" מחובר)
    '\\s*' +
    // "סקי"
    '(?:סקי|ski)' +
    // סיומת אופציונלית: בגולן / גולן / בגולן!
    '(?:\\s*(?:ב)?גולן)?' +
    // סימני פיסוק או אימוג׳י בסוף — אופציונלי
    '[\\s!\\.\\?]*$',
    'i'
);

// מקרי קצה: מקלדת אנגלית (גמ"ח = dn"j, סקי = xeh)
const TRIGGER_EN_LAYOUT_RE = new RegExp(
    '^\\s*' +
    '(?:dn' + QUOTE_CLASS + '{0,4}j|dnj)' +
    '\\s*' +
    'xeh' +
    '\\s*$',
    'i'
);

function isTrigger(text) {
    if (!text) return false;
    const t = String(text).trim();
    if (TRIGGER_EN_LAYOUT_RE.test(t)) return true;
    return TRIGGER_RE.test(t);
}

// =======================
// טריגר רך — ההודעה *מזכירה* גמ"ח סקי במקום כלשהו → לכניסה ל-FREE_CHAT.
// דורש שגם "גמ"ח" וגם "סקי" יופיעו באותה הודעה. בלי זה — מתעלמים לחלוטין
// (זה גם הוואטסאפ הפרטי של מושה).
// =======================
const LOOSE_GEMACH_RE = new RegExp('גמ' + QUOTE_OR_SPACE + '{0,4}ח|גמח');
const LOOSE_SKI_RE = /סקי|\bski\b/i;
const LOOSE_GEMACH_EN_RE = new RegExp('\\bdn' + QUOTE_CLASS + '{0,4}j\\b|\\bdnj\\b|\\bdn\\s+j\\b', 'i');
const LOOSE_SKI_EN_RE = /\bxeh\b/i;

function containsGemachSki(text) {
    if (!text) return false;
    const t = String(text);
    if (LOOSE_GEMACH_RE.test(t) && LOOSE_SKI_RE.test(t)) return true;
    if (LOOSE_GEMACH_EN_RE.test(t) && LOOSE_SKI_EN_RE.test(t)) return true;
    return false;
}

// =======================
// טריגר רך לבוט הקניות: "קניות" / "רשימה" / "רשימת קניות" / "shopping".
// הערה: \b לא עובד טוב עם עברית ב-JS, אז משתמשים ב-substring רגיל לעברית.
// =======================
const LOOSE_SHOPPING_RE = /קניות|רשימה|רשימת קניות/;
const LOOSE_SHOPPING_EN_RE = /\bshopping\b/i;

function containsShopping(text) {
    if (!text) return false;
    const t = String(text);
    return LOOSE_SHOPPING_RE.test(t) || LOOSE_SHOPPING_EN_RE.test(t);
}

module.exports = { isTrigger, containsGemachSki, containsShopping };
