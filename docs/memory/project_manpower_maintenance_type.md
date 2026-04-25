---
name: Manpower has 5th worker-type "Maintenance" (purple)
description: Maintenance worker-type added to Manpower page on 2026-04-24 for workers doing workshop cleanup / tool servicing. Behaves like Fab/Install/Driver (OT enabled, Saturday auto-OT) but no project picker. Dedicated Maintenance page is queued — to be built after Sales CRM.
type: project
originSessionId: 820a213b-31d4-4e6d-998f-274d758a9c5e
---
As of 2026-04-24, the Manpower page (`public/planning.html` — labelled "Manpower" in sidebar) has a 5th worker-type alongside Fabrication, Installation, Driver, and MC/Off.

**Type:** `Maintenance` — purple `#a855f7` accent, 🛠 icon (kept inside Manpower despite the no-emoji rule for Factory; Manpower's existing types use emoji).

**Behavior in the assignment popup:**
- Type button + Quick Assign dropdown option both wired
- Project picker hidden (like MC/Off) — no project required
- Notes field labelled "Maintenance details (e.g. workshop cleanup, tool servicing)"
- OT enabled (like Fab/Install/Driver — it's physical work)
- Saturday assignment auto-treats whole day as OT

**Visual:**
- `.dot-maintenance` (purple), `.chip-maintenance` (purple bg+border+text), `.type-btn.sel-maintenance` for selected popup button
- Summary stat counter `#stat-maintenance` between Driver and MC/Off in the summary strip
- Grid chip label: "🛠 Maint"

**Side-fix made during this work:** Old type-style map pointed Driver at non-existent `sel-driver` class. Fixed Driver → `sel-maint` (orange, matching its existing chip color). Maintenance now uses the new purple `sel-maintenance`.

**Data already captured:** Entries land in `data/manpower-plans.json` as `{type: 'Maintenance', notes, otHours}` records. Consumed by existing read APIs.

**Why:** User has workers in maintenance work (workshop cleanup, tool servicing, equipment repair) that don't fit Fab/Install/Driver but aren't MC/Off either. Wanted to capture the assignment now and build the dedicated tracking page later.

**How to apply:**
- Dedicated **Maintenance page is queued AFTER Sales CRM build is complete.** Don't pre-build it; data is already being captured cleanly.
- When building the Maintenance page: query `data/manpower-plans.json` for `type === 'Maintenance'`, group by worker × week, surface notes for what was done.
- Don't propagate purple color anywhere else in ops — it's the Maintenance signature now.
