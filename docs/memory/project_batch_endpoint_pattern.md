---
name: Batch fetch endpoint pattern for N+1 fixes
description: When a frontend page does N parallel /api/foo/:id calls, add /api/foo/batch?ids=a,b,c instead. Pattern landed 2026-04-25.
type: project
originSessionId: 0967c386-ca88-4f6d-b527-ea812bfdbeaf
---
Pattern landed 2026-04-25 to fix N+1 fetch storm on Factory page (was firing N HTTP calls per page load — one per active project). Replaced with a single `/api/projects/batch?ids=a,b,c` endpoint at server.js:1610.

**Why:** at 17 active projects today, 17 calls are tolerable. At 500 active projects, 500 sequential `readProjects().find(...)` reads on every page load. Each list endpoint reads the full JSON, so N+1 amplifies disk I/O.

**How to apply:**
- Pattern: `GET /api/<entity>/batch?ids=a,b,c` returns a `{ id1: record1, id2: record2 }` map.
- Cap at 1000 ids; reject larger requests with 400.
- Read the JSON file ONCE, filter by id-set, run any `deriveFields()` per record.
- Declare BEFORE `/api/<entity>/:id` so Express doesn't route "batch" into the `:id` handler.
- Frontend: replace `Promise.all(ids.map(id => fetch(/api/foo/${id})))` with one fetch + `Object.assign(cache, fullMap)`.

**When to use:**
- Any list page that loads detail per-item.
- Any "select multiple, show details" flow.
- Spotted candidate: similar pattern likely exists on the Project page if it cross-loads claims, PRs, DOs.

**When NOT to use:**
- A single detail page (one id) — `/api/<entity>/:id` is fine.
- When the list endpoint already returns the needed fields — just enhance it instead of adding a new endpoint.
