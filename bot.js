const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { configuredWeekendServiceDates, serviceDayForDateParts } = require("./transport-calendar");
const { buildTransitOptions, prepareTransitNetwork } = require("./trip-planner");

const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const envText = fs.readFileSync(envPath, "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...valueParts] = trimmed.split("=");
    const key = rawKey.replace(/^\uFEFF/, "");
    if (!process.env[key]) {
      process.env[key] = valueParts.join("=").trim();
    }
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : "";
const PORT = Number(process.env.PORT || 0);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const WEBHOOK_PATH = `/telegram${WEBHOOK_SECRET ? `/${WEBHOOK_SECRET}` : ""}`;
const MINI_APP_PATH = "/transport";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_TOKEN || process.env.GEMINI_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MINI_APP_ALLOW_LOCAL_UNVERIFIED = process.env.MINI_APP_ALLOW_LOCAL_UNVERIFIED === "true";
const WEATHER_NOTIFICATIONS_WORKER_URL = String(process.env.WEATHER_NOTIFICATIONS_WORKER_URL || "").trim().replace(/\/$/, "");
const WEATHER_NOTIFICATIONS_SHARED_SECRET = String(process.env.WEATHER_NOTIFICATIONS_SHARED_SECRET || "").trim();
const WEATHER_NOTIFICATIONS_DELIVERY_PATH = "/internal/weather-notifications/deliver";
const PRO_PRODUCT_CODE = "skypulse-pro-monthly-v1";
const PRO_MONTHLY_PRICE_STARS = boundedIntegerEnv("PRO_MONTHLY_PRICE_STARS", 10, 1, 10000);
const PRO_SUBSCRIPTION_PERIOD_SECONDS = 30 * 24 * 60 * 60;
const PRO_INVOICE_TTL_SECONDS = 20 * 60;
const PRO_PAYMENTS_ENABLED = process.env.PRO_PAYMENTS_ENABLED !== "false";
const PRO_PAYMENT_SIGNING_SECRET = String(process.env.PRO_PAYMENT_SIGNING_SECRET || BOT_TOKEN || "");
const PAYMENT_SUPPORT_USERNAME = String(process.env.PAYMENT_SUPPORT_USERNAME || "pitrparkeryouoi").trim().replace(/^@+/, "");
const COMPLIMENTARY_PRO_USER_IDS = [...new Set(
  String(process.env.COMPLIMENTARY_PRO_USER_IDS || "")
    .split(",")
    .map((value) => telegramUserId(value.trim()))
    .filter(Boolean)
)];
const COMPLIMENTARY_PRO_USERNAME_GIFTS = parseComplimentaryProUsernameGifts(
  process.env.COMPLIMENTARY_PRO_USERNAME_GIFTS
);
const GRODNO_TIME_ZONE = "Europe/Minsk";
const BELARUS_WEEKEND_SERVICE_DATES = configuredWeekendServiceDates(process.env.BELARUS_WEEKEND_SERVICE_DATES);
const MAX_MESSAGE_TEXT_LENGTH = 160;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_MESSAGES = 18;
const RATE_LIMIT_MAX_CALLBACKS = 40;
const MAX_EXTERNAL_RESPONSE_BYTES = 2 * 1024 * 1024;
const CALLBACK_TOKEN_TTL_MS = 30 * 60 * 1000;
const MAX_CALLBACK_TOKENS = 500;
const SESSION_TTL_MS = 30 * 60 * 1000;
const ADVICE_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_FAVORITE_ROUTES = 12;
const MINI_APP_API_WINDOW_MS = 60 * 1000;
const MINI_APP_API_MAX_REQUESTS = 90;
const MINI_APP_AI_WINDOW_MS = 60 * 1000;
const MINI_APP_AI_MAX_REQUESTS = 8;
const MINI_APP_NOTIFICATION_WINDOW_MS = 60 * 1000;
const MINI_APP_NOTIFICATION_MAX_REQUESTS = 8;
const WEATHER_NOTIFICATION_MAX_RECIPIENTS = 30;
const MINI_APP_TRIP_WINDOW_MS = 60 * 1000;
const MINI_APP_TRIP_MAX_REQUESTS = 4;
const MINI_APP_INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;
const NOMINATIM_MIN_INTERVAL_MS = 1100;
const NOMINATIM_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const OSM_NETWORK_CACHE_MS = 12 * 60 * 60 * 1000;
const OSM_OVERPASS_URL = process.env.OSM_OVERPASS_URL || "https://maps.mail.ru/osm/tools/overpass/api/interpreter";
const OSM_NOMINATIM_URL = process.env.OSM_NOMINATIM_URL || "https://nominatim.openstreetmap.org/search";
const OSM_USER_AGENT = "SkyPulseWeatherBot/1.0 (https://t.me/SkyPulseWeatherBot)";
const PREFERENCES_FILE = process.env.PREFERENCES_FILE || path.join(__dirname, "data", "user-preferences.json");

const userSessions = new Map();
const userLanguages = new Map();
const lastClothingAdvice = new Map();
const rateBuckets = new Map();
const miniAppApiRateBuckets = new Map();
const miniAppAiRateBuckets = new Map();
const miniAppNotificationRateBuckets = new Map();
const miniAppTripRateBuckets = new Map();
const userPreferences = new Map();
const transportCache = {
  routes: { value: null, expiresAt: 0 },
  stops: { value: null, expiresAt: 0 },
  routeLists: new Map(),
  routePages: new Map(),
  stopPages: new Map()
};
const callbackStore = new Map();
const tripPlannerCache = {
  geocodes: new Map(),
  osmNetwork: { value: null, expiresAt: 0 }
};
let offset = 0;
let lastStateCleanupAt = 0;
let nominatimQueue = Promise.resolve();
let nextNominatimRequestAt = 0;

function boundedIntegerEnv(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error?.message || error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error?.message || error);
});

function securityHeaders(contentType = "text/plain; charset=utf-8") {
  return {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Content-Security-Policy": "default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self' 'unsafe-inline' https://telegram.org https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org; form-action 'self'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cache-Control": "no-store"
  };
}

function isRateLimited(chatId, kind = "message") {
  const now = Date.now();
  cleanupRuntimeState(now);
  const key = `${chatId}:${kind}`;
  const limit = kind === "callback" ? RATE_LIMIT_MAX_CALLBACKS : RATE_LIMIT_MAX_MESSAGES;
  const bucket = rateBuckets.get(key) || [];
  const fresh = bucket.filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
  fresh.push(now);
  rateBuckets.set(key, fresh);
  return fresh.length > limit;
}

function isLocalRequest(req) {
  const address = String(req.socket?.remoteAddress || "");
  return address === "::1" || address === "127.0.0.1" || address.startsWith("::ffff:127.");
}

function validateMiniAppInitData(rawInitData) {
  if (!BOT_TOKEN || !rawInitData || typeof rawInitData !== "string" || rawInitData.length > 8192) return null;
  const params = new URLSearchParams(rawInitData);
  const providedHash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  if (!providedHash || !/^[a-f0-9]{64}$/i.test(providedHash) || !Number.isInteger(authDate)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 300 || now - authDate > MINI_APP_INIT_DATA_MAX_AGE_SECONDS) return null;

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const expected = crypto.createHmac("sha256", secret).update(dataCheckString).digest();
  const received = Buffer.from(providedHash, "hex");
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;

  try {
    const user = JSON.parse(params.get("user") || "{}");
    const userId = String(user?.id || "");
    if (/^\d{1,20}$/.test(userId)) return { key: `telegram:${userId}`, userId };
  } catch {
    // A valid Mini App request can omit user data in some launch contexts.
  }
  return { key: `telegram:${params.get("query_id") || providedHash}` };
}

function miniAppAuthorization(req) {
  if (MINI_APP_ALLOW_LOCAL_UNVERIFIED && isLocalRequest(req)) {
    return { key: `local:${req.socket?.remoteAddress || "unknown"}` };
  }
  return validateMiniAppInitData(String(req.headers["x-telegram-init-data"] || ""));
}

function miniAppClientKey(req, authorization = null) {
  if (authorization?.key) return authorization.key;
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

function telegramUserId(value) {
  const userId = String(value || "");
  return /^\d{1,20}$/.test(userId) ? userId : null;
}

function telegramUsername(value) {
  const username = String(value || "").trim().replace(/^@+/, "").toLowerCase();
  return /^[a-z][a-z0-9_]{4,31}$/.test(username) ? username : null;
}

function parseComplimentaryProUsernameGifts(value) {
  const gifts = new Map();
  for (const rawGift of String(value || "").split(",")) {
    const [rawUsername, rawMonths, ...extraParts] = rawGift.trim().split(":");
    const username = telegramUsername(rawUsername);
    const months = Number(rawMonths);
    if (extraParts.length || !username || !Number.isInteger(months) || months < 1 || months > 24) continue;
    gifts.set(username, months);
  }
  return gifts;
}

function addCalendarMonthsToEpoch(startEpoch, months) {
  const start = Number(startEpoch);
  const durationMonths = Number(months);
  if (!Number.isSafeInteger(start) || start <= 0 || !Number.isInteger(durationMonths) || durationMonths < 1 || durationMonths > 24) {
    return null;
  }

  const date = new Date(start * 1000);
  const targetMonthIndex = date.getUTCMonth() + durationMonths;
  const targetYear = date.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = targetMonthIndex % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return Math.floor(Date.UTC(
    targetYear,
    targetMonth,
    Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds()
  ) / 1000);
}

function constantTimeTextEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function proInvoiceSignature(base, signingSecret = PRO_PAYMENT_SIGNING_SECRET) {
  if (!signingSecret) return "";
  return crypto.createHmac("sha256", signingSecret).update(base).digest("base64url").slice(0, 32);
}

function createProInvoicePayload(userId, nowSeconds = Math.floor(Date.now() / 1000), signingSecret = PRO_PAYMENT_SIGNING_SECRET) {
  const recipient = telegramUserId(userId);
  const issuedAt = Number(nowSeconds);
  if (!recipient || !Number.isInteger(issuedAt) || !signingSecret) {
    throw new Error("Could not create a Pro invoice payload");
  }
  const expiresAt = issuedAt + PRO_INVOICE_TTL_SECONDS;
  const nonce = crypto.randomBytes(12).toString("base64url");
  const base = `${PRO_PRODUCT_CODE}.${recipient}.${expiresAt}.${nonce}`;
  return `${base}.${proInvoiceSignature(base, signingSecret)}`;
}

function parseProInvoicePayload(value, nowSeconds = Math.floor(Date.now() / 1000), signingSecret = PRO_PAYMENT_SIGNING_SECRET) {
  const payload = String(value || "");
  const now = Number(nowSeconds);
  if (!Number.isInteger(now) || !signingSecret || payload.length > 128) return null;

  const parts = payload.split(".");
  if (parts.length !== 5 || parts[0] !== PRO_PRODUCT_CODE) return null;
  const [, rawUserId, rawExpiresAt, nonce, signature] = parts;
  const userId = telegramUserId(rawUserId);
  const expiresAt = Number(rawExpiresAt);
  if (!userId || !Number.isSafeInteger(expiresAt) || !/^[A-Za-z0-9_-]{16}$/.test(nonce) || !/^[A-Za-z0-9_-]{32}$/.test(signature)) {
    return null;
  }
  if (expiresAt <= now || expiresAt > now + PRO_INVOICE_TTL_SECONDS + 5 * 60) return null;

  const base = `${PRO_PRODUCT_CODE}.${userId}.${expiresAt}.${nonce}`;
  if (!constantTimeTextEqual(signature, proInvoiceSignature(base, signingSecret))) return null;
  return { userId, expiresAt };
}

function proCheckoutDetails(value, payerId, currency, totalAmount, nowSeconds = Math.floor(Date.now() / 1000), signingSecret = PRO_PAYMENT_SIGNING_SECRET) {
  const invoice = parseProInvoicePayload(value, nowSeconds, signingSecret);
  const payer = telegramUserId(payerId);
  if (!invoice || !payer || invoice.userId !== payer || currency !== "XTR" || Number(totalAmount) !== PRO_MONTHLY_PRICE_STARS) {
    return null;
  }
  return invoice;
}

function proPaymentChargeId(value) {
  const chargeId = String(value || "").trim();
  return chargeId.length >= 1 && chargeId.length <= 256 && !/[\r\n\u0000]/.test(chargeId) ? chargeId : null;
}

function proSuccessfulPaymentDetails(payment, payerId, nowSeconds = Math.floor(Date.now() / 1000), signingSecret = PRO_PAYMENT_SIGNING_SECRET) {
  const invoice = proCheckoutDetails(
    payment?.invoice_payload,
    payerId,
    payment?.currency,
    payment?.total_amount,
    nowSeconds,
    signingSecret
  );
  const expiresAt = Number(payment?.subscription_expiration_date);
  const chargeId = proPaymentChargeId(payment?.telegram_payment_charge_id);
  if (!invoice || !Number.isSafeInteger(expiresAt) || expiresAt <= Number(nowSeconds) || !chargeId) return null;
  return {
    ...invoice,
    expiresAt,
    chargeId,
    isFirstRecurring: payment?.is_first_recurring === true
  };
}

function isMiniAppApiRateLimited(req, authorization) {
  const now = Date.now();
  cleanupRuntimeState(now);
  const key = miniAppClientKey(req, authorization);
  const bucket = miniAppApiRateBuckets.get(key) || [];
  const fresh = bucket.filter((time) => now - time < MINI_APP_API_WINDOW_MS);
  fresh.push(now);
  miniAppApiRateBuckets.set(key, fresh);
  return fresh.length > MINI_APP_API_MAX_REQUESTS;
}

function isMiniAppAiRateLimited(req, authorization) {
  const now = Date.now();
  cleanupRuntimeState(now);
  const key = miniAppClientKey(req, authorization);
  const bucket = miniAppAiRateBuckets.get(key) || [];
  const fresh = bucket.filter((time) => now - time < MINI_APP_AI_WINDOW_MS);
  fresh.push(now);
  miniAppAiRateBuckets.set(key, fresh);
  return fresh.length > MINI_APP_AI_MAX_REQUESTS;
}

function isMiniAppNotificationRateLimited(req, authorization) {
  const now = Date.now();
  cleanupRuntimeState(now);
  const key = miniAppClientKey(req, authorization);
  const bucket = miniAppNotificationRateBuckets.get(key) || [];
  const fresh = bucket.filter((time) => now - time < MINI_APP_NOTIFICATION_WINDOW_MS);
  fresh.push(now);
  miniAppNotificationRateBuckets.set(key, fresh);
  return fresh.length > MINI_APP_NOTIFICATION_MAX_REQUESTS;
}

function isMiniAppTripRateLimited(req, authorization) {
  const now = Date.now();
  cleanupRuntimeState(now);
  const key = miniAppClientKey(req, authorization);
  const bucket = miniAppTripRateBuckets.get(key) || [];
  const fresh = bucket.filter((time) => now - time < MINI_APP_TRIP_WINDOW_MS);
  fresh.push(now);
  miniAppTripRateBuckets.set(key, fresh);
  return fresh.length > MINI_APP_TRIP_MAX_REQUESTS;
}

function cleanupCallbackStore() {
  const now = Date.now();
  for (const [token, payload] of callbackStore.entries()) {
    if (!payload || payload.expiresAt < now) callbackStore.delete(token);
  }
}

function cleanupRuntimeState(now = Date.now()) {
  if (now - lastStateCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastStateCleanupAt = now;

  for (const [key, bucket] of rateBuckets.entries()) {
    const fresh = bucket.filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
    if (fresh.length) {
      rateBuckets.set(key, fresh);
    } else {
      rateBuckets.delete(key);
    }
  }

  for (const [key, bucket] of miniAppApiRateBuckets.entries()) {
    const fresh = bucket.filter((time) => now - time < MINI_APP_API_WINDOW_MS);
    if (fresh.length) {
      miniAppApiRateBuckets.set(key, fresh);
    } else {
      miniAppApiRateBuckets.delete(key);
    }
  }

  for (const [key, bucket] of miniAppAiRateBuckets.entries()) {
    const fresh = bucket.filter((time) => now - time < MINI_APP_AI_WINDOW_MS);
    if (fresh.length) {
      miniAppAiRateBuckets.set(key, fresh);
    } else {
      miniAppAiRateBuckets.delete(key);
    }
  }

  for (const [key, bucket] of miniAppNotificationRateBuckets.entries()) {
    const fresh = bucket.filter((time) => now - time < MINI_APP_NOTIFICATION_WINDOW_MS);
    if (fresh.length) {
      miniAppNotificationRateBuckets.set(key, fresh);
    } else {
      miniAppNotificationRateBuckets.delete(key);
    }
  }

  for (const [key, bucket] of miniAppTripRateBuckets.entries()) {
    const fresh = bucket.filter((time) => now - time < MINI_APP_TRIP_WINDOW_MS);
    if (fresh.length) {
      miniAppTripRateBuckets.set(key, fresh);
    } else {
      miniAppTripRateBuckets.delete(key);
    }
  }

  cleanupCallbackStore();

  for (const [chatId, session] of userSessions.entries()) {
    if (!session?.updatedAt || now - session.updatedAt > SESSION_TTL_MS) {
      userSessions.delete(chatId);
    }
  }

  for (const [chatId, cached] of lastClothingAdvice.entries()) {
    if (!cached?.expiresAt || cached.expiresAt < now) {
      lastClothingAdvice.delete(chatId);
    }
  }

  for (const [key, cached] of transportCache.routePages.entries()) {
    if (!cached?.expiresAt || cached.expiresAt < now) transportCache.routePages.delete(key);
  }

  for (const [key, cached] of transportCache.routeLists.entries()) {
    if (!cached?.expiresAt || cached.expiresAt < now) transportCache.routeLists.delete(key);
  }

  for (const [key, cached] of transportCache.stopPages.entries()) {
    if (!cached?.expiresAt || cached.expiresAt < now) transportCache.stopPages.delete(key);
  }

  for (const [key, cached] of tripPlannerCache.geocodes.entries()) {
    if (!cached?.expiresAt || cached.expiresAt < now) tripPlannerCache.geocodes.delete(key);
  }
}

function isTextTooLong(text) {
  return text.length > MAX_MESSAGE_TEXT_LENGTH;
}

const LABELS = {
  ru: {
    today: "🌤️ Погода сегодня",
    tomorrow: "🌦️ Погода завтра",
    help: "❓ Помощь",
    clothing: "🧥 А что по одежде?",
    now: "🌡️ Сейчас",
    morning: "🌅 Утро 09:00",
    day: "☀️ День 15:00",
    evening: "🌇 Вечер 18:00",
    night: "🌙 Ночь 21:00",
    allDay: "🕘 Весь день",
    menu: "🏠 Меню",
    language: "🌐 Язык"
  },
  en: {
    today: "🌤️ Weather today",
    tomorrow: "🌦️ Weather tomorrow",
    help: "❓ Help",
    clothing: "🧥 What should I wear?",
    now: "🌡️ Now",
    morning: "🌅 Morning 09:00",
    day: "☀️ Afternoon 15:00",
    evening: "🌇 Evening 18:00",
    night: "🌙 Night 21:00",
    allDay: "🕘 All day",
    menu: "🏠 Menu",
    language: "🌐 Language"
  }
};

const WEATHER_CODES = {
  ru: new Map([
    [0, "ясно"],
    [1, "в основном ясно"],
    [2, "переменная облачность"],
    [3, "пасмурно"],
    [45, "туман"],
    [48, "изморозь"],
    [51, "слабая морось"],
    [53, "морось"],
    [55, "сильная морось"],
    [61, "слабый дождь"],
    [63, "дождь"],
    [65, "сильный дождь"],
    [71, "слабый снег"],
    [73, "снег"],
    [75, "сильный снег"],
    [80, "слабый ливень"],
    [81, "ливень"],
    [82, "сильный ливень"],
    [95, "гроза"],
    [96, "гроза с градом"],
    [99, "сильная гроза с градом"]
  ]),
  en: new Map([
    [0, "clear"],
    [1, "mostly clear"],
    [2, "partly cloudy"],
    [3, "overcast"],
    [45, "fog"],
    [48, "rime fog"],
    [51, "light drizzle"],
    [53, "drizzle"],
    [55, "heavy drizzle"],
    [61, "light rain"],
    [63, "rain"],
    [65, "heavy rain"],
    [71, "light snow"],
    [73, "snow"],
    [75, "heavy snow"],
    [80, "light showers"],
    [81, "showers"],
    [82, "heavy showers"],
    [95, "thunderstorm"],
    [96, "thunderstorm with hail"],
    [99, "heavy thunderstorm with hail"]
  ])
};

function langOf(chatId) {
  return userLanguages.get(chatId) || "ru";
}

function languageKeyboard() {
  return {
    inline_keyboard: [[
      { text: "🇷🇺 Русский", callback_data: "lang:ru" },
      { text: "🇬🇧 English", callback_data: "lang:en" }
    ]]
  };
}

function savedCityFrom(value) {
  if (!value || typeof value !== "object") return null;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  const name = String(value.name || "").trim().slice(0, 100);
  if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    name,
    admin1: String(value.admin1 || "").trim().slice(0, 100),
    country: String(value.country || "").trim().slice(0, 100),
    latitude,
    longitude,
    timezone: String(value.timezone || "").trim().slice(0, 80)
  };
}

function favoriteRouteFrom(value) {
  if (!value || typeof value !== "object") return null;
  const type = normalizeTransportType(String(value.type || ""));
  const num = String(value.num || "").trim().slice(0, 16);
  if (!(["А", "Тб"].includes(type)) || !num || /[:\r\n]/.test(num)) return null;
  return { type, num };
}

function normalizedPreferences(value) {
  const city = savedCityFrom(value?.city);
  const favorites = [];
  for (const item of Array.isArray(value?.favorites) ? value.favorites : []) {
    const route = favoriteRouteFrom(item);
    if (route && !favorites.some((saved) => saved.type === route.type && saved.num === route.num)) {
      favorites.push(route);
    }
    if (favorites.length >= MAX_FAVORITE_ROUTES) break;
  }
  return { city, favorites };
}

function loadUserPreferences() {
  try {
    if (!fs.existsSync(PREFERENCES_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(PREFERENCES_FILE, "utf8"));
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
    for (const [chatId, value] of Object.entries(saved)) {
      if (!/^\d{1,20}$/.test(chatId)) continue;
      const preferences = normalizedPreferences(value);
      if (preferences.city || preferences.favorites.length) userPreferences.set(chatId, preferences);
    }
  } catch (error) {
    console.error("Could not load user preferences:", error.message);
  }
}

function persistUserPreferences() {
  try {
    fs.mkdirSync(path.dirname(PREFERENCES_FILE), { recursive: true });
    const saved = Object.fromEntries(userPreferences.entries());
    const tempFile = `${PREFERENCES_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(saved), "utf8");
    try {
      fs.renameSync(tempFile, PREFERENCES_FILE);
    } catch {
      fs.writeFileSync(PREFERENCES_FILE, JSON.stringify(saved), "utf8");
      fs.rmSync(tempFile, { force: true });
    }
  } catch (error) {
    console.error("Could not save user preferences:", error.message);
  }
}

function preferencesOf(chatId) {
  return userPreferences.get(String(chatId)) || { city: null, favorites: [] };
}

function updatePreferences(chatId, updater) {
  const key = String(chatId);
  const current = preferencesOf(key);
  const next = normalizedPreferences(updater({ city: current.city, favorites: [...current.favorites] }));
  if (next.city || next.favorites.length) {
    userPreferences.set(key, next);
  } else {
    userPreferences.delete(key);
  }
  persistUserPreferences();
  return next;
}

function setSavedCity(chatId, city) {
  const savedCity = savedCityFrom(city);
  if (!savedCity) return preferencesOf(chatId);
  return updatePreferences(chatId, (preferences) => ({ ...preferences, city: savedCity }));
}

function clearSavedCity(chatId) {
  return updatePreferences(chatId, (preferences) => ({ ...preferences, city: null }));
}

function isFavoriteRoute(chatId, type, num) {
  return preferencesOf(chatId).favorites.some((route) => route.type === type && route.num === String(num));
}

function toggleFavoriteRoute(chatId, type, num) {
  const route = favoriteRouteFrom({ type, num });
  if (!route) return { changed: false, favorites: preferencesOf(chatId).favorites };
  const current = preferencesOf(chatId);
  const exists = current.favorites.some((item) => item.type === route.type && item.num === route.num);
  if (!exists && current.favorites.length >= MAX_FAVORITE_ROUTES) {
    return { changed: false, limitReached: true, favorites: current.favorites };
  }
  const preferences = updatePreferences(chatId, (value) => ({
    ...value,
    favorites: exists
      ? value.favorites.filter((item) => item.type !== route.type || item.num !== route.num)
      : [...value.favorites, route]
  }));
  return { changed: true, added: !exists, favorites: preferences.favorites };
}

loadUserPreferences();

function getMiniAppUrl() {
  const configuredUrl = String(process.env.WEB_APP_URL || "").trim().replace(/\/$/, "");
  const baseUrl = configuredUrl || getWebhookBaseUrl();
  return baseUrl ? `${baseUrl}${MINI_APP_PATH}` : "";
}

function transportMiniAppButton(lang) {
  const text = lang === "en" ? "🚌 Timetable" : "🚌 Расписание";
  const url = getMiniAppUrl();
  return url
    ? { text, web_app: { url } }
    : { text, callback_data: "transport_menu" };
}

function menuKeyboard(lang) {
  return {
    inline_keyboard: [
      [
        { text: lang === "en" ? "🌤️ Weather" : "🌤️ Погода", callback_data: "weather_menu" },
        transportMiniAppButton(lang)
      ],
      [
        { text: LABELS[lang].help, callback_data: "help" },
        { text: LABELS[lang].language, callback_data: "choose_lang" }
      ],
      [{ text: lang === "en" ? "✨ SkyPulse Pro" : "✨ SkyPulse Pro", callback_data: "pro" }],
      [{ text: lang === "en" ? "ℹ️ Information" : "ℹ️ Информация", callback_data: "info_menu" }]
    ]
  };
}

function weatherMenuKeyboard(lang) {
  const l = LABELS[lang];
  return {
    inline_keyboard: [
      [
        { text: l.today, callback_data: "day:today" },
        { text: l.tomorrow, callback_data: "day:tomorrow" }
      ],
      [{ text: l.menu, callback_data: "menu" }]
    ]
  };
}

function transportMenuKeyboard(lang) {
  return {
    inline_keyboard: [
      [transportMiniAppButton(lang)],
      [{ text: lang === "en" ? "🚏 Find a stop" : "🚏 Найти остановку", callback_data: "tr:stop_search" }],
      [
        { text: lang === "en" ? "🚌 Buses" : "🚌 Автобусы", callback_data: "tr:type:A" },
        { text: lang === "en" ? "🚎 Trolleybuses" : "🚎 Троллейбусы", callback_data: "tr:type:Tb" }
      ],
      [{ text: lang === "en" ? "🚐 Minibuses" : "🚐 Маршрутки", callback_data: "tr:type:M" }],
      [{ text: LABELS[lang].menu, callback_data: "menu" }]
    ]
  };
}

function dayKeyboard(lang) {
  const l = LABELS[lang];
  return {
    inline_keyboard: [
      [
        { text: l.today, callback_data: "day:today" },
        { text: l.tomorrow, callback_data: "day:tomorrow" }
      ],
      [{ text: LABELS[lang].menu, callback_data: "menu" }]
    ]
  };
}

function timeKeyboard(lang) {
  const l = LABELS[lang];
  return {
    inline_keyboard: [
      [
        { text: l.now, callback_data: "time:current" },
        { text: l.morning, callback_data: "time:9" }
      ],
      [
        { text: l.day, callback_data: "time:15" },
        { text: l.evening, callback_data: "time:18" }
      ],
      [
        { text: l.night, callback_data: "time:21" },
        { text: l.allDay, callback_data: "time:daily" }
      ],
      [{ text: lang === "en" ? "✏️ Another city" : "✏️ Другой город", callback_data: "city:change" }],
      [{ text: l.menu, callback_data: "menu" }]
    ]
  };
}

function weatherResultKeyboard(lang) {
  const l = LABELS[lang];
  return {
    inline_keyboard: [
      [{ text: l.clothing, callback_data: "clothing" }],
      [
        { text: l.today, callback_data: "day:today" },
        { text: l.tomorrow, callback_data: "day:tomorrow" }
      ],
      [{ text: l.menu, callback_data: "menu" }]
    ]
  };
}

function menuText(lang) {
  if (lang === "en") {
    return [
      "Hi! I am SkyPulse Weather.",
      "",
      "Choose weather or Grodno public transport below.",
      "For weather I can show today, tomorrow, exact time, and outfit advice."
    ].join("\n");
  }

  return [
    "Привет! Я SkyPulse Weather.",
    "",
    "Выбери ниже: погода или общественный транспорт Гродно.",
    "По погоде умею сегодня, завтра, точное время и совет по одежде."
  ].join("\n");
}

function paymentSupportContact() {
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(PAYMENT_SUPPORT_USERNAME)
    ? `@${PAYMENT_SUPPORT_USERNAME}`
    : null;
}

function paymentSupportText(lang) {
  const contact = paymentSupportContact();
  if (lang === "en") {
    return [
      "<b>SkyPulse Pro payment support</b>",
      "If payment succeeded but Pro was not enabled, do not pay a second time. Keep the receipt and payment message.",
      contact ? `Contact: ${escapeHtml(contact)}` : "The support contact is being set up. Please keep the receipt until it appears here."
    ].join("\n");
  }
  return [
    "<b>Поддержка по оплате SkyPulse Pro</b>",
    "Если платёж прошёл, а Pro не включился, не плати второй раз. Сохрани чек и сообщение о платеже.",
    contact ? `Напиши: ${escapeHtml(contact)}` : "Контакт поддержки сейчас настраивается. Сохрани чек — он понадобится для проверки."
  ].join("\n");
}

function proInfoText(lang) {
  if (lang === "en") {
    return [
      "<b>✨ SkyPulse Pro</b>",
      `For ${PRO_MONTHLY_PRICE_STARS} Telegram Stars every 30 days: outfit guidance, a 24-hour weather plan with a recommended trip or walk window, and rain, wind, and thunderstorm warnings in weather notifications.`,
      "The subscription renews automatically and can be disabled at any time in the Mini App."
    ].join("\n");
  }
  return [
    "<b>✨ SkyPulse Pro</b>",
    `${PRO_MONTHLY_PRICE_STARS} Telegram Stars за 30 дней: совет по одежде, план погоды на 24 часа с лучшим окном для дороги или прогулки и предупреждения о ливне, ветре и грозе в уведомлениях о погоде.`,
    "Подписка продлевается автоматически, её можно отключить в любой момент внутри мини-приложения."
  ].join("\n");
}

function proInfoKeyboard(lang) {
  const url = getMiniAppUrl();
  return {
    inline_keyboard: [
      [url
        ? { text: lang === "en" ? "✨ Open SkyPulse Pro" : "✨ Открыть SkyPulse Pro", web_app: { url } }
        : { text: lang === "en" ? "🚌 Open Mini App" : "🚌 Открыть мини-приложение", callback_data: "transport_menu" }
      ],
      [{ text: lang === "en" ? "💳 Payment support" : "💳 Поддержка по оплате", callback_data: "paysupport" }]
    ]
  };
}

function helpText(lang) {
  if (lang === "en") {
    return [
      "<b>What I can do:</b>",
      "1. Forecast for today or tomorrow.",
      "2. Forecast for an exact hour, like 15 or 15:00.",
      "3. Clothing advice after the forecast.",
      "4. /pro — SkyPulse Pro and payment options.",
      "",
      "Example: Weather tomorrow -> type London -> Afternoon 15:00 -> What should I wear?"
    ].join("\n");
  }

  return [
    "<b>Что я умею:</b>",
    "1. Прогноз на сегодня или завтра.",
    "2. Прогноз на конкретный час: например 15 или 15:00.",
    "3. Подсказка по одежде после прогноза.",
    "4. /pro — SkyPulse Pro и оплата.",
    "",
    "Пример: «Погода завтра» -> напиши Москва -> «День 15:00» -> «А что по одежде?»."
  ].join("\n");
}

function savedCityLabel(city) {
  return city ? formatCityName(city) : "";
}

function informationKeyboard(chatId, lang) {
  const preferences = preferencesOf(chatId);
  const cityLabel = savedCityLabel(preferences.city);
  const cityButtonLabel = cityLabel.length > 42 ? `${cityLabel.slice(0, 41)}…` : cityLabel;
  return {
    inline_keyboard: [
      [{
        text: cityButtonLabel
          ? (lang === "en" ? `🏙️ My city: ${cityButtonLabel}` : `🏙️ Мой город: ${cityButtonLabel}`)
          : (lang === "en" ? "🏙️ Set my city" : "🏙️ Указать мой город"),
        callback_data: cityLabel ? "info:city" : "info:city_set"
      }],
      [{
        text: lang === "en"
          ? `⭐ Favourite routes (${preferences.favorites.length})`
          : `⭐ Избранные маршруты (${preferences.favorites.length})`,
        callback_data: "fav:menu"
      }],
      [{ text: LABELS[lang].menu, callback_data: "menu" }]
    ]
  };
}

function citySettingsKeyboard(chatId, lang) {
  const hasCity = Boolean(preferencesOf(chatId).city);
  const rows = [[{
    text: lang === "en" ? "✏️ Set or change city" : "✏️ Указать или изменить город",
    callback_data: "info:city_set"
  }]];
  if (hasCity) {
    rows.push([{
      text: lang === "en" ? "🗑️ Remove saved city" : "🗑️ Удалить сохранённый город",
      callback_data: "info:city_clear"
    }]);
  }
  rows.push([{ text: lang === "en" ? "← Information" : "← Информация", callback_data: "info_menu" }]);
  return { inline_keyboard: rows };
}

function favoriteRoutesKeyboard(chatId, lang) {
  const favorites = preferencesOf(chatId).favorites;
  const rows = favorites.map((route) => ([
    {
      text: `${transportIcon(route.type)} ${transportTypeName(route.type, lang)} ${route.num}`.slice(0, 54),
      callback_data: `tr:route:${safeCallbackText(route.type)}:${safeCallbackText(route.num)}`
    },
    {
      text: lang === "en" ? "✕ Remove" : "✕ Убрать",
      callback_data: `fav:remove:${safeCallbackText(route.type)}:${safeCallbackText(route.num)}`
    }
  ]));
  rows.push([{ text: lang === "en" ? "← Information" : "← Информация", callback_data: "info_menu" }]);
  return { inline_keyboard: rows };
}

async function showInformation(chatId) {
  const lang = langOf(chatId);
  resetToMenu(chatId);
  const preferences = preferencesOf(chatId);
  const city = savedCityLabel(preferences.city);
  const text = lang === "en"
    ? [
        "ℹ️ <b>Information</b>",
        "",
        city ? `🏙️ My city: <b>${escapeHtml(city)}</b>` : "🏙️ My city is not set yet.",
        `⭐ Favourite bus and trolleybus routes: <b>${preferences.favorites.length}</b>`
      ].join("\n")
    : [
        "ℹ️ <b>Информация</b>",
        "",
        city ? `🏙️ Мой город: <b>${escapeHtml(city)}</b>` : "🏙️ Мой город пока не указан.",
        `⭐ Избранных маршрутов автобусов и троллейбусов: <b>${preferences.favorites.length}</b>`
      ].join("\n");
  await sendMessage(chatId, text, { reply_markup: informationKeyboard(chatId, lang) });
}

async function showCitySettings(chatId) {
  const lang = langOf(chatId);
  const city = savedCityLabel(preferencesOf(chatId).city);
  const text = lang === "en"
    ? [
        "🏙️ <b>My city</b>",
        "",
        city ? `Saved: <b>${escapeHtml(city)}</b>. Weather will use it automatically.` : "Save a city to skip typing it for every forecast."
      ].join("\n")
    : [
        "🏙️ <b>Мой город</b>",
        "",
        city ? `Сохранён: <b>${escapeHtml(city)}</b>. Прогноз будет использовать его автоматически.` : "Сохрани город, чтобы не вводить его для каждого прогноза."
      ].join("\n");
  await sendMessage(chatId, text, { reply_markup: citySettingsKeyboard(chatId, lang) });
}

async function showFavoriteRoutes(chatId) {
  const lang = langOf(chatId);
  const favorites = preferencesOf(chatId).favorites;
  const text = lang === "en"
    ? (favorites.length ? "⭐ <b>Favourite routes</b>\n\nChoose a route to open its timetable." : "⭐ <b>Favourite routes</b>\n\nOpen a bus or trolleybus route and tap ‘Add to favourites’.")
    : (favorites.length ? "⭐ <b>Избранные маршруты</b>\n\nНажми маршрут, чтобы открыть расписание." : "⭐ <b>Избранные маршруты</b>\n\nОткрой автобусный или троллейбусный маршрут и нажми «В избранное».");
  await sendMessage(chatId, text, { reply_markup: favoriteRoutesKeyboard(chatId, lang) });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("External request timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readLimitedFetchText(response, maxBytes = MAX_EXTERNAL_RESPONSE_BYTES) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("External response too large");
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error("External response too large");
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("External response too large");
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function fetchJson(url, {
  timeoutMs = 9000,
  maxBytes = MAX_EXTERNAL_RESPONSE_BYTES,
  headers = {},
  method = "GET",
  body,
  label = "External API"
} = {}) {
  const response = await fetchWithTimeout(url, { method, headers, body }, timeoutMs);
  if (!response.ok) throw new Error(`${label} request failed (HTTP ${response.status})`);

  const text = await readLimitedFetchText(response, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function telegram(method, payload) {
  const response = await fetchWithTimeout(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }, method === "getUpdates" ? 35000 : 10000);

  const text = await readLimitedFetchText(response, 256 * 1024);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Telegram returned invalid JSON: ${method}`);
  }
  if (!response.ok) {
    throw new Error(data.description || `Telegram HTTP ${response.status}: ${method}`);
  }
  if (!data.ok) {
    throw new Error(data.description || `Telegram API error: ${method}`);
  }
  return data.result;
}

async function sendMessage(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra
  });
}

function formatProExpiration(expiresAt) {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: GRODNO_TIME_ZONE,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(Number(expiresAt) * 1000));
  } catch {
    return "конца текущего периода";
  }
}

async function handlePreCheckoutQuery(preCheckoutQuery) {
  if (!preCheckoutQuery?.id) return;
  const userId = telegramUserId(preCheckoutQuery?.from?.id);
  const details = userId && proPaymentsConfigured()
    ? proCheckoutDetails(
        preCheckoutQuery?.invoice_payload,
        userId,
        preCheckoutQuery?.currency,
        preCheckoutQuery?.total_amount
      )
    : null;
  const accepted = Boolean(details && preCheckoutQuery?.id);
  await telegram("answerPreCheckoutQuery", {
    pre_checkout_query_id: preCheckoutQuery?.id,
    ok: accepted,
    ...(accepted ? {} : { error_message: "Счёт устарел или временно недоступен. Открой SkyPulse Pro ещё раз." })
  });
}

function proWelcomeText(expiresAt, { complimentary = false, renewal = false } = {}) {
  const title = complimentary
    ? "<b>🎁 SkyPulse Pro подключён бесплатно</b>"
    : renewal
      ? "<b>✨ SkyPulse Pro продлён</b>"
      : "<b>✨ Вы приобрели SkyPulse Pro</b>";
  const accessLine = `Подписка активна до ${escapeHtml(formatProExpiration(expiresAt))}.`;
  return [
    title,
    accessLine,
    complimentary ? "Stars не списывались — это подарок." : "Оплата получена, спасибо!",
    "",
    "<b>Вам доступны:</b>",
    "• расширенные детали в уведомлениях о погоде каждые 3 часа;",
    "• персональный совет по одежде;",
    "• план погоды на 24 часа с лучшим окном для дороги или прогулки;",
    "• предупреждения о дожде, сильном ветре и грозе.",
    complimentary
      ? "Автопродление для подарочной подписки отключено."
      : "Автопродление можно отключить в карточке Pro внутри мини-приложения."
  ].join("\n");
}

async function sendProWelcomeMessage(chatId, expiresAt, options = {}) {
  await sendMessage(chatId, proWelcomeText(expiresAt, options));
}

async function handleSuccessfulPayment(message) {
  const payment = message?.successful_payment;
  if (!payment) return;

  const parsedInvoice = parseProInvoicePayload(payment.invoice_payload);
  const payerId = telegramUserId(message?.from?.id) || parsedInvoice?.userId || null;
  const details = payerId ? proSuccessfulPaymentDetails(payment, payerId) : null;
  if (!details) {
    console.warn("Ignored an invalid successful payment update.");
    return;
  }

  if (!proPaymentsConfigured()) {
    console.error("Received a valid SkyPulse Pro payment while the entitlement service is unavailable.");
    throw new Error("SkyPulse Pro entitlement service is unavailable");
  }

  let result;
  try {
    result = await syncProSubscription("grant", details.userId, {
      expiresAt: details.expiresAt,
      chargeId: details.chargeId,
      isFirstRecurring: details.isFirstRecurring
    });
  } catch (error) {
    console.error("Could not grant SkyPulse Pro after payment:", error.message);
    throw error;
  }

  if (result.newPayment) {
    try {
      await sendProWelcomeMessage(details.userId, details.expiresAt, {
        renewal: !details.isFirstRecurring
      });
    } catch (error) {
      console.error("Could not send SkyPulse Pro confirmation:", error.message);
    }
  }
}

async function removeReplyKeyboard(chatId) {
  try {
    const message = await sendMessage(chatId, ".", { reply_markup: { remove_keyboard: true } });
    await telegram("deleteMessage", { chat_id: chatId, message_id: message.message_id });
  } catch {
    // Best-effort cleanup for an old reply keyboard.
  }
}

async function sendLanguageChoice(chatId) {
  await removeReplyKeyboard(chatId);
  return sendMessage(chatId, "Choosing your language / Выберите язык", {
    reply_markup: languageKeyboard()
  });
}

async function findCity(query, lang) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", lang);
  url.searchParams.set("format", "json");

  const data = await fetchJson(url, {
    timeoutMs: 8000,
    maxBytes: 256 * 1024,
    headers: WEATHER_REQUEST_HEADERS,
    label: "Geocoding"
  });
  return data.results?.[0] || null;
}

const WEATHER_REQUEST_HEADERS = Object.freeze({
  "User-Agent": "SkyPulse Weather Bot/1.0 (+https://github.com/sergeevdeonisii-dotcom/skypulse-weather-bot)",
  "Accept": "application/json"
});

function wttrWeatherCode(value) {
  const code = Number(value);
  if (code === 113) return 0;
  if (code === 116) return 1;
  if (code === 119 || code === 122) return 3;
  if (code === 143 || code === 248 || code === 260) return 45;
  if ([176, 263, 266, 293, 296, 353].includes(code)) return 51;
  if ([299, 302, 305, 308, 356, 359].includes(code)) return 63;
  if ([281, 284, 311, 314, 317, 362, 365].includes(code)) return 56;
  if ([179, 227, 230, 320, 323, 326, 329, 332, 335, 338, 368, 371].includes(code)) return 71;
  if ([350, 374, 377].includes(code)) return 77;
  if ([200, 386, 389, 392, 395].includes(code)) return 95;
  return 3;
}

function wttrHour(value) {
  const hour = Math.floor(Number(value || 0) / 100);
  return Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 0;
}

function wttrSlotForHour(slots, wantedHour) {
  return slots.reduce((closest, slot) => {
    if (!closest) return slot;
    return Math.abs(wttrHour(slot.time) - wantedHour) < Math.abs(wttrHour(closest.time) - wantedHour)
      ? slot
      : closest;
  }, null);
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function getWttrForecast(city) {
  const url = new URL(`https://wttr.in/${city.latitude},${city.longitude}`);
  url.searchParams.set("format", "j1");

  const data = await fetchJson(url, {
    timeoutMs: 9000,
    maxBytes: 512 * 1024,
    headers: WEATHER_REQUEST_HEADERS,
    label: "Weather fallback"
  });
  const days = data.weather?.slice(0, 2).filter((day) => day?.date && Array.isArray(day.hourly)) || [];
  const observed = data.current_condition?.[0];
  if (days.length < 2 || !observed) throw new Error("Weather fallback response is incomplete");

  const hourly = {
    time: [],
    temperature_2m: [],
    apparent_temperature: [],
    precipitation_probability: [],
    weather_code: [],
    wind_speed_10m: []
  };
  const daily = {
    time: [],
    temperature_2m_max: [],
    temperature_2m_min: [],
    precipitation_probability_max: [],
    weather_code: []
  };

  for (const day of days) {
    const slots = day.hourly.filter(Boolean);
    if (!slots.length) throw new Error("Weather fallback has no hourly forecast");
    const noon = wttrSlotForHour(slots, 12);
    daily.time.push(day.date);
    daily.temperature_2m_max.push(finiteNumber(day.maxtempC));
    daily.temperature_2m_min.push(finiteNumber(day.mintempC));
    daily.precipitation_probability_max.push(Math.max(...slots.map((slot) => finiteNumber(slot.chanceofrain))));
    daily.weather_code.push(wttrWeatherCode(noon.weatherCode));

    for (let hour = 0; hour < 24; hour += 1) {
      const slot = wttrSlotForHour(slots, hour);
      hourly.time.push(`${day.date}T${String(hour).padStart(2, "0")}:00`);
      hourly.temperature_2m.push(finiteNumber(slot.tempC));
      hourly.apparent_temperature.push(finiteNumber(slot.FeelsLikeC, finiteNumber(slot.tempC)));
      hourly.precipitation_probability.push(finiteNumber(slot.chanceofrain));
      hourly.weather_code.push(wttrWeatherCode(slot.weatherCode));
      hourly.wind_speed_10m.push(finiteNumber(slot.windspeedKmph));
    }
  }

  return {
    timezone: city.timezone || "UTC",
    current: {
      temperature_2m: finiteNumber(observed.temp_C),
      apparent_temperature: finiteNumber(observed.FeelsLikeC, finiteNumber(observed.temp_C)),
      weather_code: wttrWeatherCode(observed.weatherCode),
      wind_speed_10m: finiteNumber(observed.windspeedKmph)
    },
    hourly,
    daily
  };
}

async function getWeather(city) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", city.latitude);
  url.searchParams.set("longitude", city.longitude);
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("current", "temperature_2m,apparent_temperature,weather_code,wind_speed_10m");
  url.searchParams.set("hourly", "temperature_2m,apparent_temperature,precipitation_probability,weather_code,wind_speed_10m");
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code");
  url.searchParams.set("forecast_days", "2");

  try {
    const data = await fetchJson(url, {
      timeoutMs: 9000,
      maxBytes: 512 * 1024,
      headers: WEATHER_REQUEST_HEADERS,
      label: "Weather"
    });
    if (!data || !data.current || !data.hourly || !data.daily) {
      throw new Error("Weather response is incomplete");
    }
    return data;
  } catch (primaryError) {
    console.warn("Open-Meteo failed, using weather fallback:", primaryError.message);
    return getWttrForecast(city);
  }
}

async function getObservedCurrent(city) {
  const url = new URL(`https://wttr.in/${city.latitude},${city.longitude}`);
  url.searchParams.set("format", "j1");

  const data = await fetchJson(url, {
    timeoutMs: 8000,
    maxBytes: 512 * 1024,
    headers: WEATHER_REQUEST_HEADERS,
    label: "Observed weather"
  });
  const current = data.current_condition?.[0];
  if (!current) return null;

  const temp = Number(current.temp_C);
  const feels = Number(current.FeelsLikeC);
  const wind = Number(current.windspeedKmph);
  if (!Number.isFinite(temp)) return null;

  return {
    temperature_2m: temp,
    apparent_temperature: Number.isFinite(feels) ? feels : temp,
    wind_speed_10m: Number.isFinite(wind) ? wind : 0,
    description: String(current.weatherDesc?.[0]?.value || "").trim(),
    source: "wttr.in"
  };
}

function formatCityName(city) {
  return [city.name, city.admin1, city.country].filter(Boolean).join(", ");
}

function formatSafeCityName(city) {
  return escapeHtml(formatCityName(city));
}

function dayLabel(day, lang) {
  if (lang === "en") return day === "tomorrow" ? "tomorrow" : "today";
  return day === "tomorrow" ? "завтра" : "сегодня";
}

function getDateForDay(weather, day) {
  return weather.daily.time[day === "tomorrow" ? 1 : 0];
}

function parseTimeChoice(text) {
  const value = text.trim().toLowerCase();
  const namedTimes = new Map([
    ["сейчас", { type: "current" }],
    ["now", { type: "current" }],
    ["весь день", { type: "daily" }],
    ["all day", { type: "daily" }],
    ["утро", { type: "hour", hour: 9 }],
    ["утро 09:00", { type: "hour", hour: 9 }],
    ["morning", { type: "hour", hour: 9 }],
    ["morning 09:00", { type: "hour", hour: 9 }],
    ["день", { type: "hour", hour: 15 }],
    ["день 15:00", { type: "hour", hour: 15 }],
    ["afternoon", { type: "hour", hour: 15 }],
    ["afternoon 15:00", { type: "hour", hour: 15 }],
    ["вечер", { type: "hour", hour: 18 }],
    ["вечер 18:00", { type: "hour", hour: 18 }],
    ["evening", { type: "hour", hour: 18 }],
    ["evening 18:00", { type: "hour", hour: 18 }],
    ["ночь", { type: "hour", hour: 21 }],
    ["ночь 21:00", { type: "hour", hour: 21 }],
    ["night", { type: "hour", hour: 21 }],
    ["night 21:00", { type: "hour", hour: 21 }]
  ]);

  if (namedTimes.has(value)) return namedTimes.get(value);
  const match = value.match(/^(\d{1,2})(?::?([0-5]\d))?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  if (hour < 0 || hour > 23) return null;
  return { type: "hour", hour };
}

function timeChoiceFromCallback(data) {
  if (data === "time:current") return { type: "current" };
  if (data === "time:daily") return { type: "daily" };
  const match = data.match(/^time:(\d{1,2})$/);
  if (!match) return null;
  return { type: "hour", hour: Number(match[1]) };
}

function findHourlyIndex(weather, date, hour) {
  const wanted = `${date}T${String(hour).padStart(2, "0")}:00`;
  return weather.hourly.time.findIndex((time) => time === wanted);
}

function describeWeatherCode(code, lang) {
  return WEATHER_CODES[lang].get(code) || (lang === "en" ? `weather code ${code}` : `код ${code}`);
}

function weatherEmoji(code) {
  if (code === 0) return "☀️";
  if (code === 1 || code === 2) return "🌤️";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 55) return "🌦️";
  if (code >= 61 && code <= 65) return "🌧️";
  if (code >= 71 && code <= 75) return "❄️";
  if (code >= 80 && code <= 82) return "🌧️";
  if (code >= 95) return "⛈️";
  return "🌡️";
}

function formatDailyWeather(city, weather, day, lang) {
  const date = getDateForDay(weather, day);
  const index = day === "tomorrow" ? 1 : 0;
  const description = describeWeatherCode(weather.daily.weather_code[index], lang);
  const precipitation = weather.daily.precipitation_probability_max?.[index];

  if (lang === "en") {
    return [
      `<b>${formatSafeCityName(city)}</b>`,
      `Forecast for ${dayLabel(day, lang)} (${date})`,
      "",
      `${weatherEmoji(weather.daily.weather_code[index])} Overall: ${description}`,
      `🌡️ Temperature: from ${Math.round(weather.daily.temperature_2m_min[index])}°C to ${Math.round(weather.daily.temperature_2m_max[index])}°C`,
      precipitation == null ? null : `💧 Chance of precipitation: ${precipitation}%`,
      "",
      `Timezone: ${weather.timezone}`
    ].filter(Boolean).join("\n");
  }

  return [
    `<b>${formatSafeCityName(city)}</b>`,
    `Прогноз на ${dayLabel(day, lang)} (${date})`,
    "",
    `${weatherEmoji(weather.daily.weather_code[index])} День в целом: ${description}`,
    `🌡️ Температура: от ${Math.round(weather.daily.temperature_2m_min[index])}°C до ${Math.round(weather.daily.temperature_2m_max[index])}°C`,
    precipitation == null ? null : `💧 Вероятность осадков: ${precipitation}%`,
    "",
    `Часовой пояс: ${weather.timezone}`
  ].filter(Boolean).join("\n");
}

function formatCurrentWeather(city, weather, lang, observedCurrent = null) {
  const current = observedCurrent || weather.current;
  const description = escapeHtml(observedCurrent?.description || describeWeatherCode(current.weather_code, lang));
  const sourceLine = observedCurrent
    ? (lang === "en" ? "Source: current observation" : "Источник: текущее наблюдение")
    : (lang === "en" ? "Source: forecast model" : "Источник: прогнозная модель");

  if (lang === "en") {
    return [
      `<b>${formatSafeCityName(city)}</b>`,
      "Weather now",
      "",
      `${weatherEmoji(current.weather_code)} ${Math.round(current.temperature_2m)}°C, ${description}`,
      `🌡️ Feels like: ${Math.round(current.apparent_temperature)}°C`,
      `💨 Wind: ${Math.round(current.wind_speed_10m)} km/h`,
      "",
      sourceLine,
      `Timezone: ${weather.timezone}`
    ].join("\n");
  }

  return [
    `<b>${formatSafeCityName(city)}</b>`,
    "Погода сейчас",
    "",
    `${weatherEmoji(current.weather_code)} ${Math.round(current.temperature_2m)}°C, ${description}`,
    `🌡️ Ощущается как: ${Math.round(current.apparent_temperature)}°C`,
    `💨 Ветер: ${Math.round(current.wind_speed_10m)} км/ч`,
    "",
    sourceLine,
    `Часовой пояс: ${weather.timezone}`
  ].join("\n");
}

function formatHourlyWeather(city, weather, day, hour, lang) {
  const date = getDateForDay(weather, day);
  const index = findHourlyIndex(weather, date, hour);
  if (index === -1) {
    return lang === "en"
      ? `I could not find a forecast for ${date} ${String(hour).padStart(2, "0")}:00. Try another time.`
      : `Не нашел прогноз на ${date} ${String(hour).padStart(2, "0")}:00. Попробуй выбрать другое время.`;
  }

  const description = describeWeatherCode(weather.hourly.weather_code[index], lang);
  const precipitation = weather.hourly.precipitation_probability?.[index];

  if (lang === "en") {
    return [
      `<b>${formatSafeCityName(city)}</b>`,
      `Forecast for ${dayLabel(day, lang)} (${date}) at ${String(hour).padStart(2, "0")}:00`,
      "",
      `${weatherEmoji(weather.hourly.weather_code[index])} ${Math.round(weather.hourly.temperature_2m[index])}°C, ${description}`,
      `🌡️ Feels like: ${Math.round(weather.hourly.apparent_temperature[index])}°C`,
      `💨 Wind: ${Math.round(weather.hourly.wind_speed_10m[index])} km/h`,
      precipitation == null ? null : `💧 Chance of precipitation: ${precipitation}%`,
      "",
      `Timezone: ${weather.timezone}`
    ].filter(Boolean).join("\n");
  }

  return [
    `<b>${formatSafeCityName(city)}</b>`,
    `Прогноз на ${dayLabel(day, lang)} (${date}) в ${String(hour).padStart(2, "0")}:00`,
    "",
    `${weatherEmoji(weather.hourly.weather_code[index])} ${Math.round(weather.hourly.temperature_2m[index])}°C, ${description}`,
    `🌡️ Ощущается как: ${Math.round(weather.hourly.apparent_temperature[index])}°C`,
    `💨 Ветер: ${Math.round(weather.hourly.wind_speed_10m[index])} км/ч`,
    precipitation == null ? null : `💧 Вероятность осадков: ${precipitation}%`,
    "",
    `Часовой пояс: ${weather.timezone}`
  ].filter(Boolean).join("\n");
}

function buildDailyAdviceContext(city, weather, day, lang) {
  const dayIndex = day === "tomorrow" ? 1 : 0;
  const min = weather.daily.temperature_2m_min[dayIndex];
  const max = weather.daily.temperature_2m_max[dayIndex];
  return {
    lang,
    city: formatCityName(city),
    label: lang === "en" ? `${dayLabel(day, lang)}, all day` : `${dayLabel(day, lang)}, весь день`,
    temp: (min + max) / 2,
    apparent: (min + max) / 2,
    min,
    max,
    wind: null,
    precipitation: weather.daily.precipitation_probability_max?.[dayIndex] ?? 0,
    code: weather.daily.weather_code[dayIndex],
    isDaily: true
  };
}

function buildCurrentAdviceContext(city, weather, lang, observedCurrent = null) {
  const current = observedCurrent || weather.current;
  return {
    lang,
    city: formatCityName(city),
    label: lang === "en" ? "now" : "сейчас",
    temp: current.temperature_2m,
    apparent: current.apparent_temperature,
    wind: current.wind_speed_10m,
    precipitation: 0,
    code: current.weather_code ?? weather.current.weather_code,
    isDaily: false
  };
}

function buildHourlyAdviceContext(city, weather, day, hour, lang) {
  const date = getDateForDay(weather, day);
  const index = findHourlyIndex(weather, date, hour);
  if (index === -1) return null;
  return {
    lang,
    city: formatCityName(city),
    label: lang === "en"
      ? `${dayLabel(day, lang)} at ${String(hour).padStart(2, "0")}:00`
      : `${dayLabel(day, lang)} в ${String(hour).padStart(2, "0")}:00`,
    temp: weather.hourly.temperature_2m[index],
    apparent: weather.hourly.apparent_temperature[index],
    wind: weather.hourly.wind_speed_10m[index],
    precipitation: weather.hourly.precipitation_probability?.[index] ?? 0,
    code: weather.hourly.weather_code[index],
    isDaily: false
  };
}

function getBaseClothing(apparent, lang) {
  if (lang === "en") {
    if (apparent <= -15) return "thermal base layer, warm sweater or hoodie, down jacket, hat, scarf, and gloves";
    if (apparent <= -5) return "warm jacket, sweater, hat, and gloves";
    if (apparent <= 3) return "winter or thick demi-season jacket with a warm layer underneath";
    if (apparent <= 9) return "jacket or coat, hoodie or sweater underneath";
    if (apparent <= 14) return "light jacket, hoodie, or thick shirt";
    if (apparent <= 19) return "long sleeve, shirt, or light sweater; jacket if you get cold easily";
    if (apparent <= 24) return "T-shirt or light shirt, maybe a thin layer for evening";
    if (apparent <= 29) return "light T-shirt or shirt, shorts or thin trousers";
    return "very light breathable clothes, cap or hat, and water";
  }

  if (apparent <= -15) return "термобелье, теплый свитер/худи, пуховик, шапка, шарф и перчатки";
  if (apparent <= -5) return "теплая куртка, свитер, шапка и перчатки";
  if (apparent <= 3) return "зимняя или плотная демисезонная куртка, теплый верхний слой";
  if (apparent <= 9) return "куртка или пальто, худи/свитер под низ";
  if (apparent <= 14) return "легкая куртка, худи или плотная рубашка";
  if (apparent <= 19) return "лонгслив, рубашка или легкая кофта; куртка по самочувствию";
  if (apparent <= 24) return "футболка или легкая рубашка, можно взять тонкий слой на вечер";
  if (apparent <= 29) return "легкая футболка/рубашка, шорты или тонкие брюки";
  return "максимально легкая одежда из дышащей ткани, головной убор и вода";
}

function getShoeAdvice(apparent, precipitation, code, lang) {
  const rainy = precipitation >= 45 || [51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 99].includes(code);
  const snowy = [71, 73, 75].includes(code);

  if (lang === "en") {
    if (snowy || apparent <= -5) return "shoes: warm and non-slip";
    if (rainy) return "shoes: closed, preferably water-resistant";
    if (apparent >= 23) return "shoes: light but comfortable for walking";
    return "shoes: regular sneakers or season-appropriate boots";
  }

  if (snowy || apparent <= -5) return "обувь: теплая и не скользкая";
  if (rainy) return "обувь: закрытая, лучше непромокаемая";
  if (apparent >= 23) return "обувь: легкая, но удобная для ходьбы";
  return "обувь: обычные кроссовки или ботинки по сезону";
}

function formatClothingAdvice(context) {
  const lang = context.lang || "ru";
  const apparent = Math.round(context.apparent);
  const temp = Math.round(context.temp);
  const precipitation = Math.round(context.precipitation || 0);
  const description = describeWeatherCode(context.code, lang);
  const base = getBaseClothing(apparent, lang);
  const shoe = getShoeAdvice(apparent, precipitation, context.code, lang);
  const safeContextLabel = `${escapeHtml(context.city)}, ${escapeHtml(context.label)}`;

  if (lang === "en") {
    const lines = [
      "<b>What should I wear?</b>",
      safeContextLabel,
      "",
      `1. Base: ${base}.`,
      `2. Feels like: around ${apparent}°C${temp !== apparent ? `, actual ${temp}°C` : ""}.`,
      `3. ${shoe}.`
    ];

    if (context.isDaily && context.min != null && context.max != null) {
      lines.push(`4. Day range: ${Math.round(context.min)}°C to ${Math.round(context.max)}°C, dress in layers.`);
    } else if (context.wind != null && context.wind >= 25) {
      lines.push(`4. Wind ${Math.round(context.wind)} km/h: add a wind-protective layer.`);
    } else {
      lines.push("4. If you will be outside for long, take one thin extra layer.");
    }

    if (precipitation >= 60) {
      lines.push(`5. Rain is likely (${precipitation}%): umbrella or hood is worth it.`);
    } else if (precipitation >= 30) {
      lines.push(`5. Rain is possible (${precipitation}%): a compact umbrella will not hurt.`);
    } else {
      lines.push(`5. Weather: ${description}, no heavy rain protection needed.`);
    }

    return lines.join("\n");
  }

  const lines = [
    "<b>А что по одежде?</b>",
    safeContextLabel,
    "",
    `1. База: ${base}.`,
    `2. По ощущениям: около ${apparent}°C${temp !== apparent ? `, фактически ${temp}°C` : ""}.`,
    `3. ${shoe}.`
  ];

  if (context.isDaily && context.min != null && context.max != null) {
    lines.push(`4. Разброс за день: от ${Math.round(context.min)}°C до ${Math.round(context.max)}°C, лучше одеться слоями.`);
  } else if (context.wind != null && context.wind >= 25) {
    lines.push(`4. Ветер ${Math.round(context.wind)} км/ч: бери слой с защитой от ветра.`);
  } else {
    lines.push("4. Если долго гуляешь, бери запасной тонкий слой.");
  }

  if (precipitation >= 60) {
    lines.push(`5. Осадки вероятны (${precipitation}%): зонт/капюшон прям к месту.`);
  } else if (precipitation >= 30) {
    lines.push(`5. Осадки возможны (${precipitation}%): компактный зонт не помешает.`);
  } else {
    lines.push(`5. По погоде: ${description}, сильной защиты от осадков не требуется.`);
  }

  return lines.join("\n");
}

function normalizeTransportType(type) {
  if (type === "A" || type === "А") return "А";
  if (type === "Tb" || type === "Тб") return "Тб";
  if (type === "M" || type === "М") return "М";
  return type;
}

function transportTypeName(type, lang) {
  const normalized = normalizeTransportType(type);
  if (lang === "en") {
    if (normalized === "А") return "Bus";
    if (normalized === "Тб") return "Trolleybus";
    if (normalized === "М") return "Minibus";
    return "Route";
  }

  if (normalized === "А") return "Автобус";
  if (normalized === "Тб") return "Троллейбус";
  if (normalized === "М") return "Маршрутка";
  return "Маршрут";
}

function transportIcon(type) {
  const normalized = normalizeTransportType(type);
  if (normalized === "Тб") return "🚎";
  if (normalized === "М") return "🚐";
  return "🚌";
}

function safeCallbackText(value) {
  return String(value).replaceAll(":", "_").slice(0, 24);
}

function parseJsonArrayLenient(text) {
  const value = String(text || "").trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    if (!value.startsWith("[")) return [];
    const lastObjectEnd = value.lastIndexOf("}");
    if (lastObjectEnd <= 0) return [];
    const repaired = `${value.slice(0, lastObjectEnd + 1)}]`;
    try {
      const parsed = JSON.parse(repaired);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

function fetchPartialText(url, timeoutMs = 9000, maxBytes = MAX_EXTERNAL_RESPONSE_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    let total = 0;

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (error && chunks.length === 0) {
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const req = https.get(url, {
      headers: {
        Referer: "https://bus62.ru/grodno/",
        "User-Agent": "SkyPulseWeatherBot/1.0"
      }
    }, (res) => {
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy();
          fail(new Error("Transport response too large"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      res.on("end", () => finish());
      res.on("error", finish);
    });

    req.on("error", finish);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish();
    });
  });
}

function fetchText(url, timeoutMs = 12000, maxBytes = MAX_EXTERNAL_RESPONSE_BYTES) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const succeed = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = https.get(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
      }
    }, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy();
          fail(new Error("BTrans response too large"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      res.on("end", () => {
        if (settled) return;
        if (res.statusCode && res.statusCode >= 400) {
          fail(new Error(`BTrans HTTP ${res.statusCode}`));
          return;
        }
        const buffer = Buffer.concat(chunks);
        const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
        const done = (error, decoded) => {
          if (error) {
            fail(error);
            return;
          }
          if (decoded.length > maxBytes) {
            fail(new Error("BTrans decoded response too large"));
            return;
          }
          succeed(decoded.toString("utf8"));
        };

        if (encoding.includes("br")) {
          zlib.brotliDecompress(buffer, done);
        } else if (encoding.includes("gzip")) {
          zlib.gunzip(buffer, done);
        } else if (encoding.includes("deflate")) {
          zlib.inflate(buffer, done);
        } else {
          succeed(buffer.toString("utf8"));
        }
      });
      res.on("error", fail);
    });

    req.on("error", fail);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("BTrans request timeout"));
    });
  });
}

function decodeHtml(value) {
  return String(value || "")
    .replaceAll("&quot;", "\"")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#039;", "'")
    .replaceAll("&nbsp;", " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function btransSlugForType(type) {
  const normalized = normalizeTransportType(type);
  if (normalized === "А") return "avtobus";
  if (normalized === "Тб") return "trollejbus";
  return null;
}

function makeCallbackToken(payload) {
  cleanupCallbackStore();
  while (callbackStore.size >= MAX_CALLBACK_TOKENS) {
    const oldestToken = callbackStore.keys().next().value;
    if (!oldestToken) break;
    callbackStore.delete(oldestToken);
  }

  const token = crypto.randomBytes(16).toString("hex");
  callbackStore.set(token, { ...payload, expiresAt: Date.now() + CALLBACK_TOKEN_TTL_MS });
  return token;
}

function getCallbackPayload(token, chatId) {
  const payload = callbackStore.get(token);
  if (!payload || payload.expiresAt < Date.now()) {
    callbackStore.delete(token);
    return null;
  }
  if (payload.chatId && payload.chatId !== String(chatId)) return null;
  return payload;
}

function splitMessageLines(header, lines, maxLength = 3300) {
  const chunks = [];
  let current = header;
  for (const line of lines) {
    const next = `${current}\n${line}`;
    if (next.length > maxLength && current !== header) {
      chunks.push(current);
      current = `${header}\n${line}`;
    } else {
      current = next;
    }
  }
  chunks.push(current);
  return chunks;
}

async function getTransportJsonArray(endpoint, timeoutMs = 9000) {
  const text = await fetchPartialText(`https://bus62.ru/grodno/php/${endpoint}`, timeoutMs);
  return parseJsonArrayLenient(text);
}

async function getTransportRoutes() {
  const now = Date.now();
  if (transportCache.routes.value && transportCache.routes.expiresAt > now) {
    return transportCache.routes.value;
  }

  const rows = await getTransportJsonArray("getRoutes.php?city=grodno&info=01234", 12000);
  const routes = rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name || ""),
    type: normalizeTransportType(row.type),
    num: String(row.num || ""),
    from: String(row.fromst || ""),
    fromId: Number(row.fromstid),
    to: String(row.tost || ""),
    toId: Number(row.tostid)
  })).filter((route) => route.id && route.type && route.num);

  if (routes.length) {
    transportCache.routes = { value: routes, expiresAt: now + 10 * 60 * 1000 };
  }
  return routes;
}

async function getBtransRouteNumbers(type) {
  const normalized = normalizeTransportType(type);
  const slug = btransSlugForType(normalized);
  if (!slug) return [];

  const cached = transportCache.routeLists.get(slug);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const html = await fetchText(`https://grodno.btrans.by/${slug}`);
  const pattern = new RegExp(`href="https:\\/\\/grodno\\.btrans\\.by\\/${slug}\\/([^"/?#]+)"`, "g");
  const numbers = [...new Set(
    [...html.matchAll(pattern)]
      .map((match) => decodeHtml(match[1]).trim())
      .filter(Boolean)
  )].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b, "ru"));

  if (!numbers.length) throw new Error(`BTrans returned no ${slug} routes`);
  transportCache.routeLists.set(slug, { value: numbers, expiresAt: Date.now() + 30 * 60 * 1000 });
  return numbers;
}

async function getTransportStops() {
  const now = Date.now();
  if (transportCache.stops.value && transportCache.stops.expiresAt > now) {
    return transportCache.stops.value;
  }

  const rows = await getTransportJsonArray("getStations.php?city=grodno&info=01234", 14000);
  const stops = rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name || "").trim(),
    descr: String(row.descr || "").trim(),
    type: String(row.type ?? "0")
  })).filter((stop) => stop.id && stop.name);

  if (stops.length) {
    transportCache.stops = { value: stops, expiresAt: now + 10 * 60 * 1000 };
  }
  return stops;
}

function matchTransportStops(stops, query) {
  const normalized = query.trim().toLowerCase();
  return stops
    .map((stop) => {
      const name = stop.name.toLowerCase();
      const descr = stop.descr.toLowerCase();
      const score = name === normalized ? 0
        : name.startsWith(normalized) ? 1
          : name.includes(normalized) ? 2
            : descr.includes(normalized) ? 3
              : 99;
      return { stop, score };
    })
    .filter((item) => item.score < 99)
    .sort((a, b) => a.score - b.score || a.stop.name.localeCompare(b.stop.name, "ru"))
    .slice(0, 8)
    .map((item) => item.stop);
}

function stopLabel(stop) {
  return stop.descr ? `${stop.name} (${stop.descr})` : stop.name;
}

function stopSearchKeyboard(stops, lang) {
  const rows = stops.map((stop) => ([{
    text: stopLabel(stop).slice(0, 56),
    callback_data: `tr:stop:${stop.id}:${stop.type}`
  }]));
  rows.push([{ text: lang === "en" ? "Transport menu" : "Меню транспорта", callback_data: "transport_menu" }]);
  return { inline_keyboard: rows };
}

function routeListKeyboard(routes, type, lang) {
  const byNumber = new Map();
  for (const route of routes.filter((item) => item.type === normalizeTransportType(type))) {
    if (!byNumber.has(route.num)) byNumber.set(route.num, route);
  }

  const buttons = [...byNumber.values()]
    .sort((a, b) => Number(a.num) - Number(b.num) || a.num.localeCompare(b.num, "ru"))
    .slice(0, 96)
    .map((route) => ({
      text: `${transportIcon(route.type)} ${route.num}`,
      callback_data: `tr:route:${safeCallbackText(route.type)}:${safeCallbackText(route.num)}`
    }));

  const rows = [];
  for (let index = 0; index < buttons.length; index += 4) {
    rows.push(buttons.slice(index, index + 4));
  }
  rows.push([{ text: lang === "en" ? "Find stop" : "Найти остановку", callback_data: "tr:stop_search" }]);
  rows.push([{ text: lang === "en" ? "Transport menu" : "Меню транспорта", callback_data: "transport_menu" }]);
  return { inline_keyboard: rows };
}

function routeDetailKeyboard(routeDirections, lang) {
  const rows = routeDirections.slice(0, 8).map((route) => ([
    {
      text: `${route.from} -> ${route.to}`.slice(0, 58),
      callback_data: `tr:route_stops:${route.id}`
    }
  ]));
  rows.push([{ text: lang === "en" ? "Find stop" : "Найти остановку", callback_data: "tr:stop_search" }]);
  rows.push([{ text: lang === "en" ? "Transport menu" : "Меню транспорта", callback_data: "transport_menu" }]);
  return { inline_keyboard: rows };
}

function btransStopsKeyboard(route, directionIndex, lang, chatId) {
  const direction = route.directions[directionIndex];
  const rows = direction.stops.slice(0, 94).map((stop, index) => {
    const token = makeCallbackToken({
      kind: "btrans_stop",
      chatId: String(chatId),
      url: stop.url,
      routeType: route.type,
      routeNum: route.num,
      directionIndex
    });
    return [{
      text: `${index + 1}. ${stop.name}`.slice(0, 58),
      callback_data: `tr:btstop:${token}`
    }];
  });
  rows.push([{ text: lang === "en" ? "Transport menu" : "Меню транспорта", callback_data: "transport_menu" }]);
  const favorite = isFavoriteRoute(chatId, route.type, route.num);
  rows.splice(Math.max(0, rows.length - 1), 0, [{
    text: favorite
      ? (lang === "en" ? "⭐ In favourites" : "⭐ В избранном")
      : (lang === "en" ? "☆ Add to favourites" : "☆ В избранное"),
    callback_data: `fav:toggle:${safeCallbackText(route.type)}:${safeCallbackText(route.num)}`
  }]);
  return { inline_keyboard: rows.slice(0, 96) };
}

async function getStopForecast(stopId, type = "0") {
  const endpoint = `getStationForecasts.php?sid=${encodeURIComponent(stopId)}&type=${encodeURIComponent(type)}&city=grodno&info=01234`;
  const rows = await getTransportJsonArray(endpoint, 9000);
  return rows.map((row) => ({
    routeType: normalizeTransportType(row.routeType || row.rtype || row.type || row.route_type || ""),
    routeNum: String(row.routeNum || row.rnum || row.num || row.route_num || ""),
    arrTime: row.arrTime ?? row.arr_time ?? row.time ?? row.t ?? "",
    whereGo: String(row.whereGo || row.where_go || row.to || row.tost || "")
  })).filter((item) => item.routeNum || item.routeType || item.arrTime !== "");
}

async function getBtransRoute(type, num) {
  const slug = btransSlugForType(type);
  if (!slug) return null;
  const key = `${slug}:${num}`;
  const cached = transportCache.routePages.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const url = `https://grodno.btrans.by/${slug}/${encodeURIComponent(num)}`;
  const html = await fetchText(url);
  const title = stripTags((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || `${transportTypeName(type, "ru")} ${num}`);
  const directions = [];
  const sectionPattern = /<div id="napravlenie-\d+" class="direction">([\s\S]*?)(?=<div id="napravlenie-\d+" class="direction">|<article|<\/main>)/g;
  const routeNum = String(num).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const linkPattern = new RegExp(`<a[^>]+href="(https:\\/\\/grodno\\.btrans\\.by\\/${slug}\\/${routeNum}\\/[^"]+)"[^>]*>([\\s\\S]*?)<\\/a>`, "g");

  for (const section of html.matchAll(sectionPattern)) {
    const sectionHtml = section[1];
    const directionTitle = stripTags((sectionHtml.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [])[1] || title);
    const stops = [...sectionHtml.matchAll(linkPattern)]
      .map((match) => ({ url: match[1], name: stripTags(match[2]) }))
      .filter((stop) => stop.url && stop.name);
    if (stops.length) directions.push({ title: directionTitle, stops });
  }

  const value = { url, title, type: normalizeTransportType(type), num: String(num), directions };
  transportCache.routePages.set(key, { value, expiresAt: Date.now() + 30 * 60 * 1000 });
  return value;
}

function parseBtransSchedule(html) {
  const title = stripTags((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || "Расписание");
  const stopName = stripTags((html.match(/Название остановки:[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || "");
  const direction = stripTags((html.match(/Направление:[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || "");
  const rows = [...html.matchAll(/<tr class="schedule-section[\s\S]*?<\/tr>/g)].map((match) => match[0]);
  const schedule = { weekdays: [], weekend: [] };
  let currentHour = null;

  for (const row of rows) {
    const hourMatch = row.match(/<th[\s\S]*?<time[^>]*>(\d{1,2})<\/time>[\s\S]*?<\/th>/);
    if (hourMatch) currentHour = hourMatch[1].padStart(2, "0");
    if (!currentHour) continue;

    const type = row.includes("weekend") || row.includes("Вых.") ? "weekend" : "weekdays";
    const minutesCell = (row.match(/<td class="schedule-ceil schedule-minutes[\s\S]*?<\/td>/) || [])[0] || "";
    const minuteMatches = [...minutesCell.matchAll(/<time[^>]*datetime="\d{2}:(\d{2})"[^>]*>([\s\S]*?)<\/time>/g)];
    const minutes = minuteMatches
      .map((item) => stripTags(item[2]))
      .filter((item) => /^\d{1,2}\*?$/.test(item));
    if (minutes.length) schedule[type].push(`${currentHour}: ${minutes.join(" ")}`);
  }

  return { title, stopName, direction, schedule };
}

async function getBtransStopSchedule(url) {
  const cached = transportCache.stopPages.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const html = await fetchText(url);
  const value = parseBtransSchedule(html);
  value.url = url;
  transportCache.stopPages.set(url, { value, expiresAt: Date.now() + 30 * 60 * 1000 });
  return value;
}

function miniAppTransportQuery(value) {
  const query = String(value || "").trim().replace(/\s+/g, " ");
  return query.length >= 2 && query.length <= 280 && !/[\r\n\u0000]/.test(query) ? query : null;
}

function normalizeTransportSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function miniAppStopQuery(value) {
  const stop = String(value || "").trim().replace(/\s+/g, " ");
  if (stop.length < 2 || stop.length > 100 || /[\r\n\u0000]/.test(stop)) return null;
  return stop;
}

function localTransportIntent(query) {
  const text = normalizeTransportSearchText(query);
  const trolleyPattern = /троллейбус|тролейбус|тролл|тралик|тралей|тролик|трал(?:\s|$)/;
  const busPattern = /автобус|автоб|автик|авт(?:\s|$)/;
  const transportWords = "автобус|автоб|автик|авт|троллейбус|тролейбус|тролл|тралик|тралей|тролик|трал";
  const ordinalNumbers = {
    первый: "1", второй: "2", третий: "3", четвертый: "4", пятый: "5",
    шестой: "6", седьмой: "7", восьмой: "8", девятый: "9", десятый: "10"
  };
  const type = trolleyPattern.test(text) ? "Тб" : busPattern.test(`${text} `) ? "А" : null;
  const routeMatch = text.match(new RegExp(`(?:${transportWords}|маршрут)\\s*(?:номер|номера|n|no)?\\s*(\\d{1,3}[a-zа-я]?)`, "i"))
    || text.match(/(?:^|\s)(?:номер|n|no)\s*(\d{1,3}[a-zа-я]?)/i)
    || text.match(new RegExp(`(?:^|\\s)(\\d{1,3}[a-zа-я]?)\\s*(?:${transportWords})`, "i"));
  let route = routeMatch ? miniAppRouteNumber(routeMatch[1]) : null;

  if (!route) {
    for (const [word, number] of Object.entries(ordinalNumbers)) {
      if (new RegExp(`(?:^|\\s)${word}\\s+(?:${transportWords})`, "i").test(text)) {
        route = number;
        break;
      }
    }
  }

  const source = String(query);
  const stopMatch = source.match(/(?:остановк(?:а|е|и|у|ой)?|на\s+остановк(?:е|у|и|ой)?)\s*[:,-]?\s*(.+)$/i)
    || source.match(/,\s*([^,]+?)\s*$/);
  return {
    type,
    route,
    stopQuery: miniAppStopQuery(stopMatch?.[1])
  };
}

function parseGeminiJson(text) {
  const source = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(source.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function geminiOutputText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  const legacy = response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(legacy)) return legacy.map((part) => part?.text || "").join("\n");

  const texts = [];
  const visit = (value, depth = 0) => {
    if (depth > 8 || value == null) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value !== "object") return;
    if (typeof value.text === "string") texts.push(value.text);
    for (const [key, item] of Object.entries(value)) {
      if (key === "input" || key === "system_instruction" || key === "text") continue;
      visit(item, depth + 1);
    }
  };

  visit(response?.output || response?.outputs || response?.steps || null);
  return texts.join("\n");
}

function cleanTransportIntent(value, fallback) {
  const rawType = String(value?.transportType ?? value?.type ?? "").trim();
  const type = rawType === "A" || rawType === "А" || /^автобус/i.test(rawType)
    ? "А"
    : rawType === "Tb" || rawType === "Тб" || /^троллейбус/i.test(rawType)
      ? "Тб"
      : fallback.type;
  const route = miniAppRouteNumber(value?.routeNumber ?? value?.route ?? value?.number) || fallback.route;
  const stopQuery = miniAppStopQuery(value?.stopQuery ?? value?.stop ?? value?.station) || fallback.stopQuery;
  return { type, route, stopQuery };
}

async function geminiTransportIntent(query) {
  if (!GEMINI_API_KEY) return null;
  const prompt = [
    "Ты разбираешь запрос к городскому транспорту Гродно.",
    "Верни только JSON без Markdown: {\"transportType\":\"A\"|\"Tb\"|null,\"routeNumber\":string|null,\"stopQuery\":string|null}.",
    "A — автобус, Tb — троллейбус. Слова «автик», «авт» означают автобус; «тралик», «тролик», «тралей», «трал» — троллейбус.",
    "Из русских порядковых числительных извлекай номер маршрута; остановка может быть указана после запятой.",
    "Не придумывай номер или остановку, если их нет в сообщении.",
    `Запрос пользователя: ${query}`
  ].join("\n");
  const response = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
    method: "POST",
    timeoutMs: 12000,
    maxBytes: 256 * 1024,
    label: "Gemini",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 128,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 }
      }
    })
  });
  return parseGeminiJson(geminiOutputText(response));
}

function grodnoClock(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: GRODNO_TIME_ZONE,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const values = Object.fromEntries(formatter.formatToParts(now)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  return {
    weekday: values.weekday || "Mon",
    year,
    month,
    day,
    date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    minutes: hour * 60 + minute,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
  };
}

function scheduleMinutes(lines) {
  const times = [];
  for (const line of lines || []) {
    const match = String(line).match(/^\s*(\d{1,2})\s*:\s*(.*)$/);
    if (!match) continue;
    const hour = Number(match[1]);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    for (const minute of match[2].matchAll(/(?:^|\s)(\d{1,2})(\*)?(?=\s|$)/g)) {
      const value = Number(minute[1]);
      if (!Number.isInteger(value) || value < 0 || value > 59) continue;
      times.push({ minuteOfDay: hour * 60 + value, inGarage: Boolean(minute[2]) });
    }
  }
  return times;
}

function nextTwoHourDepartures(schedule, now = new Date()) {
  const current = grodnoClock(now);
  const departures = [];
  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    const clock = grodnoClock(new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000));
    const serviceDay = serviceDayForDateParts(clock, BELARUS_WEEKEND_SERVICE_DATES);
    const lines = serviceDay.mode === "weekend" ? schedule.schedule.weekend : schedule.schedule.weekdays;
    for (const item of scheduleMinutes(lines)) {
      const minutesUntil = dayOffset * 24 * 60 + item.minuteOfDay - current.minutes;
      if (minutesUntil < 0 || minutesUntil > 120) continue;
      departures.push({
        time: `${String(Math.floor(item.minuteOfDay / 60)).padStart(2, "0")}:${String(item.minuteOfDay % 60).padStart(2, "0")}`,
        minutesUntil,
        tomorrow: dayOffset === 1,
        inGarage: item.inGarage,
        serviceDay: {
          mode: serviceDay.mode,
          label: serviceDay.label,
          date: serviceDay.date
        }
      });
    }
  }
  return departures.sort((a, b) => a.minutesUntil - b.minutes).slice(0, 24);
}

function editDistanceWithin(left, right, limit) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let smallest = current[0];
    for (let column = 1; column <= right.length; column += 1) {
      const value = left[row - 1] === right[column - 1]
        ? previous[column - 1]
        : Math.min(previous[column - 1], previous[column], current[column - 1]) + 1;
      current.push(value);
      if (value < smallest) smallest = value;
    }
    if (smallest > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length];
}

function stopMatchScore(stopName, query) {
  const stop = normalizeTransportSearchText(stopName);
  const search = normalizeTransportSearchText(query);
  if (!stop || !search) return 0;
  if (stop === search) return 100;
  if (stop.startsWith(search)) return 90;
  if (stop.includes(search) || search.includes(stop)) return 80;
  const words = search.split(" ").filter((word) => word.length > 1);
  const stopWords = stop.split(" ").filter((word) => word.length > 1);
  const matches = words.filter((word) => stopWords.some((stopWord) => {
    if (stopWord.includes(word) || word.includes(stopWord)) return true;
    const limit = word.length >= 7 && stopWord.length >= 7 ? 1 : 0;
    return limit > 0 && editDistanceWithin(word, stopWord, limit) <= limit;
  })).length;
  return matches ? Math.round((matches / words.length) * 65) : 0;
}

async function getMiniAppAiTransportAnswer(query) {
  const fallback = localTransportIntent(query);
  let intent = fallback;
  let aiUsed = false;
  try {
    const gemini = await geminiTransportIntent(query);
    if (gemini) {
      intent = cleanTransportIntent(gemini, fallback);
      aiUsed = true;
    }
  } catch (error) {
    console.warn("Gemini transport parsing failed:", error.message);
  }

  if (!intent.type || !intent.route) {
    return {
      kind: "clarification",
      aiUsed,
      message: "Напиши вид транспорта и номер: например, «автобус 2, остановка Автовокзал»."
    };
  }
  if (!intent.stopQuery) {
    return {
      kind: "clarification",
      aiUsed,
      message: `Маршрут ${intent.route} понял. Теперь напиши остановку, например: «автобус ${intent.route}, остановка Автовокзал».`
    };
  }

  const route = await getBtransRoute(intent.type, intent.route);
  if (!route || !route.directions.length) {
    return {
      kind: "not_found",
      aiUsed,
      message: `Маршрут ${intent.route} не найден. Проверь номер и тип транспорта.`
    };
  }

  const matches = route.directions.flatMap((direction, directionIndex) => direction.stops.map((stop, stopIndex) => ({
    direction,
    directionIndex,
    stop,
    stopIndex,
    score: stopMatchScore(stop.name, intent.stopQuery)
  }))).filter((item) => item.score >= 45)
    .sort((a, b) => b.score - a.score || a.directionIndex - b.directionIndex || a.stopIndex - b.stopIndex)
    .slice(0, 4);

  if (!matches.length) {
    return {
      kind: "not_found",
      aiUsed,
      message: `На маршруте ${intent.route} не нашёл остановку «${intent.stopQuery}». Попробуй написать её точнее.`
    };
  }

  const checkedAt = grodnoClock();
  const currentServiceDay = serviceDayForDateParts(checkedAt, BELARUS_WEEKEND_SERVICE_DATES);
  const directions = [];
  for (const match of matches) {
    const schedule = await getBtransStopSchedule(match.stop.url);
    const departures = nextTwoHourDepartures(schedule);
    directions.push({
      stopName: schedule.stopName || match.stop.name,
      direction: schedule.direction || match.direction.title,
      departures
    });
  }

  return {
    kind: "result",
    aiUsed,
    checkedAt: checkedAt.time,
    calendar: currentServiceDay,
    route: {
      type: intent.type,
      num: route.num,
      title: route.title || `${transportTypeName(intent.type, "ru")} ${route.num}`
    },
    directions,
    message: `Ближайшие рейсы по опубликованному расписанию на следующие 2 часа. Сегодня — ${currentServiceDay.label}: используется ${currentServiceDay.mode === "weekend" ? "расписание выходного дня" : "буднее расписание"}.`
  };
}

function formatBtransSchedule(schedule, lang) {
  const weekdays = schedule.schedule.weekdays.length ? schedule.schedule.weekdays : [lang === "en" ? "No trips" : "нет рейсов"];
  const weekend = schedule.schedule.weekend.length ? schedule.schedule.weekend : [lang === "en" ? "No trips" : "нет рейсов"];
  const header = lang === "en"
    ? `<b>${escapeHtml(schedule.title)}</b>`
    : `<b>${escapeHtml(schedule.title)}</b>`;
  const direction = schedule.direction
    ? (lang === "en" ? `🧭 Direction: ${escapeHtml(schedule.direction)}` : `🧭 Направление: ${escapeHtml(schedule.direction)}`)
    : null;

  return [
    header,
    schedule.stopName ? `🚏 Остановка: ${escapeHtml(schedule.stopName)}` : null,
    direction,
    "",
    "📅 <b>Будни</b>",
    ...weekdays.map((line) => `🕒 ${escapeHtml(line)}`),
    "",
    "🗓️ <b>Выходные</b>",
    ...weekend.map((line) => `🕒 ${escapeHtml(line)}`),
    "",
    "ℹ️ * — в гараж"
  ].filter(Boolean).join("\n");
}

function formatArrival(value, lang) {
  if (value === "" || value == null) return lang === "en" ? "soon" : "скоро";
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric <= 0) return lang === "en" ? "arriving" : "подъезжает";
    return lang === "en" ? `${Math.round(numeric)} min` : `${Math.round(numeric)} мин`;
  }
  return String(value);
}

function formatStopForecast(stop, forecasts, lang) {
  const title = lang === "en"
    ? `🚏 <b>${escapeHtml(stopLabel(stop))}</b>\n⏱️ Nearest arrivals:`
    : `🚏 <b>${escapeHtml(stopLabel(stop))}</b>\n⏱️ Ближайшие прибытия:`;

  if (!forecasts.length) {
    return [
      title,
      "",
      lang === "en"
        ? "The live service did not return arrivals for this stop right now. Try another stop or route."
        : "Live-сервис сейчас не вернул прибытия по этой остановке. Попробуй другую остановку или маршрут."
    ].join("\n");
  }

  const lines = forecasts.slice(0, 12).map((item) => {
    const route = `${transportIcon(item.routeType)} ${item.routeNum}`.trim();
    const where = item.whereGo ? ` -> ${item.whereGo}` : "";
    return `${route} — <b>${formatArrival(item.arrTime, lang)}</b>${escapeHtml(where)}`;
  });

  return [title, "", ...lines].join("\n");
}

async function showTransportMenu(chatId) {
  const lang = langOf(chatId);
  resetToMenu(chatId);
  await sendMessage(chatId, lang === "en"
    ? "🚌 <b>Grodno transport</b>\n\nSearch by stop or choose route type:"
    : "🚌 <b>Транспорт Гродно</b>\n\nНайди остановку или выбери тип маршрута:", {
      reply_markup: transportMenuKeyboard(lang)
    });
}

async function askForStopSearch(chatId) {
  const lang = langOf(chatId);
  userSessions.set(chatId, { step: "transport_stop_search", updatedAt: Date.now() });
  await sendMessage(chatId, lang === "en"
    ? "Type a stop name, for example: Автовокзал or Вишневец."
    : "Напиши название остановки, например: Автовокзал или Вишневец.");
}

async function sendStopSearchResults(chatId, query) {
  const lang = langOf(chatId);
  const stops = await getTransportStops();
  const matches = matchTransportStops(stops, query);

  if (!matches.length) {
    await sendMessage(chatId, lang === "en"
      ? `I did not find a stop for "${escapeHtml(query)}". Try a shorter name.`
      : `Не нашёл остановку по запросу «${escapeHtml(query)}». Попробуй написать короче.`, {
        reply_markup: transportMenuKeyboard(lang)
      });
    return;
  }

  await sendMessage(chatId, lang === "en"
    ? "Choose the stop:"
    : "Выбери остановку:", {
      reply_markup: stopSearchKeyboard(matches, lang)
    });
}

async function showStopForecast(chatId, stopId, type) {
  const lang = langOf(chatId);
  const stops = await getTransportStops();
  const stop = stops.find((item) => item.id === Number(stopId)) || { id: Number(stopId), name: `#${stopId}`, descr: "", type };
  await sendMessage(chatId, [
    `<b>${escapeHtml(stopLabel(stop))}</b>`,
    "",
    lang === "en"
      ? "For the fixed weekday/weekend timetable, choose a route first and then this stop in the full route list."
      : "Для обычного расписания Буд./Вых. сначала выбери маршрут, а потом эту остановку в полном списке маршрута.",
    "",
    lang === "en"
      ? "The old live-arrival mode is disabled because the live service often returns empty data."
      : "Live-прибытия отключил: сервис часто возвращал пустые данные и из-за этого бот ошибался."
  ].join("\n"), {
    reply_markup: transportMenuKeyboard(lang)
  });
}

async function showRoutesByType(chatId, type) {
  const lang = langOf(chatId);
  const normalized = normalizeTransportType(type);

  if (!btransSlugForType(normalized)) {
    await sendMessage(chatId, lang === "en"
      ? "Fixed weekday/weekend schedules are available here for buses and trolleybuses. Minibus timetables are not exposed on BTrans in the same format."
      : "Фиксированное расписание Буд./Вых. сейчас доступно для автобусов и троллейбусов. Маршрутки на BTrans не отдаются в таком же виде.", {
        reply_markup: transportMenuKeyboard(lang)
      });
    return;
  }

  const routeNumbers = await getBtransRouteNumbers(normalized);
  const routes = routeNumbers.map((num) => ({ type: normalized, num }));
  const title = normalized === "М" ? "Маршрутки" : `${transportTypeName(normalized, lang)}ы`;

  await sendMessage(chatId, lang === "en"
    ? `${transportTypeName(normalized, lang)} routes. Choose a route number:`
    : `${title}. Выбери номер маршрута:`, {
      reply_markup: routeListKeyboard(routes, normalized, lang)
    });

  if (!routeNumbers.length) {
    await sendMessage(chatId, lang === "en"
      ? "The transport service returned no routes for this type right now."
      : "Транспортный сервис сейчас не вернул маршруты этого типа.", {
        reply_markup: transportMenuKeyboard(lang)
      });
  }
}

async function showRouteDetails(chatId, type, num) {
  const lang = langOf(chatId);
  const normalized = normalizeTransportType(type);
  const routePage = await getBtransRoute(normalized, num);

  if (!routePage || !routePage.directions.length) {
    await sendMessage(chatId, lang === "en"
      ? "I could not load the full stop list for this route right now."
      : "Сейчас не смог загрузить полный список остановок этого маршрута.", {
        reply_markup: transportMenuKeyboard(lang)
      });
    return;
  }

  for (let index = 0; index < routePage.directions.length; index += 1) {
    const direction = routePage.directions[index];
    const lines = direction.stops.map((stop, stopIndex) => `${stopIndex + 1}. ${escapeHtml(stop.name)}`);
    const chunks = splitMessageLines([
      `<b>${escapeHtml(routePage.title)}</b>`,
      `<b>${escapeHtml(direction.title || `Направление ${index + 1}`)}</b>`,
      "",
      lang === "en" ? "Choose a stop to get the weekday/weekend timetable:" : "Выбери остановку, чтобы получить расписание Буд./Вых.:"
    ].join("\n"), lines);

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      await sendMessage(chatId, chunks[chunkIndex], chunkIndex === chunks.length - 1
        ? { reply_markup: btransStopsKeyboard(routePage, index, lang, chatId) }
        : {});
    }
  }
}

async function showRouteTerminalStops(chatId, routeId) {
  const lang = langOf(chatId);
  const routes = await getTransportRoutes();
  const route = routes.find((item) => item.id === Number(routeId));

  if (!route) {
    await sendMessage(chatId, lang === "en" ? "Route not found." : "Маршрут не найден.", {
      reply_markup: transportMenuKeyboard(lang)
    });
    return;
  }

  const stops = [
    { id: route.fromId, name: route.from, descr: "конечная", type: "0" },
    { id: route.toId, name: route.to, descr: "конечная", type: "0" }
  ].filter((stop) => stop.id && stop.name);

  await sendMessage(chatId, lang === "en"
    ? `Route ${transportIcon(route.type)}-${route.num}: ${escapeHtml(route.from)} -> ${escapeHtml(route.to)}\nChoose terminal stop:`
    : `Маршрут ${transportIcon(route.type)}-${route.num}: ${escapeHtml(route.from)} -> ${escapeHtml(route.to)}\nВыбери конечную остановку:`, {
      reply_markup: stopSearchKeyboard(stops, lang)
    });
}

async function sendWeather(chatId, cityQuery, day = "today", timeChoice = { type: "daily" }) {
  const lang = langOf(chatId);
  let city;
  const savedCity = savedCityFrom(cityQuery);
  if (savedCity) {
    city = savedCity;
  } else try {
    city = await findCity(cityQuery, lang);
  } catch (error) {
    console.error("Geocoding error:", error.message);
    await sendMessage(chatId, lang === "en" ? "Weather search is temporarily unavailable. Try again in a minute." : "Поиск города временно недоступен. Попробуй ещё раз через минуту.", { reply_markup: menuKeyboard(lang) });
    return;
  }
  if (!city) {
    const text = lang === "en"
      ? `I could not find "${escapeHtml(cityQuery)}". Try a more exact city name.`
      : `Не нашел город "${escapeHtml(cityQuery)}". Попробуй написать название точнее.`;
    await sendMessage(chatId, text, { reply_markup: menuKeyboard(lang) });
    return;
  }

  let weather;
  try {
    weather = await getWeather(city);
  } catch (error) {
    console.error("Weather error:", error.message);
    await sendMessage(chatId, lang === "en" ? "The forecast is temporarily unavailable. Try again in a minute." : "Прогноз временно недоступен. Попробуй ещё раз через минуту.", { reply_markup: menuKeyboard(lang) });
    return;
  }
  let message;
  let adviceContext;

  if (timeChoice.type === "current" && day === "today") {
    const observedCurrent = await getObservedCurrent(city).catch(() => null);
    message = formatCurrentWeather(city, weather, lang, observedCurrent);
    adviceContext = buildCurrentAdviceContext(city, weather, lang, observedCurrent);
  } else if (timeChoice.type === "daily") {
    message = formatDailyWeather(city, weather, day, lang);
    adviceContext = buildDailyAdviceContext(city, weather, day, lang);
  } else {
    message = formatHourlyWeather(city, weather, day, timeChoice.hour, lang);
    adviceContext = buildHourlyAdviceContext(city, weather, day, timeChoice.hour, lang);
  }

  if (adviceContext) {
    lastClothingAdvice.set(chatId, {
      context: adviceContext,
      expiresAt: Date.now() + ADVICE_TTL_MS
    });
  }
  await sendMessage(chatId, message, { reply_markup: weatherResultKeyboard(lang) });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function resetToMenu(chatId) {
  userSessions.delete(chatId);
}

function startFlow(chatId, day = null) {
  const session = { step: day ? "city" : "day", day, city: null, updatedAt: Date.now() };
  userSessions.set(chatId, session);
  return session;
}

async function showMenu(chatId) {
  const lang = langOf(chatId);
  await sendMessage(chatId, menuText(lang), { reply_markup: menuKeyboard(lang) });
}

async function askForDay(chatId) {
  const lang = langOf(chatId);
  await sendMessage(chatId, lang === "en" ? "Which day do you need?" : "На какой день нужен прогноз?", {
    reply_markup: dayKeyboard(lang)
  });
}

async function askForCity(chatId, day) {
  const lang = langOf(chatId);
  const text = lang === "en"
    ? `Okay, forecast for ${dayLabel(day, lang)}. Type your city:`
    : `Окей, прогноз на ${dayLabel(day, lang)}. Напиши свой город:`;
  await sendMessage(chatId, text);
}

async function askForTime(chatId, day, city) {
  const lang = langOf(chatId);
  const text = lang === "en"
    ? [
        `City: ${escapeHtml(city)}.`,
        `What time are you interested in for ${dayLabel(day, lang)}?`,
        "",
        "Choose a button below or type an exact hour, like 15, 15:00, 9."
      ].join("\n")
    : [
        `Город: ${escapeHtml(city)}.`,
        `Какой промежуток времени интересует на ${dayLabel(day, lang)}?`,
        "",
        "Выбери кнопку ниже или напиши точный час: например 15, 15:00, 9."
      ].join("\n");

  await sendMessage(chatId, text, { reply_markup: timeKeyboard(lang) });
}

async function handleSession(chatId, text, session) {
  const lang = langOf(chatId);
  session.updatedAt = Date.now();

  if (session.step === "saved_city") {
    let city;
    try {
      city = await findCity(text, lang);
    } catch (error) {
      console.error("Saved city lookup error:", error.message);
      await sendMessage(chatId, lang === "en" ? "City search is temporarily unavailable. Try again in a minute." : "Поиск города временно недоступен. Попробуй ещё раз через минуту.");
      return;
    }
    if (!city) {
      await sendMessage(chatId, lang === "en"
        ? `I could not find "${escapeHtml(text)}". Type the city name more precisely.`
        : `Не нашёл город «${escapeHtml(text)}». Напиши название точнее.`);
      return;
    }
    const preferences = setSavedCity(chatId, city);
    resetToMenu(chatId);
    await sendMessage(chatId, lang === "en"
      ? `✅ Saved city: <b>${escapeHtml(formatCityName(preferences.city))}</b>`
      : `✅ Сохранённый город: <b>${escapeHtml(formatCityName(preferences.city))}</b>`, {
        reply_markup: informationKeyboard(chatId, lang)
      });
    return;
  }

  if (session.step === "transport_stop_search") {
    resetToMenu(chatId);
    await sendStopSearchResults(chatId, text);
    return;
  }

  if (session.step === "day") {
    startFlow(chatId);
    await askForDay(chatId);
    return;
  }

  if (session.step === "city") {
    let city;
    try {
      city = await findCity(text, lang);
    } catch (error) {
      console.error("Weather city lookup error:", error.message);
      await sendMessage(chatId, lang === "en"
        ? "City search is temporarily unavailable. Try again in a minute."
        : "Поиск города временно недоступен. Попробуй ещё раз через минуту.");
      return;
    }
    if (!city) {
      await sendMessage(chatId, lang === "en"
        ? `I could not find "${escapeHtml(text)}". Type the city name more precisely.`
        : `Не нашёл город «${escapeHtml(text)}». Напиши название точнее.`);
      return;
    }
    setSavedCity(chatId, city);
    session.city = city;
    session.step = "time";
    await askForTime(chatId, session.day, formatCityName(city));
    return;
  }

  if (session.step === "time") {
    const timeChoice = parseTimeChoice(text);
    if (!timeChoice) {
      const message = lang === "en"
        ? "I did not understand the time. Choose a button below or type an hour, like 15 or 15:00."
        : "Не понял время. Выбери кнопку ниже или напиши час числом: например 15 или 15:00.";
      await sendMessage(chatId, message, { reply_markup: timeKeyboard(lang) });
      return;
    }

    resetToMenu(chatId);
    await sendWeather(chatId, session.city, session.day, timeChoice);
  }
}

async function handleCallbackQuery(callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  if (!chatId) return;

  if (isRateLimited(chatId, "callback")) {
    await telegram("answerCallbackQuery", {
      callback_query_id: callbackQuery.id,
      text: langOf(chatId) === "en" ? "Too many clicks. Wait a bit." : "Слишком много нажатий. Подожди чуть-чуть."
    });
    return;
  }

  await telegram("answerCallbackQuery", { callback_query_id: callbackQuery.id });

  if (data.startsWith("lang:")) {
    const lang = data.endsWith("en") ? "en" : "ru";
    userLanguages.set(chatId, lang);
    resetToMenu(chatId);

    await telegram("editMessageText", {
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      text: lang === "en" ? "Language: English" : "Язык: Русский"
    });

    await showMenu(chatId);
    return;
  }

  const lang = langOf(chatId);

  if (data === "choose_lang") {
    await sendLanguageChoice(chatId);
    return;
  }

  if (data === "menu") {
    resetToMenu(chatId);
    await showMenu(chatId);
    return;
  }

  if (data === "help") {
    await sendMessage(chatId, helpText(lang), { reply_markup: menuKeyboard(lang) });
    return;
  }

  if (data === "pro") {
    await sendMessage(chatId, proInfoText(lang), { reply_markup: proInfoKeyboard(lang) });
    return;
  }

  if (data === "paysupport") {
    await sendMessage(chatId, paymentSupportText(lang), { reply_markup: proInfoKeyboard(lang) });
    return;
  }

  if (data === "info_menu") {
    await showInformation(chatId);
    return;
  }

  if (data === "info:city") {
    await showCitySettings(chatId);
    return;
  }

  if (data === "info:city_set") {
    userSessions.set(chatId, { step: "saved_city", updatedAt: Date.now() });
    await sendMessage(chatId, lang === "en"
      ? "🏙️ Type the city you want to save for weather forecasts."
      : "🏙️ Напиши город, который нужно сохранить для прогнозов.");
    return;
  }

  if (data === "info:city_clear") {
    clearSavedCity(chatId);
    await sendMessage(chatId, lang === "en" ? "Saved city removed." : "Сохранённый город удалён.", {
      reply_markup: informationKeyboard(chatId, lang)
    });
    return;
  }

  if (data === "fav:menu") {
    await showFavoriteRoutes(chatId);
    return;
  }

  if (data.startsWith("fav:toggle:") || data.startsWith("fav:remove:")) {
    const [, action, type, num] = data.split(":");
    const route = favoriteRouteFrom({ type, num });
    if (!route) {
      await sendMessage(chatId, lang === "en" ? "This route button is invalid. Open the route again." : "Кнопка маршрута устарела. Открой маршрут заново.", {
        reply_markup: transportMenuKeyboard(lang)
      });
      return;
    }

    if (action === "remove") {
      updatePreferences(chatId, (preferences) => ({
        ...preferences,
        favorites: preferences.favorites.filter((item) => item.type !== route.type || item.num !== route.num)
      }));
      await showFavoriteRoutes(chatId);
      return;
    }

    const result = toggleFavoriteRoute(chatId, route.type, route.num);
    if (result.limitReached) {
      await sendMessage(chatId, lang === "en"
        ? `You can save up to ${MAX_FAVORITE_ROUTES} routes. Remove one first.`
        : `Можно сохранить до ${MAX_FAVORITE_ROUTES} маршрутов. Сначала убери один из избранного.`, {
          reply_markup: favoriteRoutesKeyboard(chatId, lang)
        });
      return;
    }
    await showFavoriteRoutes(chatId);
    return;
  }

  if (data === "weather_menu") {
    resetToMenu(chatId);
    await sendMessage(chatId, lang === "en" ? "Choose the forecast day:" : "Выбери день прогноза:", {
      reply_markup: weatherMenuKeyboard(lang)
    });
    return;
  }

  if (data === "transport_menu") {
    await showTransportMenu(chatId);
    return;
  }

  if (data === "tr:stop_search") {
    await askForStopSearch(chatId);
    return;
  }

  if (data.startsWith("tr:type:")) {
    const type = data.slice("tr:type:".length);
    try {
      await showRoutesByType(chatId, type);
    } catch {
      await sendMessage(chatId, lang === "en"
        ? "The transport service is not responding right now. Try again a bit later."
        : "Транспортный сервис сейчас не отвечает. Попробуй чуть позже.", {
          reply_markup: transportMenuKeyboard(lang)
        });
    }
    return;
  }

  if (data.startsWith("tr:route:")) {
    const [, , type, num] = data.split(":");
    try {
      await showRouteDetails(chatId, type, num);
    } catch {
      await sendMessage(chatId, lang === "en"
        ? "Could not load this route right now."
        : "Сейчас не смог загрузить этот маршрут.", {
          reply_markup: transportMenuKeyboard(lang)
        });
    }
    return;
  }

  if (data.startsWith("tr:route_stops:")) {
    const routeId = data.slice("tr:route_stops:".length);
    try {
      await showRouteTerminalStops(chatId, routeId);
    } catch {
      await sendMessage(chatId, lang === "en"
        ? "Could not load route stops right now."
        : "Сейчас не смог загрузить остановки маршрута.", {
          reply_markup: transportMenuKeyboard(lang)
        });
    }
    return;
  }

  if (data.startsWith("tr:btstop:")) {
    const token = data.slice("tr:btstop:".length);
    const payload = getCallbackPayload(token, chatId);
    if (!payload || payload.kind !== "btrans_stop") {
      await sendMessage(chatId, lang === "en"
        ? "This stop button expired. Open the route again."
        : "Эта кнопка остановки устарела. Открой маршрут заново.", {
          reply_markup: transportMenuKeyboard(lang)
        });
      return;
    }

    try {
      const schedule = await getBtransStopSchedule(payload.url);
      await sendMessage(chatId, formatBtransSchedule(schedule, lang), {
        reply_markup: transportMenuKeyboard(lang)
      });
    } catch {
      await sendMessage(chatId, lang === "en"
        ? "Could not load the weekday/weekend timetable for this stop right now."
        : "Сейчас не смог загрузить расписание Буд./Вых. по этой остановке.", {
          reply_markup: transportMenuKeyboard(lang)
        });
    }
    return;
  }

  if (data.startsWith("tr:stop:")) {
    const [, , stopId, type] = data.split(":");
    try {
      await showStopForecast(chatId, stopId, type);
    } catch {
      await sendMessage(chatId, lang === "en"
        ? "Could not load arrivals for this stop right now."
        : "Сейчас не смог загрузить прибытия по этой остановке.", {
          reply_markup: transportMenuKeyboard(lang)
        });
    }
    return;
  }

  if (data === "city:change") {
    const session = userSessions.get(chatId);
    if (!session?.day) {
      await sendMessage(chatId, lang === "en" ? "First choose the forecast day." : "Сначала выбери день прогноза.", {
        reply_markup: weatherMenuKeyboard(lang)
      });
      return;
    }
    session.city = null;
    session.step = "city";
    session.updatedAt = Date.now();
    await askForCity(chatId, session.day);
    return;
  }

  if (data.startsWith("day:")) {
    const day = data.endsWith("tomorrow") ? "tomorrow" : "today";
    const savedCity = preferencesOf(chatId).city;
    if (savedCity) {
      userSessions.set(chatId, { step: "time", day, city: savedCity, updatedAt: Date.now() });
      await askForTime(chatId, day, formatCityName(savedCity));
    } else {
      startFlow(chatId, day);
      await askForCity(chatId, day);
    }
    return;
  }

  if (data.startsWith("time:")) {
    const session = userSessions.get(chatId);
    if (!session || session.step !== "time" || !session.city || !session.day) {
      await sendMessage(chatId, lang === "en" ? "First choose a day and type your city." : "Сначала выбери день и напиши город.", {
        reply_markup: menuKeyboard(lang)
      });
      return;
    }

    const timeChoice = timeChoiceFromCallback(data);
    if (!timeChoice) return;
    resetToMenu(chatId);
    await sendWeather(chatId, session.city, session.day, timeChoice);
    return;
  }

  if (data === "clothing") {
    const cachedAdvice = lastClothingAdvice.get(chatId);
    const adviceContext = cachedAdvice?.expiresAt > Date.now() ? cachedAdvice.context : null;
    if (!adviceContext) lastClothingAdvice.delete(chatId);
    if (!adviceContext) {
      const message = lang === "en"
        ? "Ask for a forecast first, then I can suggest what to wear."
        : "Сначала запроси прогноз, а потом я подскажу, что надеть.";
      await sendMessage(chatId, message, { reply_markup: menuKeyboard(lang) });
      return;
    }

    await sendMessage(chatId, formatClothingAdvice(adviceContext), {
      reply_markup: weatherResultKeyboard(lang)
    });
  }
}

async function handleMessage(message) {
  if (message?.successful_payment) {
    await handleSuccessfulPayment(message);
    return;
  }
  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  if (!text) return;
  const command = text.split(/\s+/, 1)[0].replace(/@[\w_]+$/i, "");

  const lang = langOf(chatId);

  if (isRateLimited(chatId, "message")) {
    await sendMessage(chatId, lang === "en"
      ? "Too many messages. Please wait a minute."
      : "Слишком много сообщений. Подожди минуту.");
    return;
  }

  if (isTextTooLong(text)) {
    await sendMessage(chatId, lang === "en"
      ? "Message is too long. Send a city or stop name up to 160 characters."
      : "Сообщение слишком длинное. Напиши город или остановку до 160 символов.");
    return;
  }

  if (command === "/start") {
    resetToMenu(chatId);
    await sendLanguageChoice(chatId);
    return;
  }

  if (command === "/menu") {
    resetToMenu(chatId);
    await showMenu(chatId);
    return;
  }

  if (command === "/help") {
    await sendMessage(chatId, helpText(lang), { reply_markup: menuKeyboard(lang) });
    return;
  }

  if (command === "/pro") {
    await sendMessage(chatId, proInfoText(lang), { reply_markup: proInfoKeyboard(lang) });
    return;
  }

  if (command === "/paysupport") {
    await sendMessage(chatId, paymentSupportText(lang), { reply_markup: proInfoKeyboard(lang) });
    return;
  }

  const activeSession = userSessions.get(chatId);
  if (activeSession) {
    await handleSession(chatId, text, activeSession);
    return;
  }

  startFlow(chatId);
  await askForDay(chatId);
}

async function poll() {
  try {
    const updates = await telegram("getUpdates", {
      offset,
      timeout: 25,
      allowed_updates: ["message", "callback_query", "pre_checkout_query"]
    });

    for (const update of updates) {
      offset = update.update_id + 1;
      await handleUpdate(update);
    }
  } catch (error) {
    console.error("Polling error:", error.message);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  setImmediate(poll);
}

async function handleUpdate(update) {
  await grantConfiguredUsernameComplimentaryPro(
    update?.message?.from || update?.callback_query?.from || update?.pre_checkout_query?.from
  );

  if (update.pre_checkout_query) {
    await handlePreCheckoutQuery(update.pre_checkout_query);
    return;
  }
  if (update.message?.successful_payment) {
    await handleSuccessfulPayment(update.message);
    return;
  }
  try {
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    } else if (update.message) {
      await handleMessage(update.message);
    }
  } catch (error) {
    console.error("Update handling error:", error.message);
  }
}

function getWebhookBaseUrl() {
  if (process.env.WEBHOOK_URL) return process.env.WEBHOOK_URL.replace(/\/$/, "");
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "");
  if (process.env.RENDER_EXTERNAL_HOSTNAME) return `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
  return "";
}

async function configureWebhook(baseUrl) {
  const webhookUrl = `${baseUrl}${WEBHOOK_PATH}`;
  await telegram("deleteWebhook", { drop_pending_updates: false });
  await telegram("setWebhook", {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query", "pre_checkout_query"],
    secret_token: WEBHOOK_SECRET || undefined
  });
  console.log(`Telegram webhook set for host: ${new URL(webhookUrl).host}`);
}

async function configureMiniAppMenuButton() {
  const url = getMiniAppUrl();
  if (!url) {
    console.warn("Mini App menu button was skipped because its URL is missing.");
    return;
  }

  await telegram("setChatMenuButton", {
    menu_button: {
      type: "web_app",
      text: "Открыть",
      web_app: { url }
    }
  });
  console.log(`Telegram Mini App menu button set for host: ${new URL(url).host}`);
}

async function logWebhookStatus() {
  try {
    const info = await telegram("getWebhookInfo", {});
    let host = "unknown";
    let pathMatches = false;
    try {
      const configuredUrl = new URL(String(info?.url || ""));
      host = configuredUrl.host;
      pathMatches = configuredUrl.pathname === WEBHOOK_PATH;
    } catch {}
    const pending = Number.isFinite(Number(info?.pending_update_count)) ? Number(info.pending_update_count) : 0;
    const lastError = String(info?.last_error_message || "none").slice(0, 220);
    console.log(`Telegram webhook status: host=${host}, pathMatches=${pathMatches}, pending=${pending}, lastError=${lastError}`);
  } catch (error) {
    console.error("Telegram webhook status error:", error.message);
  }
}

async function logTelegramBotIdentity() {
  try {
    const bot = await telegram("getMe", {});
    console.log(`Telegram bot identity: @${String(bot?.username || "unknown")}`);
  } catch (error) {
    console.error("Telegram bot identity error:", error.message);
  }
}

function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, securityHeaders("application/json; charset=utf-8"));
  res.end(JSON.stringify(value));
}

function miniAppError(res, statusCode, message) {
  sendJson(res, statusCode, { ok: false, error: message });
}

function weatherNotificationSecretMatches(value) {
  if (!WEATHER_NOTIFICATIONS_SHARED_SECRET || typeof value !== "string") return false;
  const expected = Buffer.from(WEATHER_NOTIFICATIONS_SHARED_SECRET);
  const received = Buffer.from(value);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

async function handleWeatherNotificationDelivery(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }
  if (!weatherNotificationSecretMatches(String(req.headers["x-skypulse-notification-secret"] || ""))) {
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return;
  }

  let payload;
  try {
    const body = await readRequestBody(req, 16 * 1024);
    payload = JSON.parse(body);
  } catch (error) {
    sendJson(res, error?.message === "Request body too large" ? 413 : 400, { ok: false, error: "Invalid request" });
    return;
  }

  const input = Array.isArray(payload?.subscribers) ? payload.subscribers : null;
  if (!input || input.length > WEATHER_NOTIFICATION_MAX_RECIPIENTS) {
    sendJson(res, 400, { ok: false, error: "Invalid subscribers" });
    return;
  }
  const subscribers = input.map(weatherNotificationSubscriber);
  if (subscribers.some((subscriber) => !subscriber)) {
    sendJson(res, 400, { ok: false, error: "Invalid subscriber" });
    return;
  }

  try {
    const result = await deliverWeatherNotificationBatch(subscribers);
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    console.error("Weather notification batch failed:", error.message);
    sendJson(res, 502, { ok: false, error: "Weather notifications are unavailable" });
  }
}

function miniAppHtml() {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <title>Расписание Гродно</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--tg-theme-bg-color, #f5f7fb);
      --card: var(--tg-theme-secondary-bg-color, #ffffff);
      --text: var(--tg-theme-text-color, #172033);
      --hint: var(--tg-theme-hint-color, #6e7787);
      --accent: var(--tg-theme-button-color, #2888e8);
      --accent-text: var(--tg-theme-button-text-color, #ffffff);
      --border: rgba(126, 138, 158, .28);
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(100%, 720px); margin: 0 auto; padding: 20px 16px calc(28px + env(safe-area-inset-bottom)); }
    h1 { margin: 0; font-size: 25px; letter-spacing: -.35px; }
    h2 { margin: 22px 0 10px; font-size: 18px; }
    p { margin: 5px 0 0; }
    .muted { color: var(--hint); font-size: 14px; }
    .tabs, .route-grid { display: grid; gap: 9px; }
    .tabs { grid-template-columns: 1fr 1fr; margin-top: 20px; }
    .app-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; margin-bottom: 16px; }
    .app-tabs button { padding-inline: 7px; font-size: 14px; }
    .route-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
    button { appearance: none; border: 1px solid var(--border); border-radius: 13px; background: var(--card); color: var(--text); padding: 12px 10px; font: inherit; font-weight: 650; cursor: pointer; min-height: 46px; }
    button:active { opacity: .72; transform: scale(.985); }
    button.selected, button.primary { border-color: var(--accent); background: var(--accent); color: var(--accent-text); }
    button.route { padding: 9px 3px; min-height: 42px; border-radius: 11px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 14px; margin-top: 14px; }
    .direction { width: 100%; text-align: left; margin-top: 9px; }
    .stop-list { display: grid; gap: 7px; margin-top: 10px; }
    .stop { width: 100%; text-align: left; font-weight: 500; }
    .stop span { color: var(--hint); display: inline-block; min-width: 28px; font-variant-numeric: tabular-nums; }
    .back { background: transparent; border: 0; color: var(--accent); padding: 0; min-height: 26px; font-weight: 650; }
    .schedule-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .schedule-title { margin: 0 0 6px; font-weight: 750; }
    .schedule-line { padding: 5px 0; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
    .notice { min-height: 21px; margin-top: 13px; color: var(--hint); font-size: 14px; }
    .notice.error { color: #d84f4f; }
    .weather-search { display: grid; grid-template-columns: 1fr auto; gap: 9px; margin-top: 16px; }
    input, textarea { width: 100%; min-height: 46px; border: 1px solid var(--border); border-radius: 13px; background: var(--card); color: var(--text); padding: 11px 13px; font: inherit; outline: none; }
    input:focus, textarea:focus { border-color: var(--accent); }
    textarea { min-height: 112px; resize: vertical; line-height: 1.42; }
    .weather-now { font-size: 23px; font-weight: 750; margin-top: 4px; }
    .forecast-days { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
    .forecast-day { padding: 12px; border: 1px solid var(--border); border-radius: 13px; }
    .forecast-day strong { display: block; }
    .clothing-card { padding: 12px; margin-top: 10px; border: 1px solid var(--border); border-radius: 13px; }
    .clothing-card p { margin-top: 8px; }
    .weather-notification-card { padding: 12px; margin-top: 12px; border: 1px solid var(--border); border-radius: 13px; }
    .weather-notification-card p { margin-top: 7px; }
    .weather-notification-card button { width: 100%; margin-top: 10px; }
    .pro-card { padding: 13px; margin-top: 12px; border: 1px solid color-mix(in srgb, var(--accent) 58%, var(--border)); border-radius: 13px; background: color-mix(in srgb, var(--accent) 10%, var(--card)); }
    .pro-card p { margin-top: 7px; }
    .pro-card button { width: 100%; margin-top: 10px; }
    .pro-hourly-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
    .pro-hourly-slot { padding: 9px; border: 1px solid var(--border); border-radius: 11px; font-size: 13px; }
    .pro-hourly-slot strong { display: block; }
    .pro-hourly-slot span { display: block; margin-top: 3px; color: var(--hint); }
    .assistant-card { margin-top: 16px; }
    .assistant-form { display: grid; grid-template-columns: 1fr auto; gap: 9px; margin-top: 12px; }
    .assistant-result { margin-top: 10px; }
    .assistant-direction { padding-top: 10px; margin-top: 10px; border-top: 1px solid var(--border); }
    .assistant-direction:first-child { border-top: 0; padding-top: 0; margin-top: 0; }
    .departure-list { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 8px; }
    .departure { padding: 6px 8px; border: 1px solid var(--border); border-radius: 9px; font-variant-numeric: tabular-nums; font-size: 14px; }
    .departure strong { display: block; }
    .trip-form { display: grid; gap: 9px; margin-top: 12px; }
    .trip-form button { width: 100%; }
    .trip-result { display: grid; gap: 10px; margin-top: 12px; }
    .trip-option { padding: 12px; border: 1px solid var(--border); border-radius: 13px; }
    .trip-option:first-child { border-color: var(--accent); }
    .trip-option strong { display: block; }
    .trip-option p { margin-top: 7px; }
    .trip-leg { padding-top: 8px; margin-top: 8px; border-top: 1px solid var(--border); }
    #trip-map { height: 280px; margin-top: 12px; border: 1px solid var(--border); border-radius: 13px; overflow: hidden; background: var(--card); }
    .leaflet-container { font: 14px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    [hidden] { display: none !important; }
    @media (max-width: 430px) { .assistant-form { grid-template-columns: 1fr; } }
    @media (max-width: 360px) { .route-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } .schedule-grid, .forecast-days, .pro-hourly-list { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <section class="app-tabs" aria-label="Раздел">
      <button id="weather-tab" class="selected" type="button">🌤️ Погода</button>
      <button id="transport-tab" type="button">🚌 Расписание</button>
    </section>

    <section id="weather-section">
      <header>
        <h1>🌤️ Погода</h1>
        <p class="muted">Укажи город — покажем погоду сейчас, сегодня и завтра.</p>
      </header>
      <form id="weather-form" class="weather-search">
        <input id="weather-city" type="search" maxlength="100" autocomplete="address-level2" placeholder="Например, Гродно" aria-label="Город">
        <button class="primary" type="submit">Показать</button>
      </form>
      <div id="weather-notice" class="notice" role="status"></div>
      <div id="weather-result" class="card" hidden>
        <strong id="weather-city-title"></strong>
        <p id="weather-now" class="weather-now"></p>
        <p id="weather-details" class="muted"></p>
        <div id="forecast-days" class="forecast-days"></div>
        <div class="weather-notification-card">
          <strong>🔔 Погода каждые 3 часа</strong>
          <p class="muted">Бот будет присылать текущую погоду в личный чат. Подписку можно выключить в любой момент.</p>
          <button id="weather-notification-toggle" type="button" disabled>Проверяю подписку…</button>
          <div id="weather-notification-notice" class="notice" role="status"></div>
        </div>
        <div class="pro-card">
          <strong>✨ SkyPulse Pro</strong>
          <p class="muted">Совет по одежде, план погоды на 24 часа с лучшим окном для дороги или прогулки и важные предупреждения о ливне, сильном ветре или грозе.</p>
          <button id="pro-weather-toggle" type="button" disabled>Проверяю доступ к Pro…</button>
          <div id="pro-weather-details" hidden>
            <div class="clothing-card">
              <strong id="clothing-title"></strong>
              <p id="clothing-base"></p>
              <p id="clothing-shoes"></p>
              <p id="clothing-extra" class="muted"></p>
            </div>
            <p id="pro-weather-window" class="muted"></p>
            <div id="pro-hourly-list" class="pro-hourly-list" aria-label="План погоды на 24 часа"></div>
          </div>
          <div id="pro-weather-notice" class="notice" role="status"></div>
          <p class="muted">${PRO_MONTHLY_PRICE_STARS} ⭐ за 30 дней. Подписка продлевается автоматически, её можно отключить в любой момент.</p>
          <button id="pro-toggle" type="button" disabled>Проверяю SkyPulse Pro…</button>
          <div id="pro-notice" class="notice" role="status"></div>
        </div>
      </div>
    </section>

    <div id="transport-section" hidden>
    <header>
      <h1>🚌 Расписание Гродно</h1>
      <p class="muted">Выбери маршрут и остановку — покажем время в будни и выходные.</p>
    </header>

    <section class="card">
      <strong>🧭 Построить поездку</strong>
      <p class="muted">Укажи адреса в Гродно. Покажем быстрые варианты, пересадки, нужные остановки и путь на карте.</p>
      <form id="trip-form" class="trip-form">
        <input id="trip-from" type="search" maxlength="160" autocomplete="street-address" placeholder="Откуда: например, Советская 8" aria-label="Адрес отправления">
        <input id="trip-to" type="search" maxlength="160" autocomplete="street-address" placeholder="Куда: например, ТРК Тринити" aria-label="Адрес назначения">
        <button class="primary" type="submit">Построить маршрут</button>
      </form>
      <div id="trip-notice" class="notice" role="status"></div>
      <div id="trip-result" class="trip-result" hidden></div>
      <div id="trip-map" hidden aria-label="Карта поездки"></div>
    </section>

    <section class="card assistant-card">
      <strong>🤖 Умный поиск по остановке</strong>
      <p class="muted">Напиши по‑простому: «второй автобус, остановка Автовокзал». Покажем рейсы на ближайшие 2 часа по времени Гродно — с учётом выходных и официальных нерабочих дней Беларуси.</p>
      <form id="assistant-form" class="assistant-form">
        <input id="assistant-query" type="search" maxlength="280" autocomplete="off" placeholder="Автобус 2, остановка Автовокзал" aria-label="Запрос по транспорту">
        <button class="primary" type="submit">Найти</button>
      </form>
      <div id="assistant-notice" class="notice" role="status"></div>
      <div id="assistant-result" class="assistant-result" hidden></div>
    </section>

    <section class="tabs" aria-label="Тип транспорта">
      <button class="selected" type="button" data-type="A">🚌 Автобусы</button>
      <button type="button" data-type="Tb">🚎 Троллейбусы</button>
    </section>
    <div id="notice" class="notice" role="status"></div>

    <section id="routes-section">
      <h2 id="routes-heading">Автобусные маршруты</h2>
      <div id="routes" class="route-grid" aria-live="polite"></div>
    </section>

    <section id="route-section" hidden>
      <button id="route-back" class="back" type="button">← К маршрутам</button>
      <div class="card">
        <strong id="route-title"></strong>
        <p class="muted">Выбери направление, затем остановку.</p>
        <div id="directions"></div>
      </div>
    </section>

    <section id="schedule-section" hidden>
      <button id="schedule-back" class="back" type="button">← К остановкам</button>
      <div class="card">
        <strong id="schedule-title"></strong>
        <p id="schedule-direction" class="muted"></p>
        <div class="schedule-grid">
          <div><p class="schedule-title">Будни</p><div id="weekdays"></div></div>
          <div><p class="schedule-title">Выходные</p><div id="weekend"></div></div>
        </div>
        <p class="muted">* — в гараж</p>
      </div>
    </section>
    </div>
  </main>
  <script>
    (function () {
      var telegram = window.Telegram && window.Telegram.WebApp;
      if (telegram) { telegram.ready(); telegram.expand(); }

      var state = { type: "A", route: null };
      var tabs = Array.prototype.slice.call(document.querySelectorAll("[data-type]"));
      var notice = document.getElementById("notice");
      var routes = document.getElementById("routes");
      var routesHeading = document.getElementById("routes-heading");
      var routeSection = document.getElementById("route-section");
      var routeTitle = document.getElementById("route-title");
      var directions = document.getElementById("directions");
      var scheduleSection = document.getElementById("schedule-section");
      var scheduleTitle = document.getElementById("schedule-title");
      var scheduleDirection = document.getElementById("schedule-direction");
      var weekdays = document.getElementById("weekdays");
      var weekend = document.getElementById("weekend");
      var weatherTab = document.getElementById("weather-tab");
      var transportTab = document.getElementById("transport-tab");
      var weatherSection = document.getElementById("weather-section");
      var transportSection = document.getElementById("transport-section");
      var weatherForm = document.getElementById("weather-form");
      var weatherCityInput = document.getElementById("weather-city");
      var weatherNotice = document.getElementById("weather-notice");
      var weatherResult = document.getElementById("weather-result");
      var weatherCityTitle = document.getElementById("weather-city-title");
      var weatherNow = document.getElementById("weather-now");
      var weatherDetails = document.getElementById("weather-details");
      var forecastDays = document.getElementById("forecast-days");
      var clothingTitle = document.getElementById("clothing-title");
      var clothingBase = document.getElementById("clothing-base");
      var clothingShoes = document.getElementById("clothing-shoes");
      var clothingExtra = document.getElementById("clothing-extra");
      var weatherNotificationToggle = document.getElementById("weather-notification-toggle");
      var weatherNotificationNotice = document.getElementById("weather-notification-notice");
      var weatherNotification = { city: "", subscribed: false, subscribedCity: null, busy: false };
      var weatherNotificationRequestId = 0;
      var proToggle = document.getElementById("pro-toggle");
      var proNotice = document.getElementById("pro-notice");
      var pro = { active: false, expiresAt: null, autoRenewing: false, complimentary: false, busy: false, loaded: false };
      var proWeatherToggle = document.getElementById("pro-weather-toggle");
      var proWeatherDetails = document.getElementById("pro-weather-details");
      var proWeatherNotice = document.getElementById("pro-weather-notice");
      var proWeatherWindow = document.getElementById("pro-weather-window");
      var proHourlyList = document.getElementById("pro-hourly-list");
      var proWeather = { city: "", loadedCity: "", busy: false };
      var proWeatherRequestId = 0;
      var assistantForm = document.getElementById("assistant-form");
      var assistantQuery = document.getElementById("assistant-query");
      var assistantNotice = document.getElementById("assistant-notice");
      var assistantResult = document.getElementById("assistant-result");
      var tripForm = document.getElementById("trip-form");
      var tripFrom = document.getElementById("trip-from");
      var tripTo = document.getElementById("trip-to");
      var tripNotice = document.getElementById("trip-notice");
      var tripResult = document.getElementById("trip-result");
      var tripMapElement = document.getElementById("trip-map");
      var tripMapInstance = null;
      var tripMapLayers = null;
      var transportLoaded = false;

      function setNotice(text, isError) {
        notice.textContent = text || "";
        notice.className = isError ? "notice error" : "notice";
      }

      function request(path, options) {
        options = options || {};
        options.headers = Object.assign({ Accept: "application/json" }, options.headers || {});
        if (telegram && telegram.initData) options.headers["X-Telegram-Init-Data"] = telegram.initData;
        return fetch(path, options).then(function (response) {
          if (!response.ok) throw new Error("request failed");
          return response.json();
        }).then(function (body) {
          if (!body || body.ok !== true) throw new Error("invalid response");
          return body;
        });
      }

      function postJson(path, body) {
        return request(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
      }

      function setWeatherNotice(text, isError) {
        weatherNotice.textContent = text || "";
        weatherNotice.className = isError ? "notice error" : "notice";
      }

      function setWeatherNotificationNotice(text, isError) {
        weatherNotificationNotice.textContent = text || "";
        weatherNotificationNotice.className = isError ? "notice error" : "notice";
      }

      function sameWeatherCity(left, right) {
        return String(left || "").trim().toLocaleLowerCase("ru") === String(right || "").trim().toLocaleLowerCase("ru");
      }

      function updateWeatherNotificationToggle() {
        var city = weatherNotification.city;
        var subscribedToCurrentCity = weatherNotification.subscribed && sameWeatherCity(weatherNotification.subscribedCity, city);
        weatherNotificationToggle.disabled = !city || weatherNotification.busy;
        if (weatherNotification.busy) {
          weatherNotificationToggle.textContent = "Сохраняю…";
        } else if (subscribedToCurrentCity) {
          weatherNotificationToggle.textContent = "🔕 Выключить уведомления";
        } else {
          weatherNotificationToggle.textContent = "🔔 Получать погоду каждые 3 часа";
        }
      }

      function applyWeatherNotificationSubscription(subscription) {
        weatherNotification.subscribed = Boolean(subscription && subscription.subscribed);
        weatherNotification.subscribedCity = weatherNotification.subscribed ? String(subscription.city || "") : null;
        updateWeatherNotificationToggle();
      }

      function refreshWeatherNotification(city) {
        var requestId = weatherNotificationRequestId + 1;
        weatherNotificationRequestId = requestId;
        weatherNotification.city = String(city || "").trim();
        weatherNotification.subscribed = false;
        weatherNotification.subscribedCity = null;
        weatherNotification.busy = true;
        updateWeatherNotificationToggle();
        setWeatherNotificationNotice("Проверяю подписку…", false);
        postJson("/api/weather-notifications", { action: "status" }).then(function (data) {
          if (requestId !== weatherNotificationRequestId) return;
          applyWeatherNotificationSubscription(data.subscription || {});
          if (weatherNotification.subscribed && !sameWeatherCity(weatherNotification.subscribedCity, weatherNotification.city)) {
            setWeatherNotificationNotice("Сейчас уведомления приходят для города: " + weatherNotification.subscribedCity + ". Нажми кнопку, чтобы сменить город.", false);
          } else {
            setWeatherNotificationNotice("", false);
          }
        }).catch(function () {
          if (requestId !== weatherNotificationRequestId) return;
          weatherNotification.subscribed = false;
          weatherNotification.subscribedCity = null;
          setWeatherNotificationNotice("Уведомления пока недоступны. Попробуй чуть позже.", true);
        }).finally(function () {
          if (requestId !== weatherNotificationRequestId) return;
          weatherNotification.busy = false;
          updateWeatherNotificationToggle();
        });
      }

      function toggleWeatherNotification() {
        if (!weatherNotification.city || weatherNotification.busy) return;
        var requestId = weatherNotificationRequestId + 1;
        weatherNotificationRequestId = requestId;
        var unsubscribe = weatherNotification.subscribed && sameWeatherCity(weatherNotification.subscribedCity, weatherNotification.city);
        weatherNotification.busy = true;
        updateWeatherNotificationToggle();
        setWeatherNotificationNotice(unsubscribe ? "Выключаю уведомления…" : "Включаю уведомления…", false);
        postJson("/api/weather-notifications", {
          action: unsubscribe ? "unsubscribe" : "subscribe",
          city: weatherNotification.city
        }).then(function (data) {
          if (requestId !== weatherNotificationRequestId) return;
          applyWeatherNotificationSubscription(data.subscription || {});
          setWeatherNotificationNotice(unsubscribe ? "Уведомления выключены." : "Готово — бот будет писать раз в 3 часа.", false);
        }).catch(function () {
          if (requestId !== weatherNotificationRequestId) return;
          setWeatherNotificationNotice("Не получилось изменить подписку. Попробуй ещё раз чуть позже.", true);
        }).finally(function () {
          if (requestId !== weatherNotificationRequestId) return;
          weatherNotification.busy = false;
          updateWeatherNotificationToggle();
        });
      }

      function setProNotice(text, isError) {
        proNotice.textContent = text || "";
        proNotice.className = isError ? "notice error" : "notice";
      }

      function setProWeatherNotice(text, isError) {
        proWeatherNotice.textContent = text || "";
        proWeatherNotice.className = isError ? "notice error" : "notice";
      }

      function proExpirationText(expiresAt) {
        var date = new Date(Number(expiresAt) * 1000);
        if (!isFinite(date.getTime())) return "конца периода";
        try {
          return new Intl.DateTimeFormat("ru-RU", {
            timeZone: "Europe/Minsk", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
          }).format(date);
        } catch (_) {
          return date.toLocaleString("ru-RU");
        }
      }

      function applyProSubscription(subscription) {
        var expiresAt = Number(subscription && subscription.expiresAt);
        pro.active = Boolean(subscription && subscription.active && isFinite(expiresAt) && expiresAt > 0);
        pro.expiresAt = pro.active ? expiresAt : null;
        pro.autoRenewing = Boolean(pro.active && subscription && subscription.autoRenewing);
        pro.complimentary = Boolean(pro.active && subscription && subscription.complimentary);
        pro.loaded = true;
        if (!pro.active) clearProWeatherDetails();
        updateProToggle();
      }

      function updateProToggle() {
        proToggle.disabled = !pro.loaded || pro.busy || pro.complimentary;
        if (pro.busy) {
          proToggle.textContent = "Сохраняю…";
        } else if (!pro.loaded) {
          proToggle.textContent = "Проверяю SkyPulse Pro…";
        } else if (!pro.active) {
          proToggle.textContent = "✨ Оформить Pro · ${PRO_MONTHLY_PRICE_STARS} ⭐";
        } else if (pro.complimentary) {
          proToggle.textContent = "🎁 Pro в подарок";
        } else if (pro.autoRenewing) {
          proToggle.textContent = "🔕 Отключить автопродление";
        } else {
          proToggle.textContent = "🔔 Включить автопродление";
        }
        updateProWeatherToggle();
      }

      function updateProWeatherToggle() {
        var detailsOpenForCurrentCity = !proWeatherDetails.hidden && sameWeatherCity(proWeather.loadedCity, proWeather.city);
        proWeatherToggle.disabled = !proWeather.city || proWeather.busy || !pro.loaded || !pro.active;
        if (proWeather.busy) {
          proWeatherToggle.textContent = "Загружаю Pro-план…";
        } else if (!pro.loaded) {
          proWeatherToggle.textContent = "Проверяю доступ к Pro…";
        } else if (!pro.active) {
          proWeatherToggle.textContent = "🔒 Одежда и план на 24 часа — в Pro";
        } else if (detailsOpenForCurrentCity) {
          proWeatherToggle.textContent = "Скрыть Pro-план";
        } else {
          proWeatherToggle.textContent = "✨ Открыть Pro-план на 24 часа";
        }
      }

      function clearProWeatherDetails() {
        proWeatherDetails.hidden = true;
        proWeather.loadedCity = "";
        clothingTitle.textContent = "";
        clothingBase.textContent = "";
        clothingShoes.textContent = "";
        clothingExtra.textContent = "";
        proWeatherWindow.textContent = "";
        proHourlyList.replaceChildren();
      }

      function renderProWeatherDetails(details) {
        var clothing = details && details.clothing || {};
        clothingTitle.textContent = clothing.title || "Совет по одежде";
        clothingBase.textContent = "База: " + (clothing.base || "смотри по погоде.");
        clothingShoes.textContent = clothing.shoes || "";
        clothingExtra.textContent = clothing.extra || "";
        proWeatherWindow.textContent = details && details.comfortWindow || "";
        proHourlyList.replaceChildren();
        (details && details.hours || []).slice(0, 24).forEach(function (hour) {
          var slot = document.createElement("div");
          slot.className = "pro-hourly-slot";
          var time = document.createElement("strong");
          time.textContent = String(hour.time || "—");
          var temperature = document.createElement("span");
          temperature.textContent = String(hour.emoji || "🌡️") + " " + String(hour.temperature) + "°C";
          var conditions = document.createElement("span");
          conditions.textContent = "Осадки " + String(hour.precipitation) + "% · ветер " + String(hour.wind) + " км/ч";
          slot.appendChild(time);
          slot.appendChild(temperature);
          slot.appendChild(conditions);
          proHourlyList.appendChild(slot);
        });
        proWeatherDetails.hidden = false;
      }

      function toggleProWeather() {
        if (!proWeather.city || proWeather.busy || !pro.loaded || !pro.active) return;
        if (!proWeatherDetails.hidden && sameWeatherCity(proWeather.loadedCity, proWeather.city)) {
          proWeatherDetails.hidden = true;
          updateProWeatherToggle();
          return;
        }
        var requestId = proWeatherRequestId + 1;
        proWeatherRequestId = requestId;
        proWeather.busy = true;
        updateProWeatherToggle();
        setProWeatherNotice("Готовлю персональный план погоды…", false);
        postJson("/api/pro", { action: "weather_details", city: proWeather.city }).then(function (data) {
          if (requestId !== proWeatherRequestId || !data.details) return;
          renderProWeatherDetails(data.details);
          proWeather.loadedCity = String(data.details.city || proWeather.city);
          setProWeatherNotice("", false);
        }).catch(function () {
          if (requestId !== proWeatherRequestId) return;
          proWeatherDetails.hidden = true;
          setProWeatherNotice("Не получилось загрузить Pro-план. Попробуй ещё раз чуть позже.", true);
        }).finally(function () {
          if (requestId !== proWeatherRequestId) return;
          proWeather.busy = false;
          updateProWeatherToggle();
        });
      }

      function refreshPro() {
        if (pro.busy) return Promise.resolve();
        pro.busy = true;
        updateProToggle();
        return postJson("/api/pro", { action: "status" }).then(function (data) {
          applyProSubscription(data.subscription || {});
          if (pro.active) {
            setProNotice(pro.complimentary
              ? "Твоя подарочная подписка Pro активна до " + proExpirationText(pro.expiresAt) + "."
              : "Pro активен до " + proExpirationText(pro.expiresAt) + (pro.autoRenewing ? ". Автопродление включено." : ". Автопродление выключено."), false);
          } else {
            setProNotice("", false);
          }
        }).catch(function () {
          pro.loaded = false;
          pro.active = false;
          pro.complimentary = false;
          clearProWeatherDetails();
          setProNotice("SkyPulse Pro пока недоступен. Попробуй чуть позже.", true);
        }).finally(function () {
          pro.busy = false;
          updateProToggle();
        });
      }

      function waitForProActivation(attempt) {
        setTimeout(function () {
          refreshPro().then(function () {
            if (!pro.active && attempt < 4) waitForProActivation(attempt + 1);
          });
        }, attempt === 0 ? 800 : 1400);
      }

      function openProInvoice() {
        if (!telegram || typeof telegram.openInvoice !== "function") {
          setProNotice("Открой мини-приложение из Telegram, чтобы оплатить Pro Stars.", true);
          return;
        }
        pro.busy = true;
        updateProToggle();
        setProNotice("Готовлю счёт в Stars…", false);
        postJson("/api/pro", { action: "invoice" }).then(function (data) {
          applyProSubscription(data.subscription || {});
          if (pro.active) {
            setProNotice("Pro уже активен до " + proExpirationText(pro.expiresAt) + ".", false);
            return;
          }
          if (!data.invoiceUrl) throw new Error("invoice is missing");
          pro.busy = false;
          updateProToggle();
          telegram.openInvoice(data.invoiceUrl, function (status) {
            if (status === "paid") {
              setProNotice("Оплата прошла. Активирую Pro…", false);
              waitForProActivation(0);
            } else if (status === "cancelled") {
              setProNotice("Оплата отменена.", false);
            } else if (status === "failed") {
              setProNotice("Оплата не прошла. Попробуй ещё раз чуть позже.", true);
            }
          });
        }).catch(function () {
          setProNotice("Не получилось открыть оплату. Попробуй ещё раз чуть позже.", true);
        }).finally(function () {
          if (pro.busy) {
            pro.busy = false;
            updateProToggle();
          }
        });
      }

      function toggleProSubscription() {
        if (!pro.loaded || pro.busy || pro.complimentary) return;
        if (!pro.active) {
          openProInvoice();
          return;
        }
        var action = pro.autoRenewing ? "cancel" : "resume";
        pro.busy = true;
        updateProToggle();
        setProNotice(action === "cancel" ? "Отключаю автопродление…" : "Включаю автопродление…", false);
        postJson("/api/pro", { action: action }).then(function (data) {
          applyProSubscription(data.subscription || {});
          setProNotice(pro.autoRenewing
            ? "Автопродление включено."
            : "Автопродление выключено: Pro будет работать до " + proExpirationText(pro.expiresAt) + ".", false);
        }).catch(function () {
          setProNotice("Не получилось изменить автопродление. Попробуй ещё раз позже.", true);
        }).finally(function () {
          pro.busy = false;
          updateProToggle();
        });
      }

      function setAssistantNotice(text, isError) {
        assistantNotice.textContent = text || "";
        assistantNotice.className = isError ? "notice error" : "notice";
      }

      function setTripNotice(text, isError) {
        tripNotice.textContent = text || "";
        tripNotice.className = isError ? "notice error" : "notice";
      }

      function switchSection(section) {
        var isWeather = section === "weather";
        var isTransport = section === "transport";
        weatherSection.hidden = !isWeather;
        transportSection.hidden = !isTransport;
        weatherTab.classList.toggle("selected", isWeather);
        transportTab.classList.toggle("selected", isTransport);
        if (isTransport && !transportLoaded) {
          transportLoaded = true;
          loadRoutes("A");
        }
      }

      function renderWeather(weather) {
        weatherCityTitle.textContent = weather.city;
        weatherNow.textContent = weather.current.emoji + " " + String(weather.current.temperature) + "°C, " + weather.current.description;
        weatherDetails.textContent = "Ощущается как " + String(weather.current.apparent) + "°C · Ветер " + String(weather.current.wind) + " км/ч";
        forecastDays.replaceChildren();
        weather.days.forEach(function (day, index) {
          var card = document.createElement("div");
          card.className = "forecast-day";
          var title = document.createElement("strong");
          title.textContent = index === 0 ? "Сегодня" : "Завтра";
          var condition = document.createElement("p");
          condition.textContent = day.emoji + " " + day.description;
          var temperature = document.createElement("p");
          temperature.className = "muted";
          temperature.textContent = String(day.min) + "…" + String(day.max) + "°C" + (day.precipitation == null ? "" : " · осадки " + String(day.precipitation) + "%");
          card.appendChild(title);
          card.appendChild(condition);
          card.appendChild(temperature);
          forecastDays.appendChild(card);
        });
        proWeatherRequestId += 1;
        proWeather.city = String(weather.city || "");
        proWeather.busy = false;
        clearProWeatherDetails();
        setProWeatherNotice("", false);
        updateProWeatherToggle();
        weatherResult.hidden = false;
        refreshWeatherNotification(weather.city);
      }

      function departureText(departure) {
        var when = departure.minutesUntil <= 0 ? "сейчас" : "через " + String(departure.minutesUntil) + " мин";
        return departure.time + (departure.tomorrow ? " завтра" : "") + " · " + when + (departure.inGarage ? " *" : "");
      }

      function renderAssistant(answer) {
        assistantResult.replaceChildren();
        var heading = document.createElement("strong");
        if (answer.kind !== "result") {
          heading.textContent = answer.message || "Уточни маршрут и остановку.";
          assistantResult.appendChild(heading);
          assistantResult.hidden = false;
          return;
        }

        heading.textContent = answer.route.title || ("Маршрут " + String(answer.route.num));
        assistantResult.appendChild(heading);
        var meta = document.createElement("p");
        meta.className = "muted";
        meta.textContent = "Сейчас в Гродно " + String(answer.checkedAt) + ". " + (answer.message || "Ближайшие 2 часа.");
        assistantResult.appendChild(meta);
        (answer.directions || []).forEach(function (direction) {
          var block = document.createElement("div");
          block.className = "assistant-direction";
          var stop = document.createElement("strong");
          stop.textContent = direction.stopName || "Остановка";
          var destination = document.createElement("p");
          destination.className = "muted";
          destination.textContent = direction.direction || "";
          var list = document.createElement("div");
          list.className = "departure-list";
          if (direction.departures && direction.departures.length) {
            direction.departures.forEach(function (departure) {
              var item = document.createElement("span");
              item.className = "departure";
              item.textContent = departureText(departure);
              list.appendChild(item);
            });
          } else {
            var empty = document.createElement("span");
            empty.className = "muted";
            empty.textContent = "В следующие 2 часа рейсов по опубликованному расписанию нет.";
            list.appendChild(empty);
          }
          block.appendChild(stop);
          if (direction.direction) block.appendChild(destination);
          block.appendChild(list);
          assistantResult.appendChild(block);
        });
        assistantResult.hidden = false;
      }

      function tripDistanceText(meters) {
        var value = Math.max(0, Number(meters) || 0);
        if (value < 1000) return String(Math.round(value / 10) * 10) + " м";
        return (Math.round(value / 100) / 10).toFixed(1).replace(".0", "") + " км";
      }

      function tripTransportIcon(type) {
        return type === "Tb" ? "🚎" : "🚌";
      }

      function tripLegText(leg) {
        return tripTransportIcon(leg.type) + " " + (leg.type === "Tb" ? "Троллейбус " : "Автобус ")
          + String(leg.num) + ": с остановки «" + String(leg.fromStop.name) + "» до «"
          + String(leg.toStop.name) + "» — " + String(leg.stopsCount) + " "
          + (Number(leg.stopsCount) === 1 ? "остановка" : "остановок") + ", ≈ "
          + String(leg.rideMinutes) + " мин.";
      }

      function clearTripMap() {
        if (tripMapLayers) tripMapLayers.clearLayers();
        tripMapElement.hidden = true;
      }

      function drawTripMarker(point, label, color, bounds) {
        if (!point || !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lon))) return;
        var coordinates = [Number(point.lat), Number(point.lon)];
        window.L.circleMarker(coordinates, {
          radius: 8,
          color: color,
          fillColor: color,
          fillOpacity: 0.95,
          weight: 2
        }).bindTooltip(label).addTo(tripMapLayers);
        bounds.push(coordinates);
      }

      function renderTripMap(plan) {
        if (!window.L || !plan || !plan.options || !plan.options.length) {
          clearTripMap();
          return;
        }
        tripMapElement.hidden = false;
        if (!tripMapInstance) {
          tripMapInstance = window.L.map(tripMapElement, { scrollWheelZoom: false, zoomControl: true });
          window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          }).addTo(tripMapInstance);
          tripMapLayers = window.L.layerGroup().addTo(tripMapInstance);
        } else {
          tripMapLayers.clearLayers();
        }

        var bounds = [];
        drawTripMarker(plan.origin, "Старт", "#2d8cff", bounds);
        drawTripMarker(plan.destination, "Финиш", "#31a45b", bounds);
        var best = plan.options[0];
        (best.legs || []).forEach(function (leg, index) {
          var line = (leg.geometry || []).map(function (point) {
            return [Number(point.lat), Number(point.lon)];
          }).filter(function (point) {
            return Number.isFinite(point[0]) && Number.isFinite(point[1]);
          });
          if (line.length < 2) return;
          line.forEach(function (point) { bounds.push(point); });
          window.L.polyline(line, {
            color: index ? "#7a5cff" : "#2d8cff",
            weight: 5,
            opacity: 0.82
          }).addTo(tripMapLayers);
        });
        if (bounds.length) tripMapInstance.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 });
        window.setTimeout(function () { tripMapInstance.invalidateSize(); }, 0);
      }

      function renderTripPlan(plan) {
        tripResult.replaceChildren();
        if (!plan || plan.kind !== "result") {
          var notFound = document.createElement("strong");
          notFound.textContent = (plan && plan.message) || "Не получилось построить маршрут.";
          tripResult.appendChild(notFound);
          tripResult.hidden = false;
          clearTripMap();
          return;
        }

        var heading = document.createElement("strong");
        heading.textContent = "Маршруты: " + String(plan.origin.name) + " → " + String(plan.destination.name);
        tripResult.appendChild(heading);
        var note = document.createElement("p");
        note.className = "muted";
        note.textContent = plan.message || "Время ориентировочное.";
        tripResult.appendChild(note);

        (plan.options || []).forEach(function (option, optionIndex) {
          var card = document.createElement("div");
          card.className = "trip-option";
          var title = document.createElement("strong");
          title.textContent = optionIndex === 0
            ? "Самый быстрый · ≈ " + String(option.estimatedMinutes) + " мин"
            : "Вариант " + String(optionIndex + 1) + " · ≈ " + String(option.estimatedMinutes) + " мин";
          var details = document.createElement("p");
          details.className = "muted";
          var transfers = Number(option.transfers) || 0;
          var walking = (Number(option.walkToMeters) || 0) + (Number(option.walkFromMeters) || 0)
            + (Number(option.transferWalkMeters) || 0);
          details.textContent = (transfers ? String(transfers) + " пересадка" + (transfers > 1 ? "и" : "") : "Без пересадок")
            + " · пешком ≈ " + tripDistanceText(walking);
          card.appendChild(title);
          card.appendChild(details);

          (option.legs || []).forEach(function (leg, legIndex) {
            if (legIndex > 0 && option.transferStop) {
              var transfer = document.createElement("p");
              transfer.className = "muted";
              transfer.textContent = "Пересадка у остановки «" + String(option.transferStop.name) + "»"
                + ((Number(option.transferWalkMeters) || 0) ? ", пешком " + tripDistanceText(option.transferWalkMeters) : "") + ".";
              card.appendChild(transfer);
            }
            var legBlock = document.createElement("div");
            legBlock.className = "trip-leg";
            legBlock.textContent = tripLegText(leg);
            card.appendChild(legBlock);
          });
          tripResult.appendChild(card);
        });
        var mapNote = document.createElement("p");
        mapNote.className = "muted";
        mapNote.textContent = "На карте — самый быстрый вариант.";
        tripResult.appendChild(mapNote);
        tripResult.hidden = false;
        renderTripMap(plan);
      }

      function loadWeather(city) {
        var query = String(city || "").trim();
        if (query.length < 2) {
          setWeatherNotice("Напиши название города.", true);
          return;
        }
        setWeatherNotice("Загружаю погоду…", false);
        request("/api/weather?city=" + encodeURIComponent(query)).then(function (data) {
          renderWeather(data.weather);
          weatherCityInput.value = data.weather.city.split(",")[0] || query;
          try { localStorage.setItem("skypulse-city", weatherCityInput.value); } catch (_) {}
          setWeatherNotice("", false);
        }).catch(function () {
          weatherResult.hidden = true;
          setWeatherNotice("Не получилось найти город или загрузить погоду. Попробуй ещё раз.", true);
        });
      }

      function makeButton(text, className) {
        var button = document.createElement("button");
        button.type = "button";
        button.textContent = text;
        if (className) button.className = className;
        return button;
      }

      function showRoutes() {
        routeSection.hidden = true;
        scheduleSection.hidden = true;
      }

      function renderStops(direction, directionIndex) {
        var list = document.createElement("div");
        list.className = "stop-list";
        direction.stops.forEach(function (stop) {
          var button = makeButton("", "stop");
          var number = document.createElement("span");
          number.textContent = String(stop.index + 1) + ".";
          button.appendChild(number);
          button.appendChild(document.createTextNode(stop.name));
          button.addEventListener("click", function () { loadSchedule(directionIndex, stop.index); });
          list.appendChild(button);
        });
        return list;
      }

      function renderRoute(route) {
        state.route = route;
        routeTitle.textContent = route.title;
        directions.replaceChildren();
        route.directions.forEach(function (direction, directionIndex) {
          var wrap = document.createElement("div");
          var button = makeButton(direction.title || "Направление " + String(directionIndex + 1), "direction");
          var stops = renderStops(direction, directionIndex);
          stops.hidden = true;
          button.addEventListener("click", function () {
            var wasHidden = stops.hidden;
            Array.prototype.slice.call(directions.querySelectorAll(".stop-list")).forEach(function (item) { item.hidden = true; });
            stops.hidden = !wasHidden;
          });
          wrap.appendChild(button);
          wrap.appendChild(stops);
          directions.appendChild(wrap);
        });
        showRoutes();
        routeSection.hidden = false;
      }

      function renderScheduleLines(container, lines) {
        container.replaceChildren();
        (lines.length ? lines : ["Нет рейсов"]).forEach(function (line) {
          var item = document.createElement("div");
          item.className = "schedule-line";
          item.textContent = line;
          container.appendChild(item);
        });
      }

      function loadSchedule(directionIndex, stopIndex) {
        if (!state.route) return;
        setNotice("Загружаю расписание…", false);
        var path = "/api/transport/schedule?type=" + encodeURIComponent(state.type) + "&num=" + encodeURIComponent(state.route.num) + "&direction=" + encodeURIComponent(directionIndex) + "&stop=" + encodeURIComponent(stopIndex);
        request(path).then(function (data) {
          scheduleTitle.textContent = data.schedule.title || data.schedule.stopName || "Расписание";
          scheduleDirection.textContent = data.schedule.direction || "";
          renderScheduleLines(weekdays, data.schedule.weekdays || []);
          renderScheduleLines(weekend, data.schedule.weekend || []);
          scheduleSection.hidden = false;
          routeSection.hidden = true;
          setNotice("", false);
        }).catch(function () {
          setNotice("Не получилось загрузить расписание. Попробуй ещё раз.", true);
        });
      }

      function loadRoute(num) {
        setNotice("Загружаю остановки…", false);
        request("/api/transport/route?type=" + encodeURIComponent(state.type) + "&num=" + encodeURIComponent(num)).then(function (data) {
          if (!data.route.directions || !data.route.directions.length) throw new Error("empty route");
          renderRoute(data.route);
          setNotice("", false);
        }).catch(function () {
          setNotice("Не получилось загрузить остановки маршрута. Попробуй ещё раз.", true);
        });
      }

      function loadRoutes(type) {
        state.type = type;
        state.route = null;
        showRoutes();
        tabs.forEach(function (tab) { tab.classList.toggle("selected", tab.dataset.type === type); });
        routesHeading.textContent = type === "A" ? "Автобусные маршруты" : "Троллейбусные маршруты";
        routes.replaceChildren();
        setNotice("Загружаю маршруты…", false);
        request("/api/transport/routes?type=" + encodeURIComponent(type)).then(function (data) {
          data.routes.forEach(function (num) {
            var button = makeButton(num, "route");
            button.addEventListener("click", function () { loadRoute(num); });
            routes.appendChild(button);
          });
          setNotice(data.routes.length ? "" : "Маршруты пока не найдены.", !data.routes.length);
        }).catch(function () {
          setNotice("Сервис расписаний сейчас не отвечает. Попробуй чуть позже.", true);
        });
      }

      tabs.forEach(function (tab) {
        tab.addEventListener("click", function () { loadRoutes(tab.dataset.type); });
      });
      document.getElementById("route-back").addEventListener("click", function () { showRoutes(); });
      document.getElementById("schedule-back").addEventListener("click", function () {
        scheduleSection.hidden = true;
        routeSection.hidden = false;
      });
      weatherTab.addEventListener("click", function () { switchSection("weather"); });
      transportTab.addEventListener("click", function () { switchSection("transport"); });
      weatherForm.addEventListener("submit", function (event) {
        event.preventDefault();
        loadWeather(weatherCityInput.value);
      });
      weatherNotificationToggle.addEventListener("click", toggleWeatherNotification);
      proWeatherToggle.addEventListener("click", toggleProWeather);
      proToggle.addEventListener("click", toggleProSubscription);
      tripForm.addEventListener("submit", function (event) {
        event.preventDefault();
        var from = String(tripFrom.value || "").trim();
        var to = String(tripTo.value || "").trim();
        if (from.length < 3 || to.length < 3) {
          setTripNotice("Напиши адрес отправления и адрес назначения точнее.", true);
          return;
        }
        tripResult.hidden = true;
        clearTripMap();
        setTripNotice("Ищу адреса, остановки и варианты поездки… Первый поиск может занять немного дольше.", false);
        postJson("/api/trip-plan", { from: from, to: to }).then(function (data) {
          renderTripPlan(data.plan || {});
          setTripNotice("", false);
        }).catch(function () {
          tripResult.hidden = true;
          clearTripMap();
          setTripNotice("Не удалось построить маршрут сейчас. Проверь адреса и попробуй ещё раз чуть позже.", true);
        });
      });
      assistantForm.addEventListener("submit", function (event) {
        event.preventDefault();
        var query = String(assistantQuery.value || "").trim();
        if (query.length < 2) {
          setAssistantNotice("Напиши номер маршрута и остановку.", true);
          return;
        }
        assistantResult.hidden = true;
        setAssistantNotice("Разбираю запрос и ищу рейсы…", false);
        postJson("/api/transport/assistant", { query: query }).then(function (data) {
          renderAssistant(data.answer || {});
          setAssistantNotice("", false);
        }).catch(function () {
          assistantResult.hidden = true;
          setAssistantNotice("Не получилось найти рейсы. Проверь номер и остановку, затем попробуй ещё раз.", true);
        });
      });
      var initialCity = "Гродно";
      try { initialCity = localStorage.getItem("skypulse-city") || initialCity; } catch (_) {}
      weatherCityInput.value = initialCity;
      switchSection("weather");
      updateProToggle();
      refreshPro();
      loadWeather(initialCity);
    }());
  </script>
</body>
</html>`;
}

function miniAppRouteNumber(value) {
  const number = String(value || "").trim();
  return /^[0-9]{1,3}[A-Za-zА-Яа-я]?$/.test(number) ? number : null;
}

function miniAppIndex(value, size) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 && index < size ? index : -1;
}

function miniAppCityQuery(value) {
  const city = String(value || "").trim();
  return city.length >= 2 && city.length <= 100 && !/[\r\n\u0000]/.test(city) ? city : null;
}

function miniAppNotificationAction(value) {
  const action = String(value || "").trim();
  return ["status", "subscribe", "unsubscribe"].includes(action) ? action : null;
}

function weatherNotificationsConfigured() {
  if (WEATHER_NOTIFICATIONS_SHARED_SECRET.length < 32) return false;
  try {
    const url = new URL(WEATHER_NOTIFICATIONS_WORKER_URL);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function proPaymentsConfigured() {
  return PRO_PAYMENTS_ENABLED && Boolean(BOT_TOKEN) && Boolean(PRO_PAYMENT_SIGNING_SECRET) && weatherNotificationsConfigured();
}

function proSubscriptionFromWorker(value) {
  const active = value?.active === true;
  const expiresAt = Number(value?.expiresAt);
  if (!active || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    return { active: false, expiresAt: null, autoRenewing: false, complimentary: false, chargeId: null };
  }
  return {
    active: true,
    expiresAt,
    autoRenewing: value?.autoRenewing === true,
    complimentary: value?.complimentary === true,
    chargeId: proPaymentChargeId(value?.chargeId)
  };
}

function publicProSubscription(subscription) {
  return {
    active: Boolean(subscription?.active),
    expiresAt: subscription?.active ? subscription.expiresAt : null,
    autoRenewing: Boolean(subscription?.active && subscription?.autoRenewing),
    complimentary: Boolean(subscription?.active && subscription?.complimentary)
  };
}

async function syncProSubscription(action, chatId, extra = {}) {
  if (!proPaymentsConfigured()) throw new Error("SkyPulse Pro is not configured");
  const response = await fetchJson(`${WEATHER_NOTIFICATIONS_WORKER_URL}/v1/pro`, {
    method: "POST",
    timeoutMs: 12000,
    maxBytes: 64 * 1024,
    label: "SkyPulse Pro subscription",
    headers: {
      "Content-Type": "application/json",
      "X-SkyPulse-Notification-Secret": WEATHER_NOTIFICATIONS_SHARED_SECRET
    },
    body: JSON.stringify({ action, chatId, ...extra })
  });
  if (!response?.ok || !response.subscription) {
    throw new Error("SkyPulse Pro service returned an invalid response");
  }
  return {
    subscription: proSubscriptionFromWorker(response.subscription),
    newPayment: response.newPayment === true
  };
}

function complimentaryProChargeId(userId, grantKey = null) {
  const recipient = telegramUserId(userId);
  const key = String(grantKey || "").trim().toLowerCase();
  if (!recipient) throw new Error("Invalid complimentary Pro recipient");
  if (!key) return `complimentary-pro-${recipient}-v1`;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key)) throw new Error("Invalid complimentary Pro grant key");
  return `complimentary-pro-${recipient}-${key}-v1`;
}

async function grantConfiguredUsernameComplimentaryPro(from) {
  const userId = telegramUserId(from?.id);
  const username = telegramUsername(from?.username);
  const months = username ? COMPLIMENTARY_PRO_USERNAME_GIFTS.get(username) : null;
  if (!userId || !months) return false;
  if (!proPaymentsConfigured()) {
    console.error(`Complimentary Pro username gift for @${username} was skipped because SkyPulse Pro is not configured.`);
    return false;
  }

  try {
    const current = await syncProSubscription("status", userId);
    const startsAt = current.subscription.active && current.subscription.expiresAt
      ? Math.max(Math.floor(Date.now() / 1000), current.subscription.expiresAt)
      : Math.floor(Date.now() / 1000);
    const expiresAt = addCalendarMonthsToEpoch(startsAt, months);
    if (!expiresAt) throw new Error("Could not calculate complimentary Pro expiry");

    const result = await syncProSubscription("grant", userId, {
      expiresAt,
      chargeId: complimentaryProChargeId(userId, `username-${username}`),
      isFirstRecurring: false
    });
    if (result.newPayment) {
      await sendProWelcomeMessage(userId, result.subscription.expiresAt || expiresAt, { complimentary: true });
      console.log(`Complimentary ${months}-month SkyPulse Pro granted to @${username}.`);
      return true;
    }
  } catch (error) {
    console.error(`Could not grant complimentary SkyPulse Pro to @${username}:`, error.message);
  }
  return false;
}

async function grantConfiguredComplimentaryPro() {
  if (!COMPLIMENTARY_PRO_USER_IDS.length) return;
  if (!proPaymentsConfigured()) {
    console.error("Complimentary Pro grant skipped because SkyPulse Pro is not configured.");
    return;
  }

  const expiresAt = Math.floor(Date.now() / 1000) + PRO_SUBSCRIPTION_PERIOD_SECONDS;
  for (const userId of COMPLIMENTARY_PRO_USER_IDS) {
    try {
      const result = await syncProSubscription("grant", userId, {
        expiresAt,
        chargeId: complimentaryProChargeId(userId),
        isFirstRecurring: false
      });
      if (result.newPayment) {
        await sendProWelcomeMessage(userId, result.subscription.expiresAt || expiresAt, { complimentary: true });
        console.log(`Complimentary SkyPulse Pro granted to Telegram user ${userId}.`);
      }
    } catch (error) {
      console.error(`Could not grant complimentary SkyPulse Pro to ${userId}:`, error.message);
    }
  }
}

async function createProInvoiceLink(userId) {
  if (!proPaymentsConfigured()) throw new Error("SkyPulse Pro is not configured");
  const invoiceUrl = await telegram("createInvoiceLink", {
    title: "SkyPulse Pro",
    description: "Умные уведомления о погоде с советом по одежде и предупреждениями.",
    payload: createProInvoicePayload(userId),
    currency: "XTR",
    prices: [{ label: "SkyPulse Pro · 30 дней", amount: PRO_MONTHLY_PRICE_STARS }],
    subscription_period: PRO_SUBSCRIPTION_PERIOD_SECONDS
  });
  if (typeof invoiceUrl !== "string" || !/^https:\/\//i.test(invoiceUrl)) {
    throw new Error("Telegram returned an invalid SkyPulse Pro invoice link");
  }
  return invoiceUrl;
}

async function syncWeatherNotificationSubscription(action, chatId, city = null) {
  if (!weatherNotificationsConfigured()) throw new Error("Weather notifications are not configured");
  const response = await fetchJson(`${WEATHER_NOTIFICATIONS_WORKER_URL}/v1/subscriptions`, {
    method: "POST",
    timeoutMs: 12000,
    maxBytes: 64 * 1024,
    label: "Weather notification subscription",
    headers: {
      "Content-Type": "application/json",
      "X-SkyPulse-Notification-Secret": WEATHER_NOTIFICATIONS_SHARED_SECRET
    },
    body: JSON.stringify({ action, chatId, city })
  });
  const subscription = response?.subscription;
  if (!response?.ok || !subscription || typeof subscription.subscribed !== "boolean") {
    throw new Error("Weather notification service returned an invalid response");
  }
  return {
    subscribed: subscription.subscribed,
    city: miniAppCityQuery(subscription.city) || null
  };
}

function weatherNotificationSubscriber(value) {
  const chatId = String(value?.chatId || "");
  const city = miniAppCityQuery(value?.city);
  if (!/^\d{1,20}$/.test(chatId) || !city) return null;
  return value?.pro === true || Number(value?.pro) === 1 ? { chatId, city, pro: true } : { chatId, city };
}

function proWeatherAlert(weather, currentCode) {
  const precipitation = miniAppRounded(weather.daily?.precipitation_probability_max?.[0]) || 0;
  const wind = miniAppRounded(weather.current?.wind_speed_10m);
  if (currentCode >= 95) return "Гроза: по возможности пережди её в помещении и не стой рядом с высокими деревьями.";
  if (wind != null && wind >= 35) return `Сильный ветер ${wind} км/ч: закрепи капюшон и будь внимательнее рядом с деревьями.`;
  if (precipitation >= 70) return `Осадки вероятны (${precipitation}%): лучше взять зонт или непромокаемый слой.`;
  return null;
}

function formatProWeatherNotificationDetails(city, weather, currentCode) {
  const clothing = getMiniAppClothingAdvice(city, weather, weather.current || {}, currentCode);
  const alert = proWeatherAlert(weather, currentCode);
  return [
    "",
    "✨ <b>SkyPulse Pro</b>",
    clothing?.base ? `🧥 На улицу: ${escapeHtml(clothing.base)}.` : null,
    alert ? `⚠️ ${escapeHtml(alert)}` : null
  ];
}

function formatWeatherNotification(city, weather, options = {}) {
  const current = weather.current || {};
  const currentCode = Number(current.weather_code);
  const min = miniAppRounded(weather.daily?.temperature_2m_min?.[0]);
  const max = miniAppRounded(weather.daily?.temperature_2m_max?.[0]);
  const precipitation = miniAppRounded(weather.daily?.precipitation_probability_max?.[0]);
  const temperature = miniAppRounded(current.temperature_2m);
  const apparent = miniAppRounded(current.apparent_temperature);
  const wind = miniAppRounded(current.wind_speed_10m);
  const description = escapeHtml(describeWeatherCode(currentCode, "ru"));
  const lines = [
    "🔔 <b>Погода каждые 3 часа</b>",
    `<b>${formatSafeCityName(city)}</b>`,
    "",
    `${weatherEmoji(currentCode)} Сейчас: ${temperature == null ? "—" : `${temperature}°C`}, ${description}`,
    apparent == null ? null : `🌡 Ощущается как: ${apparent}°C`,
    wind == null ? null : `💨 Ветер: ${wind} км/ч`,
    min == null || max == null ? null : `Сегодня: ${min}…${max}°C`,
    precipitation == null ? null : `💧 Вероятность осадков: ${precipitation}%`
  ];
  if (options?.pro === true) lines.push(...formatProWeatherNotificationDetails(city, weather, currentCode));
  return lines.filter(Boolean).join("\n");
}

function telegramDestinationUnavailable(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("blocked by the user") || message.includes("chat not found") || message.includes("user is deactivated");
}

async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await task(items[index]);
      } catch (error) {
        results[index] = { status: "failed", error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function deliverWeatherNotificationBatch(subscribers) {
  const cityMessages = new Map();
  const messageForCity = async (cityQuery, pro = false) => {
    const key = `${cityQuery.toLocaleLowerCase("ru")}:${pro ? "pro" : "free"}`;
    if (!cityMessages.has(key)) {
      cityMessages.set(key, (async () => {
        const city = await findCity(cityQuery, "ru");
        if (!city) throw new Error("Notification city was not found");
        const weather = await getWeather(city);
        return formatWeatherNotification(city, weather, { pro });
      })());
    }
    return cityMessages.get(key);
  };

  const results = await mapWithConcurrency(subscribers, 4, async (subscriber) => {
    try {
      const text = await messageForCity(subscriber.city, subscriber.pro === true);
      await sendMessage(subscriber.chatId, text, { disable_web_page_preview: true });
      return { status: "delivered", chatId: subscriber.chatId };
    } catch (error) {
      if (telegramDestinationUnavailable(error)) return { status: "disabled", chatId: subscriber.chatId };
      console.error("Weather notification delivery failed:", error.message);
      return { status: "failed", chatId: subscriber.chatId };
    }
  });

  return {
    delivered: results.filter((result) => result?.status === "delivered").map((result) => result.chatId),
    disabled: results.filter((result) => result?.status === "disabled").map((result) => result.chatId)
  };
}

function miniAppRounded(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function getMiniAppClothingAdvice(city, weather, current, currentCode) {
  const apparent = miniAppRounded(current.apparent_temperature);
  const temperature = miniAppRounded(current.temperature_2m);
  const wind = miniAppRounded(current.wind_speed_10m);
  const precipitation = miniAppRounded(weather.daily.precipitation_probability_max?.[0]) || 0;
  const base = getBaseClothing(apparent ?? temperature ?? 0, "ru");
  const shoes = getShoeAdvice(apparent ?? temperature ?? 0, precipitation, currentCode, "ru");
  let extra;

  if (wind != null && wind >= 25) {
    extra = `Ветер ${wind} км/ч — добавь слой с защитой от ветра.`;
  } else if (precipitation >= 60) {
    extra = `Осадки вероятны (${precipitation}%) — возьми зонт или капюшон.`;
  } else if (precipitation >= 30) {
    extra = `Осадки возможны (${precipitation}%) — компактный зонт будет кстати.`;
  } else {
    extra = "Если будешь долго на улице, возьми тонкий дополнительный слой.";
  }

  return {
    title: "А что по одежде?",
    base,
    shoes,
    extra,
    apparent,
    temperature
  };
}

function miniAppWeatherCurrent(weather, observedCurrent = null) {
  const current = observedCurrent || weather.current;
  const currentCode = Number.isFinite(Number(current.weather_code))
    ? Number(current.weather_code)
    : Number(weather.current.weather_code);
  return { current, currentCode };
}

function miniAppWeatherPayload(city, weather, observedCurrent = null) {
  const { current, currentCode } = miniAppWeatherCurrent(weather, observedCurrent);
  const days = [0, 1].map((index) => {
    if (!weather.daily.time?.[index]) return null;
    const code = Number(weather.daily.weather_code?.[index]);
    const precipitation = miniAppRounded(weather.daily.precipitation_probability_max?.[index]);
    return {
      date: weather.daily.time[index],
      emoji: weatherEmoji(code),
      description: describeWeatherCode(code, "ru"),
      min: miniAppRounded(weather.daily.temperature_2m_min?.[index]),
      max: miniAppRounded(weather.daily.temperature_2m_max?.[index]),
      precipitation
    };
  }).filter(Boolean);

  return {
    city: formatCityName(city),
    timezone: weather.timezone,
    current: {
      emoji: weatherEmoji(currentCode),
      description: observedCurrent?.description || describeWeatherCode(currentCode, "ru"),
      temperature: miniAppRounded(current.temperature_2m),
      apparent: miniAppRounded(current.apparent_temperature),
      wind: miniAppRounded(current.wind_speed_10m)
    },
    days
  };
}

function miniAppLocalHourKey(timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date());
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (value.year && value.month && value.day && value.hour) {
      return `${value.year}-${value.month}-${value.day}T${value.hour}`;
    }
  } catch {
    // Fall through to UTC when the weather provider returns an unknown timezone.
  }
  return new Date().toISOString().slice(0, 13);
}

function miniAppHourlyStartIndex(weather) {
  const times = Array.isArray(weather?.hourly?.time) ? weather.hourly.time : [];
  const weatherHour = String(weather?.current?.time || "").slice(0, 13);
  const targetHour = /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(weatherHour)
    ? weatherHour
    : miniAppLocalHourKey(weather?.timezone);
  const index = times.findIndex((time) => String(time).slice(0, 13) >= targetHour);
  return index >= 0 ? index : 0;
}

function miniAppHourLabel(value) {
  const match = /T(\d{2}):(\d{2})/.exec(String(value || ""));
  return match ? `${match[1]}:${match[2]}` : "—";
}

function miniAppProWeatherDetails(city, weather, observedCurrent = null) {
  const { current, currentCode } = miniAppWeatherCurrent(weather, observedCurrent);
  const hourly = weather?.hourly || {};
  const times = Array.isArray(hourly.time) ? hourly.time : [];
  const hours = [];
  const startIndex = miniAppHourlyStartIndex(weather);

  for (let offset = 0; offset < 24; offset += 1) {
    const index = startIndex + offset;
    if (!times[index]) break;
    const code = Number(hourly.weather_code?.[index]);
    hours.push({
      time: miniAppHourLabel(times[index]),
      emoji: weatherEmoji(code),
      temperature: miniAppRounded(hourly.temperature_2m?.[index]),
      apparent: miniAppRounded(hourly.apparent_temperature?.[index]),
      precipitation: miniAppRounded(hourly.precipitation_probability?.[index]) ?? 0,
      wind: miniAppRounded(hourly.wind_speed_10m?.[index]) ?? 0
    });
  }

  const comfortable = hours.find((hour) => (
    hour.precipitation <= 25
    && hour.wind <= 20
    && hour.temperature != null
    && hour.temperature >= 5
    && hour.temperature <= 28
  )) || hours.find((hour) => hour.precipitation <= 45 && hour.wind <= 28) || hours[0] || null;
  const comfortWindow = comfortable
    ? `Лучшее окно для дороги или прогулки: около ${comfortable.time} — ${comfortable.emoji} ${comfortable.temperature}°C, осадки ${comfortable.precipitation}%, ветер ${comfortable.wind} км/ч.`
    : "Не получилось собрать почасовой план на 24 часа — попробуй обновить погоду чуть позже.";

  return {
    city: formatCityName(city),
    clothing: getMiniAppClothingAdvice(city, weather, current, currentCode),
    hours,
    comfortWindow
  };
}

async function getMiniAppWeather(cityQuery) {
  const city = await findCity(cityQuery, "ru");
  if (!city) return null;

  const weather = await getWeather(city);
  const observedCurrent = await getObservedCurrent(city).catch(() => null);
  return miniAppWeatherPayload(city, weather, observedCurrent);
}

async function getMiniAppProWeatherDetails(cityQuery) {
  const city = await findCity(cityQuery, "ru");
  if (!city) return null;

  const weather = await getWeather(city);
  const observedCurrent = await getObservedCurrent(city).catch(() => null);
  return miniAppProWeatherDetails(city, weather, observedCurrent);
}

function miniAppTripLocation(value) {
  const location = String(value || "").trim().replace(/\s+/g, " ");
  return location.length >= 3 && location.length <= 160 && !/[\r\n\u0000]/.test(location) ? location : null;
}

function waitFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInsideGrodno(point) {
  return Number(point?.lat) >= 53.60 && Number(point?.lat) <= 53.82
    && Number(point?.lon) >= 23.55 && Number(point?.lon) <= 24.05;
}

async function queuedNominatimSearch(url) {
  const previous = nominatimQueue.catch(() => {});
  const task = previous.then(async () => {
    const waitMs = Math.max(0, nextNominatimRequestAt - Date.now());
    if (waitMs) await waitFor(waitMs);
    nextNominatimRequestAt = Date.now() + NOMINATIM_MIN_INTERVAL_MS;
    return fetchJson(url, {
      timeoutMs: 12000,
      maxBytes: 256 * 1024,
      label: "Address search",
      headers: {
        "Accept": "application/json",
        "User-Agent": OSM_USER_AGENT
      }
    });
  });
  nominatimQueue = task.catch(() => {});
  return task;
}

async function geocodeGrodnoAddress(query) {
  const normalized = String(query).trim().toLowerCase();
  const cached = tripPlannerCache.geocodes.get(normalized);
  if (cached?.expiresAt > Date.now()) return cached.value;

  const url = new URL(OSM_NOMINATIM_URL);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "by");
  url.searchParams.set("bounded", "1");
  url.searchParams.set("viewbox", "23.55,53.82,24.05,53.60");
  url.searchParams.set("q", `${query}, Гродно, Беларусь`);
  const rows = await queuedNominatimSearch(url.toString());
  const row = Array.isArray(rows) ? rows.find((item) => isInsideGrodno({ lat: Number(item?.lat), lon: Number(item?.lon) })) : null;
  if (!row) return null;

  const value = {
    name: String(row.display_name || query).split(",").slice(0, 3).join(", "),
    lat: Number(row.lat),
    lon: Number(row.lon)
  };
  tripPlannerCache.geocodes.set(normalized, { value, expiresAt: Date.now() + NOMINATIM_CACHE_MS });
  return value;
}

function parseOsmTransitNetwork(data) {
  const elements = Array.isArray(data?.elements) ? data.elements : [];
  const nodes = new Map(elements
    .filter((item) => item?.type === "node" && Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lon)))
    .map((item) => [String(item.id), item]));
  const seenRoutes = new Set();
  const routes = [];

  for (const relation of elements.filter((item) => item?.type === "relation")) {
    const tags = relation.tags || {};
    const routeKind = String(tags.route || "");
    if (routeKind !== "bus" && routeKind !== "trolleybus") continue;
    const title = String(tags["name:ru"] || tags.name || "");
    if (/маршрутн(?:ое|ая)?\s+такси/i.test(title)) continue;
    const num = String(tags.ref || "").trim();
    if (!/^[0-9]{1,3}[A-Za-zА-Яа-я]?$/u.test(num)) continue;
    const members = Array.isArray(relation.members) ? relation.members : [];
    let platformMembers = members.filter((member) => member?.type === "node" && member.role === "platform");
    if (platformMembers.length < 2) {
      platformMembers = members.filter((member) => member?.type === "node" && member.role === "stop");
    }
    const stops = platformMembers.map((member) => {
      const node = nodes.get(String(member.ref));
      if (!node) return null;
      return {
        id: String(node.id),
        name: String(node.tags?.["name:ru"] || node.tags?.name || node.tags?.["name:be"] || "Остановка"),
        lat: Number(node.lat),
        lon: Number(node.lon)
      };
    }).filter(Boolean);
    if (stops.length < 2) continue;
    const signature = `${routeKind}:${num}:${stops.map((stop) => stop.id).join(",")}`;
    if (seenRoutes.has(signature)) continue;
    seenRoutes.add(signature);
    routes.push({
      id: `osm:${relation.id}`,
      type: routeKind === "trolleybus" ? "Tb" : "A",
      num,
      title: title || `${routeKind === "trolleybus" ? "Троллейбус" : "Автобус"} ${num}`,
      stops
    });
  }

  const network = prepareTransitNetwork(routes);
  if (!network.routes.length || !network.stops.length) throw new Error("OSM transit data is empty");
  return network;
}

async function getOsmTransitNetwork() {
  const cached = tripPlannerCache.osmNetwork;
  if (cached.value && cached.expiresAt > Date.now()) return cached.value;

  const query = [
    "[out:json][timeout:55];",
    "relation[\"type\"=\"route\"][\"route\"~\"^(bus|trolleybus)$\"](53.60,23.55,53.82,24.05)->.routes;",
    "(.routes;node(r.routes););",
    "out body;"
  ].join("");
  const data = await fetchJson(OSM_OVERPASS_URL, {
    method: "POST",
    timeoutMs: 65000,
    maxBytes: 5 * 1024 * 1024,
    label: "Grodno transit map",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Accept": "application/json",
      "User-Agent": OSM_USER_AGENT
    },
    body: `data=${encodeURIComponent(query)}`
  });
  const value = parseOsmTransitNetwork(data);
  tripPlannerCache.osmNetwork = { value, expiresAt: Date.now() + OSM_NETWORK_CACHE_MS };
  return value;
}

async function getMiniAppTripPlan(from, to) {
  const [origin, destination, network] = await Promise.all([
    geocodeGrodnoAddress(from),
    geocodeGrodnoAddress(to),
    getOsmTransitNetwork()
  ]);
  if (!origin || !destination) {
    return {
      kind: "not_found",
      message: "Не нашёл один из адресов в пределах Гродно. Напиши улицу и номер дома точнее."
    };
  }

  const result = buildTransitOptions(network, origin, destination);
  if (!result.options.length) {
    return {
      kind: "not_found",
      origin,
      destination,
      message: "Не получилось подобрать путь с одной пересадкой. Попробуй указать адреса точнее или выбери ближайший ориентир."
    };
  }
  return {
    kind: "result",
    origin,
    destination,
    options: result.options,
    message: "Время ориентировочное: учитывает пеший путь, среднее время между остановками и обычное ожидание транспорта."
  };
}

async function handleMiniAppRequest(req, res, requestUrl) {
  const isMiniAppApi = requestUrl.pathname.startsWith("/api/");
  const authorization = isMiniAppApi ? miniAppAuthorization(req) : null;
  if (isMiniAppApi && !authorization) {
    miniAppError(res, 401, "Open the Mini App from Telegram to use its API");
    return true;
  }
  if (isMiniAppApi && isMiniAppApiRateLimited(req, authorization)) {
    miniAppError(res, 429, "Too many requests. Please wait a minute.");
    return true;
  }

  if (requestUrl.pathname === "/api/pro") {
    if (req.method !== "POST") {
      miniAppError(res, 405, "Method not allowed");
      return true;
    }
    if (!authorization?.userId) {
      miniAppError(res, 400, "This Mini App launch has no Telegram user");
      return true;
    }

    let payload;
    try {
      const body = await readRequestBody(req, 4 * 1024);
      payload = JSON.parse(body);
    } catch (error) {
      miniAppError(res, error?.message === "Request body too large" ? 413 : 400, "Invalid request");
      return true;
    }

    const action = String(payload?.action || "").trim();
    if (!["status", "invoice", "cancel", "resume", "weather_details"].includes(action)) {
      miniAppError(res, 400, "Invalid Pro request");
      return true;
    }
    if (!proPaymentsConfigured()) {
      miniAppError(res, 503, "SkyPulse Pro is being set up");
      return true;
    }

    try {
      const current = await syncProSubscription("status", authorization.userId);
      if (action === "status") {
        sendJson(res, 200, {
          ok: true,
          priceStars: PRO_MONTHLY_PRICE_STARS,
          subscription: publicProSubscription(current.subscription)
        });
        return true;
      }

      if (action === "invoice") {
        sendJson(res, 200, {
          ok: true,
          priceStars: PRO_MONTHLY_PRICE_STARS,
          subscription: publicProSubscription(current.subscription),
          invoiceUrl: current.subscription.active ? null : await createProInvoiceLink(authorization.userId)
        });
        return true;
      }

      if (action === "weather_details") {
        if (!current.subscription.active) {
          miniAppError(res, 403, "SkyPulse Pro is required for this feature");
          return true;
        }
        const city = miniAppCityQuery(payload?.city);
        if (!city) {
          miniAppError(res, 400, "Invalid city");
          return true;
        }
        const details = await getMiniAppProWeatherDetails(city);
        if (!details) {
          miniAppError(res, 404, "City was not found");
          return true;
        }
        sendJson(res, 200, { ok: true, details });
        return true;
      }

      if (!current.subscription.active || !current.subscription.chargeId) {
        miniAppError(res, 409, "No active Pro subscription");
        return true;
      }

      const autoRenewing = action === "resume";
      if (current.subscription.autoRenewing !== autoRenewing) {
        const telegramUserIdNumber = Number(authorization.userId);
        if (!Number.isSafeInteger(telegramUserIdNumber)) throw new Error("Invalid Telegram user ID");
        await telegram("editUserStarSubscription", {
          user_id: telegramUserIdNumber,
          telegram_payment_charge_id: current.subscription.chargeId,
          is_canceled: !autoRenewing
        });
        const updated = await syncProSubscription("set_auto_renewal", authorization.userId, { autoRenewing });
        sendJson(res, 200, {
          ok: true,
          priceStars: PRO_MONTHLY_PRICE_STARS,
          subscription: publicProSubscription(updated.subscription)
        });
        return true;
      }

      sendJson(res, 200, {
        ok: true,
        priceStars: PRO_MONTHLY_PRICE_STARS,
        subscription: publicProSubscription(current.subscription)
      });
    } catch (error) {
      console.error("SkyPulse Pro request error:", error.message);
      miniAppError(res, 502, "SkyPulse Pro is temporarily unavailable");
    }
    return true;
  }

  if (requestUrl.pathname === "/api/weather-notifications") {
    if (req.method !== "POST") {
      miniAppError(res, 405, "Method not allowed");
      return true;
    }
    if (isMiniAppNotificationRateLimited(req, authorization)) {
      miniAppError(res, 429, "Too many notification requests. Please wait a minute.");
      return true;
    }
    if (!authorization?.userId) {
      miniAppError(res, 400, "This Mini App launch has no Telegram user");
      return true;
    }

    let payload;
    try {
      const body = await readRequestBody(req, 8 * 1024);
      payload = JSON.parse(body);
    } catch (error) {
      miniAppError(res, error?.message === "Request body too large" ? 413 : 400, "Invalid request");
      return true;
    }

    const action = miniAppNotificationAction(payload?.action);
    const city = action === "subscribe" ? miniAppCityQuery(payload?.city) : null;
    if (!action || (action === "subscribe" && !city)) {
      miniAppError(res, 400, "Invalid weather notification request");
      return true;
    }
    if (!weatherNotificationsConfigured()) {
      miniAppError(res, 503, "Weather notifications are being set up");
      return true;
    }

    try {
      const subscription = await syncWeatherNotificationSubscription(action, authorization.userId, city);
      sendJson(res, 200, { ok: true, subscription });
    } catch (error) {
      console.error("Weather notification subscription error:", error.message);
      miniAppError(res, 502, "Weather notification service is unavailable");
    }
    return true;
  }

  if (requestUrl.pathname === "/api/transport/assistant") {
    if (req.method !== "POST") {
      miniAppError(res, 405, "Method not allowed");
      return true;
    }
    if (isMiniAppAiRateLimited(req, authorization)) {
      miniAppError(res, 429, "Too many requests. Please wait a minute.");
      return true;
    }

    let payload;
    try {
      const body = await readRequestBody(req, 16 * 1024);
      payload = JSON.parse(body);
    } catch (error) {
      miniAppError(res, error?.message === "Request body too large" ? 413 : 400, "Invalid request");
      return true;
    }

    const query = miniAppTransportQuery(payload?.query);
    if (!query) {
      miniAppError(res, 400, "Invalid transport query");
      return true;
    }

    try {
      const answer = await getMiniAppAiTransportAnswer(query);
      sendJson(res, 200, { ok: true, answer });
    } catch (error) {
      console.error("Mini App AI transport error:", error.message);
      miniAppError(res, 502, "Transport service is unavailable");
    }
    return true;
  }

  if (requestUrl.pathname === "/api/trip-plan") {
    if (req.method !== "POST") {
      miniAppError(res, 405, "Method not allowed");
      return true;
    }
    if (isMiniAppTripRateLimited(req, authorization)) {
      miniAppError(res, 429, "Too many route searches. Please wait a minute.");
      return true;
    }

    let payload;
    try {
      const body = await readRequestBody(req, 16 * 1024);
      payload = JSON.parse(body);
    } catch (error) {
      miniAppError(res, error?.message === "Request body too large" ? 413 : 400, "Invalid request");
      return true;
    }

    const from = miniAppTripLocation(payload?.from);
    const to = miniAppTripLocation(payload?.to);
    if (!from || !to) {
      miniAppError(res, 400, "Invalid route locations");
      return true;
    }

    try {
      const plan = await getMiniAppTripPlan(from, to);
      sendJson(res, 200, { ok: true, plan });
    } catch (error) {
      console.error("Mini App trip planner error:", error.message);
      miniAppError(res, 502, "Trip planner is unavailable");
    }
    return true;
  }

  if (req.method !== "GET") return false;

  if (requestUrl.pathname === MINI_APP_PATH) {
    res.writeHead(200, securityHeaders("text/html; charset=utf-8"));
    res.end(miniAppHtml());
    return true;
  }

  if (requestUrl.pathname === "/api/weather") {
    const cityQuery = miniAppCityQuery(requestUrl.searchParams.get("city"));
    if (!cityQuery) {
      miniAppError(res, 400, "Invalid city");
      return true;
    }
    try {
      const weather = await getMiniAppWeather(cityQuery);
      if (!weather) {
        miniAppError(res, 404, "City not found");
        return true;
      }
      sendJson(res, 200, { ok: true, weather });
      return true;
    } catch (error) {
      console.error("Mini App weather error:", error.message);
      miniAppError(res, 502, "Weather service is unavailable");
      return true;
    }
  }

  if (!requestUrl.pathname.startsWith("/api/transport/")) return false;

  const type = normalizeTransportType(requestUrl.searchParams.get("type") || "");
  if (!btransSlugForType(type)) {
    miniAppError(res, 400, "Unsupported transport type");
    return true;
  }

  try {
    if (requestUrl.pathname === "/api/transport/routes") {
      const routes = await getBtransRouteNumbers(type);
      sendJson(res, 200, { ok: true, routes });
      return true;
    }

    const num = miniAppRouteNumber(requestUrl.searchParams.get("num"));
    if (!num) {
      miniAppError(res, 400, "Invalid route number");
      return true;
    }

    const route = await getBtransRoute(type, num);
    if (!route || !route.directions.length) {
      miniAppError(res, 404, "Route not found");
      return true;
    }

    if (requestUrl.pathname === "/api/transport/route") {
      sendJson(res, 200, {
        ok: true,
        route: {
          title: route.title,
          num: route.num,
          directions: route.directions.map((direction) => ({
            title: direction.title,
            stops: direction.stops.slice(0, 120).map((stop, index) => ({ index, name: stop.name }))
          }))
        }
      });
      return true;
    }

    if (requestUrl.pathname === "/api/transport/schedule") {
      const directionIndex = miniAppIndex(requestUrl.searchParams.get("direction"), route.directions.length);
      if (directionIndex < 0) {
        miniAppError(res, 400, "Invalid direction");
        return true;
      }
      const direction = route.directions[directionIndex];
      const stopIndex = miniAppIndex(requestUrl.searchParams.get("stop"), direction.stops.length);
      if (stopIndex < 0) {
        miniAppError(res, 400, "Invalid stop");
        return true;
      }
      const schedule = await getBtransStopSchedule(direction.stops[stopIndex].url);
      sendJson(res, 200, {
        ok: true,
        schedule: {
          title: schedule.title,
          stopName: schedule.stopName,
          direction: schedule.direction,
          weekdays: schedule.schedule.weekdays,
          weekend: schedule.schedule.weekend
        }
      });
      return true;
    }

    miniAppError(res, 404, "Not found");
    return true;
  } catch (error) {
    console.error("Mini App transport error:", error.message);
    miniAppError(res, 502, "Transport service is unavailable");
    return true;
  }
}

function startWebhookServer() {
  const baseUrl = getWebhookBaseUrl();
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || "/", "http://localhost");
      if (requestUrl.pathname === WEATHER_NOTIFICATIONS_DELIVERY_PATH) {
        await handleWeatherNotificationDelivery(req, res);
        return;
      }
      if (await handleMiniAppRequest(req, res, requestUrl)) return;

      if (req.method === "GET" && (req.url === "/" || req.url === "/healthz")) {
        res.writeHead(200, securityHeaders());
        res.end("ok");
        return;
      }

      if (req.method === "POST" && req.url === WEBHOOK_PATH) {
        const secretMatches = !WEBHOOK_SECRET || req.headers["x-telegram-bot-api-secret-token"] === WEBHOOK_SECRET;
        if (!secretMatches) {
          res.writeHead(403, securityHeaders());
          res.end("forbidden");
          return;
        }

        const contentType = String(req.headers["content-type"] || "").toLowerCase();
        if (!contentType.includes("application/json")) {
          res.writeHead(415, securityHeaders());
          res.end("unsupported media type");
          return;
        }

        let body;
        try {
          body = await readRequestBody(req, 256 * 1024);
        } catch (error) {
          const isTooLarge = error?.message === "Request body too large";
          res.writeHead(isTooLarge ? 413 : 400, securityHeaders());
          res.end(isTooLarge ? "request too large" : "bad request");
          return;
        }
        let update;
        try {
          update = JSON.parse(body);
        } catch {
          res.writeHead(400, securityHeaders());
          res.end("bad json");
          return;
        }

        const paymentUpdate = Boolean(update.pre_checkout_query || update.message?.successful_payment);
        if (paymentUpdate) {
          try {
            await handleUpdate(update);
          } catch (error) {
            console.error("Webhook payment update error:", error.message);
            res.writeHead(500, securityHeaders());
            res.end("payment update failed");
            return;
          }
          res.writeHead(200, securityHeaders("application/json; charset=utf-8"));
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.writeHead(200, securityHeaders("application/json; charset=utf-8"));
        res.end(JSON.stringify({ ok: true }));
        handleUpdate(update).catch((error) => {
          console.error("Webhook update error:", error.message);
        });
        return;
      }

      res.writeHead(404, securityHeaders());
      res.end("not found");
    } catch (error) {
      console.error("Webhook request error:", error.message);
      if (!res.headersSent) res.writeHead(500, securityHeaders());
      res.end("error");
    }
  });

  server.listen(PORT, async () => {
    console.log(`Webhook server is running on port ${PORT}.`);
    if (baseUrl) {
      try {
        await configureWebhook(baseUrl);
        await configureMiniAppMenuButton();
        await logTelegramBotIdentity();
        await logWebhookStatus();
      } catch (error) {
        console.error("Webhook setup error:", error.message);
      }
    } else {
      console.log("WEBHOOK_URL is missing, server is up but Telegram webhook was not configured.");
    }
    await grantConfiguredComplimentaryPro();
  });
}

async function startPollingSafely() {
  try {
    const webhook = await telegram("getWebhookInfo", {});
    if (webhook?.url) {
      console.error(`Webhook is active at ${webhook.url}. Local polling was not started to avoid Telegram conflicts.`);
      return;
    }
  } catch (error) {
    console.error("Could not verify webhook status:", error.message);
    return;
  }
  console.log("Weather bot is running. Press Ctrl+C to stop.");
  poll();
}

if (require.main === module) {
  if (!BOT_TOKEN) {
    console.error("BOT_TOKEN is missing. Create .env from .env.example and paste BotFather token.");
    process.exit(1);
  }

  if (PORT && !WEBHOOK_SECRET) {
    console.error("WEBHOOK_SECRET is missing. Refusing to start webhook mode without Telegram secret protection.");
    process.exit(1);
  }

  if (PORT) {
    startWebhookServer();
  } else {
    startPollingSafely();
  }
}

module.exports = {
  grodnoClock,
  nextTwoHourDepartures,
  miniAppNotificationAction,
  miniAppWeatherPayload,
  miniAppProWeatherDetails,
  weatherNotificationSubscriber,
  formatWeatherNotification,
  createProInvoicePayload,
  parseProInvoicePayload,
  proCheckoutDetails,
  proSuccessfulPaymentDetails,
  proWelcomeText,
  parseComplimentaryProUsernameGifts,
  addCalendarMonthsToEpoch,
  complimentaryProChargeId
};
