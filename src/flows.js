// Nyra — flows: add/edit connection wizard and text-input flows.
import { RATE_LIMIT_CONN_TEST_PER_MIN, MAX_PERSONALITY_PROMPT, MAX_PERSONALITY_DESC, MAX_CUSTOM_INSTRUCTIONS, MAX_LABEL_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_MODEL_LENGTH, MAX_URL_LENGTH, MAX_API_KEY_LENGTH, MODELS_PER_PAGE, OPENAI_DEFAULT_URL, ANTHROPIC_DEFAULT_URL, MAX_ROUTE_MODELS, MAX_ROUTE_TOKENS, MAX_ROUTE_LABEL_LENGTH, MAX_TOKEN_LABEL_LENGTH } from "./config.js";
import { now, truncate, escapeHtml, isAdmin, checkRateLimit } from "./utils.js";
import { encryptCredential, decryptCredential } from "./crypto.js";
import { sendMessage, editMessage, deleteMessage, buildInlineKeyboard } from "./telegram.js";
import { setFlowState, clearFlowState, getUserConnectionById, saveGlobalConnection, updateUserConnection, setDefaultConnection, saveRoute, addRouteModel, addRouteToken, isPersonalModelsAllowed, getPersonalModelLimit, countPersonalConnections } from "./db.js";
import { humanizeError, fetchAvailableModels, testConnectionRaw } from "./ai.js";
import { sourceSuffix } from "./menus.js";

const ROUTE_PROVIDER_LABEL = { "openai-compatible": "OpenAI-compatible", "anthropic": "Anthropic" };

async function canManageModels(env, userId) {
  if (isAdmin(env, userId)) return true;
  return await isPersonalModelsAllowed(env);
}

export async function startAddRouteFlow(env, chatId, userId, source) {
  if (!isAdmin(env, userId)) { await sendMessage(env, chatId, "Only administrators can add routes."); return; }
  await setFlowState(env, userId, { step: "route_label", flowType: "add_route", source: source || "set", models: [], tokens: [] });
  await sendMessage(env, chatId, "<b>Add Route</b>\n\nStep 1/5: Send a label for this route (e.g. <i>Production</i>). Max " + MAX_ROUTE_LABEL_LENGTH + " characters.", {
    parse_mode: "HTML",
    reply_markup: buildInlineKeyboard([[{ text: "Cancel", callback_data: "flow:cancel" }]])
  });
}

export async function startEditRouteFlow(env, chatId, userId, routeId, source) {
  if (!isAdmin(env, userId)) { await sendMessage(env, chatId, "Only administrators can edit routes."); return; }
  await setFlowState(env, userId, { step: "route_edit_label", flowType: "edit_route", routeId: routeId, source: source || "set" });
  await sendMessage(env, chatId, "<b>Edit Route</b>\n\nSend a new label or press Skip to keep the current one.", {
    parse_mode: "HTML",
    reply_markup: buildInlineKeyboard([[{ text: "Skip", callback_data: "flow:skip" }], [{ text: "Cancel", callback_data: "flow:cancel" }]])
  });
}

export async function routePromptProvider(env, chatId) {
  await sendMessage(env, chatId, "Step 2/5: Choose the provider type.", {
    reply_markup: buildInlineKeyboard([
      [{ text: "OpenAI-compatible", callback_data: "flow:route_provider:openai-compatible" }],
      [{ text: "Anthropic", callback_data: "flow:route_provider:anthropic" }],
      [{ text: "Cancel", callback_data: "flow:cancel" }]
    ])
  });
}

export async function routePromptBaseUrl(env, chatId, provider) {
  const url = provider === "anthropic" ? ANTHROPIC_DEFAULT_URL : OPENAI_DEFAULT_URL;
  await sendMessage(env, chatId, "Step 3/5: Send the Base URL, or press Use Default.\n\nDefault: <code>" + escapeHtml(url) + "</code>", {
    parse_mode: "HTML",
    reply_markup: buildInlineKeyboard([[{ text: "Use Default", callback_data: "flow:route_default_url" }], [{ text: "Cancel", callback_data: "flow:cancel" }]])
  });
}

export async function routePromptModels(env, chatId, current) {
  const msg = "Step 4/5: Send one or more model names, separated by commas (order = fallback order).\n\nExample: <code>gpt-4o-mini, gpt-4o</code>\nMax " + MAX_ROUTE_MODELS + " models. The first one is the default." +
    (current && current.length ? "\n\nCurrent: <code>" + escapeHtml(current.join(", ")) + "</code>" : "");
  await sendMessage(env, chatId, msg, { parse_mode: "HTML", reply_markup: buildInlineKeyboard([[{ text: "Cancel", callback_data: "flow:cancel" }]]) });
}

export async function routePromptTokens(env, chatId, current) {
  const msg = "Step 5/5: Send one or more API keys (tokens), separated by commas.\n\nThey rotate on failure. Max " + MAX_ROUTE_TOKENS + " tokens.\n\n⚠ Your message is deleted immediately after Nyra reads it." +
    (current && current.length ? "\n\nCurrent: " + current.length + " token(s) saved." : "");
  const rows = [[{ text: "Keep Existing", callback_data: "flow:route_keep_tokens" }], [{ text: "Cancel", callback_data: "flow:cancel" }]];
  await sendMessage(env, chatId, msg, { parse_mode: "HTML", reply_markup: buildInlineKeyboard(rows) });
}

export async function routePromptReview(env, chatId, state) {
  const lines = ["<b>Review Route</b>", ""];
  lines.push("Label: <b>" + escapeHtml(state.label) + "</b>");
  lines.push("Provider: " + escapeHtml(ROUTE_PROVIDER_LABEL[state.provider] || state.provider));
  lines.push("Base URL: <code>" + escapeHtml(state.base_url) + "</code>");
  lines.push("Models: <code>" + escapeHtml((state.models || []).join(", ")) + "</code>");
  lines.push("Tokens: " + ((state.tokens || []).length) + " (encrypted)");
  await sendMessage(env, chatId, lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: buildInlineKeyboard([[{ text: "Save Route", callback_data: "flow:route_save" }], [{ text: "Cancel", callback_data: "flow:cancel" }]])
  });
}

export async function handleRouteFlowStep(env, chatId, userId, text, message, flowState) {
  const step = flowState.step;
  if (step === "route_label" || step === "route_edit_label") {
    if (text.length === 0 || text.length > MAX_ROUTE_LABEL_LENGTH) { await sendMessage(env, chatId, "Label must be 1–" + MAX_ROUTE_LABEL_LENGTH + " characters."); return true; }
    flowState.label = text;
    if (flowState.flowType === "edit_route") {
      const { updateRoute } = await import("./db.js");
      await updateRoute(env, userId, flowState.routeId, { label: text });
      await clearFlowState(env, userId);
      await sendMessage(env, chatId, "✅ Route label updated.", { reply_markup: buildInlineKeyboard([[{ text: "Manage Routes", callback_data: "route:list" }]]) });
      return true;
    }
    flowState.step = "route_provider";
    await setFlowState(env, userId, flowState);
    await routePromptProvider(env, chatId);
    return true;
  }
  if (step === "route_base_url") {
    if (text.length === 0 || text.length > MAX_URL_LENGTH) { await sendMessage(env, chatId, "URL must be 1–" + MAX_URL_LENGTH + " characters."); return true; }
    let url;
    try { url = new URL(text); if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("bad protocol"); }
    catch (err) { await sendMessage(env, chatId, "That doesn't look like a valid URL."); return true; }
    flowState.base_url = url.toString().replace(/\/+$/, "");
    flowState.step = "route_models";
    await setFlowState(env, userId, flowState);
    await routePromptModels(env, chatId, null);
    return true;
  }
  if (step === "route_models") {
    const parts = text.split(/[,\n]+/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
    if (parts.length === 0 || parts.length > MAX_ROUTE_MODELS) { await sendMessage(env, chatId, "Send 1–" + MAX_ROUTE_MODELS + " model names separated by commas."); return true; }
    for (let i = 0; i < parts.length; i++) if (parts[i].length > MAX_MODEL_LENGTH) { await sendMessage(env, chatId, "Model name too long: <code>" + escapeHtml(parts[i]) + "</code>", { parse_mode: "HTML" }); return true; }
    flowState.models = parts;
    flowState.step = "route_tokens";
    await setFlowState(env, userId, flowState);
    await routePromptTokens(env, chatId, flowState.tokens);
    return true;
  }
  if (step === "route_tokens") {
    const delResult = await deleteMessage(env, chatId, message.message_id);
    if (!delResult || !delResult.ok) await sendMessage(env, chatId, "⚠ I could not delete your API key message. Please delete it manually.");
    const parts = text.split(/[,\n]+/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
    if (parts.length === 0 || parts.length > MAX_ROUTE_TOKENS) { await sendMessage(env, chatId, "Send 1–" + MAX_ROUTE_TOKENS + " API keys separated by commas."); return true; }
    for (let i = 0; i < parts.length; i++) if (parts[i].length > MAX_API_KEY_LENGTH) { await sendMessage(env, chatId, "An API key is too long."); return true; }
    flowState.tokens = parts;
    flowState.step = "route_confirm";
    await setFlowState(env, userId, flowState);
    await routePromptReview(env, chatId, flowState);
    return true;
  }
  await sendMessage(env, chatId, "Please follow the current step or send /cancel.");
  return true;
}

export async function finalizeRouteFromFlow(env, chatId, userId, flowState) {
  try {
    const models = flowState.models || [];
    const tokens = flowState.tokens || [];
    if (models.length === 0) { await clearFlowState(env, userId); await sendMessage(env, chatId, "No models set. Route cancelled."); return; }
    let routeId = flowState.routeId;
    if (flowState.flowType === "edit_route" && routeId) {
      const { updateRoute } = await import("./db.js");
      await updateRoute(env, userId, routeId, { label: flowState.label, provider: flowState.provider, base_url: flowState.base_url });
      for (let i = 0; i < models.length; i++) await addRouteModel(env, userId, routeId, models[i]);
      for (let i = 0; i < tokens.length; i++) await addRouteToken(env, userId, routeId, tokens[i]);
    } else {
      routeId = await saveRoute(env, userId, { label: flowState.label, provider: flowState.provider, base_url: flowState.base_url, models: models, tokens: tokens });
    }
    await clearFlowState(env, userId);
    await sendMessage(env, chatId, "✅ Route saved.\n\nLabel: <b>" + escapeHtml(flowState.label) + "</b>\nModels: <code>" + escapeHtml(models.join(", ")) + "</code>\nTokens: " + tokens.length, {
      parse_mode: "HTML",
      reply_markup: buildInlineKeyboard([[{ text: "Manage Routes", callback_data: "route:list" }]])
    });
  } catch (err) {
    console.error("finalizeRouteFromFlow failed:", err.message);
    await clearFlowState(env, userId);
    await sendMessage(env, chatId, "⚠ Could not save the route. Try again.");
  }
}

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
    encrypted_key: conn.encrypted_key, key_iv: conn.key_iv, key_updated: false
  });
  await sendMessage(env, chatId, "<b>Edit Model</b>\n\nStep 1/6: Send a new label, or press Skip to keep <b>" + escapeHtml(conn.label) + "</b>.", {
    parse_mode: "HTML",
    reply_markup: buildInlineKeyboard([[{ text: "Skip", callback_data: "flow:skip" }], [{ text: "Cancel", callback_data: "flow:cancel" }]])
  });
}

export async function flowPromptLabel(env, chatId, currentLabel) {
  const msg = currentLabel
    ? "Send a new label, or press Skip to keep <b>" + escapeHtml(currentLabel) + "</b>. Max " + MAX_LABEL_LENGTH + " characters."
    : "Step 2/7: Send a short label for this connection. Max " + MAX_LABEL_LENGTH + " characters.";
  await sendMessage(env, chatId, msg, {
    parse_mode: "HTML",
    reply_markup: buildInlineKeyboard([[{ text: "Skip", callback_data: "flow:skip" }], [{ text: "Cancel", callback_data: "flow:cancel" }]])
  });
}

async function flowPromptDescription(env, chatId, currentDesc) {
  const msg = currentDesc
    ? "Send a new description, or press Skip to keep <b>" + escapeHtml(currentDesc) + "</b>."
    : "Step 3/7: Send a short description. Max " + MAX_DESCRIPTION_LENGTH + " characters. Optional.";
  await sendMessage(env, chatId, msg, {
    parse_mode: "HTML",
    reply_markup: buildInlineKeyboard([[{ text: "Skip", callback_data: "flow:skip" }], [{ text: "Cancel", callback_data: "flow:cancel" }]])
  });
}

async function flowPromptBaseUrl(env, chatId, provider, currentUrl) {
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

async function flowPromptModel(env, chatId, currentModel) {
  const msg = currentModel
    ? "Step 6/6: Send a new model name, or press Skip to keep <code>" + escapeHtml(currentModel) + "</code>.\n\nYou can also fetch the provider's model list."
    : "Step 6/7: Send the model name.\n\nYou can also fetch the provider's model list.";
  const rows = [[{ text: "Fetch Models", callback_data: "flow:fetchmodels" }]];
  if (currentModel) rows.push([{ text: "Skip", callback_data: "flow:skip" }]);
  rows.push([{ text: "Cancel", callback_data: "flow:cancel" }]);
  await sendMessage(env, chatId, msg, { parse_mode: "HTML", reply_markup: buildInlineKeyboard(rows) });
}

async function flowPromptReview(env, chatId, flowState) {
  const rows = [[{ text: "Save and Test", callback_data: "flow:save" }], [{ text: "Cancel", callback_data: "flow:cancel" }]];
  await sendMessage(env, chatId, "<b>Review</b>\n\nLabel: " + escapeHtml(flowState.label) + "\nDescription: " + (flowState.description ? escapeHtml(flowState.description) : "<i>(none)</i>") + "\nProvider: " + escapeHtml(flowState.provider) + "\nBase URL: <code>" + escapeHtml(flowState.base_url) + "</code>\nModel: <code>" + escapeHtml(flowState.model) + "</code>\n\nThe API key is encrypted and not shown.", { parse_mode: "HTML", reply_markup: buildInlineKeyboard(rows) });
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
    let url;
    try {
      url = new URL(text);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("bad protocol");
    } catch (err) { await sendMessage(env, chatId, "That doesn't look like a valid URL. Try again or press Default."); return true; }
    flowState.base_url = url.toString().replace(/\/+$/, "");
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
  if (step === "edit_model") { flowState.step = "edit_confirm"; await setFlowState(env, userId, flowState); await flowPromptReview(env, chatId, flowState); return; }
}

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
  flowState.step = isEdit ? "edit_confirm" : "confirm";
  await setFlowState(env, userId, flowState);
  await flowPromptReview(env, chatId, flowState);
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
      const updates = { label: flowState.label, description: flowState.description || "", base_url: flowState.base_url, model: flowState.model, provider: flowState.provider };
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
