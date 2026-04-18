---
name: Manpower OT tracking and supply worker rules
description: OT hours tracked per assignment, monthly cap 72h MOM, Saturday is full OT, supply workers excluded
type: project
originSessionId: ac003d06-ee3e-4b9d-bdd5-1ef224590e88
---
**Working hours:** Mon-Fri 8am-5:30pm standard. After 5:30pm = OT. Saturday = entirely OT (default 8h).

**OT tracking:** Per-assignment otHours field in manpower plan. Monthly total computed across all weeks. Amber warning at 60h, red at 68h. MOM cap is 72h/month for work permit holders.

**Supply workers:** External/temp workers from other companies. 10h/day Mon-Sat, no OT tracking. Visually distinct: amber badge, company name shown.

**Transport:** Auto-suggests trips from installation assignments. Worker list from manpower plan (not attendance). No attendance marking needed.

**MC:** Set directly in manpower plan like any assignment. No auto-apply from attendance.json (removed — was causing ghost MC bug).

**API:** GET /api/manpower-plan/ot-summary returns monthly OT totals + at-risk workers. Dashboard OT box reads from this.
