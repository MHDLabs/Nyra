// Live end-to-end check for the Edge TTS adapter. Not part of `npm test`
// because it needs outbound network access; run it manually:
//
//   node scripts/check-tts.mjs
//
// Prints PASS only when real audio bytes come back from the service.
import { synthesizeSpeech, sanitizeForSpeech } from "../src/voice/tts.js";

const text = process.argv[2] || "This is a Nyra text to speech verification run.";

console.log("WebSocket global:", typeof WebSocket);
console.log("sanitize:", JSON.stringify(sanitizeForSpeech("**bold** and `code` and [link](http://x)")));

const started = Date.now();
const result = await synthesizeSpeech({}, text, "en-US-AriaNeural");
const elapsed = Date.now() - started;

if (result.ok) {
  console.log("PASS  bytes=" + result.audio.length + "  elapsed=" + elapsed + "ms  type=" + result.contentType);
  // MP3 frames start with 0xFF 0xFx (or an ID3 tag).
  const head = Array.from(result.audio.slice(0, 4)).map(b => b.toString(16).padStart(2, "0")).join(" ");
  const isId3 = result.audio[0] === 0x49 && result.audio[1] === 0x44 && result.audio[2] === 0x33;
  const isMp3 = result.audio[0] === 0xff;
  console.log("head bytes:", head, " mp3-signature:", isMp3 || isId3);
  process.exit(isMp3 || isId3 ? 0 : 1);
} else {
  console.log("FAIL  reason=" + result.reason + "  elapsed=" + elapsed + "ms");
  process.exit(1);
}
