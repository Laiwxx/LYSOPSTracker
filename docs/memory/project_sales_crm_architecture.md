---
name: Sales CRM build architecture
description: Consolidated architecture from 3-agent review — data model, stage transitions, FU engine, automation placement, phased build plan. Ready to implement.
type: project
originSessionId: 0a49fda5-6ffd-4238-b6de-d05549bed5b0
---
## Build Plan (4 phases, 8-12 days)

**Phase 1 (3-4 days):** Pipeline stages + FU engine + mandatory call notes + cron reminders
**Phase 2 (2-3 days):** Email compose from CRM + templates + 24hr nudge
**Phase 3 (2-3 days):** QS auto-task + file attachments + quote auto-advance
**Phase 4 (2-3 days):** Calendar events + dashboard KPIs + mobile + polish

## Pipeline Stages (replacing current 6)
New Lead → Discovery → Tender Review → Quotation → Presentation → Pending Tender → Tender Awarded → Won → Lost

## Key Data Model Fields to Add
- followUps[] array with {id, scheduledDate, type FU1/AFU1, outcome connected/npu/voicemail, notes, completedAt}
- nextFollowUpDate, fuSequence, afuSequence
- bookingLink, nudgeSentAt, discoveryCallDate, qsTaskId, quotationUploadPath, presentationDate
- Stage-specific calendar event IDs

## FU Engine
- Event-driven: on call log save, compute next date (connected → +25 days, NPU → +2 days)
- Cron 9am: email Janessa overdue FUs
- Mandatory notes on every FU — PUT rejects if notes empty
- Same logic for AFU after Tender Awarded

## Automation Placement
- Auto-email on new lead: event-driven in POST handler
- 24hr nudge: cron 9am
- QS task: event-driven on stage change to Tender Review
- Quote auto-advance: event-driven when quotationUploadPath set
- FU reminders: cron 9am
- Calendar events: event-driven, reuse existing createTaskCalendarEvent

## Email Intake (auto-lead detection)
- Poll enquiry@ + Janessa's inbox every 5 min via Graph API Mail.Read (already have permission)
- Configurable keyword list in admin.json: ["RFQ", "Enquiry", "Tender", "Quotation", "Quote", "Price"]
- Match = auto-create draft lead (status: "Unreviewed"), Janessa confirms or dismisses
- Dedup: same sender within 7 days = append to existing lead
- Existing client filter: sender matches open opp = log as activity, not new lead
- Attachments fetched only on confirm (no junk auto-download)
- Start simple with email-first approach, improve filtering over time

## External Tools (don't build)
- Calendly Free for booking links (paste in auto-email)
- Zoom personal meeting room URL (paste in templates)

## Completed (all 4 phases shipped 2026-04-23)
- Phase 1: 9 pipeline stages + FU/AFU engine + mandatory notes + cron reminders
- Phase 2: Inbox scanner (enquiry@) + email compose + 4 templates + 24hr nudge + attachment fetch
- Phase 3: QS auto-task on Tender Review + file upload + quote auto-advance + QS dropdown
- Phase 4: Calendar events (discovery/presentation via Graph API) + enhanced KPIs + mobile stage tabs
- All 6 pre-existing bugs fixed (admin auth, confirm, _busy, filters, hardcoded names, No-Bid)

## Next: Client-facing booking page
- Public page /book/:token — client picks available slot from Janessa's calendar
- Graph API getSchedule confirmed working (tested 2026-04-23)
- Need to decide auto-reply strategy: Option B recommended (auto-reply to new senders only)
- Estimated effort: ~half day

## Future considerations
- Auto-reply on new lead creation (Option B: new sender + keyword = auto-reply with booking link)
- Supplier filtering to avoid false positive auto-replies
