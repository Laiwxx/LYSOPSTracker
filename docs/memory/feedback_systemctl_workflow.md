---
name: Server management via systemctl
description: Always use systemctl to manage the server — never run node server.js manually
type: feedback
originSessionId: afbc3daa-39c7-4fe3-8fb0-04c02f1b5d12
---
Always use `sudo systemctl restart ops-tracker` to restart the server, never `node server.js` directly.

**Why:** A manual `node server.js` creates an orphan process outside systemd's control. When systemd tries to restart, it collides on port 3000, crash-loops, and floods the boss's inbox with crash emails (22,000+ in one incident on 2026-04-20).

**How to apply:** After any server.js edit, run `sudo systemctl restart ops-tracker`. To check status: `systemctl status ops-tracker`. To tail logs: `journalctl -u ops-tracker -f`. Error logs at `/var/log/ops-tracker.err.log`, stdout at `/var/log/ops-tracker.log`.
