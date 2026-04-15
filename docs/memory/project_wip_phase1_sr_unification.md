---
name: WIP — Phase 1 site-request unification (Factory page sweep)
description: In-progress handoff. Retiring v1 project.deliveryRequests[], unifying on site-requests.json. DELETE this file when Phase 1 is committed.
type: project
originSessionId: 3982e62d-8a2e-4377-ad60-766b73859530
---
**Status:** In progress as of 2026-04-15. Session interrupted mid-edit. This memory lets any future session resume EXACTLY where the previous one stopped.

**When Phase 1 is committed and verified, DELETE this file and remove its MEMORY.md entry.** It's a transient handoff, not durable knowledge.

## Why we're doing this

Factory page sweep, Bundle 1 evolved into a tri-layer data-model rework after ops-strategist and boss clarifications. Two parallel "site/delivery request" models existed:
- **v1 — `project.deliveryRequests[]`** (embedded on project) — backwards (treated delivery as project-push), only 2 empty legacy stubs.
- **v2 — `site-requests.json`** (top-level file) — correct model, site-pull, created from `/installation` via `POST /api/site-requests`, full ack/ready/delivered lifecycle already wired.

**Decision:** kill v1, unify on v2. Required because:
- Site-requests are pull signals from install team, not project-page push
- Fab + ship + install are THREE concurrent progressions (see `project_tri_layer_workflow.md`)
- The `/project` page is supposed to be read-only consolidation per one-role-one-page philosophy — the Delivery Requests tab was writing, violating that

## Phase 1 scope (what THIS work is)

Cleanup only. No new features, no new UX. Delete wrong model, point right model at the places v1 used to live.

1. ✅ Delete 2 empty legacy DR stubs from projects.json
2. ✅ Remove `deliveryRequests` field from all projects + from `buildDefaultProject` initializer
3. ✅ Remove server.js Trigger 1 (new-DR email on full-project PUT)
4. ✅ Remove server.js PUT `/api/projects/:id/delivery-requests/:reqId` route
5. ⏳ **PENDING — Rewrite noon cron (server.js ~2384) to read site-requests**
6. ⏳ **PENDING — Switch factory-queue deliveryMap derivation (server.js ~1005) to read site-requests.json**
7. ⏳ **PENDING — Remove `+ New Delivery Request` write path in public/js/project.js (addBtn.onclick at ~1792)**
8. ⏳ **PENDING — Remove DR edit/save/delete handlers in public/js/project.js (~1942-2014)**
9. ⏳ **PENDING — Rewrite `renderDeliveryRequestsTab` + `buildDeliveryRequestCard` in project.js as read-only view of site-requests filtered by projectId. Rename UI label to "Site Requests".**
10. ⏳ **PENDING — Verify no other references to `deliveryRequests` in codebase (grep)**
11. ⏳ **PENDING — Syntax check + restart + smoke test**

## Edits already shipped this session (DO NOT redo)

In `server.js`:
- **~line 909** — deleted the "Trigger 1: New delivery request → notify Chris" block (was 20+ lines iterating new DR ids). The comment `// Trigger: project status changed to Delayed → notify project manager` now immediately follows `}` at the end of the doc-check loop.
- **~line 1189** — deleted entire `PUT /api/projects/:id/delivery-requests/:reqId` route handler. `/api/notify/delivery-acknowledged` stub route now follows the delivery-requests section comment directly.
- **~line 1494** — removed `deliveryRequests: data.deliveryRequests || []` from `buildDefaultProject` return object. Last field is now `drawings: data.drawings || [],`.

In `data/projects.json`:
- All `deliveryRequests` fields removed (was only present on 2 projects with empty stubs).

## Edits still pending (exactly what to ship next)

### A) server.js — noon cron rewrite (around line 2384)

**Find:**
```js
// Trigger 2: Noon weekdays — remind Chris about unacknowledged DRs > 24hrs
cron.schedule('0 12 * * 1-5', async () => {
  try {
  console.log('[CRON] Noon delivery request reminder check...');
  const projects = readProjects();
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  for (const p of projects) {
    const stale = (p.deliveryRequests || []).filter(r =>
      r.ticketStatus === 'New' && r.requestedAt && r.requestedAt < yesterday
    );
    if (stale.length > 0) {
      const chrisEmail = getStaffEmail('Chris');
      if (chrisEmail) {
        await sendEmail(chrisEmail, 'Chris',
          `[Reminder] Unacknowledged Delivery Request — ${p.jobCode}`,
          `<p>Hi Chris,</p>
          <p>A delivery request for <strong>${p.jobCode}</strong> has been waiting for your acknowledgement for over 24 hours.</p>
          <p>Items: ${stale.map(r => r.item).join(', ')}</p>
          <p><a href="${APP_URL}/project.html?id=${p.id}">Open OPS Tracker →</a></p>`
        );
      }
    }
  }
  } catch (e) { logError('cron.noon-dr', e); }
}, { timezone: 'Asia/Singapore' });
```

**Replace with:**
```js
// Trigger 2: Noon weekdays — remind Chris about unacknowledged site requests > 24hrs
cron.schedule('0 12 * * 1-5', async () => {
  try {
    console.log('[CRON] Noon site-request reminder check...');
    const srs = readSiteRequests();
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const stale = srs.filter(r => r.status === 'New' && r.createdAt && r.createdAt < yesterday);
    if (!stale.length) return;
    // Group by project so each project gets one email, not one per item
    const byProject = {};
    stale.forEach(r => {
      const key = r.projectId || '__unlinked__';
      if (!byProject[key]) byProject[key] = { jobCode: r.projectJobCode, projectName: r.projectName, items: [] };
      byProject[key].items.push(r);
    });
    const chrisEmail = getStaffEmail('Chris');
    if (!chrisEmail) return;
    for (const key of Object.keys(byProject)) {
      const group = byProject[key];
      const label = group.jobCode || group.projectName || '(no project)';
      await sendEmail(chrisEmail, 'Chris',
        `[Reminder] Unacknowledged Site Request — ${label}`,
        `<p>Hi Chris,</p>
        <p>A site request for <strong>${label}</strong> has been waiting for your acknowledgement for over 24 hours.</p>
        <p>Items: ${group.items.map(r => `${r.item} (${r.quantity} ${r.unit || ''})`).join(', ')}</p>
        <p><a href="${APP_URL}/factory">Open Factory dashboard →</a></p>`
      );
    }
  } catch (e) { logError('cron.noon-sr', e); }
}, { timezone: 'Asia/Singapore' });
```

### B) server.js — factory-queue deliveryMap (around line 1005)

**Find:**
```js
    // Build delivery request map keyed by item name (lowercase)
    // Source: project.deliveryRequests[] — dedicated delivery tab
    const deliveryMap = {};
    for (const req of (p.deliveryRequests || [])) {
      const key = (req.item || '').toLowerCase().trim();
      const isDelivered = (req.ticketStatus || req.status) === 'Delivered';
      if (key && !isDelivered) {
        // Multiple requests for same item: keep earliest neededByDate
        if (!deliveryMap[key] || (req.neededByDate && req.neededByDate < deliveryMap[key].neededByDate)) {
          deliveryMap[key] = req;
        }
      }
    }
```

**Replace with:** (uses `allSRs` hoisted once per request for efficiency; hoist `const allSRs = readSiteRequests();` BEFORE the `for (const p of projects)` loop, around line 979)

```js
    // Build delivery request map keyed by item name (lowercase)
    // Source: site-requests.json filtered by projectId (retired project.deliveryRequests[] 2026-04-15)
    const deliveryMap = {};
    for (const sr of allSRs) {
      if (sr.projectId !== p.id) continue;
      if (sr.status === 'Delivered') continue;
      const key = (sr.item || '').toLowerCase().trim();
      if (!key) continue;
      // Multiple requests for same item: keep earliest neededByDate
      if (!deliveryMap[key] || (sr.neededByDate && sr.neededByDate < (deliveryMap[key].neededByDate || '9999'))) {
        // Normalize to the shape the downstream `items.map` already expects:
        // it reads req.neededByDate, req.phase, req.requestedBy, req.acknowledgedAt,
        // req.inProductionAt, req.id, req.ticketStatus. Site-requests don't have
        // phase/inProductionAt/ticketStatus — substitute from status field.
        deliveryMap[key] = {
          id:              sr.id,
          item:            sr.item,
          neededByDate:    sr.neededByDate || '',
          phase:           '', // site-requests don't track phase — future enhancement
          requestedBy:     sr.requestedBy || '',
          acknowledgedAt:  sr.acknowledgedAt || null,
          acknowledgedBy:  sr.acknowledgedBy || '',
          inProductionAt:  null, // not in SR model
          ticketStatus:    sr.status || 'New',
        };
      }
    }
```

And at the top of the `/api/factory-queue` handler (around server.js:975), ADD after `const projects = readProjects();`:
```js
  const allSRs = readSiteRequests();
```

### C) public/js/project.js — UI rewrite (around line 1778)

Current `renderDeliveryRequestsTab()` reads `project.deliveryRequests` directly (synchronous). New version must fetch site-requests, filter by `projectId === project.id`, and render read-only.

Add at top of `renderDeliveryRequestsTab`:
```js
async function renderDeliveryRequestsTab() {
  const list = document.getElementById('delivery-requests-list');
  if (!list) return;

  // Also update the section header label if present (was "Delivery Requests", now "Site Requests")
  const hdrLabel = document.querySelector('[data-tab-label="delivery-requests"]');
  if (hdrLabel) hdrLabel.textContent = 'Site Requests';

  list.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">Loading…</p>';
  let srs = [];
  try {
    const res = await fetch('/api/site-requests');
    if (res.ok) srs = await res.json();
  } catch (e) { console.error('[project] site-requests fetch failed:', e); }

  const mine = srs.filter(r => r.projectId === project.id);
  list.innerHTML = '';

  if (!mine.length) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">No site requests for this project yet. Site team raises requests from the Installation page.</p>';
  } else {
    mine.forEach(sr => list.appendChild(buildSiteRequestCardReadonly(sr)));
  }

  // Hide the + New Delivery Request button — site-requests are pull-from-site, not push-from-project
  const addBtn = document.getElementById('delivery-add-btn');
  if (addBtn) addBtn.style.display = 'none';
}
```

Then ADD a new function `buildSiteRequestCardReadonly(sr)` that renders item/qty/neededBy/requestedBy/status as read-only chips. Model after the existing `buildDeliveryRequestCard` BUT strip all input fields, edit handlers, and save/delete buttons.

DELETE the old `buildDeliveryRequestCard` function entirely (project.js ~1822 onward — find it via grep).

DELETE the edit/save/delete handlers at project.js:1942-2014 (the block that does `Object.assign(project.deliveryRequests[idx], updates)` and `project.deliveryRequests.splice(idx, 1)`).

### D) Grep check

Before restart, run:
```
grep -rn "deliveryRequests" /home/ubuntu/ops-tracker --include="*.js" --include="*.html"
```

Expect zero matches. If anything remains, investigate.

## Current task list state

Task IDs from this session (may not be valid in a new session — recreate if needed):
- #1 ✅ Delete 2 empty legacy DR stubs from projects.json
- #2 ⏳ Remove + New Delivery Request write path in project.js
- #3 ⏳ Rebuild delivery-requests-list as read-only site-requests view
- #4 🟡 Retire PUT /api/projects/:id/delivery-requests/:reqId route (DONE but marked in_progress — also handled Trigger 1 removal + buildDefaultProject cleanup here)
- #5 ⏳ Switch factory-queue to read site-requests not deliveryRequests
- #6 🟡 Check EOD reminder code path — confirmed: noon cron at ~2384 needs rewrite (code included above in section A)

## Verification plan

1. `node -c server.js` — syntax check
2. `bash /home/ubuntu/restart-app.sh` — restart service
3. Open `/factory` — fab cards should render with no delivery-request metadata (since only 1 SR exists and it's Delivered). No crashes.
4. Open `/project` on any active project → Site Requests tab — should render "No site requests for this project yet" or a read-only card with the 1 Delivered SR if you open bd-25225-nakano-st-eng-dc.
5. Grep for `deliveryRequests` in codebase — expect 0 hits.
6. Check `data/errors.log` for new entries after restart — expect clean.

## Rollback

If something breaks: `git diff server.js public/js/project.js data/projects.json` to see exactly what Phase 1 changed. `git checkout` any single file to revert piecewise.

## Next phases (don't start these until Phase 1 is verified)

- **Phase 2:** Add `fabIdx` to SR create flow on /installation. Server derives qtyShipped/qtyOnFloor on factory-queue. Factory card UX `40 built / 103 · 20 shipped · 20 on floor`. Retire `readyForDelivery` boolean. Split route `POST /api/site-requests/:id/split` with `{readyQty}`.
- **Phase 3 (Installation sweep):** Teo's mirror card `at factory / on site / installed`. Non-blocking banner when `qtyInstalled > qtyShipped`.
- **Phase 4 (Project page sweep):** 5-bucket consolidated row per item: `SP400 33 queued · 70 built · 30 floor · 20 site · 20 installed (of 103)`.

See also:
- `project_tri_layer_workflow.md` — the tri-layer data model this work is building toward
- `project_page_sweep_status.md` — page-by-page status (Factory page is NOT yet marked stable)
- `feedback_use_agents_for_validation.md` — the boss prefers senior-engineer / ops-strategist agents for validation/design calls

## Strategist verdict reference (for context on WHY Option C was picked)

ops-strategist verdict 2026-04-15: Option C (tranches live on site-requests, fab row stays single source of truth for built-inventory) with these refinements:
- No `installIdx` — match by item name at layer 1↔3 (Teo owns both sides, single operator, no handoff)
- `qtyInstalled > qtyShipped` → soft warn, not hard block (rule: `qtyOnSite = max(0, qtyShipped - qtyInstalled)`)
- Factory card shows fab+ship+on-floor only — NO install count on fab card (one-role-one-page)
- 5-bucket unit journey belongs on `/project` read-only consolidation
- Lock schema before touching UI
