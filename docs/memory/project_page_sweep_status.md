---
name: Page-by-page sweep status
description: Which pages have been audited and fixed — updated 2026-04-20
type: project
originSessionId: afbc3daa-39c7-4fe3-8fb0-04c02f1b5d12
---
## All Project Tabs — DONE (2026-04-19)
1. Summary — stages auto-derived from live data
2. Project Info — Parts/BOM, free-text units, sync bugs fixed
3. Documents — nested sub-folders, blank slate, file cleanup on delete
4. Drawings — nested sub-folders, list layout, per-project upload dirs
5. Fabrication — read-only enforced, fabPercent excludes parents, 299 lines dead code removed
6. Installation — doneQty/qtyDone unified, drag-drop removed
7. Delivery — urgency badge, orphan SR cleaned
8. Payment — claim notes preserved on "Paid" status change
9. Meetings — clean
10. History — field name crash fixed (event/ts vs action/timestamp)

## New Project — DONE (2026-04-19)
20-stage template, role-based defaults from staff.json, client/mainCon/consultant fields, deriveFields on create

## Ops Pages — stable (2026-04-18)
- Factory, Installation, Procurement, Manpower, Team, Feedback, Attendance

## Dashboard — AUDITED (2026-04-20)
- Refresh button fix (IIFE scope → global exposure)
- KPI grid mobile breakpoint (2×2 at ≤640px)
- `var(--blue)` → `var(--accent)` token fix

## Admin — AUDITED (2026-04-20)
- Login gate redesigned (full-screen centered, proper hierarchy)
- Staff/Workers/Activity sections not changed (clean)

## Cross-cutting (2026-04-20)
- Full 4-agent audit: backend, frontend, data, UI/UX
- 6 server bugs fixed, 9 delete policy violations fixed
- Crash email rate limit + SIGTERM handler + systemd hardening
- Port collision safety net (`_server.on('error')`)
- confirmDelete now on all delete actions across all pages
