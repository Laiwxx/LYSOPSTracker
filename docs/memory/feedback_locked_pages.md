---
name: Locked pages need 3-layer access control
description: Pattern for restricting page access — server route + static middleware block + frontend PIN gate + API 403
type: feedback
originSessionId: ed57ab64-2d25-4376-af42-d133a30aa47a
---
When a page is locked to specific users, enforce at ALL layers:

1. **Server route** — check `req.session.user` against allowed set, redirect others to `/`
2. **Static middleware** — block `/<page>.html` direct access before `express.static` serves it (otherwise users bypass the clean URL route check)
3. **Frontend PIN gate** — admin PIN prompt before content loads (same `/api/admin/pin` verify endpoint)
4. **API endpoints** — return 403 for unauthorised users
5. **Nav link** — hidden by default (`display:none`), revealed by `nav.js` after `/api/auth/me` check

**Why:** Boss requires sensitive pages (Sales, Admin) to be fully locked. A route-only check still allowed `/sales.html` direct access via express.static. The PIN gate adds a second factor even for authorised session users.

**How to apply:** Any new locked page must follow all 5 layers. See `/sales` implementation as the reference pattern.
