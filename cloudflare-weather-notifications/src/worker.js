const MAX_RECIPIENTS_PER_RUN = 30;
const MAX_PRO_EXPIRY_SECONDS = 400 * 24 * 60 * 60;
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

function epochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function cleanProExpiry(value) {
  const expiresAt = Number(value);
  const now = epochSeconds();
  return Number.isSafeInteger(expiresAt) && expiresAt > now && expiresAt <= now + MAX_PRO_EXPIRY_SECONDS
    ? expiresAt
    : null;
}

function cleanPaymentChargeId(value) {
  const chargeId = String(value || "").trim();
  return chargeId.length >= 1 && chargeId.length <= 256 && !/[\r\n\u0000]/.test(chargeId) ? chargeId : null;
}

function isComplimentaryProChargeId(value) {
  return /^complimentary-pro-\d{1,20}-v1$/.test(String(value || ""));
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

function proSubscriptionFromRow(row) {
  const expiresAt = Number(row?.expiresAt);
  const active = Number.isSafeInteger(expiresAt) && expiresAt > epochSeconds();
  const chargeId = active ? cleanPaymentChargeId(row?.chargeId) : null;
  return {
    active,
    expiresAt: active ? expiresAt : null,
    autoRenewing: active && Number(row?.autoRenewing) === 1,
    complimentary: active && isComplimentaryProChargeId(chargeId),
    chargeId
  };
}

async function proSubscriptionStatus(env, chatId) {
  const row = await env.DB.prepare(
    `SELECT expires_at AS expiresAt, auto_renewing AS autoRenewing,
            telegram_payment_charge_id AS chargeId
     FROM pro_subscriptions WHERE chat_id = ? LIMIT 1`
  ).bind(chatId).first();
  return proSubscriptionFromRow(row);
}

async function updateProSubscription(request, env) {
  if (!hasInternalSecret(request, env)) return json({ ok: false, error: "Forbidden" }, 403);
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const payload = await requestPayload(request);
  const action = String(payload?.action || "");
  const chatId = cleanChatId(payload?.chatId);
  if (!chatId || !["status", "grant", "set_auto_renewal"].includes(action)) {
    return json({ ok: false, error: "Invalid Pro subscription request" }, 400);
  }

  if (action === "status") {
    return json({ ok: true, subscription: await proSubscriptionStatus(env, chatId) });
  }

  if (action === "set_auto_renewal") {
    if (typeof payload?.autoRenewing !== "boolean") {
      return json({ ok: false, error: "Invalid auto renewal setting" }, 400);
    }
    const current = await proSubscriptionStatus(env, chatId);
    if (!current.active) return json({ ok: false, error: "No active Pro subscription" }, 409);
    await env.DB.prepare(
      "UPDATE pro_subscriptions SET auto_renewing = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?"
    ).bind(payload.autoRenewing ? 1 : 0, chatId).run();
    return json({ ok: true, subscription: await proSubscriptionStatus(env, chatId) });
  }

  const expiresAt = cleanProExpiry(payload?.expiresAt);
  const chargeId = cleanPaymentChargeId(payload?.chargeId);
  const isFirstRecurring = payload?.isFirstRecurring === true;
  if (!expiresAt || !chargeId) return json({ ok: false, error: "Invalid Pro payment" }, 400);
  const isComplimentary = isComplimentaryProChargeId(chargeId);
  const shouldEnableAutoRenewal = isFirstRecurring && !isComplimentary;

  const paymentInsert = await env.DB.prepare(
    `INSERT OR IGNORE INTO pro_payments
       (telegram_payment_charge_id, chat_id, expires_at, is_first_recurring, created_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).bind(chargeId, chatId, expiresAt, isFirstRecurring ? 1 : 0).run();
  const newPayment = Number(paymentInsert.meta?.changes) > 0;

  if (newPayment) {
    const existing = await env.DB.prepare(
      "SELECT telegram_payment_charge_id AS chargeId FROM pro_subscriptions WHERE chat_id = ? LIMIT 1"
    ).bind(chatId).first();
    const replaceChargeId = isFirstRecurring || !cleanPaymentChargeId(existing?.chargeId);
    await env.DB.prepare(
      `INSERT INTO pro_subscriptions
         (chat_id, expires_at, telegram_payment_charge_id, auto_renewing, last_payment_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(chat_id) DO UPDATE SET
         expires_at = CASE WHEN excluded.expires_at > pro_subscriptions.expires_at
           THEN excluded.expires_at ELSE pro_subscriptions.expires_at END,
         telegram_payment_charge_id = CASE WHEN ? = 1
           THEN excluded.telegram_payment_charge_id ELSE pro_subscriptions.telegram_payment_charge_id END,
         auto_renewing = CASE
           WHEN ? = 1 THEN excluded.auto_renewing
           WHEN ? = 1 THEN 0
           ELSE pro_subscriptions.auto_renewing
         END,
         last_payment_at = excluded.last_payment_at,
         updated_at = CURRENT_TIMESTAMP`
    ).bind(
      chatId,
      expiresAt,
      chargeId,
      shouldEnableAutoRenewal ? 1 : 0,
      epochSeconds(),
      replaceChargeId ? 1 : 0,
      shouldEnableAutoRenewal ? 1 : 0,
      isComplimentary ? 1 : 0
    ).run();
  }

  return json({
    ok: true,
    newPayment,
    subscription: await proSubscriptionStatus(env, chatId)
  });
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
    `SELECT weather_subscriptions.chat_id AS chatId, weather_subscriptions.city,
            CASE WHEN pro_subscriptions.expires_at > ? THEN 1 ELSE 0 END AS pro
     FROM weather_subscriptions
     LEFT JOIN pro_subscriptions ON pro_subscriptions.chat_id = weather_subscriptions.chat_id
     WHERE weather_subscriptions.enabled = 1
     ORDER BY CASE WHEN weather_subscriptions.last_sent_at IS NULL THEN 0 ELSE 1 END ASC,
              weather_subscriptions.last_sent_at ASC
     LIMIT ?`
  ).bind(epochSeconds(), MAX_RECIPIENTS_PER_RUN).all();
  const subscribers = (result.results || []).map((row) => ({
    chatId: cleanChatId(row.chatId),
    city: cleanCity(row.city),
    pro: Number(row.pro) === 1
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
    if (url.pathname === "/v1/pro") return updateProSubscription(request, env);
    return json({ ok: false, error: "Not found" }, 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(deliverScheduledWeather(env));
  }
};
