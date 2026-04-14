# LYS Ops Tracker — System Map

Living reference for every page and automation in the app. Keep this file up to date as the source of truth for how the system is structured, so it can be rebuilt or extended without digging through code.

**Last updated:** 2026-04-14

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
**Purpose:** Personal task list + internal request system. Each staff member sees their own tasks, can create self-tasks, request tasks from teammates, or link tasks to open tickets. EOD submission happens here.

**Task types:**
- **Self Task** — personal to-do
- **Requested Task** — one staff asks another (has `requestedBy` + `assignedTo`)
- **Ticket Task** — linked to an open item in the Feedback system

**Views:** Team grid (all staff cards) → click into Personal view (Pending / In Progress / Completed sections) → EOD submission at the bottom.

**Mandatory recurring tasks:** Auto-created daily at 8:45am weekdays, per role (Chris, Rena, Alex Mac, Salve, Teo, Jun Jie). Monday-only extras exist for weekly planning tasks. Templates live in `server.js` `RECURRING_DEFS`.

**Data sources:** `/api/tasks`, `/api/tasks/:id/acknowledge`, `/api/tasks/:id/hours`, `/api/eod-log`, `/api/tickets`

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
| **6:00pm** Mon–Fri | EOD reminder | Emails each staff member their today's tasks + "submit EOD" button. |
| **6:30pm** Mon–Fri | EOD flag to boss | Writes `eod-flags.json`, appends to history, emails boss a list of anyone who hasn't submitted. |
| **Monday 00:01** | Weekly archive | Archives last week's Done tasks. |

## Email override

All outbound email routes through `sendEmail(to, name, subject, html, cc)`. `EMAIL_TEST_OVERRIDE` env var redirects every recipient (and zeros the CC list) to a single address — used for pre-launch testing to prevent leakage to real staff.

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
