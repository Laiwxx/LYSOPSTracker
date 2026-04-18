---
name: Factory DO-PR workflow
description: Delivery Orders link to Purchase Requisitions; PRs editable while Pending; full tracking on procurement page
type: project
originSessionId: ac003d06-ee3e-4b9d-bdd5-1ef224590e88
---
The factory page has two connected workflows for materials:

**Purchase Requisitions (PRs):**
- Chris creates PRs from factory page → emails Purchaser (role-based) + CC boss
- Pending PRs shown on factory page (capped at 5, expandable). Edit + delete available while Pending.
- PR number is editable (auto-generated but can be corrected if numbers jump)
- Once Rena processes (adds PO → Ordered), PR drops off factory page → lives on /procurement
- PO created and Delivered status changes email Factory Manager role

**Delivery Orders (DOs):**
- Chris photos a DO → picks which PR it's for from a dropdown of open PRs → saves with notes
- Stored in `data/delivery-orders.json` with prId, prNumber, projectCode, notes, uploadedBy, uploadedAt
- Last 10 shown on factory page with file link + PR link + delete
- API: GET/POST/DELETE `/api/delivery-orders`

**Why:** DO photos were previously orphaned (uploaded to disk with no metadata). Now linked to PRs so procurement can match deliveries to orders.

**How to apply:** When building the procurement page sweep, read `delivery-orders.json` to show DOs linked to each PR. The site confirmation step (installation page acknowledges receipt) is deferred to the installation sweep.
