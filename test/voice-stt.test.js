import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isVoiceMessage, isVoiceTranscribable, getSttKey, transcribeVoice,
  withTranscript, pruneStaleTranscripts, pruneOldTranscripts, getTranscript
} from "../src/voice/stt.js";
import { STT_MAX_BYTES } from "../src/config.js";

function voice(over) {
  return Object.assign({ message_id: 10, voice: { file_id: "f1", file_size: 1024 } }, over || {});
}

/**
 * Minimal D1 stub for `voice_transcripts` plus the `thread_messages` read used
 * by the window prune. `INSERT OR IGNORE` returns changes:0 when the row already
 * exists — that is the at-most-once lock under test.
 */
function fakeEnv(opts) {
  const o = opts || {};
  const rows = new Map(); // `${chat}|${msg}` -> row
  const messages = o.messages || [];
  let fileCalls = 0;
  return {
    rows,
    get fileCalls() { return fileCalls; },
    TELEGRAM_BOT_TOKEN: o.token === undefined ? "t" : o.token,
    GROQ_API_KEY: o.key,
    DB: {
      prepare(sql) {
        const stmt = {
          _args: [],
          bind(...args) { stmt._args = args; return stmt; },
          async first() {
            if (sql.indexOf("FROM voice_transcripts") !== -1) {
              const row = rows.get(stmt._args[0] + "|" + stmt._args[1]);
              return row ? { transcript: row.transcript, status: row.status } : null;
            }
            return null;
          },
          async run() {
            const key = stmt._args[0] + "|" + stmt._args[1];
            if (sql.indexOf("INSERT OR IGNORE INTO voice_transcripts") !== -1) {
              if (rows.has(key)) return { meta: { changes: 0 } };
              rows.set(key, { transcript: null, status: "pending", created_at: stmt._args[2] });
              return { meta: { changes: 1 } };
            }
            if (sql.indexOf("UPDATE voice_transcripts SET transcript") !== -1) {
              // binds: (transcript, chat_id, message_id)
              const updateKey = stmt._args[1] + "|" + stmt._args[2];
              const row = rows.get(updateKey);
              if (row) { row.transcript = stmt._args[0]; row.status = "done"; }
              return { meta: { changes: row ? 1 : 0 } };
            }
            if (sql.indexOf("DELETE FROM voice_transcripts WHERE created_at <") !== -1) {
              const cutoff = stmt._args[0];
              let n = 0;
              for (const [k, v] of [...rows.entries()]) {
                if (v.created_at < cutoff) { rows.delete(k); n++; }
              }
              return { meta: { changes: n } };
            }
            if (sql.indexOf("DELETE FROM voice_transcripts WHERE chat_id") !== -1) {
              rows.delete(key);
              return { meta: { changes: 1 } };
            }
            if (sql.indexOf("INSERT INTO voice_transcripts") !== -1 && sql.indexOf("ON CONFLICT") !== -1) {
              const row = rows.get(key) || {};
              row.status = "failed";
              row.error = stmt._args[2];
              rows.set(key, row);
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
          async all() {
            if (sql.indexOf("FROM thread_messages") !== -1) {
              const limit = stmt._args[2];
              const ids = messages.slice().sort((a, b) => b.message_id - a.message_id).slice(0, limit);
              return { results: ids.map(m => ({ message_id: m.message_id })) };
            }
            if (sql.indexOf("JOIN thread_messages") !== -1) {
              return { results: [...rows.keys()].map(k => ({ message_id: Number(k.split("|")[1]) })) };
            }
            return { results: [] };
          }
        };
        return stmt;
      }
    }
  };
}

/** Install fetch stubs for Telegram getFile + download and the Groq call. */
function stubNetwork(opts) {
  const o = opts || {};
  const calls = { groq: 0 };
  globalThis.fetch = async function (url, init) {
    if (String(url).indexOf("api.telegram.org/file/") !== -1) {
      if (o.downloadFails) return { ok: false, status: 404 };
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(64) };
    }
    if (String(url).indexOf("api.groq.com") !== -1) {
      calls.groq++;
      if (o.groqStatus && o.groqStatus !== 200) {
        return { ok: false, status: o.groqStatus, text: async () => "bad request" };
      }
      if (o.groqEmpty) return { ok: true, status: 200, text: async () => JSON.stringify({ text: "  " }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ text: o.transcript || "hello from voice" }) };
    }
    return { ok: false, status: 599 };
  };
  return calls;
}

test("only message.voice qualifies, not audio or video notes", () => {
  assert.equal(isVoiceMessage({ voice: { file_id: "a" } }), true);
  assert.equal(isVoiceMessage({ audio: { file_id: "a" } }), false);
  assert.equal(isVoiceMessage({ video_note: { file_id: "a" } }), false);
  assert.equal(isVoiceMessage({ document: { file_id: "a" } }), false);
  assert.equal(isVoiceMessage({ voice: { file_id: "" } }), false);
  assert.equal(isVoiceMessage(null), false);
});

test("eligibility: private always, group only when triggered, oversize never", () => {
  assert.equal(isVoiceTranscribable(voice(), false, false), true);
  assert.equal(isVoiceTranscribable(voice(), true, false), false, "untriggered group voice is ignored");
  assert.equal(isVoiceTranscribable(voice(), true, true), true);
  assert.equal(isVoiceTranscribable(voice({ voice: { file_id: "f", file_size: STT_MAX_BYTES + 1 } }), false, true), false);
  assert.equal(isVoiceTranscribable({ audio: { file_id: "f" } }, false, true), false);
});

test("getSttKey prefers GROQ_API_KEY then GROQ_STT_API_KEY, blank means absent", () => {
  assert.equal(getSttKey({ GROQ_API_KEY: " g1 " }), "g1");
  assert.equal(getSttKey({ GROQ_API_KEY: "  ", GROQ_STT_API_KEY: "g2" }), "g2");
  assert.equal(getSttKey({}), "");
  assert.equal(getSttKey(null), "");
});

test("withTranscript swaps the placeholder only when there is a transcript", () => {
  const base = "[photo]\n[user sent a voice message]";
  assert.equal(withTranscript(base, "hi"), '[photo]\n[transcribed voice message] "hi"');
  assert.equal(withTranscript(base, ""), base);
  assert.equal(withTranscript("no placeholder", "hi"), "no placeholder");
  assert.equal(withTranscript(null, "hi"), "");
});

test("no key configured reports not_configured and records the reason", async () => {
  const env = fakeEnv({ key: "" });
  const res = await transcribeVoice(env, 5, voice());
  assert.equal(res.ok, false);
  assert.equal(res.reason, "not_configured");
  assert.match(env.rows.get("5|10").error, /GROQ_API_KEY/);
});

test("transcribes once and serves the cached transcript afterwards", async () => {
  const env = fakeEnv({ key: "k" });
  let groqCalls = 0;
  globalThis.fetch = async function (url) {
    const u = String(url);
    if (u.indexOf("getFile") !== -1) {
      return { json: async () => ({ ok: true, result: { file_path: "voice/file_1.oga" } }) };
    }
    if (u.indexOf("api.telegram.org/file/") !== -1) {
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(16) };
    }
    if (u.indexOf("api.groq.com") !== -1) {
      groqCalls++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ text: "سلام دنیا" }) };
    }
    return { ok: false, status: 599, text: async () => "" };
  };
  const first = await transcribeVoice(env, 5, voice());
  const second = await transcribeVoice(env, 5, voice());
  assert.equal(first.ok, true);
  assert.equal(first.transcript, "سلام دنیا");
  assert.equal(second.ok, true);
  assert.equal(second.transcript, "سلام دنیا");
  assert.equal(groqCalls, 1, "the provider is called exactly once per message");
});

test("a concurrent duplicate loses the claim instead of calling the provider", async () => {
  const env = fakeEnv({ key: "k" });
  // Simulate a request that already owns the row.
  env.rows.set("5|10", { transcript: null, status: "pending", created_at: 0 });
  const calls = stubNetwork({});
  const res = await transcribeVoice(env, 5, voice());
  assert.equal(res.ok, false);
  assert.equal(res.reason, "in_progress");
  assert.equal(calls.groq, 0);
});

test("download failure degrades to a reason, never throws", async () => {
  const env = fakeEnv({ key: "k" });
  stubNetwork({ downloadFails: true });
  globalThis.fetch = async function (url) {
    if (String(url).indexOf("getFile") !== -1) return { json: async () => ({ ok: false }) };
    return { ok: false, status: 404 };
  };
  const res = await transcribeVoice(env, 5, voice());
  assert.equal(res.ok, false);
  assert.equal(res.reason, "download_failed");
  assert.equal(env.rows.get("5|10").status, "failed");
});

test("provider error is captured with status and does not throw", async () => {
  const env = fakeEnv({ key: "k" });
  globalThis.fetch = async function (url) {
    if (String(url).indexOf("getFile") !== -1) {
      return { json: async () => ({ ok: true, result: { file_path: "v.oga" } }) };
    }
    if (String(url).indexOf("api.telegram.org/file/") !== -1) {
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    }
    return { ok: false, status: 401, text: async () => "invalid api key" };
  };
  const res = await transcribeVoice(env, 5, voice());
  assert.equal(res.ok, false);
  assert.equal(res.reason, "provider_error");
  assert.match(env.rows.get("5|10").error, /401/);
});

test("an empty provider transcript counts as a failure, not a silent blank", async () => {
  const env = fakeEnv({ key: "k" });
  globalThis.fetch = async function (url) {
    if (String(url).indexOf("getFile") !== -1) {
      return { json: async () => ({ ok: true, result: { file_path: "v.oga" } }) };
    }
    if (String(url).indexOf("api.telegram.org/file/") !== -1) {
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ text: "   " }) };
  };
  const res = await transcribeVoice(env, 5, voice());
  assert.equal(res.ok, false);
  assert.equal(res.reason, "provider_error");
  assert.match(env.rows.get("5|10").error, /empty transcript/);
});

test("pruneStaleTranscripts drops transcripts outside the latest 20 messages", async () => {
  const messages = [];
  for (let i = 1; i <= 25; i++) messages.push({ message_id: i });
  const env = fakeEnv({ key: "k", messages });
  for (const id of [1, 5, 21, 25]) {
    env.rows.set("5|" + id, { transcript: "t", status: "done", created_at: 1 });
  }
  const removed = await pruneStaleTranscripts(env, 5, 0);
  assert.equal(removed, 2, "ids 1 and 5 fell out of the window");
  assert.equal(env.rows.has("5|21"), true);
  assert.equal(env.rows.has("5|25"), true);
  assert.equal(await getTranscript(env, 5, 1), null);
});

test("pruneOldTranscripts is a global safety net by age", async () => {
  const env = fakeEnv({ key: "k" });
  env.rows.set("1|1", { transcript: "old", status: "done", created_at: 1 });
  const now = Math.floor(Date.now() / 1000);
  env.rows.set("1|2", { transcript: "new", status: "done", created_at: now });
  const removed = await pruneOldTranscripts(env, 60);
  assert.equal(removed, 1);
  assert.equal(env.rows.has("1|1"), false);
  assert.equal(env.rows.has("1|2"), true);
});
