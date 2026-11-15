/**
 * D1 row shapes for Nyra tables.
 * Column nullability matches schema.js + additive ALTERs.
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
  fallback_enabled: number | null;
  msg_counter: number | null;
  coding_mode: number | null;
  active_connection_id: string | null;
  active_route_id: string | null;
  timezone: string | null;
  last_inbound_at: number | null;
  created_at: number | null;
  last_seen_at: number | null;
  updated_at: number | null;
  onboarding_version: number | null;
  custom_intro: string | null;
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

export type ConnectionRow = {
  id: string;
  telegram_id: TelegramId | null;
  name: string | null;
  provider: string | null;
  base_url: string | null;
  api_key_enc: string | null;
  model: string | null;
  is_enabled: number | null;
  is_default: number | null;
  is_global: number | null;
  is_fast: number | null;
  supports_vision: number | null;
  supports_tools: number | null;
  is_public: number | null;
  admin_only: number | null;
  description: string | null;
  display_order: number | null;
  test_status: string | null;
  last_tested_at: number | null;
  created_at: number | null;
  updated_at: number | null;
};

export type RouteRow = {
  id: string;
  telegram_id: TelegramId | null;
  name: string | null;
  is_default: number | null;
  created_at: number | null;
  updated_at: number | null;
};

export type RouteModelRow = {
  id: number;
  route_id: string;
  model: string;
  is_default: number | null;
  display_order: number | null;
};

export type RouteTokenRow = {
  id: string;
  route_id: string;
  api_key_enc: string | null;
  is_primary: number | null;
  is_enabled: number | null;
  consecutive_failures: number | null;
  last_success_at: number | null;
  last_used_at: number | null;
  created_at: number | null;
  updated_at: number | null;
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

export type ReminderRow = {
  id: number;
  telegram_id: TelegramId;
  title: string | null;
  description: string | null;
  status: string;
  next_run_at: number | null;
  timezone: string | null;
  recurrence: string | null;
  claim_token: string | null;
  claim_expires_at: number | null;
  created_at: number | null;
  updated_at: number | null;
};

export type ScheduleRow = {
  id: number;
  telegram_id: TelegramId | null;
  chat_id: TelegramId | null;
  payload: string | null;
  status: string;
  next_run_at: number | null;
  claim_token: string | null;
  created_at: number | null;
};

export type BlockedUserRow = {
  telegram_id: TelegramId;
  blocked_at: number | null;
  created_at: number | null;
  reason: string | null;
};

export type VoiceTranscriptRow = {
  chat_id: TelegramId;
  message_id: number;
  transcript: string | null;
  status: string;
  error: string | null;
  created_at: number;
};

export type SharedServiceUsageRow = {
  telegram_id: TelegramId;
  date: string;
  requests_count: number;
  tokens_used: number;
};

export type FlowStateRow = {
  telegram_id: TelegramId;
  flow: string;
  state_json: string;
  updated_at: number;
};
