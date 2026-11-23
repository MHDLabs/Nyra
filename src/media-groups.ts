import type { NyraEnv } from "../types/env.js";
import type { TelegramMessage } from "../types/telegram.js";
import { processMessage } from "./handlers/message.js";

export const PHOTO_ALBUM_QUEUE_DELAY_SECONDS = 3;
export const PHOTO_ALBUM_DEBOUNCE_MS = 2_500;
export const PHOTO_ALBUM_LEASE_MS = 120_000;
export const MAX_PHOTO_ALBUM_ITEMS = 10;

export type PhotoAlbumFlush = {
  chat_id: string | number;
  media_group_id: string;
};

type WorkerCtx = { waitUntil?(promise: Promise<unknown>): void };

export function isTelegramPhotoAlbumMessage(message: TelegramMessage | undefined): boolean {
  return !!(
    message &&
    message.media_group_id &&
    Array.isArray(message.photo) &&
    message.photo.some((size) => !!size && typeof size.file_id === "string" && size.file_id.length > 0)
  );
}

function minimalStoredMessage(message: TelegramMessage): TelegramMessage {
  return {
    message_id: message.message_id,
    date: message.date,
    chat: message.chat,
    from: message.from,
    caption: message.caption,
    caption_entities: message.caption_entities,
    reply_to_message: message.reply_to_message,
    message_thread_id: message.message_thread_id,
    photo: message.photo,
    media_group_id: message.media_group_id
  };
}

/** Persist one album item and schedule a delayed flush before acknowledging the webhook. */
export async function enqueueTelegramPhotoAlbum(env: NyraEnv, message: TelegramMessage): Promise<void> {
  if (!isTelegramPhotoAlbumMessage(message) || !message.media_group_id) {
    throw new Error("Not a Telegram photo album message");
  }

  const chatId = message.chat.id;
  const mediaGroupId = message.media_group_id;
  const timestamp = Date.now();
  const stored = JSON.stringify(minimalStoredMessage(message));

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO telegram_media_groups (chat_id, media_group_id, updated_at, status, lease_until) VALUES (?, ?, ?, 'pending', 0) " +
      "ON CONFLICT(chat_id, media_group_id) DO UPDATE SET updated_at = excluded.updated_at, " +
      "status = CASE WHEN telegram_media_groups.status = 'processing' THEN 'processing' ELSE 'pending' END, " +
      "lease_until = CASE WHEN telegram_media_groups.status = 'processing' THEN telegram_media_groups.lease_until ELSE 0 END"
    ).bind(chatId, mediaGroupId, timestamp),
    env.DB.prepare(
      "INSERT OR IGNORE INTO telegram_media_group_items (chat_id, media_group_id, message_id, message_json, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(chatId, mediaGroupId, message.message_id, stored, timestamp)
  ]);

  await env.NYRA_QUEUE.send(
    { media_group_flush: { chat_id: chatId, media_group_id: mediaGroupId } },
    { delaySeconds: PHOTO_ALBUM_QUEUE_DELAY_SECONDS }
  );
}

/** Pure merge helper shared by the runtime and regression tests. */
export function buildTelegramPhotoAlbumMessage(messages: TelegramMessage[]): TelegramMessage | null {
  const sorted = messages
    .filter((message) => Array.isArray(message.photo) && message.photo.length > 0)
    .slice()
    .sort((a, b) => a.message_id - b.message_id);

  if (sorted.length === 0) return null;

  const first = sorted[0];
  const captionMessage = sorted.find((message) => typeof message.caption === "string" && message.caption.trim().length > 0);
  const replyMessage = sorted.find((message) => !!message.reply_to_message);
  const topicMessage = sorted.find((message) => message.message_thread_id !== undefined && message.message_thread_id !== null);
  const imageIds = Array.from(new Set(sorted.map((message) => {
    const sizes = message.photo || [];
    return sizes[sizes.length - 1]?.file_id || "";
  }).filter(Boolean))).slice(0, MAX_PHOTO_ALBUM_ITEMS);

  if (imageIds.length === 0) return null;

  return {
    ...first,
    ...(captionMessage ? {
      caption: captionMessage.caption,
      caption_entities: captionMessage.caption_entities
    } : {}),
    ...(replyMessage ? { reply_to_message: replyMessage.reply_to_message } : {}),
    ...(topicMessage ? { message_thread_id: topicMessage.message_thread_id } : {}),
    album_photo_file_ids: imageIds
  };
}

async function releasePhotoAlbumLease(env: NyraEnv, album: PhotoAlbumFlush): Promise<void> {
  await env.DB.prepare(
    "UPDATE telegram_media_groups SET status = 'pending', lease_until = 0 WHERE chat_id = ? AND media_group_id = ? AND status = 'processing'"
  ).bind(album.chat_id, album.media_group_id).run();
}

/**
 * Claim and process one stable album. A batch delete removes only the items
 * included in this turn; late-arriving items remain pending for their own
 * delayed marker instead of being silently discarded.
 */
export async function processTelegramPhotoAlbum(
  env: NyraEnv,
  ctx: WorkerCtx,
  album: PhotoAlbumFlush
): Promise<boolean> {
  if (!album || album.chat_id === undefined || !album.media_group_id) return false;

  const timestamp = Date.now();
  const claim = await env.DB.prepare(
    "UPDATE telegram_media_groups SET status = 'processing', lease_until = ? " +
    "WHERE chat_id = ? AND media_group_id = ? AND updated_at <= ? " +
    "AND (status = 'pending' OR (status = 'processing' AND lease_until <= ?))"
  ).bind(
    timestamp + PHOTO_ALBUM_LEASE_MS,
    album.chat_id,
    album.media_group_id,
    timestamp - PHOTO_ALBUM_DEBOUNCE_MS,
    timestamp
  ).run();

  if (!Number(claim.meta?.changes || 0)) return false;

  const selected = await env.DB.prepare(
    "SELECT message_id, message_json FROM telegram_media_group_items " +
    "WHERE chat_id = ? AND media_group_id = ? ORDER BY message_id ASC LIMIT ?"
  ).bind(album.chat_id, album.media_group_id, MAX_PHOTO_ALBUM_ITEMS).all();

  const rows = selected.results || [];
  const messages: TelegramMessage[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(String(row.message_json || ""));
      if (parsed && typeof parsed.message_id === "number" && parsed.chat && Array.isArray(parsed.photo)) {
        messages.push(parsed as TelegramMessage);
      }
    } catch (error) {
      console.error("Ignoring malformed stored photo-album item:", error instanceof Error ? error.message : String(error));
    }
  }

  const merged = buildTelegramPhotoAlbumMessage(messages);
  const messageIds = rows.map((row) => Number(row.message_id)).filter((id) => Number.isFinite(id));
  if (messageIds.length === 0) {
    await env.DB.prepare(
      "DELETE FROM telegram_media_groups WHERE chat_id = ? AND media_group_id = ?"
    ).bind(album.chat_id, album.media_group_id).run();
    return false;
  }

  try {
    if (merged) await processMessage(env, ctx, merged);

    const placeholders = messageIds.map(() => "?").join(", ");
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM telegram_media_group_items WHERE chat_id = ? AND media_group_id = ? AND message_id IN (" + placeholders + ")"
      ).bind(album.chat_id, album.media_group_id, ...messageIds),
      env.DB.prepare(
        "UPDATE telegram_media_groups SET status = 'pending', lease_until = 0 " +
        "WHERE chat_id = ? AND media_group_id = ? AND EXISTS (" +
        "SELECT 1 FROM telegram_media_group_items WHERE chat_id = ? AND media_group_id = ?)"
      ).bind(album.chat_id, album.media_group_id, album.chat_id, album.media_group_id),
      env.DB.prepare(
        "DELETE FROM telegram_media_groups WHERE chat_id = ? AND media_group_id = ? AND NOT EXISTS (" +
        "SELECT 1 FROM telegram_media_group_items WHERE chat_id = ? AND media_group_id = ?)"
      ).bind(album.chat_id, album.media_group_id, album.chat_id, album.media_group_id)
    ]);
    return !!merged;
  } catch (error) {
    await releasePhotoAlbumLease(env, album);
    throw error;
  }
}
