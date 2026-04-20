---
name: Full codebase audit — Apr 20
description: Comprehensive 4-agent audit covering backend, frontend, data, UI/UX — bugs found and fixed
type: project
originSessionId: afbc3daa-39c7-4fe3-8fb0-04c02f1b5d12
---
Ran 2026-04-20. Four parallel agents audited server.js, all 12 HTML pages, all data/config JSON, and UI/UX consistency.

**Server bugs fixed:**
1. `DELETE /api/purchase-orders/:id` missing try/catch — server crash on any error
2. `hoursLogged.push()` crash on legacy tasks missing the array (2 places)
3. Log rotation month calc wrong — Jan 1 produced `2026-00` instead of `2025-12`
4. `people is not defined` in daily recurring cron — should be `roles`
5. Path traversal in doc/drawing file delete — added resolve() guard
6. Missing `escHtml()` in 4 email templates (task creation, ack, reminders)

**Infrastructure fixed:**
- Crash email flood: rate limit persisted to disk (`.last-crash-email-ts`), survives restarts
- SIGTERM handler: `systemctl restart` exits cleanly, no crash email
- Systemd: `StartLimitBurst=5`, `TimeoutStopSec=10`, `KillMode=mixed`
- Port check: `_server.on('error')` catches EADDRINUSE with clear hint message

**Frontend fixed:**
- Dashboard refresh button called IIFE-scoped functions — exposed to global
- 9 delete policy violations fixed (confirm → confirmDelete with reason)
- Dashboard KPI grid mobile breakpoint added
- `var(--blue)` → `var(--accent)` token fix
- Admin login page redesigned (full-screen centered gate)

**Not fixed (test data, will be wiped):**
- 140 tasks missing `type` field, 5 garbage test tasks, corrupt attendance records
- staff.json sync gap, missing emails for Murugan/Senthil
- tasks.html is dead/unlinked — vestigial page

**Why:** Pre-launch audit to catch everything before go-live.
**How to apply:** This supersedes the 1000-scenario audit as the latest baseline.
