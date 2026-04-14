---
name: team members and their roles
description: Who is who on the ops-tracker team — use when wiring emails, filters, assignments, or test data
type: project
originSessionId: 4f0102b2-2b4d-4bce-a544-be0d6b8499f2
---
- **Chris** — Factory manager. Lives in `/factory` and `/planning`. Owns fabrication progress, weekly manpower plan, deliveries from factory.
- **Teo**, **Jun Jie** — Site engineers. Live in `/installation`. Need to be filterable by project assignment so each sees only their projects.
- **Rena** — Purchaser/procurement. Lives in `/procurement`. Owns PRs, POs, supplier relationships, price book.
- **Alex Chew** — Finance manager / accounts. Owns **invoice stage onwards** (invoice → payment tracking). NOT involved in certification reminders — do not CC her on SOP / cert-deadline emails. She only enters the flow once a claim is certified and ready to invoice.
- **Salve** and **Alex Mac** — QSs. Two of them, and they **each own different projects** (not shared). Each project has a single `qs` field; claim cert reminders must go to that project's assigned QS, not both. They own everything from claim submission up to certification; after cert, Alex Chew takes over.
- **Janessa** — Sales. Stage 1–2 owner (Quotation, Awarded).
- **Murugan** — Drafter. Drawing Submission/Approved stages.
- **Lai Wei Xiang** — Project Manager / boss / the user. Dashboard is his morning briefing.

**Why:** email notifications, role-based filters, and stage ownership labels all reference these names; getting them wrong breaks accountability flows.
**How to apply:** when touching email routing, assignment filters, or test data, pull the actual name from this list rather than guessing.
