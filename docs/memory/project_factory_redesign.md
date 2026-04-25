---
name: Factory page redesign — port complete, follow-ups deferred
description: Salesforce-inspired Factory page redesign. Preview at public/factory-preview.html; port to live factory.html complete as of 2026-04-25. 5 follow-up enhancements proposed but not built.
type: project
originSessionId: 820a213b-31d4-4e6d-998f-274d758a9c5e
---
**Status as of 2026-04-25: port complete and live.** Earlier memory said the port was incomplete — that was stale. Verification on 2026-04-25 confirmed live `public/factory.html` has 47 of 48 `fx-*` classes from the preview, with KPI strip, alert banner, multi-product job grouping, section accent bars, and one-status-vocabulary dots all in place.

**Reference files:**
- `public/factory-preview.html` (1040 lines, mock data, blue PREVIEW ribbon) — kept as design reference / staging ground for future iterations. Do not delete.
- `public/factory.html` (~4750 lines, live).

**User approved the preview.** Key design choices already committed in the preview file:
- **No emoji anywhere.** Replaced with monotone Lucide-style SVG icons + 3px colored vertical accent bars per section.
- **Top KPI strip:** 5 cards (Site Requests, In Queue, Workers Today, Open DOs, Material Reqs). Site Requests promoted to position #1 with red `.fx-kpi.critical` left-bar.
- **Critical alert banner:** Red gradient banner above KPIs that only renders when something's overdue ("1 site request overdue · 1 build overdue") with "Review now" CTA.
- **Section header chips:** "Site Requests · 3 pending · 1 overdue" — colored pills for state at a glance.
- **One status vocabulary:** green/amber/red/blue dots (`.fx-dot`) used identically across all 5 sections.
- **Job code pill (`.fx-jobcode`)** is the lead element on every row — monospaced, color-coded, ~62px min-width, sits left of item description. User explicitly flagged: "the job code is very important for information."
- **Multi-product job grouping** (`.fx-group-hdr` + `.fx-row.sub`):
  - Job header row with single job-code pill + client name + status chip summary ("1 overdue · 1 due today · 1 on track")
  - Indented sub-rows for each product, connected by faint tree-line connector (`::before` + `::after`)
  - Sub-rows have NO repeated job pill (saves visual noise)
  - Single-product jobs stay as flat rows (no header)
- **Section order:** Priority Queue → **Site Requests** (promoted) → Manpower → DOs → Material Requests
- **DO cards:** dashed-border upload zone, thumbnail grid with PENDING/MATCHED badges, job code pill in card header

**Why:** User wanted "easier but complex" feel — Salesforce-style without losing density. Stays on **ops navy/blue palette** (NOT Sales SF-blue) since this is an ops page.

**Backend audit done — zero backend work needed for the port:**
- `/api/factory-queue` already returns `[{jobCode, projectName, endDate, items: [{description, doneQty, totalQty, fabPct, targetDeliveryDate, isOverdue, neededByDate, logs, partsProgress, isMechanicalParent, status}]}]` — exactly the shape the new UI needs.
- `/api/site-requests` has `neededByDate`, `urgency`, `projectJobCode` already.
- All KPIs derivable from existing endpoints.

**Two known graceful-degradation gaps (NOT blockers):**
- **Per-item QC assignee:** No field on fab items. Fall back to `project.siteEngineer` (same person anyway in practice).
- **Fab-item ↔ PR/DO link:** PRs/DOs link to projects, not items. Detail drawer's "linked PRs/DOs" section starts with project-level filter (coarser but functional). Finer link is a small backend addition for later.

**Daily-log flow with mandatory photos is load-bearing — must keep working identically during port.** Don't restructure for tidiness; only delete provably-unreachable code.

**How to apply:**
- When user is ready to resume: re-dispatch the ui-designer agent with the same brief (port preview to live using `/api/factory-queue` + `/api/site-requests`, preserve every existing handler/modal/upload, degrade gracefully for missing fields, keep `factory.html` as the file).
- Keep `public/factory-preview.html` as the reference / staging ground — don't delete it after the port; useful for iterating without touching live.
- After port: run `node tests/scenario-test.js` (must pass 0 failures), test on Chris's phone.
- If user later wants more: 5 follow-up enhancements were proposed and not built (1: tap-row → item detail drawer with photos+logs+linked PRs/DOs — biggest depth upgrade. 2: camera-first "Log build" on mobile. 3: forecast strip Today/Next3/Week. 4: search + filter chips. 5: empty states + skeleton loaders).
