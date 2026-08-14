const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { MessageMedia } = require('whatsapp-web.js');
const { normalizePhone } = require('./sheets/helpers');
const { sendToWhatsApp } = require('./chat-bridge');
const { apiSentIds } = require('./shared');

const mediaRoutes = require('./routes/media');
const messagesRoutes = require('./routes/messages');
const chatsRoutes = require('./routes/chats');
const contactsRoutes = require('./routes/contacts');
const groupsRoutes = require('./routes/groups');
const presenceRoutes = require('./routes/presence');
const webhooksRoutes = require('./routes/webhooks');
const sessionRoutes = require('./routes/session');
const accountsRoutes = require('./routes/accounts');

const API_KEY = process.env.API_KEY || 'your-secret-key';
const PORT = process.env.API_PORT || 1000;

const rateLimits = new Map();
const MAX_MESSAGES_PER_MINUTE = 10;

function checkRateLimit(phone) {
    const now = Date.now();
    const key = normalizePhone(phone);

    if (!rateLimits.has(key)) rateLimits.set(key, []);

    const timestamps = rateLimits.get(key);
    const recent = timestamps.filter(t => now - t < 60000);

    if (recent.length >= MAX_MESSAGES_PER_MINUTE) return false;

    recent.push(now);
    rateLimits.set(key, recent);
    return true;
}

// ניקוי rate limits כל 5 דקות
setInterval(() => {
    const now = Date.now();
    for (const [phone, timestamps] of rateLimits.entries()) {
        const recent = timestamps.filter(t => now - t < 60000);
        if (recent.length === 0) rateLimits.delete(phone);
        else rateLimits.set(phone, recent);
    }
}, 5 * 60 * 1000);

function authenticate(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== API_KEY) {
        console.log('❌ Unauthorized API request');
        return res.status(403).json({ ok: false, error: 'Unauthorized' });
    }
    next();
}

function createApiServer(whatsappClient) {
    const app = express();
    app.use(bodyParser.json({ limit: '25mb' }));

    // === Public ===
    app.get('/health', (req, res) => {
        res.json({ ok: true, status: 'running', timestamp: new Date().toISOString() });
    });

    // === Legacy /send — behavior preserved ===
    app.post('/send', authenticate, async (req, res) => {
        const { phone, message, source } = req.body;

        if (!phone || !message)
            return res.status(400).json({ ok: false, error: 'Missing phone or message' });

        let formattedPhone = normalizePhone(phone);

        if (!checkRateLimit(formattedPhone)) {
            console.log(`⚠️ Rate limit exceeded for ${formattedPhone}`);
            return res.status(429).json({ ok: false, error: 'Rate limit exceeded. Max 10 messages per minute.' });
        }

        try {
            const { toChatId } = require('./routes/utils');
            const chatId = source === 'AppsScript'
                ? `${formattedPhone}@c.us`
                : toChatId(phone);

            let sent;
            try {
                sent = await whatsappClient.sendMessage(chatId, message);
            } catch (e) {
                await sendToWhatsApp(whatsappClient, formattedPhone, message);
            }

            res.json({ ok: true, phone: chatId, id: sent?.id?._serialized || null, timestamp: new Date().toISOString() });
        } catch (err) {
            console.error(`❌ Failed to send to ${formattedPhone}:`, err);
            res.status(500).json({ ok: false, error: 'Failed to send message', details: err.toString() });
        }
    });

    // === TTS — הפיכת טקסט להודעה קולית (macOS say) ===
    app.post('/send/tts', authenticate, async (req, res) => {
        try {
            const { phone, text, voice = 'Carmit' } = req.body;
            if (!phone || !text) return res.status(400).json({ ok: false, error: 'Missing phone or text' });

            const { toChatId } = require('./routes/utils');
            const chatId = toChatId(phone);
            if (!chatId) return res.status(400).json({ ok: false, error: 'Invalid phone' });

            const { execFile } = require('child_process');
            const aiffFile = path.join(os.tmpdir(), `tts_${Date.now()}.aiff`);

            const oggFile = aiffFile.replace('.aiff', '.ogg');

            // שלב 1: say → AIFF
            await new Promise((resolve, reject) => {
                execFile('say', ['-v', voice, '-o', aiffFile, text], (err) => err ? reject(err) : resolve());
            });

            // שלב 2: AIFF → OGG/OPUS (פורמט נייטיב של WhatsApp PTT)
            await new Promise((resolve, reject) => {
                execFile('ffmpeg', ['-y', '-i', aiffFile, '-c:a', 'libopus', '-b:a', '32k', oggFile],
                    (err) => err ? reject(err) : resolve());
            });

            const media = MessageMedia.fromFilePath(oggFile);
            const sent = await whatsappClient.sendMessage(chatId, media, { sendAudioAsVoice: true });
            apiSentIds.add(sent.id._serialized);

            fs.unlink(aiffFile, () => {});
            fs.unlink(oggFile, () => {});

            return res.json({ ok: true, id: sent.id._serialized, chatId });
        } catch (err) {
            console.error('❌ /send/tts error:', err);
            return res.status(500).json({ ok: false, error: String(err?.message || err) });
        }
    });

    // === שליחת אודיו מ-base64 (PTT / Voice Message) ===
    app.post('/send/ptt', authenticate, async (req, res) => {
        try {
            const { phone, audioBase64, mimetype = 'audio/mpeg' } = req.body;
            if (!phone || !audioBase64) return res.status(400).json({ ok: false, error: 'Missing phone or audioBase64' });

            const { toChatId } = require('./routes/utils');
            const chatId = toChatId(phone);
            if (!chatId) return res.status(400).json({ ok: false, error: 'Invalid phone' });

            const ext = mimetype.split('/')[1] || 'mp3';
            const tmpFile = path.join(os.tmpdir(), `ptt_${Date.now()}.${ext}`);
            fs.writeFileSync(tmpFile, Buffer.from(audioBase64, 'base64'));

            const media = MessageMedia.fromFilePath(tmpFile);
            const sent = await whatsappClient.sendMessage(chatId, media, { sendAudioAsVoice: true });
            fs.unlinkSync(tmpFile);

            return res.json({ ok: true, id: sent.id._serialized, chatId });
        } catch (err) {
            console.error('❌ /send/ptt error:', err);
            return res.status(500).json({ ok: false, error: err.message });
        }
    });

    // === Protected extended API ===
    app.use('/send', authenticate, mediaRoutes(whatsappClient));
    app.use('/messages', authenticate, messagesRoutes(whatsappClient));
    app.use('/chats', authenticate, chatsRoutes(whatsappClient));
    app.use('/contacts', authenticate, contactsRoutes(whatsappClient));
    app.use('/groups', authenticate, groupsRoutes(whatsappClient));
    app.use('/webhooks', authenticate, webhooksRoutes(whatsappClient));
    app.use('/session', authenticate, sessionRoutes(whatsappClient));
    app.use('/accounts', authenticate, accountsRoutes());
    app.use(authenticate, presenceRoutes(whatsappClient));

    app.use((err, req, res, next) => {
        console.error('💥 Unhandled API error:', err);
        res.status(500).json({ ok: false, error: 'Internal server error', details: err.message });
    });

    app.listen(PORT, () => {
        console.log(`🚀 WhatsApp API Server listening on port ${PORT}`);
        console.log(`📍 Health check: http://localhost:${PORT}/health`);
        console.log(`📤 Legacy send: POST http://localhost:${PORT}/send`);
        console.log(`🧩 Extended routes: /send/*, /messages, /chats, /contacts, /groups, /webhooks, /session, /me, /state`);
        console.log(`🔑 API Key required in header: x-api-key`);
    });

    return app;
}

module.exports = { createApiServer };
