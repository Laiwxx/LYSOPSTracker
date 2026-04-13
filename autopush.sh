#!/bin/bash
cd /home/ubuntu/ops-tracker
git add -A
git diff --cached --quiet && echo "Nothing to push" && exit 0
git commit -m "Auto-backup: $(date '+%Y-%m-%d %H:%M SGT')"
git push
echo "GitHub synced ✅"
