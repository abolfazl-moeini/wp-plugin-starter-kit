# دستورالعمل استاندارد استقرار پلاگین پروداکشن (SOP)

## پیشگیری از درخت ناقص هنگام جایگزینی ZIP (In-Place Unzip Race)

**هدف:** هیچ درخواست PHP نباید درخت **نیمه‌استخراج‌شده** پلاگین را ببیند. این سند «downtime صفر» یا «۱۰۰٪ کد ۲۰۰ هنگام دو rename» را ادعا نمی‌کند.

علت Fatal لحظه‌ای `require(): Failed opening required .../src/FrameworkClosure/functions-closure.php` در `autoload_real.php` این است که `vendor/autoload.php` روی دیسک می‌نشیند قبل از اینکه هدف `autoload.files` نوشته شود. دفاع اصلی استخراج کامل در پوشهٔ هم‌جوار و سپس دو `rename` است. ترتیب مدخل ZIP فقط دفاع مکمل است.

---

## ۱. چرا استخراج روی پوشهٔ زنده خطرناک است

خطای مشاهده‌شده:

```text
Fatal error: require(): Failed opening required
'/home/sitetavangary/tavangary/public/new/wp-content/plugins/tavangary-core/vendor/composer/../../src/FrameworkClosure/functions-closure.php'
in .../vendor/composer/autoload_real.php on line 41
```

اگر ZIP مستقیماً روی `wp-content/plugins/tavangary-core` باز شود:

1. اتولودر کامپوزر (`vendor/autoload.php` و `vendor/composer/autoload_real.php`) زودتر از `src/FrameworkClosure/functions-closure.php` روی دیسک می‌نشیند.
2. یک درخواست وب، کرون، یا صفحهٔ فعال‌سازی `vendor/autoload.php` را لود می‌کند.
3. `autoload_real.php` همان `require $file` سخت را اجرا می‌کند و Fatal می‌دهد.
4. چند ثانیه بعد unzip تمام می‌شود و درخواست بعدی سبز است.

### گارد `file_exists` دور `require` کامپوزر ممنوع است

پنهان‌کردن غیبت فایل با `if (file_exists) require` ضدالگوی **fail-open** است. اگر فایل واقعاً غایب باشد، فتال به «توابع تعریف‌نشده» یا TypeError بعدی تبدیل می‌شود. آرتیفکت خراب باید **fail-closed** بماند: deploy یا health رد شود.

---

## ۲. دستورالعمل استقرار دستی در سی‌پنل (cPanel File Manager)

> **قانون:** ZIP را هرگز داخل پوشهٔ زندهٔ پلاگین استخراج نکنید.

### مرحله ۱: آپلود آرتیفکت

فایل ZIP (مانند `tavangary-core-profile-s.zip`) را در `wp-content/plugins/` آپلود کنید؛ نه داخل `tavangary-core`.

### مرحله ۲: استخراج در پوشهٔ موقت هم‌جوار

1. در `wp-content/plugins/` پوشهٔ موقت بسازید، مثلاً `.deploy-staging`.
2. ZIP را داخل `.deploy-staging` اکسترکت کنید تا درخت کامل `tavangary-core/` شکل بگیرد.

وردپرس «Upload Plugin» هم اتمیک نیست (unzip در `upgrade/`، حذف پوشهٔ قدیم، کپی). همان روش sibling را ترجیح بدهید.

### مرحله ۳: چک‌لیست سلامت قبل از سوئیچ

روی درخت staging، وجود و غیرخالی بودن این فایل‌ها را بررسی کنید:

- [ ] `{slug}.php` (بوت‌استرپ؛ برای این پلاگین `tavangary-core.php`)
- [ ] `src/FrameworkClosure/functions-closure.php`
- [ ] `vendor/autoload.php`
- [ ] `vendor/composer/autoload_real.php`
- [ ] `artifact-manifest.json`

اگر `functions-closure.php` نیست، سوئیچ نکنید.

### مرحله ۴: دو rename پیاپی (هر کدام اتمیک؛ جفتشان یک syscall نیست)

1. `tavangary-core` ➔ `tavangary-core-old`
2. `.deploy-staging/tavangary-core` ➔ `tavangary-core`

بین این دو rename یک شکاف کوتاه هست که وردپرس پلاگین را «غیرموجود» می‌بیند. این با Fatal درخت ناقص فرق دارد و نباید «عملیات اتمیک صفر میلی‌ثانیه» نامیده شود.

### مرحله ۵: تأیید و در صورت امکان ریست OPcache

1. یک درخواست به `/wp-admin/` بزنید. اگر Fatal نبود ادامه دهید.
2. اگر کنترل‌پنل «Restart PHP» یا `opcache_reset()` دارد، کش بایت‌کد را بازنشانی کنید. OPcache علت **این** پیام `Failed opening` نیست، ولی کلاس‌های قدیمی را در حافظه نگه می‌دارد.

### مرحله ۶: پاک‌سازی

پس از تأیید: `tavangary-core-old` و ZIP آپلودشده را حذف کنید.

---

## ۳. استقرار با SSH / CLI

اسکریپت جدید در مسیر منسوخ `tavangary.new/tools/deploy-atomic.sh` ننویسید. همان `atomicDeployPlugin()` در `@wpdev/standalone-build` منبع حقیقت است. `deploy-standalone-plugin.mjs` فقط wrapper نازک همان تابع است.

از مسیر `wp-content`:

```bash
# Wrapper تانگاری: ZIP از قبل ساخته‌شده را sibling-staging می‌کند
node build-standalone.mjs --deploy-zip=/path/to/tavangary-core-profile-s.zip tavangary-core

# فراخوانی مستقیم موتور
node /Users/moeini/Documents/ideas/extend-kit/wp-starter-kit/packages/standalone-build/deploy-standalone-plugin.mjs \
  /path/to/tavangary-core-profile-s.zip tavangary-core \
  --plugins-dir=/path/to/wp-content/plugins
```

بیلد+دیپلوی از منبع (`--deploy --force --obfuscate`) مسیر جدا است و ZIP ازپیش‌ساخته را جایگزین نمی‌کند:

```bash
node build-standalone.mjs --targets=tavangary-core --obfuscate --force --deploy
```

### کارهایی که CLI انجام می‌دهد

1. قفل PID برای جلوگیری از دو استقرار هم‌زمان.
2. بررسی ریشهٔ منفرد ZIP و مانیفست.
3. استخراج کامل در sibling staging (نه روی پوشهٔ زنده).
4. preflight fail-closed: بوت‌استرپ غیرخالی، `functions-closure.php` برای مصرف‌کننده‌های فریم‌ورک، و هر هدف `autoload.files` با `php -l`.
5. دو `rename` + `fsync` روی پوشهٔ والد `plugins/`.
6. اگر verify بعد از سوئیچ شکست بخورد، backup برگردانده می‌شود.
7. پیش از حذف backup، چک سلامت معتبر از وب رانتایم (`--health-url`) انجام می‌شود.
8. `opcache_reset()` در CLI در حد best-effort برای CLI SAPI است و جایگزین Restart PHP در FPM/lsphp وب نیست.

---

## ۴. مدیریت درخواست‌های در حال اجرا و تخلیهٔ ترافیک (In-Flight Request Drain)

### سناریوی ریسک شکاف دو rename و late-include

دو `rename` پیاپی در حد چند میلی‌ثانیه بین حذف نام قدیم و نشستن نام جدید شکاف زمانی دارند. علاوه بر این:

1. درخواستی که **قبل از swap** شروع شده و اتولودر کامپوزر را لود کرده است، اگر پس از swap بخواهد کلاسی را با `require` دیرهنگام لود کند، ممکن است با فایل جدید یا غیبت فایل در لحظهٔ شکاف مواجه شده و Fatal بخورد.
2. ایجاد صرف فایل `.maintenance` وردپرس این خطر را برطرف نمی‌کند، زیرا درخواست‌هایی که از قبل وارد PHP شده‌اند همچنان تا انتها اجرا می‌شوند.

### راهکار استاندارد عملیاتی

1. **توقف ترافیک ورودی جدید (Traffic Pause / Ingress Gate):**
   - در لایهٔ وب‌سرور، Load Balancer، Cloudflare، یا Reverse Proxy (مانند Nginx)، ورود درخواست‌های جدید برای چند ثانیه متوقف یا با کد ۵۰۳ موقت معلق شود.
   - گیت ترافیک باید **کاملاً خارج از پوشهٔ پلاگینی** باشد که در حال جایگزینی است.
2. **تخلیهٔ درخواست‌های جاری (Drain):**
   - پیش از اجرای دو `rename`، به مدت ۲ تا ۵ ثانیه فرصت داده شود تا درخواست‌های وب و Workerهای جاری PHP-FPM که در حال اجرای کد قدیمی هستند به اتمام برسند.
   - سرویس‌های Background Worker و WP-Cron مرتبط در حین عملیات pause شوند.
3. **شفافیت در نبود مکانیزم Drain در هاست اشتراکی:**
   - اگر هاست امکان توقف ترافیک یا drain دقیق را فراهم نمی‌کند، این وضعیت باید تحت عنوان **«کاهش ریسک با downtime کنترل‌شده»** گزارش شود، نه ادعای غیرواقعی «تضمین صفر خطا یا صفر downtime».

---

## ۵. چک سلامت معتبر وب (Web Runtime Health Check) پیش از حذف Backup

پیش از اینکه دایرکتوری backup نسخهٔ قبلی حذف شود (`purgeBackup`):

1. **الزام اعتبارسنجی وب:** یک درخواست معتبر به آدرس مشخص وب رانتایم ارسال شود (`--health-url`).
2. **ناکافی بودن HTTP 200 ساده:**
   - پاسخ صرفاً به خاطر کد وضعیت ۲۰۰ پذیرفته نمی‌شود، زیرا ممکن است صفحهٔ لاگین وردپرس (`wp-login.php`)، صفحهٔ کش‌شدهٔ لبه (Edge Cache / CDN)، یا خطای صفحه سفید بدون هدر ۵۰۰ باشد.
   - محتوای بازگشتی نباید حاوی پیام‌های خطای وردپرس (`Fatal error`, `There has been a critical error on this website`) باشد.
   - در صورت استفاده از هدر اختصاصی سلامت (`X-WPDev-Health-Token`)، وجود توکن تأیید شود.
3. **شکست چک سلامت و Rollback:**
   - در صورت عدم موفقیت چک سلامت وب، سیستم باید فوراً fail-closed کرده، به backup قبلی بازگردد (Rollback)، و backup را به هیچ عنوان پاک نکند.

---

## ۶. تفکیک SAPI در OPcache و عدم کفایت دستور CLI

1. اجرای دستور `php -r "opcache_reset();"` در خط فرمان (CLI) فقط حافظهٔ کش **CLI SAPI** را پاک می‌کند و **هیچ تأثیری روی وب‌سرور و PHP-FPM یا LiteSpeed (lsphp)** ندارد، زیرا حافظهٔ اشتراکی (SHM) آن‌ها کاملاً تفکیک‌شده است.
2. ریست واقعی کش بایت‌کد وب باید از طریق:
   - ری‌لود یا ری‌استارت سرویس وب رانتایم (مثلاً `systemctl reload php-fpm` یا ابزار Restart PHP در cPanel).
   - یا ارسال سیگنال بازنشانی اختصاصی هاست انجام گیرد.
3. **ممنوعیت Endpoint عمومی:** هرگز فایل یا اندپوینت بدون احراز هویت وب برای فراخوانی `opcache_reset()` روی سایت ایجاد نکنید.
4. تنظیمات کلیدی محیط هاست مانند `opcache.validate_timestamps` و `opcache.revalidate_freq` باید همواره در لاگ گزارش استقرار ثبت شوند.

---

## ۷. تحلیل ریشه‌ای حادثهٔ پروداکشن (Root Cause Analysis - RCA)

1. علت فتال مشاهده‌شده در پروداکشن به عنوان **«فرضیهٔ سازگار با درخت ناقص در اثر استخراج درجا (In-Place Unzip)»** ثبت می‌شود.
2. تا زمان جمع‌آوری تمام لاگ‌های ثانیه‌ای، هشدارهای قبل از فتال، روش دقیق آپلود، هش واقعی ZIP نصب‌شده روی سرور و دسترسی‌های فایل، ادعای قطعیت ۱۰۰٪ ثبت نشود.
3. **توجه:** وجود یک فایل در فایل ZIP روی کامپیوتر توسعه‌دهنده به هیچ وجه اثبات نمی‌کند که درخت پوشه روی دیسک سرور در لحظهٔ اجرای درخواست کامل بوده است.

---

## ۸. Rollback فوری

### در File Manager

1. پوشهٔ جاری را به `tavangary-core-broken` تغییر نام دهید.
2. `tavangary-core-old` (یا نام توکن backup) را به `tavangary-core` برگردانید.

### در SSH / CLI

```bash
mv wp-content/plugins/tavangary-core wp-content/plugins/tavangary-core-broken && \
mv wp-content/plugins/tavangary-core-old wp-content/plugins/tavangary-core
```

---

## ۹. آنچه این SOP تضمین نمی‌کند

- ترتیب ZIP (closure قبل از `vendor/autoload.php`) جایگزین استخراج sibling نیست؛ unzip درجا ذاتاً ناامن می‌ماند.
- حذف `functions-closure.php` از `composer autoload.files` بدون تست سازگاری جداگانه.
- پچ کردن `autoload_real.php` تولیدشدهٔ Composer.
- سبز ماندن سایت اگر فایل اجباری از آرتیفکت غایب باشد.
- تضمین صفر خطا هنگام سوئیچ بدون توقف/drain ترافیک در هاست‌های بدون لود بالانسر.
