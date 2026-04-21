---
name: Server management via systemctl
description: Always use systemctl to manage the server — never run node server.js manually, never use pm2
type: feedback
originSessionId: 26683c22-6d5e-4b2b-837d-733ec9501be3
---
Always use `sudo systemctl restart ops-tracker` to restart the server. Never `node server.js` directly. Never use pm2 (start/restart/ecosystem).

**Why:** Running node manually or via pm2 creates a process outside systemd's control. When systemd tries to restart, it collides on port 3000, crash-loops, and floods the boss's inbox with crash emails. On 2026-04-21 pm2 had 9,478 restarts fighting systemd for the port.

**How to apply:** Systemd is the ONLY process manager. After any server.js edit, run `sudo systemctl restart ops-tracker`. If port 3000 is occupied, check `pm2 list` and `sudo lsof -i :3000` — kill the rogue process, then restart via systemd. Never install pm2 startup hooks.
