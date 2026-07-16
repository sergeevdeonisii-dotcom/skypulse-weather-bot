"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  miniAppNotificationAction,
  weatherNotificationSubscriber,
  formatWeatherNotification
} = require("../bot");

test("accepts only the supported weather notification actions", () => {
  assert.equal(miniAppNotificationAction("status"), "status");
  assert.equal(miniAppNotificationAction("subscribe"), "subscribe");
  assert.equal(miniAppNotificationAction("unsubscribe"), "unsubscribe");
  assert.equal(miniAppNotificationAction("deliver"), null);
});

test("validates the subscriber shape before a scheduled delivery", () => {
  assert.deepEqual(weatherNotificationSubscriber({ chatId: "123456", city: "Гродно" }), {
    chatId: "123456",
    city: "Гродно"
  });
  assert.equal(weatherNotificationSubscriber({ chatId: "not-a-chat", city: "Гродно" }), null);
  assert.equal(weatherNotificationSubscriber({ chatId: "123456", city: "\n" }), null);
});

test("formats a compact escaped weather update", () => {
  const message = formatWeatherNotification({ name: "<Гродно>", country: "Беларусь" }, {
    current: { temperature_2m: 12.4, apparent_temperature: 10.9, wind_speed_10m: 14.2, weather_code: 61 },
    daily: {
      temperature_2m_min: [7.1],
      temperature_2m_max: [16.7],
      precipitation_probability_max: [65]
    }
  });
  assert.match(message, /Погода каждые 3 часа/);
  assert.match(message, /&lt;Гродно&gt;/);
  assert.doesNotMatch(message, /<Гродно>/);
  assert.match(message, /12°C/);
});
