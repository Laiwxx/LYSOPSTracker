---
name: Mobile responsive navigation
description: Sidebar becomes slide-over drawer on mobile ≤768px with hamburger toggle — built 2026-04-20
type: project
originSessionId: afbc3daa-39c7-4fe3-8fb0-04c02f1b5d12
---
Added mobile-responsive navigation (2026-04-20).

**How it works:**
- Desktop (>768px): sidebar pinned left, unchanged
- Mobile (≤768px): sidebar hidden off-screen, slides in from left on hamburger tap
- `/public/js/nav.js` — auto-injects hamburger button into `.topbar` + overlay into body
- Closes on: overlay tap, Escape key, nav link click
- Exits early if page has no `.tasks-sidebar` (safe for project.html, login.html, attendance.html)

**Files touched:**
- `public/css/style.css` — mobile breakpoint, hamburger styles, sidebar slide-over, overlay
- `public/js/nav.js` — new shared script
- 10 HTML pages got `<script src="/js/nav.js"></script>` before `</body>`

**Not changed:** project.html (uses its own tab bar), attendance.html (no sidebar by design), login.html (standalone)
