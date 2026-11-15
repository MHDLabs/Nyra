/**
 * AI provider contracts: stream events, connection shape, tool calls.
 */
import type { ProviderErrorCategory, ProviderKind, TelegramId } from "./domain.js";

export type AIConnection = {
  connection_id: string;
  telegram_id?: TelegramId | null;
  label?: string | null;
  provider?: string | null;
  base_url?: string | null;
  model?: string | null;
  encrypted_key?: string | null;
  key_iv?: string | null;
  is_global?: number | boolean | null;
  is_fast?: number | boolean | null;
  supports_vision?: number | boolean | null;
  supports_tools?: number | boolean | null;
  enabled?: number | boolean | null;
  consecutive_failures?: number | null;
  [key: string]: unknown;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool" | string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
};

export type ProviderUsage = {
  in?: number;
  out?: number;
  source?: string;
  cost?: number;
};

export type StreamEvent =
  | { type: "text"; text: string }
  | {
      type: "done";
      connection?: AIConnection | null;
      attempts?: number;
      fallbackUsed?: boolean;
      usage?: ProviderUsage | null;
    }
  | {
      type: "error";
      category: ProviderErrorCategory;
      partial?: boolean;
      error?: unknown;
      message?: string;
      connection?: AIConnection | null;
      attempts?: number;
      fallbackUsed?: boolean;
    }
  | { type: "tool_calls"; tool_calls: unknown[] }
  | { type: string; [key: string]: unknown };

export type ProviderRequestOptions = {
  max_tokens?: number;
  temperature?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  totalBudgetMs?: number;
  stallTimeoutMs?: number;
  signal?: AbortSignal;
  [key: string]: unknown;
};
