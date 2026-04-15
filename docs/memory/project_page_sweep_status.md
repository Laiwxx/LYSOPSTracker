---
name: Page-by-page pre-launch sweep status
description: Which pages have been bug-swept vs. still pending, so sessions don't re-audit stable pages
type: project
originSessionId: 3982e62d-8a2e-4377-ad60-766b73859530
---
Lai is doing a page-by-page pre-launch sweep of ops-tracker. Track which pages are considered stable so future sessions don't re-open settled work.

**Why:** he scopes work by page, not by feature, and wants to close pages one at a time before launch. Re-auditing a "done" page wastes tokens and risks regressions.

**How to apply:** before diving into a page, check this file. If it's listed as stable, ask before re-auditing. If it's on the pending list, that's fair game.

## Stable as of 2026-04-15
- **Team page** (`/my-tasks`, public/my-tasks.html) — swept 2026-04-15 via senior-engineer + direct fixes. Closed: ghost-task validation (blocked save w/o assignee), double-submit guard, fetch error handling w/ alert-on-failure, self-email + self-calendar skip when createdBy===assignedTo, sendEmail 429 retry w/ Retry-After + exponential backoff, morning briefing serialized (was Promise.all → throttled), new "Requests You Sent" section w/ Awaiting/Seen/Done pills. Treat as locked unless Lai reports a new bug.

## Pending (not yet swept)
- Dashboard (`/` index.html)
- Factory (`/factory`)
- Installation (`/installation`)
- Procurement (`/procurement`)
- Manpower (`/planning`)
- Attendance (`/attendance`)
- Admin (`/admin`)
- New Project (`/new-project`)
- Project (`/project` — read-only consolidation)
- Tasks (`/tasks` — global board)
- Feedback (`/feedback`)

## Deferred cross-cutting
- **Email HTML template refactor** — explicitly deferred to the LAST polish pass, after all pages are stable. Consolidate the ~8 inline templates in server.js into one `renderEmail({title, rows, ctaUrl, ctaLabel})` helper. Don't touch email HTML mid-sweep — any logic change re-churns the template.
- **Senior-engineer review leftovers on Team page** (minor, not blockers): #7 background /api/staff refresh clobbers nt-requested-by, #9 server-side taskType whitelist, #8 tags array sanitization, #11 client 'Medium' vs server 'Normal' priority default mismatch. Pick up during the final polish pass.
