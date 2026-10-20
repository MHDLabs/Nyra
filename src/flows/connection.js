// The connection wizard's entry points and its step machine. It is the only
// module that dispatches *into* the other two (route steps, the model
// picker), which is why it carries the step routing while the prompts and
// the picker stay leaf modules.
import { RATE_LIMIT_CONN_TEST_PER_MIN, MAX_PERSONALITY_PROMPT, MAX_PERSONALITY_DESC, MAX_CUSTOM_INSTRUCTIONS, MAX_LABEL_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_MODEL_LENGTH, MAX_URL_LENGTH, MAX_API_KEY_LENGTH, OPENAI_DEFAULT_URL, ANTHROPIC_DEFAULT_URL } from "../config.js";
import { now, truncate, escapeHtml, isAdmin, checkRateLimit, normalizeBaseUrl } from "../utils.js";
import { encryptCredential, decryptCredential } from "../crypto.js";
import { sendMessage, deleteMessage, buildInlineKeyboard } from "../telegram.js";
import { setFlowState, clearFlowState, getUserConnectionById, saveGlobalConnection, updateUserConnection, setDefaultConnection, isPersonalModelsAllowed, getPersonalModelLimit, countPersonalConnections } from "../db.js";
import { humanizeError, testConnectionRaw } from "../ai.js";
import { sourceSuffix } from "../menus.js";
import {
  flowPromptDescription, flowPromptBaseUrl, flowPromptApiKey,
  flowPromptModel, flowPromptReview, flowPromptCapabilities
} from "./connection-prompts.js";
import { isEditStep } from "./model-picker.js";
import { handleRouteFlowStep } from "./route.js";

export async function startAddConnectionFlow(env, chatId, userId, source) {
  if (!isAdmin(env, userId)) {
    if (!(await isPersonalModelsAllowed(env))) {
      await sendMessage(env, chatId, "Only administrators can add models.");
      return;
    }
    const limit = await getPersonalModelLimit(env);
    const count = await countPersonalConnections(env, userId);
    if (count >= limit) {
      await sendMessage(env, chatId, "You have reached the personal model limit (" + limit + "). Remove one first.");
      return;
    }
  }
  const personal = !isAdmin(env, userId);
  await setFlowState(env, userId, { step: "provider", flowType: "add", source: source || "set", personal: personal });
  const rows = [
    [{ text: "OpenAI-compatible", callback_data: "flow:provider:openai-compatible" }],
    [{ text: "Anthropic", callback_data: "flow:provider:anthropic" }],
    [{ text: "Cancel", callback_data: "flow:cancel" }]
  ];
  const header = personal ? "Add Personal Model" : "Add Model";
  await sendMessage(env, chatId, "<b>" + header + "</b>\n\nStep 1/7: Choose the provider type.", { parse_mode: "HTML", reply_markup: buildInlineKeyboard(rows) });
}

export async function startEditConnectionFlow(env, chatId, userId, connectionId, source) {
  if (!isAdmin(env, userId)) { await sendMessage(env, chatId, "Only administrators can edit models."); return; }
  const conn = await getUserConnectionById(env, userId, connectionId);
  if (!conn) { await sendMessage(env, chatId, "Connection not found."); return; }
  await setFlowState(env, userId, {
    step: "edit_label", flowType: "edit", connectionId: connectionId, source: source || "set",
    label: conn.label, description: conn.description || "", provider: conn.provider,
    base_url: conn.base_url || "", model: conn.model,
    supports_vision: conn.supports_vision === 1 ? 1 : 0,
    encrypted_key: conn.encrypted_key, key_iv: conn.key_iv, key_updated: false
  });
  await sendMessage(env, chatId, "<b>Edit Model</b>\n\nStep 1/6: Send a new label, or press Skip to keep <b>" + escapeHtml(conn.label) + "</b>.", {
    parse_mode: "HTML",
    reply_markup: buildInlineKeyboard([[{ text: "Skip", callback_data: "flow:skip" }], [{ text: "Cancel", callback_data: "flow:cancel" }]])
  });
}

export async function handleFlowMessage(env, ctx, message, from, chat, flowState) {
  const userId = from.id;
  const chatId = chat.id;
  const text = (message.text || "").trim();

  if (flowState.flowType === "custom_instructions") {
    if (text.length === 0) { await sendMessage(env, chatId, "Please send some text, or /cancel."); return true; }
    if (text.length > MAX_CUSTOM_INSTRUCTIONS) { await sendMessage(env, chatId, "Too long (max " + MAX_CUSTOM_INSTRUCTIONS + " characters)."); return true; }
    try {
      await env.DB.prepare("UPDATE users SET custom_instructions = ?, updated_at = ? WHERE telegram_id = ?").bind(text, now(), userId).run();
      await clearFlowState(env, userId);
      await sendMessage(env, chatId, "✅ Custom instructions saved.", { reply_markup: buildInlineKeyboard([[{ text: "Back to Settings", callback_data: "set:menu" }]]) });
    } catch (err) { await sendMessage(env, chatId, "Could not save. Try again."); }
    return true;
  }

  if (flowState.flowType === "personality_edit") {
    const field = flowState.editField;
    const pid = flowState.personalityId;
    if (!field || !pid) { await clearFlowState(env, userId); await sendMessage(env, chatId, "Invalid flow state."); return true; }
    if (field === "name") {
      if (text.length === 0 || text.length > 50) { await sendMessage(env, chatId, "Name must be 1-50 characters."); return true; }
      try {
        await env.DB.prepare("UPDATE custom_personalities SET name = ?, updated_at = ? WHERE personality_id = ? AND telegram_id = ?").bind(text, now(), pid, userId).run();
        await clearFlowState(env, userId);
        await sendMessage(env, chatId, "✅ Name updated.", { reply_markup: buildInlineKeyboard([[{ text: "View", callback_data: "myp:view:" + pid }]]) });
      } catch (err) { await sendMessage(env, chatId, "Could not update."); }
      return true;
    }
    if (field === "description") {
      if (text.length > MAX_PERSONALITY_DESC) { await sendMessage(env, chatId, "Too long (max " + MAX_PERSONALITY_DESC + " characters)."); return true; }
      try {
        await env.DB.prepare("UPDATE custom_personalities SET description = ?, updated_at = ? WHERE personality_id = ? AND telegram_id = ?").bind(text, now(), pid, userId).run();
        await clearFlowState(env, userId);
        await sendMessage(env, chatId, "✅ Description updated.", { reply_markup: buildInlineKeyboard([[{ text: "View", callback_data: "myp:view:" + pid }]]) });
      } catch (err) { await sendMessage(env, chatId, "Could not update."); }
      return true;
    }
    if (field === "prompt") {
      if (text.length === 0 || text.length > MAX_PERSONALITY_PROMPT) { await sendMessage(env, chatId, "Prompt must be 1-" + MAX_PERSONALITY_PROMPT + " characters."); return true; }
      try {
        await env.DB.prepare("UPDATE custom_personalities SET prompt = ?, updated_at = ? WHERE personality_id = ? AND telegram_id = ?").bind(text, now(), pid, userId).run();
        await clearFlowState(env, userId);
        await sendMessage(env, chatId, "✅ Prompt updated.", { reply_markup: buildInlineKeyboard([[{ text: "View", callback_data: "myp:view:" + pid }]]) });
      } catch (err) { await sendMessage(env, chatId, "Could not update."); }
      return true;
    }
    await clearFlowState(env, userId);
    await sendMessage(env, chatId, "Invalid field.");
    return true;
  }

  if (flowState.flowType === "add_route" || flowState.flowType === "edit_route") {
    return await handleRouteFlowStep(env, chatId, userId, text, message, flowState);
  }

  if (!isAdmin(env, userId) && (flowState.flowType === "add" || flowState.flowType === "edit")) {
    if (flowState.flowType === "add" && await isPersonalModelsAllowed(env)) {
      // Personal model: allowed, but enforce the configured per-user limit.
      const limit = await getPersonalModelLimit(env);
      const count = await countPersonalConnections(env, userId);
      if (count >= limit) {
        await clearFlowState(env, userId);
        await sendMessage(env, chatId, "You have reached the personal model limit (" + limit + "). Remove one first.");
        return true;
      }
    } else {
      await clearFlowState(env, userId);
      await sendMessage(env, chatId, "Only administrators can configure models.");
      return true;
    }
  }

  const step = flowState.step;
  const isEdit = flowState.flowType === "edit";

  if (step === "label" || step === "edit_label") {
    if (text.length === 0 || text.length > MAX_LABEL_LENGTH) { await sendMessage(env, chatId, "Label must be 1–" + MAX_LABEL_LENGTH + " characters."); return true; }
    flowState.label = text;
    if (isEdit) { flowState.step = "edit_description"; await setFlowState(env, userId, flowState); await flowPromptDescription(env, chatId, flowState.description); }
    else { flowState.step = "description"; await setFlowState(env, userId, flowState); await flowPromptDescription(env, chatId, null); }
    return true;
  }

  if (step === "description" || step === "edit_description") {
    if (text.length > MAX_DESCRIPTION_LENGTH) { await sendMessage(env, chatId, "Description too long (max " + MAX_DESCRIPTION_LENGTH + " characters)."); return true; }
    flowState.description = text;
    if (isEdit) { flowState.step = "edit_base_url"; await setFlowState(env, userId, flowState); await flowPromptBaseUrl(env, chatId, flowState.provider, flowState.base_url); }
    else { flowState.step = "base_url"; await setFlowState(env, userId, flowState); await flowPromptBaseUrl(env, chatId, flowState.provider, null); }
    return true;
  }

  if (step === "base_url" || step === "edit_base_url") {
    if (text.length === 0 || text.length > MAX_URL_LENGTH) { await sendMessage(env, chatId, "URL must be 1–" + MAX_URL_LENGTH + " characters."); return true; }
    // Accepts a full endpoint pasted from provider docs and trims it back to
    // the API root, so the adapters never append a second "/chat/completions".
    const normalized = normalizeBaseUrl(flowState.provider, text);
    if (!normalized) { await sendMessage(env, chatId, "That doesn't look like a valid URL. Try again or press Default."); return true; }
    flowState.base_url = normalized;
    if (isEdit) { flowState.step = "edit_api_key"; await setFlowState(env, userId, flowState); await flowPromptApiKey(env, chatId, true); }
    else { flowState.step = "api_key"; await setFlowState(env, userId, flowState); await flowPromptApiKey(env, chatId, false); }
    return true;
  }

  if (step === "api_key" || step === "edit_api_key") {
    if (text.length === 0 || text.length > MAX_API_KEY_LENGTH) { await sendMessage(env, chatId, "API key length is invalid."); return true; }
    const delResult = await deleteMessage(env, chatId, message.message_id);
    if (!delResult || !delResult.ok) await sendMessage(env, chatId, "⚠ I could not delete your API key message. Please delete it manually.");
    try {
      const encrypted = await encryptCredential(env, userId, text);
      flowState.encrypted_key = encrypted.ct;
      flowState.key_iv = encrypted.iv;
      flowState.key_updated = true;
      flowState.step = isEdit ? "edit_model" : "model";
      await setFlowState(env, userId, flowState);
      await flowPromptModel(env, chatId, isEdit ? flowState.model : null);
    } catch (err) {
      console.error("Encrypt failed:", err.message);
      await clearFlowState(env, userId);
      await sendMessage(env, chatId, "Encryption failed. Connection setup cancelled.");
    }
    return true;
  }

  if (step === "model" || step === "edit_model") {
    if (text.length === 0 || text.length > MAX_MODEL_LENGTH) { await sendMessage(env, chatId, "Model name must be 1–" + MAX_MODEL_LENGTH + " characters."); return true; }
    flowState.model = text;
    await flowPromptCapabilities(env, chatId, flowState, isEdit ? "edit_capabilities" : "capabilities");
    await setFlowState(env, userId, flowState);
    return true;
  }

  if (step === "capabilities" || step === "edit_capabilities") {
    const answer = text.trim().toLowerCase();
    const yes = answer === "yes" || answer === "y" || answer === "بله" || answer === "1";
    const no = answer === "no" || answer === "n" || answer === "خیر" || answer === "0";
    if (!yes && !no) { await sendMessage(env, chatId, "Please answer Yes or No, or use the buttons above."); return true; }
    flowState.supports_vision = yes ? 1 : 0;
    flowState.step = isEdit ? "edit_confirm" : "confirm";
    await setFlowState(env, userId, flowState);
    await flowPromptReview(env, chatId, flowState);
    return true;
  }

  await sendMessage(env, chatId, "Please follow the current step or send /cancel.");
  return true;
}

export async function handleFlowSkip(env, chatId, userId, flowState) {
  const step = flowState.step;
  if (step === "route_edit_label") { await clearFlowState(env, userId); await sendMessage(env, chatId, "Route unchanged.", { reply_markup: buildInlineKeyboard([[{ text: "Manage Routes", callback_data: "route:list" }]]) }); return; }
  if (step === "edit_label") { flowState.step = "edit_description"; await setFlowState(env, userId, flowState); await flowPromptDescription(env, chatId, flowState.description); return; }
  if (step === "description") { flowState.description = ""; flowState.step = "base_url"; await setFlowState(env, userId, flowState); await flowPromptBaseUrl(env, chatId, flowState.provider, null); return; }
  if (step === "base_url") { flowState.base_url = flowState.provider === "anthropic" ? ANTHROPIC_DEFAULT_URL : OPENAI_DEFAULT_URL; flowState.step = "api_key"; await setFlowState(env, userId, flowState); await flowPromptApiKey(env, chatId, false); return; }
  if (step === "edit_description") { flowState.step = "edit_base_url"; await setFlowState(env, userId, flowState); await flowPromptBaseUrl(env, chatId, flowState.provider, flowState.base_url); return; }
  if (step === "edit_base_url") { flowState.step = "edit_api_key"; await setFlowState(env, userId, flowState); await flowPromptApiKey(env, chatId, true); return; }
  if (step === "edit_api_key") { flowState.step = "edit_model"; await setFlowState(env, userId, flowState); await flowPromptModel(env, chatId, flowState.model); return; }
  if (step === "edit_model") { await flowPromptCapabilities(env, chatId, flowState, "edit_capabilities"); await setFlowState(env, userId, flowState); return; }
  if (step === "capabilities" || step === "edit_capabilities") { flowState.supports_vision = 0; flowState.step = isEditStep(flowState) ? "edit_confirm" : "confirm"; await setFlowState(env, userId, flowState); await flowPromptReview(env, chatId, flowState); return; }
}

export async function finalizeConnectionFromFlow(env, chatId, userId, flowState) {
  if (!isAdmin(env, userId) && !(await isPersonalModelsAllowed(env))) {
    await clearFlowState(env, userId);
    await sendMessage(env, chatId, "Only administrators can configure models.");
    return;
  }
  const personal = !isAdmin(env, userId);
  const source = flowState.source || "set";
  const sfx = sourceSuffix(source);
  try {
    const rateOk = await checkRateLimit(env, "conntest:" + userId, RATE_LIMIT_CONN_TEST_PER_MIN, 60);
    if (!rateOk) { await clearFlowState(env, userId); await sendMessage(env, chatId, "Too many tests. Try again in a minute."); return; }
    let apiKey;
    try { apiKey = await decryptCredential(env, userId, flowState.encrypted_key, flowState.key_iv); }
    catch (err) { await clearFlowState(env, userId); await sendMessage(env, chatId, "Could not decrypt the API key."); return; }
    const test = await testConnectionRaw(flowState.provider, flowState.base_url, apiKey, flowState.model);
    if (test.status !== "success") {
      const rows = [[{ text: "Retry Test", callback_data: "flow:retry_test" }], [{ text: "Cancel", callback_data: "flow:cancel" }]];
      let text = "⚠ Connection test failed.\n\nReason: <b>" + escapeHtml(test.status) + "</b>\n" + escapeHtml(humanizeError(test.status));
      if (test.diagnostic) text += "\n\n<i>Diagnostic:</i> <code>" + escapeHtml(truncate(test.diagnostic, 300)) + "</code>";
      await sendMessage(env, chatId, text, { parse_mode: "HTML", reply_markup: buildInlineKeyboard(rows) });
      return;
    }
    if (flowState.flowType === "edit") {
      const updates = { label: flowState.label, description: flowState.description || "", base_url: flowState.base_url, model: flowState.model, provider: flowState.provider, supports_vision: flowState.supports_vision ? 1 : 0 };
      if (flowState.key_updated) { updates.encrypted_key = flowState.encrypted_key; updates.key_iv = flowState.key_iv; }
      const ok = await updateUserConnection(env, userId, flowState.connectionId, updates);
      if (!ok) { await sendMessage(env, chatId, "Failed to update the connection."); return; }
      await clearFlowState(env, userId);
      await sendMessage(env, chatId, "✅ Model updated and tested.\n\nLabel: " + escapeHtml(flowState.label) + "\nModel: <code>" + escapeHtml(flowState.model) + "</code>\nLatency: " + (test.latency || "?") + " ms", { parse_mode: "HTML", reply_markup: buildInlineKeyboard([[{ text: "Manage Models", callback_data: "myconn:list" + sfx }]]) });
      return;
    }
    const newId = await saveGlobalConnection(env, userId, {
      label: flowState.label,
      description: flowState.description || "",
      provider: flowState.provider,
      base_url: flowState.base_url,
      model: flowState.model,
      api_key: apiKey,
      supports_vision: flowState.supports_vision ? 1 : 0,
      personal: personal
    });
    if (!personal) {
      try {
        const existingDefault = await env.DB.prepare("SELECT connection_id FROM ai_connections WHERE is_global = 1 AND is_default = 1").first();
        if (!existingDefault) {
          await setDefaultConnection(env, userId, newId);
        }
      } catch (e) {}
    }
    await clearFlowState(env, userId);
    const suffix = personal ? "Personal model saved and tested." : "Model saved and tested.";
    await sendMessage(env, chatId, "✅ " + suffix + "\n\nLabel: " + escapeHtml(flowState.label) + "\nModel: <code>" + escapeHtml(flowState.model) + "</code>\nLatency: " + (test.latency || "?") + " ms", { parse_mode: "HTML", reply_markup: buildInlineKeyboard([[{ text: "Manage Models", callback_data: "myconn:list" + sfx }]]) });
  } catch (err) {
    console.error("finalizeConnectionFromFlow failed:", err.message);
    try { await sendMessage(env, chatId, "⚠ Test failed unexpectedly. Try /settings again."); } catch (e) {}
  }
}
