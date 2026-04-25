---
name: Sales page has its own UI identity (Salesforce-inspired)
description: Sales workspace is visually distinct from Ops — SF light blue accent, deep navy-blue sidebar, CRM-only nav, Salesforce Pipeline Path chevron bar above the toolbar. Don't revert to ops styling.
type: project
originSessionId: a185d9a3-2337-4ea6-b464-6c758a60a5c2
---
As of 2026-04-24, the Sales page (`public/sales.html`) has a dedicated Salesforce-inspired UI identity. Initial reskin was emerald; user asked to pivot to Salesforce light blue on the same day.

**Scoped palette overrides** live in the inline `<style>` at top of sales.html:
- `--sidebar-bg: #032d5c` (deep SF navy-blue) — distinct from ops `#1a1d2e` (purple-navy)
- `--accent: #1B96FF` (Salesforce bright blue) — was `#3366ff` in ops
- `--accent-dim: #cfe7ff`, `--accent-soft: rgba(27,150,255,0.10)`
- Topbar `#021f42` (darker than sidebar for depth)
- Topbar brand: "**LYS** SALES" with `#79C9F2` on the "LYS" span
- Brand mark gradient: `#1B96FF → #0176D3`

**Sales-only sidebar** (`.sales-sidebar`): no ops nav clutter. Items:
- ← Back to Ops (top)
- Brand block "Sales CRM · Pipeline & Follow-ups"
- Workspace: Pipeline (default active), Leads Inbox (opens inbox panel), Activity (SOON), Templates (SOON)
- Handoff: Convert to Project → new-project.html
- Feedback (pinned bottom via margin-top:auto)

**Salesforce Pipeline Path** (`.sf-pipeline-path` / `#pipeline-path`):
- Chevron bar above toolbar, 9 stages with counts.
- Click a chevron = toggle `filter-stage` dropdown (shares state with existing filter).
- Hidden on mobile (mobile already has stage tabs).
- `renderPipelinePath()` recomputes on every `render()` using filter-product/owner/search context (but NOT stage — since the path IS the stage filter).
- Hooked in via bindEvents() click handler + call at top of render().

**Kanban fix done alongside**: `.sf-board` changed to `repeat(9, minmax(150px, 1fr))` with `overflow-x: auto`. Was previously `repeat(6, 1fr)` for 9 stages — broken layout.

**Why:** User explicitly asked for Sales to "have its own UIUX feeling, away from ops" (Option B — separate sidebar, distinct palette, clean route back) → then specifically asked to replicate Salesforce with light blue.

**How to apply:**
- Do NOT reset sales.html's `:root` overrides or sidebar structure during general audits — they're intentional.
- New Sales features inherit the SF blue accent automatically (most use `var(--accent)`).
- If adding new Sales sub-pages, extend the `.sales-sidebar` pattern (not the ops `.tasks-sidebar` shape).
- When ops pages get visual updates, they stay on navy+electric-blue — do NOT propagate changes into sales.html's scoped palette.
- Next likely Salesforce-replication asks: Highlights Panel redesign on opp detail (existing `.sf-highlight` needs denser key-field grid), Activity Timeline on opp detail (vertical timeline of FUs/calls/emails).
