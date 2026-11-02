// Onboarding: persistent 5-step flow (language→name→personality→disclosure→welcome).
// State survives restarts, duplicate callbacks, stale messages. Recoverable at any step.
import { now, escapeHtml, isAdmin } from "../utils.js";
import { sendMessage, answerCallback, editMessage, buildInlineKeyboard } from "../telegram.js";
import { getUser, upsertUser } from "../db.js";
import { t } from "../i18n/index.js";
import { isSharedServiceEnabled as getSharedServiceEnabled, getSharedRequestLimit, getSharedTokenLimit } from "../db/settings.js";

const MAX_NAME_LENGTH = 50;
const ONBOARDING_VERSION = 1;
const PERSONALITIES = ["default", "friendly", "funny", "romantic", "creative"];

// ponytail: onboarding state in users table JSON string, upgrade to dedicated table when >5 fields needed
export async function getOnboardingState(env, userId) {
  const user = await getUser(env, userId);
  if (!user || !user.onboarding_state) return null;
  try { return JSON.parse(user.onboarding_state); }
  catch { return null; }
}

export async function setOnboardingState(env, userId, state) {
  await env.DB.prepare("UPDATE users SET onboarding_state = ?, onboarding_started_at = COALESCE(onboarding_started_at, ?), updated_at = ? WHERE telegram_id = ?")
    .bind(JSON.stringify(state), now(), now(), userId).run();
}

export async function clearOnboardingState(env, userId) {
  await env.DB.prepare("UPDATE users SET onboarding_state = NULL, onboarding_completed = 1, onboarding_version = ?, updated_at = ? WHERE telegram_id = ?")
    .bind(ONBOARDING_VERSION, now(), userId).run();
}

export async function startOnboarding(env, chatId, userId, from) {
  await upsertUser(env, from);
  const user = await getUser(env, userId);
  
  // Already complete
  if (user && user.onboarding_completed === 1) {
    const locale = user.locale || "en-US";
    await sendMessage(env, chatId, t(locale, "onboarding.already_complete"));
    return;
  }

  // Resume or restart
  const state = await getOnboardingState(env, userId);
  if (state && state.step) {
    await continueOnboarding(env, chatId, userId, state.step);
    return;
  }

  // Fresh start: language selection
  await setOnboardingState(env, userId, { step: "language" });
  const keyboard = buildInlineKeyboard([
    [{ text: "فارسی", callback_data: "onboard:lang:fa-IR" }],
    [{ text: "English (United States)", callback_data: "onboard:lang:en-US" }]
  ]);
  await sendMessage(env, chatId, "Please choose your language.\n\nلطفاً زبان خود را انتخاب کنید.", { reply_markup: keyboard });
}

async function continueOnboarding(env, chatId, userId, step) {
  const state = await getOnboardingState(env, userId);
  if (!state) { await startOnboarding(env, chatId, userId, { id: userId }); return; }

  if (step === "language") {
    const keyboard = buildInlineKeyboard([
      [{ text: "فارسی", callback_data: "onboard:lang:fa-IR" }],
      [{ text: "English (United States)", callback_data: "onboard:lang:en-US" }]
    ]);
    await sendMessage(env, chatId, "Please choose your language.\n\nلطفاً زبان خود را انتخاب کنید.", { reply_markup: keyboard });
  } else if (step === "name") {
    await sendMessage(env, chatId, t(state.locale, "onboarding.name.prompt", { max: MAX_NAME_LENGTH }));
  } else if (step === "personality") {
    await promptPersonality(env, chatId, state.locale);
  } else if (step === "disclosure") {
    await promptDisclosure(env, chatId, userId, state.locale);
  }
}

export async function handleOnboardingCallback(env, chatId, userId, messageId, action, value, queryId) {
  const state = await getOnboardingState(env, userId);
  if (!state) {
    await answerCallback(env, queryId, "");
    await editMessage(env, chatId, messageId, t("en-US", "onboarding.restart"));
    await startOnboarding(env, chatId, userId, { id: userId });
    return;
  }

  await answerCallback(env, queryId, "");

  if (action === "lang") {
    state.locale = value;
    state.step = "name";
    await setOnboardingState(env, userId, state);
    await env.DB.prepare("UPDATE users SET locale = ?, updated_at = ? WHERE telegram_id = ?")
      .bind(value, now(), userId).run();
    await editMessage(env, chatId, messageId, value === "fa-IR" ? "زبان: فارسی" : "Language: English");
    await sendMessage(env, chatId, t(state.locale, "onboarding.name.prompt", { max: MAX_NAME_LENGTH }));
  } else if (action === "personality") {
    if (!PERSONALITIES.includes(value)) return;
    state.personality = value;
    state.step = "disclosure";
    await setOnboardingState(env, userId, state);
    await env.DB.prepare("UPDATE users SET personality_id = ?, updated_at = ? WHERE telegram_id = ?")
      .bind(value, now(), userId).run();
    const pname = t(state.locale, `onboarding.personality.${value}.name`);
    await editMessage(env, chatId, messageId, t(state.locale, "onboarding.personality.prompt") + "\n\n✓ " + pname);
    await promptDisclosure(env, chatId, userId, state.locale);
  } else if (action === "accept") {
    state.accepted = true;
    await clearOnboardingState(env, userId);
    await editMessage(env, chatId, messageId, t(state.locale, "onboarding.disclosure.title"));
    const user = await getUser(env, userId);
    const name = user?.preferred_name || user?.first_name || "";
    let welcome = t(state.locale, "onboarding.welcome", { name: escapeHtml(name) });
    if (isAdmin(env, userId)) {
      welcome += "\n" + t(state.locale, "onboarding.welcome.admin");
    }
    await sendMessage(env, chatId, welcome, { parse_mode: "HTML" });
  }
}

export async function handleOnboardingMessage(env, chatId, userId, text) {
  const state = await getOnboardingState(env, userId);
  if (!state) return false;

  if (state.step === "name") {
    // Validate name: 1-MAX_NAME_LENGTH plain text, no commands/links/markup
    const clean = text.trim();
    if (!clean || clean.length > MAX_NAME_LENGTH || clean.startsWith("/") || clean.includes("http") || clean.includes("<") || clean.includes("[")) {
      await sendMessage(env, chatId, t(state.locale, "onboarding.name.invalid", { max: MAX_NAME_LENGTH }));
      return true;
    }
    state.name = clean;
    state.step = "personality";
    await setOnboardingState(env, userId, state);
    await env.DB.prepare("UPDATE users SET preferred_name = ?, updated_at = ? WHERE telegram_id = ?")
      .bind(clean, now(), userId).run();
    await promptPersonality(env, chatId, state.locale);
    return true;
  }

  return false;
}

async function promptPersonality(env, chatId, locale) {
  const buttons = PERSONALITIES.map(p => [{
    text: t(locale, `onboarding.personality.${p}.name`),
    callback_data: `onboard:personality:${p}`
  }]);
  const keyboard = buildInlineKeyboard(buttons);
  await sendMessage(env, chatId, t(locale, "onboarding.personality.prompt"), { reply_markup: keyboard });
}

async function promptDisclosure(env, chatId, userId, locale) {
  const enabled = await getSharedServiceEnabled(env);
  const reqLimit = await getSharedRequestLimit(env);
  const tokLimit = await getSharedTokenLimit(env);

  let text = t(locale, "onboarding.disclosure.title") + "\n\n";
  if (enabled) {
    const reqStr = reqLimit > 0 ? String(reqLimit) : t(locale, "onboarding.limit.unlimited");
    const tokStr = tokLimit > 0 ? String(tokLimit) : t(locale, "onboarding.limit.unlimited");
    text += t(locale, "onboarding.disclosure.shared_body", { requests: reqStr, tokens: tokStr });
  } else {
    text += t(locale, "onboarding.disclosure.shared_disabled");
  }

  const keyboard = buildInlineKeyboard([[
    { text: t(locale, "onboarding.disclosure.continue"), callback_data: "onboard:accept:1" }
  ]]);
  await sendMessage(env, chatId, text, { reply_markup: keyboard });
}
