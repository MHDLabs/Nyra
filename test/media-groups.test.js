import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PHOTO_ALBUM_ITEMS,
  buildTelegramPhotoAlbumMessage,
  isTelegramPhotoAlbumMessage
} from "../src/media-groups.js";

function photoMessage(message_id, file_id, extras = {}) {
  return {
    message_id,
    chat: { id: 100, type: "private" },
    from: { id: 200 },
    media_group_id: "album-1",
    photo: [{ file_id: file_id + "-small" }, { file_id }],
    ...extras
  };
}

test("photo album detection requires both a media_group_id and a usable photo", () => {
  assert.equal(isTelegramPhotoAlbumMessage(photoMessage(1, "photo-1")), true);
  assert.equal(isTelegramPhotoAlbumMessage({ ...photoMessage(1, "photo-1"), media_group_id: undefined }), false);
  assert.equal(isTelegramPhotoAlbumMessage({ ...photoMessage(1, "photo-1"), photo: [] }), false);
  assert.equal(isTelegramPhotoAlbumMessage(undefined), false);
});

test("album merge sorts messages, picks the best photo file ids and preserves caption/reply/topic", () => {
  const first = photoMessage(11, "file-2");
  const second = photoMessage(10, "file-1", {
    caption: "Describe all images",
    caption_entities: [{ type: "bold", offset: 0, length: 8 }],
    reply_to_message: { message_id: 4, chat: { id: 100, type: "private" }, text: "context" },
    message_thread_id: 44
  });

  const merged = buildTelegramPhotoAlbumMessage([first, second]);
  assert.ok(merged);
  assert.equal(merged.message_id, 10);
  assert.equal(merged.caption, "Describe all images");
  assert.deepEqual(merged.caption_entities, [{ type: "bold", offset: 0, length: 8 }]);
  assert.equal(merged.message_thread_id, 44);
  assert.equal(merged.reply_to_message.text, "context");
  assert.deepEqual(merged.album_photo_file_ids, ["file-1", "file-2"]);
});

test("album merge deduplicates file ids and caps the attachment count", () => {
  const messages = [];
  for (let i = 0; i < MAX_PHOTO_ALBUM_ITEMS + 3; i++) {
    messages.push(photoMessage(i + 1, i === 2 ? "same-file" : "photo-" + i));
  }
  messages.push(photoMessage(30, "same-file"));
  const merged = buildTelegramPhotoAlbumMessage(messages);
  assert.equal(merged.album_photo_file_ids.length, MAX_PHOTO_ALBUM_ITEMS);
  assert.equal(new Set(merged.album_photo_file_ids).size, MAX_PHOTO_ALBUM_ITEMS);
});

test("album merge returns null when there are no valid photo items", () => {
  assert.equal(buildTelegramPhotoAlbumMessage([{ message_id: 1, chat: { id: 1, type: "private" }, from: { id: 2 } }]), null);
});
