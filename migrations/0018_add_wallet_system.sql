-- سیستم کیف پول: موجودی هر کاربر و تاریخچه درخواست‌های شارژ کیف پول

-- موجودی فعلی کیف پول هر کاربر (به تومان)؛ فقط پس از تایید ادمین افزایش می‌یابد
ALTER TABLE users ADD COLUMN wallet_balance INTEGER DEFAULT 0;

-- درخواست‌های شارژ کیف پول (واریز کارت به کارت توسط کاربر و تایید/رد توسط ادمین)
CREATE TABLE IF NOT EXISTS wallet_charges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,             -- مبلغ درخواستی برای شارژ (تومان)
    status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | APPROVED | REJECTED
    receipt_file_id TEXT,                -- file_id عکس رسید ارسالی کاربر
    admin_message_id INTEGER,            -- شناسه پیام ارسالی به ادمین (برای ادیت پس از تصمیم)
    created_at_shamsi TEXT,
    decided_at_shamsi TEXT
);
