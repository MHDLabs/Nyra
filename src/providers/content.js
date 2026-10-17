// Internal content -> provider wire shapes. The contract is documented on
// `toOpenAIContent` below; `toAnthropicContent` reshapes the same internal
// form for the Anthropic Messages API.


/**
 * Internally a message's `content` is either a plain string or an array of
 * parts: { type: "text", text } and { type: "image", mediaType, data } where
 * `data` is base64 without a prefix. Each provider needs its own wire shape, and
 * connections that are not marked as vision-capable get the images stripped so
 * they degrade to text instead of failing the request.
 */
export function toOpenAIContent(content, allowImages) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  const parts = [];
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

export function toAnthropicContent(content, allowImages) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (let i = 0; i < content.length; i++) {
    const p = content[i];
    if (!p) continue;
    if (p.type === "text") {
      if (p.text) parts.push({ type: "text", text: p.text });
      continue;
    }
    if (p.type === "image" && allowImages && p.data) {
      parts.push({ type: "image", source: { type: "base64", media_type: p.mediaType || "image/jpeg", data: p.data } });
    }
  }
  if (parts.length === 0) return "";
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}
