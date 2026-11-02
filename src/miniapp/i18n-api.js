// Localization API for the Mini App. The client fetches ONE dictionary after
// authentication and renders every label through it; it never hardcodes a
// translation and localStorage is not the source of truth.
//
//   GET  /api/i18n          -> dictionary + the user's stored locale
//   POST /api/user/locale   -> persist users.locale (no other column touched)
import {
  SUPPORTED_LOCALES, DEFAULT_LOCALE, messagesForLocale, normalizeLocale,
  directionFor, isSupportedLocaleInput, localeForUser, t
} from "../i18n/index.js";
import { getUserStrict } from "../db/users.js";
import { setUserLocale } from "../db/locale.js";
import { jsonOk, jsonError } from "./respond.js";

/** Dictionary for the user, optionally previewed in another supported locale. */
export async function handleI18n(env, userId, url) {
  let user = null;
  try {
    user = await getUserStrict(env, userId);
  } catch (err) {
    console.error("handleI18n user lookup failed:", err.message);
    return jsonError(500, t(DEFAULT_LOCALE, "common.database_unavailable"));
  }
  if (!user) return jsonError(404, t(DEFAULT_LOCALE, "common.not_found"));

  const stored = user.locale ? normalizeLocale(user.locale) : null;
  let locale = stored || localeForUser(user);
  const requested = url && url.searchParams ? url.searchParams.get("locale") : null;
  if (requested) {
    if (!isSupportedLocaleInput(requested)) {
      return jsonError(400, t(locale, "i18n.unsupported_locale"));
    }
    locale = normalizeLocale(requested);
  }
  const bundle = messagesForLocale(locale);
  return jsonOk({
    locale: bundle.locale,
    dir: bundle.dir,
    strings: bundle.strings,
    stored_locale: stored,
    supported_locales: SUPPORTED_LOCALES,
    default_locale: DEFAULT_LOCALE
  });
}

/**
 * Persist the user's locale. Validation is strict on purpose: an unrecognized
 * value is rejected rather than silently normalized to en-US, so a client bug
 * cannot flip a Persian user's language without them choosing it.
 */
export async function handleSetLocale(env, userId, body) {
  const raw = body ? body.locale : undefined;
  if (!isSupportedLocaleInput(raw)) {
    let locale = DEFAULT_LOCALE;
    try { locale = await currentLocale(env, userId); } catch (err) {}
    return jsonError(400, t(locale, "i18n.unsupported_locale"));
  }
  let result;
  try {
    result = await setUserLocale(env, userId, raw);
  } catch (err) {
    console.error("handleSetLocale failed:", err.message);
    return jsonError(500, t(raw, "common.database_unavailable"));
  }
  if (!result.ok && result.reason === "not_found") return jsonError(404, t(raw, "common.not_found"));
  if (!result.ok) return jsonError(400, t(raw, "i18n.unsupported_locale"));
  const bundle = messagesForLocale(result.locale);
  return jsonOk({
    success: true,
    locale: bundle.locale,
    dir: bundle.dir,
    strings: bundle.strings
  });
}

async function currentLocale(env, userId) {
  const user = await getUserStrict(env, userId);
  return localeForUser(user);
}

/** Direction for a locale, re-exported so route tests can assert parity. */
export { directionFor };
