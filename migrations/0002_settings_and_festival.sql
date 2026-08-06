-- جدول ذخیره تنظیمات پویای ربات (اکانت تست / جشنواره / پلن‌های اشتراک)
-- محتوای هر ردیف به‌صورت JSON در ستون value ذخیره می‌شود (کلید ثابت 'config')
CREATE TABLE IF NOT EXISTS bot_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- ستون جدید برای پیگیری آخرین دریافت هدیه جشنواره توسط هر کاربر (جدا از last_test_date)
ALTER TABLE users ADD COLUMN last_festival_claim TEXT;
