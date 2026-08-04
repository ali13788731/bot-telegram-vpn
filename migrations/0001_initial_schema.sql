-- جدول کاربران ربات
CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY, 
    username TEXT,
    first_name TEXT,
    last_test_date TEXT, 
    join_date_shamsi TEXT
);

-- جدول تاریخچه سرویس‌ها و اکانت‌ها
CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT, 
    user_id INTEGER, 
    plan_days INTEGER, 
    plan_type TEXT, 
    cf_domain TEXT, 
    sub_link TEXT, 
    exp_date TEXT, 
    status TEXT, 
    purchase_date_shamsi TEXT
);

-- جدول ذخیره دامنه‌های ادمین
CREATE TABLE IF NOT EXISTS admin_domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT, 
    domain TEXT UNIQUE
);

-- جدول مدیریت وضعیت‌های کاربران در محیط Serverless
CREATE TABLE IF NOT EXISTS user_states (
    user_id INTEGER PRIMARY KEY, 
    state_data TEXT, 
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- جدول مدیریت کدهای تخفیف
CREATE TABLE IF NOT EXISTS discounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,
    percent INTEGER,
    max_uses INTEGER,
    used_count INTEGER DEFAULT 0,
    expire_date_shamsi TEXT
);

-- جدول ثبت دعوت دوستان (رفرال)
CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER,
    referred_id INTEGER UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
