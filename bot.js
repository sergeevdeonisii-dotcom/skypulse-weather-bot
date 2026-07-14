const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

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
const PREFERENCES_FILE = process.env.PREFERENCES_FILE || path.join(__dirname, "data", "user-preferences.json");

const userSessions = new Map();
const userLanguages = new Map();
const lastClothingAdvice = new Map();
const rateBuckets = new Map();
const userPreferences = new Map();
const transportCache = {
  routes: { value: null, expiresAt: 0 },
  stops: { value: null, expiresAt: 0 },
  routeLists: new Map(),
  routePages: new Map(),
  stopPages: new Map()
};
const callbackStore = new Map();
let offset = 0;
let lastStateCleanupAt = 0;

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
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
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

function menuKeyboard(lang) {
  return {
    inline_keyboard: [
      [
        { text: lang === "en" ? "🌤️ Weather" : "🌤️ Погода", callback_data: "weather_menu" },
        { text: lang === "en" ? "🚌 Transport" : "🚌 Транспорт", callback_data: "transport_menu" }
      ],
      [
        { text: LABELS[lang].help, callback_data: "help" },
        { text: LABELS[lang].language, callback_data: "choose_lang" }
      ],
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

function helpText(lang) {
  if (lang === "en") {
    return [
      "<b>What I can do:</b>",
      "1. Forecast for today or tomorrow.",
      "2. Forecast for an exact hour, like 15 or 15:00.",
      "3. Clothing advice after the forecast.",
      "",
      "Example: Weather tomorrow -> type London -> Afternoon 15:00 -> What should I wear?"
    ].join("\n");
  }

  return [
    "<b>Что я умею:</b>",
    "1. Прогноз на сегодня или завтра.",
    "2. Прогноз на конкретный час: например 15 или 15:00.",
    "3. Подсказка по одежде после прогноза.",
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
  label = "External API"
} = {}) {
  const response = await fetchWithTimeout(url, { headers }, timeoutMs);
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
      allowed_updates: ["message", "callback_query"]
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
    allowed_updates: ["message", "callback_query"],
    secret_token: WEBHOOK_SECRET || undefined
  });
  console.log(`Telegram webhook set for host: ${new URL(webhookUrl).host}`);
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

function startWebhookServer() {
  const baseUrl = getWebhookBaseUrl();
  const server = http.createServer(async (req, res) => {
    try {
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
        await logWebhookStatus();
      } catch (error) {
        console.error("Webhook setup error:", error.message);
      }
    } else {
      console.log("WEBHOOK_URL is missing, server is up but Telegram webhook was not configured.");
    }
  });
}

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing. Create .env from .env.example and paste BotFather token.");
  process.exit(1);
}

if (PORT && !WEBHOOK_SECRET) {
  console.error("WEBHOOK_SECRET is missing. Refusing to start webhook mode without Telegram secret protection.");
  process.exit(1);
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

if (PORT) {
  startWebhookServer();
} else {
  startPollingSafely();
}
