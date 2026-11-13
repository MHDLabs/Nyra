// Onboarding: language → name → personality → custom_intro (optional) → disclosure → welcome.
// State survives restarts. Bot message ids are tracked so setup chat can be cleaned up.
import { now, escapeHtml, isAdmin } from "../utils.js";
import { sendMessage, sendMessageReturn, answerCallback, editMessage, deleteMessage, buildInlineKeyboard, buildMainReplyKeyboard } from "../telegram.js";
import { getUser, upsertUser } from "../db.js";
import { t } from "../i18n/index.js";
import { isSharedServiceEnabled as getSharedServiceEnabled, getSharedRequestLimit, getSharedTokenLimit } from "../db/settings.js";

const MAX_NAME_LENGTH = 50;
const MAX_CUSTOM_INTRO = 2000;
const ONBOARDING_VERSION = 2;
// Romantic first (default pick order); everyday = id "default".
const PERSONALITIES = ["romantic", "default", "friendly", "funny", "creative"];

export async function getOnboardingState(env, userId) {
  const user = await getUser(env, userId);
  if (!user || !user.onboarding_state) return null;
  try { return JSON.parse(user.onboarding_state); }
  catch (e) { return null; }
}

export async function setOnboardingState(env, userId, state) {
  await env.DB.prepare(
    "UPDATE users SET onboarding_state = ?, onboarding_started_at = COALESCE(onboarding_started_at, ?), updated_at = ? WHERE telegram_id = ?"
  ).bind(JSON.stringify(state), now(), now(), userId).run();
}

export async function clearOnboardingState(env, userId) {
  await env.DB.prepare(
    "UPDATE users SET onboarding_state = NULL, onboarding_completed = 1, onboarding_version = ?, updated_at = ? WHERE telegram_id = ?"
  ).bind(ONBOARDING_VERSION, now(), userId).run();
}

function trackMsg(state, messageId) {
  if (!messageId) return;
  if (!state.botMsgs) state.botMsgs = [];
  state.botMsgs.push(messageId);
  if (state.botMsgs.length > 30) state.botMsgs = state.botMsgs.slice(-30);
}

async function sendTracked(env, chatId, state, userId, text, options) {
  const r = await sendMessageReturn(env, chatId, text, options || {});
  const mid = r && r.ok && r.result ? r.result.message_id : null;
  trackMsg(state, mid);
  await setOnboardingState(env, userId, state);
  return mid;
}

async function cleanupOnboardingMessages(env, chatId, state) {
  const ids = (state && state.botMsgs) || [];
  for (let i = 0; i < ids.length; i++) {
    try { await deleteMessage(env, chatId, ids[i]); } catch (e) {}
  }
}

export async function startOnboarding(env, chatId, userId, from) {
  await upsertUser(env, from);
  const user = await getUser(env, userId);

  if (user && user.onboarding_completed === 1) {
    const locale = user.locale || "en-US";
    await sendMessage(env, chatId, t(locale, "onboarding.already_complete"), {
      reply_markup: buildMainReplyKeyboard(locale)
    });
    return;
  }

  const state = await getOnboardingState(env, userId);
  if (state && state.step) {
    await continueOnboarding(env, chatId, userId, state.step);
    return;
  }

  const fresh = { step: "language", botMsgs: [] };
  await setOnboardingState(env, userId, fresh);
  const keyboard = buildInlineKeyboard([
    [{ text: "🇮🇷 فارسی", callback_data: "onboard:lang:fa-IR" }],
    [{ text: "🇺🇸 English", callback_data: "onboard:lang:en-US" }]
  ]);
  await sendTracked(env, chatId, fresh, userId,
    "Please choose your language.\n\nلطفاً زبان خود را انتخاب کنید.",
    { reply_markup: keyboard });
}

async function continueOnboarding(env, chatId, userId, step) {
  const state = await getOnboardingState(env, userId);
  if (!state) { await startOnboarding(env, chatId, userId, { id: userId }); return; }

  if (step === "language") {
    const keyboard = buildInlineKeyboard([
      [{ text: "🇮🇷 فارسی", callback_data: "onboard:lang:fa-IR" }],
      [{ text: "🇺🇸 English", callback_data: "onboard:lang:en-US" }]
    ]);
    await sendTracked(env, chatId, state, userId,
      "Please choose your language.\n\nلطفاً زبان خود را انتخاب کنید.",
      { reply_markup: keyboard });
  } else if (step === "name") {
    await sendTracked(env, chatId, state, userId, t(state.locale, "onboarding.name.prompt", { max: MAX_NAME_LENGTH }));
  } else if (step === "personality") {
    await promptPersonality(env, chatId, userId, state);
  } else if (step === "custom_intro") {
    await promptCustomIntro(env, chatId, userId, state);
  } else if (step === "disclosure") {
    await promptDisclosure(env, chatId, userId, state);
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
  trackMsg(state, messageId);

  if (action === "lang") {
    state.locale = value;
    state.step = "name";
    await setOnboardingState(env, userId, state);
    await env.DB.prepare("UPDATE users SET locale = ?, updated_at = ? WHERE telegram_id = ?")
      .bind(value, now(), userId).run();
    await editMessage(env, chatId, messageId, value === "fa-IR" ? "🇮🇷 زبان: فارسی" : "🇺🇸 Language: English");
    await sendTracked(env, chatId, state, userId, t(state.locale, "onboarding.name.prompt", { max: MAX_NAME_LENGTH }));
  } else if (action === "personality") {
    if (!PERSONALITIES.includes(value)) return;
    state.personality = value;
    state.step = "custom_intro";
    await setOnboardingState(env, userId, state);
    await env.DB.prepare("UPDATE users SET personality_id = ?, updated_at = ? WHERE telegram_id = ?")
      .bind(value, now(), userId).run();
    const pname = t(state.locale, "onboarding.personality." + value + ".name");
    await editMessage(env, chatId, messageId, t(state.locale, "onboarding.personality.prompt") + "\n\n✓ " + pname);
    await promptCustomIntro(env, chatId, userId, state);
  } else if (action === "intro_skip") {
    state.step = "disclosure";
    await setOnboardingState(env, userId, state);
    await editMessage(env, chatId, messageId, t(state.locale, "onboarding.custom_intro.skip"));
    await promptDisclosure(env, chatId, userId, state);
  } else if (action === "intro_paste") {
    state.awaitingIntro = true;
    await setOnboardingState(env, userId, state);
    await editMessage(env, chatId, messageId, t(state.locale, "onboarding.custom_intro.paste"));
    await sendTracked(env, chatId, state, userId, t(state.locale, "onboarding.custom_intro.prompt"));
  } else if (action === "intro_import") {
    state.awaitingIntro = true;
    await setOnboardingState(env, userId, state);
    await editMessage(env, chatId, messageId, t(state.locale, "onboarding.custom_intro.import"));
    await sendTracked(env, chatId, state, userId, t(state.locale, "onboarding.custom_intro.import_prompt"));
  } else if (action === "accept") {
    state.accepted = true;
    const locale = state.locale || "en-US";
    await cleanupOnboardingMessages(env, chatId, state);
    await clearOnboardingState(env, userId);
    // Default personality if somehow missing
    if (!state.personality) {
      await env.DB.prepare("UPDATE users SET personality_id = COALESCE(personality_id, 'romantic'), updated_at = ? WHERE telegram_id = ?")
        .bind(now(), userId).run();
    }
    const user = await getUser(env, userId);
    const name = (user && (user.preferred_name || user.first_name)) || "";
    let welcome = t(locale, "onboarding.welcome", { name: escapeHtml(name) });
    if (isAdmin(env, userId)) {
      welcome += "\n" + t(locale, "onboarding.welcome.admin");
    }
    await sendMessage(env, chatId, welcome, {
      parse_mode: "HTML",
      reply_markup: buildMainReplyKeyboard(locale)
    });
  }
}

export async function handleOnboardingMessage(env, chatId, userId, text) {
  const state = await getOnboardingState(env, userId);
  if (!state) return false;

  if (state.step === "name") {
    const clean = text.trim();
    if (!clean || clean.length > MAX_NAME_LENGTH || clean.startsWith("/") || clean.indexOf("http") !== -1 || clean.indexOf("<") !== -1 || clean.indexOf("[") !== -1) {
      await sendTracked(env, chatId, state, userId, t(state.locale, "onboarding.name.invalid", { max: MAX_NAME_LENGTH }));
      return true;
    }
    state.name = clean;
    state.step = "personality";
    await setOnboardingState(env, userId, state);
    await env.DB.prepare("UPDATE users SET preferred_name = ?, updated_at = ? WHERE telegram_id = ?")
      .bind(clean, now(), userId).run();
    await promptPersonality(env, chatId, userId, state);
    return true;
  }

  if (state.step === "custom_intro" && state.awaitingIntro) {
    const clean = String(text || "").trim();
    if (!clean || clean.length > MAX_CUSTOM_INTRO) {
      await sendTracked(env, chatId, state, userId, t(state.locale, "onboarding.custom_intro.invalid"));
      return true;
    }
    await env.DB.prepare("UPDATE users SET custom_instructions = ?, updated_at = ? WHERE telegram_id = ?")
      .bind(clean.slice(0, MAX_CUSTOM_INTRO), now(), userId).run();
    state.awaitingIntro = false;
    state.step = "disclosure";
    await setOnboardingState(env, userId, state);
    await sendTracked(env, chatId, state, userId, t(state.locale, "onboarding.custom_intro.saved"));
    await promptDisclosure(env, chatId, userId, state);
    return true;
  }

  return false;
}

async function promptPersonality(env, chatId, userId, state) {
  const locale = state.locale || "en-US";
  const buttons = PERSONALITIES.map(function (p) {
    return [{ text: t(locale, "onboarding.personality." + p + ".name"), callback_data: "onboard:personality:" + p }];
  });
  await sendTracked(env, chatId, state, userId, t(locale, "onboarding.personality.prompt"), {
    reply_markup: buildInlineKeyboard(buttons)
  });
}

async function promptCustomIntro(env, chatId, userId, state) {
  const locale = state.locale || "en-US";
  const keyboard = buildInlineKeyboard([
    [{ text: t(locale, "onboarding.custom_intro.skip"), callback_data: "onboard:intro_skip:1" }],
    [{ text: t(locale, "onboarding.custom_intro.paste"), callback_data: "onboard:intro_paste:1" }],
    [{ text: t(locale, "onboarding.custom_intro.import"), callback_data: "onboard:intro_import:1" }]
  ]);
  await sendTracked(env, chatId, state, userId, t(locale, "onboarding.custom_intro.prompt"), {
    reply_markup: keyboard
  });
}

async function promptDisclosure(env, chatId, userId, state) {
  const locale = state.locale || "en-US";
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
  await sendTracked(env, chatId, state, userId, text, { reply_markup: keyboard });
}
