-- جدول پلن‌های اشتراک (قابل مدیریت کامل از داخل ربات: افزودن/ویرایش/غیرفعال‌سازی/حذف)
CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,                    -- نام دکمه‌ای که کاربر می‌بیند
    days INTEGER NOT NULL,                  -- مدت اعتبار اشتراک (روز)
    price_single INTEGER NOT NULL DEFAULT 0, -- قیمت حالت تک‌کاربره (تومان)
    price_multi INTEGER NOT NULL DEFAULT 0,  -- قیمت حالت چندکاربره (تومان) - صفر یعنی این حالت غیرفعال است
    is_active INTEGER NOT NULL DEFAULT 1,   -- ۱=فعال و قابل خرید، ۰=غیرفعال (به‌جای حذف)
    sort_order INTEGER NOT NULL DEFAULT 0,  -- ترتیب نمایش در لیست خرید
    expire_date_shamsi TEXT,                -- تاریخ پایان اعتبار پلن به‌صورت پیشنهاد ویژه (اختیاری، NULL = بدون انقضا)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- انتقال پلن‌های ثابت قبلی به جدول جدید (همان قیمت‌های قبلی؛ چندکاربره = تک‌کاربره + ۲۰,۰۰۰ تومان مطابق منطق قبلی)
INSERT INTO plans (label, days, price_single, price_multi, is_active, sort_order) VALUES
    ('۱ روزه نامحدود', 1, 10000, 30000, 1, 1),
    ('۵ روزه نامحدود', 5, 30000, 50000, 1, 2),
    ('۱۰ روزه نامحدود', 10, 45000, 65000, 1, 3),
    ('۳۰ روزه نامحدود', 30, 100000, 120000, 1, 4),
    ('۶۰ روزه ویژه نامحدود', 60, 180000, 200000, 1, 5);
