# Task 8 — Reminders, Time Zones, Parsing and Scheduling

## Types

`types/reminders.ts`:

- `ReminderParseResult`, `ReminderRecord`, `ReminderRecurrence`
- `ZonedParts`, `ResolveLocalResult`

## Modules

| File | Notes |
|------|--------|
| `tz.ts` | Typed `zonedParts` / `isValidTimeZone`; pure Intl-based zone math |
| `jalali.ts` | Unchanged behavior; TS source |
| `schedule.ts` | Recurrence normalize + advance; null-safe weekday |
| `parse.ts` | Progressive (large pure parser); public API via types |
| `commands.ts` | Progressive; depends on Telegram helpers |
| `format.ts` / `deliver.ts` / `schedules/deliver.ts` | Progressive |

## Behavior

No intentional change to parse rules, DST handling, or delivery cadence.

## Validation

```bash
npx tsc -p tsconfig.worker.json   # clean
npx tsx --test test/*.test.js     # 332 pass
```
