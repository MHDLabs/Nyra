/**
 * Central AI request and stream contracts.
 * Provider credentials remain private to the Worker and are never part of events.
 */
import type { ProviderErrorCategory } from "./domain.js";

export type CentralAIConnection = {
  label: "Central AI";
  provider: "openai-compatible";
  base_url: string;
  model: string;
  supports_vision: 0 | 1;
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
      connection?: CentralAIConnection | null;
      attempts?: number;
      usage?: ProviderUsage | null;
    }
  | {
      type: "error";
      category: ProviderErrorCategory;
      partial?: boolean;
      error?: unknown;
      message?: string;
      connection?: CentralAIConnection | null;
      attempts?: number;
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
