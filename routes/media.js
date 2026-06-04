const express = require('express');
const multer = require('multer');
const { MessageMedia, Location } = require('whatsapp-web.js');
const { toChatId, ok, bad, asyncHandler, buildMedia, extractMediaArgs } = require('./utils');

// העלאת קובץ בזרם (multipart) — בלי ניפוח base64 ובלי מגבלת גוף ה-JSON.
// בזיכרון בלבד; התקרה היא ~100MB שזו ממילא מגבלת המסמכים של וואטסאפ.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 110 * 1024 * 1024 },
});

module.exports = function mediaRoutes(client) {
    const router = express.Router();

    async function sendMedia(req, res, prefix, extraOptions = {}) {
        const { phone, caption } = req.body;
        if (!phone) return bad(res, 'Missing phone');

        const chatId = toChatId(phone);
        if (!chatId) return bad(res, 'Invalid phone');

        const args = extractMediaArgs(req.body, prefix);
        if (!args.url && !args.base64) {
            return bad(res, `Missing ${prefix}Url or ${prefix}Base64`);
        }

        const media = await buildMedia(args);
        const sendOptions = { caption, ...extraOptions };
        const sent = await client.sendMessage(chatId, media, sendOptions);
        return ok(res, { id: sent.id._serialized, chatId });
    }

    router.post('/image', asyncHandler((req, res) => sendMedia(req, res, 'image')));
    router.post('/video', asyncHandler((req, res) => sendMedia(req, res, 'video')));

    router.post('/audio', asyncHandler((req, res) => {
        const ptt = !!req.body.ptt;
        return sendMedia(req, res, 'audio', { sendAudioAsVoice: ptt });
    }));

    router.post('/document', asyncHandler(async (req, res) => {
        const { phone, caption, filename } = req.body;
        if (!phone) return bad(res, 'Missing phone');
        if (!filename) return bad(res, 'Missing filename');
        const chatId = toChatId(phone);
        if (!chatId) return bad(res, 'Invalid phone');

        const args = extractMediaArgs(req.body, 'document');
        if (!args.url && !args.base64) return bad(res, 'Missing documentUrl or documentBase64');
        args.filename = filename;
        const media = await buildMedia(args);
        media.filename = filename;
        const sent = await client.sendMessage(chatId, media, { caption, sendMediaAsDocument: true });
        return ok(res, { id: sent.id._serialized, chatId });
    }));

    // שליחת מסמך מקומי בזרם multipart (שדה הקובץ: "file") — לקבצים גדולים
    // שלא נכנסים בנתיב ה-base64/JSON. עד ~100MB (מגבלת וואטסאפ).
    router.post('/document/upload', upload.single('file'), asyncHandler(async (req, res) => {
        const { phone, caption } = req.body;
        const filename = req.body.filename || (req.file && req.file.originalname);
        if (!phone) return bad(res, 'Missing phone');
        if (!req.file) return bad(res, 'Missing file');
        if (!filename) return bad(res, 'Missing filename');
        const chatId = toChatId(phone);
        if (!chatId) return bad(res, 'Invalid phone');

        const mimetype = req.body.mimetype || req.file.mimetype || 'application/octet-stream';
        const media = new MessageMedia(mimetype, req.file.buffer.toString('base64'), filename);
        media.filename = filename;
        const sent = await client.sendMessage(chatId, media, { caption, sendMediaAsDocument: true });
        return ok(res, { id: sent.id._serialized, chatId });
    }));

    router.post('/sticker', asyncHandler(async (req, res) => {
        const { phone } = req.body;
        if (!phone) return bad(res, 'Missing phone');
        const chatId = toChatId(phone);
        if (!chatId) return bad(res, 'Invalid phone');

        const args = extractMediaArgs(req.body, 'sticker');
        if (!args.url && !args.base64) return bad(res, 'Missing stickerUrl or stickerBase64');
        const media = await buildMedia(args);
        const sent = await client.sendMessage(chatId, media, { sendMediaAsSticker: true });
        return ok(res, { id: sent.id._serialized, chatId });
    }));

    router.post('/location', asyncHandler(async (req, res) => {
        const { phone, latitude, longitude, description } = req.body;
        if (!phone) return bad(res, 'Missing phone');
        if (latitude === undefined || longitude === undefined) {
            return bad(res, 'Missing latitude or longitude');
        }
        const chatId = toChatId(phone);
        if (!chatId) return bad(res, 'Invalid phone');

        const location = new Location(Number(latitude), Number(longitude), description);
        const sent = await client.sendMessage(chatId, location);
        return ok(res, { id: sent.id._serialized, chatId });
    }));

    router.post('/contact', asyncHandler(async (req, res) => {
        const { phone, contactId, contactIds } = req.body;
        if (!phone) return bad(res, 'Missing phone');
        const chatId = toChatId(phone);
        if (!chatId) return bad(res, 'Invalid phone');

        const ids = contactIds || (contactId ? [contactId] : null);
        if (!ids || !ids.length) return bad(res, 'Missing contactId or contactIds');

        const normalizedIds = ids.map(toChatId).filter(Boolean);
        if (!normalizedIds.length) return bad(res, 'Invalid contactId(s)');

        const contacts = await Promise.all(normalizedIds.map(id => client.getContactById(id)));
        const payload = contacts.length === 1 ? contacts[0] : contacts;
        const sent = await client.sendMessage(chatId, payload);
        return ok(res, { id: sent.id._serialized, chatId });
    }));

    return router;
};
