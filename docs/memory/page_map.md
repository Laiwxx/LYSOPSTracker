---
name: verified page map (routes, sidebar labels, owners)
description: Authoritative list of ops-tracker pages — route, sidebar label, file, owner. Use this instead of guessing page names.
type: project
originSessionId: d340e805-c3a6-422c-84b6-4f0be60f171d
---
Verified against `server.js` routes and `public/index.html` sidebar on 2026-04-14. Sidebar labels often differ from route names — always use the sidebar label when talking to the user.

| Route | Sidebar label | File | Owner |
|---|---|---|---|
| `/` | Dashboard (📊) | `index.html` | Boss — morning briefing |
| `/my-tasks` | **Team** (👥) | `my-tasks.html` | shared |
| `/factory` | Factory (🏭) | `factory.html` | Chris |
| `/installation` | Installation (🔧) | `installation.html` | Teo, Jun Jie |
| `/procurement` | Procurement (🛒) | `procurement.html` | Rena |
| `/planning` | **Manpower** (📅) | `planning.html` | Chris — weekly plan |
| `/feedback` | Feedback (💬) | `feedback.html` | all |
| `new-project.html` | New Project (➕) | `new-project.html` | sales/boss |
| `admin.html` | Admin (⚙️) | `admin.html` | boss |
| — (not in sidebar) | — | `project.html` | boss read-only consolidation |
| — (not in sidebar) | — | `attendance.html`, `tasks.html` | — |

**Landmines to remember:**
- Route `/my-tasks` is labelled **"Team"** in the sidebar, not "My Tasks".
- Route `/planning` is labelled **"Manpower"** in the sidebar, not "Planning".
- **There is no `/claims` page.** Claims is headless — `data/claims.json` + `/api/claims/summary` (server.js:1671) only. Do not refer to "the claims page" until a `claims.html` actually exists.

**Why:** the user is a non-dev boss who navigates by sidebar labels. Calling a page by its route when the sidebar says something else makes him doubt whether I'm looking at the real app.
**How to apply:** when referring to any page in conversation, lead with the sidebar label; include the route/file only as secondary reference. Before claiming a page "exists," verify it has both a file in `public/` and a route in `server.js`.
