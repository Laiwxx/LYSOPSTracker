---
name: Sales pipeline page
description: Sales page architecture, access control, stages, data model, and design decisions
type: project
originSessionId: ed57ab64-2d25-4376-af42-d133a30aa47a
---
## Sales Pipeline Page (`/sales` → `public/sales.html`)

**Owner:** Lai Wei Xiang + Janessa (edit), Alex Chew (read-only)

**Access control — 3 layers:**
1. **Server route** (`server.js` line ~250): `/sales` and `/sales.html` check session user against `SALES_ALLOWED` set. Non-authorised users redirected to `/`.
2. **PIN gate** (frontend): admin PIN required before content loads. Uses `/api/admin/pin` verify endpoint — same password as Admin page.
3. **API 403**: `SALES_ACCESS` (write) and `SALES_READ` (read) sets on all `/api/sales/*` endpoints.

**Nav link** hidden by default (`display:none`) on all pages. `nav.js` checks `/api/auth/me` and shows only for authorised users.

**Stages:** Enquiry → Site Visit → Quotation Sent → Negotiation → Won → Lost (+ No-Bid in dropdown)

**Data model** (`data/opportunities.json`):
- clientName, contactPerson, phone, email, siteAddress
- productType, estimatedValue, quotationNo, quoteDate, quoteExpiryDate
- source, stage, stageChangedAt, followUpDate, assignedTo
- notes, winLossReason, competitorInfo, convertedProjectId
- activity[] (timeline entries with ts, type, note)
- createdBy, createdAt

**UI:** Salesforce Lightning-inspired — KPI bar, kanban board with drag-and-drop, table/list view, detail side panel with stage path component, collapsible sections, activity timeline with composer.

**Convert to Project:** Won opportunities can be converted — creates project record with client/contact/value/address carried over.

**Why:** Boss wanted CRM-style pipeline tracking for 10-30 active opportunities. Salesforce-style UI was explicitly requested.
