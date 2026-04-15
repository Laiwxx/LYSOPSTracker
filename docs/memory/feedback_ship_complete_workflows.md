---
name: Ship complete workflows, not just the happy path
description: Every create/write action must ship with its undo/edit/delete path at the same time. A feature without its reverse is a half-shipped feature, not a shipped feature.
type: feedback
originSessionId: a678a956-df23-4faa-96a0-728907c543c9
---
When shipping a create/write action, the edit + delete + undo paths MUST ship in the same bundle — not as a "Phase D" follow-up. Users making mistakes is the common case, not the edge case. A create-only flow is worse than no flow because it trains the user to distrust the tool.

**Why:** 2026-04-15 Phase C Factory daily-log model. I shipped the "Log today's build" modal without edit/delete UI. Plan was to defer the edit path to Phase D. Boss caught it mid-ship: *"did you consider if chris make a mistake, how does he edit it?"* He was right. The feature was broken-by-design: Chris would fat-finger +30 instead of +3 and have no way to fix it. Server routes (PUT/DELETE log entries) were already in place from Phase A — the gap was purely that I didn't wire them into the UI before calling Phase C done.

**How to apply:**
- **Before marking any "create" flow as shipped, check:** can the user edit what they just created? can they delete it? If either answer is no, the flow is not shipped.
- **The question to run every time:** "If the user fat-fingers this, what do they do next?" If the answer is "call Claude" or "give up and live with bad data," stop and add the edit path.
- **Same-day vs historical edits:** for fast-moving operational data (daily logs, counts, status changes), same-day edit is the hot path and MUST ship with create. Historical edit (past days/weeks) is the cold path and CAN defer to a later polish pass IF the same-day case is covered.
- **Audit/history preservation is not a substitute for undo.** Preserving `editHistory[]` on the server is good for accountability, but that's about *who* changed what. It doesn't help the user who made the typo 30 seconds ago.
- **Phases should slice by layer (data → plumbing → UX), not by CRUD verb (create, then edit, then delete).** "Phase C ships create, Phase D ships edit" is a scoping smell. Re-slice so each shipped UX bundle is complete in its own right.
- **The server can be ahead of the UI, but never the other way around.** Server supporting PUT/DELETE without a UI trigger is fine (harmless, reversible). A UI that creates things it can't edit is not fine.
- **Apply to all flows, not just logs:** site-request creation needs edit/delete in the same bundle, manpower assignments need reassign/remove, task creation needs edit/delete, etc. This is a universal rule, not a Factory-page-specific one.
