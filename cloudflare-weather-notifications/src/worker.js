const MAX_RECIPIENTS_PER_RUN = 30;
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function cleanChatId(value) {
  const chatId = String(value || "");
  return /^\d{1,20}$/.test(chatId) ? chatId : null;
}

function cleanCity(value) {
  const city = String(value || "").trim().replace(/\s+/g, " ");
  return city.length >= 2 && city.length <= 100 && !/[\r\n\u0000]/.test(city) ? city : null;
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  const encoder = new TextEncoder();
  const first = encoder.encode(left);
  const second = encoder.encode(right);
  const size = Math.max(first.length, second.length);
  let mismatch = first.length ^ second.length;
  for (let index = 0; index < size; index += 1) {
    mismatch |= (first[index] || 0) ^ (second[index] || 0);
  }
  return mismatch === 0;
}

function hasInternalSecret(request, env) {
  return constantTimeEqual(request.headers.get("X-SkyPulse-Notification-Secret") || "", env.WEATHER_NOTIFICATIONS_SHARED_SECRET || "");
}

async function requestPayload(request) {
  const text = await request.text();
  if (!text || text.length > 8 * 1024) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function subscriptionFromRow(row) {
  return {
    subscribed: Boolean(row?.enabled),
    city: cleanCity(row?.city) || null
  };
}

async function subscriptionStatus(env, chatId) {
  const row = await env.DB.prepare(
    "SELECT city, enabled FROM weather_subscriptions WHERE chat_id = ? LIMIT 1"
  ).bind(chatId).first();
  return subscriptionFromRow(row);
}

async function updateSubscription(request, env) {
  if (!hasInternalSecret(request, env)) return json({ ok: false, error: "Forbidden" }, 403);
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const payload = await requestPayload(request);
  const action = String(payload?.action || "");
  const chatId = cleanChatId(payload?.chatId);
  if (!chatId || !["status", "subscribe", "unsubscribe"].includes(action)) {
    return json({ ok: false, error: "Invalid subscription request" }, 400);
  }

  if (action === "status") {
    return json({ ok: true, subscription: await subscriptionStatus(env, chatId) });
  }

  if (action === "subscribe") {
    const city = cleanCity(payload?.city);
    if (!city) return json({ ok: false, error: "Invalid city" }, 400);
    await env.DB.prepare(
      `INSERT INTO weather_subscriptions (chat_id, city, enabled, created_at, updated_at, last_sent_at)
       VALUES (?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
       ON CONFLICT(chat_id) DO UPDATE SET
         city = excluded.city,
         enabled = 1,
         updated_at = CURRENT_TIMESTAMP`
    ).bind(chatId, city).run();
    return json({ ok: true, subscription: { subscribed: true, city } });
  }

  await env.DB.prepare(
    "UPDATE weather_subscriptions SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?"
  ).bind(chatId).run();
  return json({ ok: true, subscription: { subscribed: false, city: null } });
}

function idsFrom(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanChatId).filter(Boolean))].slice(0, MAX_RECIPIENTS_PER_RUN);
}

async function markSubscribers(env, chatIds, values) {
  if (!chatIds.length) return;
  const statements = chatIds.map((chatId) => env.DB.prepare(
    `UPDATE weather_subscriptions
     SET ${values}, updated_at = CURRENT_TIMESTAMP
     WHERE chat_id = ?`
  ).bind(chatId));
  await env.DB.batch(statements);
}

async function deliverScheduledWeather(env) {
  if (!env.RENDER_DELIVERY_URL || !env.WEATHER_NOTIFICATIONS_SHARED_SECRET) {
    throw new Error("Notification Worker is missing its Render URL or shared secret");
  }
  const result = await env.DB.prepare(
    `SELECT chat_id AS chatId, city
     FROM weather_subscriptions
     WHERE enabled = 1
     ORDER BY CASE WHEN last_sent_at IS NULL THEN 0 ELSE 1 END ASC, last_sent_at ASC
     LIMIT ?`
  ).bind(MAX_RECIPIENTS_PER_RUN).all();
  const subscribers = (result.results || []).map((row) => ({
    chatId: cleanChatId(row.chatId),
    city: cleanCity(row.city)
  })).filter((row) => row.chatId && row.city);
  if (!subscribers.length) return { attempted: 0, delivered: 0, disabled: 0 };

  const response = await fetch(env.RENDER_DELIVERY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-SkyPulse-Notification-Secret": env.WEATHER_NOTIFICATIONS_SHARED_SECRET
    },
    body: JSON.stringify({ subscribers })
  });
  if (!response.ok) throw new Error(`Render delivery failed (HTTP ${response.status})`);
  const delivery = await response.json();
  if (!delivery?.ok) throw new Error("Render delivery returned an invalid response");

  const delivered = idsFrom(delivery.delivered);
  const disabled = idsFrom(delivery.disabled);
  await markSubscribers(env, delivered, "last_sent_at = CURRENT_TIMESTAMP");
  await markSubscribers(env, disabled, "enabled = 0");
  return { attempted: subscribers.length, delivered: delivered.length, disabled: disabled.length };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/v1/subscriptions") return updateSubscription(request, env);
    return json({ ok: false, error: "Not found" }, 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(deliverScheduledWeather(env));
  }
};
