---
name: Page-by-page pre-launch sweep status
description: Which pages have been bug-swept vs. still pending, so sessions don't re-audit stable pages
type: project
originSessionId: ac003d06-ee3e-4b9d-bdd5-1ef224590e88
---
## Stable pages (8 of 12)

### Team page — swept 2026-04-15
Locked.

### Factory page — audit complete 2026-04-18
Role-based names, timeline bands, fabDeadline, DO→PR workflow, daily logs, arrival confirmation, full security audit.

### Installation page — audit complete 2026-04-18
Install logging with mandatory photos + free-text steps, Confirm Received workflow, QS email on progress, install-progress API, security audit.

### Procurement page — audit complete 2026-04-18
Kanban board, View modal with editable PO + PDF upload, DO photos on cards, delivery emails to Purchaser + CC Finance, arrival from factory DO, PRs cleared for launch.

### Manpower page — audit complete 2026-04-18
- X button inline delete with debounced auto-save
- OT tracking: per-assignment hours, monthly total, amber 60h / red 68h MOM cap
- Saturday = full OT (8h default), weekdays = after 5:30pm, supply workers excluded
- Supply workers: amber badge, company name, no OT
- Transport: auto-suggest trips from installation assignments, worker list from manpower plan (attendance dependency removed)
- MC now saved directly in plan (attendance auto-apply removed — fixed Jayabalan Ramesh ghost MC bug)
- Dashboard OT box added
- OT summary API: GET /api/manpower-plan/ot-summary

### Feedback page — audit complete 2026-04-18
Clean. Viewport fixed. Feedback auto-writes to Claude memory as MD files. Resolved tickets auto-delete memory.

### Attendance page — SKIPPED
Manpower plan handles MC/Off directly. Attendance page is redundant.

### Tasks page (/tasks) — SKIPPED
Global board view of Team page data. Boss uses /my-tasks (Team page) instead.

## In progress

### Project page — STARTED 2026-04-18 (not yet complete)
- Fab tab made read-only (all inputs disabled, edit buttons hidden) — kills dual-path qtyDone bug
- Install tab made read-only with photo count per item
- Sidebar: search input added, full project names shown (no truncation)
- **Still pending:**
  1. Claims tab: link to install-progress API, show photo evidence, installLogIds
  2. Claims edit capability (currently create + status change only, no edit)
  3. Install tab: drill-down into log photos (currently just shows count)
  4. Payment milestones vs claims confusion — consolidate into one model
  5. Full security audit of project.js
  6. Mobile layout check

## Pending (not yet swept)

### Dashboard — partially done
- OT box added, sidebar search added, full project names
- Rest of dashboard not audited (project cards, charts, weekly brief)

### New Project — not swept
- Project creation form, needs endDate validation

### Admin — not swept
- Staff management, PIN settings

## Cross-cutting (completed 2026-04-18)
- Security: mass-assignment whitelisted on 5 PUT routes (projects, tasks, claims, workers, POs)
- XSS: escHtml on all email templates (8+)
- POST /api/staff requires PIN
- logActivity on 10+ routes
- Email stagger 2s in all batch crons
- Backup cron: daily 3pm SGT (/home/ubuntu/backup-ops.sh)
- RECURRING_ROLE_DEFS: role-based, no hardcoded names
- suppliers.json seeded
- Dead /api/purchase-orders routes flagged for removal

## Deferred
- Email HTML template refactor — LAST polish pass
- Rate limiting on ~25 routes (functional behind basic auth)
