-- ================================================================
-- کمپین‌های اکانت رایگان/تست (کاملاً داینامیک و قابل مدیریت از داخل ربات)
-- ================================================================
-- برخلاف قبل که فقط یک دکمه ثابت «اکانت تست» با مقادیر هاردکد وجود داشت،
-- از این به بعد می‌توانید همزمان چند کمپین مستقل داشته باشید (مثلاً هم
-- «اکانت تست» عادی، هم یک کمپین جداگانه «جشنواره» با تنظیمات متفاوت) که
-- هرکدام دکمه/مدت عادی/مدت ویژه/سقف تکرار/تک یا چندکاربره بودن و
-- فعال یا غیرفعال بودن مستقل خودشان را دارند.

CREATE TABLE IF NOT EXISTS test_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,                          -- متن دکمه‌ای که کاربر در منو می‌بیند
    days INTEGER NOT NULL DEFAULT 1,               -- مدت اعتبار برای دفعات عادی (روز)
    first_time_days INTEGER NOT NULL DEFAULT 0,    -- مدت اعتبار ویژه برای کسانی که اولین‌بار کلا وارد ربات شده‌اند (۰ = بدون تفاوت با days)
    cooldown_days INTEGER NOT NULL DEFAULT 30,     -- حداقل فاصله لازم بین دو دریافت همین کمپین توسط یک کاربر (روز)
    is_single INTEGER NOT NULL DEFAULT 1,          -- ۱=تک‌کاربره، ۰=چندکاربره
    is_active INTEGER NOT NULL DEFAULT 1,          -- ۱=فعال و قابل دریافت، ۰=غیرفعال (به‌جای حذف)
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- آخرین دریافتِ هر کاربر از هر کمپین؛ چون هر کمپین سقف تکرار جدای خودش را دارد
-- (مثلاً «تست» ماهی یک‌بار ولی «جشنواره» هفتگی)، این ردیابی جدا از جدول users نگه داشته می‌شود.
CREATE TABLE IF NOT EXISTS test_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    test_plan_id INTEGER NOT NULL,
    last_claim_shamsi TEXT,
    claim_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, test_plan_id)
);

-- پرچم دائمیِ «آیا این کاربر تا حالا، در کل عمر حسابش، از هیچ کمپین رایگان/تستی استفاده کرده یا نه».
-- این پرچم فقط یک‌بار (در اولین دریافت هدیه) روشن می‌شود و هیچ‌وقت خاموش نمی‌شود، حتی سال‌ها بعد؛
-- مستقل از cooldown هر کمپین است و صرفاً برای تشخیص «بار اول کلا وارد ربات شدن» استفاده می‌شود.
ALTER TABLE users ADD COLUMN first_gift_used INTEGER DEFAULT 0;

-- کمپین پیش‌فرض «اکانت تست» دقیقاً با همان رفتار قبلی: بار اول ۲ روزه، دفعات بعد ۱ روزه،
-- سقف تکرار ماهی یک‌بار (۳۰ روز)، تک‌کاربره.
INSERT INTO test_plans (label, days, first_time_days, cooldown_days, is_single, is_active, sort_order) VALUES
    ('🎁 دریافت اکانت رایگان (تست)', 1, 2, 30, 1, 1, 1);

-- انتقال داده‌های قبلی: کاربرانی که قبلاً حداقل یک‌بار از last_test_date استفاده کرده‌اند،
-- هم در test_claims برای کمپین پیش‌فرض بالا ثبت می‌شوند (تا cooldown‌شان درست محاسبه شود)
-- و هم پرچم first_gift_used آن‌ها ۱ می‌شود (تا دوباره هدیهٔ «بار اول» نگیرند).
INSERT INTO test_claims (user_id, test_plan_id, last_claim_shamsi, claim_count)
SELECT user_id, (SELECT id FROM test_plans WHERE sort_order = 1 LIMIT 1), last_test_date, 1
FROM users
WHERE last_test_date IS NOT NULL AND last_test_date != '';

UPDATE users SET first_gift_used = 1
WHERE last_test_date IS NOT NULL AND last_test_date != '';

-- ================================================================
-- نکته درباره «قیمت صفر»
-- ================================================================
-- از این به بعد، اگر قیمت تک‌کاربره یا چندکاربرهٔ یک پلن در جدول plans صفر
-- وارد شود، آن حالت دیگر «غیرفعال/مخفی» نیست بلکه «رایگان» است: دکمه‌اش با
-- برچسب «رایگان» نمایش داده می‌شود و کاربر بدون نیاز به کد تخفیف/رسید،
-- مستقیم برای تایید و تحویل به ادمین ارسال می‌شود (دقیقاً مثل اکانت تست).
-- این تغییر در کد index.js اعمال شده و نیازی به تغییر ساختار جدول plans ندارد.
