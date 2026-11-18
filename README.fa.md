<div dir="rtl">

# ⚡ نیرا

**دستیار هوش مصنوعی سبک برای تلگرام، با قدرت Cloudflare Workers.**

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020.svg)](https://workers.cloudflare.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6.svg)](src/index.ts)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) · فارسی

نیرا تجربهٔ گفتگوی هوش مصنوعی را به تلگرام می‌آورد؛ با زیرساختی سبک و بدون نیاز به سرور اختصاصی. ساخته و نگهداری‌شده توسط **MHDLabs**.

## 🚀 استقرار روی Cloudflare

<div dir="ltr">

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MHDLabs/Nyra)

</div>

با [@BotFather](https://t.me/BotFather) یک ربات بسازید، آن را روی Cloudflare مستقر کنید و مراحل راه‌اندازی را انجام دهید. سپس ربات را باز کنید و دستور `/start` را بفرستید.

> ℹ️ نیرا در حال ساده‌سازی است تا از یک مدل سازگار با OpenAI و با تنظیم مرکزی استفاده کند. جزئیات در [سند محدودهٔ محصول](docs/PRODUCT-SCOPE.md) آمده است. کد اجرایی فعلی هنوز فلوِ تنظیمات قدیمی را دارد.

## ✨ امکانات

- 💬 گفتگوی هوش مصنوعی با پاسخ‌های جریانی
- 🧠 حافظهٔ اختصاصی کاربران و شخصیت‌های قابل تنظیم
- 🌐 جست‌وجوی داخلی وب
- 👥 گفتگوی خصوصی و گروهی
- 🛠️ ابزارهای مدیریت تلگرام و [پنل وب مدیریت](/admin-panel)
- ☁️ استقرار بدون سرور روی Cloudflare Workers

## 🧰 توسعه

نیازمند Node.js 22.

~~~bash
npm ci
npm run typecheck
npm run test:all
./node_modules/.bin/wrangler deploy --dry-run
~~~

پیش از مشارکت، [راهنمای عامل‌ها](AGENTS.md) و [راهنمای مشارکت](CONTRIBUTING.md) را بخوانید.

## 📄 مجوز

[MIT](LICENSE) © MHDLabs

---

ساخته‌شده با ❤️ توسط **MHDLabs** · Keep it simple :)
</div>
