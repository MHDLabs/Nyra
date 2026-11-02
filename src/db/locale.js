// Per-user locale persistence (users.locale).
//
// The Mini App (and, through the same row, the Telegram bot) reads this value;
// GET /api/i18n and the prompt builder fall back to Telegram's language_code
// only while the column is still NULL. Writing a locale touches ONE column and
// one timestamp - memory, preferences, connections and history are untouched,
// so switching language can never lose data.
import { SUPPORTED_LOCALES, normalizeLocale, isSupportedLocaleInput, localeForUser } from "../i18n/index.js";
import { getUserStrict } from "./users.js";
import { now } from "../utils.js";

/** Stored locale for a user (null when never chosen, even if language_code exists). */
export async function getStoredUserLocale(env, userId) {
  const user = await getUserStrict(env, userId);
  if (!user) return null;
  return user.locale ? normalizeLocale(user.locale) : null;
}

/** Effective locale: stored value, else Telegram language_code, else en-US. */
export async function getUserLocale(env, userId) {
  const user = await getUserStrict(env, userId);
  return localeForUser(user);
}

/**
 * Persist a locale. Returns { ok, locale } or { ok: false, reason }.
 * Only the `locale` column (and `updated_at`) is written; the previous value is
 * replaced in place, never causing dependent data to be dropped.
 */
export async function setUserLocale(env, userId, locale) {
  if (!isSupportedLocaleInput(locale)) return { ok: false, reason: "invalid_locale" };
  const normalized = normalizeLocale(locale);
  if (SUPPORTED_LOCALES.indexOf(normalized) === -1) return { ok: false, reason: "invalid_locale" };
  const user = await getUserStrict(env, userId);
  if (!user) return { ok: false, reason: "not_found" };
  await env.DB.prepare("UPDATE users SET locale = ?, updated_at = ? WHERE telegram_id = ?")
    .bind(normalized, now(), userId).run();
  return { ok: true, locale: normalized };
}
