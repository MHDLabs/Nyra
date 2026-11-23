<div dir="ltr">

# ⚡ Nyra

**A lightweight AI assistant for Telegram, powered by Cloudflare Workers.**

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020.svg)](https://workers.cloudflare.com)
[![TypeScript](https://img.shields.io/badge/Runtime-TypeScript-3178c6.svg)](src/index.ts)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English · [فارسی](README.fa.md)

---

Nyra brings AI chat to Telegram with a simple serverless setup. Built and maintained by **MHDLabs**.

## 🚀 Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MHDLabs/Nyra)

Deploy your Worker, configure the required secrets and open your Telegram bot. Send /start to get going.

Configure the single shared model with `AI_MODEL` and the server-side `AI_API_KEY` secret. See the [configuration guide](docs/CONFIGURATION.md) for all required settings.

## ✨ Features

- 💬 AI conversations with streaming replies
- 🧠 Personal memory and customizable personalities
- 🌐 Built-in web search
- 🖼️ Image understanding and multi-image Telegram albums when supported by the configured model (up to 10 images)
- 📎 Text and source-code file analysis (up to 512 KiB)
- 👥 Private and group chats
- 🛠️ Telegram admin tools and a separate [web admin panel](/admin-panel)
- ☁️ Serverless runtime on Cloudflare Workers

## 🧰 Development

Requires Node.js 22.

~~~bash
npm ci
npm run typecheck
npm run test:all
./node_modules/.bin/wrangler deploy --dry-run
~~~

See [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [Product Scope](docs/PRODUCT-SCOPE.md).

## 📄 License

[MIT](LICENSE) © MHDLabs

---

Made with ❤️ by **MHDLabs** · Keep it simple :)
</div>
