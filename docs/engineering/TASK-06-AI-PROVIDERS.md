# Task 6 — AI Providers, Streaming, Fallback

## Converted

All modules under `src/providers/` are TypeScript:

- `openai.ts`, `anthropic.ts`, `stream.ts`, `content.ts`
- `errors.ts` (category taxonomy aligned with `types/domain.ts`)
- `fallback.ts` (orchestration entry points)
- `models.ts`, `index.ts`

## Types

`types/ai.ts` defines:

- `AIConnection`, `ChatMessage`, `ProviderUsage`
- `StreamEvent` discriminated union
- `ProviderRequestOptions`

## Behavior

No intentional change to retry policy, tool loops, or Workers AI fallback. Single long attempt policy from earlier product work is preserved.

## Validation

```bash
npx tsc -p tsconfig.worker.json   # clean
npx tsx --test test/*.test.js     # 332 pass
```
