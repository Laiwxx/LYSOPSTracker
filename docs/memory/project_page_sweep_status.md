---
name: Page-by-page pre-launch sweep status
description: Which pages have been bug-swept vs. still pending, so sessions don't re-audit stable pages
type: project
originSessionId: ac003d06-ee3e-4b9d-bdd5-1ef224590e88
---
## Stable pages

### Team page — swept 2026-04-15
Locked unless boss reports a new bug.

### Factory page — audit complete 2026-04-18
Role-based names, timeline bands, fabDeadline, DO→PR linked workflow, daily logs, full security audit passed.

### Installation page — audit complete 2026-04-18
Install logging with mandatory photos + steps, Confirm Received workflow, QS email on progress, install-progress API for claims, dynamic engineer dropdown, security audit passed.

### Procurement page — audit complete 2026-04-18
- Kanban board layout (Action Needed / Tracking / Done columns)
- View modal = single detail screen with editable supplier/PO/ETA/prices + PO PDF upload
- DO photos shown on PR cards, DO upload emails Purchaser + CC Finance
- Delivery-complete emails Purchaser + CC Finance (not Factory Manager — Chris receives, Rena tracks)
- Arrival confirmation on factory DO upload (Chris confirms qty at point of receipt)
- PR search, staged process (save any field independently), urgent sort
- Dead Process modal removed, all PRs cleared for fresh launch start
- Security: double-click guards on all 7 save/delete functions, email HTML escaping

### Cross-cutting security audit — 2026-04-18
- Mass-assignment fixed on 4 PUT routes (projects, tasks, claims, workers) — all whitelisted
- XSS fixed in 6 email templates (remind, project delayed, task assignment, task status, PR created, PO created)
- POST /api/staff now requires admin PIN
- logActivity added to 8 routes (project create/update, task update/ack/hours/delete, claim update, staff update)
- Email send stagger: 2s delay between sends in all batch crons (was 400ms, hitting Graph 429)
- Backup cron set: daily 3pm SGT via /home/ubuntu/backup-ops.sh
- suppliers.json seeded

## Pending (not yet swept)
- Dashboard (`/` index.html)
- Manpower (`/planning`)
- Attendance (`/attendance`)
- Admin (`/admin`)
- New Project (`/new-project`)
- Project (`/project` — read-only consolidation + milestone/claim UI for QS)
- Tasks (`/tasks` — global board)
- Feedback (`/feedback`)

## Deferred
- Email HTML template refactor — LAST polish pass
- Dead `/api/purchase-orders` routes — remove during cleanup
- Rate limiting on ~25 routes (functional behind basic auth)
- Non-atomic writes on 5 config files (low frequency)
