// shared.js — state משותף בין bot.js ו-api-server.js (אותו process)
module.exports = {
    apiSentIds: new Set(),        // IDs של הודעות שנשלחו ע"י ה-API (לא ע"י המשתמש)
    botSentIds: new Set(),        // IDs של הודעות שהבוט שלח דרך client.sendMessage
    pendingBotSends: new Map(),   // chat_id:body → timestamp, לסינון message_create של הבוט (race-safe)
};
