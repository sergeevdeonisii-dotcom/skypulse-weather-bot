# SkyPulse Weather Bot

Telegram bot with weather and Grodno public transport schedules.

## Scheduled weather notifications

The Weather tab can opt a Telegram user in to an update every three hours. The
schedule runs in `cloudflare-weather-notifications`, a Cloudflare Worker with a
D1 database. The Worker stores only the Telegram chat ID, selected city, and the
last successful delivery time. It wakes Render only when an update is due, so the
feature keeps working while the Free Render web service is asleep.

The two services authenticate each other with the `WEATHER_NOTIFICATIONS_SHARED_SECRET`
environment variable. Keep that value in platform secrets only; never commit it.

## SkyPulse Pro and Telegram Stars

The Weather tab includes a monthly **SkyPulse Pro** subscription. Free users get
current weather, today/tomorrow forecast, and standard three-hour notifications.
Pro unlocks an outfit suggestion, a 24-hour weather plan with a recommended window
for a trip or walk, plus important rain, wind, or thunderstorm warnings in the
notifications. The price defaults to 10 Stars per 30 days and can be changed with
`PRO_MONTHLY_PRICE_STARS`.

Invoices are created server-side and bound to the Telegram user who opened the Mini
App. The bot validates every pre-checkout request, then persists the paid access in
the Cloudflare D1 database. It also handles renewal and lets the user disable or
restore automatic renewal from the Mini App.

Before offering paid access publicly, configure `PAYMENT_SUPPORT_USERNAME` with the
Telegram username that will answer payment questions. The bot responds to
`/paysupport` and directs users there. Do not put payment keys or the notification
shared secret in source control.

For a one-time complimentary 30-day Pro period, set
`COMPLIMENTARY_PRO_USER_IDS` in Render to a comma-separated list of Telegram
numeric user IDs. The app sends the recipient a confirmation describing the Pro
features. Keep real user IDs in platform configuration rather than the repository.

If only a Telegram username is known, configure a pending gift with
`COMPLIMENTARY_PRO_USERNAME_GIFTS`. Use comma-separated `username:months` pairs,
for example `skyfriend:6`. Telegram does not disclose a private user's numeric ID to
a bot by username, so the gift is issued exactly once when that person next starts
or messages the bot. The recipient then receives the usual Pro confirmation from
the bot. Usernames are matched case-insensitively without `@`; keep this setting in
Render rather than the repository.

## Smart transport search

The Mini App shows departures for the next two hours in Grodno time. It switches to the weekend timetable on Saturdays, Sundays, Belarusian statutory non-working holidays (including Radunitsa), and officially transferred days off.

If an additional day is announced, set `BELARUS_WEEKEND_SERVICE_DATES` on Render as a comma-separated list. Entries use `YYYY-MM-DD` or `YYYY-MM-DD:reason`, for example:

```text
2027-05-10:перенесённый выходной день
```

## Trip planner

The Mini App also has an **«Откуда — куда»** planner for Grodno. It geocodes both
addresses, finds nearby bus and trolleybus stops, returns direct and one-transfer
options, and draws the fastest option on an OpenStreetMap map.

Travel time is deliberately shown as an estimate: it includes walking, an average
time between stops, and a normal waiting time. It is not presented as live vehicle
tracking or an exact departure prediction.
