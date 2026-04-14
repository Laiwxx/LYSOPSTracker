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

## Template for future entries

When a new data issue is found:
- **What:** the symptom
- **Spotted:** date + context
- **Impact:** what breaks or produces wrong output
- **How to find it:** one-liner grep or jq query
- **Fix:** what to change, and whether to ask first
