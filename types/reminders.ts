/**
 * Reminder parsing and scheduling contracts.
 */
import type { TelegramId } from "./domain.js";

export type ReminderRecurrence = {
  every: number;
  bucket: "minute" | "hour" | "day" | "week" | "month" | "year" | string;
} | null;

export type ReminderParseResult = {
  ok: boolean;
  at: number | null;
  atSeconds?: number | null;
  title: string;
  description: string | null;
  recurrence: ReminderRecurrence;
  timezone: string | null;
  hadDate: boolean;
  hadTime: boolean;
  matched: string[];
  missing: string | null;
  error: string | null;
  partial?: Record<string, unknown> | null;
  dstAmbiguous?: boolean;
  ambiguous?: boolean;
  lang?: string | null;
};

export type ReminderRecord = {
  id: number;
  telegram_id: TelegramId;
  title: string;
  description?: string | null;
  due_at: number;
  timezone?: string | null;
  recurrence_every?: number | null;
  recurrence_bucket?: string | null;
  status?: string | null;
  created_at?: number | null;
  [key: string]: unknown;
};

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday?: number;
};

export type ResolveLocalResult =
  | { kind: "ok"; ms: number }
  | { kind: "ambiguous"; ms: number }
  | { kind: "skipped"; ms?: number }
  | { kind: "invalid"; ms?: number };
