## User & Preferences
- [User role](user_role.md) — Boss of fabrication/installation ops business; not a dev; expects Claude to spot bugs fast.
- [Token discipline](feedback_token_discipline.md) — cost-conscious; narrow reads, batch parallel, short outputs.
- [Page-by-page workflow](feedback_workflow.md) — scopes work by page, not by feature.
- [Visual style](feedback_visual_style.md) — plain/professional, consistent across pages; no themed aesthetics.
- [Use agents for validation](feedback_use_agents_for_validation.md) — sub-agents for audits; trivial edits stay direct.
- [Sidebar labels in conversation](feedback_use_sidebar_labels.md) — say "Manpower" not "planning page"; user navigates by sidebar label.

## People & Roles
- [People and roles](people.md) — Chris/Teo/Jun Jie/Rena/Alex Chew/Salve/Alex Mac/Janessa/Murugan. Two QSs, Alex Chew = finance only.
- [Page map](page_map.md) — routes, labels, owners. /my-tasks = "Team", /planning = "Manpower", /sales = "Sales" (locked).

## System Architecture
- [System philosophy](project_philosophy.md) — one-role-one-page; ops pages are source of truth; project page is read-only consolidation.
- [Auth system](project_auth_system.md) — session-based login, 11 users, forgot-password, admin-reset, welcome emails.
- [Mobile nav](project_mobile_nav.md) — sidebar hidden ≤768px, hamburger toggle, slide-over drawer via nav.js.
- [Locked pages pattern](feedback_locked_pages.md) — 5-layer access control: server route + static block + PIN gate + API 403 + nav hide.
- [Server management](feedback_systemctl_workflow.md) — always use systemctl restart; never node server.js manually.
- [Test email suppression](test_gates.md) — Scenario Tester check in sendEmail/calendar suppresses test emails.
- [Scenario testing](feedback_testing_standard.md) — mandatory `node tests/scenario-test.js` after every API change, 0 failures.

## Domain Models
- [Tri-layer workflow](project_tri_layer_workflow.md) — fab → site-request → install run concurrently.
- [Factory daily-log model](project_factory_daily_log_model.md) — every build event = log entry with mandatory photo; qtyDone = sum of deltas.
- [Factory DO-PR workflow](project_factory_do_pr_workflow.md) — DO uploads link to PRs; PRs editable while Pending.
- [Parts/BOM design](project_parts_bom_design.md) — Mechanical items have sub-parts; parent auto-derives status.
- [Manpower OT and supply](project_manpower_ot.md) — Mon-Fri 8-5:30, after = OT. Saturday = full OT. Supply workers 10h/day no OT. 72h MOM cap.
- [Manpower Maintenance type](project_manpower_maintenance_type.md) — 5th worker-type added 2026-04-24 (purple, 🛠); dedicated page queued after Sales CRM.
- [Team page model](team_page_model.md) — 3 task types, mark-as-seen (no In Progress), ack ladder, calendar events.
- [Recurring tasks v2](project_recurring_tasks_v2.md) — revised task defs with GM + Finance roles.
- [New project template](project_new_project_template.md) — 20-stage lifecycle, role-based team defaults.

## Code Standards
- [Bug patterns to prevent](feedback_bug_patterns.md) — 16 patterns: _busy locks, safeWriteJSON, race conditions, path traversal, sendEmail, auth, todaySGT, cascades, etc.
- [Visual overshoot lesson](feedback_visual_overshoot_lesson.md) — cap status carriers at 2/row; don't restyle without user hard-refresh; consult ui-designer before iterating.
- [Batch endpoint pattern](project_batch_endpoint_pattern.md) — `/api/<entity>/batch?ids=a,b,c` to kill N+1 fetches; declare before `/:id` route.
- [Delete actions require reason](feedback_delete_reason.md) — every delete uses confirmDelete() with reason dropdown.
- [Role-based notifications](feedback_role_based_notifications.md) — never hardcode names; use staff.json role aliases.
- [Legible metrics](feedback_legible_metrics.md) — if a KPI needs a tooltip, delete it or relabel.
- [Ship complete workflows](feedback_ship_complete_workflows.md) — every create must ship with edit/delete path.
- [Factory page is factory-only](feedback_factory_scope.md) — don't mix other roles' data into an ops page.
- [Suppress test emails](feedback_test_email_suppression.md) — sendEmail/calendar bail for Scenario Tester actor.

## Sales CRM (next major build)
- [Sales UI identity](project_sales_ui_identity.md) — Sales has its own SF-blue palette (#1B96FF) + dedicated sidebar + Pipeline Path chevron bar; do NOT revert to ops styling.
- [Sales pipeline page](project_sales_page.md) — current state: kanban + list view; convert-to-project bridge.
- [Sales CRM full spec](project_sales_crm_spec.md) — Janessa's framework: 9 stages, FU/AFU engine, email compose, QS handoff.
- [Sales CRM architecture](project_sales_crm_architecture.md) — 4-phase build plan (8-12 days), data model, FU state machine, existing bugs to fix.
- [Sales leads are email-bound](feedback_sales_email_bound.md) — all leads via Outlook (enquiry@ + Janessa inbox). Mail.Read permission available. Keyword-based auto-intake.

## Open Items
- [Known data issues](known_data_issues.md) — 15/17 projects missing endDate + siteEngineer.
- [Feedback: EOD edit feature](feedback_mo9cothqexv8.md) — Feature Request by Salve, Medium priority, In Review.
- [Factory redesign done](project_factory_redesign.md) — preview ported to live as of 2026-04-25. 5 follow-up enhancements (item drawer, camera-first mobile, forecast strip, search/filter, skeletons) deferred.
- Custom sub-agents live in `.claude/agents/` — debugger, ops-strategist, workflow-architect, senior-engineer, ui-designer, context-builder.
- [Feedback: project in factory page issue](feedback_moeg0d5q06zq.md) — Bug by Lai Wei Xiang, Medium priority
- [Feedback: Sales button for UIUX import exccel flow](feedback_mohdo0dqcbvz.md) — Feature Request by Lai Wei Xiang, Medium priority
- [Feedback: Excel File](feedback_mohdz1cklqpy.md) — Feature Request by Lai Wei Xiang, Medium priority
- [Feedback: Deal UIUX](feedback_mohe15gg3d64.md) — Feature Request by Lai Wei Xiang, Medium priority