"use strict";

// In Belarus these dates are statutory non-working holidays. Grodno's timetable
// has two columns only, so the Mini App uses the weekend column for them.
const FIXED_NON_WORKING_HOLIDAYS = new Map([
  ["01-01", "Новый год"],
  ["01-02", "Новый год"],
  ["01-07", "Рождество Христово (православное)"],
  ["03-08", "Международный женский день"],
  ["05-01", "Праздник труда"],
  ["05-09", "День Победы"],
  ["07-03", "День Независимости Республики Беларусь"],
  ["11-07", "День Октябрьской революции"],
  ["12-25", "Рождество Христово (католическое)"]
]);

// Additional days off created by official working-day transfers. The calendar
// still allows new dates to be supplied through BELARUS_WEEKEND_SERVICE_DATES
// without a code deployment, in YYYY-MM-DD or YYYY-MM-DD:reason form.
const DECLARED_WEEKEND_SERVICE_DATES = new Map([
  ["2025-01-06", "перенесённый выходной день"],
  ["2025-04-28", "перенесённый выходной день"],
  ["2025-07-04", "перенесённый выходной день"],
  ["2025-12-26", "перенесённый выходной день"],
  ["2026-04-20", "перенесённый выходной день"]
]);

function pad(value) {
  return String(value).padStart(2, "0");
}

function isoDateFromUtc(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function orthodoxEasterIsoDate(year) {
  // Meeus Julian algorithm, converted from the Julian calendar to Gregorian.
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  const julianToGregorianDays = Math.floor(year / 100) - Math.floor(year / 400) - 2;
  return isoDateFromUtc(new Date(Date.UTC(year, month - 1, day + julianToGregorianDays)));
}

function radunitsaIsoDate(year) {
  const [easterYear, month, day] = orthodoxEasterIsoDate(year).split("-").map(Number);
  return isoDateFromUtc(new Date(Date.UTC(easterYear, month - 1, day + 9)));
}

function configuredWeekendServiceDates(value) {
  const dates = new Map(DECLARED_WEEKEND_SERVICE_DATES);
  for (const entry of String(value || "").split(",")) {
    const [date, rawReason] = entry.trim().split(":", 2);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) continue;
    dates.set(date, String(rawReason || "объявленный нерабочий день").trim() || "объявленный нерабочий день");
  }
  return dates;
}

function serviceDayForDateParts(parts, extraWeekendDates) {
  const year = Number(parts?.year);
  const month = Number(parts?.month);
  const day = Number(parts?.day);
  const weekday = String(parts?.weekday || "");
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return { mode: "weekdays", label: "рабочий день", date: "" };
  }

  const date = `${year}-${pad(month)}-${pad(day)}`;
  const fixedHoliday = FIXED_NON_WORKING_HOLIDAYS.get(`${pad(month)}-${pad(day)}`);
  const holiday = fixedHoliday || (date === radunitsaIsoDate(year) ? "Радуница" : "");
  const declaredDays = extraWeekendDates instanceof Map ? extraWeekendDates : configuredWeekendServiceDates();
  const declaredDay = declaredDays.get(date);
  const regularWeekend = weekday === "Sat" || weekday === "Sun";

  if (holiday) {
    return { mode: "weekend", label: holiday, date, isHoliday: true, isWeekend: regularWeekend };
  }
  if (declaredDay) {
    return { mode: "weekend", label: declaredDay, date, isHoliday: false, isWeekend: regularWeekend };
  }
  if (regularWeekend) {
    return { mode: "weekend", label: "выходной день", date, isHoliday: false, isWeekend: true };
  }
  return { mode: "weekdays", label: "рабочий день", date, isHoliday: false, isWeekend: false };
}

module.exports = {
  configuredWeekendServiceDates,
  orthodoxEasterIsoDate,
  radunitsaIsoDate,
  serviceDayForDateParts
};
