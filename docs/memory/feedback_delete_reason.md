---
name: Delete actions require reason
description: Every user-facing delete must show a reason dropdown before proceeding — never plain confirm()
type: feedback
originSessionId: dc1ba73a-2f84-41fa-8970-3c7921fe2ab5
---
All delete actions must use `confirmDelete(title, itemName)` from utils.js, not `confirm()`.

**Why:** Boss wants audit trail for why things are deleted. Prevents accidental deletes and gives context when reviewing activity logs.

**How to apply:** When adding any new delete button:
1. Import confirmDelete from utils.js (already loaded on all pages)
2. Call `const result = await confirmDelete('Delete this X?', itemName);`
3. If `result` is null, user cancelled — return early
4. `result.reason` contains the selected reason from dropdown
5. Pass `deleteReason: result.reason` to the API if the server logs it

Reasons list: Duplicate entry, Created by mistake, No longer needed, Replaced by another, Data entered wrongly, Client/scope change, Other.

Exceptions (no reason needed): file removals (PDFs), internal array splices during sync, feedback tickets, monday flags, price book entries.
