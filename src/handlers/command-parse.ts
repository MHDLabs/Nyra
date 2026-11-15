// Command parsing: `/cmd@BotName arg1 arg2` -> { command, args }.
// Prefer Telegram `entities` (type bot_command) when present so offset/length
// are accurate; fall back to text splitting for older clients / tests.
// Deep-link payloads (`/start ref123`) land in `args`.

export type MessageEntity = {
  type: string;
  offset: number;
  length: number;
};

export type CommandMessageSource = {
  text?: string;
  caption?: string;
  entities?: MessageEntity[];
  caption_entities?: MessageEntity[];
};

export type BotIdentity = {
  username?: string;
};

export type ParsedCommand = {
  command: string;
  args: string;
};

/**
 * Extract plain text from a message (body or caption).
 */
export function getMessageText(message: CommandMessageSource | null | undefined): string {
  if (!message) return "";
  return String(message.text || message.caption || "").trim();
}

/**
 * Parse a bot command from a Telegram message or raw text.
 */
export function parseCommand(
  source: string | CommandMessageSource | null | undefined,
  identity?: BotIdentity | null
): ParsedCommand | null {
  let text = "";
  let entities: MessageEntity[] | null = null;

  if (typeof source === "string") {
    text = source;
  } else if (source && typeof source === "object") {
    text = source.text || source.caption || "";
    entities = source.entities || source.caption_entities || null;
  } else {
    return null;
  }

  if (!text || text.charAt(0) !== "/") return null;

  if (Array.isArray(entities) && entities.length) {
    for (let i = 0; i < entities.length; i++) {
      const ent = entities[i];
      if (!ent || ent.type !== "bot_command") continue;
      if (ent.offset !== 0) continue;
      const length = Number(ent.length) || 0;
      if (length < 2) continue;
      const raw = text.slice(ent.offset, ent.offset + length);
      const parsed = splitCommandToken(raw, identity);
      if (!parsed) return null;
      const args = text.slice(ent.offset + length).replace(/^\s+/, "");
      return { command: parsed.command, args };
    }
  }

  const parts = text.trim().split(/\s+/);
  const firstWord = parts[0] || "";
  const parsed = splitCommandToken(firstWord, identity);
  if (!parsed) return null;
  const args = parts.slice(1).join(" ");
  return { command: parsed.command, args };
}

function splitCommandToken(
  token: string,
  identity?: BotIdentity | null
): { command: string } | null {
  if (!token || token.charAt(0) !== "/") return null;
  const atIdx = token.indexOf("@");
  let command = token.toLowerCase();
  if (atIdx !== -1) {
    const cmdName = token.slice(0, atIdx).toLowerCase();
    const targetUsername = token.slice(atIdx + 1);
    if (identity && identity.username) {
      if (targetUsername.toLowerCase() !== String(identity.username).toLowerCase()) {
        return null;
      }
    }
    command = cmdName;
  }
  return { command };
}
