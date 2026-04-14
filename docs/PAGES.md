# LYS Ops Tracker — System Map

Living reference for every page and automation in the app. Keep this file up to date as the source of truth for how the system is structured, so it can be rebuilt or extended without digging through code.

**Last updated:** 2026-04-14 (Team page — logic kept, mission-control visuals reverted)

---

## Core principle

**One role, one page.** Each of the four ops pages below is the single source of truth for its owner's work. `/project.html` is the boss's read-only consolidation that pulls *from* the ops pages — data flows ops → project, never the other way.

- Physical work progress (fab / install pipelines) lives per-item on the ops pages.
- Project-level lifecycle stages (21 stages: tendering → handover) live on the project record.
- Claims are monthly / phase-bound, NOT triggered by install-%.

---

## Pages

### Dashboard — `/` (index.html)

**Sidebar label:** 📊 Dashboard
**Owner:** Lai Wei Xiang (boss — morning briefing)
**Purpose:** Answer five questions at a glance — what's moving, is prod/install on track, who's MC today, any stuck items, what's the week's focus.

**Key sections:**
- KPI cards: Active Projects · Fabrication % · Installation %
- Weekly Movement (manpower plan, Mon–Sat)
- Today's MC / Absent (from live attendance)
- Claims Pipeline (status pills with dollar totals)
- Project cards (active fab/install projects)
- Factory panel — attention-only (overdue tickets, new tickets, ready-awaiting-pickup)

**Data sources:** `/api/summary`, `/api/projects`, `/api/factory-queue`, `/api/fab-status`, `/api/manpower-plan`, `/api/workers`, `/api/attendance`, `/api/claims`, `/api/eod-log`

**Auto-refresh:** Weekly movement + MC every 2 min; EOD status every 5 min.

---

### Team — `/my-tasks` (my-tasks.html)

**Sidebar label:** 👥 Team
**Owner:** All staff
**Purpose:** Personal task list + internal request system. Each staff member sees their own tasks, can create self-tasks, request tasks from teammates. End-of-Watch log submission happens here.
**Aesthetic:** Plain / professional — uses the app's default `style.css` tokens. Consistent with Factory / Installation / Procurement / Dashboard. No themed styling.

**Three task types (grouped into sections in the personal view):**
- `Mandatory Daily Tasks` — `Recurring` (auto-created at 8:45am). Hours logged.
- `Requests From Team` — `Requested Task` (one staff asks another; `requestedBy` + `assignedTo` both set). **Hours NOT logged.**
- `Personal Tasks` — everything else (Self Task, Project Task). Hours logged.

**Status model:** Pending → Done only. "In Progress" and "Blocked" were removed. Tasks stay Pending until explicitly marked Done; the "Mark as Seen" button sets `acknowledgedAt` and emails the requester without changing status.

**Ack reminder ladder (capped at 3 days):** Day 1 + Day 2 email assignee, CC requester. Day 3 email assignee, CC requester + boss with `[FINAL FLAG]` subject. Day 4+ stops — the escalation IS the signal. Counter stored in `task.ackReminderCount`, flag in `task.ackBossFlaggedAt`.

**Calendar events:** Every task with a `dueDate` creates a 30-minute Outlook event at 9am SGT on the due date via Graph API. Event lifecycle handled on create / reassign / due-date change / mark Done / delete. Test-mode controlled by `CALENDAR_TEST_OVERRIDE` env var.

**Views:**
- **Team Overview grid** — staff cards with avatar, name, overdue/unseen pills, EOD ✅/⚠️ badge, total/open stats.
- **Personal view** — header `{Name} — {done}/{total} done · {date}` with badges. Three collapsible type sections (Mandatory / Requests / Personal). End-of-Day Report section at the bottom with a fixed "Submit EOD" button.

**Mandatory recurring tasks:** Auto-created daily at 8:45am weekdays, per role (Chris, Rena, Alex Mac, Salve, Teo, Jun Jie). Monday-only extras exist for weekly planning tasks. Templates live in `server.js` `RECURRING_DEFS`.

**Data sources:** `/api/tasks`, `/api/tasks/:id/acknowledge`, `/api/tasks/:id/hours`, `/api/eod-log`, `/api/staff`, `/api/projects`

**Removed / deprecated:** `Ticket Task` type (data/tickets.json is empty). `ticketId` field still accepted server-side but no UI surface. Can be re-enabled if the Feedback page starts accumulating items.

---

### Factory — `/factory` (factory.html)

**Sidebar label:** 🏭 Factory
**Owner:** Chris (factory manager)
**Purpose:** Source of truth for fabrication progress. Per-item quantity tracking, delivery-request acknowledgement, manpower-for-today, site-request inbox from installation.

**Key features:**
- Fab item grid: `qtyDone / totalQty` per item, fab % auto-derived
- Per-item stages: Not Started → In Progress → QC Check → Ready for Delivery → Delivered
- Delivery tickets from Installation (acknowledge within 2hrs — flagged on dashboard if stale)
- Site request inbox — unacknowledged > 24hrs triggers 12pm email reminder

**Data sources:** `/api/factory-queue`, `/api/fab-status`, `/api/site-requests`, per-project fabrication array

---

### Installation — `/installation` (installation.html)

**Sidebar label:** 🔧 Installation
**Owner:** Teo Meei Haw, Jun Jie (site engineers)
**Purpose:** Source of truth for on-site installation progress. Filtered per site engineer by project assignment.

**Key features:**
- Install item grid with per-item stages: Not Started → In Progress → Installed → Verified
- Raise delivery requests to Chris (creates tickets in Factory)
- Raise site requests for materials/tools

**Data sources:** `/api/installation`, per-project installation array, delivery requests

---

### Procurement — `/procurement` (procurement.html)

**Sidebar label:** 🛒 Procurement
**Owner:** Rena (purchaser)
**Purpose:** PR → PO → delivery pipeline. Supplier and price book management.

**Key features:**
- PR pending → PO raised → In Transit → Delivered
- Price book (supplier + material + rate)
- Overdue PO flag (past promisedDate)

**Data sources:** `/api/purchase-requisitions`, `/api/purchase-orders`, `/api/suppliers`, `/api/prices`

---

### Manpower — `/planning` (planning.html)

**Sidebar label:** 📅 Manpower
**Owner:** Chris (weekly planner)
**Purpose:** Weekly manpower plan — who works where, Monday to Saturday. Auto-populates last week as starting point each Monday.

**Key features:**
- Worker grid: each row = worker, columns = days
- Assignment types: Fabrication, Installation, Driver, MC, Off
- Reconciles MC/Off entries against live attendance so stale plan data is hidden
- Supply workers (temporary hires) stored on the plan itself

**Data sources:** `/api/manpower-plan`, `/api/workers`, `/api/attendance`

---

### Feedback — `/feedback` (feedback.html)

**Sidebar label:** 💬 Feedback
**Owner:** All staff
**Purpose:** Internal bug reports, feature requests, and feedback. Tickets can be linked to tasks on the Team page.

**Statuses:** New → In Review → Done

**Data sources:** `/api/tickets`

---

### New Project — `/new-project.html`

**Sidebar label:** ➕ New Project
**Owner:** Sales (Janessa) and boss
**Purpose:** Create a new project record — populates contract value, VO, dates, assigned PM/QS/factory/site, initial product scope.

**Data sources:** `POST /api/projects`

---

### Admin — `/admin.html`

**Sidebar label:** ⚙️ Admin
**Owner:** Lai Wei Xiang (boss only — should be gated in prod)
**Purpose:** Staff management, worker management, activity logs, admin PIN, this system map.

**Data sources:** `/api/staff`, `/api/workers`, `/api/admin/pin`, `/api/admin/logs`, `/api/system-map`

---

### Project Detail — `/project.html?id=…` (NOT in sidebar)

**Owner:** Boss (read-only for fab/install tabs)
**Purpose:** Consolidated project view — Info, Product Scope, Fabrication, Installation, Payment, Stages, Uploads, Overview.

**Important:** Fabrication and Installation tabs display what the ops pages captured — they are read-only from the project page. Only Product Scope, Info, Payment, and Uploads are editable here.

**Data sources:** `/api/projects/:id`

---

### Claims — headless module (NO page yet)

**Owner:** Assigned QS per project (Salve or Alex Mac) up to certification; Alex Chew (finance) from invoice onwards.
**Purpose:** Progress claim tracking — submitted → awaiting cert → certified → invoiced → paid / disputed.

**Important:** There is NO `/claims.html` page. All claims flow is via `/api/claims`, `/api/claims/summary`, and the Payment tab on `/project.html`. Do not refer to "the claims page."

**Automation:** 1-week / 3-day / past-deadline email reminders to the project's assigned QS, CC boss. Runs in 9am weekday cron.

---

## Automations (cron schedule)

All times Singapore timezone (Asia/Singapore).

| Time | Trigger | What it does |
|---|---|---|
| **8:45am** Mon–Fri | `createDailyRecurringTasks` | Creates mandatory daily tasks per role (Chris, Rena, Alex Mac, Salve, Teo, Jun Jie). Monday-only extras added. Sends one summary email per person. |
| **9:00am** Mon–Fri | Overdue task check | Emails each assignee if their task is past dueDate (one-shot per task). |
| **9:00am** Mon–Fri | SOP claims deadline | For each claim in Awaiting Certification: fires at 7 days, 3 days, and past-deadline. Primary → project's assigned QS, CC → boss. |
| **9:00am** Mon–Fri | Unacknowledged task reminder | If task created > 24hr ago and never acknowledged, email assignee (CC requester). |
| **9:00am** Mon–Fri | Yesterday's EOD re-alert | If anyone was missing yesterday's EOD and still hasn't caught up, email boss. |
| **12:00pm** Mon–Fri | Stale delivery request | Emails Chris if a delivery request has been "New" for > 24hrs. |
| **6:00pm** Mon–Fri | End-of-Watch reminder | Emails each staff member their today's tasks + "file EOW" button. |
| **6:30pm** Mon–Fri | End-of-Watch flag to boss | Writes `eod-flags.json`, appends to history, emails boss a list of anyone who hasn't filed. (Was 6:15pm, moved to 6:30pm.) |
| **Monday 00:01** | Weekly archive | Archives last week's Done tasks. |

**Removed:** 7pm weekday re-reminder — redundant with 6pm + 6:30pm flag. Coverage if someone still hasn't filed overnight: 9am next-day re-alert to boss (inside the 9am cron, Check 4).

## Email + Calendar overrides

All outbound email routes through `sendEmail(to, name, subject, html, cc)`. `EMAIL_TEST_OVERRIDE` env var redirects every recipient (and zeros the CC list) to a single address — used for pre-launch testing to prevent leakage to real staff.

All Outlook calendar events route through `createTaskCalendarEvent(task, email, by)` → Graph API `/users/{email}/events`. `CALENDAR_TEST_OVERRIDE` env var redirects every event to a single mailbox (with a `[TEST — would go to ...]` subject prefix) so staff calendars aren't spammed during pre-launch testing.

**Both must be unset before going live.**

---

## Data files

| File | Purpose |
|---|---|
| `data/projects.json` | Master project records (one array of objects) |
| `data/tasks.json` | All tasks, across all staff |
| `data/claims.json` | Claims (headless module) |
| `data/staff.json` | Staff name → email map, plus role name aliases |
| `data/workers.json` | Hourly workers (for Manpower page) |
| `data/attendance.json` | Daily attendance records |
| `data/manpower-plans.json` | Weekly manpower plans |
| `data/site-requests.json` | Installation → Factory material requests |
| `data/purchase-orders.json` · `purchase-requisitions.json` · `suppliers.json` · `prices.json` | Procurement pipeline |
| `data/eod-logs.json` · `eod-flags.json` · `eod-history.json` | EOD submission tracking |
| `data/tickets.json` | Feedback / bug reports |
| `data/activity.log` · `errors.log` | Audit and error trail |

---

## Auth

Currently: single shared Basic Auth via `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` env vars. Applies to every route. Pre-launch gate only — not a real per-user login.

---

## Changelog

Append-only log of significant changes. Newest first.

### 2026-04-14 · Custom sub-agents + token-discipline
- Six custom sub-agents created in `.claude/agents/`: `debugger`, `senior-engineer`, `ui-designer`, `ops-strategist`, `workflow-architect`, `context-builder`. Invoke via Agent tool with `subagent_type=<name>`.
- `feedback_token_discipline.md` memory added: narrow before Read, batch parallel calls, short outputs, no ceremony. Applies to main assistant and all sub-agents.
- `feedback_visual_style.md` memory added: plain/professional only; themed aesthetics get reverted.

### 2026-04-14 · Mandatory tasks seeded + install-complete note automation
- `RECURRING_DEFS` edited: claim-trigger wording removed from both QSs' daily list (philosophy: claims are time/phase-bound, not %-bound). **Janessa** added to the daily rotation (sales manager — quotation follow-ups, tender inbox, pipeline updates). People list is now Chris / Rena / Alex Mac / Salve / Teo / Jun Jie / Janessa. Still excluded: Alex Chew (finance-only), Murugan, Senthil.
- New 9am cron Check 5: when a project's `installPercent` hits 100% and `installCompleteTaskCreated` flag is unset, create ONE note task for that project's assigned QS ("Installation complete on [jobCode] — note for claim planning"). Flag stored on project record, idempotent.
- New admin endpoint `POST /api/admin/seed-recurring-tasks` runs the recurring-task seeder on demand. Idempotent — dedups by assignedTo+title+today.
- Seeded Wednesday 2026-04-15 SGT mandatory tasks: **36 created** across 7 people. Plus 1 install-complete note that surfaced a data issue: one project has `qs="Lai Wei Xiang"` — see `known_data_issues.md`.

### 2026-04-14 · Team page — mission-control visuals reverted
- After shipping Phase 2, the themed mission-control look didn't land. Reverted every visual change: body class removed, telemetry strip deleted, station IDs + LEDs dropped from cards, topbar / overview header / personal view header / section labels / EOD labels / buttons all restored to plain English.
- All 465 lines of dead `body.mission-control .*` CSS stripped from `public/my-tasks.html` (file went from ~2124 → ~1659 lines).
- **Kept** from Phase 1 (unchanged): three type-grouped sections (Mandatory / Requests / Personal), Ticket Task removed, In Progress + Blocked removed, Mark-as-Seen flow, hours hidden on Requested, 3-day ack ladder, calendar integration, wiped tasks.json.
- New feedback memory added: `feedback_visual_style.md` — default to plain professional styling consistent with existing pages; don't reintroduce themed visuals.

### 2026-04-14 · Team page rebuild (Phase 1 + Phase 2)
- **Data:** `data/tasks.json` wiped to `[]` for clean launch. Backup at `data/tasks.json.bak.20260414-153324`.
- **Phase 1 (logic):** Removed Ticket Task type from modal. Removed In Progress + Blocked statuses (Pending → Done only). Mark-as-seen no longer auto-advances status. Hours input hidden on Requested Tasks (both row list and EOD modal). "Open" replaces "Active" on staff card stats.
- **Phase 2 (visual):** Rebuilt Team page with mission-control aesthetic under `body.mission-control` scope. Dark navy panels, cyan/amber glow, monospace labels, scan-line textures, status LEDs. Telemetry strip (mission date, SGT, crew, open, overdue, flagged). Station cards (STN-##). Pilot Console personal view. Three collapsible type sections: [01] SYSTEM CHECKS / [02] INCOMING / [03] OBJECTIVES. EOD → END-OF-WATCH LOG.
- **Memory files added:** `team_page_model.md`, `test_gates.md`.

### 2026-04-14 · Claim + EOD cron corrections
- Claim cert reminders now fire at 7-day + 3-day + past-deadline. Primary → per-project `qs` field (Salve or Alex Mac, not both). CC = boss only. Alex Chew removed from CC (she handles invoice stage, not certification).
- EOD cron: 6:15pm → **6:30pm** boss flag. 7pm staff re-reminder **deleted**. Added 9am next-day re-alert to boss if anyone still missing (inside existing 9am cron as Check 4).

### 2026-04-14 · Outlook calendar integration
- New helpers `createTaskCalendarEvent` / `deleteTaskCalendarEvent` using Graph `/users/{email}/events`.
- Wired to POST /api/tasks, PUT /api/tasks/:id (reassign + due-date change), DELETE /api/tasks/:id, and mark-Done.
- Test gate via `CALENDAR_TEST_OVERRIDE` env var.
- `sendEmail()` helper extended to accept `cc` argument; respects `EMAIL_TEST_OVERRIDE` by zeroing the CC list.

### 2026-04-14 · Ack reminder ladder
- Unacknowledged task reminder now caps at 3 days. Day 3 CCs the boss with `[FINAL FLAG]` subject and stops — escalation IS the signal. Counter stored in `task.ackReminderCount`, flag in `task.ackBossFlaggedAt`.

### 2026-04-14 · Pre-launch gates
- Added `BASIC_AUTH_USER=admin` / `BASIC_AUTH_PASSWORD=user1234` middleware gating every route.
- Added `EMAIL_TEST_OVERRIDE=laiwx@...` and `CALENDAR_TEST_OVERRIDE=laiwx@...` so nothing leaks to real staff pre-launch.

### 2026-04-14 · Dashboard audit + System Map
- Factory panel → attention-only filter (overdue / new / ready-awaiting-pickup). Was showing all 33 items.
- Total Portfolio card removed.
- Dashboard refresh: 60s → 2min on weekly movement + MC panel.
- Dead dashboard code deleted: `loadActions`, `loadSiteRequestAlerts`, `loadOverduePOAlerts`, `bindActionToggle`, `renderTaskAlerts`. Fixed silent TypeError in `bindFilters` (null-safe).
- Added `/api/system-map` endpoint + collapsed "System Map" admin section that renders this file via a minimal inline markdown parser.
