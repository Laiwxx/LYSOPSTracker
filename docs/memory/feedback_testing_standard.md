---
name: Scenario testing is mandatory before shipping
description: Always run backend scenario tests after code changes. Test file at tests/scenario-test.js. 22 baseline scenarios must pass.
type: feedback
originSessionId: 59570639-312c-46cb-93ee-76a2a1eef8e6
---
Scenario tests are the gate before any code is considered done. Run `node tests/scenario-test.js` after every server.js or API-touching change.

**Why:** Boss marked this as critical. The app is pre-launch with real staff about to use it. Bugs that pass code review but fail at runtime are unacceptable.

**How to apply:**
1. After editing server.js or any API route: run `node tests/scenario-test.js`
2. All 22 baseline tests must pass (0 failures)
3. When adding a new API feature, add corresponding test scenarios to the test file
4. The test file self-bootstraps (creates temp credentials, temp admin pin, cleans up after)
5. Test categories: Auth, Data Integrity, Email Routing, Date Handling, Edge Cases
6. If a test fails, fix the code — don't skip or weaken the test

**Test file:** `tests/scenario-test.js`
**Run:** `node tests/scenario-test.js`
**Pass criteria:** 0 failures, all scenarios PASS
