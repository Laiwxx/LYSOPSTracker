---
name: Prefer specialist sub-agents for validation work
description: User wants Claude to default to spawning specialist sub-agents (debugger, senior-engineer, etc.) for any "check / validate / find bugs" task instead of doing it solo
type: feedback
originSessionId: a4d1b6bc-a0a2-4a36-86ef-e76abb7d4fa4
---
When the user asks Claude to **check, validate, audit, or find bugs/API errors** in code, default to spawning the relevant specialist sub-agent (`debugger`, `senior-engineer`, `ui-designer`, `workflow-architect`, `ops-strategist`) rather than running grep/Read directly in the main loop.

**Why:** on 2026-04-15 the user said: *"i prefer if you can validate with agents, since they are tailored to be experts."* He values the expert framing — agents are prompted to form a hypothesis and verify, which catches things the main loop skims past. He's willing to pay the extra tokens for sharper findings.

**How to apply:**
- "Check this for bugs / API errors / is this right?" → spawn `debugger` or `senior-engineer`.
- "Is this the right architecture / refactor approach?" → `senior-engineer`.
- UI / UX feedback → `ui-designer`.
- Process / workflow questions → `workflow-architect`.
- Strategic ops/business questions → `ops-strategist`.
- Trivial single-file edits, label changes, lookups where the answer is already on screen → still do directly. Don't burn an agent on a one-line fix.
- Token discipline (`feedback_token_discipline.md`) still applies *inside* the agent prompt — give the agent a tight, specific brief, not "audit everything."
- After the agent reports back, summarise its findings to the user in main-context-friendly form; don't dump raw agent output.

**Rule of thumb:** if the user is asking me to *judge* something rather than just *do* something, an expert agent should weigh in.
