// ================= تنظیمات اصلی =================
const TOKEN = '8452962087:AAH-WX6MIxTuBNj0YS6YkrwhMjlavT-9uaU';
const ADMIN_ID = 8081586840;
const CARD_NUMBER = "6037-9973-7667-2938 بنام علی فرجی";
const SUPPORT_ID = "@mrpcdesigner";
const PIC_UPDATE_SUB = "https://example.com/update_sub_tutorial.jpg";
const PIC_V2BOX_SETUP = "https://example.com/v2box_setup_tutorial.jpg";
const CF_ADMIN_PATH = "my-secret-admin-9988";
const CF_ADMIN_TOKEN = "admin12345";

// قیمت‌گذاری پلن‌ها (به تومان)
const PLAN_PRICES = {
  1: 10000,
  5: 30000,
  10: 45000,
  30: 100000,
  60: 180000
};

// ================= توابع تاریخ شمسی =================
function getShamsiNow() {
  const now = new Date();
  const option = { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' };
  return new Intl.DateTimeFormat('fa-IR', option).format(now);
}

function getShamsiDateOnly() {
  const now = new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(now);
}

// ================= توابع کاربردی =================
function getQRUrl(text) {
  return `https://quickchart.io/qr?text=${encodeURIComponent(text)}&margin=2&size=400`;
}

function getUserLink(user_id, first_name, username) {
  const cleanName = (first_name || "کاربر").replace(/[<>&]/g, '');
  const unStr = username ? ` (@${username})` : "";
  return `<a href="tg://user?id=${user_id}">${cleanName}</a>${unStr}`;
}

// تولید دکمه‌های ایمپورت با استفاده از ریدایرکتور داخلی ورکر
function getImportKeyboard(subLink, botOrigin) {
  const encoded = encodeURIComponent(subLink);
  return {
    inline_keyboard: [
      [
        { text: "📥 افزودن به V2Box (آیفون)", url: `${botOrigin}/import?app=v2box&url=${encoded}` }
      ],
      [
        { text: "📥 افزودن به v2rayNG (اندروید)", url: `${botOrigin}/import?app=v2rayng&url=${encoded}` }
      ]
    ]
  };
}

// ================= ارتباط با تلگرام API =================
async function callTelegram(method, body) {
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  return await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(res => res.json());
}

async function sendMessage(chat_id, text, reply_markup = null, parse_mode = "HTML") {
  const body = { chat_id, text, parse_mode };
  if (reply_markup) body.reply_markup = reply_markup;
  return await callTelegram('sendMessage', body);
}

// ================= مدیریت وضعیت‌ها (State Machine در D1) =================
async function getState(db, user_id) {
  const res = await db.prepare("SELECT state_data FROM user_states WHERE user_id = ?").bind(user_id).first();
  return res ? JSON.parse(res.state_data) : null;
}

async function setState(db, user_id, data) {
  const json_data = JSON.stringify(data);
  await db.prepare("INSERT INTO user_states (user_id, state_data) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET state_data = excluded.state_data").bind(user_id, json_data).run();
}

async function clearState(db, user_id) {
  await db.prepare("DELETE FROM user_states WHERE user_id = ?").bind(user_id).run();
}

// ================= ارتباط با ورکر کلودفلر (پنل ادمین) =================
async function updateCloudflareExp(domain, daysToAdd, hoursToAdd = 0, singleUser = false, targetUser = null, db = null) {
  let inputDomain = domain.trim();
  if (!inputDomain.startsWith('http')) inputDomain = 'https://' + inputDomain;
  inputDomain = inputDomain.replace(/\/$/, ""); 
  
  let apiDomain = inputDomain;
  let proxyPrefix = "";

  if (inputDomain.includes("?url=")) {
    const parts = inputDomain.split("?url=");
    proxyPrefix = parts[0] + "?url=";
    apiDomain = decodeURIComponent(parts[1]).replace(/\/$/, "");
  }

  const url = `${apiDomain}/${CF_ADMIN_PATH}?token=${CF_ADMIN_TOKEN}`;
  let lastStatus = "نامشخص";
  
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: "getData" }) });
    lastStatus = res.status;
    
    if (!res.ok) {
      return { success: false, subLink: "", error: `پاسخ سرور ${lastStatus} (احتمالاً توکن یا مسیر ادمین اشتباه است)` };
    }

    const currentData = (await res.json()).data || {};
    if (currentData.killSwitch === true) {
      await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: "toggleKillSwitch" }) });
    }
    
    let baseDate = new Date(); 
    
    // محاسبه دقیق زمان باقی مانده و تجمیع آن
    if (targetUser && db) {
      try {
        const activeSrv = await db.prepare("SELECT exp_date FROM services WHERE user_id = ? AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1").bind(targetUser).first();
        if (activeSrv && activeSrv.exp_date) {
          const expD = new Date(activeSrv.exp_date);
          if (!isNaN(expD.getTime()) && expD > baseDate) {
            baseDate = expD; 
          }
        }
      } catch(e) { console.log("DB Fetch Error:", e); }
    } else if (currentData.exp && currentData.exp > baseDate.getTime()) {
      baseDate = new Date(currentData.exp);
    }

    let dToAdd = parseInt(daysToAdd) || 0;
    let hToAdd = parseInt(hoursToAdd) || 0;

    baseDate.setDate(baseDate.getDate() + dToAdd);
    baseDate.setHours(baseDate.getHours() + hToAdd);
    
    const dateOptions = { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' };
    const timeOptions = { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
    
    const dateStr = new Intl.DateTimeFormat('en-CA', dateOptions).format(baseDate); 
    const timeStr = new Intl.DateTimeFormat('en-GB', timeOptions).format(baseDate).substring(0, 5); 
    
    const updateRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        action: "updateExp", 
        date: dateStr, 
        time: timeStr,
        singleUser: singleUser
      })
    });
    
    lastStatus = updateRes.status;
    if (updateRes.ok) {
      const data = await updateRes.json();
      let finalSubLink = data.subLink || `${apiDomain}/sub`;
      
      if (proxyPrefix && finalSubLink.startsWith(apiDomain)) {
        finalSubLink = finalSubLink.replace(apiDomain, inputDomain);
      }
      
      return { success: true, subLink: finalSubLink, newExpDate: baseDate.toISOString() };
    }
    return { success: false, subLink: "", error: `خطا در آپدیت تاریخ. پاسخ سرور: ${lastStatus}` };
  } catch (e) {
    return { success: false, subLink: "", error: `عدم برقراری ارتباط با دامنه (${e.message})` };
  }
}

// ================= کیبوردها =================
function mainMenu(user_id) {
  const keyboard = [
    [{ text: "🎁 دریافت اکانت رایگان (تست)" }, { text: "🛒 خرید سرویس" }],
    [{ text: "📚 آموزش‌ها" }, { text: "📦 سرویس‌های من" }],
    [{ text: "📞 ارتباط با پشتیبانی" }]
  ];
  if (user_id === ADMIN_ID) keyboard.push([{ text: "⚙️ ورود به پنل مدیریت حرفه‌ای" }]);
  return { keyboard, resize_keyboard: true };
}

function adminPanelMenu() {
  return { 
    keyboard: [
      [{ text: "👥 لیست کامل کاربران و خریدها" }],
      [{ text: "🛠 مدیریت سرویس‌های کاربر" }, { text: "📖 راهنمای پنل مدیریت" }],
      [{ text: "🏠 بازگشت به منوی اصلی" }]
    ], 
    resize_keyboard: true 
  };
}

function backAndSupportKeyboard() {
  return { keyboard: [[{ text: "🔙 مرحله قبل" }, { text: "🏠 بازگشت به منوی اصلی" }], [{ text: "📞 ارتباط با پشتیبانی" }]], resize_keyboard: true };
}

function pendingMenu() {
  return { keyboard: [[{ text: "❌ لغو عملیات" }]], resize_keyboard: true };
}

function tutorialsMenu() {
  return {
    keyboard: [
      [{ text: "🔄 آموزش آپدیت کردن لینک (بروزرسانی)" }],
      [{ text: "🚀 آموزش راه‌اندازی در V2Box" }],
      [{ text: "💬 راهنمای ارسال پیام به پشتیبانی" }],
      [{ text: "🏠 بازگشت به منوی اصلی" }]
    ], resize_keyboard: true
  };
}

function daysKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: `۵ روزه (${(PLAN_PRICES[5]/1000).toLocaleString('fa-IR')} ه.ت)`, callback_data: "plan_5" },
        { text: `۱ روزه (${(PLAN_PRICES[1]/1000).toLocaleString('fa-IR')} ه.ت)`, callback_data: "plan_1" }
      ],
      [
        { text: `۳۰ روزه (${(PLAN_PRICES[30]/1000).toLocaleString('fa-IR')} ه.ت)`, callback_data: "plan_30" },
        { text: `۱۰ روزه (${(PLAN_PRICES[10]/1000).toLocaleString('fa-IR')} ه.ت)`, callback_data: "plan_10" }
      ],
      [{ text: `۶۰ روزه ویژه (${(PLAN_PRICES[60]/1000).toLocaleString('fa-IR')} هزار تومان)`, callback_data: "plan_60" }]
    ]
  };
}

// ================= هندلر اصلی کلودفلر ورکر =================
export default {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);
    const botOrigin = requestUrl.origin;

    if (request.method === 'GET') {
      if (requestUrl.pathname === '/import') {
        const app = requestUrl.searchParams.get('app');
        const subUrl = requestUrl.searchParams.get('url');
        if (app && subUrl) {
          const deepLink = `${app}://install-sub?url=${encodeURIComponent(subUrl)}`;
          const html = `<!DOCTYPE html>
          <html dir="rtl" lang="fa">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>انتقال به برنامه...</title>
            <meta http-equiv="refresh" content="0; url=${deepLink}">
            <style>
              body { font-family: Tahoma, sans-serif; text-align: center; margin-top: 50px; background: #f0f2f5; color: #333; }
              .card { background: #fff; padding: 20px; border-radius: 10px; max-width: 400px; margin: auto; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
              a { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #007bff; color: #fff; text-decoration: none; border-radius: 5px; }
            </style>
          </head>
          <body>
            <div class="card">
              <h2>در حال انتقال به برنامه...</h2>
              <p>لطفاً منتظر بمانید. اگر به صورت خودکار به برنامه منتقل نشدید، روی دکمه زیر کلیک کنید.</p>
              <a href="${deepLink}">باز کردن برنامه</a>
            </div>
          </body>
          </html>`;
          return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
      }
      return new Response('Bot is Running in Serverless Mode!', { status: 200 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    
    const db = env.DB;
    const update = await request.json();

    try {
      if (update.message) {
        const msg = update.message;
        const chat_id = msg.chat.id;
        const user_id = msg.from.id;
        const text = msg.text || "";
        const first_name = msg.from.first_name || "کاربر";
        const username = msg.from.username || "";
        let state = await getState(db, user_id);

        // بروزرسانی اطلاعات کاربر در دیتابیس
        await db.prepare("INSERT INTO users (user_id, username, first_name, join_date_shamsi) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name")
            .bind(user_id, username, first_name, getShamsiNow()).run();

        // دستور شروع و ریست
        if (text === '/start') {
          await clearState(db, user_id);
          const welcome = `👋 <b>به ربات هوشمند ما خوش آمدید!</b>\n\n💡 <b>هدیه ویژه ما:</b> کاربران جدید برای بار اول یک اکانت <b>تست ۲ روزه (تک‌کاربره)</b> رایگان دریافت می‌کنند. همچنین تمامی کاربران می‌توانند <b>هر ماه یکبار، یک اکانت رایگان ۱ روزه</b> دریافت کنند!\n\nپایداری، سرعت و امنیت را با ما تجربه کنید. لطفاً از منوی زیر یک گزینه را انتخاب کنید 👇`;
          await sendMessage(chat_id, welcome, mainMenu(user_id));
          return new Response('OK');
        }

        // اگر کاربر در حال پاسخ به ادمین یا در وضعیت ویرایش عکس است
        if (user_id === ADMIN_ID && state && state.step === 'WAIT_ADMIN_REPLY_TEXT') {
          const targetUid = state.target_user;
          await sendMessage(targetUid, `📩 <b>پاسخ جدید از طرف پشتیبانی:</b>\n\n${text}`);
          await sendMessage(ADMIN_ID, `✅ پاسخ شما با موفقیت برای کاربر <code>${targetUid}</code> ارسال شد.`, adminPanelMenu());
          await clearState(db, ADMIN_ID);
          return new Response('OK');
        }

        // جستجوی کاربر در پنل ادمین
        if (user_id === ADMIN_ID && state && state.step === 'WAIT_ADMIN_SEARCH_USER') {
          const targetUid = parseInt(text.trim());
          if (isNaN(targetUid)) {
            await sendMessage(ADMIN_ID, "❌ آیدی وارد شده معتبر نیست. لطفاً یک آیدی عددی وارد کنید:");
            return new Response('OK');
          }

          const { results: srvList } = await db.prepare("SELECT * FROM services WHERE user_id = ? ORDER BY id DESC").bind(targetUid).all();
          if (!srvList || srvList.length === 0) {
            await sendMessage(ADMIN_ID, `❌ هیچ سرویسی برای کاربر (آیدی: <code>${targetUid}</code>) یافت نشد.`, adminPanelMenu());
            await clearState(db, ADMIN_ID);
            return new Response('OK');
          }

          const uRow = await db.prepare("SELECT first_name, username FROM users WHERE user_id = ?").bind(targetUid).first();
          const userLink = getUserLink(targetUid, uRow ? uRow.first_name : "کاربر", uRow ? uRow.username : "");

          await sendMessage(ADMIN_ID, `🛠 <b>مدیریت سرویس‌های کاربر:</b> ${userLink}\n🆔 آیدی: <code>${targetUid}</code>\nتعداد سرویس‌ها: ${srvList.length}`);

          for (const s of srvList) {
            let expView = "نامشخص";
            if (s.exp_date) {
               const d = new Date(s.exp_date);
               if (!isNaN(d)) expView = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
            }

            let srvMsg = `📦 <b>شناسه سرویس:</b> #${s.id}\n🛍 <b>پلن:</b> ${s.plan_days} روزه (${s.plan_type})\n🌐 <b>ورکر:</b> <code>${s.cf_domain}</code>\n⏳ <b>انقضا:</b> ${expView}\nوضعیت: ${s.status === 'ACTIVE' ? '✅ فعال' : '❌ غیرفعال'}`;
            let kb = {
              inline_keyboard: [
                [
                  { text: s.status === 'ACTIVE' ? "⛔️ قطع سرویس" : "✅ وصل سرویس", callback_data: `admtoggle_${s.id}` },
                  { text: "➕ تمدید / شارژ", callback_data: `admrenew_${s.id}` }
                ],
                [{ text: "🗑 حذف سرویس", callback_data: `admdel_${s.id}` }]
              ]
            };
            await sendMessage(ADMIN_ID, srvMsg, kb);
          }
          await clearState(db, ADMIN_ID);
          return new Response('OK');
        }

        // تمدید سرویس توسط ادمین
        if (user_id === ADMIN_ID && state && state.step === 'WAIT_ADMIN_ADD_DAYS') {
          const daysToAdd = parseInt(text.trim());
          if (isNaN(daysToAdd) || daysToAdd <= 0) {
            await sendMessage(ADMIN_ID, "❌ لطفاً یک عدد معتبر بر حسب روز وارد کنید:");
            return new Response('OK');
          }

          const srv = await db.prepare("SELECT * FROM services WHERE id = ?").bind(state.service_id).first();
          if (!srv) {
            await sendMessage(ADMIN_ID, "❌ سرویس یافت نشد.", adminPanelMenu());
            await clearState(db, ADMIN_ID);
            return new Response('OK');
          }

          const cfRes = await updateCloudflareExp(srv.cf_domain, daysToAdd, 0, srv.plan_type.includes('یک کاربره'), srv.user_id, db);
          if (cfRes.success) {
            await db.prepare("UPDATE services SET exp_date = ?, status = 'ACTIVE' WHERE id = ?").bind(cfRes.newExpDate, srv.id).run();
            
            const uRow = await db.prepare("SELECT first_name, username FROM users WHERE user_id = ?").bind(srv.user_id).first();
            const userLink = getUserLink(srv.user_id, uRow ? uRow.first_name : "کاربر", uRow ? uRow.username : "");

            await sendMessage(ADMIN_ID, `✅ سرویس #${srv.id} کاربر ${userLink} به مدت <b>${daysToAdd} روز</b> شارژ/تمدید گردید.`, adminPanelMenu());
            await sendMessage(srv.user_id, `🎉 <b>سرویس شما تمدید شد!</b>\n\n➕ مقدار <b>${daysToAdd} روز</b> به اعتبار سرویس شما افزوده شد.\n🔗 <b>لینک اتصال:</b>\n<code>${srv.sub_link}</code>`);
          } else {
            await sendMessage(ADMIN_ID, `❌ خطا در آپدیت ورکر: ${cfRes.error}`, adminPanelMenu());
          }
          await clearState(db, ADMIN_ID);
          return new Response('OK');
        }

        // ویرایش عکس فیش واریزی توسط کاربر تا قبل از تایید ادمین
        if (msg.photo && state && state.step === 'PENDING_ADMIN' && user_id !== ADMIN_ID) {
          const photoId = msg.photo[msg.photo.length - 1].file_id;
          const userLink = getUserLink(user_id, first_name, username);
          const lastSrv = await db.prepare("SELECT cf_domain FROM services WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(user_id).first();
          const workerText = lastSrv ? `🌐 <b>ورکر فعلی کاربر:</b> <code>${lastSrv.cf_domain}</code>\n` : `🌐 <b>ورکر فعلی کاربر:</b> ندارد (نیاز به ثبت ورکر جدید)\n`;
          
          let caption = `🧾 <b>درخواست پرداخت جدید (ویرایش شده توسط کاربر)</b>\n👤 کاربر: ${userLink}\n🆔 آیدی: <code>${user_id}</code>\n📅 <b>زمان ویرایش:</b> ${getShamsiNow()}\n📦 پلن: ${state.days} روزه - ${state.type || 'سفارشی'}\n${workerText}`;
          const isSingle = (state.type && state.type.includes('یک کاربره')) ? '1' : '0';

          const admMarkup = { inline_keyboard: [
              [{ text: "✅ تایید پرداختی و شارژ اکانت", callback_data: `admaprv_buy_${user_id}_${state.days}_0_${isSingle}` }],
              [{ text: "❌ رد کردن درخواست", callback_data: `admrej_${user_id}` }]
          ] };

          if (state.admin_message_id) {
             await callTelegram('editMessageMedia', {
                chat_id: ADMIN_ID,
                message_id: state.admin_message_id,
                media: { type: 'photo', media: photoId, caption: caption, parse_mode: 'HTML' },
                reply_markup: admMarkup
             });
             await sendMessage(chat_id, "📸 <b>تصویر فیش واریزی شما با موفقیت ویرایش شد.</b>\nدرخواست به‌روزرسانی شده جهت بررسی به ادمین ارسال گردید.", pendingMenu());
          }
          return new Response('OK');
        }

        // قفل جلوگیری از درخواست مجدد تا پاسخ ادمین
        if (state && state.step === 'PENDING_ADMIN' && user_id !== ADMIN_ID) {
          if (text === "❌ لغو عملیات") {
             if (state.admin_message_id) {
                 await callTelegram('editMessageReplyMarkup', { chat_id: ADMIN_ID, message_id: state.admin_message_id, reply_markup: { inline_keyboard: [] } });
                 if (state.is_test) {
                     await callTelegram('editMessageText', { chat_id: ADMIN_ID, message_id: state.admin_message_id, text: "❌ <b>این درخواست توسط کاربر لغو شد.</b>", parse_mode: "HTML" });
                 } else {
                     await callTelegram('editMessageCaption', { chat_id: ADMIN_ID, message_id: state.admin_message_id, caption: "❌ <b>این درخواست توسط کاربر لغو شد.</b>", parse_mode: "HTML" });
                 }
             }
             await clearState(db, user_id);
             await sendMessage(chat_id, "✅ عملیات با موفقیت لغو شد و به منوی اصلی بازگشتید.", mainMenu(user_id));
          } else {
             await sendMessage(chat_id, "⏳ <b>شما یک درخواست در حال بررسی دارید!</b>\nمی‌توانید عکس فیش جدید را جهت ویرایش بفرستید یا دکمه «❌ لغو عملیات» را بزنید.", pendingMenu());
          }
          return new Response('OK');
        }

        if (text === "🔙 مرحله قبل" || text === "🏠 بازگشت به منوی اصلی" || text === "🔙 بازگشت به پنل کاربری" || text === "❌ لغو عملیات") {
          await clearState(db, user_id);
          await sendMessage(chat_id, "🏠 عملیات فعلی لغو شد. به منوی اصلی برگشتید.", mainMenu(user_id));
          return new Response('OK');
        }

        if (text === "⚙️ ورود به پنل مدیریت حرفه‌ای" && user_id === ADMIN_ID) {
          await sendMessage(chat_id, "👨‍💻 <b>به پنل مدیریت حرفه‌ای خوش آمدید.</b>\nاز گزینه‌های زیر استفاده کنید:", adminPanelMenu());
          return new Response('OK');
        }

        if (text === "📖 راهنمای پنل مدیریت" && user_id === ADMIN_ID) {
          const guideText = `📖 <b>راهنمای جامع پنل مدیریت:</b>\n\n` +
          `1️⃣ <b>تایید خریدهای جدید:</b> هنگامی که کاربر رسید ارسال کند، دکمه تایید پرداختی ظاهر می‌شود. اگر کاربر قبلاً ورکر داشته باشد به صورت خودکار تمدید می‌شود، در غیر این صورت از شما آدرس ورکر جدید درخواست می‌گردد.\n\n` +
          `2️⃣ <b>مدیریت سرویس‌های کاربر:</b> روی دکمه «🛠 مدیریت سرویس‌های کاربر» بزنید و آیدی عددی کاربر را بفرستید تا بتوانید سرویس‌ها را قطع/وصل، شارژ یا حذف کنید.\n\n` +
          `3️⃣ <b>پاسخ به پیام‌های شخصی:</b> هنگامی که کاربر پیامی بفرستد، دکمه «💬 پاسخ به این پیام» زیر آن قرار می‌گیرد تا مستقیماً به کاربر پاسخ دهید.`;
          await sendMessage(chat_id, guideText, adminPanelMenu());
          return new Response('OK');
        }

        if (text === "🛠 مدیریت سرویس‌های کاربر" && user_id === ADMIN_ID) {
          await setState(db, ADMIN_ID, { step: 'WAIT_ADMIN_SEARCH_USER' });
          await sendMessage(chat_id, "🔍 لطفاً **آیدی عددی کاربر (User ID)** را جهت مدیریت سرویس‌ها ارسال کنید:", pendingMenu());
          return new Response('OK');
        }
        
        if (text === "📦 سرویس‌های من") {
            const { results: userServices } = await db.prepare("SELECT id, plan_days, plan_type, cf_domain, sub_link, exp_date, status, purchase_date_shamsi FROM services WHERE user_id = ? ORDER BY id DESC").bind(user_id).all();

            if (!userServices || userServices.length === 0) {
              await sendMessage(chat_id, "❌ شما هنوز هیچ سرویس یا تستی دریافت نکرده‌اید.");
              return new Response('OK');
            }

            let msgText = "📦 <b>لیست تمامی سرویس‌های شما:</b>\n\n";
            let inline_keyboard = [];

            userServices.forEach((s, idx) => {
              msgText += `🔹 <b>سرویس ${idx + 1}:</b>\n`;
              msgText += `🛍 <b>پکیج:</b> ${s.plan_days} روزه (${s.plan_type})\n`;
              msgText += `🌐 <b>ورکر:</b> <code>${s.cf_domain}</code>\n`;
              msgText += `📅 <b>تاریخ ثبت:</b> ${s.purchase_date_shamsi}\n`;
              
              let expView = "نامشخص";
              if (s.exp_date) {
                 const d = new Date(s.exp_date);
                 if (!isNaN(d)) expView = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
              }
              msgText += `⏳ <b>تاریخ انقضا:</b> ${expView}\n`;
              msgText += `وضعیت: ${s.status === 'ACTIVE' ? '✅ فعال' : '❌ غیرفعال'}\n➖➖➖➖➖➖\n`;

              if (s.sub_link) {
                 inline_keyboard.push([{ text: `🔗 اتصال به سرویس ${idx + 1}`, callback_data: `getqr_${s.id}` }]);
              }
            });

            await sendMessage(chat_id, msgText, inline_keyboard.length > 0 ? { inline_keyboard } : null);
            return new Response('OK');
        }

        if (text === "👥 لیست کامل کاربران و خریدها" && user_id === ADMIN_ID) {
          const { results: users } = await db.prepare("SELECT user_id, first_name, username, join_date_shamsi FROM users ORDER BY user_id DESC LIMIT 20").all();
          if (!users || users.length === 0) {
            await sendMessage(chat_id, "هیچ کاربری در دیتابیس ثبت نشده است.");
            return new Response('OK');
          }

          let text_chunk = "👥 <b>گزارش جامع تمام کاربران:</b>\n\n";
          for (const u of users) {
            const uid = u.user_id;
            const userLink = getUserLink(uid, u.first_name, u.username);
            const join_date = u.join_date_shamsi || "نامشخص";
            
            const { results: services } = await db.prepare("SELECT plan_days, plan_type, cf_domain, purchase_date_shamsi FROM services WHERE user_id = ? ORDER BY id ASC").bind(uid).all();
            let service_text = "";
            if (services && services.length > 0) {
              for (const s of services) {
                service_text += `   🛍 <b>${s.plan_days} روزه (${s.plan_type})</b>\n   🌐 <b>ورکر:</b> <code>${s.cf_domain}</code>\n   📅 <b>تاریخ:</b> ${s.purchase_date_shamsi}\n   ---\n`;
              }
            } else {
              service_text = "   - خرید یا تستی نداشته\n";
            }
            
            const user_info = `👤 <b>کاربر:</b> ${userLink}\n🆔 <b>آیدی:</b> <code>${uid}</code>\n📅 <b>عضویت:</b> ${join_date}\n\n📦 <b>تاریخچه خریدهـا و تـست‌ها:</b>\n${service_text}➖➖➖➖➖➖➖➖\n`;
            
            if (text_chunk.length + user_info.length > 3800) {
              await sendMessage(ADMIN_ID, text_chunk);
              text_chunk = user_info;
            } else {
              text_chunk += user_info;
            }
          }
          if (text_chunk) await sendMessage(ADMIN_ID, text_chunk);
          return new Response('OK');
        }

        if (text === "📚 آموزش‌ها") {
          await sendMessage(chat_id, "کدام آموزش را نیاز دارید؟ 👇", tutorialsMenu());
          return new Response('OK');
        }
        if (text === "🔄 آموزش آپدیت کردن لینک (بروزرسانی)") {
          const res = await callTelegram('sendPhoto', { chat_id, photo: PIC_UPDATE_SUB, caption: "🖼 برای دریافت بهترین سرعت و پینگ، همیشه لینک خود را طبق این عکس آپدیت کنید." });
          if (!res.ok) await sendMessage(chat_id, "لینک عکس آموزشی تنظیم نشده است.");
          return new Response('OK');
        }
        if (text === "🚀 آموزش راه‌اندازی در V2Box") {
          const res = await callTelegram('sendPhoto', { chat_id, photo: PIC_V2BOX_SETUP, caption: "🖼 مراحل وارد کردن لینک در برنامه V2Box طبق این عکس می‌باشد." });
          if (!res.ok) await sendMessage(chat_id, "لینک عکس آموزشی تنظیم نشده است.");
          return new Response('OK');
        }
        if (text === "💬 راهنمای ارسال پیام به پشتیبانی") {
          const guide = `💬 <b>راهنمای ارسال پیام شخصی به پشتیبانی:</b>\n\nبرای ارسال هرگونه سوال، درخواست یا گزارش، کافیست متن دلخواه خود را در ربات تایپ کرده و بفرستید.\n\nربات پیش‌نمایش پیام را به شما نشان داده و در صورت تایید، پیام مستقیماً برای ادمین ارسال خواهد شد.`;
          await sendMessage(chat_id, guide);
          return new Response('OK');
        }
        if (text === "📞 ارتباط با پشتیبانی") {
          await sendMessage(chat_id, `👨‍💻 تیم پشتیبانی ما همیشه پاسخگوی شماست.\n\nبرای ارتباط مستقیم به آیدی زیر پیام دهید:\n${SUPPORT_ID}`);
          return new Response('OK');
        }

        if (text === "🛒 خرید سرویس") {
          const rules = "⚠️ <b>قوانین سرویس:</b>\nسرویس‌های ما کاملاً نامحدود هستند، اما شامل قانون مصرف منصفانه می‌شوند. در صورت مصرف غیرعادی، اکانت موقتاً قطع شده و از روز بعد متصل می‌گردد.\n\n⏳ لطفاً مدت زمان سرویس خود را انتخاب کنید:";
          await sendMessage(chat_id, rules, daysKeyboard());
          await sendMessage(chat_id, "در صورت نیاز به انصراف، از دکمه‌های پایین استفاده کنید:", backAndSupportKeyboard());
          return new Response('OK');
        }

        if (text === "🎁 دریافت اکانت رایگان (تست)") {
          if (state && state.locked) {
            await sendMessage(user_id, "⏳ درخواست قبلی شما در حال پردازش است. لطفاً منتظر بمانید...");
            return new Response('OK');
          }

          const userRow = await db.prepare("SELECT last_test_date FROM users WHERE user_id = ?").bind(user_id).first();
          let isFirstTime = true;
          if (userRow && userRow.last_test_date) {
            const lastTestTime = new Date(userRow.last_test_date).getTime();
            const nowTime = Date.now();
            const diffDays = (nowTime - lastTestTime) / (1000 * 60 * 60 * 24);
            
            if (diffDays < 30) {
              const remainingDays = Math.ceil(30 - diffDays);
              await sendMessage(user_id, `❌ <b>دریافت مجدد امکان‌پذیر نیست!</b>\n\nشما در این ماه اکانت رایگان خود را دریافت کرده‌اید. شما <b>ماهی یک بار</b> مجاز به دریافت هدیه هستید.\n⏳ لطفاً <b>${remainingDays} روز</b> دیگر برای دریافت تست بعدی مراجعه کنید.`);
              return new Response('OK');
            }
            isFirstTime = false;
          }

          const testDays = isFirstTime ? 2 : 1;
          const msgText = isFirstTime ? `🎁 <b>مژده:</b> چون بار اول شماست، یک اکانت تست <b>۲ روزه (کاملاً تک‌کاربره)</b> به شما تعلق می‌گیرد!\n(برای ماه‌های آینده، هدیه شما ۱ روزه خواهد بود)` : `🎁 اکانت هدیه ماهانه شما (<b>۱ روزه و تک‌کاربره</b>) در حال آماده‌سازی است...`;
          await sendMessage(user_id, msgText);
          
          let newState = { days: testDays, hours: 0, type: `اکانت تست (${testDays} روزه - تک‌کاربره)`, is_test: true, user_type: '1', step: 'PENDING_ADMIN' };
          
          const userLink = getUserLink(user_id, first_name, username);
          const lastSrv = await db.prepare("SELECT cf_domain FROM services WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(user_id).first();
          const workerText = lastSrv ? `\n🌐 <b>ورکر فعلی:</b> <code>${lastSrv.cf_domain}</code>` : `\n🌐 <b>ورکر فعلی:</b> ندارد (نیاز به ثبت ورکر جدید)`;

          const admText = `🎁 <b>درخواست تست (${newState.type})</b>\n👤 کاربر: ${userLink}\n🆔 آیدی: <code>${user_id}</code>${workerText}`;
          const admKb = { inline_keyboard: [
              [{ text: "✅ تایید و ارسال لینک تست", callback_data: `admaprv_test_${user_id}_${testDays}_0_1` }],
              [{ text: "❌ رد کردن", callback_data: `admrej_${user_id}` }]
          ]};

          const adminMsgRes = await callTelegram('sendMessage', { chat_id: ADMIN_ID, text: admText, reply_markup: admKb, parse_mode: "HTML" });
          if (adminMsgRes && adminMsgRes.ok) {
              newState.admin_message_id = adminMsgRes.result.message_id;
          }
          await setState(db, user_id, newState);

          await sendMessage(user_id, "✅ درخواست تست شما ثبت شد و به ادمین ارسال گردید. لطفاً تا پاسخ پشتیبانی شکیبا باشید.", pendingMenu());
          return new Response('OK');
        }

        if (msg.photo && state && state.step === 'WAIT_RECEIPT') {
          if (state.locked) return new Response('OK');
          state.locked = true;
          await setState(db, user_id, state);

          if (Date.now() - state.timer_start > 600000) {
            await clearState(db, user_id);
            await sendMessage(user_id, "❌ زمان ۱۰ دقیقه‌ای شما برای پرداخت به پایان رسیده است. لطفاً فرآیند را مجدداً آغاز کنید.", mainMenu(user_id));
            return new Response('OK');
          }

          const photoId = msg.photo[msg.photo.length - 1].file_id;
          const info = state;
          
          const userLink = getUserLink(user_id, first_name, username);
          const lastSrv = await db.prepare("SELECT cf_domain FROM services WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(user_id).first();
          const workerText = lastSrv ? `🌐 <b>ورکر فعلی کاربر:</b> <code>${lastSrv.cf_domain}</code>\n` : `🌐 <b>ورکر فعلی کاربر:</b> ندارد (نیاز به ثبت ورکر جدید)\n`;

          let caption = `🧾 <b>درخواست پرداخت جدید</b>\n👤 کاربر: ${userLink}\n🆔 آیدی: <code>${user_id}</code>\n📅 <b>زمان ثبت:</b> ${getShamsiNow()}\n📦 پلن: ${info.days} روزه - ${info.type}\n${workerText}`;
          const isSingle = info.type.includes('یک کاربره') ? '1' : '0';
          
          const admMarkup = { inline_keyboard: [
              [{ text: "✅ تایید پرداختی و شارژ اکانت", callback_data: `admaprv_buy_${user_id}_${info.days}_0_${isSingle}` }],
              [{ text: "❌ رد کردن درخواست", callback_data: `admrej_${user_id}` }]
          ] };

          state.step = 'PENDING_ADMIN';
          state.locked = false;

          const adminMsgRes = await callTelegram('sendPhoto', { chat_id: ADMIN_ID, photo: photoId, caption: caption, parse_mode: "HTML", reply_markup: admMarkup });
          if (adminMsgRes && adminMsgRes.ok) {
              state.admin_message_id = adminMsgRes.result.message_id;
          }
          await setState(db, user_id, state);
          
          await sendMessage(user_id, "✅ رسید شما با موفقیت ارسال شد و در صف بررسی قرار گرفت. لطفاً تا بررسی ادمین صبور باشید.", pendingMenu());
          return new Response('OK');
        }

        // ================= ثبت دامنه ورکر جدید توسط ادمین =================
        if (user_id === ADMIN_ID && state && state.step === 'WAIT_DOMAIN') {
          let domainInput = text.trim();
          if (!domainInput.startsWith('http')) domainInput = 'https://' + domainInput;
          domainInput = domainInput.replace(/\/$/, "");
          
          const duplicateCheck = await db.prepare("SELECT user_id FROM services WHERE cf_domain = ? AND user_id != ? LIMIT 1").bind(domainInput, state.target_user).first();
          if (duplicateCheck) {
              const errKb = { inline_keyboard: [[{ text: "❌ انصراف از این عملیات", callback_data: "cancel_admin" }]] };
              await sendMessage(ADMIN_ID, `❌ <b>خطای امنیتی: ورکر تکراری!</b>\n\n⚠️ این ورکر (<code>${domainInput}</code>) قبلاً برای کاربر دیگری ثبت شده است.\n👤 آیدی صاحب فعلی: <a href="tg://user?id=${duplicateCheck.user_id}">${duplicateCheck.user_id}</a>\n\nلطفاً یک ورکر جدید وارد کنید یا عملیات را لغو کنید.`, errKb);
              return new Response('OK');
          }

          await sendMessage(ADMIN_ID, "⏳ در حال برقراری ارتباط با ورکر، اعمال تنظیمات و استخراج لینک...");
          
          let applyDays = state.days;
          let applyHours = state.hours;
          let applySingle = state.user_type === '1';

          if (state.action === 'test') {
            applyHours = parseInt(applyDays) * 24;
            applyDays = 0;
            applySingle = true; 
          }

          const cfRes = await updateCloudflareExp(domainInput, applyDays, applyHours, applySingle, state.target_user, db);
          
          if (cfRes.success && cfRes.subLink) {
            await db.prepare("INSERT OR IGNORE INTO admin_domains (domain) VALUES (?)").bind(domainInput).run();

            const shamsiNow = getShamsiNow();
            const planName = state.action === 'test' ? `تست ${state.days} روزه` : `سرویس ${state.days} روزه (${state.user_type === '1' ? 'یک کاربره' : 'چند کاربره'})`;
            const planTypeDb = state.action === 'test' ? "اکانت تست (رایگان)" : "Normal";
            
            if (state.action === 'test') {
              await db.prepare("INSERT INTO users (user_id, last_test_date) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_test_date = excluded.last_test_date").bind(state.target_user, getShamsiDateOnly()).run();
            }
            
            await db.prepare("INSERT INTO services (user_id, plan_days, plan_type, cf_domain, sub_link, exp_date, status, purchase_date_shamsi) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                .bind(state.target_user, state.days, planTypeDb, domainInput, cfRes.subLink, cfRes.newExpDate, 'ACTIVE', shamsiNow).run();
            
            await clearState(db, state.target_user);

            const uRow = await db.prepare("SELECT first_name, username FROM users WHERE user_id = ?").bind(state.target_user).first();
            const userLink = getUserLink(state.target_user, uRow ? uRow.first_name : "کاربر", uRow ? uRow.username : "");

            // ارسال به کاربر
            const userCaption = `✅ <b>سرویس اختصاصی شما آماده و فعال شد!</b>\n\n👤 <b>کاربر:</b> ${userLink}\n🆔 <b>آیدی:</b> <code>${state.target_user}</code>\n📦 <b>بسته:</b> ${planName}\n📅 <b>تاریخ ثبت:</b> ${shamsiNow}\n\n🔗 <b>لینک اتصال سابسکریپشن:</b>\n<code>${cfRes.subLink}</code>\n\n💡 <i>از دکمه‌های زیر برای افزودن سریع به برنامه استفاده کنید یا بارکد را اسکن نمایید.</i>`;
            await callTelegram('sendPhoto', { chat_id: state.target_user, photo: getQRUrl(cfRes.subLink), caption: userCaption, parse_mode: 'HTML', reply_markup: getImportKeyboard(cfRes.subLink, botOrigin) });
            await sendMessage(state.target_user, "✅ درخواست شما تایید و اعمال شد. به منوی اصلی بازگشتید.", mainMenu(state.target_user));

            // ارسال تاییدیه به ادمین
            const adminCaption = `✅ <b>تحویل سرویس به کاربر با موفقیت انجام شد.</b>\n\n👤 <b>کاربر:</b> ${userLink}\n🆔 <b>آیدی:</b> <code>${state.target_user}</code>\n📦 <b>بسته:</b> ${planName}\n🔗 <b>لینک اتصال:</b>\n<code>${cfRes.subLink}</code>`;
            await callTelegram('sendPhoto', { chat_id: ADMIN_ID, photo: getQRUrl(cfRes.subLink), caption: adminCaption, parse_mode: 'HTML' });
            
            await clearState(db, ADMIN_ID);
          } else {
            const errKb = { inline_keyboard: [[{ text: "❌ انصراف از این عملیات", callback_data: "cancel_admin" }]] };
            await sendMessage(ADMIN_ID, `❌ <b>خطا در ارتباط با ورکر!</b>\n💬 <b>دلیل خطا:</b> ${cfRes.error}\n\n💡 <i>لطفاً آدرس صحیح دامنه ورکر را مجدداً ارسال کنید یا عملیات را لغو کنید.</i>`, errKb);
          }
          return new Response('OK');
        }

        // ================= ارسال پیام شخصی/دلخواه کاربر به ادمین =================
        if (text && !text.startsWith('/') && user_id !== ADMIN_ID && (!state || !state.step)) {
          await setState(db, user_id, { step: 'CONFIRM_PERSONAL_MSG', message_text: text });
          const confirmKb = {
            inline_keyboard: [
              [{ text: "📤 ارسال پیام به پشتیبانی", callback_data: "confirm_send_msg" }],
              [{ text: "❌ لغو و انصراف", callback_data: "cancel_send_msg" }]
            ]
          };
          await sendMessage(chat_id, `💬 <b>ارسال پیام شخصی به پشتیبانی:</b>\n\nشما متن زیر را تایپ کرده‌اید:\n\n<i>"${text}"</i>\n\nآیا می‌خواهید این پیام برای ادمین/پشتیبانی ارسال شود؟`, confirmKb);
          return new Response('OK');
        }
      }

      // ================= هندلر Callback Queries =================
      if (update.callback_query) {
        const call = update.callback_query;
        const user_id = call.from.id;
        const chat_id = call.message.chat.id;
        const msg_id = call.message.message_id;
        const data = call.data;
        let state = await getState(db, user_id) || {};

        if (state && state.step === 'PENDING_ADMIN' && user_id !== ADMIN_ID && !data.startsWith('adm')) {
            await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "⏳ درخواست شما در حال بررسی است. لطفا منتظر بمانید.", show_alert: true });
            return new Response('OK');
        }

        // تایید ارسال پیام شخصی توسط کاربر
        if (data === 'confirm_send_msg') {
          if (state && state.message_text) {
            const uRow = await db.prepare("SELECT first_name, username FROM users WHERE user_id = ?").bind(user_id).first();
            const userLink = getUserLink(user_id, uRow ? uRow.first_name : "کاربر", uRow ? uRow.username : "");
            
            const admText = `📩 <b>پیام شخصی جدید از کاربر:</b>\n\n👤 <b>کاربر:</b> ${userLink}\n🆔 <b>آیدی:</b> <code>${user_id}</code>\n\n💬 <b>متن پیام:</b>\n${state.message_text}`;
            const admKb = { inline_keyboard: [[{ text: "💬 پاسخ به این پیام", callback_data: `admreply_${user_id}` }]] };
            
            await sendMessage(ADMIN_ID, admText, admKb);
            await clearState(db, user_id);
            await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: "✅ پیام شما با موفقیت برای پشتیبانی ارسال شد. به محض پاسخ ادمین مطلع خواهید شد.", parse_mode: "HTML" });
          }
          return new Response('OK');
        }

        if (data === 'cancel_send_msg') {
          await clearState(db, user_id);
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: "❌ ارسال پیام شخصی لغو شد.", parse_mode: "HTML" });
          return new Response('OK');
        }

        // کلیک ادمین برای پاسخ به پیام شخصی
        if (data.startsWith('admreply_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const targetUid = data.split('_')[1];
          await setState(db, ADMIN_ID, { step: 'WAIT_ADMIN_REPLY_TEXT', target_user: targetUid });
          await sendMessage(ADMIN_ID, `💬 لطفاً پاسخ خود را برای کاربر (آیدی: <code>${targetUid}</code>) تایپ و ارسال کنید:`, pendingMenu());
          return new Response('OK');
        }

        // تغییر وضعیت سرویس (قطع/وصل)
        if (data.startsWith('admtoggle_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const srvId = data.split('_')[1];
          const srv = await db.prepare("SELECT * FROM services WHERE id = ?").bind(srvId).first();
          if (srv) {
            const newStatus = srv.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
            await db.prepare("UPDATE services SET status = ? WHERE id = ?").bind(newStatus, srvId).run();
            await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: `وضعیت سرویس به ${newStatus === 'ACTIVE' ? 'فعال' : 'غیرفعال'} تغییر یافت.`, show_alert: true });
            
            if (newStatus === 'INACTIVE') {
              await sendMessage(srv.user_id, `⚠️ <b>اطلاعیه:</b> سرویس #${srv.id} شما توسط پشتیبانی موقتاً غیرفعال گردید.`);
            } else {
              await sendMessage(srv.user_id, `✅ <b>اطلاعیه:</b> سرویس #${srv.id} شما مجدداً فعال گردید.`);
            }
          }
          return new Response('OK');
        }

        // شروع تمدید سرویس توسط ادمین
        if (data.startsWith('admrenew_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const srvId = data.split('_')[1];
          await setState(db, ADMIN_ID, { step: 'WAIT_ADMIN_ADD_DAYS', service_id: srvId });
          await sendMessage(ADMIN_ID, `⏳ لطفاً تعداد روزهایی که می‌خواهید به این سرویس افزوده شود را تایپ کرده و بفرستید (مثلاً: 5 یا 30):`, pendingMenu());
          return new Response('OK');
        }

        // حذف سرویس توسط ادمین
        if (data.startsWith('admdel_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const srvId = data.split('_')[1];
          await db.prepare("DELETE FROM services WHERE id = ?").bind(srvId).run();
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: `🗑 سرویس شناسه #${srvId} با موفقیت حذف گردید.`, parse_mode: "HTML" });
          return new Response('OK');
        }

        if (data === 'cancel_admin') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          let adminState = await getState(db, ADMIN_ID);
          if (adminState && adminState.target_user) {
              await clearState(db, adminState.target_user);
              await sendMessage(adminState.target_user, "❌ فرآیند صدور سرویس توسط پشتیبانی لغو شد. می‌توانید مجدداً درخواست دهید.", mainMenu(adminState.target_user));
          }
          await clearState(db, ADMIN_ID);
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: "✅ عملیات ادمین با موفقیت لغو شد و کاربر از وضعیت انتظار خارج گردید.", parse_mode: "HTML" });
          return new Response('OK');
        }

        // --- نمایش QR و لینک مستقیم در سرویس‌های من ---
        if (data.startsWith('getqr_')) {
          const serviceId = data.split('_')[1];
          const srv = await db.prepare("SELECT sub_link FROM services WHERE id = ? AND user_id = ?").bind(serviceId, user_id).first();
          if (srv && srv.sub_link) {
              const caption = `📱 <b>بارکد (QR Code) و لینک اتصال سرویس</b>\n\n🔗 <b>لینک سابسکریپشن شما:</b>\n<code>${srv.sub_link}</code>\n\n💡 جهت اتصال سریع، روی دکمه‌های زیر کلیک کنید یا بارکد را اسکن نمایید.`;
              await callTelegram('sendPhoto', { chat_id, photo: getQRUrl(srv.sub_link), caption: caption, parse_mode: 'HTML', reply_markup: getImportKeyboard(srv.sub_link, botOrigin) });
          } else {
              await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "❌ لینک سابسکریپشن و بارکد این سرویس یافت نشد.", show_alert: true });
          }
        }

        else if (data.startsWith('plan_')) {
          const days = data.split('_')[1];
          state.days = days;
          state.hours = 0;
          state.is_test = false;
          await setState(db, user_id, state);
          const kb = { 
            inline_keyboard: [
              [{ text: "👥 چند کاربره", callback_data: "users_multi" }, { text: "👤 یک کاربره", callback_data: "users_1" }]
            ] 
          };
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: "👥 نوع مصرف را مشخص کنید:", reply_markup: kb, parse_mode: "HTML" });
        }

        else if (data.startsWith('users_')) {
          const userType = data.split('_')[1];
          state.user_type = userType;
          state.type = (userType === '1') ? "یک کاربره" : "چند کاربره";
          state.step = 'WAIT_RECEIPT';
          state.timer_start = Date.now();
          await setState(db, user_id, state);
          
          const planPrice = PLAN_PRICES[state.days] || 0;
          const formattedPrice = planPrice.toLocaleString('fa-IR');
          
          const factor = `💳 <b>فاکتور سرویس ${state.days} روزه (${state.type})</b>\n💵 مبلغ سرویس: <b>${formattedPrice} تومان</b>\n\nلطفاً مبلغ فوق را به شماره کارت زیر واریز کرده و <b>عکس رسید تراکنش</b> را همینجا ارسال کنید:\n\n💳 <code>${CARD_NUMBER}</code>\n\n⏱ <i>شما ۱۰ دقیقه برای ارسال رسید فرصت دارید. (تا زمان تایید ادمین، امکان ویرایش عکس وجود دارد)</i>`;
          await callTelegram('deleteMessage', { chat_id, message_id: msg_id });
          await sendMessage(chat_id, factor, backAndSupportKeyboard());
        }

        else if (data.startsWith('admrej_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const targetUser = data.split('_')[1];
          await callTelegram('editMessageReplyMarkup', { chat_id, message_id: msg_id, reply_markup: { inline_keyboard: [] } });
          
          if (call.message.photo) {
             await callTelegram('editMessageCaption', { chat_id, message_id: msg_id, caption: "❌ <b>توسط شما رد شد.</b>", parse_mode: "HTML" });
          } else {
             await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: "❌ <b>توسط شما رد شد.</b>", parse_mode: "HTML" });
          }
          await clearState(db, targetUser);
          await sendMessage(targetUser, "❌ متاسفانه درخواست / رسید پرداختی شما توسط بخش پشتیبانی رد شد. در صورت بروز مشکل با ادمین در ارتباط باشید.", mainMenu(targetUser));
        }

        // ================= تایید پرداختی / تست توسط ادمین =================
        else if (data.startsWith('admaprv_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const parts = data.split('_');
          const action = parts[1]; // test یا buy
          const targetUser = parts[2];
          const days = parts[3];
          const hours = parts[4];
          const userType = parts[5] || '1';

          const lastService = await db.prepare("SELECT cf_domain FROM services WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(targetUser).first();
          let preSelectedDomain = lastService ? lastService.cf_domain : null;

          if (preSelectedDomain) {
              await callTelegram('editMessageReplyMarkup', { chat_id, message_id: msg_id, reply_markup: { inline_keyboard: [] } });
              
              if (call.message.photo) {
                  await callTelegram('editMessageCaption', { chat_id, message_id: msg_id, caption: "✅ رسید تایید شد. در حال شارژ خودکار..." });
              } else {
                  await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: "✅ درخواست تایید شد. در حال شارژ و ارسال به کاربر...", parse_mode: "HTML" });
              }
              
              let applyDays = days;
              let applyHours = hours;
              let applySingle = userType === '1';

              if (action === 'test') {
                applyHours = parseInt(applyDays) * 24;
                applyDays = 0;
                applySingle = true; 
              }

              let normalizedDomain = preSelectedDomain.trim();
              if (!normalizedDomain.startsWith('http')) normalizedDomain = 'https://' + normalizedDomain;
              normalizedDomain = normalizedDomain.replace(/\/$/, "");

              const cfRes = await updateCloudflareExp(normalizedDomain, applyDays, applyHours, applySingle, targetUser, db);
              
              if (cfRes.success && cfRes.subLink) {
                  const shamsiNow = getShamsiNow();
                  const planName = action === 'test' ? `تست ${days} روزه` : `سرویس ${days} روزه (${applySingle ? 'یک کاربره' : 'چند کاربره'})`;
                  const planTypeDb = action === 'test' ? "اکانت تست (رایگان)" : "Normal";

                  if (action === 'test') {
                    await db.prepare("INSERT INTO users (user_id, last_test_date) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_test_date = excluded.last_test_date").bind(targetUser, getShamsiDateOnly()).run();
                  } 
                  
                  await db.prepare("INSERT INTO services (user_id, plan_days, plan_type, cf_domain, sub_link, exp_date, status, purchase_date_shamsi) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                      .bind(targetUser, days, planTypeDb, normalizedDomain, cfRes.subLink, cfRes.newExpDate, 'ACTIVE', shamsiNow).run();
                  
                  await clearState(db, targetUser);

                  const uRow = await db.prepare("SELECT first_name, username FROM users WHERE user_id = ?").bind(targetUser).first();
                  const userLink = getUserLink(targetUser, uRow ? uRow.first_name : "کاربر", uRow ? uRow.username : "");

                  // ارسال پیام به کاربر
                  const userCaption = `✅ <b>سرویس اختصاصی شما با موفقیت شارژ/فعال شد!</b>\n\n👤 <b>کاربر:</b> ${userLink}\n🆔 <b>آیدی:</b> <code>${targetUser}</code>\n📦 <b>بسته خریداری شده:</b> ${planName}\n📅 <b>تاریخ ثبت:</b> ${shamsiNow}\n\n🔗 <b>لینک اتصال سابسکریپشن:</b>\n<code>${cfRes.subLink}</code>\n\n💡 <i>از دکمه‌های زیر برای افزودن سریع به برنامه استفاده کنید یا بارکد را اسکن نمایید.</i>`;
                  await callTelegram('sendPhoto', { chat_id: targetUser, photo: getQRUrl(cfRes.subLink), caption: userCaption, parse_mode: 'HTML', reply_markup: getImportKeyboard(cfRes.subLink, botOrigin) });
                  await sendMessage(targetUser, "✅ عملیات با موفقیت انجام شد و به منوی اصلی بازگشتید.", mainMenu(targetUser));
                  
                  // ارسال تاییدیه به ادمین
                  const adminCaption = `✅ <b>شارژ خودکار اکانت با موفقیت انجام شد!</b>\n\n👤 <b>کاربر:</b> ${userLink}\n🆔 <b>آیدی:</b> <code>${targetUser}</code>\n📦 <b>بسته:</b> ${planName}\n🔗 <b>لینک اتصال:</b>\n<code>${cfRes.subLink}</code>`;
                  await callTelegram('sendPhoto', { chat_id: ADMIN_ID, photo: getQRUrl(cfRes.subLink), caption: adminCaption, parse_mode: 'HTML' });
                  
              } else {
                  await sendMessage(ADMIN_ID, `❌ <b>خطا در ارتباط با ورکر!</b>\n💬 <b>دلیل خطا:</b> ${cfRes.error}`);
              }
              return new Response('OK');
          }

          // کاربر جدید بدون ورکر قبلی
          await callTelegram('editMessageReplyMarkup', { chat_id, message_id: msg_id, reply_markup: { inline_keyboard: [] } });
          
          if (call.message.photo) {
              await callTelegram('editMessageCaption', { chat_id, message_id: msg_id, caption: "✅ رسید تایید شد. کاربر ورکری ندارد، لطفاً ورکر جدید را وارد کنید.", parse_mode: "HTML" });
          } else {
              await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: "✅ درخواست تایید شد. کاربر ورکری ندارد، لطفاً ورکر جدید را وارد کنید.", parse_mode: "HTML" });
          }

          await setState(db, ADMIN_ID, { step: 'WAIT_DOMAIN', target_user: targetUser, days, hours, action, user_type: userType });
          
          const { results: savedDomains } = await db.prepare("SELECT id, domain FROM admin_domains ORDER BY id DESC LIMIT 5").all();
          let admMsg = `🔗 کاربر جدید است. لطفاً <b>آدرس دامنه ورکر (لینک اصلی)</b> را برای اختصاص دادن به این کاربر تایپ و ارسال کنید.`;
          let mkb = { inline_keyboard: [] };
          
          if (savedDomains && savedDomains.length > 0) {
            admMsg += `\n\n⚡️ یا از دامنه‌های ذخیره شده زیر یکی را انتخاب کنید:`;
            mkb.inline_keyboard = savedDomains.map(d => [{ text: d.domain, callback_data: `admsel_${d.id}` }]);
          }
          mkb.inline_keyboard.push([{ text: "❌ انصراف از این عملیات", callback_data: "cancel_admin" }]);
          
          await sendMessage(ADMIN_ID, admMsg, mkb);
        }

        // ================= شارژ روی دامنه‌های ذخیره‌شده ادمین =================
        else if (data.startsWith('admsel_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const domain_id = data.split('_')[1];
          const row = await db.prepare("SELECT domain FROM admin_domains WHERE id = ?").bind(domain_id).first();
          if (row) {
            
            let normalizedDomain = row.domain.trim();
            if (!normalizedDomain.startsWith('http')) normalizedDomain = 'https://' + normalizedDomain;
            normalizedDomain = normalizedDomain.replace(/\/$/, "");

            const processState = await getState(db, ADMIN_ID);

            if (processState) {
                const duplicateCheck = await db.prepare("SELECT user_id FROM services WHERE cf_domain = ? AND user_id != ? LIMIT 1").bind(normalizedDomain, processState.target_user).first();
                if (duplicateCheck) {
                    await sendMessage(ADMIN_ID, `❌ <b>خطای امنیتی:</b> این ورکر ذخیره‌شده (<code>${normalizedDomain}</code>) متعلق به کاربر دیگری (آیدی: <a href="tg://user?id=${duplicateCheck.user_id}">${duplicateCheck.user_id}</a>) است.\nعملیات لغو شد.`);
                    return new Response('OK');
                }

                await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: `⏳ در حال اعمال تنظیمات روی دامنه:\n${normalizedDomain}`, parse_mode: "HTML" });
                
                let applyDays = processState.days;
                let applyHours = processState.hours;
                let applySingle = processState.user_type === '1';

                if (processState.action === 'test') {
                  applyHours = parseInt(applyDays) * 24;
                  applyDays = 0;
                  applySingle = true; 
                }

                const cfRes = await updateCloudflareExp(normalizedDomain, applyDays, applyHours, applySingle, processState.target_user, db);
                
                if (cfRes.success && cfRes.subLink) {
                  const shamsiNow = getShamsiNow();
                  const planName = processState.action === 'test' ? `تست ${processState.days} روزه` : `سرویس ${processState.days} روزه (${processState.user_type === '1' ? 'یک کاربره' : 'چند کاربره'})`;
                  const planTypeDb = processState.action === 'test' ? "اکانت تست (رایگان)" : "Normal";
                  
                  if (processState.action === 'test') {
                    await db.prepare("INSERT INTO users (user_id, last_test_date) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_test_date = excluded.last_test_date").bind(processState.target_user, getShamsiDateOnly()).run();
                  } 
                  
                  await db.prepare("INSERT INTO services (user_id, plan_days, plan_type, cf_domain, sub_link, exp_date, status, purchase_date_shamsi) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                      .bind(processState.target_user, processState.days, planTypeDb, normalizedDomain, cfRes.subLink, cfRes.newExpDate, 'ACTIVE', shamsiNow).run();
                  
                  await clearState(db, processState.target_user);

                  const uRow = await db.prepare("SELECT first_name, username FROM users WHERE user_id = ?").bind(processState.target_user).first();
                  const userLink = getUserLink(processState.target_user, uRow ? uRow.first_name : "کاربر", uRow ? uRow.username : "");

                  const userCaption = `✅ <b>سرویس اختصاصی شما آماده و فعال شد!</b>\n\n👤 <b>کاربر:</b> ${userLink}\n🆔 <b>آیدی:</b> <code>${processState.target_user}</code>\n📦 <b>بسته خریداری شده:</b> ${planName}\n📅 <b>تاریخ ثبت:</b> ${shamsiNow}\n\n🔗 <b>لینک سابسکریپشن شما:</b>\n<code>${cfRes.subLink}</code>\n\n💡 <i>از دکمه‌های زیر برای افزودن سریع به برنامه استفاده کنید.</i>`;
                  await callTelegram('sendPhoto', { chat_id: processState.target_user, photo: getQRUrl(cfRes.subLink), caption: userCaption, parse_mode: 'HTML', reply_markup: getImportKeyboard(cfRes.subLink, botOrigin) });
                  await sendMessage(processState.target_user, "✅ درخواست شما تایید و اعمال شد. به منوی اصلی بازگشتید.", mainMenu(processState.target_user));
                  
                  const adminCaption = `✅ <b>تحویل سرویس به کاربر با موفقیت انجام شد.</b>\n\n👤 <b>کاربر:</b> ${userLink}\n🆔 <b>آیدی:</b> <code>${processState.target_user}</code>\n📦 <b>بسته:</b> ${planName}\n🔗 <b>لینک:</b>\n<code>${cfRes.subLink}</code>`;
                  await callTelegram('sendPhoto', { chat_id: ADMIN_ID, photo: getQRUrl(cfRes.subLink), caption: adminCaption, parse_mode: 'HTML' });
                  
                  await clearState(db, ADMIN_ID);
                } else {
                  const errKb = { inline_keyboard: [[{ text: "❌ انصراف از این عملیات", callback_data: "cancel_admin" }]] };
                  await sendMessage(ADMIN_ID, `❌ <b>خطا در ارتباط با ورکر!</b>\n💬 <b>دلیل خطا:</b> ${cfRes.error}\n\n💡 <i>لطفاً آدرس صحیح دامنه ورکر را مجدداً ارسال کنید یا عملیات را لغو کنید.</i>`, errKb);
                }
            }
          }
        }

        await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
      }

    } catch (e) {
      console.log("Error:", e);
      try {
         await sendMessage(ADMIN_ID, `❌ خطای سیستمی رخ داد:\n<code>${e.message}</code>`);
      } catch(err) {}
    }

    return new Response('OK', { status: 200 });
  }
};
