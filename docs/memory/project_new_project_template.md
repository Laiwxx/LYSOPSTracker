---
name: New project template (20-stage)
description: New projects use 20-stage template matching real LYS lifecycle; team defaults from staff.json roles
type: project
originSessionId: dc1ba73a-2f84-41fa-8970-3c7921fe2ab5
---
`buildDefaultProject()` in server.js creates projects with:

**20 stages:** Quotation → Awarded → Contract Review → QS Breakdown → Job Code Created → Kick-off Meeting → Safety Document Submission → Drawing Submission → Drawing Approved → SIC Submission → Assign to Factory → Factory Take-off → PR to Purchaser → PO Issued → Production/Fabrication → Shipping → Delivered → Site Ready → Installation → Handover

**Owners:** Sales, GM, QS, Accounts, PM, PM/SE, Drafter, PM, Factory Manager, Purchaser, Site Engineer

**Blank by default:** documents[], productScope[], fabrication[], installation[], drawings[]

**Why:** The old 11-stage template (LOI → Final Claim) didn't match the real workflow. 14/17 existing projects already used the 20-stage version. deriveStages() auto-derives status for all 20 from live operational data.

**How to apply:** deriveFields() runs on create so currentStage is computed immediately. Team defaults resolve from staff.json role aliases, not hardcoded names.
