/**
 * High-level application event shapes (queue / AI stream).
 * Refined further in Tasks 5–6 when runtime modules migrate.
 */
import type { ProviderErrorCategory, TelegramId } from "./domain.js";

export type QueueUpdatePayload = {
  update_id: number;
  /** Opaque Telegram Update JSON — validate before use. */
  update: unknown;
  received_at?: number;
};

export type StreamEvent =
  | { type: "text"; text: string }
  | {
      type: "done";
      attempts: number;
      fallbackUsed: boolean;
      connectionId?: string;
    }
  | {
      type: "error";
      category: ProviderErrorCategory;
      partial: boolean;
      message: string;
    };

export type CallbackAction =
  | { namespace: "set"; parts: string[] }
  | { namespace: "adm"; parts: string[] }
  | { namespace: "model"; parts: string[] }
  | { namespace: "pers"; parts: string[] }
  | { namespace: "unknown"; raw: string };

/** Minimal inbound message context used by domain logic. */
export type InboundContext = {
  chatId: TelegramId;
  userId: TelegramId;
  isGroup: boolean;
  messageId?: number;
  text?: string;
};
