---
name: Test email suppression (live mode)
description: App is live — test emails suppressed via Scenario Tester check in sendEmail/calendar, not env vars
type: project
originSessionId: ed57ab64-2d25-4376-af42-d133a30aa47a
---
App is now **live** (as of 2026-04-22). The old EMAIL_TEST_OVERRIDE / CALENDAR_TEST_OVERRIDE env vars are **no longer used**.

Instead, `sendEmail()` and `createTaskCalendarEvent()` both check `getAuthUser() === 'Scenario Tester'` and return early. This means:
- Running `node tests/scenario-test.js` never sends real emails or creates calendar events
- Real staff actions send real emails as expected
- No env vars to manage

**Why:** Boss confirmed app is live, no longer in testing mode. Env vars were never set in systemd anyway, so test runs were accidentally emailing real staff. The in-code guard is more reliable.
