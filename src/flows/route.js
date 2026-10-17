// The route wizard: a route is an ordered model x token bundle with a
// default model, so its prompts and its step machine are separate from the
// single-connection wizard even though both are driven by the same
// getFlowState/setFlowState mechanism.
import { MAX_MODEL_LENGTH, MAX_URL_LENGTH, MAX_API_KEY_LENGTH, OPENAI_DEFAULT_URL, ANTHROPIC_DEFAULT_URL, MAX_ROUTE_MODELS, MAX_ROUTE_TOKENS, MAX_ROUTE_LABEL_LENGTH } from "../config.js";
import { escapeHtml, isAdmin } from "../utils.js";
import { sendMessage, deleteMessage, buildInlineKeyboard } from "../telegram.js";
import { setFlowState, clearFlowState, saveRoute, addRouteModel, addRouteToken, isPersonalModelsAllowed } from "../db.js";

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
      const { updateRoute } = await import("../db.js");
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
      const { updateRoute } = await import("../db.js");
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
