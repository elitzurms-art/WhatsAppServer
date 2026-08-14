# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## שליחת הודעות עברית מ-Bash/Script

כשצריך לשלוח הודעת WhatsApp עם עברית מתוך Bash או סקריפט — **השתמש תמיד ב-Python**, לא ב-PowerShell. PowerShell מקלקל את ה-encoding של עברית ושולח סימני שאלה.

```python
PYTHONHOME=/c/OSGeo4W/apps/Python312 /c/OSGeo4W/bin/python3 -c "
import json
from urllib.request import urlopen, Request
req = Request('https://bot.elitzurgames.com/send',
    data=json.dumps({'phone': 'PHONE', 'message': 'הודעה בעברית'}).encode('utf-8'),
    headers={'x-api-key': 'a17d2A17d2', 'Content-Type': 'application/json; charset=utf-8'})
print(json.loads(urlopen(req).read()))
"
```

## מחיקת הודעות

כשמשתמש מבקש למחוק הודעה — **שאל תחילה איזו מחיקה הוא רוצה** והצג את האפשרויות:

1. **מחיקה אצלי בלבד** — ההודעה נעלמת רק ממך, הצד השני עדיין רואה אותה
2. **מחיקה לכולם** — ההודעה נמחקת אצל כולם (בתנאי שחלפו פחות מ-60 שניות מהשליחה)

**כלל קריטי**: אם בוצעה מחיקה "אצלי בלבד" — **לא ניתן עוד לבצע "מחיקה לכולם"** על אותה הודעה. WhatsApp חוסם זאת ומחזיר שגיאה 500. אל תנסה שוב.

---

## MCP Server (whatsapp_server.py)

`whatsapp_server.py` is a **Python FastMCP server** that wraps the remote WhatsApp bot REST API as Claude tools.

- **Backend URL**: `https://bot.elitzurgames.com`
- **Auth**: header `x-api-key: a17d2A17d2`
- **Framework**: `fastmcp` (pip: `mcp`)
- **HTTP client**: `httpx` (async)
- **Config**: `~/.claude/mcp.json` on the local machine

### HTTP helpers

| Helper | Method | Body type |
|--------|--------|-----------|
| `_get(path, params)` | GET | query params |
| `_post(path, body)` | POST | JSON |
| `_patch(path, body)` | PATCH | JSON |
| `_delete(path, params)` | DELETE | query params |
| `_delete_body(path, body)` | DELETE | JSON body — use when DELETE needs a JSON body (e.g. remove participants) |

### Adding a new tool

```python
@mcp.tool()
async def do_something(param: str) -> dict:
    """One-line description visible to Claude."""
    return await _post("/some/path", {"param": param})
```

After editing, commit + push, then the server pulls and Claude Code restarts the MCP.

### All 55 tools

**Health & Core**: `check_whatsapp_health`, `get_whatsapp_me`, `get_whatsapp_state`

**Send**: `send_whatsapp_message`, `send_whatsapp_image`, `send_whatsapp_video`, `send_whatsapp_audio`, `send_whatsapp_document`, `send_whatsapp_location`, `send_whatsapp_contact`, `send_whatsapp_sticker`, `send_whatsapp_tts`

**Messages**: `get_whatsapp_message`, `get_whatsapp_message_media`, `forward_whatsapp_message`, `delete_whatsapp_message`, `react_to_whatsapp_message`, `reply_to_whatsapp_message`

**Chats**: `get_whatsapp_chats`, `get_whatsapp_chat_messages`, `mark_whatsapp_chat_read`, `mark_whatsapp_chat_unread`, `send_whatsapp_typing`, `send_whatsapp_recording`, `archive_whatsapp_chat`, `unarchive_whatsapp_chat`, `pin_whatsapp_chat`, `unpin_whatsapp_chat`, `mute_whatsapp_chat`, `delete_whatsapp_chat`, `clear_whatsapp_chat`

**Contacts**: `get_whatsapp_contacts`, `search_whatsapp_contacts`, `get_whatsapp_contact`, `get_whatsapp_contact_profile_pic`, `get_whatsapp_contact_status`, `block_whatsapp_contact`, `unblock_whatsapp_contact`

**Groups**: `create_whatsapp_group`, `get_whatsapp_group`, `get_whatsapp_group_invite_code`, `leave_whatsapp_group`, `add_whatsapp_group_participants`, `remove_whatsapp_group_participants`, `promote_whatsapp_group_admin`, `demote_whatsapp_group_admin`, `update_whatsapp_group`, `set_whatsapp_group_picture`, `revoke_whatsapp_group_invite`

**Webhooks**: `get_whatsapp_webhooks`, `register_whatsapp_webhook`, `delete_whatsapp_webhook`

**Session**: `get_whatsapp_qr`, `restart_whatsapp_bot`, `logout_whatsapp`

---

## Deployment (Linux VPS — since 2026-08-14)

The bot runs on the DigitalOcean droplet `livemaps-vps` (**178.62.249.112**, same droplet as the LiveKit relay + coturn for Navigate video calls). It was previously on a Mac (macOS LaunchDaemon) — that setup is retired.

- **Path**: `/opt/WhatsAppServer` (git clone via read-only deploy key `github.com-whatsapp`)
- **Service**: `whatsapp-bot.service` (systemd, enabled at boot) — runs `start.sh`, which loops `node bot.js` with cleanup between restarts
- **Log**: `/var/log/whatsapp-bot.log`
- **Domain**: `bot.elitzurgames.com` → Cloudflare Tunnel `whatsapp-bot` (`c1fc782e-d8be-4078-b7ba-0d71c59245ab`, `cloudflared.service` on the droplet, config in `/etc/cloudflared/config.yml`) → `localhost:1000`. Note: the Mac's old tunnel (`elitzur`) still serves the `elitzurgames.com` website from the Mac — do not touch it.
- **Secrets** (not in git): `/opt/WhatsAppServer/.env` and `/opt/WhatsAppServer/credentials.json`
- **RAM**: droplet has only 1GB + 2GB swapfile (`/swapfile`). Chrome + bot ≈ 500-700MB. Do not run heavy extras; check `free -h` before adding services.
- **SSH from the Windows PC**: `ssh -i ~/.ssh/hetzner_livemaps root@178.62.249.112`

### Manage the service

```bash
systemctl status whatsapp-bot        # status
systemctl restart whatsapp-bot       # full restart (fresh Chrome)
tail -f /var/log/whatsapp-bot.log    # tail log
```

### Deploy updates

```bash
cd /opt/WhatsAppServer && git pull && npm ci && systemctl restart whatsapp-bot
```

`npm ci` (not `pnpm`) — the repo's `package-lock.json` is the source of truth; it pins `whatsapp-web.js` 1.34.6 which the patch in `patches/` depends on, and runs `patch-package` via postinstall.

---

## Project Overview

**WattsapServer** is a WhatsApp bot for managing a ski equipment lending library ("גמ"ח סקי בגולן"). The bot handles borrowing, returning, and reserving ski equipment (coats, pants, goggles, etc.) through WhatsApp conversations with users. All inventory and session data is stored in Google Sheets.

## Installation

### Prerequisites
The only prerequisite needed on the computer:
- **Node.js** (includes npm) - Download from https://nodejs.org/

That's it! No Python, pip, Git, or other dependencies needed.

The fixed whatsapp-web.js fork is included locally in the `whatsapp-web.js` folder, so no GitHub access is required during installation.

### Creating Deployment Package
To create a clean ZIP package for distribution:
1. Run `צור-חבילה.bat`
2. This creates a ZIP file with timestamp containing:
   - All source code (bot.js, sheets/, handlers/)
   - package.json
   - Installation script (התקנה.bat)
   - Local whatsapp-web.js fork
   - Patches
   - Documentation
   - Configuration files
3. The ZIP excludes node_modules, cache folders, credentials, and temporary files

### First-Time Setup
1. Extract the ZIP package to a folder (or download/clone the project)
2. Right-click `התקנה.bat` and select "Run as Administrator"
3. The script will:
   - Verify Node.js and npm are installed
   - Clean old installations
   - Install all dependencies (including the fixed whatsapp-web.js fork)
   - Set up Puppeteer Chrome
   - Apply patches
4. Copy `credentials.json.example` to `credentials.json` and add your Google Sheets credentials
5. Everything should work after the script completes

## Commands

### Running Tests
```bash
# Run all tests
npx jest

# Run specific test suite
npx jest tests/flow.simulation.test.js

# Run with watch mode
npx jest --watch
```

### Package Management
```bash
# Install dependencies
pnpm install

# Apply patches (runs automatically after install)
npx patch-package
```

### Utilities
```bash
# Kill Chrome instances (used for cleanup)
taskkill /F /IM chrome.exe /T
```

## Architecture

### State Machine Flow
The bot operates as a conversational state machine. User sessions track the current state and transition through these states:

- `ANUNIMI` - Initial/anonymous state (no active session)
- `BORROW_RETURN_SELECT` - User selecting between borrow/return/reserve/cancel
- `BORROW_SELECT` - User selecting items to borrow
- `RETURN_SELECT` - User selecting items to return
- `RESERVE_SELECT` - User selecting items to reserve
- `RESERVE_DATE` - Waiting for date confirmation for reservation
- `RESERVE_DATES_CONFIRM` - User entering reservation dates
- `BORROW_CONFIRM`, `RETURN_CONFIRM`, `RESERVE_CONFIRM` - Final confirmation states

State transitions are handled in `handlers/index.js` through a switch statement on `session.state`.

### Data Storage Strategy
The system uses Google Sheets as the database with two available session management approaches:

1. **In-Memory Sessions** (`sheets/sessions.js`) - Default approach
   - Sessions stored in JavaScript memory with 30-minute TTL
   - Faster performance, no Google Sheets API calls for sessions
   - Sessions cleared automatically after timeout
   - Data lost on server restart

2. **Google Sheets Sessions** (`sheets/sessionsForAppsScript.js`)
   - Sessions persisted to Google Sheets "Sessions" tab
   - Survives server restarts
   - Slower due to API round-trips
   - Can be inspected/modified directly in spreadsheet

**Inventory Data** is always stored in Google Sheets under the "ניהול" (Management) tab. Responses/transactions are logged to the "תגובות" (Responses) tab.

### Module Responsibilities

**`handlers/index.js`** - Core message handler and state machine
- `handleMessage()` - Main entry point, routes to state-specific handlers
- `startSession()` - Initiates new conversation
- `handle_Borrow_Return_Select()` - Handles main menu selection
- `handleBorrowSelect()`, `handleReturnSelect()`, `handleReserveSelect()` - Display available items
- `choice()` - Validates user selections and shows confirmation
- `reserveDates()`, `handleReserveDatesConfirm()` - Handle reservation date logic
- `accept()` - Final confirmation and transaction processing

**`sheets/inventory.js`** - Inventory management
- `getAvailableItems()` - Returns items with status "במלאי" or "משוריין"
- `getBorrowedItemsByPhone()` - Returns items borrowed/reserved by specific user
- `hasDateOverlap()` - Checks if reservation dates conflict with existing reservations
- `addResponse()` - Writes transaction to "תגובות" sheet

**`sheets/sessions.js`** - Session management (in-memory)
- Uses JavaScript object as session store
- 30-minute TTL with automatic cleanup via `setTimeout`

**`sheets/helpers.js`** - Shared utilities
- `getDoc()` - Google Sheets authentication and connection (singleton pattern)
- `normalizePhone()` - Strips non-digits from phone numbers for consistent comparison
- `validateSelection()` - Validates user input for item selection (3-digit IDs)

**`sheets/whatsapp.js`** - WhatsApp message utilities
- `sendWhatsAppButtons()` - Sends interactive button lists (with text fallback)
- `sendWhatsAppText()` - Sends plain text messages

### Key Data Structures

**Item Object**:
```javascript
{
  id: "305",           // 3-digit item ID
  name: "מעיל | מידה: L | צבע: אדום",
  status: "במלאי" | "מושאל" | "משוריין" | "מושאל+משוריין",
  phoneWattsap: "972123456789,972987654321", // Comma-separated (first=borrower in "מושאל+משוריין", rest=reservers)
  nameWattsap: "User Name(s)",
  reserveFrom: "01/02/2026,15/02/2026",      // Comma-separated dates
  reserveTo: "07/02/2026,21/02/2026",
  reserveReturnBy: "31/01/2026"              // Calculated: day before first reservation
}
```

**Session Object**:
```javascript
{
  state: "BORROW_SELECT",
  payload: "305,310##305 - מעיל אדום | 310 - מכנס כחול", // "ids##names" format
  reserveFrom: "01/02/2026",
  reserveTo: "07/02/2026"
}
```

### Multi-User Reservations
The system supports multiple users reserving the same item for different date ranges:
- Phone numbers stored as comma-separated list: `"phone1,phone2"`
- Corresponding dates stored as comma-separated lists: `"01/02/26,15/02/26"`
- Index matching: phone[i] corresponds to reserveFrom[i] and reserveTo[i]
- `hasDateOverlap()` checks all date ranges to prevent conflicts

### Date Validation Rules (reservations)
1. End date must be after start date
2. Start date must be at least 3 days from today
3. End date cannot exceed 3 months from today
4. Reservation duration cannot exceed 14 days
5. Must not overlap with existing reservations for the same item

### Phone Number Normalization
All phone numbers are normalized using `normalizePhone()` which strips non-digit characters. This ensures consistent comparisons across:
- User messages (`msg.from`)
- Google Sheets data
- Session lookups
- Multi-user reservation matching

## Configuration

- **Google Sheets ID**: Stored in `sheets/helpers.js` as `SPREADSHEET_ID`
- **Service Account Credentials**: `credentials.json` (not committed)
- **Session Sheet Name**: Configurable via `process.env.SESSIONS_SHEET` (default: "Sessions")

## Google Sheets Structure

### "תגובות" (Responses) Sheet Columns
The `addResponse()` function writes transaction logs with these columns (in order):
1. חותמת זמן - Timestamp
2. פעולה - Action type (שאילת ציוד / החזרת ציוד / שריון ציוד)
3. שם - User name
4. טלפון - Phone number
5. תאריך החזרה צפוי - Expected return date
6. מעילים שאולים - Borrowed coats (,ID1,ID2,)
7. מכנסיים שאולים - Borrowed pants
8. פריטים נוספים שאולים - Borrowed additional items
9. פריטים מוחזרים - Returned items
10. פריטים משוריינים - Reserved items
11. שריון מתאריך - Reservation start date
12. שריון עד תאריך - Reservation end date
13. ביטול שריון - Cancelled reservations

**Important**: The code uses column names (via `sheet.addRow(object)`) not indexes, so column order in the sheet doesn't matter as long as headers match.

## Testing

Tests use Jest with mocked Google Sheets and WhatsApp clients. Mock implementations are in `tests/__mocks__/`:
- `client.mock.js` - Mock WhatsApp client
- `msg.mock.js` - Mock message objects
- `helpers.js`, `sessions.js`, `inventory.js` - Mock sheet operations

## Patches and Fixes

### WhatsApp Web.js Fork
Due to breaking changes in WhatsApp Web that caused duplicate events and binding issues, this project uses a patched fork from timothydillan.

The fork is included locally in the `whatsapp-web.js` folder (not downloaded from GitHub during installation):

```json
"whatsapp-web.js": "file:./whatsapp-web.js"
```

This fork fixes critical issues with duplicate event handlers and binding problems that broke the official package. The local copy eliminates the need for Git during installation.

### Patch Package
A patch is applied via `patch-package` to fix a crash in `whatsapp-web.js` related to `sendSeen()`. The patch disables the "mark as read" functionality to prevent errors.

File: `patches/whatsapp-web.js+sendSeen-noop.patch`

## Important Notes

- All user-facing text is in Hebrew (RTL)
- Item IDs are always 3 digits
- User selections can be comma or space-separated: "305,310" or "305 310"
- The system automatically cancels personal reservations when a user borrows their reserved items
- Status values in Google Sheets:
  - "במלאי" (available)
  - "מושאל" (borrowed)
  - "משוריין" (reserved)
  - "מושאל+משוריין" (currently borrowed AND has future reservation)
- When status is "מושאל+משוריין": first phones in list are future reservers (with dates), last phone is current borrower (no dates)
- Status is calculated dynamically via Google Sheets formulas based on "תגובות" sheet
- Date format is DD/MM/YYYY or DD/MM/YY (auto-expanded to 20YY)
