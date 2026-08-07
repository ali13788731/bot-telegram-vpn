// ================= تنظیمات اصلی =================
// 🔒 هیچ مقدار حساسی اینجا هاردکد نشده؛ همه از env (Cloudflare Secrets) خوانده می‌شوند.
// این متغیرها در ابتدای هر fetch() توسط loadConfig(env) مقداردهی می‌شوند.
let TOKEN, ADMIN_ID, CARD_NUMBER, SUPPORT_ID, CF_ADMIN_PATH, CF_ADMIN_TOKEN, WEBHOOK_SECRET;

function loadConfig(env) {
  TOKEN = env.BOT_TOKEN;
  ADMIN_ID = Number(env.ADMIN_ID);
  CARD_NUMBER = env.CARD_NUMBER;
  SUPPORT_ID = env.SUPPORT_ID;
  CF_ADMIN_PATH = env.CF_ADMIN_PATH;
  CF_ADMIN_TOKEN = env.CF_ADMIN_TOKEN;
  WEBHOOK_SECRET = env.WEBHOOK_SECRET;

  const missing = ['BOT_TOKEN', 'ADMIN_ID', 'CARD_NUMBER', 'SUPPORT_ID', 'CF_ADMIN_PATH', 'CF_ADMIN_TOKEN', 'WEBHOOK_SECRET']
    .filter(k => !env[k]);
  if (missing.length) {
    throw new Error(`متغیرهای محیطی زیر تنظیم نشده‌اند: ${missing.join(', ')}`);
  }
}

// جلوگیری از HTML injection وقتی متن آزاد کاربر داخل پیام parse_mode=HTML قرار می‌گیرد
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

// ================= مدیریت پلن‌های اشتراک (کاملاً داینامیک - از جدول plans در دیتابیس خوانده می‌شود) =================
// پلن‌ها دیگر در کد هاردکد نیستند؛ ادمین از داخل ربات (تنظیمات ربات ← مدیریت پلن‌های اشتراک)
// می‌تواند پلن جدید بسازد، نام دکمه/مدت/قیمت تک‌کاربره/قیمت چندکاربره/تاریخ انقضای پیشنهاد را ویرایش کند
// و پلن را به‌جای حذف، غیرفعال یا دوباره فعال کند.

// فقط پلن‌های فعال و هنوز منقضی‌نشده (برای نمایش در لیست خرید)
async function getActivePlans(db) {
  const nowShamsi = getShamsiNow().split(/[ ,-]/)[0];
  const { results } = await db.prepare(
    "SELECT * FROM plans WHERE is_active = 1 AND (expire_date_shamsi IS NULL OR expire_date_shamsi = '' OR expire_date_shamsi >= ?) ORDER BY sort_order ASC, days ASC"
  ).bind(nowShamsi).all();
  return results || [];
}

// همه پلن‌ها (فعال و غیرفعال) برای پنل مدیریت
async function getAllPlans(db) {
  const { results } = await db.prepare("SELECT * FROM plans ORDER BY sort_order ASC, days ASC").all();
  return results || [];
}

async function getPlanById(db, id) {
  return await db.prepare("SELECT * FROM plans WHERE id = ?").bind(id).first();
}

// برای نمایش تقریبیِ قیمت سرویس‌هایی که قبلاً ثبت شده‌اند (گزارش فروش و لیست سرویس‌های کاربر)
// چون این سرویس‌ها فقط plan_days را ذخیره کرده‌اند، جدیدترین پلن با همان مدت را به‌عنوان مرجع قیمت برمی‌گردانیم.
async function getPlanPriceByDays(db, days, isSingle) {
  const plan = await db.prepare("SELECT price_single, price_multi FROM plans WHERE days = ? ORDER BY is_active DESC, id DESC LIMIT 1").bind(days).first();
  if (!plan) return 0;
  return isSingle ? (plan.price_single || 0) : (plan.price_multi || 0);
}

// نسخه دسته‌ای getPlanPriceByDays برای استفاده داخل حلقه‌های sync (forEach) بدون نیاز به await در هر تکرار
async function buildDaysPriceMap(db) {
  const { results } = await db.prepare("SELECT days, price_single, price_multi FROM plans ORDER BY id ASC").all();
  const map = new Map();
  (results || []).forEach(p => map.set(p.days, { single: p.price_single || 0, multi: p.price_multi || 0 }));
  return map;
}

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

// ================= تنظیمات پویا (اکانت تست / جشنواره) - ذخیره در جدول bot_settings =================
const DEFAULT_TRIAL_CONFIG = { is_active: 1, button_text: "🎁 دریافت اکانت رایگان (تست)", first_time_days: 3, repeat_days: 2, cooldown_days: 30, is_single: 1 };
const DEFAULT_FESTIVAL_CONFIG = { is_active: 0, button_text: "🎉 جشنواره ویژه", days: 1, is_single: 1, start_date: "", end_date: "" };

async function getSetting(db, key, defaultValue) {
  try {
    const row = await db.prepare("SELECT value FROM bot_settings WHERE key = ?").bind(key).first();
    if (!row || !row.value) return { ...defaultValue };
    const parsed = JSON.parse(row.value);
    return { ...defaultValue, ...parsed };
  } catch (e) {
    return { ...defaultValue };
  }
}

async function setSetting(db, key, valueObj) {
  await db.prepare("INSERT INTO bot_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, JSON.stringify(valueObj)).run();
}

async function getTrialConfig(db) {
  return await getSetting(db, 'trial_config', DEFAULT_TRIAL_CONFIG);
}

async function getFestivalConfig(db) {
  return await getSetting(db, 'festival_config', DEFAULT_FESTIVAL_CONFIG);
}

// آیا امروز داخل بازه شروع/پایان جشنواره است؟ (تاریخ‌ها به فرمت شمسی رشته‌ای مقایسه می‌شوند)
function isFestivalWindowOpen(cfg) {
  if (!cfg || !cfg.is_active) return false;
  const today = getShamsiNow().split(/[ ,-]/)[0];
  if (cfg.start_date && today < cfg.start_date) return false;
  if (cfg.end_date && today > cfg.end_date) return false;
  return true;
}

// ================= اعتبارسنجی آدرس ورکر قبل از ثبت/ویرایش =================
async function validateWorkerDomain(domain) {
  let apiDomain = domain.trim();
  if (!apiDomain.startsWith('http')) apiDomain = 'https://' + apiDomain;
  apiDomain = apiDomain.replace(/\/$/, "");
  if (apiDomain.includes("?url=")) apiDomain = decodeURIComponent(apiDomain.split("?url=")[1]).replace(/\/$/, "");

  const url = `${apiDomain}/${CF_ADMIN_PATH}?token=${CF_ADMIN_TOKEN}`;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: "getData" }) });
    if (!res.ok) {
      return { success: false, error: `پاسخ سرور ${res.status} (احتمالاً آدرس، مسیر ادمین یا توکن اشتباه است)` };
    }
    let json;
    try {
      json = await res.json();
    } catch (e) {
      return { success: false, error: "پاسخ دریافتی از این آدرس معتبر نیست (JSON نامعتبر). احتمالاً این آدرس یک ورکر معتبر نیست." };
    }
    if (!json || typeof json.data === 'undefined') {
      return { success: false, error: "این آدرس یک ورکر معتبر با توکن ادمین صحیح نیست." };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: `عدم برقراری ارتباط با این آدرس (${e.message})` };
  }
}

// ================= برچسب مدت پلن (همه پلن‌های خریدنی، از جمله ۱ روزه، نامحدود هستند) =================
function planDaysLabel(days) {
  return `${days} روزه نامحدود`;
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

// ================= استخراج وضعیت لحظه‌ای ورکر =================
async function getWorkerStatus(domain) {
  let apiDomain = domain.trim();
  if (!apiDomain.startsWith('http')) apiDomain = 'https://' + apiDomain;
  apiDomain = apiDomain.replace(/\/$/, "");
  if (apiDomain.includes("?url=")) apiDomain = decodeURIComponent(apiDomain.split("?url=")[1]).replace(/\/$/, "");
  
  const url = `${apiDomain}/${CF_ADMIN_PATH}?token=${CF_ADMIN_TOKEN}`;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: "getData" }) });
    if (res.ok) {
      const json = await res.json();
      return json.data || {};
    }
  } catch(e) {}
  return {};
}

// تابع کمکی برای آپدیت درجایِ پیام وضعیت سرویس (بدون خروج از منو)
async function refreshAdminServiceMessage(db, srvId, chat_id, msg_id) {
  const s = await db.prepare("SELECT * FROM services WHERE id = ?").bind(srvId).first();
  if (!s) return;
  
  let expView = "نامشخص";
  if (s.exp_date) {
     const d = new Date(s.exp_date);
     if (!isNaN(d)) expView = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
  }

  let srvMsg = `📦 <b>شناسه سرویس:</b> #${s.id}\n🛍 <b>پلن:</b> ${planDaysLabel(s.plan_days)} (${s.plan_type})\n🌐 <b>ورکر:</b> <code>${s.cf_domain}</code>\n⏳ <b>انقضا:</b> ${expView}\nوضعیت: ${s.status === 'ACTIVE' ? '✅ فعال' : '❌ غیرفعال'}`;
  
  const workerData = await getWorkerStatus(s.cf_domain);
  const isKsActive = workerData.killSwitch === true;
  
  let ksText = isKsActive ? "✅ وصل فوری" : "🛑 قطع فوری";
  let singleMultiText = s.plan_type.includes('یک کاربره') ? "👥 تبدیل به چندکاربره" : "👤 تبدیل به تک‌کاربره";
  
  let kb = {
    inline_keyboard: [
      [{ text: "⏳ صفر کردن زمان", callback_data: `admexpire_${s.id}` }],
      [{ text: "➕ تمدید / شارژ", callback_data: `admrenew_${s.id}` }],
      [{ text: singleMultiText, callback_data: `admmulti_${s.id}` }],
      [{ text: ksText, callback_data: `admks_${s.id}` }],
      [{ text: "🗑 حذف سرویس", callback_data: `admdel_${s.id}` }],
      [{ text: "🔙 بازگشت", callback_data: `admback` }]
    ]
  };
  await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: srvMsg, reply_markup: kb, parse_mode: "HTML" });
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
async function mainMenu(db, user_id) {
  // پنل خرید فقط مخصوص کاربران عادی است؛ ادمین اصلاً این منو را نمی‌بیند.
  // دکمه «دعوت دوستان» فقط زمانی نمایش داده می‌شود که کاربر حداقل یک سرویس با ورکر ثبت‌شده داشته باشد.
  const hasWorker = await db.prepare("SELECT 1 FROM services WHERE user_id = ? AND cf_domain IS NOT NULL AND cf_domain != '' LIMIT 1").bind(user_id).first();
  const trialCfg = await getTrialConfig(db);
  const festivalCfg = await getFestivalConfig(db);

  const keyboard = [];

  // دکمه اکانت تست فقط زمانی نمایش داده می‌شود که ادمین آن را فعال کرده باشد
  if (trialCfg.is_active) {
    keyboard.push([{ text: trialCfg.button_text }]);
  }

  // دکمه جشنواره فقط زمانی نمایش داده می‌شود که فعال باشد و در بازه تاریخ تعیین‌شده باشیم
  if (isFestivalWindowOpen(festivalCfg)) {
    keyboard.push([{ text: festivalCfg.button_text }]);
  }

  keyboard.push([{ text: "🛒 خرید سرویس" }]);
  keyboard.push([{ text: "📚 آموزش‌ها" }]);
  keyboard.push([{ text: "📦 سرویس‌های من" }]);

  if (hasWorker) {
    keyboard.push([{ text: "🤝 دعوت دوستان (هدیه ۵ روزه)" }]);
  }
  keyboard.push([{ text: "👤 وضعیت من" }]);
  keyboard.push([{ text: "📞 ارتباط با پشتیبانی" }]);
  return { keyboard, resize_keyboard: true };
}

function adminPanelMenu() {
  // پنل اصلی و تنها پنل ادمین - همه دکمه‌ها تمام عرض
  return { 
    keyboard: [
      [{ text: "📊 گزارش فروش" }],
      [{ text: "👥 لیست کامل کاربران و خریدها" }],
      [{ text: "🛠 مدیریت سرویس‌های کاربر" }],
      [{ text: "📖 راهنمای پنل مدیریت" }],
      [{ text: "📢 ارسال اطلاعیه" }],
      [{ text: "⚙️ تنظیمات ربات" }]
    ], 
    resize_keyboard: true 
  };
}

function settingsMenu() {
  return {
    keyboard: [
      [{ text: "🧩 مدیریت پلن‌های اشتراک" }],
      [{ text: "🎁 مدیریت اکانت تست و جشنواره" }],
      [{ text: "🎟 مدیریت کدهای تخفیف" }],
      [{ text: "🗑 مدیریت و پاک‌سازی داده‌ها" }],
      [{ text: "🔙 بازگشت به پنل مدیریت" }]
    ],
    resize_keyboard: true
  };
}

// ================= پنل مدیریت اکانت تست و جشنواره =================
function trialFestivalMenu() {
  return { inline_keyboard: [
    [{ text: "🎁 تنظیمات اکانت تست", callback_data: "admtrialcfg" }],
    [{ text: "🎉 تنظیمات جشنواره", callback_data: "admfestivalcfg" }]
  ] };
}

async function renderTrialConfigMessage(db) {
  const cfg = await getTrialConfig(db);
  const isSingle = cfg.is_single !== 0;
  const msg = `🎁 <b>تنظیمات اکانت تست</b>\n\n` +
    `🔘 وضعیت دکمه: ${cfg.is_active ? '✅ فعال' : '🚫 غیرفعال'}\n` +
    `✏️ متن دکمه: ${escapeHtml(cfg.button_text)}\n` +
    `🗓 روزهای تست (بار اول ورود به ربات): <b>${cfg.first_time_days}</b> روز\n` +
    `🔁 روزهای تست (دفعات بعدی): <b>${cfg.repeat_days}</b> روز\n` +
    `⏳ فاصله مجاز بین دو درخواست: هر <b>${cfg.cooldown_days}</b> روز یکبار\n` +
    `👥 نوع اکانت صادرشده: ${isSingle ? '👤 تک‌کاربره' : '👥 چندکاربره'}`;
  const kb = { inline_keyboard: [
    [{ text: cfg.is_active ? "🚫 غیرفعال کردن دکمه تست" : "✅ فعال کردن دکمه تست", callback_data: "admtrial_toggle" }],
    [{ text: "✏️ تغییر متن دکمه", callback_data: "admtrial_edit_button_text" }],
    [{ text: "🗓 تغییر روزهای تست بار اول", callback_data: "admtrial_edit_first_time_days" }],
    [{ text: "🔁 تغییر روزهای تست دفعات بعد", callback_data: "admtrial_edit_repeat_days" }],
    [{ text: "⏳ تغییر فاصله مجاز (روز)", callback_data: "admtrial_edit_cooldown_days" }],
    [{ text: isSingle ? "👥 تغییر به چندکاربره" : "👤 تغییر به تک‌کاربره", callback_data: "admtrial_toggle_single" }],
    [{ text: "🔙 بازگشت", callback_data: "admtrialfestival_menu" }]
  ] };
  return { msg, kb };
}

async function renderFestivalConfigMessage(db) {
  const cfg = await getFestivalConfig(db);
  const isSingle = cfg.is_single !== 0;
  const windowInfo = (cfg.start_date || cfg.end_date) ? `${cfg.start_date || '—'} تا ${cfg.end_date || '—'}` : "تنظیم نشده";
  const msg = `🎉 <b>تنظیمات جشنواره</b>\n\n` +
    `🔘 وضعیت: ${cfg.is_active ? '✅ فعال' : '🚫 غیرفعال'}\n` +
    `✏️ متن دکمه: ${escapeHtml(cfg.button_text)}\n` +
    `🗓 مدت اعتبار اکانت: <b>${cfg.days}</b> روز\n` +
    `📅 بازه زمانی نمایش: ${windowInfo}\n` +
    `👥 نوع اکانت صادرشده: ${isSingle ? '👤 تک‌کاربره' : '👥 چندکاربره'}\n\n` +
    `ℹ️ برخلاف اکانت تست، هر کاربر فقط <b>یک‌بار برای همیشه</b> می‌تواند از جشنواره استفاده کند.`;
  const kb = { inline_keyboard: [
    [{ text: cfg.is_active ? "🚫 غیرفعال کردن جشنواره" : "✅ فعال کردن جشنواره", callback_data: "admfestival_toggle" }],
    [{ text: "✏️ تغییر متن دکمه", callback_data: "admfestival_edit_button_text" }],
    [{ text: "🗓 تغییر مدت اعتبار (روز)", callback_data: "admfestival_edit_days" }],
    [{ text: "📅 تنظیم تاریخ شروع", callback_data: "admfestival_edit_start_date" }],
    [{ text: "📅 تنظیم تاریخ پایان", callback_data: "admfestival_edit_end_date" }],
    [{ text: isSingle ? "👥 تغییر به چندکاربره" : "👤 تغییر به تک‌کاربره", callback_data: "admfestival_toggle_single" }],
    [{ text: "🔙 بازگشت", callback_data: "admtrialfestival_menu" }]
  ] };
  return { msg, kb };
}

// ================= پنل مدیریت و پاک‌سازی موردی داده‌ها =================
function wipeOptionsMenu() {
  return { inline_keyboard: [
    [{ text: "👤 پاک کردن اطلاعات یک کاربر خاص", callback_data: "admwipe_user_prompt" }],
    [{ text: "📦 پاک کردن همه سرویس‌ها", callback_data: "admwipe_ask_services" }],
    [{ text: "👥 پاک کردن همه کاربران", callback_data: "admwipe_ask_users" }],
    [{ text: "🎟 پاک کردن کدهای تخفیف", callback_data: "admwipe_ask_discounts" }],
    [{ text: "🤝 پاک کردن رفرال‌ها", callback_data: "admwipe_ask_referrals" }],
    [{ text: "⏳ پاک کردن وضعیت‌های در حال پردازش", callback_data: "admwipe_ask_user_states" }],
    [{ text: "🌐 پاک کردن دامنه‌های ذخیره‌شده ادمین", callback_data: "admwipe_ask_admin_domains" }],
    [{ text: "🗑 پاک کردن کامل کل دیتابیس", callback_data: "admwipe_ask_all" }]
  ] };
}

const WIPE_TARGET_LABELS = {
  services: "همه سرویس‌ها",
  users: "همه کاربران (به همراه سرویس‌ها، وضعیت‌ها و رفرال‌های مرتبط)",
  discounts: "همه کدهای تخفیف",
  referrals: "همه رفرال‌ها",
  user_states: "وضعیت‌های در حال پردازش کاربران",
  admin_domains: "دامنه‌های ذخیره‌شده ادمین",
  all: "کل دیتابیس (کاربران، سرویس‌ها، وضعیت‌ها، دامنه‌ها، رفرال‌ها، کدهای تخفیف)"
};

async function executeWipe(db, target) {
  if (target === 'services') {
    await db.prepare("DELETE FROM services").run();
  } else if (target === 'users') {
    await db.prepare("DELETE FROM services").run();
    await db.prepare("DELETE FROM user_states").run();
    await db.prepare("DELETE FROM referrals").run();
    await db.prepare("DELETE FROM users").run();
  } else if (target === 'discounts') {
    await db.prepare("DELETE FROM discounts").run();
  } else if (target === 'referrals') {
    await db.prepare("DELETE FROM referrals").run();
  } else if (target === 'user_states') {
    await db.prepare("DELETE FROM user_states").run();
  } else if (target === 'admin_domains') {
    await db.prepare("DELETE FROM admin_domains").run();
  } else if (target === 'all') {
    await db.prepare("DELETE FROM services").run();
    await db.prepare("DELETE FROM users").run();
    await db.prepare("DELETE FROM user_states").run();
    await db.prepare("DELETE FROM admin_domains").run();
    await db.prepare("DELETE FROM referrals").run();
    await db.prepare("DELETE FROM discounts").run();
  }
}

// ================= پنل مدیریت پلن‌های اشتراک =================
async function renderPlansListMessage(db) {
  const plans = await getAllPlans(db);
  if (!plans.length) {
    return { msg: "📭 هیچ پلنی ثبت نشده است.\n\nبرای شروع، یک پلن جدید بسازید:", kb: { inline_keyboard: [[{ text: "➕ افزودن پلن جدید", callback_data: "admaddplan" }]] } };
  }
  let msg = "🧩 <b>مدیریت پلن‌های اشتراک</b>\n\n";
  const rows = [];
  plans.forEach(p => {
    const statusIcon = p.is_active ? "✅" : "🚫";
    const expTxt = p.expire_date_shamsi ? `\n⏳ در دسترس تا: ${p.expire_date_shamsi}` : "";
    msg += `${statusIcon} <b>#${p.id} - ${escapeHtml(p.label)}</b>\n⏱ مدت: ${p.days} روز\n👤 تک‌کاربره: ${(p.price_single || 0).toLocaleString('fa-IR')} تومان\n👥 چندکاربره: ${(p.price_multi || 0).toLocaleString('fa-IR')} تومان${expTxt}\n➖➖➖➖\n`;
    rows.push([{ text: `✏️ ویرایش #${p.id}`, callback_data: `admeditplan_${p.id}` }]);
    rows.push([{ text: p.is_active ? `🚫 غیرفعال #${p.id}` : `✅ فعال‌سازی #${p.id}`, callback_data: `admtoggleplan_${p.id}` }]);
    rows.push([{ text: `🗑 حذف #${p.id}`, callback_data: `admdelplan_${p.id}` }]);
  });
  rows.push([{ text: "➕ افزودن پلن جدید", callback_data: "admaddplan" }]);
  return { msg, kb: { inline_keyboard: rows } };
}

function planEditFieldsKeyboard(planId) {
  return {
    inline_keyboard: [
      [{ text: "✏️ نام دکمه", callback_data: `admeditplanfield_${planId}_label` }],
      [{ text: "⏱ مدت اعتبار (روز)", callback_data: `admeditplanfield_${planId}_days` }],
      [{ text: "👤 قیمت تک‌کاربره", callback_data: `admeditplanfield_${planId}_price_single` }],
      [{ text: "👥 قیمت چندکاربره", callback_data: `admeditplanfield_${planId}_price_multi` }],
      [{ text: "⏳ تاریخ پایان پیشنهاد (اختیاری)", callback_data: `admeditplanfield_${planId}_expire_date_shamsi` }],
      [{ text: "🔙 بازگشت به لیست پلن‌ها", callback_data: "admplanslist" }]
    ]
  };
}

function adminServiceKeyboard(isSingle, isBlocked) {
  return { 
    keyboard: [
      [{ text: "⏳ صفر کردن زمان" }],
      [{ text: "➕ تمدید / شارژ" }],
      [{ text: isSingle ? "👥 تبدیل به چندکاربره" : "👤 تبدیل به تک‌کاربره" }],
      [{ text: isBlocked ? "✅ وصل فوری" : "🛑 قطع فوری" }],
      [{ text: "✏️ ویرایش ورکر" }],
      [{ text: "🔙 بازگشت به پنل مدیریت" }]
    ], 
    resize_keyboard: true 
  };
}

function backAndSupportKeyboard() {
  return { keyboard: [[{ text: "🔙 مرحله قبل" }], [{ text: "🏠 بازگشت به منوی اصلی" }], [{ text: "📞 ارتباط با پشتیبانی" }]], resize_keyboard: true };
}

function pendingMenu() {
  return { keyboard: [[{ text: "❌ لغو عملیات" }]], resize_keyboard: true };
}

function tutorialsMenu() {
  return {
    keyboard: [
      [{ text: "🚀 آموزش برنامه v2ray برای نصب کانفیگ" }],
      [{ text: "📥 آموزش برنامه v2box برای نصب کانفیگ" }],
      [{ text: "💬 راهنمای ارسال پیام به پشتیبانی" }],
      [{ text: "🏠 بازگشت به منوی اصلی" }]
    ], resize_keyboard: true
  };
}

// ================= مجموعه متن تمام دکمه‌های ثابت (کیبورد پایین صفحه) =================
// برای تشخیص این‌که آیا متن ارسالی توسط ادمین «فشردن یک دکمه منو» است یا «ورودی واقعی» (مثل آدرس ورکر)
const FIXED_MENU_BUTTON_TEXTS = new Set([
  "🤝 دعوت دوستان (هدیه ۵ روزه)", "🎟 مدیریت کدهای تخفیف", "📊 گزارش فروش", "🎁 دریافت اکانت رایگان (تست)", "🛒 خرید سرویس", "📚 آموزش‌ها", "📦 سرویس‌های من", "👤 وضعیت من", "📞 ارتباط با پشتیبانی", "⚙️ ورود به پنل مدیریت حرفه‌ای",
  "👥 لیست کامل کاربران و خریدها", "🛠 مدیریت سرویس‌های کاربر", "📖 راهنمای پنل مدیریت", "🏠 بازگشت به منوی اصلی",
  "📢 ارسال اطلاعیه", "⚙️ تنظیمات ربات", "🗑 مدیریت و پاک‌سازی داده‌ها", "🎁 مدیریت اکانت تست و جشنواره", "🔙 بازگشت به پنل مدیریت", "🧩 مدیریت پلن‌های اشتراک",
  "⏳ صفر کردن زمان", "➕ تمدید / شارژ", "👥 تبدیل به چندکاربره", "👤 تبدیل به تک‌کاربره", "✅ وصل فوری", "🛑 قطع فوری", "✏️ ویرایش ورکر",
  "🔙 مرحله قبل", "🔙 بازگشت به پنل کاربری", "❌ لغو عملیات",
  "🚀 آموزش برنامه v2ray برای نصب کانفیگ", "📥 آموزش برنامه v2box برای نصب کانفیگ", "💬 راهنمای ارسال پیام به پشتیبانی"
]);

// دکمه‌ها را بر اساس طول متن، خودکار در ردیف می‌چیند:
// متن کوتاه -> کنار هم (تا سقف maxPerRow) | متن بلند -> تنها و تمام‌عرض
function autoRowKeyboard(buttons, maxRowChars = 52, maxPerRow = 3) {
  const rows = [];
  let currentRow = [];
  let currentLen = 0;

  for (const btn of buttons) {
    const len = btn.text.length;
    const wouldExceed = currentLen + len > maxRowChars || currentRow.length >= maxPerRow;
    const tooLongAlone = len > maxRowChars * 0.9;

    if (currentRow.length > 0 && (wouldExceed || tooLongAlone)) {
      rows.push(currentRow);
      currentRow = [];
      currentLen = 0;
    }

    currentRow.push(btn);
    currentLen += len;

    if (tooLongAlone) {
      rows.push(currentRow);
      currentRow = [];
      currentLen = 0;
    }
  }
  if (currentRow.length) rows.push(currentRow);
  return { inline_keyboard: rows };
}

// کیبورد خرید سرویس - کاملاً داینامیک، از جدول plans خوانده می‌شود
async function daysKeyboard(db) {
  const plans = await getActivePlans(db);
  if (!plans.length) return { inline_keyboard: [] };

  const buttons = plans.map(p => ({
    text: `${p.label} (از ${Math.round((p.price_single || p.price_multi || 0) / 1000).toLocaleString('fa-IR')} ه.ت)`,
    callback_data: `plan_${p.id}`
  }));
  return autoRowKeyboard(buttons);
}

// ================= هندلر اصلی کلودفلر ورکر =================
export default {
  async fetch(request, env, ctx) {
    try {
      loadConfig(env);
    } catch (e) {
      console.log("Config error:", e.message);
      return new Response('Server misconfigured', { status: 500 });
    }

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

    // 🔒 حیاتی‌ترین لایه امنیتی: تأیید اینکه این درخواست واقعاً از تلگرام آمده، نه یک آدرس جعلی.
    // بدون این بررسی، هر کسی که آدرس ورکر را حدس بزند می‌تواند با ساختن یک بدنه JSON دلخواه
    // و گذاشتن from.id برابر ADMIN_ID، خودش را جای ادمین جا بزند (پاک‌کردن دیتابیس، صدور سرویس و ...).
    const secretHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (secretHeader !== WEBHOOK_SECRET) {
      return new Response('Unauthorized', { status: 401 });
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

        // بررسی اینکه آیا این کاربر کاملاً جدید است (برای سیستم رفرال)
        const checkIsNew = await db.prepare("SELECT user_id FROM users WHERE user_id = ?").bind(user_id).first();
        const isBrandNewUser = !checkIsNew;

        // بروزرسانی اطلاعات کاربر در دیتابیس
        await db.prepare("INSERT INTO users (user_id, username, first_name, join_date_shamsi) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name")
            .bind(user_id, username, first_name, getShamsiNow()).run();

        // دستور شروع و بررسی لینک دعوت
        if (text.startsWith('/start')) {
          await clearState(db, user_id);

          // پردازش لینک رفرال
          const parts = text.split(' ');
          if (parts.length > 1 && isBrandNewUser) {
            const referrerId = parseInt(parts[1]);
            if (referrerId && referrerId !== user_id) {
              try {
                // ثبت در دیتابیس رفرال
                await db.prepare("INSERT INTO referrals (referrer_id, referred_id) VALUES (?, ?)").bind(referrerId, user_id).run();
                
                // پیدا کردن آخرین سرویس فعال شخص دعوت‌کننده
                const refActiveSrv = await db.prepare("SELECT * FROM services WHERE user_id = ? AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1").bind(referrerId).first();
                
                if (refActiveSrv) {
                  // اضافه کردن 5 روز به سرویس دعوت کننده
                  const cfRes = await updateCloudflareExp(refActiveSrv.cf_domain, 5, 0, refActiveSrv.plan_type.includes('یک کاربره'), referrerId, db);
                  if (cfRes.success) {
                    await db.prepare("UPDATE services SET exp_date = ? WHERE id = ?").bind(cfRes.newExpDate, refActiveSrv.id).run();
                    await db.prepare("UPDATE referrals SET gift_applied = 1, gift_days = 5 WHERE referrer_id = ? AND referred_id = ?").bind(referrerId, user_id).run();
                    const newInviteeName = escapeHtml(first_name);
                    await sendMessage(referrerId, `🎉 <b>مژده!</b>\n\nکاربر ${newInviteeName} با لینک دعوت شما وارد ربات شد.\n🎁 <b>۵ روز هدیه</b> به اعتبار سرویس شما (شناسه #${refActiveSrv.id}) اضافه شد!\n\nبرای دیدن لیست کامل افرادی که دعوت کرده‌اید، وارد بخش «🤝 دعوت دوستان» شوید.`);
                  }
                } else {
                  await sendMessage(referrerId, `🎉 <b>مژده!</b>\n\nیک کاربر جدید با لینک دعوت شما عضو شد.\n⚠️ <i>توجه: از آنجایی که شما در حال حاضر سرویس فعالی ندارید، امکان اضافه کردن هدیه ۵ روزه به سرویس شما وجود نداشت. (هدیه فقط روی سرویس‌های فعال اعمال می‌شود).</i>`);
                }
              } catch (err) { console.log("Referral Error: ", err); }
            }
          }

          // ادمین اصلاً پنل خرید را نمی‌بیند و مستقیماً وارد پنل حرفه‌ای مدیریت می‌شود
          if (user_id === ADMIN_ID) {
            await sendMessage(chat_id, "👨‍💻 <b>به پنل مدیریت حرفه‌ای خوش آمدید.</b>\nاز گزینه‌های زیر استفاده کنید:", adminPanelMenu());
            return new Response('OK');
          }

          const welcome = `👋 <b>به ربات هوشمند ما خوش آمدید!</b>\n\n💡 <b>هدیه ویژه ما:</b> کاربران جدید برای بار اول یک اکانت <b>تست ۲ روزه (تک‌کاربره)</b> رایگان دریافت می‌کنند. همچنین تمامی کاربران می‌توانند <b>هر ماه یکبار، یک اکانت رایگان ۱ روزه</b> دریافت کنند!\n\nپایداری، سرعت و امنیت را با ما تجربه کنید. لطفاً از منوی زیر یک گزینه را انتخاب کنید 👇`;
          await sendMessage(chat_id, welcome, await mainMenu(db, user_id));
          return new Response('OK');
        }

        // 🔒 قفل حیاتی: تا وقتی ادمین منتظر تایپ «آدرس ورکر» برای یک کاربر در انتظار است (WAIT_DOMAIN)،
        // فشردن هر یک از دکمه‌های ثابت پایین صفحه نباید این وضعیت را بی‌سروصدا از بین ببرد،
        // چون در آن صورت دیگر هیچ راهی برای ارسال لینک به آن کاربر باقی نمی‌ماند.
        if (user_id === ADMIN_ID && state && state.step === 'WAIT_DOMAIN' && (msg.photo || FIXED_MENU_BUTTON_TEXTS.has(text))) {
          let cancelledUserInfo = "";
          if (state.target_user) {
            const cUrow = await db.prepare("SELECT first_name, username FROM users WHERE user_id = ?").bind(state.target_user).first();
            const cUserLink = getUserLink(state.target_user, cUrow ? cUrow.first_name : "کاربر", cUrow ? cUrow.username : "");
            cancelledUserInfo = `\n\n👤 <b>کاربری که درخواستش لغو شد:</b> ${cUserLink}\n🆔 <b>آیدی:</b> <code>${state.target_user}</code>`;
            await clearState(db, state.target_user);
            await sendMessage(state.target_user, "❌ فرآیند صدور سرویس توسط پشتیبانی لغو شد. می‌توانید مجدداً درخواست دهید.", await mainMenu(db, state.target_user));
          }
          await clearState(db, ADMIN_ID);
          const retryKb = state.target_user ? { inline_keyboard: [[{ text: "🔄 تلاش مجدد برای همین کاربر (ثبت ورکر جدید)", callback_data: `admretrydomain_${state.target_user}_${state.days}_${state.hours}_${state.action}_${state.user_type}` }]] } : null;
          await sendMessage(chat_id, `⚠️ چون از مرحله «ثبت آدرس ورکر» خارج شدید، آن عملیات به‌صورت خودکار لغو شد و کاربر مربوطه از حالت انتظار خارج و مطلع گردید.${cancelledUserInfo}\n\nبرای تکمیل درخواست او لازم است دوباره از «🛠 مدیریت سرویس‌های کاربر» او را جستجو و اقدام کنید، یا از دکمه زیر استفاده نمایید.`, adminPanelMenu());
          if (retryKb) await sendMessage(chat_id, "برای شروع مجدد سریع همین درخواست:", retryKb);
          return new Response('OK');
        }

        // قفل جلوگیری از درخواست مجدد تا پاسخ ادمین و لغو توسط کاربر
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
             await sendMessage(chat_id, "✅ عملیات با موفقیت لغو شد و به منوی اصلی بازگشتید.", await mainMenu(db, user_id));
          } else if (!msg.photo) {
             await sendMessage(chat_id, "⏳ <b>شما یک درخواست در حال بررسی دارید!</b>\nمی‌توانید عکس فیش جدید را جهت ویرایش بفرستید یا دکمه «❌ لغو عملیات» را بزنید.", pendingMenu());
          }
          if (text === "❌ لغو عملیات") return new Response('OK');
        }

        // 🟢 هندل سراسری دکمه‌های لغو برای تمام بخش‌ها (به جز PENDING کاربر که بالاتر هندل شد)
        if (text === "🔙 مرحله قبل" || text === "🏠 بازگشت به منوی اصلی" || text === "🔙 بازگشت به پنل کاربری" || text === "🔙 بازگشت به پنل مدیریت" || text === "❌ لغو عملیات") {
          await clearState(db, user_id);
          
          let menu;
          let replyMsg = "🏠 عملیات فعلی لغو شد.";
          
          if (user_id === ADMIN_ID) {
            // ادمین پنل خرید/منوی اصلی ندارد؛ همیشه به پنل حرفه‌ای مدیریت برمی‌گردد
            menu = adminPanelMenu();
            replyMsg = "👨‍💻 به پنل مدیریت برگشتید.";
          } else if (text === "🏠 بازگشت به منوی اصلی") {
            menu = await mainMenu(db, user_id);
            replyMsg = "🏠 به منوی اصلی برگشتید.";
          } else {
            menu = await mainMenu(db, user_id);
          }
          
          await sendMessage(chat_id, replyMsg, menu);
          return new Response('OK');
        }

        // اگر ادمین در حال پاسخ به تیکت کاربر است
        if (user_id === ADMIN_ID && state && state.step === 'WAIT_ADMIN_REPLY_TEXT') {
          const targetUid = state.target_user;
          await sendMessage(targetUid, `📩 <b>پاسخ جدید از طرف پشتیبانی:</b>\n\n${text}`);
          await sendMessage(ADMIN_ID, `✅ پاسخ شما با موفقیت برای کاربر <code>${targetUid}</code> ارسال شد.`, adminPanelMenu());
          await clearState(db, ADMIN_ID);
          return new Response('OK');
        }

        // دکمه مدیریت کاربر
        if (text === "🛠 مدیریت سرویس‌های کاربر" && user_id === ADMIN_ID) {
          await setState(db, ADMIN_ID, { step: 'WAIT_ADMIN_SEARCH_USER' });
          await sendMessage(chat_id, "🔍 لطفاً <b>آیدی عددی</b>، <b>یوزرنیم</b> یا <b>آدرس ورکر</b> کاربر را جهت جستجو ارسال کنید:", pendingMenu());
          return new Response('OK');
        }

        // اعمال کنترل‌های پنل مدیریت روی دکمه‌های ثابت
        if (user_id === ADMIN_ID && state && state.step === 'MANAGE_FIXED_ACTIONS') {
            const srvId = state.service_id;
            const srv = await db.prepare("SELECT * FROM services WHERE id = ?").bind(srvId).first();
            if (!srv) return new Response('OK');
            
            let apiDomain = srv.cf_domain.trim();
            if (!apiDomain.startsWith('http')) apiDomain = 'https://' + apiDomain;
            apiDomain = apiDomain.replace(/\/$/, "");
            if (apiDomain.includes("?url=")) apiDomain = decodeURIComponent(apiDomain.split("?url=")[1]).replace(/\/$/, "");
            const url = `${apiDomain}/${CF_ADMIN_PATH}?token=${CF_ADMIN_TOKEN}`;
            
            let updated = false;

            if (text === "🛑 قطع فوری" || text === "✅ وصل فوری") {
                await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: "toggleKillSwitch" }) });
                updated = true;
            } 
            else if (text === "👥 تبدیل به چندکاربره" || text === "👤 تبدیل به تک‌کاربره") {
                await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: "toggleUser" }) });
                const isSingle = srv.plan_type.includes('یک کاربره');
                const newPlanType = isSingle ? srv.plan_type.replace('یک کاربره', 'چند کاربره') : srv.plan_type.replace('چند کاربره', 'یک کاربره');
                await db.prepare("UPDATE services SET plan_type = ? WHERE id = ?").bind(newPlanType, srvId).run();
                updated = true;
            }
            else if (text === "⏳ صفر کردن زمان") {
                const now = new Date();
                now.setMinutes(now.getMinutes() - 5);
                const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(now); 
                const timeStr = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' }).format(now).substring(0, 5);
                await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: "updateExp", date: dateStr, time: timeStr }) });
                await db.prepare("UPDATE services SET exp_date = ?, status = 'INACTIVE' WHERE id = ?").bind(now.toISOString(), srvId).run();
                updated = true;
            }
            else if (text === "➕ تمدید / شارژ") {
                await setState(db, ADMIN_ID, { step: 'WAIT_ADMIN_ADD_DAYS', service_id: srvId });
                await sendMessage(ADMIN_ID, `⏳ لطفاً تعداد روزهایی که می‌خواهید به این سرویس افزوده شود را تایپ کنید:`, pendingMenu());
                return new Response('OK');
            }
            else if (text === "✏️ ویرایش ورکر") {
                await setState(db, ADMIN_ID, { step: 'WAIT_EDIT_WORKER_DOMAIN', service_id: srvId });
                const editKb = { inline_keyboard: [[{ text: "❌ انصراف از این عملیات", callback_data: "cancel_admin" }]] };
                await sendMessage(ADMIN_ID, `✏️ <b>ویرایش آدرس ورکر سرویس #${srvId}</b>\n\n🌐 آدرس فعلی:\n<code>${srv.cf_domain}</code>\n\nلطفاً <b>آدرس دامنه جدید ورکر</b> را تایپ و ارسال کنید:`, editKb);
                return new Response('OK');
            }

            // ارسال پیام وضعیت فعلی با جزئیات کامل و کیبورد جدید
            if (updated) {
                const updatedSrv = await db.prepare("SELECT * FROM services WHERE id = ?").bind(srvId).first();
                const workerData = await getWorkerStatus(updatedSrv.cf_domain);
                const isKsActive = workerData.killSwitch === true;
                const isSingleType = updatedSrv.plan_type.includes('یک کاربره');
                
                let remaining = "منقضی شده";
                let expView = "نامشخص";
                if (updatedSrv.exp_date) {
                    const d = new Date(updatedSrv.exp_date);
                    const now = new Date();
                    if (!isNaN(d)) {
                        expView = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
                        const diffMs = d - now;
                        if (diffMs > 0) {
                            const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                            const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                            const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                            remaining = `${days} روز و ${hours} ساعت و ${mins} دقیقه`;
                        }
                    }
                }

                let statusMsg = `📝 <b>وضعیت فعلی سرویس (${updatedSrv.cf_domain})</b>\n\n`;
                statusMsg += `⏳ <b>باقی‌مانده:</b> ${remaining}\n`;
                statusMsg += `📅 <b>تاریخ و ساعت انقضا:</b> ${expView}\n`;
                statusMsg += `👥 <b>حالت:</b> ${isSingleType ? 'تک‌کاربره' : 'چندکاربره'}\n`;
                statusMsg += `🔌 <b>قطع فوری (Kill Switch):</b> ${isKsActive ? '🛑 مسدود' : '✅ آزاد'}\n`;
                
                await sendMessage(ADMIN_ID, statusMsg, adminServiceKeyboard(isSingleType, isKsActive));
                return new Response('OK');
            }
        }

        // جستجوی پیشرفته کاربر در پنل ادمین
        if (user_id === ADMIN_ID && state && state.step === 'WAIT_ADMIN_SEARCH_USER') {
          let searchTerm = text.trim();
          
          searchTerm = searchTerm.replace(/^https?:\/\//i, '').replace(/\/$/, '');
          if (searchTerm.length > 40) {
             searchTerm = searchTerm.substring(0, 40);
          }

          // 🚫 جستجو برای خود ادمین مجاز نیست
          const cleanSearchTerm = searchTerm.replace(/^@/, '');
          const adminRowCheck = await db.prepare("SELECT username FROM users WHERE user_id = ?").bind(ADMIN_ID).first();
          const adminUsername = adminRowCheck && adminRowCheck.username ? adminRowCheck.username : "";
          if (cleanSearchTerm === String(ADMIN_ID) || (adminUsername && cleanSearchTerm.toLowerCase() === adminUsername.toLowerCase())) {
            await sendMessage(ADMIN_ID, "⛔ برای ادمین این امکان وجود ندارد.");
            return new Response('OK');
          }
          
          const { results: foundUsers } = await db.prepare(`
            SELECT DISTINCT u.user_id, u.first_name, u.username
            FROM users u
            LEFT JOIN services s ON u.user_id = s.user_id
            WHERE (CAST(u.user_id AS TEXT) LIKE ? 
               OR u.username LIKE ? 
               OR s.cf_domain LIKE ?)
               AND u.user_id != ?
            LIMIT 10
          `).bind(`%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`, ADMIN_ID).all();

          if (!foundUsers || foundUsers.length === 0) {
            await sendMessage(ADMIN_ID, "❌ هیچ کاربری با این مشخصات یافت نشد. لطفاً عبارت دیگری جستجو کنید.");
            return new Response('OK');
          }

          // تولید دکمه‌های شیشه‌ای برای کلیک کردن ادمین اگر چند کاربر پیدا شد
          if (foundUsers.length > 1) {
            let msgList = "🔍 <b>چندین کاربر یافت شد. لطفاً روی کاربر مورد نظر کلیک کنید:</b>\n\n";
            let inline_keyboard = [];
            foundUsers.forEach(u => {
              let btnText = `👤 ${u.first_name || 'کاربر'} ` + (u.username ? `(@${u.username})` : `(${u.user_id})`);
              inline_keyboard.push([{ text: btnText, callback_data: `admuser_${u.user_id}` }]);
            });
            await sendMessage(ADMIN_ID, msgList, { inline_keyboard });
            return new Response('OK');
          }

          const targetUid = foundUsers[0].user_id;
          const { results: srvList } = await db.prepare("SELECT * FROM services WHERE user_id = ? ORDER BY id DESC").bind(targetUid).all();

          if (!srvList || srvList.length === 0) {
            const newSrvKb = { inline_keyboard: [[{ text: "➕ ثبت سرویس جدید برای این کاربر", callback_data: `admnewsrv_${targetUid}` }]] };
            await sendMessage(ADMIN_ID, `❌ کاربر یافت شد اما هیچ سرویسی برای آیدی <code>${targetUid}</code> ثبت نشده است.\n\nمی‌توانید یک سرویس جدید مستقیماً برای او ثبت کنید:`, newSrvKb);
            await clearState(db, ADMIN_ID);
            return new Response('OK');
          }

          const targetSrv = srvList[0];
          await setState(db, ADMIN_ID, { step: 'MANAGE_FIXED_ACTIONS', service_id: targetSrv.id });

          const uRow = foundUsers[0];
          const userLink = getUserLink(targetUid, uRow.first_name, uRow.username);
          const refCountRow = await db.prepare("SELECT COUNT(*) as cnt FROM referrals WHERE referrer_id = ?").bind(targetUid).first();
          const referralCount = refCountRow ? refCountRow.cnt : 0;
          
          const workerData = await getWorkerStatus(targetSrv.cf_domain);
          const isKsActive = workerData.killSwitch === true;
          const isSingle = targetSrv.plan_type.includes('یک کاربره');

          let apiDomainMain = targetSrv.cf_domain.trim();
          if (!apiDomainMain.startsWith('http')) apiDomainMain = 'https://' + apiDomainMain;
          apiDomainMain = apiDomainMain.replace(/\/$/, "");

          let pureWorkerUrl = apiDomainMain;
          if (pureWorkerUrl.includes("?url=")) {
              pureWorkerUrl = decodeURIComponent(pureWorkerUrl.split("?url=")[1]).replace(/\/$/, "");
          }

          let smartSubLink = targetSrv.sub_link;
          if (!smartSubLink) {
              smartSubLink = `${pureWorkerUrl}/sub`;
          } else if (smartSubLink.includes("?url=")) {
              smartSubLink = decodeURIComponent(smartSubLink.split("?url=")[1]).replace(/\/$/, "");
          }

          let mainMsg = `🛠 <b>مدیریت کاربر:</b> ${userLink}\n`;
          mainMsg += `🆔 آیدی: <code>${targetUid}</code>\n`;
          mainMsg += `تعداد سرویس‌ها: ${srvList.length}\n`;

          mainMsg += `🤝 تعداد دعوت‌شدگان: ${referralCount} نفر\n\n`;
          
          mainMsg += `🌐 <b>آدرس ورکر:</b>\n<code>${pureWorkerUrl}/</code>\n\n`;
          mainMsg += `📊 <b>لینک پنل معمولی:</b>\n<code>${pureWorkerUrl}/login</code>\n\n`;
          mainMsg += `🕵️‍♂️ <b>لینک پنل مخفی:</b>\n<code>${pureWorkerUrl}/${CF_ADMIN_PATH}?token=${CF_ADMIN_TOKEN}</code>\n\n`;
          mainMsg += `🔗 <b>لینک اشتراک هوشمند:</b>\n<code>${smartSubLink}</code>\n\n`;
          
          mainMsg += `👇 در حال مدیریت سرویس اصلی (آخرین ورکر). دکمه‌های کنترل را در پایین صفحه مشاهده می‌کنید.`;

          await callTelegram('sendPhoto', { chat_id: ADMIN_ID, photo: getQRUrl(smartSubLink), caption: mainMsg, parse_mode: 'HTML', reply_markup: adminServiceKeyboard(isSingle, isKsActive) });

          for (const s of srvList) {
            let expView = "نامشخص";
            if (s.exp_date) {
               const d = new Date(s.exp_date);
               if (!isNaN(d)) expView = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
            }

            let planPrice = await getPlanPriceByDays(db, s.plan_days, !s.plan_type.includes('چند کاربره'));
            let priceText = planPrice > 0 ? `${planPrice.toLocaleString('fa-IR')} تومان` : "تست / رایگان";

            let srvMsg = `📦 <b>شناسه سرویس:</b> #${s.id}\n`;
            srvMsg += `📅 <b>شروع:</b> ${s.purchase_date_shamsi || "نامشخص"}\n`;
            srvMsg += `⏳ <b>انقضا:</b> ${expView}\n`;
            srvMsg += `🛍 <b>اسم سرویس:</b> ${s.plan_days} روزه (${s.plan_type})\n`;
            srvMsg += `💳 <b>مبلغ خرید:</b> ${priceText}\n`;
            srvMsg += `🔘 <b>وضعیت:</b> ${s.status === 'ACTIVE' ? '✅ فعال' : '❌ غیرفعال'}`;
            
            let kb = { inline_keyboard: [ [ { text: "🗑 حذف سرویس", callback_data: `admdel_${s.id}` } ] ] };
            await sendMessage(ADMIN_ID, srvMsg, kb);
          }
          return new Response('OK');
        }

        // تمدید سرویس توسط ادمین (و آپدیت دکمه درجا)
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
            await sendMessage(srv.user_id, `🎉 <b>سرویس شما تمدید شد!</b>\n\n➕ مقدار <b>${daysToAdd} روز</b> به اعتبار سرویس شما افزوده شد.\n🔗 <b>لینک اتصال:</b>\n<code>${srv.sub_link}</code>`);

            // بازگشت به همان پنل مدیریت سرویس (با کیبورد به‌روز، نه پیام بدون دکمه)
            const workerDataAfterRenew = await getWorkerStatus(srv.cf_domain);
            const isKsActiveAfterRenew = workerDataAfterRenew.killSwitch === true;
            const isSingleTypeAfterRenew = srv.plan_type.includes('یک کاربره');
            await sendMessage(ADMIN_ID, `✅ سرویس شناسه #${srv.id} با موفقیت ${daysToAdd} روز شارژ شد.`, adminServiceKeyboard(isSingleTypeAfterRenew, isKsActiveAfterRenew));
            await setState(db, ADMIN_ID, { step: 'MANAGE_FIXED_ACTIONS', service_id: srv.id });
          } else {
            await sendMessage(ADMIN_ID, `❌ خطا در آپدیت ورکر: ${cfRes.error}`, adminPanelMenu());
            await clearState(db, ADMIN_ID);
          }
          return new Response('OK');
        }

        // ================= دریافت تعداد روز برای ثبت دستی سرویس جدید (بدون درخواست کاربر) =================
        if (user_id === ADMIN_ID && state && state.step === 'WAIT_MANUAL_DAYS') {
          const manualDays = parseInt(text.trim());
          if (isNaN(manualDays) || manualDays <= 0) {
            await sendMessage(ADMIN_ID, "❌ لطفاً یک عدد معتبر بر حسب روز وارد کنید (مثلاً: 30):");
            return new Response('OK');
          }
          const typeKb = { inline_keyboard: [
            [{ text: "👤 تک‌کاربره", callback_data: `admmanualtype_${manualDays}_${state.target_user}_1` }],
            [{ text: "👥 چندکاربره", callback_data: `admmanualtype_${manualDays}_${state.target_user}_0` }]
          ] };
          await sendMessage(ADMIN_ID, `📦 پلن <b>${manualDays} روزه</b> برای کاربر <code>${state.target_user}</code>. حالا نوع مصرف را انتخاب کنید:`, typeKb);
          return new Response('OK');
        }

        // ویرایش عکس فیش واریزی توسط کاربر تا قبل از تایید ادمین
        if (msg.photo && state && state.step === 'PENDING_ADMIN' && user_id !== ADMIN_ID) {
          const photoId = msg.photo[msg.photo.length - 1].file_id;
          const userLink = getUserLink(user_id, first_name, username);
          const lastSrv = await db.prepare("SELECT cf_domain FROM services WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(user_id).first();
          const workerText = lastSrv ? `🌐 <b>ورکر فعلی کاربر:</b> <code>${lastSrv.cf_domain}</code>\n` : `🌐 <b>ورکر فعلی کاربر:</b> ندارد (نیاز به ثبت ورکر جدید)\n`;
          
          let caption = `🧾 <b>درخواست پرداخت جدید (ویرایش شده توسط کاربر)</b>\n👤 کاربر: ${userLink}\n🆔 آیدی: <code>${user_id}</code>\n📅 <b>زمان ویرایش:</b> ${getShamsiNow()}\n📦 پلن: ${planDaysLabel(state.days)} - ${state.type || 'سفارشی'}\n${workerText}`;
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

        if (text === "📊 گزارش فروش" && user_id === ADMIN_ID) {
          const shamsiNow = getShamsiNow();
          // جداسازی تاریخ از ساعت (مثلا 1403/05/12)
          const todayStr = shamsiNow.split(/[ ,-]/)[0];
          const monthStr = todayStr.substring(0, 7);
          const yearStr = todayStr.substring(0, 4);

          const { results: allServices } = await db.prepare("SELECT plan_days, plan_type, purchase_date_shamsi FROM services").all();
          const priceMap = await buildDaysPriceMap(db);

          let dailyCount = 0, dailyIncome = 0;
          let monthlyCount = 0, monthlyIncome = 0;
          let yearlyCount = 0, yearlyIncome = 0;
          let totalCount = 0, totalIncome = 0;

          allServices.forEach(s => {
            if (!s.purchase_date_shamsi) return;
            const pDate = s.purchase_date_shamsi;
            
            // محاسبه قیمت بر اساس روز و حالت چندکاربره (از جدول پلن‌های داینامیک)
            const priceEntry = priceMap.get(s.plan_days) || { single: 0, multi: 0 };
            let price = s.plan_type.includes('چند کاربره') ? priceEntry.multi : priceEntry.single;
            if (s.plan_type.includes('رایگان') || s.plan_type.includes('تست')) price = 0;

            totalCount++;
            totalIncome += price;

            if (pDate.startsWith(todayStr)) { dailyCount++; dailyIncome += price; }
            if (pDate.startsWith(monthStr)) { monthlyCount++; monthlyIncome += price; }
            if (pDate.startsWith(yearStr)) { yearlyCount++; yearlyIncome += price; }
          });

          let reportMsg = `📊 <b>گزارش جامع فروش</b>\n\n`;
          reportMsg += `📅 <b>امروز (${todayStr}):</b>\nتعداد: ${dailyCount} سرویس | درآمد: ${dailyIncome.toLocaleString('fa-IR')} تومان\n\n`;
          reportMsg += `🗓 <b>این ماه (${monthStr}):</b>\nتعداد: ${monthlyCount} سرویس | درآمد: ${monthlyIncome.toLocaleString('fa-IR')} تومان\n\n`;
          reportMsg += `📆 <b>امسال (${yearStr}):</b>\nتعداد: ${yearlyCount} سرویس | درآمد: ${yearlyIncome.toLocaleString('fa-IR')} تومان\n\n`;
          reportMsg += `📈 <b>فروش کل تاریخ:</b>\nتعداد: ${totalCount} سرویس | درآمد: ${totalIncome.toLocaleString('fa-IR')} تومان\n`;

          const kb = { inline_keyboard: [[{ text: "🔍 گزارش یک تاریخ خاص", callback_data: "admreport_custom" }]] };
          await sendMessage(ADMIN_ID, reportMsg, kb);
          return new Response('OK');
        }

        if (text === "📖 راهنمای پنل مدیریت" && user_id === ADMIN_ID) {
          const guideText = `📖 <b>راهنمای جامع پنل مدیریت:</b>\n\n` +
          `1️⃣ <b>تایید خریدهای جدید:</b> هنگامی که کاربر رسید ارسال کند، دکمه تایید پرداختی ظاهر می‌شود. اگر کاربر قبلاً ورکر داشته باشد به صورت خودکار تمدید می‌شود، در غیر این صورت از شما آدرس ورکر جدید درخواست می‌گردد.\n\n` +
          `2️⃣ <b>مدیریت سرویس‌های کاربر:</b> روی دکمه «🛠 مدیریت سرویس‌های کاربر» بزنید. حالا می‌توانید بر اساس <b>آیدی، نام، یوزرنیم یا آدرس ورکر</b> جستجو کنید. گزینه‌های جدید مانند <b>قطع فوری، صفر کردن زمان و تغییر کاربری</b> در همانجا قابل استفاده هستند.\n\n` +
          `3️⃣ <b>پاسخ به پیام‌های شخصی:</b> هنگامی که کاربر پیامی بفرستد، دکمه «💬 پاسخ به این پیام» زیر آن قرار می‌گیرد تا مستقیماً به کاربر پاسخ دهید.\n\n` +
          `4️⃣ <b>ارسال اطلاعیه:</b> از دکمه «📢 ارسال اطلاعیه» استفاده کنید و انتخاب کنید که برای <b>همه کاربران</b> یا فقط <b>کاربران خاص</b> (با آیدی/یوزرنیم) ارسال شود. هر نوع پیام (متن، عکس، لینک و ...) که ارسال کنید، پس از تایید شما عیناً برای مقصد انتخاب‌شده فرستاده می‌شود.\n\n` +
          `5️⃣ <b>تنظیمات ربات:</b> از دکمه «⚙️ تنظیمات ربات» می‌توانید در صورت نیاز کل دیتابیس (کاربران و سرویس‌ها) را به‌طور کامل و غیرقابل‌بازگشت پاک کنید.\n\n` +
          `6️⃣ <b>مدیریت پلن‌های اشتراک:</b> از مسیر «⚙️ تنظیمات ربات ← 🧩 مدیریت پلن‌های اشتراک» می‌توانید پلن جدید بسازید (نام دکمه، مدت اعتبار، قیمت تک‌کاربره و چندکاربره، تاریخ پایان پیشنهاد اختیاری)، پلن‌های موجود را ویرایش کنید، و به‌جای حذف کامل، آن‌ها را فقط غیرفعال/فعال کنید تا از لیست خرید کاربران خارج/وارد شوند.`;
          await sendMessage(chat_id, guideText, adminPanelMenu());
          return new Response('OK');
        }
        
        if (text === "📦 سرویس‌های من") {
            const { results: userServices } = await db.prepare("SELECT id, plan_days, plan_type, cf_domain, sub_link, exp_date, status, purchase_date_shamsi FROM services WHERE user_id = ? ORDER BY id DESC").bind(user_id).all();

            if (!userServices || userServices.length === 0) {
              await sendMessage(chat_id, "❌ شما هنوز هیچ سرویس یا تستی دریافت نکرده‌اید.");
              return new Response('OK');
            }

            let msgText = "📦 <b>لیست تمامی سرویس‌های شما:</b>\n\n";
            const priceMapMy = await buildDaysPriceMap(db);

            userServices.forEach((s, idx) => {
              msgText += `🔹 <b>سرویس ${idx + 1}:</b>\n`;
              msgText += `🛍 <b>پکیج:</b> ${planDaysLabel(s.plan_days)} (${s.plan_type})\n`;
              msgText += `📅 <b>تاریخ ثبت:</b> ${s.purchase_date_shamsi}\n`;

              const priceEntryMy = priceMapMy.get(s.plan_days) || { single: 0, multi: 0 };
              let planPrice = s.plan_type.includes('چند کاربره') ? priceEntryMy.multi : priceEntryMy.single;
              let priceText = planPrice > 0 ? `${planPrice.toLocaleString('fa-IR')} تومان` : "تست / رایگان";
              msgText += `💳 <b>مبلغ خرید:</b> ${priceText}\n`;

              let expView = "نامشخص";
              if (s.exp_date) {
                 const d = new Date(s.exp_date);
                 if (!isNaN(d)) expView = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
              }
              msgText += `⏳ <b>تاریخ انقضا:</b> ${expView}\n`;
              msgText += `وضعیت: ${s.status === 'ACTIVE' ? '✅ فعال' : '❌ غیرفعال'}\n➖➖➖➖➖➖\n`;
            });

            await sendMessage(chat_id, msgText);

            // ارسال خودکار بارکد (QR) و لینک اتصال برای هر سرویس دارای لینک فعال
            for (const s of userServices) {
              if (s.sub_link) {
                const caption = `📱 <b>بارکد (QR Code) و لینک اتصال سرویس</b>\n\n🔗 <b>لینک سابسکریپشن شما:</b>\n<code>${s.sub_link}</code>\n\n💡 جهت اتصال سریع، روی دکمه‌های زیر کلیک کنید یا بارکد را اسکن نمایید.`;
                await callTelegram('sendPhoto', { chat_id, photo: getQRUrl(s.sub_link), caption: caption, parse_mode: 'HTML', reply_markup: getImportKeyboard(s.sub_link, botOrigin) });
              }
            }
            return new Response('OK');
        }

        if (text === "👤 وضعیت من") {
          const uRow = await db.prepare("SELECT * FROM users WHERE user_id = ?").bind(user_id).first();
          const { results: srvList } = await db.prepare("SELECT * FROM services WHERE user_id = ? ORDER BY id DESC").bind(user_id).all();
          
          let msg = `👤 <b>وضعیت من</b>\n\n`;
          msg += `📝 <b>نام ثبت شده:</b> ${escapeHtml(uRow && uRow.first_name ? uRow.first_name : first_name)}\n`;
          msg += `🆔 <b>آیدی عددی:</b> <code>${user_id}</code>\n`;
          msg += `🌐 <b>یوزرنیم:</b> ${uRow && uRow.username ? '@' + uRow.username : (username ? '@' + username : 'ندارد')}\n\n`;
          
          if (!srvList || srvList.length === 0) {
              msg += `❌ شما در حال حاضر هیچ سرویسی ندارید.`;
              await sendMessage(chat_id, msg);
              return new Response('OK');
          }
          
          msg += `📦 <b>اطلاعات سرویس‌های شما:</b>\n`;
          for (const s of srvList) {
              const workerData = await getWorkerStatus(s.cf_domain);
              const isBlocked = workerData.killSwitch === true;
              const isSingle = s.plan_type.includes('یک کاربره');
              
              let expView = "نامشخص";
              let remaining = "پایان یافته / نامشخص";
              if (s.exp_date) {
                  const d = new Date(s.exp_date);
                  const now = new Date();
                  if (!isNaN(d)) {
                      expView = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
                      const diffMs = d - now;
                      if (diffMs > 0) {
                          const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                          const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                          remaining = `${days} روز و ${hours} ساعت`;
                      }
                  }
              }
              
              msg += `\n🔹 <b>نام ورکر:</b> <code>${s.cf_domain}</code>\n`;
              msg += `🛒 <b>نوع سرویس:</b> ${isSingle ? 'تک‌کاربره' : 'چندکاربره'}\n`;
              msg += `⏳ <b>زمان باقی‌مانده:</b> ${remaining}\n`;
              msg += `📅 <b>تاریخ انقضا:</b> ${expView}\n`;
              msg += `🛡 <b>وضعیت حساب:</b> ${isBlocked ? '🛑 مسدود توسط ادمین' : '✅ فعال و متصل'}\n`;
          }
          await sendMessage(chat_id, msg);
          return new Response('OK');
        }

        if (text === "👥 لیست کامل کاربران و خریدها" && user_id === ADMIN_ID) {
          const { results: users } = await db.prepare("SELECT user_id, first_name, username, join_date_shamsi FROM users WHERE user_id != ? ORDER BY user_id DESC LIMIT 20").bind(ADMIN_ID).all();
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
                service_text += `   🛍 <b>${planDaysLabel(s.plan_days)} (${s.plan_type})</b>\n   🌐 <b>ورکر:</b> <code>${s.cf_domain}</code>\n   📅 <b>تاریخ:</b> ${s.purchase_date_shamsi}\n   ---\n`;
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
        if (text === "🚀 آموزش برنامه v2ray برای نصب کانفیگ") {
          const v2rayFileId = "BAACAgQAAxkBAAIJqWp0UTm4vjXy1eE1YlHgo1nf929iAAIHHwACVm-hU1oVDnIo-uFzPQQ";
          const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendVideo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chat_id, video: v2rayFileId, caption: "🎥 آموزش نصب و راه‌اندازی کانفیگ در برنامه V2ray" })
          });
          if (!res.ok) await sendMessage(chat_id, "❌ ویدیوی آموزشی یافت نشد یا مشکلی در ارسال وجود دارد. لطفاً به پشتیبانی اطلاع دهید.");
          return new Response('OK');
        }
        if (text === "📥 آموزش برنامه v2box برای نصب کانفیگ") {
          const v2boxFileId = "BAACAgQAAxkBAAIJo2p0UFDzSabd4rGGZr1lk6AQRg4SAAIGHwACVm-hU3EXI5PaaswwPQQ";
          const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendVideo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chat_id, video: v2boxFileId, caption: "🎥 آموزش نصب و راه‌اندازی کانفیگ در برنامه V2box" })
          });
          if (!res.ok) await sendMessage(chat_id, "❌ ویدیوی آموزشی یافت نشد یا مشکلی در ارسال وجود دارد. لطفاً به پشتیبانی اطلاع دهید.");
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
		
		
		// ================= دریافت لینک معرفی دوستان =================
        if (text === "🤝 دعوت دوستان (هدیه ۵ روزه)" && user_id !== ADMIN_ID) {
          // این قابلیت فقط برای کاربرانی که حداقل یک ورکر ثبت‌شده دارند فعال است
          const hasWorkerForRef = await db.prepare("SELECT 1 FROM services WHERE user_id = ? AND cf_domain IS NOT NULL AND cf_domain != '' LIMIT 1").bind(user_id).first();
          if (!hasWorkerForRef) {
            await sendMessage(chat_id, "⚠️ برای استفاده از سیستم دعوت دوستان، ابتدا باید حداقل یک سرویس با ورکر ثبت‌شده داشته باشید.", await mainMenu(db, user_id));
            return new Response('OK');
          }

          // دریافت اطلاعات ربات برای ساخت لینک دعوت
          const botInfo = await callTelegram('getMe');
          let botUsername = "YOUR_BOT_USERNAME"; // نام کاربری پیش‌فرض در صورت خطا
          if (botInfo && botInfo.ok) {
             botUsername = botInfo.result.username;
          }
          
          const refLink = `https://t.me/${botUsername}?start=${user_id}`;
          
          const msg = `🎁 <b>سیستم معرفی دوستان (کسب هدیه)</b>\n\nبا دعوت از دوستان خود به این ربات، به ازای هر نفری که عضو شود، <b>۵ روز سرویس رایگان</b> هدیه بگیرید!\n\n📌 <b>قوانین:</b>\n۱. شخصی که دعوت می‌کنید نباید قبلاً عضو ربات بوده باشد.\n۲. هدیه ۵ روزه به صورت خودکار به <b>آخرین سرویس فعال شما</b> اضافه می‌شود.\n۳. محدودیتی در تعداد دعوت‌ها وجود ندارد!\n\n🔗 <b>لینک اختصاصی دعوت شما:</b>\n<code>${refLink}</code>\n\nهمین الان این پیام را برای دوستانتان فوروارد کنید! 🚀`;
          
          await sendMessage(chat_id, msg);

          // ================= نمایش لیست افرادی که این کاربر دعوت کرده =================
          const { results: myInvitees } = await db.prepare(`
            SELECT r.referred_id, r.created_at, r.gift_applied, u.first_name, u.username
            FROM referrals r
            LEFT JOIN users u ON r.referred_id = u.user_id
            WHERE r.referrer_id = ?
            ORDER BY r.id DESC
          `).bind(user_id).all();

          if (!myInvitees || myInvitees.length === 0) {
            await sendMessage(chat_id, `👥 <b>لیست دعوت‌شدگان شما</b>\n\nشما تاکنون هیچ کاربری را با لینک خود دعوت نکرده‌اید.`);
          } else {
            const appliedCount = myInvitees.filter(i => i.gift_applied === 1).length;
            const totalGiftDays = appliedCount * 5;

            let inviteesMsg = `👥 <b>لیست دعوت‌شدگان شما</b>\n\n`;
            inviteesMsg += `📊 <b>تعداد کل دعوت‌ها:</b> ${myInvitees.length} نفر\n`;
            inviteesMsg += `🎁 <b>مجموع روزهای هدیه دریافتی:</b> ${totalGiftDays} روز\n\n`;

            const showList = myInvitees.slice(0, 30);
            showList.forEach((inv, idx) => {
              const displayName = escapeHtml(inv.first_name || 'کاربر');
              const usernamePart = inv.username ? ` (@${inv.username})` : '';
              const giftStatus = inv.gift_applied === 1 ? '🎁 هدیه اعمال شد' : '⏳ هدیه اعمال نشد';
              inviteesMsg += `${idx + 1}. ${displayName}${usernamePart} — ${giftStatus}\n`;
            });

            if (myInvitees.length > showList.length) {
              inviteesMsg += `\n... و ${myInvitees.length - showList.length} نفر دیگر`;
            }

            await sendMessage(chat_id, inviteesMsg);
          }
          return new Response('OK');
        }		
		

        if (text === "🛒 خرید سرویس" && user_id !== ADMIN_ID) {
          const buyKb = await daysKeyboard(db);
          if (!buyKb.inline_keyboard.length) {
            await sendMessage(chat_id, "⛔ در حال حاضر هیچ پلن فعالی برای خرید موجود نیست. لطفاً بعداً مراجعه کنید یا با پشتیبانی تماس بگیرید.");
            return new Response('OK');
          }
          const rules = "⚠️ <b>قوانین سرویس:</b>\nسرویس‌های ما کاملاً نامحدود هستند، اما شامل قانون مصرف منصفانه می‌شوند. در صورت مصرف غیرعادی، اکانت موقتاً قطع شده و از روز بعد متصل می‌گردد.\n\n⏳ لطفاً مدت زمان سرویس خود را انتخاب کنید:";
          await sendMessage(chat_id, rules, buyKb);
          await sendMessage(chat_id, "در صورت نیاز به انصراف، از دکمه‌های پایین استفاده کنید:", backAndSupportKeyboard());
          return new Response('OK');
        }

        if (user_id !== ADMIN_ID) {
          const trialCfgCheck = await getTrialConfig(db);
          if (trialCfgCheck.is_active && text === trialCfgCheck.button_text) {
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
              const cooldownDays = trialCfgCheck.cooldown_days || 30;

              if (diffDays < cooldownDays) {
                const remainingDays = Math.ceil(cooldownDays - diffDays);
                await sendMessage(user_id, `❌ <b>دریافت مجدد امکان‌پذیر نیست!</b>\n\nشما اخیراً اکانت رایگان خود را دریافت کرده‌اید. شما هر <b>${cooldownDays} روز یکبار</b> مجاز به دریافت هدیه هستید.\n⏳ لطفاً <b>${remainingDays} روز</b> دیگر برای دریافت تست بعدی مراجعه کنید.`);
                return new Response('OK');
              }
              isFirstTime = false;
            }

            const testDays = isFirstTime ? (trialCfgCheck.first_time_days || 3) : (trialCfgCheck.repeat_days || 2);
            const isTrialSingle = trialCfgCheck.is_single !== 0;
            const trialUserTypeLabel = isTrialSingle ? 'تک‌کاربره' : 'چندکاربره';
            let msgText = "";

            if (isFirstTime) {
                msgText = `🎁 <b>مژده:</b> چون بار اول شماست، یک اکانت تست <b>${testDays} روزه (${trialUserTypeLabel})</b> به شما تعلق می‌گیرد!\n(برای دفعات بعد، هدیه شما ${trialCfgCheck.repeat_days} روزه خواهد بود)`;
            } else {
                msgText = `🎁 اکانت هدیه شما (<b>${testDays} روزه و ${trialUserTypeLabel}</b>) در حال آماده‌سازی است...\n\n⚠️ <b>هشدار:</b> این اکانت تست مجدد است. لطفاً قوانین مصرف منصفانه را رعایت کنید، در غیر این صورت امکان دریافت تست در آینده مسدود خواهد شد.`;
            }

            await sendMessage(user_id, msgText);

            let newState = { days: testDays, hours: 0, type: `اکانت تست (${testDays} روزه - ${trialUserTypeLabel})`, is_test: true, user_type: isTrialSingle ? '1' : '0', step: 'PENDING_ADMIN' };

            const userLink = getUserLink(user_id, first_name, username);
            const lastSrv = await db.prepare("SELECT cf_domain FROM services WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(user_id).first();
            const workerText = lastSrv ? `\n🌐 <b>ورکر فعلی:</b> <code>${lastSrv.cf_domain}</code>` : `\n🌐 <b>ورکر فعلی:</b> ندارد (نیاز به ثبت ورکر جدید)`;

            const admText = `🎁 <b>درخواست تست (${newState.type})</b>\n👤 کاربر: ${userLink}\n🆔 آیدی: <code>${user_id}</code>${workerText}`;
            const admKb = { inline_keyboard: [
                [{ text: "✅ تایید و ارسال لینک تست", callback_data: `admaprv_test_${user_id}_${testDays}_0_${newState.user_type}` }],
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

          const festivalCfgCheck = await getFestivalConfig(db);
          if (isFestivalWindowOpen(festivalCfgCheck) && text === festivalCfgCheck.button_text) {
            if (state && state.locked) {
              await sendMessage(user_id, "⏳ درخواست قبلی شما در حال پردازش است. لطفاً منتظر بمانید...");
              return new Response('OK');
            }

            const userRow = await db.prepare("SELECT last_festival_claim FROM users WHERE user_id = ?").bind(user_id).first();
            if (userRow && userRow.last_festival_claim) {
              await sendMessage(user_id, "❌ <b>شما قبلاً از هدیه جشنواره استفاده کرده‌اید!</b>\n\nاین هدیه فقط یک‌بار برای هر کاربر قابل استفاده است.");
              return new Response('OK');
            }

            const fDays = festivalCfgCheck.days || 1;
            const isFestivalSingle = festivalCfgCheck.is_single !== 0;
            const fUserTypeLabel = isFestivalSingle ? 'تک‌کاربره' : 'چندکاربره';

            await sendMessage(user_id, `🎉 <b>مژده جشنواره!</b>\n\nیک اکانت هدیه <b>${fDays} روزه (${fUserTypeLabel})</b> به شما تعلق می‌گیرد!`);

            let newState = { days: fDays, hours: 0, type: `جشنواره (${fDays} روزه - ${fUserTypeLabel})`, is_test: true, user_type: isFestivalSingle ? '1' : '0', step: 'PENDING_ADMIN' };

            const userLink = getUserLink(user_id, first_name, username);
            const lastSrv = await db.prepare("SELECT cf_domain FROM services WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(user_id).first();
            const workerText = lastSrv ? `\n🌐 <b>ورکر فعلی:</b> <code>${lastSrv.cf_domain}</code>` : `\n🌐 <b>ورکر فعلی:</b> ندارد (نیاز به ثبت ورکر جدید)`;

            const admText = `🎉 <b>درخواست جشنواره (${newState.type})</b>\n👤 کاربر: ${userLink}\n🆔 آیدی: <code>${user_id}</code>${workerText}`;
            const admKb = { inline_keyboard: [
                [{ text: "✅ تایید و ارسال لینک جشنواره", callback_data: `admaprv_festival_${user_id}_${fDays}_0_${newState.user_type}` }],
                [{ text: "❌ رد کردن", callback_data: `admrej_${user_id}` }]
            ]};

            const adminMsgRes = await callTelegram('sendMessage', { chat_id: ADMIN_ID, text: admText, reply_markup: admKb, parse_mode: "HTML" });
            if (adminMsgRes && adminMsgRes.ok) {
                newState.admin_message_id = adminMsgRes.result.message_id;
            }
            await setState(db, user_id, newState);

            await sendMessage(user_id, "✅ درخواست شما ثبت شد و به ادمین ارسال گردید. لطفاً تا پاسخ پشتیبانی شکیبا باشید.", pendingMenu());
            return new Response('OK');
          }
        }

        if (msg.photo && state && state.step === 'WAIT_RECEIPT') {
          if (state.locked) return new Response('OK');
          state.locked = true;
          await setState(db, user_id, state);

          if (Date.now() - state.timer_start > 600000) {
            await clearState(db, user_id);
            await sendMessage(user_id, "❌ زمان ۱۰ دقیقه‌ای شما برای پرداخت به پایان رسیده است. لطفاً فرآیند را مجدداً آغاز کنید.", await mainMenu(db, user_id));
            return new Response('OK');
          }

          const photoId = msg.photo[msg.photo.length - 1].file_id;
          const info = state;
          
          const userLink = getUserLink(user_id, first_name, username);
          const lastSrv = await db.prepare("SELECT cf_domain FROM services WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(user_id).first();
          const workerText = lastSrv ? `🌐 <b>ورکر فعلی کاربر:</b> <code>${lastSrv.cf_domain}</code>\n` : `🌐 <b>ورکر فعلی کاربر:</b> ندارد (نیاز به ثبت ورکر جدید)\n`;

          let caption = `🧾 <b>درخواست پرداخت جدید</b>\n👤 کاربر: ${userLink}\n🆔 آیدی: <code>${user_id}</code>\n📅 <b>زمان ثبت:</b> ${getShamsiNow()}\n📦 پلن: ${info.plan_label || planDaysLabel(info.days)} - ${info.type}\n💵 مبلغ: ${(info.price_paid || 0).toLocaleString('fa-IR')} تومان\n${workerText}`;
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
          
          const duplicateCheck = await db.prepare(`
            SELECT s.user_id, u.first_name, u.username
            FROM services s LEFT JOIN users u ON u.user_id = s.user_id
            WHERE s.cf_domain = ? AND s.user_id != ? LIMIT 1
          `).bind(domainInput, state.target_user).first();
          if (duplicateCheck) {
              const ownerLink = getUserLink(duplicateCheck.user_id, duplicateCheck.first_name, duplicateCheck.username);
              await sendMessage(ADMIN_ID, `❌ <b>خطای امنیتی: ورکر تکراری!</b>\n\n⚠️ این ورکر (<code>${domainInput}</code>) قبلاً برای کاربر دیگری ثبت شده است.\n👤 صاحب فعلی: ${ownerLink}\n🆔 آیدی: <code>${duplicateCheck.user_id}</code>\n\nلطفاً یک ورکر جدید وارد کنید یا عملیات را لغو کنید.`);
              return new Response('OK');
          }

          await sendMessage(ADMIN_ID, "⏳ در حال برقراری ارتباط با ورکر، اعمال تنظیمات و استخراج لینک...");
          
          let applyDays = state.days;
          let applyHours = state.hours;
          let applySingle = state.user_type === '1';

          if (state.action === 'test' || state.action === 'festival') {
            applyHours = parseInt(applyDays) * 24;
            applyDays = 0;
          }

          const cfRes = await updateCloudflareExp(domainInput, applyDays, applyHours, applySingle, state.target_user, db);
          
          if (cfRes.success && cfRes.subLink) {

            const shamsiNow = getShamsiNow();
            const freeActionLabels = { test: 'تست', festival: 'جشنواره' };
            const freeActionLabel = freeActionLabels[state.action];
            const planName = freeActionLabel ? `${freeActionLabel} ${state.days} روزه (${applySingle ? 'یک کاربره' : 'چند کاربره'})` : `سرویس ${planDaysLabel(state.days)} (${applySingle ? 'یک کاربره' : 'چند کاربره'})`;
            const planTypeDb = freeActionLabel ? `اکانت ${freeActionLabel} (رایگان) - ${applySingle ? 'یک کاربره' : 'چند کاربره'}` : (applySingle ? 'یک کاربره' : 'چند کاربره');
            
            if (state.action === 'test') {
              await db.prepare("INSERT INTO users (user_id, last_test_date) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_test_date = excluded.last_test_date").bind(state.target_user, getShamsiDateOnly()).run();
            } else if (state.action === 'festival') {
              await db.prepare("INSERT INTO users (user_id, last_festival_claim) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_festival_claim = excluded.last_festival_claim").bind(state.target_user, getShamsiDateOnly()).run();
            }
            
            await db.prepare("INSERT INTO services (user_id, plan_days, plan_type, cf_domain, sub_link, exp_date, status, purchase_date_shamsi) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                .bind(state.target_user, state.days, planTypeDb, domainInput, cfRes.subLink, cfRes.newExpDate, 'ACTIVE', shamsiNow).run();
            
            await clearState(db, state.target_user);

            const uRow = await db.prepare("SELECT first_name, username FROM users WHERE user_id = ?").bind(state.target_user).first();
            const userLink = getUserLink(state.target_user, uRow ? uRow.first_name : "کاربر", uRow ? uRow.username : "");

            const userCaption = `✅ <b>سرویس اختصاصی شما آماده و فعال شد!</b>\n\n👤 <b>کاربر:</b> ${userLink}\n🆔 <b>آیدی:</b> <code>${state.target_user}</code>\n📦 <b>بسته:</b> ${planName}\n📅 <b>تاریخ ثبت:</b> ${shamsiNow}\n\n🔗 <b>لینک اتصال سابسکریپشن:</b>\n<code>${cfRes.subLink}</code>\n\n💡 <i>از دکمه‌های زیر برای افزودن سریع به برنامه استفاده کنید یا بارکد را اسکن نمایید.</i>`;
            await callTelegram('sendPhoto', { chat_id: state.target_user, photo: getQRUrl(cfRes.subLink), caption: userCaption, parse_mode: 'HTML', reply_markup: getImportKeyboard(cfRes.subLink, botOrigin) });
            await sendMessage(state.target_user, "✅ درخواست شما تایید و اعمال شد. به منوی اصلی بازگشتید.", await mainMenu(db, state.target_user));

            const adminCaption = `✅ <b>تحویل سرویس به کاربر با موفقیت انجام شد.</b>\n\n👤 <b>کاربر:</b> ${userLink}\n🆔 <b>آیدی:</b> <code>${state.target_user}</code>\n📦 <b>بسته:</b> ${planName}\n🔗 <b>لینک اتصال:</b>\n<code>${cfRes.subLink}</code>`;
            await callTelegram('sendPhoto', { chat_id: ADMIN_ID, photo: getQRUrl(cfRes.subLink), caption: adminCaption, parse_mode: 'HTML' });
            
            await clearState(db, ADMIN_ID);
            // کیبورد موقتِ «لغو عملیات» رو به‌صورت خودکار با پنل عادی مدیریت جایگزین می‌کنیم (دیگه نیازی به کلیک دستی نیست)
            await sendMessage(ADMIN_ID, "✅ به پنل مدیریت بازگشتید.", adminPanelMenu());
          } else {
            await sendMessage(ADMIN_ID, `❌ <b>خطا در ارتباط با ورکر!</b>\n💬 <b>دلیل خطا:</b> ${cfRes.error}\n\n💡 <i>لطفاً آدرس صحیح دامنه ورکر را مجدداً ارسال کنید یا عملیات را لغو کنید.</i>`);
          }
          return new Response('OK');
        }

        // ================= ویرایش آدرس ورکر یک سرویس خاص توسط ادمین =================
        if (user_id === ADMIN_ID && state && state.step === 'WAIT_EDIT_WORKER_DOMAIN') {
          let domainInput = text.trim();
          if (!domainInput.startsWith('http')) domainInput = 'https://' + domainInput;
          domainInput = domainInput.replace(/\/$/, "");

          const srv = await db.prepare("SELECT * FROM services WHERE id = ?").bind(state.service_id).first();
          if (!srv) {
            await sendMessage(ADMIN_ID, "❌ سرویس یافت نشد.", adminPanelMenu());
            await clearState(db, ADMIN_ID);
            return new Response('OK');
          }

          const duplicateCheck = await db.prepare(`
            SELECT s.user_id, u.first_name, u.username
            FROM services s LEFT JOIN users u ON u.user_id = s.user_id
            WHERE s.cf_domain = ? AND s.id != ? LIMIT 1
          `).bind(domainInput, state.service_id).first();
          if (duplicateCheck) {
              const errKb = { inline_keyboard: [[{ text: "❌ انصراف از این عملیات", callback_data: "cancel_admin" }]] };
              const ownerLink = getUserLink(duplicateCheck.user_id, duplicateCheck.first_name, duplicateCheck.username);
              await sendMessage(ADMIN_ID, `❌ <b>خطای امنیتی: ورکر تکراری!</b>\n\n⚠️ این ورکر (<code>${domainInput}</code>) قبلاً برای کاربر دیگری ثبت شده است.\n👤 صاحب فعلی: ${ownerLink}\n🆔 آیدی: <code>${duplicateCheck.user_id}</code>\n\nلطفاً یک ورکر جدید وارد کنید یا عملیات را لغو کنید.`, errKb);
              return new Response('OK');
          }

          await sendMessage(ADMIN_ID, "⏳ در حال بررسی اعتبار ورکر جدید و انتقال دقیق اطلاعات ورکر قبلی (زمان، تعداد سرویس‌ها، حالت تک/چند‌کاربره)...");

          const validation = await validateWorkerDomain(domainInput);
          if (!validation.success) {
              const errKb = { inline_keyboard: [[{ text: "❌ انصراف از این عملیات", callback_data: "cancel_admin" }]] };
              await sendMessage(ADMIN_ID, `❌ <b>آدرس ورکر تایید نشد!</b>\n\n💬 <b>دلیل خطا:</b> ${validation.error}\n\n💡 لطفاً یک آدرس صحیح و در دسترس وارد کنید یا عملیات را لغو کنید.`, errKb);
              return new Response('OK');
          }

          const oldDomain = srv.cf_domain || "";

          // 1) وضعیت زنده و دقیق ورکر قبلی (برای کیل‌سوییچ) را می‌خوانیم
          const oldWorkerLiveData = await getWorkerStatus(oldDomain);
          const isSingleFromDB = srv.plan_type.includes('یک کاربره');

          // 2) زمان دقیق انقضا (تا دقیقه) و حالت تک/چندکاربره را دقیقاً از رکورد دیتابیس (که همیشه به‌روز است) روی ورکر جدید اعمال می‌کنیم
          const cfRes = await updateCloudflareExp(domainInput, 0, 0, isSingleFromDB, srv.user_id, db);
          if (!cfRes.success || !cfRes.subLink) {
              const errKb = { inline_keyboard: [[{ text: "❌ انصراف از این عملیات", callback_data: "cancel_admin" }]] };
              await sendMessage(ADMIN_ID, `❌ <b>خطا در انتقال اطلاعات به ورکر جدید!</b>\n💬 <b>دلیل خطا:</b> ${cfRes.error || 'نامشخص'}\n\n💡 هیچ تغییری در دیتابیس اعمال نشد. لطفاً یک آدرس صحیح وارد کنید یا عملیات را لغو کنید.`, errKb);
              return new Response('OK');
          }

          // 3) وضعیت قطع فوری (کیل‌سوییچ) ورکر قبلی را هم روی ورکر جدید تکرار می‌کنیم
          let apiDomainNew = domainInput;
          if (apiDomainNew.includes("?url=")) apiDomainNew = decodeURIComponent(apiDomainNew.split("?url=")[1]).replace(/\/$/, "");
          const newWorkerUrl = `${apiDomainNew}/${CF_ADMIN_PATH}?token=${CF_ADMIN_TOKEN}`;
          if (oldWorkerLiveData && oldWorkerLiveData.killSwitch === true) {
            await fetch(newWorkerUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: "toggleKillSwitch" }) });
          }

          // 4) تمام سرویس‌های ثبت‌شده روی همین ورکر قبلی (نه فقط سرویس انتخاب‌شده) به ورکر جدید منتقل می‌شوند
          const { results: siblingSrvs } = await db.prepare("SELECT id, user_id FROM services WHERE cf_domain = ?").bind(oldDomain).all();
          const rowsToMigrate = (siblingSrvs && siblingSrvs.length) ? siblingSrvs : [{ id: srv.id, user_id: srv.user_id }];

          for (const row of rowsToMigrate) {
            await db.prepare("UPDATE services SET cf_domain = ?, sub_link = ?, exp_date = ? WHERE id = ?")
              .bind(domainInput, cfRes.subLink, cfRes.newExpDate, row.id).run();
          }

          const updatedSrvAfterEdit = await db.prepare("SELECT * FROM services WHERE id = ?").bind(state.service_id).first();
          const workerDataAfterEdit = await getWorkerStatus(updatedSrvAfterEdit.cf_domain);
          const isKsActiveAfterEdit = workerDataAfterEdit.killSwitch === true;
          const isSingleTypeAfterEdit = updatedSrvAfterEdit.plan_type.includes('یک کاربره');

          // به‌جای پاک کردن استیت و بازگشت به منوی اصلی، در همان صفحه مدیریت سرویس باقی می‌مانیم
          await setState(db, ADMIN_ID, { step: 'MANAGE_FIXED_ACTIONS', service_id: state.service_id });

          await sendMessage(ADMIN_ID, `✅ آدرس ورکر با موفقیت ویرایش شد و اطلاعات به‌طور کامل منتقل گردید.\n\n🌐 <b>آدرس جدید:</b>\n<code>${domainInput}</code>\n📦 <b>تعداد سرویس‌های منتقل‌شده روی این ورکر:</b> ${rowsToMigrate.length}\n👥 <b>حالت:</b> ${isSingleTypeAfterEdit ? 'تک‌کاربره' : 'چندکاربره'}\n🔌 <b>قطع فوری:</b> ${isKsActiveAfterEdit ? '🛑 مسدود' : '✅ آزاد'}`, adminServiceKeyboard(isSingleTypeAfterEdit, isKsActiveAfterEdit));

          // اطلاع‌رسانی به تمام کاربران متأثر (معمولاً یک کاربر، اما اگر چند کاربر روی این ورکر بودند همه مطلع می‌شوند)
          const notifiedUsers = new Set();
          const editedUserMsg = `⚠️ <b>توجه: آدرس اتصال سرویس شما توسط پشتیبانی ویرایش شد.</b>\n\nاین تغییر معمولاً به این دلیل انجام می‌شود که آدرس قبلی به هر دلیلی (از جمله فیلترشدن) دچار مشکل دسترسی شده است. تمام اطلاعات شما (زمان باقی‌مانده و حالت تک/چندکاربره) بدون هیچ کم و کاستی به آدرس جدید منتقل شد.\n\n🔗 <b>لینک اتصال سابسکریپشن جدید شما:</b>\n<code>${cfRes.subLink}</code>\n\n💡 لطفاً از این پس فقط از لینک جدید برای اتصال استفاده کنید.`;
          for (const row of rowsToMigrate) {
            if (notifiedUsers.has(row.user_id)) continue;
            notifiedUsers.add(row.user_id);
            await callTelegram('sendPhoto', { chat_id: row.user_id, photo: getQRUrl(cfRes.subLink), caption: editedUserMsg, parse_mode: 'HTML', reply_markup: getImportKeyboard(cfRes.subLink, botOrigin) });
          }
          return new Response('OK');
        }

        // ================= تنظیمات ربات =================
        if (text === "⚙️ تنظیمات ربات" && user_id === ADMIN_ID) {
          await sendMessage(chat_id, "⚙️ <b>تنظیمات ربات</b>\n\nاز گزینه‌های زیر استفاده کنید:", settingsMenu());
          return new Response('OK');
        }

        // ================= مدیریت پلن‌های اشتراک =================
        if (text === "🧩 مدیریت پلن‌های اشتراک" && user_id === ADMIN_ID) {
          await clearState(db, ADMIN_ID);
          const { msg, kb } = await renderPlansListMessage(db);
          await sendMessage(ADMIN_ID, msg, kb);
          return new Response('OK');
        }

        // مراحل ساخت پلن جدید (نام دکمه → مدت روز → قیمت تک‌کاربره → قیمت چندکاربره → تاریخ پایان پیشنهاد)
        if (user_id === ADMIN_ID && state && state.step === 'WAIT_PLAN_LABEL') {
          const label = text.trim();
          if (!label) {
            await sendMessage(ADMIN_ID, "❌ نام دکمه نمی‌تواند خالی باشد. لطفاً دوباره ارسال کنید:", pendingMenu());
            return new Response('OK');
          }
          await setState(db, ADMIN_ID, { step: 'WAIT_PLAN_DAYS', new_plan: { label } });
          await sendMessage(ADMIN_ID, "⏳ <b>مدت اعتبار اشتراک</b> را بر حسب روز وارد کنید (مثلاً: 30):", pendingMenu());
          return new Response('OK');
        }

        if (user_id === ADMIN_ID && state && state.step === 'WAIT_PLAN_DAYS') {
          const days = parseInt(text.trim());
          if (isNaN(days) || days <= 0) {
            await sendMessage(ADMIN_ID, "❌ لطفاً یک عدد معتبر برای تعداد روز وارد کنید:", pendingMenu());
            return new Response('OK');
          }
          const newPlan = { ...state.new_plan, days };
          await setState(db, ADMIN_ID, { step: 'WAIT_PLAN_PRICE_SINGLE', new_plan: newPlan });
          await sendMessage(ADMIN_ID, "👤 <b>قیمت حالت تک‌کاربره</b> را به تومان وارد کنید (مثلاً: 45000):", pendingMenu());
          return new Response('OK');
        }

        if (user_id === ADMIN_ID && state && state.step === 'WAIT_PLAN_PRICE_SINGLE') {
          const priceSingle = parseInt(text.trim());
          if (isNaN(priceSingle) || priceSingle < 0) {
            await sendMessage(ADMIN_ID, "❌ لطفاً یک عدد معتبر برای قیمت وارد کنید:", pendingMenu());
            return new Response('OK');
          }
          const newPlan = { ...state.new_plan, price_single: priceSingle };
          await setState(db, ADMIN_ID, { step: 'WAIT_PLAN_PRICE_MULTI', new_plan: newPlan });
          await sendMessage(ADMIN_ID, "👥 <b>قیمت حالت چندکاربره</b> را به تومان وارد کنید (اگر می‌خواهید این حالت رایگان باشد، عدد 0 ارسال کنید):", pendingMenu());
          return new Response('OK');
        }

        if (user_id === ADMIN_ID && state && state.step === 'WAIT_PLAN_PRICE_MULTI') {
          const priceMulti = parseInt(text.trim());
          if (isNaN(priceMulti) || priceMulti < 0) {
            await sendMessage(ADMIN_ID, "❌ لطفاً یک عدد معتبر برای قیمت وارد کنید:", pendingMenu());
            return new Response('OK');
          }
          const newPlan = { ...state.new_plan, price_multi: priceMulti };
          await setState(db, ADMIN_ID, { step: 'WAIT_PLAN_EXPIRY', new_plan: newPlan });
          const expKb = { inline_keyboard: [[{ text: "♾ بدون تاریخ انقضا", callback_data: "planexpiry_none" }]] };
          await sendMessage(ADMIN_ID, "⏳ اگر می‌خواهید این پلن فقط تا تاریخ خاصی در دسترس باشد (پیشنهاد ویژه/زمان‌دار)، تاریخ را به شمسی وارد کنید (مثال: 1403/12/29).\n\nدر غیر این صورت روی دکمه زیر بزنید:", expKb);
          return new Response('OK');
        }

        if (user_id === ADMIN_ID && state && state.step === 'WAIT_PLAN_EXPIRY') {
          const expireDate = text.trim();
          const np = state.new_plan;
          const { results: maxRow } = await db.prepare("SELECT COALESCE(MAX(sort_order), 0) as m FROM plans").all();
          const nextOrder = (maxRow && maxRow[0] ? maxRow[0].m : 0) + 1;
          await db.prepare("INSERT INTO plans (label, days, price_single, price_multi, is_active, sort_order, expire_date_shamsi) VALUES (?, ?, ?, ?, 1, ?, ?)")
            .bind(np.label, np.days, np.price_single, np.price_multi, nextOrder, expireDate || null).run();
          await clearState(db, ADMIN_ID);
          await sendMessage(ADMIN_ID, `✅ پلن <b>${escapeHtml(np.label)}</b> با موفقیت ساخته شد و اکنون فعال است.`);
          const { msg, kb } = await renderPlansListMessage(db);
          await sendMessage(ADMIN_ID, msg, kb);
          return new Response('OK');
        }

        // ویرایش مقدار یک فیلد از پلن
        if (user_id === ADMIN_ID && state && state.step === 'WAIT_PLAN_EDIT_VALUE') {
          const { plan_id, field } = state;
          let value = text.trim();
          const numericFields = ['days', 'price_single', 'price_multi'];
          if (numericFields.includes(field)) {
            const n = parseInt(value);
            if (isNaN(n) || n < 0) {
              await sendMessage(ADMIN_ID, "❌ لطفاً یک عدد معتبر وارد کنید:", pendingMenu());
              return new Response('OK');
            }
            value = n;
          }
          if (field === 'expire_date_shamsi' && (value === '-' || value === '' || value.toLowerCase() === 'حذف')) {
            value = null;
          }
          await db.prepare(`UPDATE plans SET ${field} = ? WHERE id = ?`).bind(value, plan_id).run();
          await clearState(db, ADMIN_ID);
          await sendMessage(ADMIN_ID, "✅ پلن با موفقیت به‌روزرسانی شد.");
          const { msg, kb } = await renderPlansListMessage(db);
          await sendMessage(ADMIN_ID, msg, kb);
          return new Response('OK');
        }
		
		
		// ================= مدیریت کدهای تخفیف =================
        if (text === "🎟 مدیریت کدهای تخفیف" && user_id === ADMIN_ID) {
          const { results: discounts } = await db.prepare("SELECT * FROM discounts ORDER BY id DESC").all();
          let msg = "🎟 <b>لیست کدهای تخفیف فعال:</b>\n\n";
          
          if (!discounts || discounts.length === 0) {
            msg += "هیچ کد تخفیفی ثبت نشده است.\n";
          } else {
            discounts.forEach(d => {
              msg += `🏷 <b>کد:</b> <code>${d.code}</code>\n📉 درصد: ${d.percent}%\n👥 استفاده شده: ${d.used_count} از ${d.max_uses}\n⏳ انقضا: ${d.expire_date_shamsi}\n➖➖➖➖\n`;
            });
          }
          
          const kb = { inline_keyboard: [[{ text: "➕ افزودن کد تخفیف جدید", callback_data: "admadd_discount" }]] };
          await sendMessage(ADMIN_ID, msg, kb);
          return new Response('OK');
        }

        // دریافت اطلاعات کد تخفیف جدید از ادمین
        if (user_id === ADMIN_ID && state && state.step === 'WAIT_DISCOUNT_DATA') {
          // فرمت مورد انتظار: کد-درصد-تعداد-تاریخ
          const parts = text.split('-');
          if (parts.length !== 4) {
            await sendMessage(ADMIN_ID, "❌ فرمت وارد شده اشتباه است. لطفاً دقیقاً مانند مثال ارسال کنید:\n\n<code>NOROUZ-20-50-1403/01/15</code>", pendingMenu());
            return new Response('OK');
          }
          
          const [code, percentStr, maxUsesStr, expireDate] = parts;
          const percent = parseInt(percentStr);
          const maxUses = parseInt(maxUsesStr);
          
          if (isNaN(percent) || isNaN(maxUses)) {
             await sendMessage(ADMIN_ID, "❌ درصد یا تعداد استفاده باید عدد باشند.", pendingMenu());
             return new Response('OK');
          }

          try {
            await db.prepare("INSERT INTO discounts (code, percent, max_uses, expire_date_shamsi) VALUES (?, ?, ?, ?)").bind(code.trim(), percent, maxUses, expireDate.trim()).run();
            await clearState(db, ADMIN_ID);
            await sendMessage(ADMIN_ID, `✅ کد تخفیف <b>${code}</b> با موفقیت ثبت شد!`, settingsMenu());
          } catch (e) {
            await sendMessage(ADMIN_ID, "❌ این کد تخفیف قبلاً ثبت شده است یا خطایی رخ داد.", pendingMenu());
          }
          return new Response('OK');
        }		
		
		

        if (text === "🗑 مدیریت و پاک‌سازی داده‌ها" && user_id === ADMIN_ID) {
          await clearState(db, ADMIN_ID);
          await sendMessage(chat_id, "🗑 <b>مدیریت و پاک‌سازی داده‌ها</b>\n\nمی‌توانید هر بخش از داده‌ها را جداگانه پاک کنید، یا اطلاعات یک کاربر خاص را به‌طور کامل حذف نمایید.\n\n⚠️ تمام عملیات‌های این بخش غیرقابل بازگشت هستند.", wipeOptionsMenu());
          return new Response('OK');
        }

        // ================= مدیریت اکانت تست و جشنواره =================
        if (text === "🎁 مدیریت اکانت تست و جشنواره" && user_id === ADMIN_ID) {
          await clearState(db, ADMIN_ID);
          await sendMessage(chat_id, "🎁 <b>مدیریت اکانت تست و جشنواره</b>\n\nکدام بخش را می‌خواهید مدیریت کنید؟", trialFestivalMenu());
          return new Response('OK');
        }

        // دریافت مقدار جدید یکی از فیلدهای تنظیمات اکانت تست
        if (user_id === ADMIN_ID && state && state.step === 'WAIT_TRIAL_EDIT_VALUE') {
          const field = state.field;
          const cfg = await getTrialConfig(db);
          if (field === 'button_text') {
            const val = text.trim();
            if (!val) {
              await sendMessage(ADMIN_ID, "❌ متن دکمه نمی‌تواند خالی باشد. لطفاً دوباره ارسال کنید:", pendingMenu());
              return new Response('OK');
            }
            cfg.button_text = val;
          } else {
            const n = parseInt(text.trim());
            if (isNaN(n) || n <= 0) {
              await sendMessage(ADMIN_ID, "❌ لطفاً یک عدد معتبر (بزرگ‌تر از صفر) وارد کنید:", pendingMenu());
              return new Response('OK');
            }
            cfg[field] = n;
          }
          await setSetting(db, 'trial_config', cfg);
          await clearState(db, ADMIN_ID);
          await sendMessage(ADMIN_ID, "✅ تنظیمات اکانت تست به‌روزرسانی شد.");
          const { msg, kb } = await renderTrialConfigMessage(db);
          await sendMessage(ADMIN_ID, msg, kb);
          return new Response('OK');
        }

        // دریافت مقدار جدید یکی از فیلدهای تنظیمات جشنواره
        if (user_id === ADMIN_ID && state && state.step === 'WAIT_FESTIVAL_EDIT_VALUE') {
          const field = state.field;
          const cfg = await getFestivalConfig(db);
          if (field === 'button_text') {
            const val = text.trim();
            if (!val) {
              await sendMessage(ADMIN_ID, "❌ متن دکمه نمی‌تواند خالی باشد. لطفاً دوباره ارسال کنید:", pendingMenu());
              return new Response('OK');
            }
            cfg.button_text = val;
          } else if (field === 'days') {
            const n = parseInt(text.trim());
            if (isNaN(n) || n <= 0) {
              await sendMessage(ADMIN_ID, "❌ لطفاً یک عدد معتبر (بزرگ‌تر از صفر) وارد کنید:", pendingMenu());
              return new Response('OK');
            }
            cfg.days = n;
          } else if (field === 'start_date' || field === 'end_date') {
            const val = text.trim();
            cfg[field] = (val === '-' || val === '') ? "" : val;
          }
          await setSetting(db, 'festival_config', cfg);
          await clearState(db, ADMIN_ID);
          await sendMessage(ADMIN_ID, "✅ تنظیمات جشنواره به‌روزرسانی شد.");
          const { msg, kb } = await renderFestivalConfigMessage(db);
          await sendMessage(ADMIN_ID, msg, kb);
          return new Response('OK');
        }

        // دریافت آیدی/یوزرنیم کاربر هدف برای پاک‌سازی موردی
        if (user_id === ADMIN_ID && state && state.step === 'WAIT_WIPE_USER_TARGET') {
          const term = text.trim().replace(/^@/, '');
          const row = await db.prepare("SELECT user_id, first_name, username FROM users WHERE CAST(user_id AS TEXT) = ? OR username = ?").bind(term, term).first();
          if (!row) {
            await sendMessage(ADMIN_ID, "❌ کاربری با این مشخصات یافت نشد. لطفاً دوباره ارسال کنید یا عملیات را لغو کنید.", pendingMenu());
            return new Response('OK');
          }
          if (Number(row.user_id) === ADMIN_ID) {
            await sendMessage(ADMIN_ID, "⛔ برای ادمین این امکان وجود ندارد.", pendingMenu());
            return new Response('OK');
          }
          const svcCountRow = await db.prepare("SELECT COUNT(*) as c FROM services WHERE user_id = ?").bind(row.user_id).first();
          const svcCount = svcCountRow ? svcCountRow.c : 0;
          const userLink = getUserLink(row.user_id, row.first_name, row.username);
          await clearState(db, ADMIN_ID);
          const confirmKb = { inline_keyboard: [
            [{ text: "✅ بله، تمام اطلاعات این کاربر پاک شود", callback_data: `admwipeuserconfirm_${row.user_id}` }],
            [{ text: "❌ انصراف", callback_data: "admwipe_cancel" }]
          ] };
          await sendMessage(ADMIN_ID, `⚠️ <b>تایید حذف کاربر</b>\n\n👤 کاربر: ${userLink}\n🆔 آیدی: <code>${row.user_id}</code>\n📦 تعداد سرویس‌ها: ${svcCount}\n\nبا تایید، حساب کاربری، تمام سرویس‌ها، وضعیت فعلی و سوابق دعوت این کاربر برای همیشه پاک می‌شود. آیا مطمئن هستید؟`, confirmKb);
          return new Response('OK');
        }

        // ================= ارسال اطلاعیه (به همه یا کاربران خاص) =================
        if (text === "📢 ارسال اطلاعیه" && user_id === ADMIN_ID) {
          await clearState(db, ADMIN_ID);
          const choiceKb = {
            inline_keyboard: [
              [{ text: "👥 همه کاربران", callback_data: "bcast_all" }],
              [{ text: "🎯 کاربران خاص", callback_data: "bcast_specific" }]
            ]
          };
          await sendMessage(chat_id, "📢 <b>ارسال اطلاعیه</b>\n\nمی‌خواهید این اطلاعیه برای چه کسانی ارسال شود؟", choiceKb);
          return new Response('OK');
        }

        // دریافت لیست کاربران خاص (آیدی عددی یا یوزرنیم) قبل از دریافت محتوای اطلاعیه
        if (user_id === ADMIN_ID && state && state.step === 'WAIT_BROADCAST_TARGETS') {
          const rawList = text.split(/[\n,]+/).map(s => s.trim().replace(/^@/, '')).filter(Boolean);
          if (rawList.length === 0) {
            await sendMessage(ADMIN_ID, "❌ لطفاً حداقل یک آیدی عددی یا یوزرنیم معتبر ارسال کنید.");
            return new Response('OK');
          }

          let matchedUsers = [];
          let notFound = [];
          for (const item of rawList) {
            const row = await db.prepare("SELECT user_id, first_name, username FROM users WHERE (CAST(user_id AS TEXT) = ? OR username = ?) AND user_id != ?").bind(item, item, ADMIN_ID).first();
            if (row) {
              if (!matchedUsers.find(u => u.user_id === row.user_id)) matchedUsers.push(row);
            } else {
              notFound.push(item);
            }
          }

          if (matchedUsers.length === 0) {
            await sendMessage(ADMIN_ID, "❌ هیچ‌کدام از موارد ارسالی در دیتابیس یافت نشد (یا مربوط به ادمین بودند). لطفاً دوباره تلاش کنید یا عملیات را لغو کنید.", pendingMenu());
            return new Response('OK');
          }

          let listMsg = `✅ <b>${matchedUsers.length} کاربر یافت شد:</b>\n\n`;
          matchedUsers.forEach(u => {
            listMsg += `👤 ${getUserLink(u.user_id, u.first_name, u.username)} — <code>${u.user_id}</code>\n`;
          });
          if (notFound.length > 0) {
            listMsg += `\n⚠️ <b>موارد یافت‌نشده:</b> ${notFound.join('، ')}`;
          }
          listMsg += `\n\n👇 حالا هر چیزی که می‌خواهید فقط برای همین کاربران ارسال شود را بفرستید (متن، عکس، لینک و ...).`;

          await setState(db, ADMIN_ID, { step: 'WAIT_BROADCAST_CONTENT', broadcast_mode: 'specific', broadcast_targets: matchedUsers.map(u => u.user_id) });
          await sendMessage(ADMIN_ID, listMsg, pendingMenu());
          return new Response('OK');
        }

        if (user_id === ADMIN_ID && state && state.step === 'WAIT_BROADCAST_CONTENT') {
          const bMode = state.broadcast_mode || 'all';
          const bTargets = state.broadcast_targets || [];
          await setState(db, ADMIN_ID, { step: 'CONFIRM_BROADCAST', src_chat_id: chat_id, src_message_id: msg.message_id, broadcast_mode: bMode, broadcast_targets: bTargets });

          const targetLabel = bMode === 'specific' ? `${bTargets.length} کاربر خاص` : "تمام کاربران ربات";
          await sendMessage(ADMIN_ID, `👇 این پیش‌نمایش دقیقاً همانطور که هست (متن، فرمت، عکس، لینک) برای <b>${targetLabel}</b> ارسال خواهد شد:`);
          const confirmKb = {
            inline_keyboard: [
              [{ text: "✅ تایید و ارسال", callback_data: "confirm_broadcast" }],
              [{ text: "❌ انصراف", callback_data: "cancel_broadcast" }]
            ]
          };
          await callTelegram('copyMessage', { chat_id: ADMIN_ID, from_chat_id: chat_id, message_id: msg.message_id, reply_markup: confirmKb });
          return new Response('OK');
        }
		
		
		// دریافت تاریخ خاص برای گزارش‌گیری از ادمین
        if (user_id === ADMIN_ID && state && state.step === 'WAIT_REPORT_DATE') {
          const targetDate = text.trim(); 
          const { results: targetServices } = await db.prepare("SELECT plan_days, plan_type, purchase_date_shamsi FROM services WHERE purchase_date_shamsi LIKE ?").bind(`${targetDate}%`).all();

          let targetCount = 0, targetIncome = 0;
          if (targetServices && targetServices.length > 0) {
            const priceMapReport = await buildDaysPriceMap(db);
            targetServices.forEach(s => {
              const priceEntryReport = priceMapReport.get(s.plan_days) || { single: 0, multi: 0 };
              let price = s.plan_type.includes('چند کاربره') ? priceEntryReport.multi : priceEntryReport.single;
              if (s.plan_type.includes('رایگان') || s.plan_type.includes('تست')) price = 0;
              targetCount++;
              targetIncome += price;
            });
          }

          let msg = `📊 <b>گزارش فروش برای تاریخ:</b> <code>${targetDate}</code>\n\n`;
          msg += `تعداد فروش: <b>${targetCount} سرویس</b>\n`;
          msg += `مجموع درآمد: <b>${targetIncome.toLocaleString('fa-IR')} تومان</b>`;

          await clearState(db, ADMIN_ID);
          await sendMessage(ADMIN_ID, msg, adminPanelMenu());
          return new Response('OK');
        }	
		
		

        // بررسی کد تخفیف ارسال شده توسط کاربر
        if (state && state.step === 'WAIT_DISCOUNT_CODE' && user_id !== ADMIN_ID) {
          const codeInput = text.trim();
          const shamsiNow = getShamsiNow().split(/[ ,-]/)[0]; 
          
          const discount = await db.prepare("SELECT * FROM discounts WHERE code = ?").bind(codeInput).first();
          
          if (!discount) {
             await sendMessage(chat_id, "❌ کد تخفیف وارد شده نامعتبر است.\nلطفاً کد صحیح را ارسال کنید یا از دکمه مرحله قبل برای رد شدن استفاده کنید.");
             return new Response('OK');
          }
          
          if (discount.used_count >= discount.max_uses) {
             await sendMessage(chat_id, "❌ ظرفیت استفاده از این کد تخفیف به پایان رسیده است.");
             return new Response('OK');
          }
          
          if (discount.expire_date_shamsi < shamsiNow) {
             await sendMessage(chat_id, "❌ مهلت استفاده از این کد تخفیف به پایان رسیده است.");
             return new Response('OK');
          }

          const plan = await getPlanById(db, state.plan_id);
          if (!plan) {
            await sendMessage(chat_id, "❌ این پلن دیگر در دسترس نیست. لطفاً دوباره از منوی «🛒 خرید سرویس» اقدام کنید.", await mainMenu(db, user_id));
            await clearState(db, user_id);
            return new Response('OK');
          }
          const basePrice = state.user_type === '1' ? (plan.price_single || 0) : (plan.price_multi || 0);

          const discountAmount = (basePrice * discount.percent) / 100;
          const finalPrice = basePrice - discountAmount;

          await db.prepare("UPDATE discounts SET used_count = used_count + 1 WHERE id = ?").bind(discount.id).run();

          state.step = 'WAIT_RECEIPT';
          state.timer_start = Date.now();
          state.price_paid = finalPrice;
          await setState(db, user_id, state);
          
          const factor = `🎉 <b>کد تخفیف ${discount.percent} درصدی اعمال شد!</b>\n\n💳 <b>فاکتور نهایی ${escapeHtml(plan.label)} (${state.type})</b>\n💵 قیمت اصلی: <s>${basePrice.toLocaleString('fa-IR')} تومان</s>\n🎁 مبلغ قابل پرداخت: <b>${finalPrice.toLocaleString('fa-IR')} تومان</b>\n\nلطفاً مبلغ فوق را واریز کرده و <b>عکس رسید تراکنش</b> را ارسال کنید:\n\n💳 <code>${CARD_NUMBER}</code>\n\n⏱ <i>شما ۱۰ دقیقه فرصت دارید.</i>`;
          
          await sendMessage(chat_id, factor, backAndSupportKeyboard());
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
          await sendMessage(chat_id, `💬 <b>ارسال پیام شخصی به پشتیبانی:</b>\n\nشما متن زیر را تایپ کرده‌اید:\n\n<i>"${escapeHtml(text)}"</i>\n\nآیا می‌خواهید این پیام برای ادمین/پشتیبانی ارسال شود؟`, confirmKb);
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

        if (data === 'admback') {
            if (user_id !== ADMIN_ID) return new Response('OK');
            await callTelegram('deleteMessage', { chat_id, message_id: msg_id });
            return new Response('OK');
        }

        if (data === 'confirm_send_msg') {
          if (state && state.message_text) {
            const uRow = await db.prepare("SELECT first_name, username FROM users WHERE user_id = ?").bind(user_id).first();
            const userLink = getUserLink(user_id, uRow ? uRow.first_name : "کاربر", uRow ? uRow.username : "");
            
            const admText = `📩 <b>پیام شخصی جدید از کاربر:</b>\n\n👤 <b>کاربر:</b> ${userLink}\n🆔 <b>آیدی:</b> <code>${user_id}</code>\n\n💬 <b>متن پیام:</b>\n${escapeHtml(state.message_text)}`;
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

        if (data.startsWith('admreply_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const targetUid = data.split('_')[1];
          await setState(db, ADMIN_ID, { step: 'WAIT_ADMIN_REPLY_TEXT', target_user: targetUid });
          await sendMessage(ADMIN_ID, `💬 لطفاً پاسخ خود را برای کاربر (آیدی: <code>${targetUid}</code>) تایپ و ارسال کنید:`, pendingMenu());
          return new Response('OK');
        }

        // صفر کردن زمان برای دکمه‌های اینلاین قدیمی
        if (data.startsWith('admexpire_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const srvId = data.split('_')[1];
          const srv = await db.prepare("SELECT * FROM services WHERE id = ?").bind(srvId).first();
          if (srv) {
            let apiDomain = srv.cf_domain.trim();
            if (!apiDomain.startsWith('http')) apiDomain = 'https://' + apiDomain;
            apiDomain = apiDomain.replace(/\/$/, "");
            if (apiDomain.includes("?url=")) apiDomain = decodeURIComponent(apiDomain.split("?url=")[1]).replace(/\/$/, "");
            const url = `${apiDomain}/${CF_ADMIN_PATH}?token=${CF_ADMIN_TOKEN}`;
            
            const now = new Date();
            now.setMinutes(now.getMinutes() - 5);
            const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(now); 
            const timeStr = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' }).format(now).substring(0, 5);
            
            try {
               await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: "updateExp", date: dateStr, time: timeStr }) });
               await db.prepare("UPDATE services SET exp_date = ?, status = 'INACTIVE' WHERE id = ?").bind(now.toISOString(), srvId).run();
               await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "⏳ زمان سرویس با موفقیت صفر (منقضی) شد.", show_alert: true });
               await refreshAdminServiceMessage(db, srvId, chat_id, msg_id);
            } catch(e) {
               await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "❌ خطا در ارتباط با ورکر", show_alert: true });
            }
          }
          return new Response('OK');
        }

        // قطع و وصل فوری برای دکمه‌های اینلاین قدیمی
        if (data.startsWith('admks_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const srvId = data.split('_')[1];
          const srv = await db.prepare("SELECT * FROM services WHERE id = ?").bind(srvId).first();
          if (srv) {
            let apiDomain = srv.cf_domain.trim();
            if (!apiDomain.startsWith('http')) apiDomain = 'https://' + apiDomain;
            apiDomain = apiDomain.replace(/\/$/, "");
            if (apiDomain.includes("?url=")) apiDomain = decodeURIComponent(apiDomain.split("?url=")[1]).replace(/\/$/, "");
            const url = `${apiDomain}/${CF_ADMIN_PATH}?token=${CF_ADMIN_TOKEN}`;

            try {
              const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: "toggleKillSwitch" }) });
              if (res.ok) {
                await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "عملیات قطع/وصل سریع در ورکر انجام شد.", show_alert: true });
                await refreshAdminServiceMessage(db, srvId, chat_id, msg_id);
              } else {
                 await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "❌ خطا در ارتباط با ورکر.", show_alert: true });
              }
            } catch(e) {
              await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "❌ عدم برقراری ارتباط با دامنه.", show_alert: true });
            }
          }
          return new Response('OK');
        }

        // تغییر کاربری دکمه اینلاین قدیمی
        if (data.startsWith('admmulti_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const srvId = data.split('_')[1];
          const srv = await db.prepare("SELECT * FROM services WHERE id = ?").bind(srvId).first();
          if (srv) {
            let apiDomain = srv.cf_domain.trim();
            if (!apiDomain.startsWith('http')) apiDomain = 'https://' + apiDomain;
            apiDomain = apiDomain.replace(/\/$/, "");
            if (apiDomain.includes("?url=")) apiDomain = decodeURIComponent(apiDomain.split("?url=")[1]).replace(/\/$/, "");
            const url = `${apiDomain}/${CF_ADMIN_PATH}?token=${CF_ADMIN_TOKEN}`;
            
            try {
               await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: "toggleUser" }) });
               const isSingle = srv.plan_type.includes('یک کاربره');
               const newPlanType = isSingle ? srv.plan_type.replace('یک کاربره', 'چند کاربره') : srv.plan_type.replace('چند کاربره', 'یک کاربره');
               await db.prepare("UPDATE services SET plan_type = ? WHERE id = ?").bind(newPlanType, srvId).run();
               await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: `✅ سرویس با موفقیت به ${isSingle ? 'چندکاربره' : 'تک‌کاربره'} تغییر یافت.`, show_alert: true });
               await refreshAdminServiceMessage(db, srvId, chat_id, msg_id);
            } catch(e) {
               await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "❌ خطا در ارتباط با دامنه", show_alert: true });
            }
          }
          return new Response('OK');
        }

        // تمدید دکمه اینلاین قدیمی
        if (data.startsWith('admrenew_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const srvId = data.split('_')[1];
          await setState(db, ADMIN_ID, { step: 'WAIT_ADMIN_ADD_DAYS', service_id: srvId, original_msg_id: msg_id });
          await sendMessage(ADMIN_ID, `⏳ لطفاً تعداد روزهایی که می‌خواهید به این سرویس افزوده شود را تایپ کرده و بفرستید (مثلاً: 5 یا 30):`, pendingMenu());
          return new Response('OK');
        }

        // حذف سرویس توسط ادمین و کسر زمان دقیق از روی ورکر
        if (data.startsWith('admdel_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const srvId = data.split('_')[1];
          const srv = await db.prepare("SELECT * FROM services WHERE id = ?").bind(srvId).first();
          
          if (srv) {
              if (srv.exp_date && srv.status === 'ACTIVE') {
                  const expDate = new Date(srv.exp_date);
                  const now = new Date();
                  if (expDate > now) {
                      const remainingMs = expDate.getTime() - now.getTime();
                      const workerData = await getWorkerStatus(srv.cf_domain);
                      
                      if (workerData && workerData.exp && workerData.exp > now.getTime()) {
                          let newWorkerExpMs = workerData.exp - remainingMs;
                          if (newWorkerExpMs < now.getTime()) newWorkerExpMs = now.getTime() - 60000; 
                          
                          const newExpDate = new Date(newWorkerExpMs);
                          const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(newExpDate); 
                          const timeStr = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' }).format(newExpDate).substring(0, 5);
                          
                          let apiDomain = srv.cf_domain.trim();
                          if (!apiDomain.startsWith('http')) apiDomain = 'https://' + apiDomain;
                          apiDomain = apiDomain.replace(/\/$/, "");
                          if (apiDomain.includes("?url=")) apiDomain = decodeURIComponent(apiDomain.split("?url=")[1]).replace(/\/$/, "");
                          
                          await fetch(`${apiDomain}/${CF_ADMIN_PATH}?token=${CF_ADMIN_TOKEN}`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ action: "updateExp", date: dateStr, time: timeStr })
                          });
                      }
                  }
              }
              await db.prepare("DELETE FROM services WHERE id = ?").bind(srvId).run();
              await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: `🗑 سرویس شناسه #${srvId} با موفقیت حذف گردید و زمان باقی‌مانده آن از ورکر کسر شد.`, parse_mode: "HTML" });
          }
          return new Response('OK');
        }

        // ویرایش دستی آدرس ورکر یک سرویس توسط ادمین (مثلاً به دلیل فیلتر شدن آدرس قبلی)
        else if (data.startsWith('admeditworker_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const srvId = data.split('_')[1];
          const srv = await db.prepare("SELECT * FROM services WHERE id = ?").bind(srvId).first();
          if (!srv) {
            await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "❌ سرویس یافت نشد.", show_alert: true });
            return new Response('OK');
          }
          await setState(db, ADMIN_ID, { step: 'WAIT_EDIT_WORKER_DOMAIN', service_id: srvId });
          const editKb = { inline_keyboard: [[{ text: "❌ انصراف از این عملیات", callback_data: "cancel_admin" }]] };
          await sendMessage(ADMIN_ID, `✏️ <b>ویرایش آدرس ورکر سرویس #${srvId}</b>\n\n🌐 آدرس فعلی:\n<code>${srv.cf_domain}</code>\n\nلطفاً <b>آدرس دامنه جدید ورکر</b> را تایپ و ارسال کنید:`, editKb);
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          return new Response('OK');
        }

        // انتخاب کاربر از لیست پیشنهادی جستجو
        else if (data.startsWith('admuser_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const targetUid = data.split('_')[1];

          await callTelegram('deleteMessage', { chat_id, message_id: msg_id });

          const uRow = await db.prepare("SELECT first_name, username FROM users WHERE user_id = ?").bind(targetUid).first();
          const { results: srvList } = await db.prepare("SELECT * FROM services WHERE user_id = ? ORDER BY id DESC").bind(targetUid).all();

          if (!srvList || srvList.length === 0) {
            const newSrvKb = { inline_keyboard: [[{ text: "➕ ثبت سرویس جدید برای این کاربر", callback_data: `admnewsrv_${targetUid}` }]] };
            await sendMessage(ADMIN_ID, `❌ کاربر یافت شد اما هیچ سرویسی برای آیدی <code>${targetUid}</code> ثبت نشده است.\n\nمی‌توانید یک سرویس جدید مستقیماً برای او ثبت کنید:`, newSrvKb);
            await clearState(db, ADMIN_ID);
            return new Response('OK');
          }

          const targetSrv = srvList[0];
          await setState(db, ADMIN_ID, { step: 'MANAGE_FIXED_ACTIONS', service_id: targetSrv.id });

          const userLink = getUserLink(targetUid, uRow ? uRow.first_name : "کاربر", uRow ? uRow.username : "");
          const refCountRow2 = await db.prepare("SELECT COUNT(*) as cnt FROM referrals WHERE referrer_id = ?").bind(targetUid).first();
          const referralCount2 = refCountRow2 ? refCountRow2.cnt : 0;
          const workerData = await getWorkerStatus(targetSrv.cf_domain);
          const isKsActive = workerData.killSwitch === true;
          const isSingle = targetSrv.plan_type.includes('یک کاربره');

          let apiDomainMain = targetSrv.cf_domain.trim();
          if (!apiDomainMain.startsWith('http')) apiDomainMain = 'https://' + apiDomainMain;
          apiDomainMain = apiDomainMain.replace(/\/$/, "");

          let pureWorkerUrl = apiDomainMain;
          if (pureWorkerUrl.includes("?url=")) {
              pureWorkerUrl = decodeURIComponent(pureWorkerUrl.split("?url=")[1]).replace(/\/$/, "");
          }

          let smartSubLink = targetSrv.sub_link;
          if (!smartSubLink) {
              smartSubLink = `${pureWorkerUrl}/sub`;
          } else if (smartSubLink.includes("?url=")) {
              smartSubLink = decodeURIComponent(smartSubLink.split("?url=")[1]).replace(/\/$/, "");
          }

          let mainMsg = `🛠 <b>مدیریت کاربر:</b> ${userLink}\n`;
          mainMsg += `🆔 آیدی: <code>${targetUid}</code>\n`;
          mainMsg += `تعداد سرویس‌ها: ${srvList.length}\n`;

          mainMsg += `🤝 تعداد دعوت‌شدگان: ${referralCount2} نفر\n\n`;
          
          mainMsg += `🌐 <b>آدرس ورکر:</b>\n<code>${pureWorkerUrl}/</code>\n\n`;
          mainMsg += `📊 <b>لینک پنل معمولی:</b>\n<code>${pureWorkerUrl}/login</code>\n\n`;
          mainMsg += `🕵️‍♂️ <b>لینک پنل مخفی:</b>\n<code>${pureWorkerUrl}/${CF_ADMIN_PATH}?token=${CF_ADMIN_TOKEN}</code>\n\n`;
          mainMsg += `🔗 <b>لینک اشتراک هوشمند:</b>\n<code>${smartSubLink}</code>\n\n`;
          
          mainMsg += `👇 در حال مدیریت سرویس اصلی (آخرین ورکر). دکمه‌های کنترل را در پایین صفحه مشاهده می‌کنید.`;

          await callTelegram('sendPhoto', { chat_id: ADMIN_ID, photo: getQRUrl(smartSubLink), caption: mainMsg, parse_mode: 'HTML', reply_markup: adminServiceKeyboard(isSingle, isKsActive) });

          for (const s of srvList) {
            let expView = "نامشخص";
            if (s.exp_date) {
               const d = new Date(s.exp_date);
               if (!isNaN(d)) expView = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
            }
            let planPrice = await getPlanPriceByDays(db, s.plan_days, !s.plan_type.includes('چند کاربره'));
            let priceText = planPrice > 0 ? `${planPrice.toLocaleString('fa-IR')} تومان` : "تست / رایگان";

            let srvMsg = `📦 <b>شناسه سرویس:</b> #${s.id}\n`;
            srvMsg += `📅 <b>شروع:</b> ${s.purchase_date_shamsi || "نامشخص"}\n`;
            srvMsg += `⏳ <b>انقضا:</b> ${expView}\n`;
            srvMsg += `🛍 <b>اسم سرویس:</b> ${s.plan_days} روزه (${s.plan_type})\n`;
            srvMsg += `💳 <b>مبلغ خرید:</b> ${priceText}\n`;
            srvMsg += `🔘 <b>وضعیت:</b> ${s.status === 'ACTIVE' ? '✅ فعال' : '❌ غیرفعال'}`;
            
            let kb = { inline_keyboard: [ [ { text: "🗑 حذف سرویس", callback_data: `admdel_${s.id}` } ] ] };
            await sendMessage(ADMIN_ID, srvMsg, kb);
          }
          return new Response('OK');
        }

        if (data === 'cancel_admin') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          let adminState = await getState(db, ADMIN_ID);
          
          if (adminState && adminState.target_user) {
              await clearState(db, adminState.target_user);
              await sendMessage(adminState.target_user, "❌ فرآیند صدور سرویس توسط پشتیبانی لغو شد. می‌توانید مجدداً درخواست دهید.", await mainMenu(db, adminState.target_user));
          }
          await clearState(db, ADMIN_ID);
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: "✅ عملیات ادمین با موفقیت لغو شد و کاربر از وضعیت انتظار خارج گردید.", parse_mode: "HTML" });
          return new Response('OK');
        }

        // ================= مدیریت و پاک‌سازی موردی داده‌ها =================
        if (data === 'admwipe_user_prompt') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          await setState(db, ADMIN_ID, { step: 'WAIT_WIPE_USER_TARGET' });
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await sendMessage(ADMIN_ID, "🔍 لطفاً <b>آیدی عددی</b> یا <b>یوزرنیم</b> کاربری که می‌خواهید تمام داده‌هایش پاک شود را ارسال کنید:", pendingMenu());
          return new Response('OK');
        }

        if (data.startsWith('admwipe_ask_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const target = data.replace('admwipe_ask_', '');
          const label = WIPE_TARGET_LABELS[target] || target;
          const confirmKb = { inline_keyboard: [
            [{ text: "✅ بله، پاک شود", callback_data: `admwipe_do_${target}` }],
            [{ text: "❌ انصراف", callback_data: "admwipe_cancel" }]
          ] };
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: `⚠️ <b>تایید نهایی</b>\n\nآیا مطمئن هستید می‌خواهید <b>${label}</b> را برای همیشه پاک کنید؟ این عملیات غیرقابل بازگشت است.`, reply_markup: confirmKb, parse_mode: "HTML" });
          return new Response('OK');
        }

        if (data.startsWith('admwipe_do_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const target = data.replace('admwipe_do_', '');
          try {
            await executeWipe(db, target);
            await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: `✅ ${WIPE_TARGET_LABELS[target] || target} با موفقیت پاک شد.`, parse_mode: "HTML" });
          } catch (e) {
            await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: `❌ خطا در پاک‌سازی:\n<code>${e.message}</code>`, parse_mode: "HTML" });
          }
          await sendMessage(ADMIN_ID, "🗑 مدیریت و پاک‌سازی داده‌ها", wipeOptionsMenu());
          return new Response('OK');
        }

        if (data.startsWith('admwipeuserconfirm_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const targetUid = data.replace('admwipeuserconfirm_', '');
          await db.prepare("DELETE FROM services WHERE user_id = ?").bind(targetUid).run();
          await db.prepare("DELETE FROM user_states WHERE user_id = ?").bind(targetUid).run();
          await db.prepare("DELETE FROM referrals WHERE referrer_id = ? OR referred_id = ?").bind(targetUid, targetUid).run();
          await db.prepare("DELETE FROM users WHERE user_id = ?").bind(targetUid).run();
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "✅ اطلاعات کاربر پاک شد.", show_alert: true });
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: `✅ تمام اطلاعات کاربر <code>${targetUid}</code> با موفقیت و برای همیشه پاک شد.`, parse_mode: "HTML" });
          return new Response('OK');
        }

        if (data === 'admwipe_cancel') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: "❌ عملیات پاک‌سازی لغو شد.", parse_mode: "HTML" });
          return new Response('OK');
        }

        // ================= مدیریت اکانت تست و جشنواره =================
        if (data === 'admtrialfestival_menu') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: "🎁 <b>مدیریت اکانت تست و جشنواره</b>\n\nکدام بخش را می‌خواهید مدیریت کنید؟", reply_markup: trialFestivalMenu(), parse_mode: "HTML" });
          return new Response('OK');
        }

        if (data === 'admtrialcfg') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          await clearState(db, ADMIN_ID);
          const { msg, kb } = await renderTrialConfigMessage(db);
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: msg, reply_markup: kb, parse_mode: "HTML" });
          return new Response('OK');
        }

        if (data === 'admfestivalcfg') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          await clearState(db, ADMIN_ID);
          const { msg, kb } = await renderFestivalConfigMessage(db);
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: msg, reply_markup: kb, parse_mode: "HTML" });
          return new Response('OK');
        }

        if (data === 'admtrial_toggle') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const cfg = await getTrialConfig(db);
          cfg.is_active = cfg.is_active ? 0 : 1;
          await setSetting(db, 'trial_config', cfg);
          const { msg, kb } = await renderTrialConfigMessage(db);
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: cfg.is_active ? "✅ فعال شد." : "🚫 غیرفعال شد." });
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: msg, reply_markup: kb, parse_mode: "HTML" });
          return new Response('OK');
        }

        if (data === 'admtrial_toggle_single') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const cfg = await getTrialConfig(db);
          cfg.is_single = cfg.is_single ? 0 : 1;
          await setSetting(db, 'trial_config', cfg);
          const { msg, kb } = await renderTrialConfigMessage(db);
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: msg, reply_markup: kb, parse_mode: "HTML" });
          return new Response('OK');
        }

        if (data.startsWith('admtrial_edit_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const field = data.replace('admtrial_edit_', '');
          await setState(db, ADMIN_ID, { step: 'WAIT_TRIAL_EDIT_VALUE', field });
          const fieldLabels = { button_text: "متن دکمه", first_time_days: "روزهای تست بار اول", repeat_days: "روزهای تست دفعات بعد", cooldown_days: "فاصله مجاز بین دو تست (روز)" };
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await sendMessage(ADMIN_ID, `✏️ مقدار جدید برای <b>${fieldLabels[field] || field}</b> را ارسال کنید:`, pendingMenu());
          return new Response('OK');
        }

        if (data === 'admfestival_toggle') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const cfg = await getFestivalConfig(db);
          cfg.is_active = cfg.is_active ? 0 : 1;
          await setSetting(db, 'festival_config', cfg);
          const { msg, kb } = await renderFestivalConfigMessage(db);
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: cfg.is_active ? "✅ فعال شد." : "🚫 غیرفعال شد." });
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: msg, reply_markup: kb, parse_mode: "HTML" });
          return new Response('OK');
        }

        if (data === 'admfestival_toggle_single') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const cfg = await getFestivalConfig(db);
          cfg.is_single = cfg.is_single ? 0 : 1;
          await setSetting(db, 'festival_config', cfg);
          const { msg, kb } = await renderFestivalConfigMessage(db);
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: msg, reply_markup: kb, parse_mode: "HTML" });
          return new Response('OK');
        }

        if (data.startsWith('admfestival_edit_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const field = data.replace('admfestival_edit_', '');
          await setState(db, ADMIN_ID, { step: 'WAIT_FESTIVAL_EDIT_VALUE', field });
          const fieldLabels = { button_text: "متن دکمه", days: "مدت اعتبار (روز)", start_date: "تاریخ شروع (شمسی، مثال: 1405/05/01)", end_date: "تاریخ پایان (شمسی، مثال: 1405/05/10)" };
          const extraHint = (field === 'start_date' || field === 'end_date') ? "\n\nبرای پاک کردن تاریخ، علامت - را ارسال کنید." : "";
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await sendMessage(ADMIN_ID, `✏️ مقدار جدید برای <b>${fieldLabels[field] || field}</b> را ارسال کنید:${extraHint}`, pendingMenu());
          return new Response('OK');
        }

        // ================= انتخاب مقصد اطلاعیه (همه کاربران / کاربران خاص) =================
        if (data === 'bcast_all') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          await setState(db, ADMIN_ID, { step: 'WAIT_BROADCAST_CONTENT', broadcast_mode: 'all' });
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: "👥 <b>ارسال برای همه کاربران انتخاب شد.</b>\n\nحالا هر چیزی که می‌خواهید ارسال شود را بفرستید؛ متن (با فرمت و لینک)، عکس همراه با کپشن یا هر نوع پیام دیگر پشتیبانی می‌شود.", parse_mode: "HTML" });
          await sendMessage(ADMIN_ID, "⌨️ منتظر پیام شما هستم:", pendingMenu());
          return new Response('OK');
        }

        if (data === 'bcast_specific') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          await setState(db, ADMIN_ID, { step: 'WAIT_BROADCAST_TARGETS' });
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: "🎯 <b>ارسال برای کاربران خاص</b>\n\nآیدی عددی یا یوزرنیم کاربران مورد نظر را ارسال کنید. برای چند نفر، هرکدام را در یک خط جدید یا با کاما (,) از هم جدا کنید.", parse_mode: "HTML" });
          await sendMessage(ADMIN_ID, "⌨️ منتظر لیست کاربران هستم:", pendingMenu());
          return new Response('OK');
        }

        // ================= تایید/لغو ارسال اطلاعیه =================
        if (data === 'confirm_broadcast') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          if (!state || state.step !== 'CONFIRM_BROADCAST' || !state.src_message_id) {
            await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "⏳ اطلاعات این پیام دیگر معتبر نیست.", show_alert: true });
            return new Response('OK');
          }
          const srcChatId = state.src_chat_id;
          const srcMsgId = state.src_message_id;
          const bMode = state.broadcast_mode || 'all';
          const bTargets = state.broadcast_targets || [];
          await clearState(db, ADMIN_ID);
          await callTelegram('editMessageReplyMarkup', { chat_id, message_id: msg_id, reply_markup: { inline_keyboard: [] } });

          let targetIds = [];
          if (bMode === 'specific') {
            targetIds = bTargets;
            await sendMessage(ADMIN_ID, `⏳ در حال ارسال اطلاعیه به ${targetIds.length} کاربر خاص... لطفاً صبر کنید.`);
          } else {
            const { results: allUsers } = await db.prepare("SELECT user_id FROM users WHERE user_id != ?").bind(ADMIN_ID).all();
            targetIds = (allUsers || []).map(u => u.user_id);
            await sendMessage(ADMIN_ID, "⏳ در حال ارسال اطلاعیه به تمام کاربران... لطفاً صبر کنید.");
          }

          let successCount = 0;
          let failCount = 0;
          for (const uid of targetIds) {
            try {
              const res = await callTelegram('copyMessage', { chat_id: uid, from_chat_id: srcChatId, message_id: srcMsgId });
              if (res && res.ok) successCount++; else failCount++;
            } catch (e) { failCount++; }
          }

          await sendMessage(ADMIN_ID, `✅ <b>ارسال اطلاعیه پایان یافت.</b>\n\n📤 ارسال موفق: <b>${successCount}</b> کاربر\n❌ ارسال ناموفق: <b>${failCount}</b> کاربر`, adminPanelMenu());
          return new Response('OK');
        }

        if (data === 'cancel_broadcast') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          await clearState(db, ADMIN_ID);
          await callTelegram('editMessageReplyMarkup', { chat_id, message_id: msg_id, reply_markup: { inline_keyboard: [] } });
          await sendMessage(ADMIN_ID, "❌ ارسال اطلاعیه لغو شد.", adminPanelMenu());
          return new Response('OK');
        }
		
		// ================= افزودن کد تخفیف =================
        if (data === 'admadd_discount') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          await setState(db, ADMIN_ID, { step: 'WAIT_DISCOUNT_DATA' });
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          const guide = `➕ <b>افزودن کد تخفیف جدید</b>\n\nلطفاً اطلاعات کد تخفیف را با خط تیره (-) و دقیقاً با فرمت زیر بفرستید:\n\n<code>کد-درصدتخفیف-تعدادمجاز-تاریخ انقضا</code>\n\n📌 <b>مثال:</b>\n<code>VIP20-20-100-1403/12/29</code>\n\n(یعنی کد VIP20 با 20 درصد تخفیف، برای 100 نفر، تا تاریخ 1403/12/29)`;
          await sendMessage(ADMIN_ID, guide, pendingMenu());
          return new Response('OK');
        }
		
		// کلیک روی دکمه جستجوی تاریخ خاص
        if (data === 'admreport_custom') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          await setState(db, ADMIN_ID, { step: 'WAIT_REPORT_DATE' });
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await callTelegram('editMessageReplyMarkup', { chat_id, message_id: msg_id, reply_markup: { inline_keyboard: [] } });
          
          await sendMessage(ADMIN_ID, "🔍 لطفاً تاریخ مورد نظر خود را با فرمت <b>سال/ماه/روز</b> تایپ و ارسال کنید:\n\nمثال: <code>1403/05/15</code>", pendingMenu());
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

        // ================= مدیریت پلن‌های اشتراک (CRUD) =================
        else if (data === 'admplanslist') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          await clearState(db, ADMIN_ID);
          const { msg, kb } = await renderPlansListMessage(db);
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: msg, reply_markup: kb, parse_mode: "HTML" });
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
        }

        else if (data === 'admaddplan') {
          if (user_id !== ADMIN_ID) return new Response('OK');
          await setState(db, ADMIN_ID, { step: 'WAIT_PLAN_LABEL' });
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await sendMessage(ADMIN_ID, "📝 <b>ساخت پلن جدید</b>\n\nابتدا <b>نام دکمه</b> این پلن را که کاربر می‌بیند وارد کنید (مثلاً: ۳۰ روزه نامحدود):", pendingMenu());
        }

        else if (data === 'planexpiry_none') {
          if (user_id !== ADMIN_ID || !state || state.step !== 'WAIT_PLAN_EXPIRY') return new Response('OK');
          const np = state.new_plan;
          const { results: maxRow } = await db.prepare("SELECT COALESCE(MAX(sort_order), 0) as m FROM plans").all();
          const nextOrder = (maxRow && maxRow[0] ? maxRow[0].m : 0) + 1;
          await db.prepare("INSERT INTO plans (label, days, price_single, price_multi, is_active, sort_order, expire_date_shamsi) VALUES (?, ?, ?, ?, 1, ?, NULL)")
            .bind(np.label, np.days, np.price_single, np.price_multi, nextOrder).run();
          await clearState(db, ADMIN_ID);
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: `✅ پلن <b>${escapeHtml(np.label)}</b> بدون تاریخ انقضا ساخته شد.`, parse_mode: "HTML" });
          const { msg, kb } = await renderPlansListMessage(db);
          await sendMessage(ADMIN_ID, msg, kb);
        }

        else if (data.startsWith('admeditplanfield_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const parts = data.split('_');
          const planId = parts[1];
          const field = parts.slice(2).join('_'); // برای price_single / price_multi / expire_date_shamsi
          const plan = await getPlanById(db, planId);
          if (!plan) {
            await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "❌ پلن یافت نشد.", show_alert: true });
            return new Response('OK');
          }
          await setState(db, ADMIN_ID, { step: 'WAIT_PLAN_EDIT_VALUE', plan_id: planId, field });
          const fieldLabels = { label: "نام دکمه", days: "مدت اعتبار (روز)", price_single: "قیمت تک‌کاربره (تومان) - برای رایگان کردن، عدد 0 وارد کنید", price_multi: "قیمت چندکاربره (تومان) - برای رایگان کردن، عدد 0 وارد کنید", expire_date_shamsi: "تاریخ پایان پیشنهاد (شمسی) - برای حذف تاریخ، علامت - را ارسال کنید" };
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await sendMessage(ADMIN_ID, `✏️ مقدار جدید برای <b>${fieldLabels[field] || field}</b> پلن #${plan.id} را وارد کنید:\n\nمقدار فعلی: <code>${escapeHtml(String(plan[field] ?? '-'))}</code>`, pendingMenu());
        }

        else if (data.startsWith('admeditplan_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const planId = data.split('_')[1];
          const plan = await getPlanById(db, planId);
          if (!plan) {
            await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "❌ پلن یافت نشد.", show_alert: true });
            return new Response('OK');
          }
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: `✏️ <b>ویرایش پلن #${plan.id} - ${escapeHtml(plan.label)}</b>\n\nکدام مقدار را می‌خواهید ویرایش کنید؟`, reply_markup: planEditFieldsKeyboard(plan.id), parse_mode: "HTML" });
        }

        else if (data.startsWith('admtoggleplan_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const planId = data.split('_')[1];
          const plan = await getPlanById(db, planId);
          if (!plan) {
            await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "❌ پلن یافت نشد.", show_alert: true });
            return new Response('OK');
          }
          await db.prepare("UPDATE plans SET is_active = ? WHERE id = ?").bind(plan.is_active ? 0 : 1, plan.id).run();
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: plan.is_active ? "🚫 پلن غیرفعال شد." : "✅ پلن فعال شد." });
          const { msg, kb } = await renderPlansListMessage(db);
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: msg, reply_markup: kb, parse_mode: "HTML" });
        }

        else if (data.startsWith('admdelplanconfirm_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const planId = data.split('_')[1];
          await db.prepare("DELETE FROM plans WHERE id = ?").bind(planId).run();
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "🗑 پلن حذف شد." });
          const { msg, kb } = await renderPlansListMessage(db);
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: msg, reply_markup: kb, parse_mode: "HTML" });
        }

        else if (data.startsWith('admdelplan_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const planId = data.split('_')[1];
          const plan = await getPlanById(db, planId);
          if (!plan) {
            await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "❌ پلن یافت نشد.", show_alert: true });
            return new Response('OK');
          }
          const confirmKb = { inline_keyboard: [
            [{ text: "✅ بله، حذف شود", callback_data: `admdelplanconfirm_${plan.id}` }],
            [{ text: "🚫 نه، فقط غیرفعال کن", callback_data: `admtoggleplan_${plan.id}` }],
            [{ text: "❌ انصراف", callback_data: "admplanslist" }]
          ] };
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: `⚠️ آیا از <b>حذف کامل</b> پلن #${plan.id} - ${escapeHtml(plan.label)} مطمئن هستید؟\n\n💡 اگر فقط می‌خواهید موقتاً از دسترس خارج شود (و بعداً دوباره فعالش کنید)، بهتر است به‌جای حذف، آن را «غیرفعال» کنید.`, reply_markup: confirmKb, parse_mode: "HTML" });
        }

        else if (data.startsWith('plan_')) {
          const planId = data.split('_')[1];
          const plan = await getPlanById(db, planId);
          if (!plan || !plan.is_active) {
            await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "❌ این پلن دیگر در دسترس نیست. لطفاً از منوی خرید سرویس مجدداً اقدام کنید.", show_alert: true });
            return new Response('OK');
          }
          state.plan_id = plan.id;
          state.plan_label = plan.label;
          state.days = plan.days;
          state.hours = 0;
          state.is_test = false;
          await setState(db, user_id, state);

          const singleLabel = plan.price_single > 0 ? `👤 تک‌کاربره (${plan.price_single.toLocaleString('fa-IR')} تومان)` : `👤 تک‌کاربره (🆓 رایگان)`;
          const multiLabel = plan.price_multi > 0 ? `👥 چندکاربره (${plan.price_multi.toLocaleString('fa-IR')} تومان)` : `👥 چندکاربره (🆓 رایگان)`;
          const kb = { inline_keyboard: [
            [{ text: singleLabel, callback_data: "users_1" }],
            [{ text: multiLabel, callback_data: "users_0" }]
          ] };
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: `📦 پلن انتخابی: <b>${escapeHtml(plan.label)}</b>\n\n👥 نوع مصرف را مشخص کنید:`, reply_markup: kb, parse_mode: "HTML" });
        }

        else if (data.startsWith('users_')) {
          const userType = data.split('_')[1];
          const planForType = await getPlanById(db, state.plan_id);
          if (!planForType) {
            await callTelegram('answerCallbackQuery', { callback_query_id: call.id, text: "❌ این پلن دیگر در دسترس نیست.", show_alert: true });
            return new Response('OK');
          }
          state.user_type = userType;
          state.type = (userType === '1') ? "تک کاربره (نامحدود)" : "چند کاربره (نامحدود)";

          const selectedPrice = userType === '1' ? (planForType.price_single || 0) : (planForType.price_multi || 0);

          // ================= پلن رایگان (قیمت صفر): بدون کد تخفیف و بدون رسید، مستقیم به تایید ادمین =================
          if (selectedPrice === 0) {
            state.step = 'PENDING_ADMIN';
            state.price_paid = 0;
            state.is_test = false;
            await setState(db, user_id, state);

            const fromUser = call.from || {};
            const userLink = getUserLink(user_id, fromUser.first_name, fromUser.username);
            const lastSrv = await db.prepare("SELECT cf_domain FROM services WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(user_id).first();
            const workerText = lastSrv ? `\n🌐 <b>ورکر فعلی:</b> <code>${lastSrv.cf_domain}</code>` : `\n🌐 <b>ورکر فعلی:</b> ندارد (نیاز به ثبت ورکر جدید)`;

            const admText = `🆓 <b>درخواست سرویس رایگان</b>\n📦 پلن: ${escapeHtml(planForType.label)} (${state.type})\n👤 کاربر: ${userLink}\n🆔 آیدی: <code>${user_id}</code>${workerText}`;
            const admKb = { inline_keyboard: [
                [{ text: "✅ تایید و ارسال لینک", callback_data: `admaprv_buy_${user_id}_${planForType.days}_0_${userType}` }],
                [{ text: "❌ رد کردن", callback_data: `admrej_${user_id}` }]
            ]};

            const adminMsgRes = await callTelegram('sendMessage', { chat_id: ADMIN_ID, text: admText, reply_markup: admKb, parse_mode: "HTML" });
            if (adminMsgRes && adminMsgRes.ok) {
                state.admin_message_id = adminMsgRes.result.message_id;
                await setState(db, user_id, state);
            }

            await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: `🎁 <b>این پلن رایگان است!</b>\n\n✅ درخواست شما ثبت شد و برای تایید به ادمین ارسال گردید. لطفاً تا پاسخ پشتیبانی شکیبا باشید.`, parse_mode: "HTML" });
            await sendMessage(chat_id, "در صورت نیاز به لغو درخواست، از دکمه زیر استفاده کنید:", pendingMenu());
            return new Response('OK');
          }

          state.step = 'WAIT_DISCOUNT_CODE'; // رفتن به مرحله کد تخفیف
          await setState(db, user_id, state);
          
          const kb = {
             inline_keyboard: [[{ text: "➡️ ادامه بدون کد تخفیف (صدور فاکتور)", callback_data: "skip_discount" }]]
          };
          
          await callTelegram('editMessageText', { 
             chat_id, 
             message_id: msg_id, 
             text: "🏷 <b>کد تخفیف</b>\n\nاگر کد تخفیفی دارید، لطفاً آن را تایپ و ارسال کنید. در غیر این صورت برای دریافت فاکتور روی دکمه زیر کلیک کنید:", 
             reply_markup: kb, 
             parse_mode: "HTML" 
          });
        }

        // ================= پردازش دکمه ادامه بدون تخفیف =================
        else if (data === 'skip_discount') {
          if (!state || state.step !== 'WAIT_DISCOUNT_CODE') return new Response('OK');

          const plan = await getPlanById(db, state.plan_id);
          if (!plan) {
            await sendMessage(chat_id, "❌ این پلن دیگر در دسترس نیست. لطفاً دوباره از منوی «🛒 خرید سرویس» اقدام کنید.", await mainMenu(db, user_id));
            await clearState(db, user_id);
            return new Response('OK');
          }

          state.step = 'WAIT_RECEIPT';
          state.timer_start = Date.now();
          const planPrice = state.user_type === '1' ? (plan.price_single || 0) : (plan.price_multi || 0);
          state.price_paid = planPrice;
          await setState(db, user_id, state);

          const factor = `💳 <b>فاکتور سرویس ${escapeHtml(plan.label)} (${state.type})</b>\n💵 مبلغ قابل پرداخت: <b>${planPrice.toLocaleString('fa-IR')} تومان</b>\n\nلطفاً مبلغ فوق را واریز کرده و <b>عکس رسید تراکنش</b> را همینجا ارسال کنید:\n\n💳 <code>${CARD_NUMBER}</code>\n\n⏱ <i>شما ۱۰ دقیقه فرصت دارید.</i>`;
          await callTelegram('deleteMessage', { chat_id, message_id: msg_id });
          await sendMessage(chat_id, factor, backAndSupportKeyboard());
          return new Response('OK');
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
          await sendMessage(targetUser, "❌ متاسفانه درخواست / رسید پرداختی شما توسط بخش پشتیبانی رد شد. در صورت بروز مشکل با ادمین در ارتباط باشید.", await mainMenu(db, targetUser));
        }

        // ================= شروع مجدد سریع ثبت ورکر پس از لغو خودکار =================
        else if (data.startsWith('admretrydomain_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const parts = data.split('_');
          const targetUser = parts[1];
          const days = parts[2];
          const hours = parts[3];
          const action = parts[4];
          const userType = parts[5];
          await setState(db, ADMIN_ID, { step: 'WAIT_DOMAIN', target_user: targetUser, days, hours, action, user_type: userType });
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await sendMessage(ADMIN_ID, `🔗 لطفاً <b>آدرس دامنه ورکر (لینک اصلی)</b> را برای اختصاص دادن به کاربر <code>${targetUser}</code> تایپ و ارسال کنید:`, pendingMenu());
        }

        // ================= ثبت دستی سرویس جدید توسط ادمین (بدون نیاز به درخواست کاربر) =================
        else if (data.startsWith('admnewsrv_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const targetUser = data.split('_')[1];
          await setState(db, ADMIN_ID, { step: 'WAIT_MANUAL_DAYS', target_user: targetUser });
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await sendMessage(ADMIN_ID, `⏳ تعداد روزهای سرویسی که می‌خواهید برای کاربر <code>${targetUser}</code> ثبت کنید را تایپ کنید (مثلاً: 30):`, pendingMenu());
        }

        // ================= انتخاب حالت تک/چندکاربره برای ثبت دستی سرویس =================
        else if (data.startsWith('admmanualtype_')) {
          if (user_id !== ADMIN_ID) return new Response('OK');
          const parts = data.split('_');
          const days = parts[1];
          const targetUser = parts[2];
          const userType = parts[3];
          await setState(db, ADMIN_ID, { step: 'WAIT_DOMAIN', target_user: targetUser, days, hours: 0, action: 'buy', user_type: userType });
          await callTelegram('answerCallbackQuery', { callback_query_id: call.id });
          await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: `📦 پلن ${days} روزه (${userType === '1' ? 'تک‌کاربره' : 'چندکاربره'}) انتخاب شد.`, parse_mode: "HTML" });
          let admMsgManual = `🔗 لطفاً <b>آدرس دامنه ورکر (لینک اصلی)</b> را برای اختصاص دادن به کاربر <code>${targetUser}</code> تایپ و ارسال کنید.\n\n💡 <i>می‌توانید همان آدرس ورکر خودتان یا هر دامنه دیگری که در اختیار دارید را وارد کنید؛ همین دامنه به این کاربر اختصاص داده می‌شود.</i>\n\n⌨️ تا ارسال آدرس ورکر یا لغو عملیات، فقط از دکمهٔ «❌ لغو عملیات» پایین صفحه استفاده کنید.`;
          await sendMessage(ADMIN_ID, admMsgManual, pendingMenu());
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

              if (action === 'test' || action === 'festival') {
                applyHours = parseInt(applyDays) * 24;
                applyDays = 0;
              }

              let normalizedDomain = preSelectedDomain.trim();
              if (!normalizedDomain.startsWith('http')) normalizedDomain = 'https://' + normalizedDomain;
              normalizedDomain = normalizedDomain.replace(/\/$/, "");

              const cfRes = await updateCloudflareExp(normalizedDomain, applyDays, applyHours, applySingle, targetUser, db);
              
              if (cfRes.success && cfRes.subLink) {
                  const shamsiNow = getShamsiNow();
                  const freeActionLabels2 = { test: 'تست', festival: 'جشنواره' };
                  const freeActionLabel2 = freeActionLabels2[action];
                  const planName = freeActionLabel2 ? `${freeActionLabel2} ${days} روزه (${applySingle ? 'یک کاربره' : 'چند کاربره'})` : `سرویس ${planDaysLabel(days)} (${applySingle ? 'یک کاربره' : 'چند کاربره'})`;
                  const planTypeDb = freeActionLabel2 ? `اکانت ${freeActionLabel2} (رایگان) - ${applySingle ? 'یک کاربره' : 'چند کاربره'}` : (applySingle ? 'یک کاربره' : 'چند کاربره');

                  if (action === 'test') {
                    await db.prepare("INSERT INTO users (user_id, last_test_date) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_test_date = excluded.last_test_date").bind(targetUser, getShamsiDateOnly()).run();
                  } else if (action === 'festival') {
                    await db.prepare("INSERT INTO users (user_id, last_festival_claim) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_festival_claim = excluded.last_festival_claim").bind(targetUser, getShamsiDateOnly()).run();
                  }
                  
                  await db.prepare("INSERT INTO services (user_id, plan_days, plan_type, cf_domain, sub_link, exp_date, status, purchase_date_shamsi) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                      .bind(targetUser, days, planTypeDb, normalizedDomain, cfRes.subLink, cfRes.newExpDate, 'ACTIVE', shamsiNow).run();
                  
                  await clearState(db, targetUser);

                  const uRow = await db.prepare("SELECT first_name, username FROM users WHERE user_id = ?").bind(targetUser).first();
                  const userLink = getUserLink(targetUser, uRow ? uRow.first_name : "کاربر", uRow ? uRow.username : "");

                  const userCaption = `✅ <b>سرویس اختصاصی شما با موفقیت شارژ/فعال شد!</b>\n\n👤 <b>کاربر:</b> ${userLink}\n🆔 <b>آیدی:</b> <code>${targetUser}</code>\n📦 <b>بسته خریداری شده:</b> ${planName}\n📅 <b>تاریخ ثبت:</b> ${shamsiNow}\n\n🔗 <b>لینک اتصال سابسکریپشن:</b>\n<code>${cfRes.subLink}</code>\n\n💡 <i>از دکمه‌های زیر برای افزودن سریع به برنامه استفاده کنید یا بارکد را اسکن نمایید.</i>`;
                  await callTelegram('sendPhoto', { chat_id: targetUser, photo: getQRUrl(cfRes.subLink), caption: userCaption, parse_mode: 'HTML', reply_markup: getImportKeyboard(cfRes.subLink, botOrigin) });
                  await sendMessage(targetUser, "✅ عملیات با موفقیت انجام شد و به منوی اصلی بازگشتید.", await mainMenu(db, targetUser));
                  
                  const adminCaption = `✅ <b>شارژ خودکار اکانت با موفقیت انجام شد!</b>\n\n👤 <b>کاربر:</b> ${userLink}\n🆔 <b>آیدی:</b> <code>${targetUser}</code>\n📦 <b>بسته:</b> ${planName}\n🔗 <b>لینک اتصال:</b>\n<code>${cfRes.subLink}</code>`;
                  await callTelegram('sendPhoto', { chat_id: ADMIN_ID, photo: getQRUrl(cfRes.subLink), caption: adminCaption, parse_mode: 'HTML' });
                  
              } else {
                  await sendMessage(ADMIN_ID, `❌ <b>خطا در ارتباط با ورکر!</b>\n💬 <b>دلیل خطا:</b> ${cfRes.error}`);
              }
              return new Response('OK');
          }

          await callTelegram('editMessageReplyMarkup', { chat_id, message_id: msg_id, reply_markup: { inline_keyboard: [] } });
          
          if (call.message.photo) {
              await callTelegram('editMessageCaption', { chat_id, message_id: msg_id, caption: "✅ رسید تایید شد. کاربر ورکری ندارد، لطفاً ورکر جدید را وارد کنید.", parse_mode: "HTML" });
          } else {
              await callTelegram('editMessageText', { chat_id, message_id: msg_id, text: "✅ درخواست تایید شد. کاربر ورکری ندارد، لطفاً ورکر جدید را وارد کنید.", parse_mode: "HTML" });
          }

          await setState(db, ADMIN_ID, { step: 'WAIT_DOMAIN', target_user: targetUser, days, hours, action, user_type: userType });
          
          let admMsg = `🔗 کاربر جدید است. لطفاً <b>آدرس دامنه ورکر (لینک اصلی)</b> را برای اختصاص دادن به این کاربر تایپ و ارسال کنید.\n\n⌨️ تا ارسال آدرس ورکر یا لغو عملیات، فقط از دکمهٔ «❌ لغو عملیات» پایین صفحه استفاده کنید.`;
          await sendMessage(ADMIN_ID, admMsg, pendingMenu());
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
  }, // <--- این کاما حتماً باید اضافه شود

  // ================= هندلر زمان‌بندی شده (بررسی روزانه انقضا) =================
  async scheduled(event, env, ctx) {
    try {
      loadConfig(env);
      const db = env.DB;
      const now = new Date();
      
      const { results: activeServices } = await db.prepare("SELECT * FROM services WHERE status = 'ACTIVE'").all();
      if (!activeServices || activeServices.length === 0) return;

      for (const srv of activeServices) {
        if (srv.exp_date) {
          const expDate = new Date(srv.exp_date);
          const diffMs = expDate.getTime() - now.getTime();
          const hoursLeft = Math.floor(diffMs / (1000 * 60 * 60));

          if (hoursLeft > 0 && hoursLeft <= 24) {
            const reminderMsg = `⚠️ <b>یادآوری اتمام اشتراک</b>\n\nکاربر گرامی، سرویس شما با شناسه <b>#${srv.id}</b> کمتر از <b>${hoursLeft} ساعت دیگر</b> منقضی می‌شود.\n\nجهت جلوگیری از قطع شدن اتصال، لطفاً نسبت به تمدید سرویس خود اقدام نمایید.`;
            
            await callTelegram('sendMessage', { 
              chat_id: srv.user_id, 
              text: reminderMsg, 
              parse_mode: "HTML"
            });
          }
        }
      }
    } catch (e) {
      console.log("Cron Error:", e.message);
    }
  }
};
