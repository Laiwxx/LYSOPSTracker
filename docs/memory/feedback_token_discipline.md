---
name: Token discipline — keep token usage low across the board
description: User is cost-conscious about Claude token spend; prefers precise, minimal-token work over verbose narration. Applies to main Claude and all spawned agents.
type: feedback
originSessionId: dc23bf86-1afc-4379-814e-dfd86a818bb5
---
The user wants every Claude interaction on this project (main assistant AND spawned sub-agents) to minimize token spend while staying clear and precise. Tokens cost money; ceremony wastes money.

**Why:** on 2026-04-14 while creating custom sub-agents for the repo, the user said: *"ensure this senior engineer make sure we use as slow [few] token, but as clear, precise in context needed to attain the goal/object we want as well. creating low token spend all the time for us."* He was drafting a `senior-engineer` agent but the instruction applies broadly — he wants cost-efficient work as a default behavior, not a per-agent toggle.

**How to apply:**

1. **Narrow before you read.** Always `Grep` or `Glob` to find the exact lines needed before calling `Read`. Never read a whole 3000-line file to "get a feel" — that's 20,000+ wasted tokens.
2. **Use `offset` + `limit` on `Read`.** Read the specific range, not the whole file.
3. **Don't re-read after editing.** The `Edit` tool errors if it fails. Trust it. Verifying with another `Read` is pure waste.
4. **Batch parallel tool calls.** If 3 independent reads are needed, call all 3 in one message. Sequential reads waste round-trip tokens on restated context.
5. **Keep outputs short.** Text between tool calls ≤ 25 words. Final responses ≤ 100 words unless the task genuinely needs more. No restating the question, no "let me now…", no trailing "I'm done" summaries.
6. **No heading ceremony for small answers.** A 2-sentence answer doesn't need "## Summary" / "## Changes" / "## Next steps" scaffolding.
7. **File:line refs, not code blocks.** Cite `server.js:1947` instead of pasting 20 lines. The user can open the file if they want the code.
8. **Delegate to Explore agent for wide searches.** If a task requires reading 10+ files, spawn a sub-agent with a tight prompt rather than burning main context — the agent's results come back as a compact summary.
9. **Don't narrate reasoning.** Think silently, output decisions. Reasoning belongs in commit messages and PR descriptions, not chat responses.
10. **Stop when done.** Don't keep polishing or adding "improvements" once the ask is satisfied.

**The rule of thumb:** every sentence in a response should either be *state I couldn't have known before* or *a decision the user needs to make*. If it's neither, cut it.
