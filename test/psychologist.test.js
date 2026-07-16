"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isPsychologyCrisisMessage,
  miniAppPsychologyMessages,
  psychologistCrisisAnswer
} = require("../bot");

test("flags clear self-harm and harm-to-others messages for the crisis flow", () => {
  assert.equal(isPsychologyCrisisMessage("Я хочу покончить с собой"), true);
  assert.equal(isPsychologyCrisisMessage("Я порежу себя"), true);
  assert.equal(isPsychologyCrisisMessage("Я застрелю этого человека"), true);
  assert.equal(isPsychologyCrisisMessage("Мне тревожно перед экзаменом"), false);
});

test("accepts a short alternating psychologist conversation that ends with the user", () => {
  const messages = miniAppPsychologyMessages([
    { role: "user", text: "Мне тяжело после ссоры" },
    { role: "model", text: "Похоже, это было болезненно." },
    { role: "user", text: "Да, я всё время прокручиваю разговор." }
  ]);
  assert.deepEqual(messages, [
    { role: "user", text: "Мне тяжело после ссоры" },
    { role: "model", text: "Похоже, это было болезненно." },
    { role: "user", text: "Да, я всё время прокручиваю разговор." }
  ]);
});

test("rejects malformed or non-alternating psychologist messages", () => {
  assert.equal(miniAppPsychologyMessages([]), null);
  assert.equal(miniAppPsychologyMessages([
    { role: "user", text: "Первое" },
    { role: "user", text: "Второе" }
  ]), null);
  assert.equal(miniAppPsychologyMessages([
    { role: "model", text: "Ответ без вопроса" }
  ]), null);
});

test("crisis reply directs the person to immediate real-world support", () => {
  const answer = psychologistCrisisAnswer();
  assert.equal(answer.kind, "crisis");
  assert.match(answer.message, /112/);
  assert.match(answer.message, /103/);
  assert.match(answer.message, /безопасном месте/i);
});
