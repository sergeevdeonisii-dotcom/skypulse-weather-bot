"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createProInvoicePayload,
  parseProInvoicePayload,
  proCheckoutDetails,
  proSuccessfulPaymentDetails,
  proInfoText,
  proWelcomeText,
  parseComplimentaryProUsernameGifts,
  addCalendarMonthsToEpoch,
  complimentaryProChargeId,
  miniAppWeatherPayload,
  miniAppProWeatherDetails,
  rememberMiniAppWeatherSnapshot,
  readMiniAppWeatherSnapshot,
  metNoForecastPayload,
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
  assert.match(text, /расширенные детали в уведомлениях о погоде каждые 3 часа/);
  assert.match(text, /совет по одежде/);
  assert.match(text, /план погоды на 24 часа/);
  assert.match(text, /построение поездок по адресам с пересадками и картой/);
  assert.match(text, /умный поиск ближайших рейсов по остановке/);
  assert.match(text, /дожде, сильном ветре и грозе/);
});

test("describes the Pro-only transport tools in the bot tariff conditions", () => {
  const text = proInfoText("ru");
  assert.match(text, /построение поездок по адресам с пересадками и картой/);
  assert.match(text, /умный поиск по остановке/);
});

test("keeps outfit advice and the 24-hour plan out of the Free weather payload", () => {
  const hourlyTimes = Array.from({ length: 48 }, (_, index) => (
    new Date(Date.UTC(2027, 0, 2, index, 0)).toISOString().slice(0, 16)
  ));
  const weather = {
    timezone: "Europe/Minsk",
    current: {
      time: "2027-01-02T09:15",
      temperature_2m: 12,
      apparent_temperature: 10,
      weather_code: 2,
      wind_speed_10m: 11
    },
    hourly: {
      time: hourlyTimes,
      temperature_2m: hourlyTimes.map((_, index) => 8 + (index % 7)),
      apparent_temperature: hourlyTimes.map((_, index) => 7 + (index % 7)),
      precipitation_probability: hourlyTimes.map((_, index) => index === 4 ? 65 : 10),
      weather_code: hourlyTimes.map(() => 2),
      wind_speed_10m: hourlyTimes.map(() => 11)
    },
    daily: {
      time: ["2027-01-02", "2027-01-03"],
      weather_code: [2, 3],
      temperature_2m_min: [7, 5],
      temperature_2m_max: [14, 12],
      precipitation_probability_max: [10, 50]
    }
  };
  const city = { name: "Гродно", timezone: "Europe/Minsk" };

  const free = miniAppWeatherPayload(city, weather);
  assert.equal(Object.prototype.hasOwnProperty.call(free, "clothing"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(free, "hours"), false);

  const pro = miniAppProWeatherDetails(city, weather);
  assert.ok(pro.clothing.base);
  assert.equal(pro.hours.length, 24);
  assert.equal(pro.hours[0].time, "09:00");
  assert.match(pro.comfortWindow, /Лучшее окно/);
});

test("reuses a freshly loaded weather snapshot only for its Pro owner and city", () => {
  const city = { name: "Grodno", country: "Belarus" };
  const weather = { marker: "forecast" };
  const observedCurrent = { temperature_2m: 22 };
  const now = 1_800_000_000_000;
  const token = rememberMiniAppWeatherSnapshot("123456", city, weather, observedCurrent, now);

  assert.match(token, /^[a-f0-9]{48}$/);
  const snapshot = readMiniAppWeatherSnapshot(token, "123456", "Grodno, Belarus", now + 1);
  assert.equal(snapshot.weather, weather);
  assert.equal(snapshot.observedCurrent, observedCurrent);
  assert.equal(readMiniAppWeatherSnapshot(token, "654321", "Grodno, Belarus", now + 1), null);
  assert.equal(readMiniAppWeatherSnapshot(token, "123456", "Minsk, Belarus", now + 1), null);
  assert.equal(readMiniAppWeatherSnapshot(token, "123456", "Grodno, Belarus", now + 21 * 60 * 1000), null);
});

test("converts MET Norway hourly data into the shared weather forecast shape", () => {
  const city = { name: "Grodno", latitude: 53.6694, longitude: 23.8131, timezone: "Europe/Minsk" };
  const timeseries = Array.from({ length: 48 }, (_, index) => ({
    time: new Date(Date.UTC(2027, 0, 1, 21 + index, 0, 0)).toISOString(),
    data: {
      instant: { details: { air_temperature: 4 + (index % 4), wind_speed: 9 } },
      next_1_hours: {
        summary: { symbol_code: index === 5 ? "heavyrain" : "clearsky_day" },
        details: { precipitation_amount: index === 5 ? 3.2 : 0 }
      }
    }
  }));

  const weather = metNoForecastPayload(city, { properties: { timeseries } });

  assert.equal(weather.source, "met.no");
  assert.equal(weather.current.time, "2027-01-02T00:00");
  assert.equal(weather.hourly.time.length, 48);
  assert.equal(weather.hourly.weather_code[5], 65);
  assert.equal(weather.hourly.precipitation_probability[5], 90);
  assert.deepEqual(weather.daily.time, ["2027-01-02", "2027-01-03"]);
  assert.equal(weather.daily.precipitation_probability_max[0], 90);
});

test("labels a complimentary Pro period without an auto-renewal promise", () => {
  const text = proWelcomeText(NOW + 30 * 24 * 60 * 60, { complimentary: true });
  assert.match(text, /подключён бесплатно/);
  assert.match(text, /Stars не списывались/);
  assert.match(text, /Автопродление для подарочной подписки отключено/);
});

test("queues username gifts safely and calculates their calendar expiry", () => {
  assert.deepEqual(
    parseComplimentaryProUsernameGifts("@SkyFriend:6,invalid:0,too:many:parts"),
    new Map([["skyfriend", 6]])
  );
  const januaryThirtyFirst = Math.floor(Date.UTC(2027, 0, 31, 12, 15, 0) / 1000);
  assert.equal(
    addCalendarMonthsToEpoch(januaryThirtyFirst, 1),
    Math.floor(Date.UTC(2027, 1, 28, 12, 15, 0) / 1000)
  );
  assert.equal(
    addCalendarMonthsToEpoch(januaryThirtyFirst, 120),
    Math.floor(Date.UTC(2037, 0, 31, 12, 15, 0) / 1000)
  );
  assert.equal(complimentaryProChargeId("123456", "username-skyfriend"), "complimentary-pro-123456-username-skyfriend-v1");
  assert.equal(addCalendarMonthsToEpoch(januaryThirtyFirst, 0), null);
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
