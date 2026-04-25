---
name: Refer to pages by sidebar label, never route/filename
description: In conversation, call pages by their sidebar label (Manpower, Team, Sales), never by route or file name (planning, my-tasks, sales.html).
type: feedback
originSessionId: a185d9a3-2337-4ea6-b464-6c758a60a5c2
---
When talking to the user about a page, always use the sidebar label — not the route, not the filename.

**Why:** User is a non-dev boss who navigates by sidebar labels. Calling `/planning` "the planning page" is confusing and wrong — he sees it as "Manpower." Corrected on 2026-04-24 after I referred to it as "planning page."

**How to apply:**
- `/planning` → **Manpower** (not "planning page", not "planning.html")
- `/my-tasks` → **Team** (not "my-tasks page")
- `/sales` → **Sales** (ok as-is)
- `/` → **Dashboard**
- `/factory` → **Factory**
- `/installation` → **Installation**
- `/procurement` → **Procurement**
- `/feedback` → **Feedback**

File paths in tool calls and code are fine — this is about how I talk to the user.
