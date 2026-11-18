<div dir="rtl">

# ⚡ نیرا

**دستیار هوش مصنوعی سبک برای تلگرام، با قدرت Cloudflare Workers.**

<div dir="ltr">

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020.svg)](https://workers.cloudflare.com)
[![Runtime](https://img.shields.io/badge/Runtime-TypeScript-3178c6.svg)](src/index.ts)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

[English](README.md) · فارسی

---

نیرا گفتگوی هوش مصنوعی را به تلگرام می‌آورد؛ با زیرساختی سبک و بدون نیاز به سرور اختصاصی. ساخته و نگهداری‌شده توسط **MHDLabs**.

## 🚀 استقرار روی Cloudflare

<div dir="ltr">

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MHDLabs/Nyra)

</div>

Worker را مستقر کنید، اسرار موردنیاز را تنظیم کنید و ربات تلگرام خود را باز کنید. برای شروع دستور /start را بفرستید.

## ✨ امکانات

- 💬 گفتگوی هوش مصنوعی با پاسخ‌های جریانی
- 🧠 حافظهٔ شخصی و شخصیت‌های قابل تنظیم
- 🌐 جست‌وجوی داخلی وب
- 🖼️ درک تصویر، در صورت پشتیبانی مدل تنظیم‌شده
- 👥 گفتگوی خصوصی و گروهی
- 🛠️ ابزارهای مدیریت تلگرام و [پنل وب مدیریت](/admin-panel)
- ☁️ اجرای بدون سرور روی Cloudflare Workers

## 🧰 توسعه

نیازمند Node.js 22.

~~~bash
npm ci
npm run typecheck
npm run test:all
./node_modules/.bin/wrangler deploy --dry-run
~~~

[راهنمای عامل‌ها](AGENTS.md)، [راهنمای مشارکت](CONTRIBUTING.md) و [محدودهٔ محصول](docs/PRODUCT-SCOPE.md) را ببینید.

## 📄 مجوز

[MIT](LICENSE) © MHDLabs

---

ساخته‌شده با ❤️ توسط **MHDLabs** · Keep it simple :)
</div>
