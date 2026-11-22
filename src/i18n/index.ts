// Centralized localization for every Nyra surface.
//
// Locale is persisted per user in `users.locale` and defaults to `en-US`.
// The Telegram bot reads a locale stored per user. Messages are grouped into
// small domain modules so the bot and admin-facing flows share one dictionary:
//
//   messages-core.js      shared generic strings (errors, common actions)
//   messages-telegram.js  bot messages: onboarding, commands, groups, maintenance
//
// `t(locale, key, params)` is the only way user-facing text should be produced.
// A missing key falls back to en-US, then to the key itself, so a missing
// translation degrades visibly instead of throwing.
import { CORE_MESSAGES } from "./messages-core.js";
import { TELEGRAM_MESSAGES } from "./messages-telegram.js";

export const SUPPORTED_LOCALES = ["en-US", "fa-IR"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = "en-US";

type MessageDict = Record<string, string>;
type LocaleTable = Record<SupportedLocale, MessageDict>;

const DOMAINS: Array<Partial<Record<string, MessageDict>>> = [
  CORE_MESSAGES as Partial<Record<string, MessageDict>>,
  TELEGRAM_MESSAGES as Partial<Record<string, MessageDict>>
];

const DICTS: LocaleTable = { "en-US": {}, "fa-IR": {} };
for (let d = 0; d < DOMAINS.length; d++) {
  const domain = DOMAINS[d] || {};
  for (let i = 0; i < SUPPORTED_LOCALES.length; i++) {
    const locale = SUPPORTED_LOCALES[i];
    const messages = domain[locale] || {};
    Object.assign(DICTS[locale], messages);
  }
}

/** Coerce anything (Telegram language_code, stale value, null) to a supported locale. */
export function normalizeLocale(value: unknown): SupportedLocale {
  if (value === null || value === undefined) return DEFAULT_LOCALE;
  const raw = String(value).trim().toLowerCase().replace(/_/g, "-");
  if (raw === "en" || raw === "en-us") return "en-US";
  if (raw === "fa" || raw === "fa-ir") return "fa-IR";
  return DEFAULT_LOCALE;
}

/**
 * True only for supported locale tags (and common short forms a
 * stale client may send). Unlike normalizeLocale this does
 * NOT silently coerce unknown values to the default — write paths need to be
 * able to reject "de-DE" instead of pretending it became en-US.
 */
export function isSupportedLocaleInput(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const raw = String(value).trim().toLowerCase().replace(/_/g, "-");
  if (raw === "en" || raw === "en-us") return true;
  if (raw === "fa" || raw === "fa-ir") return true;
  return false;
}

/** Text direction for a locale. fa-IR is the only shipped RTL locale. */
export function directionFor(locale: unknown): "rtl" | "ltr" {
  return normalizeLocale(locale) === "fa-IR" ? "rtl" : "ltr";
}

type UserLocaleSource = {
  locale?: string | null;
  language_code?: string | null;
};

/** The locale stored on a user row, with a Telegram language_code fallback. */
export function localeForUser(user: UserLocaleSource | null | undefined): SupportedLocale {
  if (user && user.locale) return normalizeLocale(user.locale);
  if (user && user.language_code) return normalizeLocale(user.language_code);
  return DEFAULT_LOCALE;
}

function interpolate(template: string, params?: Record<string, unknown> | null): string {
  if (!params || typeof template !== "string") return template;
  return template.replace(/\{(\w+)\}/g, function (match, name: string) {
    if (params[name] === undefined || params[name] === null) return match;
    return String(params[name]);
  });
}

/** Translate a key for a locale. params fill `{name}` placeholders. */
export function t(
  locale: unknown,
  key: string,
  params?: Record<string, unknown> | null
): string {
  const normalized = normalizeLocale(locale);
  let template: string | undefined = DICTS[normalized] ? DICTS[normalized][key] : undefined;
  if (template === undefined) template = DICTS[DEFAULT_LOCALE][key];
  if (template === undefined) return key;
  return interpolate(template, params);
}

export { DICTS as MESSAGE_DICTS };
