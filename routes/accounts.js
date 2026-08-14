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
