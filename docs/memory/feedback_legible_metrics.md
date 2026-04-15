---
name: Every metric on a page must be legible to a cold-open user
description: Numbers the user can't explain in 3 seconds are noise. Don't ship stats chips/badges/KPIs until you've tested "would the target user understand this label without a tooltip?"
type: feedback
originSessionId: a678a956-df23-4faa-96a0-728907c543c9
---
Every metric on a page must be understandable by a user who opens the page cold, with no tooltip, no training, and no domain jargon the developer invented. If the label requires explanation — delete it or relabel it. Don't defend the math when the real problem is the label.

**Why:** 2026-04-15 Factory page sweep. I shipped a top-of-page stats chip reading "`129 📦 on floor`" where "on floor" was terminology I (not Chris) had adopted from an internal ops-strategist discussion. Mathematically correct: sum of `qtyDone − qtyShipped` across active fab rows. But when the boss opened the page he asked "what is that?" — meaning a real user would not know either. I caught myself defending the formula instead of recognising that the chip was failing its purpose. The boss: *"if i am a user, i open this and see 129 on floor, i wouldn't know what it is, have you considered that?"*

**How to apply:**
- **Before shipping any KPI/chip/badge/summary number, ask: "If Chris (or Rena, or Teo — the actual user) opens this page cold, can they explain what this number is without anyone's help?"** If no, FIX THE LABEL first — don't reflexively delete the metric.
- **Top-of-page chips CAN be valuable as memory aids.** Boss correction 2026-04-15: "it is good for chris to know, afterall we are human, we forget." Across parallel projects, a summary number helps Chris not track totals in his head. The problem isn't the chip existing — it's the chip using jargon the user doesn't own.
- **Distrust labels I invented from specialist-agent conversations.** Ops-strategist, senior-engineer, etc. use domain shorthand ("on floor", "qtyOnFloor", "in production WIP"). Don't carry that shorthand straight into the UI — translate to plain-language labels the target user already uses day-to-day.
- **Numbers that are technically correct but require explanation are worse than no number at all IF the label can't be fixed.** Usually it can. Try relabeling before deleting.
- **Contextual metrics and summary chips complement each other.** A number rendered next to the item it describes carries meaning by proximity. A top-of-page chip carries meaning by being a total the user would otherwise have to compute. Both are fine; neither works if the word is jargon.
- **When I catch myself writing "we could relabel it to X or Y," don't treat that as a red flag — treat it as the actual design work.** Pick one, ship it, iterate. Brainstorming labels IS UX. Just don't ship the jargon version while you're still brainstorming.
- **"Would a non-dev understand this in 3 seconds?"** should be a check I run on every page change that introduces a visible number, not something I remember after the fact. Add it to the mental checklist beside "syntax clean" and "restart clean."
- **When in doubt on a label, ask the boss directly rather than guessing.** Single question, faster than a design iteration loop.
