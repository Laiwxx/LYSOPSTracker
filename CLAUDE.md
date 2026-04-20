# LYS Ops Tracker

## Architecture
- Single-file Node.js/Express server (`server.js`, ~5500 lines)
- Static HTML/CSS/vanilla JS frontend in `public/`
- JSON file storage in `data/`, config in `config/`
- Server managed by systemd (`ops-tracker.service`)

## Server management
- **Always** use `sudo systemctl restart ops-tracker` after editing server.js
- **Never** run `node server.js` manually — causes port collision and crash-loop emails
- Status: `systemctl status ops-tracker`
- Logs: `/var/log/ops-tracker.log`, `/var/log/ops-tracker.err.log`, `data/errors.log`

## Key rules
- Every user-facing delete action MUST use `confirmDelete()` with reason dropdown — never plain `confirm()`
- Email templates MUST use `escHtml()` for all user-supplied content
- File delete routes MUST validate resolved paths stay inside `UPLOADS_DIR`
- Notifications are role-based via `staff.json` aliases — never hardcode person names
- One role, one page — don't mix other roles' data into an ops page
- UI: plain/professional, use existing CSS tokens from `style.css`, no themed aesthetics

## Testing
- `EMAIL_TEST_OVERRIDE` and `CALENDAR_TEST_OVERRIDE` env vars route all emails/calendar events to boss during testing
- App is pre-launch — most data in `data/*.json` is test data from Excel migration
