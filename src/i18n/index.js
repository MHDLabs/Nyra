// Centralized localization for every Nyra surface.
//
// Locale is persisted per user in `users.locale` and defaults to `en-US`.
// The Telegram bot and the Mini App read the same stored value, so changing the
// language in either place changes it everywhere. Messages are grouped into
// domain modules so independent features never edit the same dictionary:
//
//   messages-core.js      shared generic strings (errors, common actions)
//   messages-telegram.js  bot messages: onboarding, commands, groups, maintenance
//   messages-routing.js   provider/model/routing errors and labels
//   messages-miniapp.js   Mini App navigation, settings and admin UI labels
//
// `t(locale, key, params)` is the only way user-facing text should be produced.
// A missing key falls back to en-US, then to the key itself, so a missing
// translation degrades visibly instead of throwing.
import { CORE_MESSAGES } from "./messages-core.js";
import { TELEGRAM_MESSAGES } from "./messages-telegram.js";
import { ROUTING_MESSAGES } from "./messages-routing.js";
import { MINIAPP_MESSAGES } from "./messages-miniapp.js";

export const SUPPORTED_LOCALES = ["en-US", "fa-IR"];
export const DEFAULT_LOCALE = "en-US";

const DOMAINS = [CORE_MESSAGES, TELEGRAM_MESSAGES, ROUTING_MESSAGES, MINIAPP_MESSAGES];

const DICTS = { "en-US": {}, "fa-IR": {} };
for (let d = 0; d < DOMAINS.length; d++) {
  const domain = DOMAINS[d] || {};
  for (let i = 0; i < SUPPORTED_LOCALES.length; i++) {
    const locale = SUPPORTED_LOCALES[i];
    const messages = domain[locale] || {};
    Object.assign(DICTS[locale], messages);
  }
}

/** Coerce anything (Telegram language_code, stale value, null) to a supported locale. */
export function normalizeLocale(value) {
  if (value === null || value === undefined) return DEFAULT_LOCALE;
  const raw = String(value).trim().toLowerCase();
  if (raw === "fa" || raw === "fa-ir" || raw === "fa_ir" || raw.startsWith("fa-") || raw.startsWith("fa_")) return "fa-IR";
  if (raw === "en" || raw === "en-us" || raw === "en_us" || raw.startsWith("en-") || raw.startsWith("en_")) return "en-US";
  return DEFAULT_LOCALE;
}

/**
 * True when a raw value names a shipped locale (accepts the short/underscored
 * forms Telegram or a stale client may send). Unlike normalizeLocale this does
 * NOT silently coerce unknown values to the default — write paths need to be
 * able to reject "de-DE" instead of pretending it became en-US.
 */
export function isSupportedLocaleInput(value) {
  if (value === null || value === undefined) return false;
  const raw = String(value).trim().toLowerCase().replace(/_/g, "-");
  if (raw === "en" || raw === "en-us") return true;
  if (raw === "fa" || raw === "fa-ir") return true;
  return false;
}

/** Text direction for a locale. fa-IR is the only shipped RTL locale. */
export function directionFor(locale) {
  return normalizeLocale(locale) === "fa-IR" ? "rtl" : "ltr";
}

/** The locale stored on a user row, with a Telegram language_code fallback. */
export function localeForUser(user) {
  if (user && user.locale) return normalizeLocale(user.locale);
  if (user && user.language_code) return normalizeLocale(user.language_code);
  return DEFAULT_LOCALE;
}

function interpolate(template, params) {
  if (!params || typeof template !== "string") return template;
  return template.replace(/\{(\w+)\}/g, function (match, name) {
    if (params[name] === undefined || params[name] === null) return match;
    return String(params[name]);
  });
}

/** Translate a key for a locale. params fill `{name}` placeholders. */
export function t(locale, key, params) {
  const normalized = normalizeLocale(locale);
  let template = DICTS[normalized] ? DICTS[normalized][key] : undefined;
  if (template === undefined) template = DICTS[DEFAULT_LOCALE][key];
  if (template === undefined) return key;
  return interpolate(template, params);
}

/** Every translated string for a locale: what the Mini App fetches at boot. */
export function messagesForLocale(locale) {
  const normalized = normalizeLocale(locale);
  // Spread into a fresh object so callers cannot mutate the shared dictionary.
  const strings = {};
  const source = DICTS[normalized] || {};
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i++) strings[keys[i]] = source[keys[i]];
  // Fill gaps from en-US so the frontend never renders a raw key.
  const fallback = DICTS[DEFAULT_LOCALE];
  const fallbackKeys = Object.keys(fallback);
  for (let i = 0; i < fallbackKeys.length; i++) {
    if (strings[fallbackKeys[i]] === undefined) strings[fallbackKeys[i]] = fallback[fallbackKeys[i]];
  }
  return { locale: normalized, dir: directionFor(normalized), strings: strings };
}

export { DICTS as MESSAGE_DICTS };
