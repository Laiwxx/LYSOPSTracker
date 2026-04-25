---
name: Visual overshoot lesson — don't stack color tints
description: Learning from 2026-04-25 — small visual fixes compound into mess fast. Cap status carriers at 2 per row, never restyle without the user's hard refresh first.
type: feedback
originSessionId: 0967c386-ca88-4f6d-b527-ea812bfdbeaf
---
When iterating on the Factory page redesign on 2026-04-25, I shipped 7 sequential visual changes (card-ify, big bold pills, mobile-only repeat pill, collapse chevrons, view toggles, prefix/number splits, etc.). User flagged the cumulative effect as "messy"; ui-designer agent diagnosed: 9 tinted surfaces fighting per row (card border + header gradient + pill bg + dot + bar all colored). Walked back to "1 color carrier per job" — bar + dot, nothing else.

**Why:** stacking color signals overwhelms the eye even if each individual signal is "subtle". Each iteration on its own seemed reasonable; the sum was visual chaos. Same trap with chrome (border + radius + shadow + margin per element).

**How to apply:**
- **Cap status carriers at 2 per row** (e.g., dot + colored bar). Job code text color is decorative reinforcement, not a primary signal.
- **Don't restyle a UI without the user hard-refreshing first.** The user kept seeing partial changes via cache; multiple "this still feels messy" reactions were baseline drift, not the change itself.
- **One header pattern per list.** Mixing "group-header + sub-rows" with "flat single-product rows" inside the same queue confuses the eye. Render every job the same way (header + N items, even if N=1) — extra vertical space is a worthwhile trade for unambiguous boundaries.
- **Visible boundaries beat negative space.** A 1px top border + 3px colored left bar reads as "new section" much faster than 10px of margin between rows of similar weight.
- **When in doubt, dispatch ui-designer agent BEFORE shipping more.** It pushed back hard on my overshoot and the walk-back was correct. Cheaper than 7 iterations of incremental tweaks.
