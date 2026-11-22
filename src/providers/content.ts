// Internal message content -> OpenAI-compatible chat-completions format.

/**
 * Internally a message's `content` is either a plain string or an array of
 * parts: { type: "text", text } and { type: "image", mediaType, data } where
 * `data` is base64 without a prefix. Images are stripped unless the central
 * model is explicitly configured as vision-capable.
 */
export function toOpenAIContent(content, allowImages) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  const parts: any[] = [];
  for (let i = 0; i < content.length; i++) {
    const p = content[i];
    if (!p) continue;
    if (p.type === "text") {
      if (p.text) parts.push({ type: "text", text: p.text });
      continue;
    }
    if (p.type === "image" && allowImages && p.data) {
      parts.push({ type: "image_url", image_url: { url: "data:" + (p.mediaType || "image/jpeg") + ";base64," + p.data } });
    }
  }
  if (parts.length === 0) return "";
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}
