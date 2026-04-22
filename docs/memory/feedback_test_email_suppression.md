---
name: Suppress emails from test accounts
description: sendEmail() and createTaskCalendarEvent() skip when actor is 'Scenario Tester' — prevents test runs from emailing real staff
type: feedback
originSessionId: ed57ab64-2d25-4376-af42-d133a30aa47a
---
`sendEmail()` and `createTaskCalendarEvent()` both check `getAuthUser() === 'Scenario Tester'` and bail early if true. This prevents scenario test runs from firing real emails and calendar events to staff.

**Why:** App is now live. Running `node tests/scenario-test.js` was sending real emails to staff because EMAIL_TEST_OVERRIDE env var was never set in systemd. Instead of relying on env vars, the guard is now built into the functions themselves.

**How to apply:** If adding new notification functions (SMS, Slack, etc.), add the same `Scenario Tester` check at the top. The test account name is hardcoded in `tests/scenario-test.js` as `TEST_NAME = 'Scenario Tester'`.
