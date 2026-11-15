# Task 9 — Frontend, Mini App and Admin Surfaces

## Server surfaces

- `src/miniapp/**` and `src/admin-panel/**` remain TypeScript sources bundled by Wrangler.
- Shared contracts: `types/miniapp.ts` (`MiniAppUser`, `MiniAppAuthContext`, `PanelSession`).
- Progressive `// @ts-nocheck` retained on these routers until handler arity/options are fully annotated (Task 10).

## Browser shell

- `public/app.js`, `public/index.html`, `public/styles.css` are the served Mini App assets (no bundler step today).
- `web-src/telegram-webapp.d.ts` provides Telegram WebApp ambient types for a future `app.ts` port.
- `tsconfig.web.json` typechecks `web-src/**`.

## Behavior

No intentional UI/behavior change. Liquid Glass styles and admin panel routes unchanged.

## Validation

```bash
npx tsc -p tsconfig.worker.json   # clean
npx tsc -p tsconfig.web.json      # clean
npx tsx --test test/*.test.js     # 332 pass
```
