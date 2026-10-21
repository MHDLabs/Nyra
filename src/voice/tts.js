// Text-to-speech via Microsoft Edge's online read-aloud service.
//
// This is an *optional* feature behind `EDGE_TTS_ENABLED`. Two hard rules:
//   1. a failed synthesis never blocks, delays, or degrades the text reply;
//   2. the service is undocumented, so an unavailable endpoint is reported as
//      unavailable — never claimed to work.
//
// Protocol (the same one the Edge browser uses): connect to the read-aloud
// WebSocket, send a `speech.config` frame, send an SSML `ssml` frame, then
// collect `audio` binary frames until the terminating `turn.end` text frame.
import { EDGE_TTS_URL, EDGE_TTS_TIMEOUT_MS, EDGE_TTS_MAX_CHARS } from "../config.js";

const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Strip characters that break SSML and bound the length. */
export function sanitizeForSpeech(text) {
  const clean = String(text || "")
    // Markdown that would otherwise be read aloud as punctuation.
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~#>]+/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.slice(0, EDGE_TTS_MAX_CHARS);
}

function buildSsml(text, voice) {
  return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    "<voice name='" + escapeXml(voice) + "'>" + escapeXml(text) + "</voice></speak>";
}

/**
 * Synthesize speech. Returns `{ ok: true, audio: Uint8Array, contentType }` or
 * `{ ok: false, reason }`. Never throws.
 *
 * `reason` is one of: `disabled`, `unsupported`, `empty_text`,
 * `socket_unavailable`, `timeout`, `no_audio`, `service_error`.
 */
export async function synthesizeSpeech(env, text, voice) {
  const clean = sanitizeForSpeech(text);
  if (!clean) return { ok: false, reason: "empty_text" };
  if (typeof WebSocket === "undefined") return { ok: false, reason: "unsupported" };
  const chosenVoice = voice || "en-US-AriaNeural";

  let socket;
  try {
    socket = new WebSocket(EDGE_TTS_URL);
  } catch (err) {
    return { ok: false, reason: "socket_unavailable" };
  }

  return await new Promise(function (resolve) {
    let settled = false;
    let opened = false;
    const chunks = [];
    const timer = setTimeout(function () {
      finish({ ok: false, reason: "timeout" });
    }, EDGE_TTS_TIMEOUT_MS);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch (e) { /* already closed */ }
      resolve(result);
    }

    socket.addEventListener("open", function () {
      opened = true;
      const requestId = crypto.randomUUID().replace(/-/g, "");
      const timestamp = new Date().toISOString();
      try {
        socket.send(
          "X-Timestamp:" + timestamp + "\r\n" +
          "Content-Type:application/json; charset=utf-8\r\n" +
          "Path:speech.config\r\n\r\n" +
          JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" }, outputFormat: OUTPUT_FORMAT } } } })
        );
        socket.send(
          "X-RequestId:" + requestId + "\r\n" +
          "Content-Type:application/ssml+xml\r\n" +
          "X-Timestamp:" + timestamp + "Z\r\n" +
          "Path:ssml\r\n\r\n" +
          buildSsml(clean, chosenVoice)
        );
      } catch (err) {
        finish({ ok: false, reason: "socket_unavailable" });
      }
    });

    socket.addEventListener("message", function (event) {
      if (settled) return;
      const data = event.data;
      if (typeof data === "string") {
        // Binary audio arrives in separate binary frames; the text frames are
        // control messages, and `turn.end` terminates the utterance.
        if (data.indexOf("Path:turn.end") !== -1) {
          if (chunks.length === 0) return finish({ ok: false, reason: "no_audio" });
          const total = chunks.reduce(function (sum, chunk) { return sum + chunk.length; }, 0);
          const audio = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length; }
          return finish({ ok: true, audio, contentType: "audio/mpeg" });
        }
        return;
      }
      // Binary frame: first two bytes are the big-endian header length, and the
      // header is followed by the raw MP3 payload.
      const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer || data);
      if (buffer.length < 2) return;
      const headerLength = (buffer[0] << 8) | buffer[1];
      const start = 2 + headerLength;
      if (buffer.length <= start) return;
      chunks.push(buffer.subarray(start));
    });

    socket.addEventListener("error", function () {
      finish({ ok: false, reason: opened ? "service_error" : "socket_unavailable" });
    });

    socket.addEventListener("close", function () {
      if (!settled) finish({ ok: false, reason: opened ? "no_audio" : "socket_unavailable" });
    });
  });
}

/** TTS is opt-in per deployment; a missing setting means off. */
export async function isTtsEnabled(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'tts_enabled'").first();
    return !!(row && (row.value === "1" || row.value === "true"));
  } catch (err) {
    return false;
  }
}
