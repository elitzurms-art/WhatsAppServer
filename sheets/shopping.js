// sheets/shopping.js
// פעולות על גיליון "רשימת קניות משפחתית" (ID ב-SHOPPING_SHEET_ID).
// טאב "רשימה" — עמודות: חותמת זמן | פריט | כמות | מי הוסיף | טלפון | סטטוס | מי קנה | חותמת קנייה.
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('../credentials.json');

const SHOPPING_SHEET_ID = process.env.SHOPPING_SHEET_ID || '17u5Nj9HcXrM80rlNCtkEJBdUOaQ6hGErJWY8lxPciN0';
const LIST_TITLE = 'רשימה';
const HISTORY_TITLE = 'היסטוריית שיחה';
const LIST_HEADERS = ['חותמת זמן', 'פריט', 'כמות', 'מי הוסיף', 'טלפון', 'סטטוס', 'מי קנה', 'חותמת קנייה'];
const HISTORY_HEADERS = ['חותמת זמן', 'טלפון', 'שם', 'תפקיד', 'מצב', 'תוכן'];

const STATUS_ACTIVE = 'פעיל';
const STATUS_BOUGHT = 'נקנה';

let doc = null;
async function getDoc() {
    if (doc) return doc;
    const auth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const spreadsheet = new GoogleSpreadsheet(SHOPPING_SHEET_ID, auth);
    await spreadsheet.loadInfo();
    doc = spreadsheet;
    return doc;
}

async function ensureSheet(title, headers) {
    const d = await getDoc();
    let sheet = d.sheetsByTitle[title];
    if (!sheet) {
        sheet = await d.addSheet({ title, headerValues: headers });
        console.log(`📝 נוצר טאב חדש: "${title}"`);
    } else {
        try {
            await sheet.loadHeaderRow();
            if (!sheet.headerValues || sheet.headerValues.length === 0) {
                await sheet.setHeaderRow(headers);
            }
        } catch {
            await sheet.setHeaderRow(headers);
        }
    }
    return sheet;
}

async function ensureListSheet() {
    return ensureSheet(LIST_TITLE, LIST_HEADERS);
}

async function ensureHistorySheet() {
    return ensureSheet(HISTORY_TITLE, HISTORY_HEADERS);
}

/**
 * החזרת פריטים פעילים (סטטוס "פעיל").
 * @returns {Promise<Array<{rowIndex, name, quantity, addedBy, addedAt}>>}
 */
async function getActiveItems() {
    try {
        const sheet = await ensureListSheet();
        const rows = await sheet.getRows({ limit: 500 });
        const items = [];
        rows.forEach(row => {
            const status = (row.get('סטטוס') || '').trim();
            if (status !== STATUS_ACTIVE) return;
            items.push({
                rowIndex: row.rowNumber,
                name: (row.get('פריט') || '').trim(),
                quantity: (row.get('כמות') || '').toString().trim(),
                addedBy: (row.get('מי הוסיף') || '').trim(),
                addedAt: (row.get('חותמת זמן') || '').trim()
            });
        });
        return items;
    } catch (err) {
        console.error('❌ getActiveItems error:', err.message);
        return [];
    }
}

/**
 * הוספת פריטים לרשימה.
 * @param {Array<{name: string, quantity?: string}>} items
 * @param {string} addedBy - user's display name
 * @param {string} phone
 */
async function addItems(items, addedBy, phone) {
    if (!Array.isArray(items) || !items.length) return 0;
    const sheet = await ensureListSheet();
    const timestamp = new Date().toLocaleString('he-IL');
    const rows = items.map(it => ({
        'חותמת זמן': timestamp,
        'פריט': String(it.name || '').trim(),
        'כמות': String(it.quantity || '').trim(),
        'מי הוסיף': addedBy || '',
        'טלפון': phone || '',
        'סטטוס': STATUS_ACTIVE,
        'מי קנה': '',
        'חותמת קנייה': ''
    })).filter(r => r['פריט']);
    if (!rows.length) return 0;
    await sheet.addRows(rows);
    return rows.length;
}

/**
 * סימון פריטים כ"נקנה" לפי rowIndex (מספר השורה בגיליון, כפי שמופיע ב-getActiveItems).
 * @param {number[]} rowIndices
 * @param {string} boughtBy
 */
async function markBought(rowIndices, boughtBy) {
    if (!Array.isArray(rowIndices) || !rowIndices.length) return 0;
    const sheet = await ensureListSheet();
    const rows = await sheet.getRows({ limit: 500 });
    const set = new Set(rowIndices.map(Number));
    const timestamp = new Date().toLocaleString('he-IL');
    let count = 0;
    for (const row of rows) {
        if (!set.has(row.rowNumber)) continue;
        if ((row.get('סטטוס') || '').trim() !== STATUS_ACTIVE) continue;
        row.set('סטטוס', STATUS_BOUGHT);
        row.set('מי קנה', boughtBy || '');
        row.set('חותמת קנייה', timestamp);
        await row.save();
        count++;
    }
    return count;
}

/**
 * סימון כל הפריטים הפעילים כ"נקנה".
 */
async function clearActiveList(boughtBy) {
    const sheet = await ensureListSheet();
    const rows = await sheet.getRows({ limit: 500 });
    const timestamp = new Date().toLocaleString('he-IL');
    let count = 0;
    for (const row of rows) {
        if ((row.get('סטטוס') || '').trim() !== STATUS_ACTIVE) continue;
        row.set('סטטוס', STATUS_BOUGHT);
        row.set('מי קנה', boughtBy || '');
        row.set('חותמת קנייה', timestamp);
        await row.save();
        count++;
    }
    return count;
}

module.exports = {
    getDoc,
    ensureListSheet,
    ensureHistorySheet,
    getActiveItems,
    addItems,
    markBought,
    clearActiveList,
    LIST_TITLE,
    HISTORY_TITLE,
    STATUS_ACTIVE,
    STATUS_BOUGHT
};
