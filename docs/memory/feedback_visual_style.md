---
name: Visual style — prefers plain and professional, not themed
description: User has rejected themed UI aesthetics twice in a row on the Team page; prefers the app to look consistent and professional across all pages
type: feedback
originSessionId: dc23bf86-1afc-4379-814e-dfd86a818bb5
---
The user prefers the app to **look professional and consistent across every page**. Themed / stylized aesthetics get rejected fast.

**Why:** on 2026-04-14 I was asked to make the Team page feel "game-style" — I proposed XP/levels/leaderboards, he said no, he meant the *look and feel*, like a mission-control space console. I then shipped a full mission-control aesthetic (dark navy panels, cyan/amber monospace, status LEDs, "STN-##" station IDs, "CREW STATIONS" / "PILOT CONSOLE" / "[01] SYSTEM CHECKS" labels, telemetry strip). He looked at it and said "revert back to just being professional" / "revert back to the old style." All theming was stripped, but the functional improvements (three type sections, mark-as-seen, hours gating, etc.) were kept. He was willing to iterate on the concept verbally but the *actual rendered result* did not land.

**How to apply:**
- Default to the app's existing design tokens (`var(--bg2)`, `var(--border)`, `var(--text)`, `var(--accent)`, etc.) and existing component classes on any new UI work. Don't introduce a new palette, font family, or visual language for a single page.
- When he says "more interactive" or "more interesting", interpret it as **better information density, clearer hierarchy, useful micro-interactions** — not a new theme.
- If a request is ambiguous ("make it feel like X"), show a small concrete sample or ask for one specific element he wants changed rather than redesigning a whole page.
- Plain English labels beat jargon ("Pending" over "ACTIVE OBJECTIVES", "Submit EOD" over "FILE END-OF-WATCH").
- Emoji status badges (✅ ⚠️ 🔥) are OK — they already exist elsewhere in the app and match his mental model.

**Safe bet when in doubt:** make it look like Factory / Installation / Procurement. Those pages have his implicit approval — they're what he was staring at when he said "looks good enough, just tweak to improve."
