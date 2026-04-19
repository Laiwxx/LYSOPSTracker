---
name: Parts/BOM feature design
description: Mechanical items have sub-parts (Fabricate/Order) that must all be ready before parent item can proceed to assembly. Parts show on Factory page for Chris visibility.
type: project
originSessionId: f4b5947b-4ebb-4ca0-b81e-82ca83e07e3d
---
## Design: Parts/BOM for Mechanical Items

### Concept
- Fixed items: 1 scope item → 1 fab row (no change)
- Mechanical items with parts: 1 scope item → 1 parent fab row + N child fab rows (for Fabricate parts) + Order parts visible read-only

### Data model
- `productScope[].parts[]` = `{ name, qty, source ('Fabricate'|'Order'), status ('Pending'|'Done') }`
- Source=Order parts: status managed manually on Project Info (boss ticks done when arrived)
- Source=Fabricate parts: become real fab rows, Chris logs against them
- Parent fab row: `isMechanicalParent: true`, status auto-derived from parts
- Child fab rows: `parentIdx: <index of parent>`, Chris works on these normally

### Parent status derivation
- All parts pending → "Parts In Progress"
- All Fabricate parts done + all Order parts done → "Assembly" (Chris can now assemble)
- Chris logs assembly → same flow as Fixed: QC Check → Ready for Delivery → Delivered

### Factory page visibility
- Chris sees child fab parts as workable items
- Chris sees Order parts as read-only (just for awareness — his KPI depends on whole set)
- Parent item shows parts progress "3/5 ready"

### What Sync does
- Fixed items: same as today
- Mechanical+parts: creates parent fab row + child fab rows for Fabricate parts. Skips Order parts from fab.
- Order parts only appear on Factory page via the queue API (merged at read time from productScope)

### Decided 2026-04-19
- No auto-PR creation for Order parts (Rena decides when to raise PR)
- Install row stays as 1 per parent item (install the whole thing)
- Build checklist first, validate, then upgrade if needed
