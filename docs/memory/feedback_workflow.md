---
name: prefer page-by-page work over cross-cutting features
description: How Lai Wei Xiang wants Claude to scope work — one page/surface at a time, not scattered multi-file refactors
type: feedback
originSessionId: 4f0102b2-2b4d-4bce-a544-be0d6b8499f2
---
The user prefers work to be organized **page by page** rather than as cross-cutting features.

**Why:** He said "I prefer if we fix erm page by page, so it would be cleaner." As a non-developer boss reviewing work visually, he tracks progress by walking through individual pages in the browser. Work that's scattered across 5 files for a single conceptual feature is harder for him to verify and mentally close off.

**How to apply:**
- When a task could be done either "feature-first across multiple pages" or "page-first with related features grouped", pick page-first.
- Scope work by the page a user lands on: `/factory`, `/installation`, `/procurement`, `/planning`, `/project.html`, `/index.html` (dashboard), `/claims`, etc.
- For backend-only work with no visible page surface (like cron jobs, activity log, deriveFields), pair it with the page that triggered the need and ship it alongside that page's UI changes so the user can see the effect.
- When a single feature genuinely requires touching multiple pages (e.g., an audit trail that shows on every page), announce it explicitly and get confirmation rather than sprawling silently.
- When summarising work, describe it in terms of the pages affected — "I changed factory.html, installation.html, and server.js" — so he can walk his browser through the change list.
