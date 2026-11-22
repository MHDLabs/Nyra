/**
 * D1 row shapes for the retained Nyra data model.
 * Retired provider, routing, reminder, schedule, and voice rows are intentionally absent.
 */
import type { MemoryMode, TelegramId } from "./domain.js";

export type UserRow = {
  telegram_id: TelegramId;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  language_code: string | null;
  locale: string | null;
  personality_id: string | null;
  memory_mode: MemoryMode | string | null;
  memory_data: string | null;
  usage_stats: string | null;
  msg_counter: number | null;
  coding_mode: number | null;
  timezone: string | null;
  created_at: number | null;
  last_seen_at: number | null;
  updated_at: number | null;
  onboarding_version: number | null;
  custom_intro: string | null;
  custom_instructions: string | null;
};

export type ChatRow = {
  chat_id: TelegramId;
  chat_type: string | null;
  title: string | null;
  mode: string | null;
  created_at: number | null;
  updated_at: number | null;
};

export type ThreadMessageRow = {
  id: number;
  chat_id: TelegramId;
  thread_id: number | null;
  role: string;
  content: string;
  created_at: number;
};

export type AppSettingRow = {
  key: string;
  value: string;
  updated_at: number;
  updated_by: number | null;
};

export type ChatLogRow = {
  id: number;
  chat_id: TelegramId;
  telegram_id: TelegramId | null;
  direction: string;
  content: string | null;
  media_type: string | null;
  message_id: number | null;
  created_at: number;
};

export type BlockedUserRow = {
  telegram_id: TelegramId;
  blocked_at: number | null;
  created_at: number | null;
  reason: string | null;
};

export type FlowStateRow = {
  telegram_id: TelegramId;
  flow: string;
  state_json: string;
  updated_at: number;
};
