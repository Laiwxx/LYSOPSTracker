---
name: system philosophy and architecture principles
description: Non-obvious architectural principles for ops-tracker — what the app is replacing, who owns which page, and the single-source-of-truth rule
type: project
originSessionId: 4f0102b2-2b4d-4bce-a544-be0d6b8499f2
---
The app replaces email chains, WhatsApp groups, Excel trackers, paper PR forms, and verbal EOD reports. Everything lost in those channels should become data in the app — with audit trail (`data/activity.log`) and uploads that can be viewed/deleted, so accountability is data-driven without micromanaging.

**Why:** without this, the boss spends his day chasing people ("did Rena order it?", "did Chris start fab?", "is install on track?"). The app should make answers visible without asking.

**How to apply — the "one role, one page" rule:**
- `/factory` is Chris's world. Source of truth for fabrication progress (qty + per-item stages). Manpower/transport/delivery/collection he needs today should surface here.
- `/installation` is Teo/Jun Jie's world. Source of truth for install progress. Site engineer assignment from the project Info tab should filter this page.
- `/procurement` is Rena's world. PR → PO → delivery pipeline. Price book lives here.
- `/planning` is Chris's weekly manpower planning. Should auto-populate last-week-as-starting-point.
- Claims are **time/phase-bound, not %-bound**. Projects claim **monthly** based on construction phasing, not when install hits 100%. The `installPercent` field exists for visibility only — it is NOT a claim trigger. Do not build "auto-create claim when install=100%" logic. Claim numbers are running numbers, editable by the QS.
- Claim reminders (1 week / 3 days / past-deadline) go to the **project's assigned QS** (per-project `qs` field — Salve or Alex Mac, one per project), CC the boss only. Alex Chew is NOT on the cert-stage CC list — she's finance, she only enters the flow at invoice stage.
- `/project.html` is the boss's view — read-only for fabrication/installation tabs (shows what the ops tabs captured). Product Scope is the *start* of the funnel and auto-populates Chris's FAB queue.

**Consequence:** any "sync" work should flow FROM the four ops pages TO the project record, never the other way. `deriveFields()` in `server.js` is the correct place for server-side auto-computation. Don't scatter recompute logic across routes.

**Construction domain note:** Before physical installation, projects go through an architectural/drawing/material-submission phase. The 21 project stages exist to capture this; fab/install pipelines on the Overview tab capture the physical-work phase. Both matter but they are separate concepts — don't conflate "project stages" (21 lifecycle steps) with "per-item stages" (fab 5-chip / install 4-chip pipelines). They are different layers.
