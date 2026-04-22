# LYS Ops Tracker

## Architecture
- Single-file Node.js/Express server (`server.js`, ~5800 lines)
- Static HTML/CSS/vanilla JS frontend in `public/`
- JSON file storage in `data/`, config in `config/`
- Server managed by systemd (`ops-tracker.service`)
- Session-based auth (bcrypt passwords in `config/credentials.json`, sessions via express-session)
- No build step, no bundler — edit and restart

## File structure

```
ops-tracker/
├── server.js                    # Express server — ALL API routes, email, cron, auth (~5800 lines)
├── package.json
│
├── public/                      # Static frontend — each page is self-contained HTML+JS
│   ├── index.html               #   Dashboard (155 lines)
│   ├── login.html               #   Login page (244 lines)
│   ├── factory.html             #   Factory ops — fab items, daily logs, DOs (3584 lines)
│   ├── planning.html            #   Manpower — weekly grid, transport tab (1838 lines)
│   ├── my-tasks.html            #   Team — recurring/request/personal tasks (1750 lines)
│   ├── procurement.html         #   Procurement — PRs, suppliers, prices (1591 lines)
│   ├── installation.html        #   Installation — site requests, install tracking (1455 lines)
│   ├── tasks.html               #   Task admin — all tasks view (786 lines)
│   ├── admin.html               #   Admin — users, credentials, settings (616 lines)
│   ├── project.html             #   Single project detail (read-only consolidation) (511 lines)
│   ├── feedback.html            #   User feedback/bug reports (476 lines)
│   ├── attendance.html          #   Daily attendance (390 lines)
│   ├── new-project.html         #   Create new project wizard (368 lines)
│   ├── css/
│   │   └── style.css            #   Global styles — all CSS tokens/variables live here
│   └── js/
│       ├── utils.js             #   Shared: confirmDelete(), toast(), formatDate(), etc.
│       ├── nav.js               #   Sidebar navigation + mobile hamburger drawer
│       ├── dashboard.js         #   Dashboard charts and stats
│       ├── project.js           #   Project detail page logic
│       └── chart.min.js         #   Chart.js library (vendored)
│
├── config/                      # App configuration (NOT runtime data)
│   ├── credentials.json         #   User login credentials (bcrypt hashes)
│   ├── staff.json               #   Role aliases → email mappings for notifications
│   └── admin.json               #   Admin settings
│
├── data/                        # Runtime JSON data (flat-file database)
│   ├── projects.json            #   All projects (17 active)
│   ├── tasks.json               #   Recurring + request + personal tasks
│   ├── workers.json             #   Worker roster (own + supply)
│   ├── manpower-plans.json      #   Weekly manpower assignments
│   ├── attendance.json          #   Daily attendance records
│   ├── purchase-requisitions.json
│   ├── delivery-orders.json
│   ├── site-requests.json
│   ├── transport.json
│   ├── suppliers.json
│   ├── prices.json
│   ├── tickets.json             #   Feedback/bug tickets
│   ├── eod-flags.json           #   End-of-day completion flags
│   ├── eod-logs.json            #   EOD log entries
│   ├── eod-history.json
│   ├── monday-flags.json
│   ├── cron-heartbeat.json
│   ├── activity.log             #   Append-only activity log (JSON lines)
│   └── errors.log               #   Server error log
│
└── uploads/                     # User-uploaded files (photos, PDFs, DOs)
```

## Page ownership (one role, one page)
| Page | Route | Owner role | Purpose |
|------|-------|-----------|---------|
| Factory | `/factory` | Factory Manager (Chris) | Fab items, daily logs, DOs |
| Installation | `/installation` | Site Engineers | Site requests, install tracking |
| Procurement | `/procurement` | Purchaser (Rena) | PRs, suppliers, prices |
| Manpower | `/planning` | GM (boss) | Weekly worker assignments, transport |
| Team | `/my-tasks` | All staff | Personal + recurring + request tasks |
| Dashboard | `/` | All staff | Read-only overview |
| Project | `/project?id=X` | Read-only | Consolidation view from ops pages |

## Frontend pattern
- Each HTML page is **self-contained**: inline `<style>`, inline `<script>`, no framework
- Shared utilities in `public/js/utils.js` — loaded via `<script src="/js/utils.js">`
- Pages fetch data from `/api/*` endpoints, render with DOM manipulation
- No router — each page is a separate HTML file served by Express static
- CSS variables defined in `style.css` — use `var(--accent)`, `var(--bg2)`, `var(--border)`, etc.

## Server management
- **Always** use `sudo systemctl restart ops-tracker` after editing server.js
- **Never** run `node server.js` manually — causes port collision and crash-loop emails
- **Never** use pm2 (start/restart/ecosystem) — systemd is the only process manager; pm2 causes duplicate-listen conflicts
- Status: `systemctl status ops-tracker`
- Logs: `/var/log/ops-tracker.log`, `/var/log/ops-tracker.err.log`, `data/errors.log`

## Key rules
- Every user-facing delete action MUST use `confirmDelete()` with reason dropdown — never plain `confirm()`
- Email templates MUST use `escHtml()` for all user-supplied content
- File delete routes MUST validate resolved paths stay inside `UPLOADS_DIR`
- Notifications are role-based via `config/staff.json` aliases — never hardcode person names
- One role, one page — don't mix other roles' data into an ops page
- UI: plain/professional, use existing CSS tokens from `style.css`, no themed aesthetics
- Each page averages ~1,050 lines; the 4 ops pages average ~2,100 lines each

## Testing
- **Scenario tests are mandatory** after any server.js or API change: `node tests/scenario-test.js`
- All tests must pass (0 failures) before work is considered done
- Test file self-bootstraps: creates temp credentials + admin pin, runs 22+ scenarios, cleans up
- When adding new API features, add corresponding test scenarios to `tests/scenario-test.js`
- `EMAIL_TEST_OVERRIDE` and `CALENDAR_TEST_OVERRIDE` env vars route all emails/calendar events to boss during testing
- App is pre-launch — most data in `data/*.json` is test data from Excel migration

## Code safety rules
- Always use `todaySGT()` for date stamps — never `new Date().toISOString().split('T')[0]` (UTC)
- Always use `safeWriteJSON()` for writing JSON files — never raw `fs.writeFileSync()`
- Every `fetch()` in frontend must check `res.ok` and show error feedback on failure
- Every `_busy` guard must reset on ALL early return paths before `finally`
- Every ID must include random suffix: `Date.now().toString(36) + Math.random().toString(36).slice(2,6)`
- Admin-only endpoints must call `requireAdminAuth(req, res)` as first check
- `getRoleEmail()` does key lookup on staff.json — never search by name field
- Delete cascades: when deleting a parent record, clean up child records in other data files
- `sendEmail()` is the only way to send email — never raw fetch to Graph API
