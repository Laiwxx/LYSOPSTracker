---
name: Per-staff session auth system
description: Session-based login with per-staff credentials, forgot password, admin reset, welcome emails — built 2026-04-20
type: project
originSessionId: afbc3daa-39c7-4fe3-8fb0-04c02f1b5d12
---
Replaced shared Basic Auth with per-staff session auth (2026-04-20).

**How it works:**
- Credentials in `config/credentials.json` — bcrypt-hashed passwords, keyed by username (first name lowercase)
- Session cookie (30 days, httpOnly, sameSite lax, secure auto)
- `express-session` with `trust proxy` for nginx
- SESSION_SECRET in `.env` (persists across restarts)
- Basic Auth still accepted as fallback (for curl/API usage)
- AsyncLocalStorage tracks logged-in user → `logActivity()` auto-captures `by` field

**Endpoints:**
- `POST /api/auth/login` — session login (public, no auth)
- `POST /api/auth/logout` — destroy session
- `GET /api/auth/me` — returns current user name
- `POST /api/auth/change-password` — user changes own (requires auth)
- `POST /api/auth/forgot-password` — emails new password (public, rate-limited 3/hr)
- `POST /api/auth/admin-reset` — admin resets someone's password (requires auth + admin PIN)
- `POST /api/auth/send-welcome-emails` — one-time bulk email credentials (requires auth + admin PIN)

**Staff credentials (11 users):**
weixiang, chris, rena, alexmac, salve, teo, junjie, janessa, murugan, senthil, alexchew

**Login page:** `/public/login.html` — fully self-contained, zero external deps, mobile-first (16px inputs, 44px touch targets)

**Why:** Individual accountability — activity log shows who did what. Also enables per-person task email routing.
