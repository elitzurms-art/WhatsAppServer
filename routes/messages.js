const express = require('express');
const { toChatId, ok, bad, asyncHandler, buildMedia } = require('./utils');

module.exports = function messagesRoutes(client) {
    const router = express.Router();

    async function loadMessage(messageId) {
        let msg = await client.getMessageById(messageId).catch(() => null);
        if (!msg) {
            const parts = messageId.split('_');
            if (parts.length >= 3) {
                const chatId = parts[1];
                const chat = await client.getChatById(chatId).catch(() => null);
                if (chat) {
                    const messages = await chat.fetchMessages({ limit: 200 });
                    msg = messages.find(m => m.id._serialized === messageId) || null;
                }
            }
        }
        if (!msg) throw new Error('Message not found');
        return msg;
    }

    router.get('/:messageId', asyncHandler(async (req, res) => {
        const msg = await loadMessage(req.params.messageId);
        return ok(res, {
            message: {
                id: msg.id._serialized,
                body: msg.body,
                from: msg.from,
                to: msg.to,
                timestamp: msg.timestamp,
                type: msg.type,
                hasMedia: msg.hasMedia,
                fromMe: msg.fromMe,
                ack: msg.ack,
                isForwarded: msg.isForwarded,
            },
        });
    }));

    router.get('/:messageId/media', asyncHandler(async (req, res) => {
        const msg = await loadMessage(req.params.messageId);
        if (!msg.hasMedia) return bad(res, 'Message has no media', 404);
        const media = await msg.downloadMedia();
        if (!media) return bad(res, 'Failed to download media', 500);
        return ok(res, { mimetype: media.mimetype, data: media.data, filename: media.filename });
    }));

    router.post('/:messageId/forward', asyncHandler(async (req, res) => {
        const { toPhone, toPhones } = req.body;
        const targets = toPhones || (toPhone ? [toPhone] : null);
        if (!targets || !targets.length) return bad(res, 'Missing toPhone or toPhones');

        const msg = await loadMessage(req.params.messageId);
        const results = [];
        for (const phone of targets) {
            const chatId = toChatId(phone);
            if (!chatId) {
                results.push({ phone, ok: false, error: 'Invalid phone' });
                continue;
            }
            try {
                const chat = await client.getChatById(chatId);
                await msg.forward(chat);
                results.push({ phone, chatId, ok: true });
            } catch (err) {
                results.push({ phone, chatId, ok: false, error: err.message });
            }
        }
        return ok(res, { results });
    }));

    router.delete('/:messageId', asyncHandler(async (req, res) => {
        const everyone = String(req.query.everyone || 'false').toLowerCase() === 'true';
        const msg = await loadMessage(req.params.messageId);
        await msg.delete(everyone);
        return ok(res, { deleted: true, everyone });
    }));

    router.post('/:messageId/react', asyncHandler(async (req, res) => {
        const { emoji } = req.body;
        if (emoji === undefined) return bad(res, 'Missing emoji (pass "" to clear)');
        const msg = await loadMessage(req.params.messageId);
        await msg.react(emoji);
        return ok(res, { reacted: true, emoji });
    }));

    router.post('/:messageId/reply', asyncHandler(async (req, res) => {
        const { message, mediaUrl, mediaBase64, mimetype, filename, caption } = req.body;
        const msg = await loadMessage(req.params.messageId);

        let content = message;
        const options = {};
        if (mediaUrl || mediaBase64) {
            content = await buildMedia({ url: mediaUrl, base64: mediaBase64, mimetype, filename });
            if (caption || message) options.caption = caption || message;
        } else if (!message) {
            return bad(res, 'Missing message or media');
        }

        const sent = await msg.reply(content, undefined, options);
        return ok(res, { id: sent.id._serialized });
    }));

    return router;
};
