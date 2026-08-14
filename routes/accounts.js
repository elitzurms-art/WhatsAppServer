const express = require('express');
const { ok, bad, asyncHandler, toChatId } = require('./utils');
const accounts = require('../accounts');

// ניהול ריבוי חשבונות WhatsApp — סשן נפרד לכל משתמש (ראה accounts.js).
module.exports = function accountsRoutes() {
    const router = express.Router();

    router.get('/', asyncHandler(async (req, res) => {
        return ok(res, { accounts: accounts.listAccounts(), running: accounts.runningCount() });
    }));

    router.post('/', asyncHandler(async (req, res) => {
        const { id, label } = req.body || {};
        if (!id) return bad(res, 'Missing id', 400);
        await accounts.createAccount(id, label);
        return ok(res, { account: accounts.getAccount(id) });
    }));

    router.get('/:id', asyncHandler(async (req, res) => {
        const acct = accounts.getAccount(req.params.id);
        if (!acct) return bad(res, 'Unknown account', 404);
        return ok(res, { account: acct });
    }));

    // מתחיל/מחזיר QR לקישור. הלקוח עושה polling עד status=ready
    router.get('/:id/qr', asyncHandler(async (req, res) => {
        const out = await accounts.getQr(req.params.id);
        return ok(res, out);
    }));

    router.post('/:id/send', asyncHandler(async (req, res) => {
        const { phone, message } = req.body || {};
        if (!phone || !message) return bad(res, 'Missing phone or message', 400);
        const chatId = toChatId(phone);
        if (!chatId) return bad(res, 'Invalid phone', 400);
        const sent = await accounts.sendFromAccount(req.params.id, chatId, message);
        return ok(res, { id: sent?.id?._serialized || null, chatId });
    }));

    // ---------- קריאות מהחשבון האישי (לצורכי אתר הלו"ז) ----------

    router.get('/:id/chats', asyncHandler(async (req, res) => {
        const limit = Math.max(0, parseInt(req.query.limit, 10) || 100);
        const client = await accounts.ensureReady(req.params.id);
        // לא client.getChats(): הסריאליזציה המלאה של WWebJS קורסת ("Evaluation failed: r")
        // כשהחשבון עוקב אחרי ערוצים (newsletter). ממפים ישירות מה-Store רק שדות קלים.
        let chats = await client.pupPage.evaluate(() => {
            return window.require('WAWebCollections').Chat.getModelsArray()
                .filter(c => c && c.id && c.id.server !== 'newsletter')
                .map(c => ({
                    id: c.id._serialized,
                    name: c.formattedTitle || c.name || '',
                    isGroup: c.id.server === 'g.us',
                    timestamp: c.t || 0,
                }));
        });
        chats.sort((a, b) => b.timestamp - a.timestamp);
        if (limit) chats = chats.slice(0, limit);
        return ok(res, { chats });
    }));

    const serializeContact = (c) => ({
        id: c.id?._serialized,
        number: c.number,
        name: c.name,
        pushname: c.pushname,
        shortName: c.shortName,
        isMyContact: c.isMyContact,
        isGroup: c.isGroup,
    });

    router.get('/:id/contacts', asyncHandler(async (req, res) => {
        const client = await accounts.ensureReady(req.params.id);
        const contacts = await client.getContacts();
        return ok(res, { contacts: contacts.map(serializeContact) });
    }));

    router.get('/:id/contacts/search', asyncHandler(async (req, res) => {
        const name = (req.query.name || '').toString().trim().toLowerCase();
        if (!name) return bad(res, 'Missing name', 400);
        const client = await accounts.ensureReady(req.params.id);
        const contacts = await client.getContacts();
        const matches = contacts.filter(c => {
            const fields = [c.name, c.pushname, c.shortName, c.number].filter(Boolean);
            return fields.some(f => String(f).toLowerCase().includes(name));
        });
        return ok(res, { contacts: matches.map(serializeContact) });
    }));

    router.get('/:id/chats/:chatId/messages', asyncHandler(async (req, res) => {
        const limit = Math.max(1, parseInt(req.query.limit, 10) || 50);
        const client = await accounts.ensureReady(req.params.id);
        // לא getChatById/fetchMessages: סריאליזציית הצ'אט של WWebJS ‏(getChatModel)
        // קורסת בחשבונות שעוקבים אחרי ערוצים. משכפל את הלוגיקה של fetchMessages
        // עם getAsModel:false ומיפוי שדות קל בלבד.
        const messages = await client.pupPage.evaluate(async (chatId, limit) => {
            const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
            if (!chat) return null;
            const filter = (m) => !m.isNotification;
            let msgs = chat.msgs.getModelsArray().filter(filter);
            while (msgs.length < limit) {
                const loaded = await window
                    .require('WAWebChatLoadMessages')
                    .loadEarlierMsgs({ chat });
                if (!loaded || !loaded.length) break;
                msgs = [...loaded.filter(filter), ...msgs];
            }
            return msgs
                .sort((a, b) => (a.t || 0) - (b.t || 0))
                .slice(-limit)
                .map(m => ({
                    id: m.id && m.id._serialized,
                    body: m.body || '',
                    from: (m.from && m.from._serialized) || null,
                    fromMe: !!(m.id && m.id.fromMe),
                    timestamp: m.t || 0,
                }));
        }, req.params.chatId, limit);
        if (!messages) return bad(res, 'Chat not found', 404);
        return ok(res, { messages });
    }));

    // יצירת קבוצה חדשה מהחשבון האישי. participants אופציונלי —
    // וואטסאפ מאפשר קבוצה שבה רק היוצר, ומוסיפים חברים אחר כך.
    router.post('/:id/groups', asyncHandler(async (req, res) => {
        const name = String((req.body || {}).name || '').trim();
        if (!name) return bad(res, 'Missing name', 400);
        const participants = Array.isArray((req.body || {}).participants)
            ? req.body.participants.map(toChatId).filter(Boolean)
            : [];
        const client = await accounts.ensureReady(req.params.id);
        const result = await client.createGroup(name, participants);
        const gid = typeof result === 'string' ? result : result?.gid?._serialized;
        if (!gid) return bad(res, 'Group creation failed', 500);
        return ok(res, { group: { id: gid, name } });
    }));

    router.post('/:id/logout', asyncHandler(async (req, res) => {
        await accounts.logoutAccount(req.params.id);
        return ok(res, { loggedOut: true });
    }));

    router.delete('/:id', asyncHandler(async (req, res) => {
        await accounts.deleteAccount(req.params.id);
        return ok(res, { deleted: true });
    }));

    return router;
};
