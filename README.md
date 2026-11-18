# ⚡ Nyra

**A lightweight AI assistant for Telegram, powered by Cloudflare Workers.**

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020.svg)](https://workers.cloudflare.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6.svg)](src/index.ts)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

English · [فارسی](README.fa.md)

Nyra brings AI chat to Telegram with a lightweight serverless runtime. Built and maintained by **MHDLabs**.

## 🚀 Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MHDLabs/Nyra)

Create a bot with [@BotFather](https://t.me/BotFather), deploy it to Cloudflare, and complete the required setup prompts. Then open your bot and send `/start`.

> ℹ️ Nyra is being simplified around one centrally configured OpenAI-compatible model. See the [Product Scope](docs/PRODUCT-SCOPE.md) for the upcoming changes. The current runtime still contains the legacy setup flow.

## ✨ Features

- 💬 AI conversations with streaming replies
- 🧠 Per-user memory and customizable personalities
- 🌐 Built-in web search
- 👥 Private and group chats
- 🛠️ Telegram admin tools and a separate [web admin panel](/admin-panel)
- ☁️ Serverless deployment on Cloudflare Workers

## 🧰 Development

Requires Node.js 22.

~~~bash
npm ci
npm run typecheck
npm run test:all
./node_modules/.bin/wrangler deploy --dry-run
~~~

See [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) before contributing.

## 📄 License

[MIT](LICENSE) © MHDLabs

---

Made with ❤️ by **MHDLabs** · Keep it simple :)
