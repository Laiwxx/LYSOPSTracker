---
name: Known data issues in projects.json
description: Data integrity issues spotted during development that haven't been fixed yet — flag if they come up in future work
type: project
originSessionId: dc23bf86-1afc-4379-814e-dfd86a818bb5
---
Open data issues in `data/projects.json` that should be cleaned up at some point. None of them break the app today, but they produce wrong outputs in automations.

## At least one project has `qs = "Lai Wei Xiang"` (should be Salve or Alex Mac)

**Spotted:** 2026-04-14 when seeding mandatory tasks. The 9am install-complete-note cron assigned a task to "Lai Wei Xiang" as the project QS. That's wrong — Lai is the boss/PM, not a QS. Every project's `qs` field should be either `"Salve"` or `"Alex Mac"`.

**Impact:** the install-complete note task ended up on the boss's task list instead of the actual QS's. Also means claim cert reminders (9am cron Check 2) may route to the wrong person for that project, because they use `project.qs` for primary recipient.

**How to find it:**
```bash
grep -B1 '"qs": "Lai Wei Xiang"' data/projects.json
```
Or any `"qs"` value that isn't Salve / Alex Mac.

**Fix:** edit `data/projects.json` and set `qs` to the correct person for each affected project. Back up first:
```bash
cp data/projects.json data/projects.json.bak.$(date +%Y%m%d)
```

**Don't fix silently** — the boss should pick which QS owns that project. Ask first, then edit.

---

---

## Open security issue: GitHub PAT embedded in `.git/config` remote URL

**Spotted:** 2026-04-14 while setting up the memory backup-to-repo flow. `git remote -v` showed the origin URL contains a literal GitHub Personal Access Token (`github_pat_...`). Anyone who gets a copy of `.git/config` has full GitHub API access to Laiwxx.

**Impact:** worst-case, full compromise of the GitHub account — push/force-push/delete any repo, rotate keys, create secrets. Embedding PATs in remote URLs is always a leak risk.

**Fix (user action required — cannot do without the user):**
1. GitHub → Settings → Developer settings → Personal access tokens → find the one starting with `github_pat_11CAQF2RY0Qh...` → Revoke.
2. Strip the token from the remote: `git remote set-url origin https://github.com/Laiwxx/LYSOPSTracker.git`
3. Generate a fresh PAT and use it via a git credential helper, a `~/.netrc`, or the default git credential prompt — not embedded in the URL.

**Check on each session:** run `git remote -v`. If the URL still contains `github_pat_`, remind the user to finish the fix.

---

## Auto-backup cron creates root-owned files in `.git/objects`

**Spotted:** 2026-04-15 17:47 SGT. Running `autopush.sh` interactively failed with `error: insufficient permission for adding an object to repository database .git/objects` on every write. Investigation found 56 files under `/home/ubuntu/ops-tracker/.git/objects/` owned by `root:root` with timestamps matching the 15:00 SGT auto-backup run — so whatever schedules the auto-backup (`cron`, `systemd`, or similar) is running it as root instead of as `ubuntu`.

**Impact:** mixed ownership of `.git/objects` makes subsequent interactive git commits from the `ubuntu` user fail silently (well, noisily — but the error is misleading). Every time the user manually runs autopush between cron firings, they'll hit this until someone fixes the cron. It also creates a subtle risk that roll-backs, amends, or rebases could corrupt the tree since git expects all objects to be writable by the committing user.

**How to find it:**
```bash
find /home/ubuntu/ops-tracker/.git -not -user ubuntu | head
```

**Workaround (temporary):** run once to reclaim ownership whenever the commit fails.
```bash
sudo chown -R ubuntu:ubuntu /home/ubuntu/ops-tracker/.git
```

**Real fix:** check what's firing the auto-backup and make it run as `ubuntu`.
```bash
sudo crontab -l                 # if root cron, move to user crontab
crontab -l                      # check ubuntu's cron
systemctl list-timers           # look for ops-tracker or autopush timers
```
Either (a) move the entry from `root`'s crontab into `ubuntu`'s crontab, or (b) if it must stay in root's crontab, change the line to `su ubuntu -c '/home/ubuntu/ops-tracker/autopush.sh'`.

**Don't fix silently** — the boss scheduled the backup, he should decide which user should own it.

---

## Pending boss input — productScope mismatches (2026-04-25)

Four projects have `productScope` issues that need the boss's external knowledge to resolve. Don't auto-fix; ask before touching.

### BD 19121 — CityScape Gate qty drift

**What:** `productScope` says CityScape Gate qty=4, `fabrication[]` row says totalQty=1. Whitespace mismatch already trimmed 2026-04-25, but the qty disagreement remains. **Question for boss:** is the contract for 1 gate or 4?

**How to find it:**
```bash
node -e "const p=require('./data/projects.json').find(x=>x.id==='bd-19121-rbss-dnr'); console.log(p.productScope.find(s=>s.item==='CityScape Gate'), p.fabrication.find(f=>f.item==='CityScape Gate'));"
```

### BD 21222 — M30 Arm Barrier type/fab mismatch

**What:** `productScope[0]` is marked `type: "Overseas Order"` (so factory-queue should skip it) but a `fabrication[0]` row exists for it anyway. Chris will see it on the queue and may try to fabricate something we're importing. **Question for boss:** do we fabricate this locally, or is it overseas? Either delete the fab row OR change scope type.

### BD 25426 — Woh Hup WCP partial-qty blob

**What:** Original `productScope` blob mentioned 5 products but only 1 (`Crash Rated Fixed Bollard - 100 No's`) has an explicit qty in the source string. The other 4 (Road Blocker, Auto Bollard, Security Fence, Security Gate) have NO qty mentioned. Splitting would invent qtys. Left as the original single blob row. **Question for boss:** what's the contracted qty for each of the 5 products?

### PJ10726 — Clementi Close generic line

**What:** `productScope[0].item` is `"Railing / Cat Walk Metal Works"` qty=1 — generic, not item-grained. No factory-queue auto-population, no per-item progress tracking possible. **Question for boss:** what are the actual products + qtys for this project?

---

## Fixed 2026-04-25 (no further action needed)

Done in commit on 2026-04-25 after data integrity audit:
- BD 23525 (China Harbour 8SW) — empty-string placeholder removed.
- BD 23925 (Chong Pang ID) — blob row split into 2 normalized rows (ATG SP400 ×18, SS Safety Bollard ×32).
- BD 24425 (Qing Feng Somerset) — blob row split into 3 rows (SP30 Fixed ×12, Sleeve ×12, Removable SS ×8).
- BD 25325 (Sam Lain TT Tuas) — boilerplate prefix stripped, qty preserved at 1.
- PJ10025 (ICA Kallang) — blob row split into 6 rows (4 column types + 2 wall types) with explicit qtys.
- BD 19121 (RBSS DNR) — trailing whitespace trimmed on CityScape Gate scope item.

---

## Template for future entries

When a new data issue is found:
- **What:** the symptom
- **Spotted:** date + context
- **Impact:** what breaks or produces wrong output
- **How to find it:** one-liner grep or jq query
- **Fix:** what to change, and whether to ask first
