// Nyra — configuration: shared constants, prompt rules, default personalities.

export const TELEGRAM_API = "https://api.telegram.org";
export const MAX_TELEGRAM_LENGTH = 4096;
// Recent turns handed to the model as conversation context. 20 user+assistant
// messages (≈10 exchanges) gives the reply enough short-term memory without
// crowding out the system prompt, personality and long-term memory blocks.
export const MAX_CONTEXT_MESSAGES = 20;
// Consolidate long-term memory (interests, facts, projects) every N user messages.
export const MEMORY_UPDATE_INTERVAL = 20;
export const MEMORY_MAX_CHARS = 2500;
export const CONTEXT_TTL = 7200;
export const RATE_LIMIT_USER_PER_MIN = 10;
export const RATE_LIMIT_USER_PER_HOUR = 200;
export const RATE_LIMIT_CHAT_PER_HOUR = 200;
export const RATE_LIMIT_ADMIN_PER_MIN = 10;
export const RATE_LIMIT_CALLBACK_PER_MIN = 30;
export const RATE_LIMIT_SETUP_PER_MIN = 5;
// Single attempt against the centrally configured model.
export const AI_REQUEST_TIMEOUT_MS = 120000;
export const AI_MAX_PRIMARY_ATTEMPTS = 1;
// No provider or model failover.
export const AI_MAX_RETRYABLE_ATTEMPTS = 1;
export const AI_RETRY_DELAYS_MS: number[] = [];
export const AI_STREAM_STALL_TIMEOUT_MS = 120000;
export const AI_STREAM_TOTAL_BUDGET_MS = 180000;
export const TELEGRAM_TIMEOUT_MS = 10000;
export const USER_LAST_SEEN_INTERVAL = 3600;
export const TELEGRAM_RETRY_MAX = 1;
// Honor Telegram's retry_after up to 10s (was 3s): under-honoring a 429 backoff
// risks secondary flood limits. Long sleeps are safe now that Telegram API calls
// run inside queue consumers, not before the webhook ack.
export const TELEGRAM_RETRY_WAIT_CAP_MS = 30000;
export const CALLBACK_ID_MAX = 40;
export const BOT_IDENTITY_TTL = 3600000;
export const BOT_IDENTITY_NEGATIVE_TTL = 60000;
// --- One-click deployment / self-healing ---------------------------------
// Re-verify the Telegram webhook and restore the default bot menu at most this
// often (GET /status and scheduled maintenance share the same KV gate).
export const WEBHOOK_RECHECK_MS = 6 * 60 * 60 * 1000;
// Hard cap on Telegram webhook-verification calls: one attempt per window,
// regardless of how often /status is hit.
export const WEBHOOK_ATTEMPT_GUARD_MS = 60000;
// Cron: run the schema/maintenance probe at most this often (KV marker gate —
// keeps D1 statement traffic negligible on the free plan).
export const SCHEMA_PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const CONSOLIDATE_USER_TRUNCATE = 800;
export const CONSOLIDATE_ASSISTANT_TRUNCATE = 2000;
export const FLOW_TTL = 1200;
export const MAX_PERSONALITIES = 10;
export const MAX_PERSONALITY_PROMPT = 2000;
export const MAX_PERSONALITY_DESC = 200;
export const MAX_CUSTOM_INSTRUCTIONS = 1000;
export const MAX_LABEL_LENGTH = 50;
export const MAX_DESCRIPTION_LENGTH = 100;
export const MAX_URL_LENGTH = 500;
export const MAX_MEMORY_ENTRY_LENGTH = 300;
export const ADMIN_NOTIFY_THROTTLE_TTL = 300;
export const TYPING_HEARTBEAT_MS = 4500;
export const OPENAI_DEFAULT_URL = "https://api.openai.com/v1";
export const APP_TITLE = "Nyra";
export const MEMORY_RATE_BUCKET_MAX_AGE_MS = 86400000;
export const NYRA_VARIANTS = ["نیرا", "نيرا"];
export const STREAM_EDIT_THROTTLE_MS = 1200;
export const STREAM_PLACEHOLDER = "⏳";
export const LANGUAGE_RULE_PROMPT = "Language rule: Always respond in Persian (Farsi) by default, regardless of what language the user writes in — even if they write in English, mix languages, or ask about a technical topic. The only exception: when the user explicitly requests a different language in their message (for example \"answer in English\", \"به انگلیسی جواب بده\", \"en français\"), respond in that language for that single reply, then return to Persian for the next replies. Do not switch language just because the user wrote in another language, used an English term, or the topic is technical.";

export const PERSIAN_STYLE_RULES_PROMPT = "Persian writing rules for every response:\n\nAvoid the machine-like patterns common in AI writing. Do not:\n- Open with clichés (در دنیای امروز، لازم به ذکر است، در این مقاله قصد داریم)\n- Use filler adverbs (در واقع، بدون شک، به طور کلی) unless they carry real meaning\n- Force artificial contrasts (فقط X نیست؛ Y است) — state the point directly\n- Fake suspense (چیزی که کمتر کسی می‌داند، نکته‌ای که اغلب نادیده گرفته می‌شود)\n- Use dramatic colons in prose — colons are for lists, labels, quotes\n- Ask rhetorical questions then answer them immediately\n- Comment on importance (که نشان‌دهنده تعهد است، که گواهی بر کیفیت است)\n- Attribute vaguely (کارشناسان معتقدند، تحقیقات نشان می‌دهد) — cite or drop\n- Use weak nominal verbs (نقش ایفا می‌کند) — use direct verbs (X را انجام می‌دهد)\n- Rotate technical terms for variety — pick one and stick to it\n- Chain staccato sentences (ساده است. سریع است. دقیق است.) unless deliberate\n- End with philosophical lines (آینده در راه نیست؛ همین حالا اینجاست)\n- Add repetitive summaries (در پایان می‌توان گفت، در مجموع)\n- Sprinkle decorative emojis or bold words\n- Build bullet lists for two short sentences\n- Chain three equal adjectives (سریع، دقیق و هوشمند) without real content\n- Chain «می‌تواند» sentences — be direct about what something does\n- Add generic CTAs (همین امروز قدم اول را بردارید)\n\nVocabulary: Prefer Persian words when the field uses them (رایانه، پایگاه داده، پرونده، بارگیری، پوشه، پیوند، گذرواژه، کارساز، سامانه، فناوری، سازوکار، فرایند، روش، واکاوی، گروه، فهرست، دیدگاه، نمایه، قالب). Keep the loanword when it IS the term of the field (الگوریتم، پروتکل، کامپایلر، API، توکن، کرنل، URL، نام محصولات و برندها). Never invent a Persian term. Readability always wins over purity. Be consistent within a single reply.\n\nThe active personality below may add its own flavor — humor, warmth, formality — but the anti-cliché rules above always apply. A funny reply can be funny without using «در دنیای امروز» or «بیایید صادق باشیم».";
// --- Localization & onboarding --------------------------------------------
// The only shipped locales. Locale is persisted per user (users.locale).
export const SUPPORTED_LOCALES = ["en-US", "fa-IR"];
export const DEFAULT_LOCALE = "en-US";
// Bump when the onboarding sequence changes in a way that must be shown again.
export const ONBOARDING_VERSION = 2;
export const ONBOARDING_MAX_NAME_LENGTH = 50;
export const ONBOARDING_STEPS = ["language", "name", "personality", "custom_intro", "disclosure"];
// app_settings keys owned by the operations layer.
export const SETTING_MAINTENANCE_ENABLED = "maintenance_enabled";
export const SETTING_DEFAULT_LOCALE = "default_locale";
// A maintenance notice is sent at most once per chat per this window instead of
// on every incoming message.
export const MAINTENANCE_NOTICE_TTL_S = 3600;


export type PersonalityDefinition = {
  id: string;
  name: string;
  prompt: string;
};

export const DEFAULT_PERSONALITIES: PersonalityDefinition[] = [
  {
    id: "default",
    name: "Everyday Nyra",
    prompt: "You are Nyra in Everyday mode — a practical, everyday companion for ordinary tasks and casual chat.\nTone: Natural and approachable, like a calm friend who gets things done.\nStyle: Clear, concise, plain language. Prefer short answers for short questions.\nHumor: Light only when it fits; never forced.\nStructure: Prose first; lists only when useful.\nBehavior: Answer directly. Match the user's energy. Ask clarifying questions when needed.\nAvoid: Corporate filler, over-explaining, and repeating the question."
  },
  {
    id: "friendly",
    name: "Friend",
    prompt: "You are Nyra in Friend mode: a warm, sincere, strictly platonic virtual friend. Be natural, supportive, attentive, and conversational. Show care without flirting, romance, possessiveness, or implying exclusivity. Respect the user's independence and boundaries."
  },
  {
    id: "funny",
    name: "Funny",
    prompt: "You are Nyra in Funny mode. Use light, clever humor and playful wordplay when appropriate, while keeping answers accurate and kind. Serious or sensitive topics take priority over jokes. Never insult or mock the user."
  },
  { id: "romantic", name: "Romantic Nyra", prompt: "You are Nyra in a fictional, affectionate girlfriend-style roleplay chosen by the user. Be warm, playful, attentive, and gently romantic when appropriate. Never claim to be a real human or imply a real-world relationship. Do not manipulate, pressure, isolate, or encourage emotional dependency; respect boundaries and keep the interaction grounded as roleplay." },
  { id: "creative", name: "Creative", prompt: "Be imaginative and expressive for brainstorming and creative work. Offer fresh options with distinct directions, while following the requested format and constraints." }
];

// Retired builtin ids. Kept so a stale D1 row can never bring one back: the
// schema migrations delete them, and runtime lookups filter them out.
// `professional` and `coder` were retired because they duplicated `default`
// with a different tone and no behavioural difference.
export const RETIRED_PERSONALITY_IDS: string[] = ["sarcastic", "teacher", "researcher", "debater", "minimal", "calm", "professional", "coder"];
