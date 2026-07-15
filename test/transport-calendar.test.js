"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  orthodoxEasterIsoDate,
  radunitsaIsoDate,
  serviceDayForDateParts
} = require("../transport-calendar");
const { nextTwoHourDepartures } = require("../bot");

test("calculates Orthodox Easter and Radunitsa for 2026", () => {
  assert.equal(orthodoxEasterIsoDate(2026), "2026-04-12");
  assert.equal(radunitsaIsoDate(2026), "2026-04-21");
});

test("uses the weekend timetable on Belarus non-working holidays", () => {
  const radunitsa = serviceDayForDateParts({ year: 2026, month: 4, day: 21, weekday: "Tue" });
  const independenceDay = serviceDayForDateParts({ year: 2026, month: 7, day: 3, weekday: "Fri" });
  assert.equal(radunitsa.mode, "weekend");
  assert.equal(radunitsa.label, "Радуница");
  assert.equal(independenceDay.mode, "weekend");
});

test("keeps ordinary working holidays on the weekday timetable", () => {
  const constitutionDay = serviceDayForDateParts({ year: 2026, month: 3, day: 15, weekday: "Sun" });
  const unityDay = serviceDayForDateParts({ year: 2026, month: 4, day: 2, weekday: "Thu" });
  assert.equal(constitutionDay.mode, "weekend"); // Sunday is weekend independently of the observance.
  assert.equal(unityDay.mode, "weekdays");
});

test("uses the weekend timetable on an officially transferred day off", () => {
  const transferredDay = serviceDayForDateParts({ year: 2026, month: 4, day: 20, weekday: "Mon" });
  assert.equal(transferredDay.mode, "weekend");
  assert.equal(transferredDay.label, "перенесённый выходной день");
});

test("smart search returns only the next two hours and uses the holiday timetable", () => {
  const schedule = {
    schedule: {
      weekdays: ["10: 00 30", "11: 50", "12: 00"],
      weekend: ["10: 05 35", "11: 45"]
    }
  };
  // 03 July 2026 is a Friday but a non-working Independence Day in Belarus.
  const departures = nextTwoHourDepartures(schedule, new Date("2026-07-03T06:50:00Z"));
  assert.deepEqual(departures.map((item) => item.time), ["10:05", "10:35", "11:45"]);
  assert.ok(departures.every((item) => item.minutesUntil <= 120));
});
