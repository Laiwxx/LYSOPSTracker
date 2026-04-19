---
name: Page-by-page sweep status
description: Which pages have been audited and fixed — updated 2026-04-19
type: project
originSessionId: dc1ba73a-2f84-41fa-8970-3c7921fe2ab5
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

## Cross-cutting (2026-04-19)
- 1000-scenario audit: 945/977 pass, 5 validation bugs fixed
- Delete reason modal on all user-facing deletes (confirmDelete in utils.js)
- Per-project upload directories (public/uploads/projects/<id>/)

## Pending
- Dashboard — not audited
- Admin — not audited
