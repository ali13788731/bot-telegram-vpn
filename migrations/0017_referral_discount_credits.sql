-- شمارشگر کدهای تخفیفِ در دسترسِ هر کاربر (کسب‌شده از دعوت دوستان، هنوز تولید نشده)
ALTER TABLE users ADD COLUMN referral_credits INTEGER DEFAULT 0;

-- آیا به‌ازای این رکورد رفرال، اعتبار کد تخفیف به دعوت‌کننده اضافه شده است یا نه
ALTER TABLE referrals ADD COLUMN credit_awarded INTEGER DEFAULT 0;

-- مشخص می‌کند این کد تخفیف توسط کدام کاربر و از طریق سیستم دعوت دوستان تولید شده (برای کدهای دستی ادمین، NULL است)
ALTER TABLE discounts ADD COLUMN generated_by INTEGER;
