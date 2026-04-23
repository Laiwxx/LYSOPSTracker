---
name: Sales CRM full spec (Janessa's framework)
description: Complete sales pipeline spec — Salesforce-style UI, automated follow-ups, email/calendar integration, QS handoff, mandatory call notes.
type: project
originSessionId: 0a49fda5-6ffd-4238-b6de-d05549bed5b0
---
**Sales CRM rebuild spec** — requested by boss, framework by Janessa (sales).

## Pipeline stages

1. **New Lead** — lead enters, auto-email client with calendar booking link
2. **Discovery Call Scheduled** — client picks time slot → reflects on Outlook calendar + CRM
3. **Tender Review** — post-call, sales reads tender docs. Auto-create QS task for quotation.
4. **Quotation** — QS uploads quotation → stage auto-advances. Sales sends recap + zoom link.
5. **Presentation** — zoom call with client. Auto-reminder before call.
6. **Pending Tender** — follow-up calls begin (FU1, FU2, FU3...). 3-4 week intervals.
7. **Tender Awarded** — awarded follow-ups (AFU1, AFU2...) until client issues contract.
8. **Won** — auto-transfer all details to operations (convert-to-project).
9. **Lost** — reason captured.

## Follow-up logic (FU and AFU)

- FU1 scheduled 3-4 weeks after presentation zoom
- If NPU (no pick up) → auto-reschedule same FU in 2 days
- If picked up → schedule next FU in 3-4 weeks
- Steps repeat (FU1, FU2, FU3...) until tender awarded
- Same logic for AFU (awarded follow-ups) after tender awarded stage
- Mandatory call notes on every follow-up

## Automations needed

- Auto-email client with booking link on new lead
- 24hr auto-reminder if client hasn't booked
- Auto-capture PDF attachments from email into opportunity
- Calendar sync (Outlook API) for booked calls
- Auto-create QS task when moving to Tender Review
- Auto-advance stage when QS uploads quotation
- Zoom call reminder emails
- FU/AFU auto-scheduling with NPU retry logic
- Convert-to-project on Won (already exists)

## Email integration

- Send emails from within CRM (like Pipedrive)
- Link incoming emails to opportunities
- Capture PDF attachments automatically

## UI goal

Salesforce-style: stage progress bar, activity timeline, one-page view with all info.

**Why:** "idea is to have all information on one page so sales do not have to use multiple platforms"
