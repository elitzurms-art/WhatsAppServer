//index.js
const inventory = require('../sheets/inventory');
const sessions = require('../sheets/sessions');
const { normalizePhone, validateSelection } = require('../sheets/helpers');
const { sendWhatsAppButtons, sendWhatsAppText } = require('../sheets/whatsapp');
const { rescueMessage } = require('../ai/rescue');
const { isTrigger, containsGemachSki } = require('../ai/trigger');
const { runFreeChat } = require('../ai/freeChat');
const conversationHistory = require('../sheets/conversationHistory');

// שליפה נקודתית של רשימת פריטים רלוונטית למצב — להעברה ל-AI כ-context
async function loadInventorySnapshot(state, phone) {
	try {
		if (state === 'RETURN_SELECT' || state === 'RETURN_CONFIRM') {
			const items = await inventory.getBorrowedItemsByPhone(phone);
			return [...(items.coats || []), ...(items.pants || []), ...(items.additional || [])];
		}
		if (['BORROW_SELECT', 'RESERVE_SELECT', 'BORROW_CONFIRM', 'RESERVE_CONFIRM'].includes(state)) {
			const items = await inventory.getAvailableItems();
			return [...(items.coats || []), ...(items.pants || []), ...(items.additional || [])];
		}
		return null;
	} catch {
		return null;
	}
}

async function handleMessage(client, msg, session) {
	try {
		console.log('📩 ENTER handleMessage');
		const contact = await msg.getContact();
		const phoneNumber = contact.number;
		const phone = normalizePhone(phoneNumber);
		// שליפת השם של המשתמש מוואטסאפ
		const userName = msg.pushname || msg._data?.notifyName || 'לא ידוע';

		const currentState = (session && session.state) ? session.state : 'ANUNIMI';
		const text = msg.body?.trim();

		// הדפסה מעודכנת הכוללת את שם המשתמש
		console.log(`switch- Name: ${userName} | Phone: ${phone} | State: ${currentState} | Text: ${text}`);

		// ===============================
		// ANUNIMI: כניסה לבוט רק אם ההודעה מזכירה "גמ"ח סקי".
		// - טריגר מדויק (וריאציות הפתיח של isTrigger) → startSession עם תפריט.
		// - מזכיר גמ"ח+סקי בצורה חופשית → FREE_CHAT.
		// - אחרת — מתעלמים לחלוטין (זה גם הוואטסאפ הפרטי, לא להגיב על כל הודעה).
		// ===============================
		if (currentState === 'ANUNIMI') {
			if (!text) return;
			if (isTrigger(text)) {
				conversationHistory.appendTurn(phone, 'user', text, currentState, userName);
				await startSession(client, msg, userName);
			} else if (containsGemachSki(text) && process.env.GEMINI_API_KEY) {
				conversationHistory.appendTurn(phone, 'user', text, currentState, userName);
				await handleFreeChat(client, msg, phone, userName);
			} else {
				// הודעה לא קשורה לבוט — שקט (גם בלי תיעוד היסטוריה).
				return;
			}
			return;
		}

		// יש סשן פעיל — מתעדים הודעה (לכל מצב שאינו ANUNIMI)
		if (text) {
			conversationHistory.appendTurn(phone, 'user', text, currentState, userName);
		}

		// ===============================
		// FREE_CHAT: לולאת שיחה חופשית
		// ===============================
		if (currentState === 'FREE_CHAT') {
			if (text && isTrigger(text)) {
				// המשתמש כתב "גמ"ח סקי" בתוך שיחה חופשית — מאפסים ופותחים תפריט
				await startSession(client, msg, userName);
				return;
			}
			await handleFreeChat(client, msg, phone, userName);
			return;
		}

		// ===============================
		// שכבת AI rescue: אם המטפל הקשיח לא יצליח לפרש את ההודעה — ה-AI מתערב.
		// רץ רק כשיש סשן פעיל (לא ב-ANUNIMI) ורק אם יש טקסט.
		// ===============================
		if (text && process.env.GEMINI_API_KEY) {
			try {
				const inventorySnapshot = await loadInventorySnapshot(currentState, phone);
				const history = conversationHistory.getRecentHistory(phone, 10);
				const result = await rescueMessage({
					state: currentState,
					text,
					phone,
					userName,
					inventorySnapshot,
					sessionPayload: session?.payload,
					history,
					source: 'text'
				});

				if (result.action === 'reply') {
					await client.sendMessage(msg.from, result.message);
					conversationHistory.appendTurn(phone, 'bot', result.message, currentState, userName);
					return;
				}
				if (result.action === 'cancel') {
					await sessions.clearSession(phone);
					const goodbye = 'התהליך בוטל\n😊 תודה שהשתמשת בגמ"ח סקי!\n\nעל מנת לשאול, להחזיר או לשריין- רשום מחדש "גמ"ח סקי"';
					await client.sendMessage(msg.from, goodbye);
					conversationHistory.appendTurn(phone, 'bot', goodbye, currentState, userName);
					return;
				}
				if (result.action === 'rewrite' && result.newText) {
					console.log(`🧠 AI rewrite: "${text}" → "${result.newText}"`);
					msg.body = result.newText;
				}
				// passthrough — ממשיך כרגיל
			} catch (aiErr) {
				console.error('❌ שגיאה ב-AI rescue, ממשיך עם הטקסט המקורי:', aiErr.message);
			}
		}

		switch (currentState) {

			case 'BORROW_SELECT':
			case 'RETURN_SELECT':
			case 'RESERVE_SELECT':
				await choice(client, msg, session);
				break;

			case 'BORROW_RETURN_SELECT':
				await handle_Borrow_Return_Select(client, msg, session);
				break;

			case 'RESERVE_DATE':
				await reserveDates(client, msg, session);
				break;

			case 'RESERVE_DATES_CONFIRM':
				await handleReserveDatesConfirm(client, msg, session);
				break;

			case 'BORROW_CONFIRM':
			case 'RETURN_CONFIRM':
			case 'RESERVE_CONFIRM':
				await accept(client, msg, session);
				break;

			default:
				await sessions.clearSession(phone);
				break;
		}

	} catch (err) {
		if (err.message && err.message.includes('Execution context was destroyed')) {
			console.log('⚠️ דף הוואטסאפ התרענן, מתעלם וממשיך...');
		} else {
			console.error('❌ שגיאה ב-handleMessage:', err.message);
		}
	}
}


/* ===================== שיחה חופשית (FREE_CHAT) ===================== */
async function handleFreeChat(client, msg, phone, userName) {
	const from = msg.from;
	const text = msg.body?.trim();
	if (!text) return;

	// טוענים מלאי + פריטי המשתמש כקונטקסט ל-AI
	let inventoryItems = [];
	let userItems = [];
	try {
		const inv = await inventory.getAvailableItems();
		inventoryItems = [...(inv.coats || []), ...(inv.pants || []), ...(inv.additional || [])];
		const mine = await inventory.getBorrowedItemsByPhone(phone);
		userItems = [...(mine.coats || []), ...(mine.pants || []), ...(mine.additional || [])];
	} catch (e) {
		console.error('❌ free chat inventory load failed:', e.message);
	}

	// שומרים סשן FREE_CHAT לפני הקריאה ל-AI — שהודעה כפולה לא תיכנס שוב ל-ANUNIMI
	await sessions.saveSession(phone, 'FREE_CHAT', '');

	const history = conversationHistory.getRecentHistory(phone, 10);
	const result = await runFreeChat({ text, history, inventoryItems, userItems, userName });

	if (!result) {
		const fallback = 'מצטער, לא הצלחתי להבין. אפשר לנסח שוב? לתפריט הראשי עם אפשרויות בחירה — שלח "גמ"ח סקי".';
		await client.sendMessage(from, fallback);
		conversationHistory.appendTurn(phone, 'bot', fallback, 'FREE_CHAT', userName);
		return;
	}

	if (result.tool === 'answer_question') {
		const reply = result.input?.text || 'מצטער, לא הצלחתי לנסח תשובה. נסה שוב.';
		await client.sendMessage(from, reply);
		conversationHistory.appendTurn(phone, 'bot', reply, 'FREE_CHAT', userName);
		return;
	}

	if (result.tool === 'end_chat') {
		const bye = 'בכיף 😊 לכל שאלה או פעולה בעתיד — שלח "גמ"ח סקי".';
		await client.sendMessage(from, bye);
		conversationHistory.appendTurn(phone, 'bot', bye, 'FREE_CHAT', userName);
		await sessions.clearSession(phone);
		conversationHistory.clearHistory(phone);
		return;
	}

	if (result.tool === 'start_action') {
		const action = result.input?.action;
		console.log(`🧠 free chat → start_action: ${action}`);
		if (action === 'borrow') {
			await handleBorrowSelect(client, msg);
		} else if (action === 'return') {
			await handleReturnSelect(client, msg);
		} else if (action === 'reserve') {
			await handleReserveSelect(client, msg);
		} else {
			const fb = 'לא הבנתי איזו פעולה תרצה. אפשר לרשום "גמ"ח סקי" לתפריט עם אפשרויות בחירה.';
			await client.sendMessage(from, fb);
			conversationHistory.appendTurn(phone, 'bot', fb, 'FREE_CHAT', userName);
		}
		return;
	}

	// כלי לא צפוי
	const fb = 'מצטער, התבלבלתי. אפשר לנסח מחדש או לשלוח "גמ"ח סקי" לתפריט.';
	await client.sendMessage(from, fb);
	conversationHistory.appendTurn(phone, 'bot', fb, 'FREE_CHAT', userName);
}


async function startSession(client, msg, session) {
	const contact = await msg.getContact();
	const phoneNumber = contact.number;
	const phone = normalizePhone(phoneNumber);
	const from = msg.from;

	await sessions.saveSession(phone, 'BORROW_RETURN_SELECT', '');

	await sendWhatsAppButtons(client, from, 'ברוך הבא לגמ"ח סקי בגולן 📦\nמה תרצה לבצע?', [
		{ id: 'BORROW', title: 'שאילה' },
		{ id: 'RETURN', title: 'החזרה / ביטול שיריון' },
		{ id: 'RESERVE', title: 'שיריון 📅' },
		{ id: 'FINISH', title: 'ביטול' }
	]);
}

async function handle_Borrow_Return_Select(client, msg, session) {
	const contact = await msg.getContact();
	const phoneNumber = contact.number;
	const phone = normalizePhone(phoneNumber);
	const text = msg.body?.trim();
	const from = msg.from;

	switch (text) {
		case '1':
		case 'שאילה':
			await handleBorrowSelect(client, msg);
			break;

		case '2':
		case 'החזרה':
		case 'ביטול שריון':
		case 'החזרה / ביטול שיריון':
			await handleReturnSelect(client, msg);
			break;

		case '3':
		case 'שיריון':
			await handleReserveSelect(client, msg);
			break;

		case '4':
		case 'ביטול':
			await sessions.clearSession(phone);
			await client.sendMessage(
				from,
				'התהליך בוטל\n😊 תודה שהשתמשת בגמ"ח סקי!\n\nעל מנת להשאיל או להחזיר רשום מחדש "גמ"ח סקי"'
			);
			break;

		default:
			await client.sendMessage(from, '❌בחירה לא תקינה\nאנא שלח את המספר 1 לשאילה, 2 להחזרה/ ביטול שיריון, 3 לשריון או 4 לביטול.');
	}
}

/* ===================== שאילה ===================== */
async function handleBorrowSelect(client, msg, session) {
	const contact = await msg.getContact();
	const phoneNumber = contact.number;
	const phone = normalizePhone(phoneNumber);
	const from = msg.from;
	const items = await inventory.getAvailableItems();

	if (
		!items ||
		(!items.coats?.length &&
			!items.pants?.length &&
			!items.additional?.length)
	) {
		await client.sendMessage(from, 'אין כרגע פריטים זמינים.');
		await sessions.clearSession(phone);
		await client.sendMessage(
			from,
			'התהליך בוטל\n😊 תודה שהשתמשת בגמ"ח סקי!\n\nעל מנת להשאיל או להחזיר רשום מחדש "גמ"ח סקי"'
		);
		return;
	}

	await sessions.saveSession(phone, 'BORROW_SELECT', '');

	let messageList = 'בחר את הפריטים שברצונך לשאול:\n';
	messageList +=
		'✍️ שלח את מספר הפריט/ים *מופרדים בפסיק או רווח* (לדוגמה: 305,310).\n לביטול הפעולה: שלח "ביטול".\n\n';

	// 🔹 פונקציית עזר מעודכנת המזהה שריון אישי (תמיכה בריבוי ערכים)
	const formatItem = item => {
		// 1. פירוק רשימת הטלפונים ומציאת המיקום של המשתמש הנוכחי
		const allPhones = String(item.phoneWattsap || '').split(',').map(p => normalizePhone(p.trim()));
		const myIndex = allPhones.indexOf(phone);
		const isMyReservation = myIndex !== -1;

		// טיפול בסטטוס מושאל+משוריין
		// סדר חדש: משריינים קודם (עם תאריכים), שואל אחרון (בלי תאריך)
		if (item.status === 'מושאל+משוריין') {
			if (isMyReservation) {
				// בודקים אם יש לי תאריך (= אני משריין) או לא (= אני השואל)
				const allFromDates = String(item.reserveFrom || '').split(',');
				const allToDates = String(item.reserveTo || '').split(',');
				const myFrom = allFromDates[myIndex]?.trim();
				const myTo = allToDates[myIndex]?.trim();

				if (myFrom && myTo && myFrom !== 'ללא') {
					// יש לי תאריכים = אני משריין, הפריט מושאל לאחר - לא להציג!
					return null;
				} else {
					// אין לי תאריכים = אני השואל הנוכחי
					const earliestDate = inventory.getEarliestDate(item.reserveFrom);
					const returnBy = earliestDate ? inventory.getDayBefore(earliestDate) : null;
					if (returnBy) {
						return `• *${item.id}* - ${item.name} ⚠️ הפריט משוריין ולכן *חובה עליך להחזירו עד - ${returnBy}*`;
					} else {
						return `• *${item.id}* - ${item.name} ⚠️ *הפריט משוריין - נא להחזיר בהקדם*`;
					}
				}
			}
			// לא שייך לי - חישוב תאריך החזרה מהתאריך המוקדם ביותר
			const earliestDate = inventory.getEarliestDate(item.reserveFrom);
			const returnBy = earliestDate ? inventory.getDayBefore(earliestDate) : null;
			if (returnBy) {
				return `• *${item.id}* - ${item.name} ⚠️ (מושאל כרגע + משוריין – יש להחזיר עד ${returnBy})`;
			} else {
				return `• *${item.id}* - ${item.name} ⚠️ (מושאל כרגע + משוריין)`;
			}
		}

		if (item.status === 'משוריין' && isMyReservation) {
			// 2. חילוץ התאריכים התואמים למשתמש הספציפי לפי אותו אינדקס
			const allFromDates = String(item.reserveFrom || '').split(',');
			const allToDates = String(item.reserveTo || '').split(',');

			const myFrom = allFromDates[myIndex]?.trim() || item.reserveFrom;
			const myTo = allToDates[myIndex]?.trim() || item.reserveTo;

			return `• *${item.id}* - ${item.name} ⚠️ פריט זה (${item.id}) משוריין על שמך בין התאריכים ${myFrom}-${myTo}, בחירה של הפריט משמעותה העברת הפריט לרשימת הפריטים השאולים ומחיקת השיריון.`;
		}

		if (item.status === 'משוריין') {
			// חישוב תאריך החזרה מהתאריך המוקדם ביותר
			const earliestDate = inventory.getEarliestDate(item.reserveFrom);
			const returnBy = earliestDate ? inventory.getDayBefore(earliestDate) : null;
			if (returnBy) {
				return `• *${item.id}* - ${item.name} ⚠️ הפריט משוריין ולכן *חובה עליך להחזירו עד - ${returnBy}*`;
			} else {
				return `• *${item.id}* - ${item.name} ⚠️ *הפריט משוריין - נא להחזיר בהקדם*`;
			}
		}

		return `• *${item.id}* - ${item.name}`;
	};

	if (items.coats.length)
		messageList +=
			'*מעילים זמינים 🧥:*\n' +
			items.coats.map(formatItem).filter(Boolean).join('\n') +
			'\n\n';

	if (items.pants.length)
		messageList +=
			'*מכנסיים זמינים 👖:*\n' +
			items.pants.map(formatItem).filter(Boolean).join('\n') +
			'\n\n';

	if (items.additional.length)
		messageList +=
			'*פריטים נוספים 🎒:*\n' +
			items.additional.map(formatItem).filter(Boolean).join('\n') +
			'\n\n';

	await client.sendMessage(from, messageList);
}


/* ===================== החזרה ===================== */
async function handleReturnSelect(client, msg, session) {
	const contact = await msg.getContact();
	const phoneNumber = contact.number;
	const phone = normalizePhone(phoneNumber);
	const from = msg.from;
	const items = await inventory.getBorrowedItemsByPhone(phone);

	const totalitems =
		(items.coats?.length || 0) +
		(items.pants?.length || 0) +
		(items.additional?.length || 0);

	if (totalitems === 0) {
		await client.sendMessage(from, 'לא נמצאו פריטים שאולים או משוריינים על שמך.');
		await startSession(client, msg, session);
		return;
	}

	await client.sendMessage(
		from,
		`הטלפון זוהה, מצאתי ${totalitems} פריטים שרשומים על שמך. התהליך ממשיך...`
	);
	await sessions.saveSession(phone, 'RETURN_SELECT', '');

	let messageList = 'הנה הציוד המושאל על שמך. בחר מה ברצונך להחזיר/ לבטל:\n\n';

	// 🔹 פונקציית עזר מעודכנת לעיצוב הפריט - תמיכה בריבוי ערכים
	const formatItem = item => {
		// 1. פירוק רשימת הטלפונים מהגיליון ומציאת המיקום (אינדקס) של המשתמש הנוכחי
		const allPhones = String(item.phoneWattsap || '').split(',').map(p => normalizePhone(p.trim()));
		const myIndex = allPhones.indexOf(phone);
		const isMyReservation = myIndex !== -1;

		// טיפול בסטטוס מושאל+משוריין
		// סדר חדש: משריינים קודם (עם תאריכים), שואל אחרון (בלי תאריך)
		if (item.status === 'מושאל+משוריין') {
			
		
			const allFromDates = String(item.reserveFrom || '').split(',');
			const allToDates = String(item.reserveTo || '').split(',');

			const myFrom = allFromDates[myIndex]?.trim();
			const myTo = allToDates[myIndex]?.trim();
			
			const earliestDate = inventory.getEarliestDate(item.reserveFrom);
			const returnBy = earliestDate ? inventory.getDayBefore(earliestDate) : null;
			
			
				
			if (isMyReservation) {
				// בודקים אם יש לי תאריך (= אני משריין) או לא (= אני השואל)();

				if (myFrom && myTo && myFrom !== 'ללא' && myTo !== 'ללא') {
					// אני משריין - יש לי תאריכים
					return `• *${item.id}* - ${item.name} ⚠️ פריט זה משוריין על שמך לתאריכים ${myFrom}-${myTo} אך מושאל כרגע למישהו אחר. ביטול השריון יסיר אותך מהרשימה.`;
				} else {
					
					if (returnBy) {
						return `• *${item.id}* - ${item.name} ⚠️ הפריט משוריין ולכן *חובה עליך להחזירו עד - ${returnBy}*`;
					} else {
						return `• *${item.id}* - ${item.name} ⚠️ *הפריט משוריין - נא להחזיר בהקדם*`;
					}
					
					
				}
			}
		}

		if (item.status === 'משוריין' && isMyReservation) {
			// 2. חילוץ התאריכים התואמים למשתמש הספציפי לפי אותו אינדקס
			const allFromDates = String(item.reserveFrom || '').split(',');
			const allToDates = String(item.reserveTo || '').split(',');

			const myFrom = allFromDates[myIndex]?.trim() || item.reserveFrom;
			const myTo = allToDates[myIndex]?.trim() || item.reserveTo;

			return `• *${item.id}* - ${item.name} ⚠️ פריט זה (${item.id}) משוריין על שמך בין התאריכים ${myFrom}-${myTo}, בחירה של הפריט משמעותה ביטול השיריון של הפריט.`;
		}
		// פריט שאול על ידי המשתמש אבל משוריין על מישהו אחר
		if (item.status === 'משוריין') {


					const earliestDate = inventory.getEarliestDate(item.reserveFrom);
					const returnBy = earliestDate ? inventory.getDayBefore(earliestDate) : null;

					if (returnBy) {
						return `• *${item.id}* - ${item.name} ⚠️ הפריט משוריין ולכן *חובה עליך להחזירו עד - ${returnBy}*`;
					} else {
						return `• *${item.id}* - ${item.name} ⚠️ *הפריט משוריין - נא להחזיר בהקדם*`;
					}
					
		}

		return `• *${item.id}* - ${item.name}`;
	};

	if (items.coats.length)
		messageList +=
			'*מעילים 🧥:*\n' +
			items.coats.map(formatItem).join('\n') +
			'\n\n';
			
	if (items.pants.length)
		messageList +=
			'*מכנסיים 👖:*\n' +
			items.pants.map(formatItem).join('\n') +
			'\n\n';
			
	if (items.additional.length)
		messageList +=
			'*פריטים נוספים 🎒:*\n' +
			items.additional.map(formatItem).filter(Boolean).join('\n') +
			'\n\n';
			
	messageList += '*נא לשלוח את מספרי המזהה של הפריטים שחזרו (מופרדים בפסיק או רווח)*\n';
	messageList += '💡 *לבחירת כל הפריטים שלח: "הכול"*';
	await client.sendMessage(from, messageList);
}


/* ===================== שיריון ===================== */
async function handleReserveSelect(client, msg, session) {
	const contact = await msg.getContact();
	const phoneNumber = contact.number;
	const phone = normalizePhone(phoneNumber);
	const from = msg.from;
	const items = await inventory.getAvailableItems();

	if (
		!items ||
		(!items.coats?.length &&
			!items.pants?.length &&
			!items.additional?.length)
	) {
		await client.sendMessage(from, 'אין כרגע פריטים זמינים.');
		await sessions.clearSession(phone);
		return;
	}

	await sessions.saveSession(phone, 'RESERVE_SELECT', '');

	let messageList = 'בחר את הפריטים שברצונך לשריין:\n';
	messageList +=
		'✍️ שלח את מספר הפריט/ים *מופרדים בפסיק או רווח* (לדוגמה: 305,310).\n לביטול הפעולה: שלח "ביטול".\n\n';

	const formatItem = item => {
		// 🔥 עדכון: בדיקת בעלות על שריון מתוך רשימת טלפונים (split)
		const allPhones = String(item.phoneWattsap || '').split(',').map(p => normalizePhone(p.trim()));
		const isMyReservation = allPhones.includes(phone);

		// 1. אם הפריט כבר משוריין על שמי (מופיע ברשימה) - אנחנו לא מציגים אותו ברשימת השריון
		if (isMyReservation) {
			return null;
		}

		// 2. טיפול בסטטוס מושאל+משוריין
		if (item.status === 'מושאל+משוריין') {
			return `• *${item.id}* - ${item.name} ⚠️ מושאל כרגע + משוריין – לא ניתן לשריין כעת (מושאל ויש שריון עתידי)`;
		}

		// 3. אם הפריט משוריין לאחרים - מציגים אותו עם אזהרת החזרה
		if (item.status === 'משוריין') {
			// חישוב תאריך החזרה מהתאריך המוקדם ביותר
			const earliestDate = inventory.getEarliestDate(item.reserveFrom);
			const returnBy = earliestDate ? inventory.getDayBefore(earliestDate) : null;
			const endDate = String(item.reserveTo || '').split(',').pop()?.trim() || item.reserveTo;

			if (returnBy) {
				return `• *${item.id}* - ${item.name} ⚠️ משוריין – השריון מותנה בכך שתחזיר עד ${returnBy}, או לחילופין שתשריין החל מ- ${endDate}`;
			} else {
				return `• *${item.id}* - ${item.name} ⚠️ משוריין – אנא התעדכן לגבי תאריכי השריון`;
			}
		}

		// 4. פריט פנוי לחלוטין
		return `• *${item.id}* - ${item.name}`;
	};

	// פונקציית עזר לסינון פריטים שהחזירו null (אלו שמשוריינים עלי)
	const renderList = (list) => list.map(formatItem).filter(Boolean).join('\n');

	if (items.coats.length) {
		const list = renderList(items.coats);
		if (list) messageList += '*מעילים זמינים 🧥:*\n' + list + '\n\n';
	}

	if (items.pants.length) {
		const list = renderList(items.pants);
		if (list) messageList += '*מכנסיים זמינים 👖:*\n' + list + '\n\n';
	}

	if (items.additional.length) {
		const list = renderList(items.additional);
		if (list) messageList += '*פריטים נוספים 🎒:*\n' + list + '\n\n';
	}

	await client.sendMessage(from, messageList);
}


// הודעת אישור לכלל הפעולות שאילה / החזרה / שריון
async function choice(client, msg, session) {
	const contact = await msg.getContact();
	const phoneNumber = contact.number;
	const phone = normalizePhone(phoneNumber);
	const from = msg.from;
	const text = msg.body?.trim();
	const currentState = session.state;

	if (!text) return;

	// ביטול תהליך
	if (text === 'ביטול') {
		await sessions.clearSession(phone);
		await client.sendMessage(from, 'התהליך בוטל\n😊 תודה שהשתמשת בגמ"ח סקי!\n\nעל מנת לשאול, להחזיר או לשריין- רשום מחדש "גמ"ח סקי"');
		return;
	}

	// קבלת פריטים לפי מצב
	let categorizedItems = currentState === 'RETURN_SELECT'
		? await inventory.getBorrowedItemsByPhone(phone)
		: await inventory.getAvailableItems();

	// 🔥 סינון פריטים עבור שריון - לא להראות פריטים שכבר משוריינים על המשתמש
	if (currentState === 'RESERVE_SELECT') {
		const filterOutMine = (list) =>
			list.filter(i => {
				const allPhones = String(i.phoneWattsap || '').split(',').map(p => normalizePhone(p.trim()));
				return !allPhones.includes(phone);
			});
		categorizedItems.coats = filterOutMine(categorizedItems.coats);
		categorizedItems.pants = filterOutMine(categorizedItems.pants);
		categorizedItems.additional = filterOutMine(categorizedItems.additional);
	}

	const allItems = [
		...categorizedItems.coats,
		...categorizedItems.pants,
		...categorizedItems.additional
	];

	// בדיקה אם המשתמש רוצה את כל הפריטים (רק בהחזרה)
	let items;
	if (currentState === 'RETURN_SELECT' && (text === 'הכול' | text === 'הכל' || text === 'כלם' || text === 'כולם' || text.toLowerCase() === 'all')) {
		if (allItems.length === 0) {
			await client.sendMessage(from, '❌ אין פריטים להחזיר.');
			return;
		}
		items = allItems;
		await client.sendMessage(from, `✅ נבחרו כל הפריטים (${items.length} פריטים)`);
	} else {
		const validation = validateSelection(text, allItems);

		if (!validation.valid || !validation.valid.length) {
			await client.sendMessage(from, `❌ ${validation.message || 'בחירה לא תקינה'}`);
			return;
		}

		items = validation.valid;
	}

	// בדיקת תקינות: בשאילה - לא לאפשר פריטים שהם מושאל+משוריין שבהם המשתמש הוא משריין
	if (currentState === 'BORROW_SELECT') {
		const invalidItems = [];
		items = items.filter(item => {
			if (item.status === 'מושאל+משוריין') {
				const phones = String(item.phoneWattsap || '').split(',').map(p => normalizePhone(p.trim()));
				const myIndex = phones.indexOf(phone);
				if (myIndex !== -1) {
					const fromDates = String(item.reserveFrom || '').split(',');
					const toDates = String(item.reserveTo || '').split(',');
					const myFrom = fromDates[myIndex]?.trim();
					const myTo = toDates[myIndex]?.trim();
					if (myFrom && myTo && myFrom !== 'ללא') {
						// יש לי תאריכים = אני משריין, הפריט מושאל לאחר
						invalidItems.push(item.id);
						return false;
					}
				}
			}
			return true;
		});

		if (invalidItems.length > 0) {
			await client.sendMessage(from, `❌ פריטים לא תקינים: ${invalidItems.join(', ')}\nפריטים אלו מושאלים כרגע למישהו אחר ולא ניתן לשאול אותם.\nנא לבחור פריטים אחרים.`);
			return;
		}
	}

	if (items.length === 0) {
		await client.sendMessage(from, '❌ לא נבחרו פריטים תקינים.');
		return;
	}

	const nextState = currentState === 'RESERVE_SELECT' ? 'RESERVE_DATE'
		: currentState === 'BORROW_SELECT' ? 'BORROW_CONFIRM'
		: 'RETURN_CONFIRM';
	const peula = nextState === 'RESERVE_DATE' ? 'לשריין' : nextState === 'BORROW_CONFIRM' ? 'לשאול' : 'להחזיר';

	await sessions.saveSession(
		phone,
		nextState,
		`${items.map(i => i.id).join(',')}##${items.map(i => `${i.id} - ${i.name}`).join(' | ')}`
	);

	// סיווג פריטים לפי סטטוס ובעלות
	const availableItems = [];
	const borrowedItems = [];
	const myReservedItems = [];
	const othersReservedItems = [];

	for (const item of items) {
		const phones = String(item.phoneWattsap || '').split(',').map(p => normalizePhone(p.trim()));
		const myIndex = phones.indexOf(phone);
		const isInList = myIndex !== -1;

		if (item.status === 'במלאי') {
			availableItems.push(item);
		} else if (item.status === 'מושאל') {
			borrowedItems.push(item);
		} else if (item.status === 'מושאל+משוריין') {
			if (isInList) {
				const fromDates = String(item.reserveFrom || '').split(',');
				const toDates = String(item.reserveTo || '').split(',');
				const myFrom = fromDates[myIndex]?.trim();
				const myTo = toDates[myIndex]?.trim();

				if (myFrom && myTo && myFrom !== 'ללא') {
					// יש לי תאריכים = אני משריין
					myReservedItems.push({ ...item, myFrom, myTo });
				} else {
					// אין לי תאריכים = אני השואל
					borrowedItems.push(item);
				}
			} else {
				// לא ברשימה = משוריין על אחרים
				othersReservedItems.push(item);
			}
		} else if (item.status === 'משוריין') {
			if (isInList) {
				const fromDates = String(item.reserveFrom || '').split(',');
				const toDates = String(item.reserveTo || '').split(',');
				myReservedItems.push({
					...item,
					myFrom: fromDates[myIndex]?.trim(),
					myTo: toDates[myIndex]?.trim()
				});
			} else {
				othersReservedItems.push(item);
			}
		}
	}

	// פונקציית עזר להצגת פריטים עם אזהרות
	const formatItemsWithWarnings = (itemsList, showWarnings = true) => {
		const coats = itemsList.filter(i => i.name.includes('מעיל'));
		const pants = itemsList.filter(i => i.name.includes('מכנס'));
		const additional = itemsList.filter(i => !i.name.includes('מעיל') && !i.name.includes('מכנס'));

		let out = '';

		if (coats.length) {
			out += '*מעילים 🧥:*\n';
			coats.forEach(i => {
				out += `* ${i.id} - ${i.name}`;
				if (showWarnings && i.myFrom && i.myTo && i.myTo !== 'ללא') {
					out += ` ⚠️ פריט זה (${i.id}) משוריין על שמך בין התאריכים ${i.myFrom}-${i.myTo}, בחירה של הפריט משמעותה `;
					out += currentState === 'BORROW_SELECT'
						? 'העברת הפריט לרשימת הפריטים השאולים ומחיקת השיריון.'
						: 'ביטול השיריון של הפריט.';
				} else if (showWarnings && (i.status === 'משוריין' || i.status === 'מושאל+משוריין')) {
					const earliestDate = inventory.getEarliestDate(i.reserveFrom);
					const returnBy = earliestDate ? inventory.getDayBefore(earliestDate) : i.reserveReturnBy;
					if (returnBy) {
						out += ` ⚠️ הפריט משוריין ולכן חובה עליך להחזירו עד - ${returnBy}`;
					}
				}
				out += '\n';
			});
			out += '\n';
		}

		if (pants.length) {
			out += '*מכנסיים 👖:*\n';
			pants.forEach(i => {
				out += `* ${i.id} - ${i.name}`;
				if (showWarnings && i.myFrom && i.myTo && i.myTo !== 'ללא') {
					out += ` ⚠️ פריט זה (${i.id}) משוריין על שמך בין התאריכים ${i.myFrom}-${i.myTo}, בחירה של הפריט משמעותה `;
					out += currentState === 'BORROW_SELECT'
						? 'העברת הפריט לרשימת הפריטים השאולים ומחיקת השיריון.'
						: 'ביטול השיריון של הפריט.';
				} else if (showWarnings && (i.status === 'משוריין' || i.status === 'מושאל+משוריין')) {
					const earliestDate = inventory.getEarliestDate(i.reserveFrom);
					const returnBy = earliestDate ? inventory.getDayBefore(earliestDate) : i.reserveReturnBy;
					if (returnBy) {
						out += ` ⚠️ הפריט משוריין ולכן חובה עליך להחזירו עד - ${returnBy}`;
					}
				}
				out += '\n';
			});
			out += '\n';
		}

		if (additional.length) {
			out += '*פריטים נוספים 🎒:*\n';
			additional.forEach(i => {
				out += `* ${i.id} - ${i.name}`;
				if (showWarnings && i.myFrom && i.myTo && i.myTo !== 'ללא') {
					out += ` ⚠️ פריט זה (${i.id}) משוריין על שמך בין התאריכים ${i.myFrom}-${i.myTo}, בחירה של הפריט משמעותה `;
					out += currentState === 'BORROW_SELECT'
						? 'העברת הפריט לרשימת הפריטים השאולים ומחיקת השיריון.'
						: 'ביטול השיריון של הפריט.';
				} else if (showWarnings && (i.status === 'משוריין' || i.status === 'מושאל+משוריין')) {
					const earliestDate = inventory.getEarliestDate(i.reserveFrom);
					const returnBy = earliestDate ? inventory.getDayBefore(earliestDate) : i.reserveReturnBy;
					if (returnBy) {
						out += ` ⚠️ הפריט משוריין ולכן חובה עליך להחזירו עד - ${returnBy}`;
					}
				}
				out += '\n';
			});
			out += '\n';
		}

		return out;
	};

	let message = `✅ *בחרת ${peula} את הפריטים הבאים:*\n\n`;

	// הצגה לפי סוג הפעולה
	if (currentState === 'RETURN_SELECT') {
		// החזרה
		const allReturnItems = [...borrowedItems, ...myReservedItems, ...othersReservedItems];
		message += formatItemsWithWarnings(allReturnItems, true);
	} else if (currentState === 'BORROW_SELECT') {
		// שאילה
		const allBorrowItems = [...availableItems, ...myReservedItems, ...othersReservedItems];
		message += formatItemsWithWarnings(allBorrowItems, true);
	} else if (currentState === 'RESERVE_SELECT') {
		// שריון
		const allReserveItems = [...availableItems, ...othersReservedItems];
		message += formatItemsWithWarnings(allReserveItems, true);
	}

	await sendWhatsAppButtons(client, from, message + 'האם לאשר?', [
		{ id: 'CONFIRM', title: 'אישור' },
		{ id: 'CANCEL', title: 'ביטול' }
	]);
}



// בחירת תאריכים לשריון
async function reserveDates(client, msg, session) {
	const contact = await msg.getContact();
	const phoneNumber = contact.number;
	const phone = normalizePhone(phoneNumber);
	const from = msg.from;
	const text = msg.body?.trim();
	const currentState = session.state;
	
	if (!text) return;

	if (text === 'ביטול' || text === '2') {
		await sessions.clearSession(phone);
		await client.sendMessage(
			from,
			'התהליך בוטל\n😊 תודה שהשתמשת בגמ"ח סקי!\n\nעל מנת לשאול, להחזיר או לשריין- רשום מחדש "גמ"ח סקי"'
		);
		return;
	}
	
	if (text === 'אישור' || text === '1') {


	await sessions.saveSession(
		phone,
		'RESERVE_DATES_CONFIRM',
		session.payload
	);
	
	await client.sendMessage(
		from,
		'נא לשלוח תאריך התחלה ותאריך סיום באותה ההודעה\nלדוגמה: *12.02.26 עד 18.02.26*'
	);
	}
}

// פונקציית עזר להמרת מחרוזת תאריך (DD/MM/YYYY) לאובייקט Date
function parseDate(dateStr) {
    if (!dateStr) return null;
    const parts = dateStr.trim().split('/');
    if (parts.length !== 3) return null;

    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const year = parseInt(parts[2], 10);

    // יצירת אובייקט תאריך
    const d = new Date(year, month - 1, day);

    // בדיקה שהתאריך חוקי:
    // ב-JS, אם תיתן יום 33, הוא יקפוץ אוטומטית לחודש הבא. 
    // לכן בודקים אם היום, החודש והשנה נשארו זהים למה שהכנסנו.
    if (d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day) {
        return d;
    }
    
    return null; // תאריך לא תקין (כמו 33/01)
}



// בדיקת תאריכים לשריון
async function handleReserveDatesConfirm(client, msg, session) {
    const contact = await msg.getContact();
    const phoneNumber = contact.number;
    const phone = normalizePhone(phoneNumber);
    const from = msg.from;
    const text = (msg.body || '').trim();

    if (!text) return;
    if (text === 'ביטול' || text === '2') {
        await sessions.clearSession(phone);
        await client.sendMessage(from, 'התהליך בוטל\n😊 תודה שהשתמשת בגמ"ח סקי!\n\nעל מנת להשאיל או להחזיר רשום מחדש "גמ"ח סקי"');
        return;
    }
            
    const dateMatches = text.match(/\d{1,2}[\/\\.]\d{1,2}[\/\\.]\d{2,4}/g);

    if (!dateMatches || dateMatches.length < 2) {
        await client.sendMessage(from, '❌ לא הצלחתי למצוא שני תאריכים.\nנא לשלוח תאריך התחלה ותאריך סיום.\nלדוגמה: *12/02/2026 עד 18/02/2026*');
        return;
    }	

    const formatToStandardDate = (dateStr) => {
        let normalizedDate = dateStr.replace(/[\.\\\s]/g, '/'); 
        let parts = normalizedDate.split('/');
        if (parts[2].length === 2) parts[2] = '20' + parts[2];
        parts[0] = parts[0].padStart(2, '0');
        parts[1] = parts[1].padStart(2, '0');
        return parts.join('/');
    };
                
    const reserveFrom = formatToStandardDate(dateMatches[0]);
    const reserveTo = formatToStandardDate(dateMatches[1]);

    // --- לוגיקת בדיקות 2026 ---
    const startDate = parseDate(reserveFrom);
    const endDate = parseDate(reserveTo);
	
	// בדיקה אם אחד התאריכים לא חוקי (למשל 33/01/2026)
	if (!startDate || !endDate) {
		await client.sendMessage(from, '❌ אחד התאריכים ששלחת אינו תקין (למשל: יום או חודש לא קיימים).\nנא לשלוח תאריכים חוקיים בפורמט 01.01.26.');
		return;
	}
	
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // א. תאריך סיום אחרי התחלה
    if (endDate < startDate) {
        await client.sendMessage(from, '❌ תאריך הסיום לא יכול להיות לפני תאריך ההתחלה.');
        return;
    }

    // ב. תאריך התחלה לפחות 3 ימים מהיום (23/01/2026)
    const minStart = new Date(today);
    minStart.setDate(today.getDate() + 3);
    if (startDate < minStart) {
        await client.sendMessage(from, `❌ שריון חייב להתחיל לפחות 3 ימים מהיום. התאריך המוקדם ביותר: ${minStart.toLocaleDateString('he-IL')}`);
        return;
    }

    // ג. תאריך סיום עד 3 חודשים קדימה
    const maxLimit = new Date(today);
    maxLimit.setMonth(today.getMonth() + 3);
    if (endDate > maxLimit) {
        await client.sendMessage(from, `❌ לא ניתן לשריין מעבר ל-3 חודשים קדימה (עד ${maxLimit.toLocaleDateString('he-IL')})`);
        return;
    }

    // ד. משך השריון עד שבועיים
    const diffTime = Math.abs(endDate - startDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
    if (diffDays > 14) {
        await client.sendMessage(from, '❌ לא ניתן לשריין לתקופה העולה על שבועיים (14 יום).');
        return;
    }

    // ה. בדיקת חפיפה מול שריונים קיימים בגיליון ניהול
    const [idsPart] = session.payload.split('##');
    const selectedIds = idsPart.split(',').map(id => id.trim());
    
    const inventoryData = await inventory.getAvailableItems();
    const allItems = [...inventoryData.coats, ...inventoryData.pants, ...inventoryData.additional];
    
    const unavailableItems = [];
    for (const id of selectedIds) {
        const item = allItems.find(i => i.id === id);
        // שימוש בפונקציית העזר שנמצאת ב-inventory.js
        if (item && inventory.hasDateOverlap(item, reserveFrom, reserveTo)) {
            unavailableItems.push(id);
        }
    }

    if (unavailableItems.length > 0) {
        await client.sendMessage(from, `❌ הפריט/ים הבאים כבר משוריינים בתאריכים שביקשת: ${unavailableItems.join(', ')} כפי שפורט בהודעה הקודמת.\nנא לשלוח תאריכים אחרים.`);
        return;
    }

    // שמירה בסשן ומעבר לאישור
    await sessions.saveSession(phone, 'RESERVE_CONFIRM', session.payload, reserveFrom, reserveTo);

    const message = 
        `📅 *סיכום שיריון:*\n` +
        `תחילת שיריון: ${reserveFrom}\n` +
        `סיום שיריון: ${reserveTo}\n\n` +
        `האם ברצונך לאשר?`;

    await sendWhatsAppButtons(client, from, message, [
        { id: 'CONFIRM', title: 'אישור' },
        { id: 'CANCEL', title: 'ביטול' }
    ]);
}


// ביצוע הפעולות בפועל לאחר קבלת האישור
async function accept(client, msg, session)
{
	const contact = await msg.getContact();
	const phoneNumber = contact.number;
	const phone = normalizePhone(phoneNumber);
    const text = msg.body?.trim();
	const from = msg.from;
	const currentState = session.state;
	
    if (!text) return;

	if (text ==='ביטול' || text ==='2')
	{
		await sessions.clearSession(phone);
		await client.sendMessage(from, 'התהליך בוטל\n😊 תודה שהשתמשת בגמ"ח סקי!\n\nעל מנת להשאיל או להחזיר רשום מחדש "גמ"ח סקי"');
		return;
	}
	else
	{
		if (text ==='אישור' || text ==='1' || text === 'CONFIRM')
		{ 
			if (!session.payload || !session.payload.includes('##')) {
				await client.sendMessage(from, '❌ שגיאה בתהליך. אנא התחל מחדש.');
				await sessions.clearSession(phone);
				return;
			}

			const [itemsStr, namesStr] = session.payload.split('##');
			const finalIds = itemsStr.split(',').map(x => x.trim());
			const details = namesStr.split(' | ').map(row => {
				const [id, ...nameParts] = row.split(' - ');
				return { id: id.trim(), name: nameParts.join(' - ').trim() };
			});

			const contact = await msg.getContact();

			const responseData = {
				action: '',
				userName: contact.pushname || msg.notifyName || 'לא ידוע',
				phone: phone,
				returnDate: '',
				coats: '',
				pants: '',
				additional: '',
				returnItems: '',
				reserveItems: '',
				reserveFrom: '',
				reserveTo: '',
				reserveItemsCancel: '',
				itemsThatWereReserved: '' // שדה עזר חדש לביטול אוטומטי
			};
			await client.sendMessage(from, 'מטפל בבקשתך, התהליך ממשיך...');


			// --- טיפול בשאילת ציוד ---
			if (currentState === 'BORROW_CONFIRM') {
				// שליפת המידע המלא על הפריטים כדי לזהות שריונים אישיים
				const availableItems = await inventory.getAvailableItems();
				const allAvailable = [
					...availableItems.coats,
					...availableItems.pants,
					...availableItems.additional
				];

				const itemsToCancelAuto = [];

				// בדיקה עבור כל פריט שנבחר: האם הוא משוריין על השואל?
				finalIds.forEach(id => {
					const item = allAvailable.find(i => i.id === id);
					if (item && item.status === 'משוריין') {
						// 🔥 שינוי כאן: פירוק רשימת הטלפונים ובדיקה אם הטלפון הנוכחי נמצא בה
						const phonesList = String(item.phoneWattsap || '').split(',').map(p => normalizePhone(p.trim()));
						if (phonesList.includes(phone)) {
							itemsToCancelAuto.push(id);
						}
					}
				});

				const allBorrowedItems = formatIds(finalIds);

				// יומן פעולות
				await inventory.addToLog({
					actionType: 'שאילת ציוד',
					userName: contact.pushname || msg.notifyName || 'לא ידוע',
					phone: phone,
					items: allBorrowedItems
				});

				// עדכון מלאי - העברת פריטים משוריינים לשאולים
				if (itemsToCancelAuto.length > 0) {
					await inventory.updateInventory({
						phone: phone,
						userName: contact.pushname || msg.notifyName || 'לא ידוע',
						action: 'move',
						items: formatIds(itemsToCancelAuto)
					});
				}

				// עדכון מלאי - הוספת פריטים שאולים (שלא היו משוריינים)
				const newBorrowedItems = finalIds.filter(id => !itemsToCancelAuto.includes(id));
				if (newBorrowedItems.length > 0) {
					const borrowData = {
						phone: phone,
						userName: contact.pushname || msg.notifyName || 'לא ידוע',
						action: 'add',
						borrowedItems: formatIds(newBorrowedItems)
					};
					console.log(`🔍 BORROW_CONFIRM - שולח לupdateInventory:`, JSON.stringify(borrowData, null, 2));
					await inventory.updateInventory(borrowData);
				}
			}
						
			// --- טיפול בהחזרת ציוד (כולל ביטול שריון ידני) ---
			if (currentState === 'RETURN_CONFIRM') {
				const borrowedItems = await inventory.getBorrowedItemsByPhone(phone)
					|| { coats: [], pants: [], additional: [] };

				const allBorrowed = borrowedItems.coats.concat(borrowedItems.pants, borrowedItems.additional);

				// 🔥 תיקון: שליפת פריטים זמינים למקרה שהמשתמש שאל פריט משוריין של אחר
				const availableItems = await inventory.getAvailableItems();
				const allAvailable = [
					...availableItems.coats,
					...availableItems.pants,
					...availableItems.additional
				];

				const finalReturnItems = [];
				const reserveItemsCancel = [];

				finalIds.forEach(id => {
					// חיפוש בפריטים שלי
					let item = allBorrowed.find(i => i.id === id);

					// אם לא נמצא - חיפוש בפריטים זמינים (מקרה של שאילה של פריט משוריין של אחר)
					if (!item) {
						item = allAvailable.find(i => i.id === id);
					}

					if (!item) return;

					// טיפול מדויק בסטטוסים
					if (item.status === 'מושאל') {
						// פריט מושאל רגיל
						finalReturnItems.push(item);
					} else if (item.status === 'מושאל+משוריין') {
						// בדיקה אם המשתמש הוא משריין או השואל
						const phones = String(item.phoneWattsap || '').split(',').map(p => normalizePhone(p.trim()));
						const myIndex = phones.indexOf(phone);

						if (myIndex !== -1) {
							const fromDates = String(item.reserveFrom || '').split(',');
							const toDates = String(item.reserveTo || '').split(',');
							const myFrom = fromDates[myIndex]?.trim();
							const myTo = toDates[myIndex]?.trim();

							if (myFrom && myTo && myFrom !== 'ללא') {
								// יש לי תאריכים = אני משריין - ביטול שריון
								reserveItemsCancel.push(item);
							} else {
								// אין לי תאריכים = אני השואל - החזרת פריט
								finalReturnItems.push(item);
							}
						} else {
							// לא ברשימה - לא צריך לקרות אבל לכל מקרה
							finalReturnItems.push(item);
						}
					} else if (item.status === 'משוריין') {
						// פריט משוריין רגיל - ביטול שריון
						reserveItemsCancel.push(item);
					}
				});
				
				// יומן פעולות - החזרה
				if (finalReturnItems.length > 0) {
					await inventory.addToLog({
						actionType: 'החזרת ציוד',
						userName: contact.pushname || msg.notifyName || 'לא ידוע',
						phone: phone,
						items: formatIds(finalReturnItems.map(i => i.id))
					});

					// עדכון מלאי - הסרת פריטים שהוחזרו
					await inventory.updateInventory({
						phone: phone,
						userName: contact.pushname || msg.notifyName || 'לא ידוע',
						action: 'remove',
						borrowedItems: formatIds(finalReturnItems.map(i => i.id))
					});
				}

				// יומן פעולות - ביטול שריון
				if (reserveItemsCancel.length > 0) {
					await inventory.addToLog({
						actionType: 'ביטול שריון',
						userName: contact.pushname || msg.notifyName || 'לא ידוע',
						phone: phone,
						items: formatIds(reserveItemsCancel.map(i => i.id))
					});

					// עדכון מלאי - הסרת פריטים משוריינים + תאריכים
					await inventory.updateInventory({
						phone: phone,
						userName: contact.pushname || msg.notifyName || 'לא ידוע',
						action: 'remove',
						reservedItems: formatIds(reserveItemsCancel.map(i => i.id))
					});
				}
			}

			// --- טיפול בשריון ציוד ---
			if (currentState === 'RESERVE_CONFIRM') {
				const categories = ['מסיכת סקי','גוגלס','נעליים','כפפות','חרמונית','קסדה','מעיל','מכנס'];
				const additional = details.filter(i => categories.some(cat => i.name.includes(cat))).map(i => i.id);

				// יומן פעולות
				await inventory.addToLog({
					actionType: 'שריון ציוד',
					userName: contact.pushname || msg.notifyName || 'לא ידוע',
					phone: phone,
					items: formatIds(additional)
				});

				// עדכון מלאי - הוספת שריון עם תאריכים
				// תאריך אחד לכל השורה (לא לכל פריט)
				const reserveData = {
					phone: phone,
					userName: contact.pushname || msg.notifyName || 'לא ידוע',
					action: 'add',
					reservedItems: formatIds(additional),
					reserveDatesFrom: session.reserveFrom,
					reserveDatesTo: session.reserveTo
				};

				console.log(`🔍 RESERVE_CONFIRM - שולח לupdateInventory:`, JSON.stringify(reserveData, null, 2));

				await inventory.updateInventory(reserveData);
			}

			await client.sendMessage(from, 'הפעולה בוצעה בהצלחה ✅\nיום טוב 😊\nאם ברצונך לשאול, לשריין או להחזיר פריטים נוספים, רשום: "גמ"ח סקי"');
			await sessions.clearSession(phone);
			return;
		} 
		else
		{
			await client.sendMessage(from, `❌בחירה לא תקינה\nאנא שלח את המספר 1 לאישור או 2 לביטול.`);
		}
	}
}



function formatIds(ids) {
	if (!Array.isArray(ids) || !ids.length) return '';
	return `,${ids.join(',')},`;
}


module.exports = { handleMessage };