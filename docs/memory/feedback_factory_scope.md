---
name: Factory page is factory-only — don't mix in other roles
description: Factory page manpower section should only show fabrication workers, not installation/site workers. Each page serves one role.
type: feedback
originSessionId: ac003d06-ee3e-4b9d-bdd5-1ef224590e88
---
Factory page is Chris's (Factory Manager) page — used 24/7. Don't mix in data from other roles.

**Why:** Boss explicitly rejected showing all workers (factory + site) in the manpower section because "showing all manpower only will make it like the dashboard." Each ops page serves one role; cross-role data belongs on the dashboard.

**How to apply:** When adding features to an ops page, only show data relevant to that page's role owner. Factory = fabrication workers, fab items, site requests TO factory. Don't pull in installation workers, site progress, or other role data even if available via API.
