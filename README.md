# SkyPulse Weather Bot

Telegram bot with weather, outfit advice, and Grodno public transport schedules.

## Smart transport search

The Mini App shows departures for the next two hours in Grodno time. It switches to the weekend timetable on Saturdays, Sundays, Belarusian statutory non-working holidays (including Radunitsa), and officially transferred days off.

If an additional day is announced, set `BELARUS_WEEKEND_SERVICE_DATES` on Render as a comma-separated list. Entries use `YYYY-MM-DD` or `YYYY-MM-DD:reason`, for example:

```text
2027-05-10:перенесённый выходной день
```
