---
name: Pre-launch test gates
description: Env vars that keep emails and calendar events routed to boss only during pre-launch testing
type: project
originSessionId: dc23bf86-1afc-4379-814e-dfd86a818bb5
---
While the app is in pre-launch / beta, two env vars route all outbound side effects to the boss so real staff aren't spammed:

- **`EMAIL_TEST_OVERRIDE`** — every email sent via `sendEmail(...)` gets its `to` swapped to this address and its CC list dropped. Set to `laiwx@laiyewseng.com.sg`.
- **`CALENDAR_TEST_OVERRIDE`** — every Outlook calendar event created via `createTaskCalendarEvent(...)` goes to this mailbox instead of the real assignee. Subject is prefixed `[TEST — would go to ...]` and a yellow banner is injected into the event body so it's obvious. `task.calendarEventOwner` stores the override mailbox so future deletes/updates target the right calendar. Set to `laiwx@laiyewseng.com.sg`.

Both live in `/home/ubuntu/ops-tracker/.env`. To go live with real staff, **delete both lines and restart the server** (`bash /home/ubuntu/restart-app.sh`).

**Why:** missing these checks during a previous email leak got real staff in a past project — the spec now is that nothing goes out to real people until the boss explicitly pulls the gate.

**How to apply:** before suggesting "just test by creating a task", verify the test gates are still in `.env`. If a user asks to "try it for real", confirm explicitly before unsetting either variable.

## Also note
- Shared pre-launch Basic Auth is configured via `BASIC_AUTH_USER` + `BASIC_AUTH_PASSWORD` env vars in `.env`. Applies to every route. The literal credentials are kept out of memory (see `.env` on the server). Swap them before sharing the URL widely.
- `data/tasks.json` was wiped to `[]` at launch time. Backup: `data/tasks.json.bak.20260414-153324`.
