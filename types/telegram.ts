/**
 * Telegram Bot API shapes used by Nyra (subset, structural).
 * Unknown extra fields are allowed via index signatures where needed.
 */
import type { TelegramId } from "./domain.js";

export type TelegramUser = {
  id: TelegramId;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type TelegramChat = {
  id: TelegramId;
  type: "private" | "group" | "supergroup" | "channel" | string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

export type MessageEntity = {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: TelegramUser;
  language?: string;
};

export type TelegramMessage = {
  message_id: number;
  date?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  entities?: MessageEntity[];
  caption_entities?: MessageEntity[];
  reply_to_message?: TelegramMessage;
  message_thread_id?: number;
  photo?: Array<{ file_id: string; file_unique_id?: string; width?: number; height?: number; file_size?: number }>;
  /** Internal field added after durable Telegram album aggregation; never sent back to Telegram. */
  album_photo_file_ids?: string[];
  voice?: { file_id: string; duration?: number; mime_type?: string };
  audio?: { file_id: string; duration?: number; mime_type?: string };
  video?: { file_id: string; duration?: number; mime_type?: string };
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  sticker?: { file_id: string; emoji?: string };
  animation?: { file_id: string };
  video_note?: { file_id: string };
  media_group_id?: string;
};

export type CallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
  chat_instance?: string;
  inline_message_id?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  callback_query?: CallbackQuery;
  my_chat_member?: unknown;
  chat_member?: unknown;
  chat_join_request?: unknown;
};

export type TelegramApiResponse<T = any> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
};

export type QueueUpdateMessage = {
  update_id: number;
  update: TelegramUpdate;
  enqueued_at?: number;
};
