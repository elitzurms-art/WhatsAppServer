<div dir="rtl">

# פריסה במחשב השני (איפה שהבוט רץ)

אחרי כל `git push` בבראנץ' `main`, יש לרוץ על המחשב שבו הבוט פועל:

```bash
cd C:/MCP_WhatsApp
git pull
npx patch-package     # מפעיל את patches/whatsapp-web.js+1.34.6.patch
# restart לבוט (pm2 restart whatsapp-bot --update-env או start.sh מחדש)
```

> ⚠️ **אם `package.json` השתנה ב-pull הזה (נוספה/השתנתה תלות) — `npx patch-package` לבדו לא מספיק.** חובה להריץ `pnpm install` (או `npm install`) כדי שהתלות החדשה תרד ל-`node_modules`, ורק אז restart. patch-package רץ אוטומטית ב-postinstall.

## 📌 פריסה ספציפית — endpoint חדש לשליחת מסמכים גדולים (multipart)

נוסף נתיב `POST /send/document/upload` שמקבל קובץ כ-`multipart/form-data` (שדה `file`) במקום base64 בתוך JSON — כדי לעקוף את מגבלת גוף ה-JSON (25MB) ולשלוח קבצים עד ~100MB (תקרת המסמכים של וואטסאפ). הקובץ `whatsapp_server.py` (ה-MCP) כבר משתמש בנתיב הזה ב-`send_whatsapp_document_from_file`.

**מה צריך לעשות אחרי ה-pull שכולל את השינוי הזה:**

```bash
cd C:/MCP_WhatsApp
git pull
pnpm install          # ⬅️ חובה — מתקין את התלות החדשה multer (וגם מריץ patch-package ב-postinstall)
# restart מלא לבוט (לא רק soft-restart) — ראה למטה
```

אימות שהתלות הותקנה והנתיב חי:

```bash
ls node_modules/multer >/dev/null && echo "multer OK"
curl -s -X POST -H "x-api-key: a17d2A17d2" https://bot.elitzurgames.com/send/document/upload
# תגובה תקינה (חסר phone): {"ok":false,"error":"Missing phone"}  ← מוכיח שהנתיב קיים ורשום
```

> בצד ה-Windows המקומי (איפה שה-MCP רץ): אין מה להתקין — `httpx` כבר קיים. רק לטעון מחדש את ה-MCP (Claude Code restart) כדי שיקלוט את `whatsapp_server.py` המעודכן.

## למה צריך `npx patch-package`?

התיקיה `node_modules/whatsapp-web.js/` מגיעה מ-npm ולא מ-git (`node_modules` ב-`.gitignore`). כדי שהתיקונים שלנו ל-whatsapp-web.js יחולו בכל פעם מחדש, הם נשמרים כפאץ׳ בתיקייה `patches/` ו-patch-package מיישם אותם על node_modules.

אם מריצים `npm install` במקום, patch-package ירוץ אוטומטית ב-postinstall.

## אימות שהתיקון הוחל

```bash
grep "WAWebChatLoadMessages" node_modules/whatsapp-web.js/src/structures/Chat.js
```
צריך להחזיר שורה עם `window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat })`.

## סדר פעולות אחרי פאץ׳ חדש

1. `git pull`
2. `npx patch-package` (או `npm install`)
3. restart מלא לבוט — לא רק soft-restart של ה-MCP, אלא גם הפלת התהליך והרמתו מחדש (puppeteer צריך frame חדש)

</div>
