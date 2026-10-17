// Live model discovery and paginated model selection. Kept apart from the
// prompts because it performs network I/O (the provider's /models endpoint)
// and has its own pagination state.
import { MODELS_PER_PAGE } from "../config.js";
import { truncate, escapeHtml } from "../utils.js";
import { decryptCredential } from "../crypto.js";
import { sendMessage, editMessage, buildInlineKeyboard } from "../telegram.js";
import { setFlowState } from "../db.js";
import { humanizeError, fetchAvailableModels } from "../ai.js";
import { flowPromptCapabilities } from "./connection-prompts.js";

export function isEditStep(flowState) { return flowState.flowType === "edit"; }

export async function flowFetchModels(env, chatId, userId, flowState) {
  if (!flowState.encrypted_key || !flowState.base_url) { await sendMessage(env, chatId, "Set the Base URL and API key first before fetching models."); return; }
  await sendMessage(env, chatId, "Fetching models...");
  let apiKey;
  try { apiKey = await decryptCredential(env, userId, flowState.encrypted_key, flowState.key_iv); }
  catch (err) { await sendMessage(env, chatId, "Could not decrypt the API key. Re-enter it."); return; }
  const result = await fetchAvailableModels(flowState.provider, flowState.base_url, apiKey);
  if (result.error || !result.models || result.models.length === 0) {
    const msg = result.error ? ("⚠ Could not fetch models: <b>" + escapeHtml(result.error) + "</b>\n" + escapeHtml(humanizeError(result.error))) : "⚠ The provider returned no models. Enter the model name manually.";
    await sendMessage(env, chatId, msg, { parse_mode: "HTML" });
    return;
  }
  flowState.modelList = result.models.map(function (m) { return m.id; });
  flowState.modelPage = 0;
  await setFlowState(env, userId, flowState);
  await showModelPage(env, chatId, null, userId, flowState, 0);
}

export async function showModelPage(env, chatId, messageId, userId, flowState, page) {
  const list = flowState.modelList || [];
  const total = list.length;
  const pageSize = MODELS_PER_PAGE;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.max(0, Math.min(page, pageCount - 1));
  const start = safePage * pageSize;
  const end = Math.min(start + pageSize, total);
  const lines = ["<b>Choose a Model</b>", "", "Page " + (safePage + 1) + "/" + pageCount + " — " + total + " models"];
  const rows = [];
  for (let i = start; i < end; i++) {
    lines.push("• <code>" + escapeHtml(list[i]) + "</code>");
    rows.push([{ text: truncate(list[i], 60), callback_data: "flow:ms:" + i }]);
  }
  const nav = [];
  if (safePage > 0) nav.push({ text: "◀ Prev", callback_data: "flow:mp:" + (safePage - 1) });
  if (safePage < pageCount - 1) nav.push({ text: "Next ▶", callback_data: "flow:mp:" + (safePage + 1) });
  if (nav.length > 0) rows.push(nav);
  rows.push([{ text: "Enter Manually", callback_data: "flow:manual" }, { text: "Cancel", callback_data: "flow:cancel" }]);
  flowState.modelPage = safePage;
  await setFlowState(env, userId, flowState);
  await editMessage(env, chatId, messageId, lines.join("\n"), buildInlineKeyboard(rows), "HTML");
}

export async function flowSelectModel(env, chatId, userId, flowState, index) {
  const list = flowState.modelList || [];
  if (index < 0 || index >= list.length) { await sendMessage(env, chatId, "That model is no longer available. Fetch again."); return; }
  flowState.model = list[index];
  const isEdit = flowState.flowType === "edit";
  await flowPromptCapabilities(env, chatId, flowState, isEdit ? "edit_capabilities" : "capabilities");
  await setFlowState(env, userId, flowState);
}
