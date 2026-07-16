"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createProInvoicePayload,
  parseProInvoicePayload,
  proCheckoutDetails,
  proSuccessfulPaymentDetails,
  proWelcomeText,
  formatWeatherNotification,
  weatherNotificationSubscriber
} = require("../bot");

const TEST_SECRET = "test-only-signing-secret";
const NOW = 1_800_000_000;

test("creates a short-lived Pro invoice payload bound to one Telegram user", () => {
  const payload = createProInvoicePayload("123456", NOW, TEST_SECRET);
  const invoice = parseProInvoicePayload(payload, NOW, TEST_SECRET);

  assert.deepEqual(invoice, { userId: "123456", expiresAt: NOW + 20 * 60 });
  assert.equal(parseProInvoicePayload(payload, NOW + 20 * 60, TEST_SECRET), null);
  assert.equal(parseProInvoicePayload(`${payload}x`, NOW, TEST_SECRET), null);
});

test("rejects a Pro checkout when the payer or Stars amount does not match", () => {
  const payload = createProInvoicePayload("123456", NOW, TEST_SECRET);

  assert.ok(proCheckoutDetails(payload, "123456", "XTR", 10, NOW, TEST_SECRET));
  assert.equal(proCheckoutDetails(payload, "999999", "XTR", 10, NOW, TEST_SECRET), null);
  assert.equal(proCheckoutDetails(payload, "123456", "XTR", 9, NOW, TEST_SECRET), null);
  assert.equal(proCheckoutDetails(payload, "123456", "USD", 10, NOW, TEST_SECRET), null);
});

test("accepts only a valid recurring Pro payment with a Telegram payment charge", () => {
  const payload = createProInvoicePayload("123456", NOW, TEST_SECRET);
  const details = proSuccessfulPaymentDetails({
    invoice_payload: payload,
    currency: "XTR",
    total_amount: 10,
    subscription_expiration_date: NOW + 30 * 24 * 60 * 60,
    telegram_payment_charge_id: "telegram-charge-1",
    is_first_recurring: true
  }, "123456", NOW, TEST_SECRET);

  assert.deepEqual(details, {
    userId: "123456",
    expiresAt: NOW + 30 * 24 * 60 * 60,
    chargeId: "telegram-charge-1",
    isFirstRecurring: true
  });
  assert.equal(proSuccessfulPaymentDetails({
    invoice_payload: payload,
    currency: "XTR",
    total_amount: 10,
    subscription_expiration_date: NOW + 30 * 24 * 60 * 60
  }, "123456", NOW, TEST_SECRET), null);
});

test("confirms a Pro purchase with the enabled notification features", () => {
  const text = proWelcomeText(NOW + 30 * 24 * 60 * 60);
  assert.match(text, /Вы приобрели SkyPulse Pro/);
  assert.match(text, /уведомления о погоде каждые 3 часа/);
  assert.match(text, /совет по одежде/);
  assert.match(text, /дожде, сильном ветре и грозе/);
});

test("labels a complimentary Pro period without an auto-renewal promise", () => {
  const text = proWelcomeText(NOW + 30 * 24 * 60 * 60, { complimentary: true });
  assert.match(text, /подключён бесплатно/);
  assert.match(text, /Stars не списывались/);
  assert.match(text, /Автопродление для подарочной подписки отключено/);
});

test("marks Pro notification recipients and adds their extra weather guidance", () => {
  const subscriber = weatherNotificationSubscriber({ chatId: "123456", city: "Гродно", pro: true });
  assert.deepEqual(subscriber, { chatId: "123456", city: "Гродно", pro: true });

  const text = formatWeatherNotification({ name: "Гродно" }, {
    current: { temperature_2m: 11, apparent_temperature: 8, wind_speed_10m: 38, weather_code: 63 },
    daily: {
      temperature_2m_min: [5],
      temperature_2m_max: [13],
      precipitation_probability_max: [80]
    }
  }, { pro: true });

  assert.match(text, /SkyPulse Pro/);
  assert.match(text, /На улицу:/);
  assert.match(text, /Сильный ветер/);
});
