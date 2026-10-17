// Every prompt and validation rule for the connection wizard. Each function
// renders one step, re-shows the persisted flow state, and re-displays the
// same step on invalid input rather than losing the user's progress.
import { MAX_LABEL_LENGTH, MAX_DESCRIPTION_LENGTH, OPENAI_DEFAULT_URL, ANTHROPIC_DEFAULT_URL } from "../config.js";
import { escapeHtml } from "../utils.js";
import { sendMessage, buildInlineKeyboard } from "../telegram.js";

export async function flowPromptLabel(env, chatId, currentLabel) {
  const msg = currentLabel
    ? "Send a new label, or press Skip to keep <b>" + escapeHtml(currentLabel) + "</b>. Max " + MAX_LABEL_LENGTH + " characters."
    : "Step 2/7: Send a short label for this connection. Max " + MAX_LABEL_LENGTH + " characters.";
  await sendMessage(env, chatId, msg, {
    parse_mode: "HTML",
    reply_markup: buildInlineKeyboard([[{ text: "Skip", callback_data: "flow:skip" }], [{ text: "Cancel", callback_data: "flow:cancel" }]])
  });
}

export async function flowPromptDescription(env, chatId, currentDesc) {
  const msg = currentDesc
    ? "Send a new description, or press Skip to keep <b>" + escapeHtml(currentDesc) + "</b>."
    : "Step 3/7: Send a short description. Max " + MAX_DESCRIPTION_LENGTH + " characters. Optional.";
  await sendMessage(env, chatId, msg, {
    parse_mode: "HTML",
    reply_markup: buildInlineKeyboard([[{ text: "Skip", callback_data: "flow:skip" }], [{ text: "Cancel", callback_data: "flow:cancel" }]])
  });
}

export async function flowPromptBaseUrl(env, chatId, provider, currentUrl) {
  const defaultUrl = provider === "anthropic" ? ANTHROPIC_DEFAULT_URL : OPENAI_DEFAULT_URL;
  const current = currentUrl || defaultUrl;
  await sendMessage(env, chatId, "Step 4/7: Send the Base URL, or press Default.\n\nCurrent: <code>" + escapeHtml(current) + "</code>", {
    parse_mode: "HTML",
    reply_markup: buildInlineKeyboard([[{ text: "Use Default", callback_data: "flow:use_default_url" }], [{ text: "Skip", callback_data: "flow:skip" }], [{ text: "Cancel", callback_data: "flow:cancel" }]])
  });
}

export async function flowPromptApiKey(env, chatId, isEdit) {
  const msg = isEdit
    ? "Step 5/6: Send a new API key, or press Skip to keep the current key.\n\n⚠ This message will be deleted immediately after Nyra reads it."
    : "Step 5/7: Send the API key.\n\n⚠ This message will be deleted immediately after Nyra reads it.";
  await sendMessage(env, chatId, msg, {
    reply_markup: buildInlineKeyboard([[{ text: "Skip", callback_data: "flow:skip" }], [{ text: "Cancel", callback_data: "flow:cancel" }]])
  });
}

export async function flowPromptModel(env, chatId, currentModel) {
  const msg = currentModel
    ? "Step 6/6: Send a new model name, or press Skip to keep <code>" + escapeHtml(currentModel) + "</code>.\n\nYou can also fetch the provider's model list."
    : "Step 6/7: Send the model name.\n\nYou can also fetch the provider's model list.";
  const rows = [[{ text: "Fetch Models", callback_data: "flow:fetchmodels" }]];
  if (currentModel) rows.push([{ text: "Skip", callback_data: "flow:skip" }]);
  rows.push([{ text: "Cancel", callback_data: "flow:cancel" }]);
  await sendMessage(env, chatId, msg, { parse_mode: "HTML", reply_markup: buildInlineKeyboard(rows) });
}

export async function flowPromptReview(env, chatId, flowState) {
  const rows = [[{ text: "Save and Test", callback_data: "flow:save" }], [{ text: "Cancel", callback_data: "flow:cancel" }]];
  const visionLine = flowState.supports_vision ? "Images: yes" : "Images: no";
  await sendMessage(env, chatId, "<b>Review</b>\n\nLabel: " + escapeHtml(flowState.label) + "\nDescription: " + (flowState.description ? escapeHtml(flowState.description) : "<i>(none)</i>") + "\nProvider: " + escapeHtml(flowState.provider) + "\nBase URL: <code>" + escapeHtml(flowState.base_url) + "</code>\nModel: <code>" + escapeHtml(flowState.model) + "</code>\n" + visionLine + "\n\nThe API key is encrypted and not shown.", { parse_mode: "HTML", reply_markup: buildInlineKeyboard(rows) });
}

/**
 * Capability question. Only models that accept image input support this, so the
 * answer is recorded on the connection and used to decide whether photos are
 * forwarded to the provider instead of being described as text.
 */
export async function flowPromptCapabilities(env, chatId, flowState, step) {
  flowState.step = step;
  const rows = [
    [{ text: "📷 This model can see images", callback_data: "flow:vision:1" }],
    [{ text: "📝 Text only", callback_data: "flow:vision:0" }],
    [{ text: "Cancel", callback_data: "flow:cancel" }]
  ];
  await sendMessage(env, chatId, "Step " + (step === "edit_capabilities" ? "6/6" : "7/7") + ": Does <code>" + escapeHtml(flowState.model) + "</code> accept images?\n\nIf yes, photos you send are forwarded to the model. If no (or if unsure), images are described to the model as text.", { parse_mode: "HTML", reply_markup: buildInlineKeyboard(rows) });
}
