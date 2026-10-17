// Command parsing: `/cmd@BotName arg1 arg2` -> { command, args }, honouring
// the bot's own @username so a command addressed to a different bot in the
// same group is ignored rather than executed.


export function parseCommand(text, identity) {
  if (!text.startsWith("/")) return null;
  const parts = text.split(/\s+/);
  const firstWord = parts[0];
  const atIdx = firstWord.indexOf("@");
  let command = firstWord.toLowerCase();
  if (atIdx !== -1) {
    const cmdName = firstWord.slice(0, atIdx).toLowerCase();
    const targetUsername = firstWord.slice(atIdx + 1);
    if (identity && identity.username) {
      if (targetUsername.toLowerCase() !== identity.username.toLowerCase()) return null;
    }
    command = cmdName;
  }
  const args = parts.slice(1).join(" ");
  return { command: command, args: args };
}
