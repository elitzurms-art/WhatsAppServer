from mcp.server.fastmcp import FastMCP
import httpx
import base64
import mimetypes
import os
from typing import Optional

mcp = FastMCP("whatsapp")


async def _post_large(path: str, body: dict, timeout: float = 120.0) -> dict:
    """POST helper with a long timeout for base64-encoded media uploads.
    The default 15s in `_post` is too tight for multi-MB payloads going
    over the internet to bot.elitzurgames.com."""
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(f"{BASE_URL}{path}", headers=HEADERS, json=body)
        return r.json()


def _read_file_as_base64(file_path: str, default_mimetype: str = "application/octet-stream") -> tuple[str, str]:
    """Return (base64_payload, mimetype) for a local file. Mimetype is
    guessed from the extension; falls back to `default_mimetype` if the
    extension isn't recognized."""
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")
    mimetype, _ = mimetypes.guess_type(file_path)
    if not mimetype:
        mimetype = default_mimetype
    with open(file_path, "rb") as f:
        data = f.read()
    return base64.b64encode(data).decode("ascii"), mimetype

BASE_URL = "https://bot.elitzurgames.com"
API_KEY = "a17d2A17d2"
HEADERS = {"x-api-key": API_KEY}


async def _get(path: str, params: dict = None) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{BASE_URL}{path}", headers=HEADERS, params=params)
        return r.json()


async def _post(path: str, body: dict = None) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(f"{BASE_URL}{path}", headers=HEADERS, json=body or {})
        return r.json()


async def _delete(path: str, params: dict = None) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.delete(f"{BASE_URL}{path}", headers=HEADERS, params=params)
        return r.json()


async def _patch(path: str, body: dict) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.patch(f"{BASE_URL}{path}", headers=HEADERS, json=body)
        return r.json()


async def _delete_body(path: str, body: dict) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.delete(f"{BASE_URL}{path}", headers=HEADERS, json=body)
        return r.json()


# ── Health / Core ─────────────────────────────────────────────────────────────

@mcp.tool()
async def check_whatsapp_health() -> dict:
    """Check if the WhatsApp bot is online and running"""
    async with httpx.AsyncClient(timeout=5) as client:
        r = await client.get(f"{BASE_URL}/health")
        return r.json()


@mcp.tool()
async def get_whatsapp_me() -> dict:
    """Get the logged-in WhatsApp user info (wid, pushname, platform)"""
    return await _get("/me")


@mcp.tool()
async def get_whatsapp_state() -> dict:
    """Get WhatsApp connection state (CONNECTED, TIMEOUT, CONFLICT, ...)"""
    return await _get("/state")


# ── Send ──────────────────────────────────────────────────────────────────────

@mcp.tool()
async def send_whatsapp_message(phone: str, message: str, source: str = "AppsScript") -> dict:
    """Send a WhatsApp text message. Phone: Israeli format (0521234567) or E.164 (972521234567)."""
    return await _post("/send", {"phone": phone, "message": message, "source": source})


@mcp.tool()
async def send_whatsapp_image(phone: str, image_url: str, caption: str = "") -> dict:
    """Send an image by URL to a WhatsApp number."""
    return await _post("/send/image", {"phone": phone, "imageUrl": image_url, "caption": caption})


@mcp.tool()
async def send_whatsapp_image_from_file(phone: str, file_path: str, caption: str = "") -> dict:
    """Send a LOCAL image file by uploading its bytes inline (no public
    URL needed). Use this when you have a file on the local machine and
    don't want to host it on an external server first.
    `file_path` is an absolute path on the machine running this MCP."""
    b64, mimetype = _read_file_as_base64(file_path, "image/jpeg")
    return await _post_large("/send/image", {
        "phone": phone,
        "imageBase64": b64,
        "mimetype": mimetype,
        "caption": caption,
    })


@mcp.tool()
async def send_whatsapp_video(phone: str, video_url: str, caption: str = "") -> dict:
    """Send a video by URL to a WhatsApp number."""
    return await _post("/send/video", {"phone": phone, "videoUrl": video_url, "caption": caption})


@mcp.tool()
async def send_whatsapp_audio(phone: str, audio_url: str, ptt: bool = False) -> dict:
    """Send audio to a WhatsApp number. ptt=True sends as voice message."""
    return await _post("/send/audio", {"phone": phone, "audioUrl": audio_url, "ptt": ptt})


@mcp.tool()
async def send_whatsapp_document(phone: str, document_url: str, filename: str, caption: str = "") -> dict:
    """Send a document/file by URL to a WhatsApp number."""
    return await _post("/send/document", {"phone": phone, "documentUrl": document_url, "filename": filename, "caption": caption})


@mcp.tool()
async def send_whatsapp_document_from_file(phone: str, file_path: str, filename: str = "", caption: str = "") -> dict:
    """Send a LOCAL document/file by streaming its bytes as multipart/form-data
    (no base64 inflation, no JSON body-size limit) — handles large files up to
    WhatsApp's ~100MB document cap. `filename` is what WhatsApp shows on the
    file bubble; if empty, the basename of `file_path` is used."""
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")
    if not filename:
        filename = os.path.basename(file_path)
    mimetype, _ = mimetypes.guess_type(file_path)
    if not mimetype:
        mimetype = "application/octet-stream"
    async with httpx.AsyncClient(timeout=300.0) as client:
        with open(file_path, "rb") as f:
            files = {"file": (filename, f, mimetype)}
            data = {"phone": phone, "filename": filename, "mimetype": mimetype, "caption": caption}
            r = await client.post(
                f"{BASE_URL}/send/document/upload", headers=HEADERS, data=data, files=files
            )
            return r.json()


@mcp.tool()
async def send_whatsapp_location(phone: str, latitude: float, longitude: float, description: str = "") -> dict:
    """Send a location pin to a WhatsApp number."""
    return await _post("/send/location", {"phone": phone, "latitude": latitude, "longitude": longitude, "description": description})


@mcp.tool()
async def send_whatsapp_contact(phone: str, contact_id: str) -> dict:
    """Send a contact card to a WhatsApp number. contact_id: E.164 number (e.g. 972501234567)."""
    return await _post("/send/contact", {"phone": phone, "contactId": contact_id})


# ── Send (extra) ──────────────────────────────────────────────────────────────

@mcp.tool()
async def send_whatsapp_sticker(phone: str, sticker_url: str) -> dict:
    """Send a sticker by URL to a WhatsApp number."""
    return await _post("/send/sticker", {"phone": phone, "stickerUrl": sticker_url})


@mcp.tool()
async def send_whatsapp_tts(phone: str, text: str, voice: str = "") -> dict:
    """Send a text-to-speech voice message to a WhatsApp number."""
    body: dict = {"phone": phone, "text": text}
    if voice:
        body["voice"] = voice
    return await _post("/send/tts", body)


# ── Messages ──────────────────────────────────────────────────────────────────

@mcp.tool()
async def get_whatsapp_message(message_id: str) -> dict:
    """Get details of a WhatsApp message by its serialized ID."""
    return await _get(f"/messages/{message_id}")


@mcp.tool()
async def get_whatsapp_message_media(message_id: str) -> dict:
    """Download media from a WhatsApp message. Returns mimetype, base64 data, filename."""
    return await _get(f"/messages/{message_id}/media")


@mcp.tool()
async def forward_whatsapp_message(message_id: str, to_phone: str) -> dict:
    """Forward a WhatsApp message to another number (with 'Forwarded' tag)."""
    return await _post(f"/messages/{message_id}/forward", {"toPhone": to_phone})


@mcp.tool()
async def delete_whatsapp_message(message_id: str, for_everyone: bool) -> dict:
    """Delete a WhatsApp message.
    IMPORTANT: Always ask the user which deletion type they want before calling:
      - for_everyone=False: delete only for me (recipient still sees the message)
      - for_everyone=True:  delete for everyone (only works within ~60 seconds of sending)
    WARNING: Once deleted with for_everyone=False, deleting for everyone is no longer possible.
    WhatsApp blocks it (returns 500). Do not retry with for_everyone=True in that case."""
    result = await _delete(f"/messages/{message_id}", {"everyone": str(for_everyone).lower()})
    if for_everyone and isinstance(result, dict) and not result.get("everyone"):
        result["warning"] = "נמחק אצלי בלבד — לא ניתן למחוק לכולם (חלף הזמן או נמחק קודם אצלי בלבד)"
    return result


@mcp.tool()
async def react_to_whatsapp_message(message_id: str, emoji: str) -> dict:
    """React to a WhatsApp message with an emoji. Empty string removes reaction."""
    return await _post(f"/messages/{message_id}/react", {"emoji": emoji})


@mcp.tool()
async def reply_to_whatsapp_message(message_id: str, message: str) -> dict:
    """Reply to a specific WhatsApp message."""
    return await _post(f"/messages/{message_id}/reply", {"message": message})


# ── Chats ─────────────────────────────────────────────────────────────────────

@mcp.tool()
async def get_whatsapp_chats(limit: int = 50, only_unread: bool = False) -> dict:
    """Get list of WhatsApp chats."""
    return await _get("/chats", {"limit": limit, "onlyWithUnread": str(only_unread).lower()})


@mcp.tool()
async def get_whatsapp_chat_messages(chat_id: str, limit: int = 50) -> dict:
    """Get message history from a WhatsApp chat. chat_id: e.g. 972501234567@c.us"""
    return await _get(f"/chats/{chat_id}/messages", {"limit": limit})


@mcp.tool()
async def mark_whatsapp_chat_read(chat_id: str) -> dict:
    """Mark a WhatsApp chat as read."""
    return await _post(f"/chats/{chat_id}/markRead")


@mcp.tool()
async def send_whatsapp_typing(chat_id: str, duration: int = 3000) -> dict:
    """Show 'typing...' indicator in a WhatsApp chat for the given duration (ms)."""
    return await _post(f"/chats/{chat_id}/typing", {"duration": duration})


@mcp.tool()
async def send_whatsapp_recording(chat_id: str, duration: int = 3000) -> dict:
    """Show 'recording...' indicator in a WhatsApp chat for the given duration (ms)."""
    return await _post(f"/chats/{chat_id}/recording", {"duration": duration})


@mcp.tool()
async def mark_whatsapp_chat_unread(chat_id: str) -> dict:
    """Mark a WhatsApp chat as unread."""
    return await _post(f"/chats/{chat_id}/markUnread")


@mcp.tool()
async def archive_whatsapp_chat(chat_id: str) -> dict:
    """Archive a WhatsApp chat."""
    return await _post(f"/chats/{chat_id}/archive")


@mcp.tool()
async def unarchive_whatsapp_chat(chat_id: str) -> dict:
    """Unarchive a WhatsApp chat."""
    return await _delete(f"/chats/{chat_id}/archive")


@mcp.tool()
async def pin_whatsapp_chat(chat_id: str) -> dict:
    """Pin a WhatsApp chat to the top of the list."""
    return await _post(f"/chats/{chat_id}/pin")


@mcp.tool()
async def unpin_whatsapp_chat(chat_id: str) -> dict:
    """Unpin a WhatsApp chat."""
    return await _delete(f"/chats/{chat_id}/pin")


@mcp.tool()
async def mute_whatsapp_chat(chat_id: str, duration: str = "8h") -> dict:
    """Mute a WhatsApp chat. duration: '8h', '1w', 'year', or null to unmute."""
    return await _post(f"/chats/{chat_id}/mute", {"duration": duration})


@mcp.tool()
async def delete_whatsapp_chat(chat_id: str) -> dict:
    """Delete a WhatsApp chat entirely."""
    return await _delete(f"/chats/{chat_id}")


@mcp.tool()
async def clear_whatsapp_chat(chat_id: str) -> dict:
    """Clear all messages from a WhatsApp chat (keeps the chat itself)."""
    return await _post(f"/chats/{chat_id}/clear")


# ── Contacts ──────────────────────────────────────────────────────────────────

@mcp.tool()
async def get_whatsapp_contacts() -> dict:
    """Get all WhatsApp contacts."""
    return await _get("/contacts")


@mcp.tool()
async def search_whatsapp_contacts(name: str) -> dict:
    """Search WhatsApp contacts by name (case-insensitive substring match)."""
    return await _get("/contacts/search", {"name": name})


@mcp.tool()
async def get_whatsapp_contact(contact_id: str) -> dict:
    """Get details of a WhatsApp contact. contact_id: E.164 number (e.g. 972501234567@c.us)"""
    return await _get(f"/contacts/{contact_id}")


@mcp.tool()
async def get_whatsapp_contact_profile_pic(contact_id: str) -> dict:
    """Get profile picture URL of a WhatsApp contact."""
    return await _get(f"/contacts/{contact_id}/profilePicUrl")


@mcp.tool()
async def get_whatsapp_contact_status(contact_id: str) -> dict:
    """Get the 'About' status text of a WhatsApp contact."""
    return await _get(f"/contacts/{contact_id}/about")


@mcp.tool()
async def block_whatsapp_contact(contact_id: str) -> dict:
    """Block a WhatsApp contact."""
    return await _post(f"/contacts/{contact_id}/block")


@mcp.tool()
async def unblock_whatsapp_contact(contact_id: str) -> dict:
    """Unblock a WhatsApp contact."""
    return await _delete(f"/contacts/{contact_id}/block")


# ── Groups ────────────────────────────────────────────────────────────────────

@mcp.tool()
async def create_whatsapp_group(name: str, participants: list[str]) -> dict:
    """Create a new WhatsApp group. participants: list of phone numbers."""
    return await _post("/groups", {"name": name, "participants": participants})


@mcp.tool()
async def get_whatsapp_group(group_id: str) -> dict:
    """Get details of a WhatsApp group. group_id: e.g. 1234567890@g.us"""
    return await _get(f"/groups/{group_id}")


@mcp.tool()
async def get_whatsapp_group_invite_code(group_id: str) -> dict:
    """Get the invite link for a WhatsApp group."""
    return await _get(f"/groups/{group_id}/inviteCode")


@mcp.tool()
async def leave_whatsapp_group(group_id: str) -> dict:
    """Leave a WhatsApp group."""
    return await _post(f"/groups/{group_id}/leave")


@mcp.tool()
async def add_whatsapp_group_participants(group_id: str, phones: list[str]) -> dict:
    """Add participants to a WhatsApp group. phones: list of E.164 numbers."""
    return await _post(f"/groups/{group_id}/participants", {"phones": phones})


@mcp.tool()
async def remove_whatsapp_group_participants(group_id: str, phones: list[str]) -> dict:
    """Remove participants from a WhatsApp group. phones: list of E.164 numbers."""
    return await _delete_body(f"/groups/{group_id}/participants", {"phones": phones})


@mcp.tool()
async def promote_whatsapp_group_admin(group_id: str, phones: list[str]) -> dict:
    """Promote participants to admin in a WhatsApp group. phones: list of E.164 numbers."""
    return await _post(f"/groups/{group_id}/admins", {"phones": phones})


@mcp.tool()
async def demote_whatsapp_group_admin(group_id: str, phones: list[str]) -> dict:
    """Demote admins to regular participants in a WhatsApp group. phones: list of E.164 numbers."""
    return await _delete_body(f"/groups/{group_id}/admins", {"phones": phones})


@mcp.tool()
async def update_whatsapp_group(group_id: str, name: str = "", description: str = "",
                                 messages_admins_only: bool = None, edit_info_admins_only: bool = None) -> dict:
    """Update WhatsApp group settings: name, description, who can send messages, who can edit info."""
    body: dict = {}
    if name:
        body["name"] = name
    if description:
        body["description"] = description
    if messages_admins_only is not None:
        body["messagesAdminsOnly"] = messages_admins_only
    if edit_info_admins_only is not None:
        body["editInfoAdminsOnly"] = edit_info_admins_only
    return await _patch(f"/groups/{group_id}", body)


@mcp.tool()
async def set_whatsapp_group_picture(group_id: str, image_url: str) -> dict:
    """Set the profile picture of a WhatsApp group by image URL."""
    return await _post(f"/groups/{group_id}/picture", {"imageUrl": image_url})


@mcp.tool()
async def revoke_whatsapp_group_invite(group_id: str) -> dict:
    """Revoke the current invite link of a WhatsApp group (generates a new one)."""
    return await _post(f"/groups/{group_id}/inviteCode/revoke")


# ── Webhooks ──────────────────────────────────────────────────────────────────

@mcp.tool()
async def get_whatsapp_webhooks() -> dict:
    """List all registered WhatsApp webhooks."""
    return await _get("/webhooks")


@mcp.tool()
async def register_whatsapp_webhook(url: str, events: list[str], secret: str = "") -> dict:
    """Register a webhook URL to receive WhatsApp events.
    events: e.g. ['message', 'message_reaction', 'group_join', 'disconnected']"""
    body = {"url": url, "events": events}
    if secret:
        body["secret"] = secret
    return await _post("/webhooks", body)


@mcp.tool()
async def delete_whatsapp_webhook(webhook_id: str) -> dict:
    """Remove a registered WhatsApp webhook."""
    return await _delete(f"/webhooks/{webhook_id}")


# ── Session ───────────────────────────────────────────────────────────────────

@mcp.tool()
async def get_whatsapp_qr() -> dict:
    """Get the current QR code (if bot is not authenticated yet)."""
    return await _get("/session/qr")


@mcp.tool()
async def restart_whatsapp_bot() -> dict:
    """Soft-restart the WhatsApp bot process (requires PM2/nodemon supervisor)."""
    return await _post("/session/restart")


@mcp.tool()
async def logout_whatsapp() -> dict:
    """Logout from WhatsApp and disconnect the session."""
    return await _post("/session/logout")


if __name__ == "__main__":
    mcp.run()
