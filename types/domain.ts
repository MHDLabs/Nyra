/**
 * Shared domain literals and identifiers used across Worker modules.
 * Keep this free of runtime code so it can be imported from types-only paths.
 */

export type LocaleCode = "fa-IR" | "en-US";

export type MemoryMode = "normal" | "minimal" | "none";

export type ChatType = "private" | "group" | "supergroup" | "channel";

export type GroupChatMode = "enabled" | "disabled" | "admin_only";

export type PersonalityId = string;

/** Telegram user or chat id (bot API uses signed 64-bit integers). */
export type TelegramId = number;

/** Provider error categories aligned with src/providers/errors.js */
export type ProviderErrorCategory =
  | "invalid_key"
  | "forbidden"
  | "model_not_found"
  | "rate_limited"
  | "quota_exceeded"
  | "daily_quota_exceeded"
  | "provider_overloaded"
  | "timeout"
  | "network_error"
  | "server_error"
  | "unexpected_format"
  | "empty_response"
  | "invalid_base_url"
  | "invalid_configuration"
  | "unknown";

export type OnboardingStep =
  | "language"
  | "name"
  | "personality"
  | "custom_intro"
  | "done";
