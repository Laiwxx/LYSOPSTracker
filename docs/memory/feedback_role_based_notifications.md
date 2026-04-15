---
name: Notifications must be role-based, not person-hardcoded
description: Never hardcode staff names in email routing; resolve via role aliases in staff.json so churn doesn't break notifications silently.
type: feedback
originSessionId: a678a956-df23-4faa-96a0-728907c543c9
---
Never hardcode person names (e.g. `getStaffEmail('Chris')`) in cron jobs, email triggers, or notification fan-outs. Resolve to a role via staff.json aliases (`Factory Manager`, `Project Manager`, `Site Engineer`, `QS`, `Purchaser`) and fall back to the boss (`Lai Wei Xiang` → `ADMIN_EMAIL`) when the role is unset.

**Why:** Chris (or anyone) leaving the company would silently break notifications — they'd either hit a dead mailbox or return `null` and the cron would log nothing. Raised 2026-04-15 mid-Phase-1 site-request unification when I almost shipped a noon cron that hardcoded `getStaffEmail('Chris')`. Boss caught it before the edit landed: *"ensure that the fall back logic do not only fix chris forever, because considering chris leave the company too."*

**How to apply:**
- Helper already exists at server.js: `getRoleEmail(role)` — resolves role alias then falls back to boss. Use it for any "notify the person responsible for X" path.
- The existing `Factory Manager`, `Project Manager`, `Site Engineer`, `QS`, `Purchaser` aliases in `data/staff.json` map roles → current staff name. Add new role aliases here when introducing new notification paths.
- For display-name ("Hi Chris,") also resolve from staff.json: `(readStaff()['Factory Manager'] || {}).name`. Never hardcode the greeting name either.
- Audit existing `getStaffEmail('Chris')` / `getStaffEmail('Lai Wei Xiang')` calls when touching notification code — migrate to `getRoleEmail` opportunistically, especially for role-bound triggers (not person-bound ones like "email the task requester").
- Person-bound calls (task assignee, requester, PM stored on the project) stay as `getStaffEmail(name)` — those are dynamic per record, not role-fixed.
