---
name: Team page model and UX
description: How the Team (/my-tasks) page groups tasks, tracks hours, handles acknowledgement, and styles itself
type: project
originSessionId: dc23bf86-1afc-4379-814e-dfd86a818bb5
---
Authoritative reference for how the Team page (/my-tasks, labelled "Team" in sidebar) works after the Phase 1/2 rebuild.

## Three task types (visually separated in the personal view)

Tasks are grouped into three type sections on each person's personal view (labels in plain English after the visual revert):

1. **Mandatory Daily Tasks** — `taskType === 'Recurring'`. Auto-created at 8:45am weekdays by `createDailyRecurringTasks` (server.js ~3107). Per-role templates in `RECURRING_DEFS` (server.js ~2991). Hours logged. People currently in rotation: **Chris · Rena · Alex Mac · Salve · Teo Meei Haw · Jun Jie · Janessa**. No Alex Chew, no Murugan, no Senthil — deliberate (confirmed 2026-04-14).
2. **Requests From Team** — `taskType === 'Requested Task'`. One staff member asking another. `requestedBy` + `assignedTo` both set. **Hours NOT logged** — they don't count toward the assignee's own hour telemetry.
3. **Personal Tasks** — everything else (Self Task, Project Task, legacy types). Hours logged.

**Why:** boss wants clean hours data on where the assignee's OWN work goes — requested work is effort for someone else, not a category he's trying to benchmark.
**How to apply:** when adding anything that affects hours, remember to gate on `task.taskType !== 'Requested Task'`. When adding new task types, place them in one of these three buckets.

## Task status — Pending → Done only

"In Progress" and "Blocked" statuses were **removed**. The only two statuses are **Pending** and **Done**.
**Why:** boss wanted staff forced through "mark as seen" as the first action, not a soft "in progress" middle state that could be parked forever. Blocked was overhead — ops teams don't use the concept.
**How to apply:** never reintroduce "In Progress" as a UI button or status filter. Legacy data may still carry it — treat as Pending on render.

## Mark-as-Seen flow

- Button label is "Mark as Seen" (never "Acknowledge").
- Sets `acknowledgedAt` + `acknowledgedBy` on the task. Does **NOT** change status.
- Emails the requester (`task.requestedBy`) saying the task was seen. Subject `[Task Seen]`.
- Stops the ack reminder ladder.

## Ack reminder ladder (capped at 3 days)

- 9am weekday cron loops over tasks where `createdAt > 24hrs` and `acknowledgedAt` is null.
- Sends up to **3** reminders total, one per day. Counter in `task.ackReminderCount`.
- Day 1 + Day 2: email assignee, CC requester.
- Day 3 (`isFinal`): email assignee, CC requester **+ boss**. Subject `[FINAL FLAG] ...`. Sets `task.ackBossFlaggedAt`.
- Day 4+: no more reminders — the boss escalation IS the signal.

**Why:** boss said "that is huge flag if they don't use it" — 3 days of silence from an assignee is already the alarm, no point continuing to spam. The team page uses `ackBossFlaggedAt` to drive red LED indicators.

## Calendar integration

Every task with a `dueDate` creates a 30-minute Outlook calendar event at 9am SGT on the due date, via Graph API `/users/{email}/events`. Event id stored on `task.calendarEventId` + owner email on `task.calendarEventOwner`.

Lifecycle handled:
- create → event created
- reassign → old event deleted, new one created for new assignee
- dueDate change → delete + recreate
- mark Done → event deleted
- delete task → event deleted

`CALENDAR_TEST_OVERRIDE` env var routes every event to one mailbox (mirrors `EMAIL_TEST_OVERRIDE`) — must be set during pre-launch testing or real staff calendars get spammed.

## Visual aesthetic — plain / professional

Uses the app's default style.css tokens (`var(--bg2)`, `var(--border)`, `var(--text)`, `var(--accent)`, etc.). No special theming, no monospace labels, no themed color palette. Matches the rest of the app visually.

Labels are plain English:
- Team overview → "Team Overview"
- Cards → avatar + name + overdue/unseen pills + EOD ✅/⚠️ emoji badge (no station IDs, no LEDs)
- Personal view header → `{FirstName} — {done}/{total} done · {date}` with badges
- Sections → "Mandatory Daily Tasks" / "Requests From Team" / "Personal Tasks" (collapsible, each shows `N open · M done` counts)
- EOD → "End of Day Report" / "Submit EOD" / "Fill EOD Form"
- Task create button → "+ New Task" / "+ Add Task"

The three type-section split (Mandatory / Requests / Personal) is implemented via the `.mc-type-group*` CSS classes but styled professionally — the class-name prefix is a vestige, not a themed layer.

**Why:** a themed mission-control aesthetic (cyan/amber monospace, scan lines, LEDs, "STN-##" station IDs, NASA-speak labels) was tried and reverted. The boss prefers the app to look consistent across pages rather than one page being styled differently.
**How to apply:** when making UI changes on Team, use the same design tokens and plain English labels as the rest of the app. Don't reintroduce themed styling unless explicitly requested.

## Install-complete note automation (9am cron Check 5)

When a project's `installPercent` reaches 100% and `installCompleteTaskCreated` flag is not yet set, the 9am weekday cron creates ONE task for that project's assigned QS (`project.qs` — Salve or Alex Mac). The task is a **note**, not a claim trigger — wording: "Installation complete on [jobCode] — note for claim planning". Flag gets set on the project record so the task is never double-created.

**Why:** claims are time/phase-bound, not %-bound (see project_philosophy.md). But the QS should still be aware when install finishes so they can factor it into the next monthly claim cycle. This is a heads-up, not an automation trigger.

**How to apply:** don't repurpose this into "auto-create a claim". Don't add similar %-based triggers elsewhere. If the user asks for "auto-trigger on X%", remind them claims are phase-based and confirm before building.

## Manual seed endpoint

`POST /api/admin/seed-recurring-tasks` runs `createDailyRecurringTasks()` on demand. Same function the 8:45am cron calls. Idempotent — dedups by `assignedTo + title + today`. Use it to back-fill when tasks.json was wiped or to force-refresh after editing RECURRING_DEFS.

## Removed features

- **Ticket Task** type removed from the create modal (but `task.ticketId` field still accepted server-side in case it's re-enabled later).
- **In Progress** status removed from UI.
- **Blocked** status removed from UI.
- **7pm EOD re-reminder cron** removed (6pm + 6:30pm flag to boss is enough; 9am next-day re-alert handles catch-up).
