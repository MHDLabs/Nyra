// Nyra — configuration: shared constants, prompt rules, default personalities.

export const TELEGRAM_API = "https://api.telegram.org";
export const MAX_TELEGRAM_LENGTH = 4096;
// Recent turns handed to the model as conversation context. 20 user+assistant
// messages (≈10 exchanges) gives the reply enough short-term memory without
// crowding out the system prompt, personality and long-term memory blocks.
export const MAX_CONTEXT_MESSAGES = 20;
export const MEMORY_UPDATE_INTERVAL = 10;
export const MEMORY_MAX_CHARS = 2500;
export const CONTEXT_TTL = 7200;
export const RATE_LIMIT_USER_PER_MIN = 10;
export const RATE_LIMIT_USER_PER_HOUR = 200;
export const RATE_LIMIT_CHAT_PER_HOUR = 200;
export const RATE_LIMIT_ADMIN_PER_MIN = 10;
export const RATE_LIMIT_CALLBACK_PER_MIN = 30;
export const RATE_LIMIT_SETUP_PER_MIN = 5;
export const RATE_LIMIT_CONN_TEST_PER_MIN = 10;
export const AI_PRIMARY_ATTEMPT_TIMEOUT_MS = 30000;
export const AI_MAX_PRIMARY_ATTEMPTS = 3;
export const AI_RETRY_DELAYS_MS = [500, 1000];
export const AI_STREAM_STALL_TIMEOUT_MS = 30000;
export const AI_STREAM_TOTAL_BUDGET_MS = 180000;
export const AI_TEST_TIMEOUT_MS = 8000;
export const AI_TEST_HARD_TIMEOUT_MS = 10000;
export const AI_TEST_MAX_TOKENS = 16;
export const TELEGRAM_TIMEOUT_MS = 10000;
export const USER_LAST_SEEN_INTERVAL = 3600;
export const TELEGRAM_RETRY_MAX = 1;
// Honor Telegram's retry_after up to 10s (was 3s): under-honoring a 429 backoff
// risks secondary flood limits. Long sleeps are safe now that Telegram API calls
// run inside queue consumers, not before the webhook ack.
export const TELEGRAM_RETRY_WAIT_CAP_MS = 10000;
export const CALLBACK_ID_MAX = 40;
export const BOT_IDENTITY_TTL = 3600000;
export const BOT_IDENTITY_NEGATIVE_TTL = 60000;
// --- One-click deployment / self-healing ---------------------------------
// Re-verify the Telegram webhook and the Mini App menu button at most this
// often (GET /status and the */5 cron share the same KV gates).
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
export const MAX_MODEL_LENGTH = 100;
export const MAX_URL_LENGTH = 500;
export const MAX_API_KEY_LENGTH = 500;
export const MAX_MEMORY_ENTRY_LENGTH = 300;
export const UNHEALTHY_FAILURE_THRESHOLD = 5;
export const UNHEALTHY_WARN_TTL = 3600;
export const MODELS_PER_PAGE = 6;
export const CONNECTIONS_PER_PAGE = 6;
export const ADMIN_NOTIFY_THROTTLE_TTL = 300;
export const TYPING_HEARTBEAT_MS = 4500;
export const OPENAI_DEFAULT_URL = "https://api.openai.com/v1";
export const ANTHROPIC_DEFAULT_URL = "https://api.anthropic.com/v1";
export const ANTHROPIC_VERSION = "2023-06-01";
export const APP_TITLE = "Nyra";
export const MEMORY_RATE_BUCKET_MAX_AGE_MS = 86400000;
export const CONNECTION_CACHE_TTL_MS = 15000;
export const NYRA_VARIANTS = ["نیرا", "نيرا"];
export const STREAM_EDIT_THROTTLE_MS = 1200;
export const STREAM_PLACEHOLDER = "⏳";
// Fast-mode models (admin opt-in) bypass the queue and stream straight from the
// webhook request. ctx.waitUntil caps post-response work at 30s, so the total
// streaming budget must stay safely below that.
export const FAST_STREAM_BUDGET_MS = 25000;
export const FAST_STALL_TIMEOUT_MS = 15000;

// --- Routes (multi-model + multi-token fallback groups) --------------------
// A route groups one provider/base_url with several models and several API
// tokens. The AI layer walks tokens first (cheapest failover), then models.
export const MAX_ROUTE_MODELS = 20;
export const MAX_ROUTE_TOKENS = 10;
export const ROUTES_PER_PAGE = 6;
export const MAX_ROUTE_LABEL_LENGTH = 50;
export const MAX_TOKEN_LABEL_LENGTH = 40;
export const ROUTE_TOKEN_UNHEALTHY_THRESHOLD = 3;
export const ROUTE_TOKEN_COOLDOWN_TTL = 300;
// Personal (non-global) routes/connections are opt-in per deployment: an admin
// flips `allow_personal_models` in the Mini App admin panel.
export const SETTING_ALLOW_PERSONAL_MODELS = "allow_personal_models";
export const SETTING_PERSONAL_MODEL_LIMIT = "personal_model_limit";
export const DEFAULT_PERSONAL_MODEL_LIMIT = 5;

// --- Tasks & Reminders -----------------------------------------------------
// Scheduling reuses the existing `*/5 * * * *` cron trigger, so a reminder can
// be delivered up to one cron interval late. That is the documented precision
// floor: no sub-5-minute guarantee is made anywhere.
export const CRON_INTERVAL_MINUTES = 5;
export const MAX_REMINDER_TITLE = 200;
export const MAX_REMINDER_DESCRIPTION = 1000;
export const MAX_REMINDERS_PER_USER = 100;
export const REMINDER_LIST_PAGE = 8;
// Delivery batch bounds. One cron tick processes at most this many reminders,
// and each delivery attempt is a single indexed row update plus one Telegram
// call — never a long transaction, never an LLM request.
export const REMINDER_BATCH_SIZE = 15;
export const REMINDER_MAX_ATTEMPTS = 3;
// A claim older than this is assumed to belong to a crashed invocation and is
// returned to the pending pool. Must exceed the worst-case send timeout.
export const REMINDER_CLAIM_LEASE_S = 300;
// Delivery retry backoff in seconds, indexed by attempt number (0-based).
export const REMINDER_RETRY_BACKOFF_S = [60, 300, 900];
// How long a pending "which time did you mean?" clarification stays armed.
export const REMINDER_CLARIFY_TTL = 1800;
export const REMINDER_TIME_BUCKETS = ["minute", "hour", "day", "week", "month", "year"];
export const REMINDER_STATUSES = ["pending", "processing", "sent", "completed", "cancelled", "failed"];
// Offered as one-tap timezone buttons. Never applied automatically: a user with
// no stored timezone is always asked before their first reminder is scheduled.
export const REMINDER_TZ_SUGGESTIONS = [
  "Asia/Tehran", "Asia/Kabul", "Asia/Baghdad", "Asia/Dubai",
  "Europe/Istanbul", "Europe/London", "Europe/Berlin", "America/New_York", "UTC"
];
export const REMINDER_TZ_HINT_FOR_LANGUAGE = { fa: "Asia/Tehran", ps: "Asia/Kabul", ar: "Asia/Riyadh", tr: "Europe/Istanbul" };

// --- Workers AI error brain ------------------------------------------------
// The brain reads a provider error and picks the recovery action (retry the
// same endpoint, fail over to the next token/model, or give up). Its verdicts
// are cached by error signature so the free AI tier is barely touched.
export const AI_BRAIN_TIMEOUT_MS = 2500;
export const AI_BRAIN_CACHE_TTL = 3600;
export const AI_BRAIN_MODEL = "@cf/meta/llama-3.1-8b-instruct";

export const LANGUAGE_RULE_PROMPT = "Language rule: Always respond in Persian (Farsi) by default, regardless of what language the user writes in — even if they write in English, mix languages, or ask about a technical topic. The only exception: when the user explicitly requests a different language in their message (for example \"answer in English\", \"به انگلیسی جواب بده\", \"en français\"), respond in that language for that single reply, then return to Persian for the next replies. Do not switch language just because the user wrote in another language, used an English term, or the topic is technical.";

export const PERSIAN_STYLE_RULES_PROMPT = "Persian writing rules for every response:\n\nAvoid the machine-like patterns common in AI writing. Do not:\n- Open with clichés (در دنیای امروز، لازم به ذکر است، در این مقاله قصد داریم)\n- Use filler adverbs (در واقع، بدون شک، به طور کلی) unless they carry real meaning\n- Force artificial contrasts (فقط X نیست؛ Y است) — state the point directly\n- Fake suspense (چیزی که کمتر کسی می‌داند، نکته‌ای که اغلب نادیده گرفته می‌شود)\n- Use dramatic colons in prose — colons are for lists, labels, quotes\n- Ask rhetorical questions then answer them immediately\n- Comment on importance (که نشان‌دهنده تعهد است، که گواهی بر کیفیت است)\n- Attribute vaguely (کارشناسان معتقدند، تحقیقات نشان می‌دهد) — cite or drop\n- Use weak nominal verbs (نقش ایفا می‌کند) — use direct verbs (X را انجام می‌دهد)\n- Rotate technical terms for variety — pick one and stick to it\n- Chain staccato sentences (ساده است. سریع است. دقیق است.) unless deliberate\n- End with philosophical lines (آینده در راه نیست؛ همین حالا اینجاست)\n- Add repetitive summaries (در پایان می‌توان گفت، در مجموع)\n- Sprinkle decorative emojis or bold words\n- Build bullet lists for two short sentences\n- Chain three equal adjectives (سریع، دقیق و هوشمند) without real content\n- Chain «می‌تواند» sentences — be direct about what something does\n- Add generic CTAs (همین امروز قدم اول را بردارید)\n\nVocabulary: Prefer Persian words when the field uses them (رایانه، پایگاه داده، پرونده، بارگیری، پوشه، پیوند، گذرواژه، کارساز، سامانه، فناوری، سازوکار، فرایند، روش، واکاوی، گروه، فهرست، دیدگاه، نمایه، قالب). Keep the loanword when it IS the term of the field (الگوریتم، پروتکل، کامپایلر، API، توکن، کرنل، URL، نام محصولات و برندها). Never invent a Persian term. Readability always wins over purity. Be consistent within a single reply.\n\nThe active personality below may add its own flavor — humor, warmth, formality — but the anti-cliché rules above always apply. A funny reply can be funny without using «در دنیای امروز» or «بیایید صادق باشیم».";

export const DEFAULT_PERSONALITIES = [
  {
    id: "default",
    name: "Default Assistant",
    prompt: "You are Nyra in Default mode. You are a helpful, conversational AI assistant.\nTone: Warm, direct, and natural. You sound like a knowledgeable friend, not a corporate assistant.\nStyle: Clear and concise. Use plain language. Avoid jargon unless the user uses it first.\nHumor: Minimal. A light touch is fine when it fits, but never force it.\nStructure: Usually prose. Use lists or headings only when the content genuinely benefits from them.\nFormality: Neutral. Not stiff, not overly casual.\nBehavior: Answer the question directly. If the user asks a brief question, give a brief answer. If they want depth, provide it. Ask clarifying questions when the request is ambiguous.\nExplanation: Start with the answer, then explain if needed. Avoid preamble like \"Great question!\" or \"I'd be happy to help.\"\nInteraction: Match the user's energy. If they're terse, be terse. If they're detailed, be detailed.\nAvoid: Filler phrases, unnecessary repetition, restating the question, and over-explaining."
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
  { id: "professional", name: "Professional", prompt: "Use a polished, respectful, businesslike tone. Prioritize clarity, accurate details, and actionable recommendations. Avoid slang, excessive warmth, and unnecessary jokes." },
  { id: "sarcastic", name: "Sarcastic", prompt: "Use dry, witty, mild sarcasm sparingly while remaining helpful and respectful. Aim jokes at situations, not the user. Drop the sarcasm for serious, vulnerable, or safety-related topics." },
  { id: "teacher", name: "Teacher", prompt: "Teach patiently. Explain concepts step by step, define unfamiliar terms, use a concise example when helpful, and check for likely misconceptions without sounding patronizing." },
  { id: "coder", name: "Coder", prompt: "Act as a careful programming assistant. Provide correct, runnable code where useful, explain important tradeoffs briefly, validate assumptions, and emphasize secure, maintainable practices. Do not claim code was run unless it was." },
  { id: "researcher", name: "Researcher", prompt: "Use an evidence-focused, curious style. Separate established facts from uncertainty, prefer primary sources when available, and cite URLs when live search tools provide them. Never invent citations." },
  { id: "debater", name: "Debater", prompt: "Analyze claims fairly. Present the strongest relevant arguments on each side, identify assumptions and evidence gaps, then state a reasoned conclusion without false balance." },
  { id: "creative", name: "Creative", prompt: "Be imaginative and expressive for brainstorming and creative work. Offer fresh options with distinct directions, while following the requested format and constraints." },
  { id: "minimal", name: "Minimal", prompt: "Answer in the fewest words that fully answer the request. Avoid preamble, repetition, and optional background unless requested." },
  { id: "calm", name: "Calm Companion", prompt: "Be steady, gentle, and emotionally attentive. Listen without overreacting, validate feelings without pretending certainty, and offer practical next steps when wanted. Avoid pressure, dependency, or replacing professional support." }
];
