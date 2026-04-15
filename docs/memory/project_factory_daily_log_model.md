---
name: Factory page — daily-log-with-photo accountability model
description: Canonical data model for how Chris logs fabrication progress. Every build event is a log entry with a mandatory photo. qtyDone is derived, not stored. Edits preserved in history.
type: project
originSessionId: a678a956-df23-4faa-96a0-728907c543c9
---
Decided 2026-04-15 after ui-designer + ops-strategist joint review. Overrides the earlier "autosave on blur, drop save button" UX proposal — Chris's updates are deliberate daily log events paired with photo evidence, not live counter edits.

## Workflow
- Chris updates counters **once per day**, not live.
- Every log entry is paired with a **mandatory photo** — no photo, no save.
- Photo is **per individual product**. If Chris logs 3 items in a day, that's 3 separate log events with 3 separate photos.
- **Delta-based:** Chris enters "I built +3 today", not "I'm now at 8 total".
- **Edits allowed** (e.g. to fix a fat-finger +30 that should've been +3), but the edit itself is logged — old value preserved in `editHistory[]`, `editedAt` + `editedBy` stamped. Nobody silently rewrites numbers.
- **Untouched rows = no entry, no nag.** A product Chris didn't work on today doesn't need a log. The page must not nag him about it.
- **Multi-log per day allowed:** Chris can log the same product twice in a day (morning +3, afternoon +2). Each is a separate entry with its own photo. Editing is for *corrections*, not for *appending new work*. Boss: "more photo, more evidence."

## Data model
Each fab row grows a `logs[]` array. `qtyDone` becomes a derivation (sum of all deltas across the logs array), not a stored counter. Display calls `sum(logs.map(l => l.delta))`.

```
project.fabrication[i] = {
  item, totalQty, unit, status, ...existing fields...,
  logs: [
    {
      id: 'log_xxx',              // unique id
      loggedAt: '2026-04-15T09:30:00+08:00',  // ISO with SGT offset
      loggedBy: 'Chris',          // staff name — not hardcoded, comes from session
      delta: 3,                   // positive = built, negative = correction
      photoPath: 'uploads/fab-logs/<projectId>/<fabRowId>/<logId>.jpg',
      note: '',                   // optional ("finished QC", etc.)
      editedAt: null,             // set if this entry has been edited
      editedBy: null,
      editHistory: [              // prior versions preserved — not append-only audit purism,
        {                         // but every edit leaves a trail
          at: '...',
          by: '...',
          delta: <prev>,
          note: '<prev>',
          photoPath: '<prev>'     // prior photo moves here, never orphaned
        }
      ]
    }
  ]
}
```

qtyDone is computed server-side on read, not stored. Clients display `sum(logs[].delta)`. For backwards compat during the migration window, the existing `qtyDone` field can live alongside as a cache — but the source of truth is the logs array.

## Migration
Existing `qtyDone` numbers from before this model shipped become a synthetic "baseline" log entry per fab row:
- `delta` = current qtyDone
- `loggedAt` = migration timestamp
- `loggedBy` = 'system'
- `photoPath` = null (the one case where null photo is allowed — pre-launch data has no photo)
- `note` = 'Pre-launch baseline — no photo available'

Sum still reconciles. Clean one-time migration. After migration, photoPath is mandatory on every new entry.

## Photo storage hygiene
1. **Directory:** `uploads/fab-logs/<projectId>/<fabRowId>/<logId>.jpg` — per-project colocation so a project can be archived/shipped as a unit when it closes.
2. **Client-side compression:** resize to 1600px long-edge, JPEG quality 85 before upload. Phone photos are 4–8MB; this brings them to ~300–500KB. Factory WiFi survives.
3. **EXIF strip on server:** remove GPS coordinates, keep timestamp + orientation.
4. **Async upload queue:** photo captured → previewed instantly → uploads in background → log entry provisional until server confirms. On bad WiFi the modal doesn't block; it retries. Offline = queue in `localStorage`, sync when Chris returns to office WiFi.
5. **No orphans:** if a log entry is deleted, its photo is deleted server-side. If a log entry is edited with photo replaced, old photo moves to `editHistory[].photoPath` — still referenced, never orphaned.
6. **Backup:** `uploads/fab-logs/` must be synced off-server. Current state: `public/uploads/` is in `.gitignore`, so autopush.sh (git-based) does NOT cover photos. Decision 2026-04-15: target destination is the boss's **Hostinger** account. Implementation deferred until photos accumulate (uploads/ is currently empty). Likely mechanism: rsync-over-SSH or SFTP nightly cron. Confirm Hostinger plan supports SSH/rsync before wiring. **Do not ship Phase C without revisiting this.**
7. **Retention:** keep every log photo for project-lifetime + 7 years (SG construction record-keeping standard). No auto-purge.

## UX implications
- **Kills the "autosave on blur, drop 💾 button" proposal** from the ui-designer synthesis. Save MUST be explicit and coupled with a photo.
- **Kills the "move camera to card-level" proposal** from ui-designer. Camera must stay per-row because every log event is per-product. (Ops-strategist's warning — "don't move photos to a gallery, he needs to see 'did I photo this?' at a glance" — was the right instinct.)
- **Kills the independent −/+ counter buttons.** The row no longer has live counters. Instead: one "Log today" button per row that opens the log modal (camera → delta input → save).
- **Row header shows today's progress at a glance:** rows Chris has already logged today show a small "✓ logged today (+3)" indicator. Rows with no log today show nothing or a subtle "—". No nag — just visibility.
- **Timeline view:** tap any row → expand to show full log history, newest first, each entry with thumbnail, delta, timestamp, loggedBy, and an Edit link if the entry is still editable.
- **Edit flow:** tap Edit on a past log → smaller modal, change delta / note / replace photo / save. Old version pushed to `editHistory[]`, new `editedAt` + `editedBy` stamped.
- **The over-sent guardrail gets stronger:** since qtyDone is now derived, the server can validate on every log write that `sum(logs.delta) <= totalQty` (can't log more than the BOM) and that `sum(Delivered SRs.qty) <= sum(logs.delta)` (can't ship what wasn't built). Either becomes a hard block with "reconcile" affordance.

## What this does NOT do
- Does not change fab row status progression (Not Started → In Progress → QC → Ready → Delivered). Those transitions remain a separate concern.
- Does not change the site-request model — SRs still live in `site-requests.json` with `fabIdx` linking.
- Does not move any ownership to /project. /project stays a read-only consolidation.
- Does not require Chris to log anything he didn't touch. No daily "completeness check."
- Does not retroactively require photos on the pre-launch baseline — one free pass for the migration entry only.
