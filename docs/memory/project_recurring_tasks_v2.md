---
name: Recurring tasks v2 — revised per ops review
description: Updated RECURRING_ROLE_DEFS based on ops strategist review — removed checkbox theatre, added boss + finance roles
type: project
originSessionId: afbc3daa-39c7-4fe3-8fb0-04c02f1b5d12
---
Revised recurring task definitions (2026-04-20) after ops strategist review.

**Key changes from v1:**
- Removed "Submit EOD log" from all roles (system auto-flags via eod-flags.json, self-policing is theatre)
- Removed "Source 1 new supplier contact today" from Purchaser (unrealistic in niche industry)
- Removed "Safety walkthrough" as daily → moved to Monday with photo evidence requirement
- Removed "Chase newly Awarded handover" from Sales daily → should be event-triggered
- Added "Review and action new PRs" to Purchaser (her actual intake queue)
- Added "Prepare next progress claim" to QS roles (cash-flow creation, not just chasing)
- Added GM role (boss): EOD flag review, cash position, pending decisions
- Added Finance role (Alex Chew): invoice issuance, payment matching, aging flags

**Current daily task counts:**
GM: 3, Factory Manager: 6, Purchaser: 4, QS/QS2: 4 each, Sales: 3, Site Engineers: 4 each, Finance: 3

**Config required:** `config/staff.json` must have `GM` and `Finance` keys (added 2026-04-20).
Alex Chew added to `config/credentials.json` (username: alexchew).
