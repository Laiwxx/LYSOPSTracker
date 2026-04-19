---
name: 1000-scenario audit results
description: Full system audit ran 977 scenarios across 17 categories — 945 pass, 5 bugs found and fixed
type: project
originSessionId: dc1ba73a-2f84-41fa-8970-3c7921fe2ab5
---
Ran 2026-04-19. 977 scenarios across all 80+ API routes, 9 pages, security, concurrency, data integrity.

**Result:** 945 pass (96.7%), 32 fail (5 real bugs, rest test-script issues or PIN-gated).

**5 bugs fixed in server.js:**
1. Attendance POST accepted invalid status values → now rejects 400
2. Site request POST accepted missing projectId → now requires it
3. Site request POST accepted invalid urgency → now validates Normal/Urgent
4. Project PUT accepted endDate < startDate → now rejects 400
5. Rate limiter bypassed by concurrent bursts → fixed entry initialization

**Data integrity verified:** All 17 projects clean — no orphaned fab children, no qtyDone > totalQty, no invalid statuses, fabPercent/installPercent 0-100, recalc idempotent, fab log sums match qtyDone.

**Why:** Baseline for production readiness. Re-run after major changes.
**How to apply:** Keep audit script at /tmp/ops-audit2.js pattern for future runs.
