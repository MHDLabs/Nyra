// Command parsing: `/cmd@BotName arg1 arg2` -> { command, args }.
// Prefer Telegram `entities` (type bot_command) when present so offset/length
// are accurate; fall back to text splitting for older clients / tests.
// Deep-link payloads (`/start ref123`) land in `args`.

/**
 * Extract plain text from a message (body or caption).
 * @param {{ text?: string, caption?: string } | null | undefined} message
 */
export function getMessageText(message) {
  if (!message) return "";
  return String(message.text || message.caption || "").trim();
}

/**
 * Parse a bot command from a Telegram message or raw text.
 *
 * @param {string|{ text?: string, caption?: string, entities?: Array, caption_entities?: Array }} source
 *   Either the raw text string (legacy) or the full Message object.
 * @param {{ username?: string } | null} [identity] Bot identity for @username filter in groups.
 * @returns {{ command: string, args: string } | null}
 */
export function parseCommand(source, identity) {
  let text = "";
  let entities = null;

  if (typeof source === "string") {
    text = source;
  } else if (source && typeof source === "object") {
    text = source.text || source.caption || "";
    entities = source.entities || source.caption_entities || null;
  } else {
    return null;
  }

  if (!text || text.charAt(0) !== "/") return null;

  // Prefer entity-based parse (Bot API: type "bot_command").
  if (Array.isArray(entities) && entities.length) {
    for (let i = 0; i < entities.length; i++) {
      const ent = entities[i];
      if (!ent || ent.type !== "bot_command") continue;
      if (ent.offset !== 0) continue; // command must start the message
      const length = Number(ent.length) || 0;
      if (length < 2) continue;
      const raw = text.slice(ent.offset, ent.offset + length); // e.g. /start@MyBot
      const parsed = splitCommandToken(raw, identity);
      if (!parsed) return null;
      // Args = everything after the command entity (trim leading whitespace).
      const args = text.slice(ent.offset + length).replace(/^\s+/, "");
      return { command: parsed.command, args: args };
    }
  }

  // Fallback: whitespace split (no entities available).
  const parts = text.trim().split(/\s+/);
  const firstWord = parts[0] || "";
  const parsed = splitCommandToken(firstWord, identity);
  if (!parsed) return null;
  const args = parts.slice(1).join(" ");
  return { command: parsed.command, args: args };
}

/**
 * @param {string} token e.g. "/start" or "/start@MyBot"
 * @param {{ username?: string } | null} identity
 * @returns {{ command: string } | null}
 */
function splitCommandToken(token, identity) {
  if (!token || token.charAt(0) !== "/") return null;
  const atIdx = token.indexOf("@");
  let command = token.toLowerCase();
  if (atIdx !== -1) {
    const cmdName = token.slice(0, atIdx).toLowerCase();
    const targetUsername = token.slice(atIdx + 1);
    if (identity && identity.username) {
      if (targetUsername.toLowerCase() !== String(identity.username).toLowerCase()) {
        return null; // addressed to a different bot
      }
    }
    command = cmdName;
  }
  // Normalize: keep leading slash for callers that compare with "/start",
  // but most handlers strip it — both forms work via replace(/^\//, "").
  return { command: command };
}
