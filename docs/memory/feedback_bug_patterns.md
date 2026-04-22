---
name: Bug patterns to prevent
description: Recurring bug patterns found in Apr 21 code review — rules to follow so they don't recur
type: feedback
originSessionId: 59570639-312c-46cb-93ee-76a2a1eef8e6
---
## 1. _busy lock must always reset on early return
When using `if (_busy) return; _busy = true;` pattern, EVERY early `return` before the `finally` block MUST set `_busy = false` first. Otherwise one failed validation permanently freezes the page.

**Why:** Found 9 instances in procurement.html where validation failures locked the page until refresh.
**How to apply:** Any time you write or edit a function with `_busy` guard, scan ALL return paths before `finally`.

## 2. Never use raw fs.writeFileSync for config files — use safeWriteJSON
`safeWriteJSON` writes to `.tmp` then renames (atomic). Raw `writeFileSync` can truncate the file on crash, corrupting credentials and locking everyone out.

**Why:** Found 6 instances writing credentials.json with raw writeFileSync.
**How to apply:** Every JSON write to `config/` or `data/` must use `safeWriteJSON()`.

## 3. Async callbacks must not do stale read-modify-write
If a `.then()` callback re-reads a JSON file, modifies it, and writes it back, it can overwrite changes made between the outer write and the callback firing. This is a data-loss race condition.

**Why:** Calendar event callbacks in task create/update were re-reading tasks.json asynchronously.
**How to apply:** If you must update a field after an async operation, re-read → find → update → write in a try/catch, and accept that the window is small. Never re-read inside a loop that also writes.

## 4. Path traversal: always use path.resolve().startsWith()
`path.normalize` + `includes('..')` is fragile. The correct guard is:
```js
const resolved = path.resolve(BASE_DIR, userInput);
if (!resolved.startsWith(path.resolve(BASE_DIR))) return res.status(400)...
```
Also sanitize `req.params.id` with `path.basename()` when used in directory construction.

**Why:** Upload delete route and multer destination allowed traversal via unsanitized project ID.
**How to apply:** Every route that builds a file path from user input must use resolve+startsWith.

## 5. Email notifications must go through sendEmail()
Never use raw `fetch` to the Graph API. `sendEmail()` handles: test-mode override, CC dedup, retry logic, access token management.

**Why:** PR notification bypassed sendEmail(), leaked CC to real staff in test mode.
**How to apply:** All email sends use `sendEmail(to, name, subject, body, cc)`.

## 6. Auth middleware path checks must be exact matches
`req.path.startsWith('/js/utils.js')` also matches `/js/utils.js.map`, `/js/utils.js../../secret`. Use exact `===` match for specific files.

**Why:** Prefix match created potential auth bypass.
**How to apply:** Use `PUBLIC_PATHS.has()` set or exact `===` comparisons, not `startsWith` for specific files.

## 7. staff.json emails must be lowercase
Credential keys in `credentials.json` are lowercase. If `config/staff.json` has mixed-case emails, case-sensitive comparisons will fail.

**Why:** Salve, Teo, Jun Jie had mixed-case emails that didn't match credential keys.
**How to apply:** Always lowercase email addresses in staff.json.

## 8. ID generation must include random suffix
`Date.now().toString(36)` without randomness can collide if two items are created in the same millisecond. Add `Math.random().toString(36).slice(2, 6)`.

**How to apply:** Every new ID generator should follow the pattern: `Date.now().toString(36) + Math.random().toString(36).slice(2, 6)`.

## 9. Always use todaySGT() for date stamps — never raw UTC
`new Date().toISOString().split('T')[0]` returns UTC date, which is yesterday between midnight and 8am SGT. Use `todaySGT()` helper instead.

**Why:** Stage timestamps, PR dates, cron "today" comparisons, and overdue flags were all wrong before 8am SGT. `getWeekStart()` was computing last week's Monday on Sunday UTC.
**How to apply:** Every `new Date().toISOString().split('T')[0]` in server.js should be `todaySGT()`. The helper is defined at line ~677.

## 10. Delete cascades — clean up child records when parent is deleted
When deleting a project, also remove its site requests, tasks, and upload files. Otherwise orphan records accumulate and break cross-references.

**Why:** Project delete had no cascade — SRs, tasks, uploads became invisible orphans.
**How to apply:** Any DELETE endpoint for a parent entity must clean up child references in other data files.

## 11. Every fetch() must check res.ok
Frontend fetch calls that don't check `res.ok` silently swallow server errors. The UI proceeds as if the operation succeeded, showing stale data.

**Why:** Found in tasks.html (create, delete), my-tasks.html (status update, acknowledge), feedback.html (status/priority change).
**How to apply:** After every `fetch()`, check `if (!res.ok)` and show an error toast before returning.

## 12. Admin-only endpoints must call requireAdminAuth()
Any route under `/api/admin/*` must check admin auth. Without it, any logged-in staff member can trigger recalcs, seed tasks, etc.

**Why:** `/api/admin/recalc` and `/api/admin/seed-recurring-tasks` had no auth check.
**How to apply:** First line inside try block: `if (!await requireAdminAuth(req, res)) return;`

## 13. Role aliases in staff.json are reserved — prevent overwrite
Creating a staff member with a name like "Factory Manager" overwrites the role alias, misdirecting all emails for that role.

**Why:** `POST /api/staff` used the name as the key with no collision check against role aliases.
**How to apply:** Validate new staff names against ROLE_ALIASES list before saving.

## 14. Ticket status enum must match cleanup logic
If code checks for status values that aren't in the valid enum, the check is dead code. Memory cleanup checked for "Resolved"/"Closed" but valid statuses were only "New"/"In Review"/"Done".

**How to apply:** When referencing status values in conditionals, verify they exist in the VALID_*_STATUSES array.

## 15. Static file bypass — locked pages need middleware block
`express.static` serves `public/*.html` to any logged-in user. A route check on `/sales` does NOT block `/sales.html`. Must add middleware before `express.static` to block direct `.html` access for locked pages.

**Why:** Sales page was accessible to all logged-in staff via `/sales.html` despite route lock on `/sales`.
**How to apply:** For every locked page, add a middleware check for `/<page>.html` before the `express.static` call.

## 16. Test accounts must not trigger side effects
`sendEmail()` and `createTaskCalendarEvent()` must check `getAuthUser() === 'Scenario Tester'` and bail. Otherwise test runs email real staff.

**Why:** App went live but scenario tests kept firing real emails because EMAIL_TEST_OVERRIDE was never set.
**How to apply:** Any new notification channel (SMS, Slack, etc.) must add the same Scenario Tester guard.
