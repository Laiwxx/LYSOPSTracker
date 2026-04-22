---
name: verified page map (routes, sidebar labels, owners)
description: Authoritative list of ops-tracker pages — route, sidebar label, file, owner. Use this instead of guessing page names.
type: project
originSessionId: ed57ab64-2d25-4376-af42-d133a30aa47a
---
Verified against `server.js` routes and sidebar HTML on 2026-04-22.

| Route | Sidebar label | File | Owner | Locked? |
|---|---|---|---|---|
| `/` | Dashboard | `index.html` | Boss — morning briefing | No |
| `/my-tasks` | **Team** | `my-tasks.html` | shared | No |
| `/factory` | Factory | `factory.html` | Chris | No |
| `/installation` | Installation | `installation.html` | Teo, Jun Jie | No |
| `/procurement` | Procurement | `procurement.html` | Rena | No |
| `/planning` | **Manpower** | `planning.html` | Chris — weekly plan | No |
| `/sales` | **Sales** (Pipeline) | `sales.html` | Boss + Janessa (edit), Alex Chew (read) | **Yes** — 3-layer lock + PIN gate |
| `/feedback` | Feedback | `feedback.html` | all | No |
| `new-project.html` | New Project | `new-project.html` | sales/boss | No |
| `admin.html` | Admin | `admin.html` | boss | **Yes** — PIN gate |
| — | — | `project.html` | boss read-only consolidation | No |
| — | — | `attendance.html`, `tasks.html` | — | No |

**Landmines to remember:**
- Route `/my-tasks` is labelled **"Team"** in the sidebar, not "My Tasks".
- Route `/planning` is labelled **"Manpower"** in the sidebar, not "Planning".
- **There is no `/claims` page.** Claims is headless — `data/claims.json` + API only.
- Sales nav link is **hidden by default** on all pages — `nav.js` reveals it only for authorised users.
- Sales and Admin both require admin PIN to access content.

**Why:** the user is a non-dev boss who navigates by sidebar labels. Use sidebar labels in conversation.
