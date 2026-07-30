// ================= تنظیمات اصلی =================
const TOKEN = '8452962087:AAH-WX6MIxTuBNj0YS6YkrwhMjlavT-9uaU';
const ADMIN_ID = 8081586840;
const CARD_NUMBER = "6037-9973-7667-2938 بنام علی فرجی";
const SUPPORT_ID = "@mrpcdesigner";
const PIC_UPDATE_SUB = "https://example.com/update_sub_tutorial.jpg";
const PIC_V2BOX_SETUP = "https://example.com/v2box_setup_tutorial.jpg";
const CF_ADMIN_PATH = "my-secret-admin-9988";
const CF_ADMIN_TOKEN = "admin12345";
const FIXED_TUNNEL_LINK = "https://my-secure-tu0nnel.signalalizahra.workers.dev/sub?target=mixed&token=e72e4985b47c12443f0dcd9e3caa80b4"; // لینک اتصال کمکی

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
async function updateCloudflareExp(domain, daysToAdd, hoursToAdd = 0, singleUser = false, db = null) {
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
    
    // نکته: اگر انقضا در آینده باشد، این قسمت مقدار جدید را به روزهای باقیمانده اضافه می‌کند (جمع می‌شود)
    if (currentData.exp && currentData.exp > baseDate.getTime()) {
      baseDate = new Date(currentData.exp);
    } else if (db) {
      try {
        let cleanMatch = apiDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
        const existing = await db.prepare("SELECT exp_date FROM services WHERE cf_domain LIKE ? ORDER BY id DESC LIMIT 1").bind(`%${cleanMatch}%`).first();
        if (existing && existing.exp_date) {
          const expD = new Date(existing.exp_date);
          if (!isNaN(expD) && expD > baseDate) {
            baseDate = expD; 
          }
        }
      } catch(e) { console.log("DB Fetch Error:", e); }
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
      [{ text: "👥 لیست کامل کاربران و خریدها" }, { text: "مدیریت کاربران (ویرایش/حذف)" }], 
      [{ text: "📖 راهنمای پنل ادمین" }],
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
        let state = await getState(db, user_id);
        
        // دکمه‌های اصلی ربات برای نادیده گرفتن در پیام شخصی
        const mainCommands = ["/start", "🔙 مرحله قبل", "🏠 بازگشت به منوی اصلی", "🔙 بازگشت به پنل کاربری", "❌ لغو عملیات", "⚙️ ورود به پنل مدیریت حرفه‌ای", "📦 سرویس‌های من", "👥 لیست کامل کاربران و خریدها", "مدیریت کاربران (ویرایش/حذف)", "📖 راهنمای پنل ادمین", "📚 آموزش‌ها", "🔄 آموزش آپدیت کردن لینک (بروزرسانی)", "🚀 آموزش راه‌اندازی در V2Box", "📞 ارتباط با پشتیبانی", "🛒 خرید سرویس", "🎁 دریافت اکانت رایگان (تست)"];

        // ثبت یا آپدیت نام کاربر در شروع
        if (text === '/start') {
          const f_name = msg.from.first_name || "";
          const u_name = msg.from.username || "";
          await clearState(db, user_id);
          await db.prepare("INSERT INTO users (user_id, first_name, username, join_date_shamsi) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET first_name=excluded.first_name, username=excluded.username").bind(user_id, f_name, u_name, getShamsiNow()).run();
          const welcome = `\u200F👋 <b>به ربات هوشمند ما خوش آمدید!</b>\n\n💡 <b>هدیه ویژه ما:</b> کاربران جدید برای بار اول یک اکانت <b>تست ۲ روزه (تک‌کاربره)</b> رایگان دریافت می‌کنند. همچنین تمامی کاربران می‌توانند <b>هر ماه یکبار، یک اکانت رایگان ۱ روزه</b> دریافت کنند!\n\nپایداری، سرعت و امنیت را با ما تجربه کنید. لطفاً از منوی زیر یک گزینه را انتخاب کنید 👇`;
          await sendMessage(chat_id, welcome, mainMenu(user_id));
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
             
             let adminState = await getState(db, ADMIN_ID);
             if (adminState && adminState.target_user == user_id) {
                 await clearState(db, ADMIN_ID);
                 await sendMessage(ADMIN_ID, `⚠️ کاربر (آیدی: <code>${user_id}</code>) فرآیند را لغو کرد. عملیات ثبت ورکر متوقف شد.`, adminPanelMenu());
             }

             await clearState(db, user_id);
             await sendMessage(chat_id, "✅ عملیات با موفقیت لغو شد و به منوی اصلی بازگشتید.", mainMenu(user_id));
          } else if (!msg.photo) {
             await sendMessage(chat_id, "⏳ <b>شما یک درخواست در حال بررسی دارید!</b>\nبرای انجام عملیات جدید باید منتظر پاسخ ادمین باشید یا درخواست فعلی را لغو کنید.", pendingMenu());
          }
          // اگر عکس بفرستد (برای ویرایش رسید) در بلاک msg.photo در پایین هندل می‌شود
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
        
        if (text === "📖 راهنمای پنل ادمین" && user_id === ADMIN_ID) {
          const guide = `📖 <b>راهنمای پنل مدیریت ربات</b>\n\n` +
          `🔹 <b>لیست کاربران:</b> نمایش ۲۰ کاربر آخر به همراه تاریخچه کامل خریدهایشان.\n` +
          `🔹 <b>مدیریت کاربران:</b> با وارد کردن آیدی عددی هر کاربر، لیست سرویس‌های او ظاهر می‌شود و می‌توانید با دکمه شیشه‌ای، دیتابیس آن سرویس را برای همیشه حذف کنید تا دیگر کاربر به آن لینک دسترسی نداشته باشد.\n` +
          `🔹 <b>تایید رسیدها:</b> وقتی کاربری رسید خرید می‌فرستد، تا زمانی که شما تایید یا رد نکرده‌اید، کاربر می‌تواند عکس رسید را عوض و ویرایش کند (تا اشتباهی رخ ندهد).\n` +
          `🔹 <b>پیام‌های شخصی:</b> کاربران می‌توانند مستقیماً در ربات برای شما پیام بنویسند و ربات آن‌ها را به پی‌وی شما می‌فرستد.`;
          await sendMessage(chat_id, guide);
          return new Response('OK');
        }
        
        if (text === "مدیریت کاربران (ویرایش/حذف)" && user_id === ADMIN_ID) {
          await setState(db, ADMIN_ID, { step: 'ADMIN_MANAGE_USER' });
          await sendMessage(chat_id, "لطفاً آیدی عددی (User ID) کاربر مورد نظر را برای مدیریت سرویس‌هایش ارسال کنید:", backAndSupportKeyboard());
          return new Response('OK');
        }

        if (state && state.step === 'ADMIN_MANAGE_USER' && user_id === ADMIN_ID && !mainCommands.includes(text)) {
          const target_uid = parseInt(text.trim());
          if (isNaN(target_uid)) {
              await sendMessage(chat_id, "❌ لطفاً یک آیدی عددی معتبر ارسال کنید.");
              return new Response('OK');
          }
          const { results: userSrvs } = await db.prepare("SELECT * FROM services WHERE user_id = ? ORDER BY id DESC").bind(target_uid).all();
          if (!userSrvs || userSrvs.length === 0) {
              await sendMessage(chat_id, "❌ این کاربر هیچ سرویسی ندارد.");
              return new Response('OK');
          }
          await sendMessage(chat_id, `⚙️ <b>مدیریت سرویس‌های کاربر:</b> <code>${target_uid}</code>`);
          for (const s of userSrvs) {
              const kb = {
                  inline_keyboard: [
                      [{ text: "❌ حذف کامل این سرویس", callback_data: `admdelsrv_${s.id}_${target_uid}` }]
                  ]
              };
              const sTxt = `📦 <b>سرویس ${s.plan_days} روزه</b>\n🌐 دامنه: <code>${s.cf_domain}</code>\nتاریخ خرید: ${s.purchase_date_shamsi}\nوضعیت: ${s.status}`;
              await sendMessage(chat_id, sTxt, kb);
          }
          await clearState(db, ADMIN_ID);
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
            let row = [];

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
                 row.push({ text: `🔗 اتصال به سرویس ${idx + 1}`, callback_data: `getqr_${s.id}` });
                 if (row.length === 1) {
                     inline_keyboard.push(row);
                     row = [];
                 }
              }
            });
            if (row.length > 0) inline_keyboard.push(row);

            await sendMessage(chat_id, msgText, inline_keyboard.length > 0 ? { inline_keyboard } : null);
            return new Response('OK');
        }

        if (text === "👥 لیست کامل کاربران و خریدها" && user_id === ADMIN_ID) {
          const { results: users } = await db.prepare("SELECT user_id, join_date_shamsi FROM users ORDER BY user_id DESC LIMIT 20").all();
          if (!users || users.length === 0) {
            await sendMessage(chat_id, "هیچ کاربری در دیتابیس ثبت نشده است.");
            return new Response('OK');
          }

          let text_chunk = "👥 <b>گزارش جامع تمام کاربران:</b>\n\n";
          for (const u of users) {
            const uid = u.user_id;
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
            
            const user_info = `👤 <b>کاربر:</b> <a href="tg://user?id=${uid}">${uid}</a>\n📅 <b>عضویت:</b> ${join_date}\n\n📦 <b>تاریخچه خریدهـا و تـست‌ها:</b>\n${service_text}➖➖➖➖➖➖➖➖\n`;
            
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
        if (text === "📞 ارتباط با پشتیبانی") {
          await sendMessage(chat_id, `👨‍💻 تیم پشتیبانی ما همیشه پاسخگوی شماست.\n\n💡 <b>راهنمای پیام خصوصی:</b>\nشما می‌توانید به راحتی متن سوال یا پیام خود را مستقیماً در همین ربات تایپ کرده و ارسال کنید تا پیام شما مستقیماً برای مدیریت فرستاده شود!\n\nیا در صورت نیاز به آیدی زیر پیام دهید:\n${SUPPORT_ID}`);
          return new Response('OK');
        }

        if (text === "🛒 خرید سرویس") {
          const rules = "\u200F⚠️ <b>قوانین سرویس:</b>\nسرویس‌های ما کاملاً نامحدود هستند، اما شامل قانون مصرف منصفانه می‌شوند. در صورت مصرف غیرعادی، اکانت موقتاً قطع شده و از روز بعد متصل می‌گردد.\n\n⏳ لطفاً مدت زمان سرویس خود را انتخاب کنید:";
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
          
          const first_name = msg.from.first_name ? msg.from.first_name.replace(/[<>&]/g, '') : "کاربر";
          const username = msg.from.username ? `(@${msg.from.username})` : "";
          const userLink = `<a href="tg://user?id=${user_id}">${first_name}</a> ${username}`.trim();

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

        // ================= پردازش عکس‌های ارسالی (رسید و ویرایش رسید) =================
        if (msg.photo) {
          if (state && state.step === 'WAIT_RECEIPT') {
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
            
            const first_name = msg.from.first_name ? msg.from.first_name.replace(/[<>&]/g, '') : "کاربر";
            const username = msg.from.username ? `(@${msg.from.username})` : "";
            const userLink = `<a href="tg://user?id=${user_id}">${first_name}</a> ${username}`.trim();

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
            // ذخیره برای ویرایش بعدی
            state.admin_caption = caption;
            state.admin_markup = admMarkup;

            const adminMsgRes = await callTelegram('sendPhoto', { chat_id: ADMIN_ID, photo: photoId, caption: caption, parse_mode: "HTML", reply_markup: admMarkup });
            if (adminMsgRes && adminMsgRes.ok) {
                state.admin_message_id = adminMsgRes.result.message_id;
            }
            await setState(db, user_id, state);
            
            await sendMessage(user_id, "✅ رسید شما ارسال شد و در صف بررسی قرار گرفت.\n💡 در صورت اشتباه بودن رسید، می‌توانید مجدداً عکس صحیح را همینجا ارسال کنید تا جایگزین شود.", pendingMenu());
            return new Response('OK');
          } 
          // امکان ویرایش رسید تا زمانی که ادمین تایید نکرده
          else if (state && state.step === 'PENDING_ADMIN' && !state.is_test) {
            const photoId = msg.photo[msg.photo.length - 1].file_id;
            await callTelegram('editMessageMedia', {
                chat_id: ADMIN_ID,
                message_id: state.admin_message_id,
                media: {
                    type: 'photo',
                    media: photoId,
                    caption: "🔄 <b>(رسید ویرایش و جایگزین شده)</b>\n\n" + (state.admin_caption || ""),
                    parse_mode: 'HTML'
                },
                reply_markup: state.admin_markup
            });
            await sendMessage(user_id, "✅ رسید شما با موفقیت ویرایش و عکس جدید برای پشتیبانی ارسال گردید.", pendingMenu());
            return new Response('OK');
          }
        }

        // ================= پیام‌های متنی آزاد و سیستم PM =================
        if (text && !mainCommands.includes(text) && (!state || state.step === 'CONFIRM_PM')) {
            // اگر قبلاً در حالت ارسال نبود و یک متن آزاد فرستاد
            if (!state || state.step !== 'CONFIRM_PM') {
                await setState(db, user_id, { step: 'CONFIRM_PM', pm_text: text });
                await sendMessage(chat_id, "💬 <b>سیستم پشتیبانی</b>\n\nآیا مایل هستید پیام زیر مستقیماً برای پشتیبانی ارسال شود؟\n\n" + text, {
                    inline_keyboard: [
                        [{text: "✅ بله، ارسال شود", callback_data: "send_pm"}],
                        [{text: "❌ لغو", callback_data: "cancel_pm"}]
                    ]
                });
                return new Response('OK');
            }
        }

        // ================= دریافت دامنه ورکر توسط ادمین (اولین بار کاربر) =================
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

          const cfRes = await updateCloudflareExp(domainInput, applyDays, applyHours, applySingle, db);
          
          if (cfRes.success && cfRes.subLink) {
            await db.prepare("INSERT OR IGNORE INTO admin_domains (domain) VALUES (?)").bind(domainInput).run();

            const shamsiNow = getShamsiNow();
            const newExpDateStr = cfRes.newExpDate; 
            const planName = state.action === 'test' ? `تست ${state.days} روزه` : `سرویس ${state.days} روزه (${state.user_type === '1' ? 'یک کاربره' : 'چند کاربره'})`;
            const planTypeDb = state.action === 'test' ? "اکانت تست (رایگان)" : "Normal";
            
            if (state.action === 'test') {
              await db.prepare("UPDATE users SET last_test_date = ? WHERE user_id = ?").bind(getShamsiDateOnly(), state.target_user).run();
            }
            
            await db.prepare("INSERT INTO services (user_id, plan_days, plan_type, cf_domain, sub_link, exp_date, status, purchase_date_shamsi) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                .bind(state.target_user, state.days, planTypeDb, domainInput, cfRes.subLink, newExpDateStr, 'ACTIVE', shamsiNow).run();
            
            await clearState(db, state.target_user);

            const userCaption = `✅ <b>سرویس اختصاصی شما آماده و فعال شد!</b>\n\n📦 <b>بسته:</b> ${planName}\n📅 <b>تاریخ ثبت:</b> ${shamsiNow}\n\n🔗 <b>لینک اختصاصی شما:</b>\n<code>${cfRes.subLink}</code>\n\n🛡 <b>لینک امن و کمکی:</b>\n<code>${FIXED_TUNNEL_LINK}</code>\n\n💡 <i>از دکمه‌های زیر برای افزودن سریع به برنامه استفاده کنید یا بارکد را اسکن نمایید.</i>`;
            await callTelegram('sendPhoto', { chat_id: state.target_user, photo: getQRUrl(cfRes.subLink), caption: userCaption, parse_mode: 'HTML', reply_markup: getImportKeyboard(cfRes.subLink, botOrigin) });
            await sendMessage(state.target_user, "✅ درخواست شما تایید و اعمال شد. به منوی اصلی بازگشتید.", mainMenu(state.target_user));

            const uRow = await db.prepare("SELECT first_name, username FROM users WHERE user_id = ?").bind(state.target_user).first();
            let uName = "کاربر"; let uUsername = "";
            if (uRow) { if (uRow.first_name) uName = uRow.first_name.replace(/[<>&]/g, ''); if (uRow.username) uUsername = `(@${uRow.username})`; }
            const userLink = `<a href="tg://user?id=${state.target_user}">${uName}</a> ${uUsername}`.trim();

            const adminCaption = `✅ <b>تحویل سرویس به کاربر با موفقیت انجام شد.</b>\n\n👤 <b>کاربر:</b> ${userLink}\n🆔 <b>آیدی:</b> <code>${state.target_user}</code>\n📦 <b>بسته:</b> ${planName}\n🔗 <b>لینک:</b>\n<code>${cfRes.subLink}</code>`;
            await callTelegram('sendPhoto', { chat_id: ADMIN_ID, photo: getQRUrl(cfRes.subLink), caption: adminCaption, parse_mode: 'HTML' });
            
            await clearState(db, ADMIN_ID);
          } else {
            const errKb = { inline_keyboard: [[{ text: "❌ انصراف از این عملیات", callback_data: "cancel_admin" }]] };
            await sendMessage(ADMIN_ID, `❌ <b>خطا در ارتباط با ورکر!</b>\n💬 <b>دلیل خطا:</b> ${cfRes.error}\n\n💡 <i>لطفاً آدرس صحیح دامنه ورکر را مجدداً ارسال کنید یا عملیات را لغو کنید.</i>`, errKb);
          }
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

        // پیام سیستم شخصی
        if (data === 'send_pm') {
            await callTelegram('editMessageReplyMarkup', { chat_id, message_id: msg_id, reply_markup: { inline_keyboard: [] } });
            await callTelegram('sendMessage', { chat_id: ADMIN_ID, text: `💬 <b>پیام جدید از کاربر:</b> <a href="tg://user?id=${user_id}">${user_id}</a>\n\n${state.pm_text}`, parse_mode: 'HTML' });
            await clearState(db, user_id);
            await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: "✅ پیام شما با موفقیت برای پشتیبانی ارسال شد." });
            return new Response('OK');
        }
        if (data === 'cancel_pm') {
            await clearState(db, user_id);
            await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: "❌ ارسال پیام لغو شد." });
            return new Response('OK');
        }

        if (state && state.step === 'PENDING_ADMIN' && user_id !== ADMIN_ID && !data.startsWith('adm')) {
            await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "⏳ درخواست شما در حال بررسی است. لطفا منتظر بمانید.", show_alert: true });
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

        if (data.startsWith('admdelsrv_')) {
            if (user_id !== ADMIN_ID) return new Response('OK');
            const srvId = data.split('_')[1];
            await db.prepare("DELETE FROM services WHERE id = ?").bind(srvId).run();
            await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: "✅ این سرویس با موفقیت از دیتابیس ربات حذف شد." });
            return new Response('OK');
        }

        if (data.startsWith('getqr_')) {
          const serviceId = data.split('_')[1];
          const srv = await db.prepare("SELECT sub_link FROM services WHERE id = ? AND user_id = ?").bind(serviceId, user_id).first();
          if (srv && srv.sub_link) {
              const txt = `📱 <b>بارکد (QR Code) و لینک اشتراک شما</b>\n\n🔗 <b>لینک اختصاصی شما:</b>\n<code>${srv.sub_link}</code>\n\n🛡 <b>لینک کمکی و امن:</b>\n<code>${FIXED_TUNNEL_LINK}</code>\n\nجهت اتصال سریع، روی دکمه‌های زیر کلیک کنید یا بارکد را اسکن نمایید.`;
              await callTelegram('sendPhoto', { chat_id, photo: getQRUrl(srv.sub_link), caption: txt, parse_mode: 'HTML', reply_markup: getImportKeyboard(srv.sub_link, botOrigin) });
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
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: "\u200F👥 نوع مصرف را مشخص کنید:", reply_markup: kb, parse_mode: "HTML" });
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
          
          const factor = `\u200F💳 <b>فاکتور سرویس ${state.days} روزه (${state.type})</b>\n💵 مبلغ سرویس: <b>${formattedPrice} تومان</b>\n\nلطفاً مبلغ فوق را به شماره کارت زیر واریز کرده و <b>عکس رسید تراکنش</b> را همینجا ارسال کنید:\n\n💳 <code>${CARD_NUMBER}</code>\n\n⏱ <i>شما ۱۰ دقیقه برای ارسال رسید فرصت دارید.</i>`;
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
          await sendMessage(targetUser, "❌ متاسفانه درخواست یا رسید پرداختی شما توسط پشتیبانی رد شد. در صورت بروز مشکل مجدداً اقدام کنید یا پیام بدهید.", mainMenu(targetUser));
        }

        // ================= شارژ و تایید اکانت =================
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

              const cfRes = await updateCloudflareExp(normalizedDomain, applyDays, applyHours, applySingle, db);
              
              if (cfRes.success && cfRes.subLink) {
                  const shamsiNow = getShamsiNow();
                  const planName = action === 'test' ? `تست ${days} روزه` : `سرویس ${days} روزه (${applySingle ? 'یک کاربره' : 'چند کاربره'})`;
                  const planTypeDb = action === 'test' ? "اکانت تست (رایگان)" : "Normal";

                  if (action === 'test') {
                    await db.prepare("UPDATE users SET last_test_date = ? WHERE user_id = ?").bind(getShamsiDateOnly(), targetUser).run();
                  } 
                  
                  await db.prepare("INSERT INTO services (user_id, plan_days, plan_type, cf_domain, sub_link, exp_date, status, purchase_date_shamsi) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                      .bind(targetUser, days, planTypeDb, normalizedDomain, cfRes.subLink, cfRes.newExpDate, 'ACTIVE', shamsiNow).run();
                  
                  await clearState(db, targetUser);

                  const userCaption = `✅ <b>سرویس اختصاصی شما با موفقیت شارژ/فعال شد!</b>\n\n📦 <b>بسته خریداری شده:</b> ${planName}\n📅 <b>تاریخ ثبت:</b> ${shamsiNow}\n\n🔗 <b>لینک اختصاصی شما:</b>\n<code>${cfRes.subLink}</code>\n\n🛡 <b>لینک امن و کمکی:</b>\n<code>${FIXED_TUNNEL_LINK}</code>\n\n💡 <i>از دکمه‌های زیر برای افزودن سریع به برنامه استفاده کنید یا بارکد را اسکن نمایید.</i>`;
                  await callTelegram('sendPhoto', { chat_id: targetUser, photo: getQRUrl(cfRes.subLink), caption: userCaption, parse_mode: 'HTML', reply_markup: getImportKeyboard(cfRes.subLink, botOrigin) });
                  await sendMessage(targetUser, "✅ عملیات با موفقیت انجام شد و به منوی اصلی بازگشتید.", mainMenu(targetUser));
                  
                  const uRow = await db.prepare("SELECT first_name, username FROM users WHERE user_id = ?").bind(targetUser).first();
                  let uName = "کاربر"; let uUsername = "";
                  if (uRow) { if (uRow.first_name) uName = uRow.first_name.replace(/[<>&]/g, ''); if (uRow.username) uUsername = `(@${uRow.username})`; }
                  const userLink = `<a href="tg://user?id=${targetUser}">${uName}</a> ${uUsername}`.trim();

                  const adminCaption = `✅ <b>شارژ خودکار اکانت با موفقیت انجام شد!</b>\n\n👤 <b>کاربر:</b> ${userLink}\n🆔 <b>آیدی:</b> <code>${targetUser}</code>\n📦 <b>بسته:</b> ${planName}\n🔗 <b>لینک:</b>\n<code>${cfRes.subLink}</code>`;
                  await callTelegram('sendPhoto', { chat_id: ADMIN_ID, photo: getQRUrl(cfRes.subLink), caption: adminCaption, parse_mode: 'HTML' });
                  
              } else {
                  await sendMessage(ADMIN_ID, `❌ <b>خطا در ارتباط با ورکر!</b>\n💬 <b>دلیل خطا:</b> ${cfRes.error}`);
              }
              return new Response('OK');
          }

          // دریافت ورکر جدید
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

        // ================= شارژ روی دامنه‌های ذخیره شده ادمین =================
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

                const cfRes = await updateCloudflareExp(normalizedDomain, applyDays, applyHours, applySingle, db);
                
                if (cfRes.success && cfRes.subLink) {
                  const shamsiNow = getShamsiNow();
                  const newExpDateStr = cfRes.newExpDate; 
                  const planName = processState.action === 'test' ? `تست ${processState.days} روزه` : `سرویس ${processState.days} روزه (${processState.user_type === '1' ? 'یک کاربره' : 'چند کاربره'})`;
                  const planTypeDb = processState.action === 'test' ? "اکانت تست (رایگان)" : "Normal";
                  
                  if (processState.action === 'test') {
                    await db.prepare("UPDATE users SET last_test_date = ? WHERE user_id = ?").bind(getShamsiDateOnly(), processState.target_user).run();
                  } 
                  
                  await db.prepare("INSERT INTO services (user_id, plan_days, plan_type, cf_domain, sub_link, exp_date, status, purchase_date_shamsi) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                      .bind(processState.target_user, processState.days, planTypeDb, normalizedDomain, cfRes.subLink, newExpDateStr, 'ACTIVE', shamsiNow).run();
                  
                  await clearState(db, processState.target_user);

                  const userCaption = `✅ <b>سرویس اختصاصی شما آماده و فعال شد!</b>\n\n📦 <b>بسته خریداری شده:</b> ${planName}\n📅 <b>تاریخ ثبت:</b> ${shamsiNow}\n\n🔗 <b>لینک اختصاصی شما:</b>\n<code>${cfRes.subLink}</code>\n\n🛡 <b>لینک امن و کمکی:</b>\n<code>${FIXED_TUNNEL_LINK}</code>\n\n💡 <i>از دکمه‌های زیر برای افزودن سریع به برنامه استفاده کنید.</i>`;
                  await callTelegram('sendPhoto', { chat_id: processState.target_user, photo: getQRUrl(cfRes.subLink), caption: userCaption, parse_mode: 'HTML', reply_markup: getImportKeyboard(cfRes.subLink, botOrigin) });
                  await sendMessage(processState.target_user, "✅ درخواست شما تایید و اعمال شد. به منوی اصلی بازگشتید.", mainMenu(processState.target_user));
                  
                  const uRow = await db.prepare("SELECT first_name, username FROM users WHERE user_id = ?").bind(processState.target_user).first();
                  let uName = "کاربر"; let uUsername = "";
                  if (uRow) { if (uRow.first_name) uName = uRow.first_name.replace(/[<>&]/g, ''); if (uRow.username) uUsername = `(@${uRow.username})`; }
                  const userLink = `<a href="tg://user?id=${processState.target_user}">${uName}</a> ${uUsername}`.trim();

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
