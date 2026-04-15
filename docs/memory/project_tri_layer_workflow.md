---
name: Fab → Site-request → Install tri-layer workflow
description: How fabrication, site requests, and installation layer together in the real business — critical for any Factory/Installation/Project page work
type: project
originSessionId: 3982e62d-8a2e-4377-ad60-766b73859530
---
The ops-tracker app has to model three DIFFERENT progressions for the same item on the same project, running concurrently, not sequentially. Missing this produces naive models that break in week 2.

**Why this matters:** Lai corrected my model twice in one session (2026-04-15). I was about to ship "delivered = done" and he pushed back with "even installation takes time to install, so a lot of sequencing in real life." The lesson: fab → delivery → install is not a waterfall on this business.

**How to apply:** whenever working on Factory, Installation, or Project pages — especially on data model or progress-tracking changes — remember that a single item lives in THREE separate progressions at once, and the UX must let Chris + Teo + boss see "where is it right now" across all three.

## The three layers

1. **Fabrication** (`project.fabrication[]`, owned by Chris on Factory page)
   - `totalQty` = quoted qty for this item on this project
   - `qtyDone` = how many units the factory has BUILT so far
   - Advances as Chris fabricates, never waits for site to be ready

2. **Site-requests** (`site-requests.json`, raised by Teo/Jun Jie on Installation page)
   - A **pull signal from site**, not a push from factory
   - Site says: "I need N of this item by X date for phase Y" — can be smaller than full qty, phased
   - Chris responds: Acknowledged → Ready → Delivered → (optionally Issue)
   - Multiple SRs against the same fab item over the life of a project (tranches)

3. **Installation** (`project.installation[]`, owned by Teo/Jun Jie on Installation page)
   - `totalQty` = quoted qty (same as fab row)
   - `qtyDone` = how many units have been INSTALLED on site
   - Advances independently of fab — installation takes time too, even after arrival

## Why fab ≠ delivery ≠ install

- Fab finishes → items sit on factory floor (qtyDone > qtyShipped)
- SR Delivered → items on site but not yet installed (qtyShipped > qtyInstalled)
- Install in progress → items finally in the wall (qtyInstalled < qtyShipped < qtyDone)
- All three can be moving concurrently on different slices of the same 103-unit batch

## Derived metrics (compute, don't store)
- `qtyShipped` for a fab row = sum of Delivered SRs linked to that fab row
- `qtyOnFloor` = qtyDone − qtyShipped (built but not shipped yet)
- `qtyOnSite` = qtyShipped − qtyInstalled (delivered but not installed yet)

## What this rules out
- ❌ Single-progression "% complete" bars that collapse fab+deliver+install into one number
- ❌ Auto-advancing fab status when SR goes Delivered (fab is independent)
- ❌ Auto-closing SRs when install completes (SRs are DOs, not install receipts)
- ❌ `readyForDelivery` booleans on fab rows (always lies on partial batches — use SRs instead)
- ❌ Project-page-pushed "delivery requests" (`project.deliveryRequests[]` is the v1 model — backwards; site-requests are the v2 model and match reality)

## Linking the layers (needed, not yet shipped)
- `fabIdx` on site-request → links SR to the fab row it pulls from. Without this, layer 1↔2 matching relies on fragile item-name string compare.
- Possibly `fabIdx` on install row too → links install progression to the same fab row. Match layer 1↔3.
- Untracked SRs (e.g. Teo typed a custom item name not on the fab list) exist and are valid — just don't decrement derived counts.

## Scale reality
- ~8 staff, 1–6 concurrent projects, batches of 20–200 per item
- Not an MES/ERP. Don't build travelers, routing, per-piece scan. Chris is a factory manager, not a data-entry clerk.
- The tri-layer model is the minimum viable truth, not a maximum.
