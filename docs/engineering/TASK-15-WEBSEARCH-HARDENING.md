# Task 15 — Web Search Security & TypeScript Hardening

## Responsibilities

`src/websearch.ts` performs zero-key HTML search against DuckDuckGo and Bing,
normalizes titles/URLs/snippets, and returns a capped, deduplicated list for the
AI tool layer (`web_search` in `tools.ts`).

## Threat boundary

- Untrusted HTML from external engines.
- Untrusted URL schemes in extracted links (returned, never fetched).
- Response size and total search time bounds.

This module does **not** fetch result URLs (no SSRF surface for result links).

## Types

- `WebSearchSource`, `WebSearchItem`, `WebSearchResponse`
- Internal `RawSearchFields`
- Explicit `AbortSignal` / `Response` usage
- Discriminated handling of `Promise.allSettled` outcomes

## Resource limits (preserved)

| Limit | Value |
|-------|------:|
| Timeout | 7000 ms |
| Max results | 8 |
| Query | 300 chars |
| Title / URL / snippet | 200 / 1000 / 700 |
| HTML body | 2_000_000 chars |

Bodies are read via `readTextBounded` (stream when available; cancel on overflow).

## Tests

`test/websearch.test.js` is deterministic by default (mocked `fetch`). Live
network coverage runs only when `NYRA_WEBSEARCH_LIVE=1`.

Coverage includes URL scheme rejection, entity/tag stripping, DDG `uddg` and
plain links, Bing `a1` base64 redirects, engine merge/dedupe, single-engine
failure, dual failure, and oversize bodies.

## Coverage count

`@ts-nocheck` under `src/`: 57 → 56.

## Recommended next task

Progressive typing of `src/utils.ts` or security review of remaining high-risk
nocheck modules (`crypto`, webhook handlers) as separate scoped tasks.
