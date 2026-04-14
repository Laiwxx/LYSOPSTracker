---
name: user role and expectations
description: Who the user is, what their job is in the business, and how they expect to collaborate with Claude on this app
type: user
originSessionId: 4f0102b2-2b4d-4bce-a544-be0d6b8499f2
---
Lai Wei Xiang runs an ops/construction business (fabrication + installation of crash-rated items, bollards, gates, etc.) in Singapore. He is the **boss/strategy** seat — not a developer by training. The ops-tracker app is his replacement for the email/WhatsApp/Excel/paper chaos his team was running before.

He opens the **Dashboard** as his morning briefing and wants it to answer five questions fast: what's moving, is prod/install on track, who's MC today, any stuck site requests / overdue materials / coordination issues, and what's the week's focus. He explicitly does NOT want to see everything — just what needs his attention.

His team has dedicated "one role = one page" owners: **Chris** (factory manager, `/factory`), **Teo** and **Jun Jie** (site engineers, `/installation`), **Rena** (procurement, `/procurement`), **Alex Chew** (accounts, claims CC), **Salve** (QS), plus a GM, PM, drafter, sales. Chris plans manpower via `/planning`. Each person should only need their own page; project detail (`/project.html`) is the single source of truth viewed by the boss.

How he wants Claude to collaborate: treat him like a non-developer boss. Spot mistakes sharper and faster than he can — he literally said "you are my eyes." Don't bury the lede in jargon. When he calls out a list of broken things, verify each one before building, because he may be looking at a stale browser or misunderstanding what's already shipped.
