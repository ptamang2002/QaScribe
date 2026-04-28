---
name: coverage-gap-analysis
description: Identify untested flows and edge cases from session evidence
---

# Coverage Gap Analysis Skill

Analyze the action log and identify flows or scenarios that were NOT tested but should be, based on what WAS tested.

## Schema

```json
{
  "untested_flow": "Brief description of the untested scenario",
  "rationale": "Why this matters given what was tested",
  "related_tested_flow": "The flow this gap is adjacent to",
  "suggested_test": {
    "title": "Suggested test case title",
    "key_steps": ["Step 1", "Step 2"]
  },
  "priority": "high" | "medium" | "low"
}
```

## Heuristics for finding gaps

1. **Inverse-of-positive**: if happy path was tested, suggest the negative path
   - Tested: login with valid credentials → suggest: invalid password, locked account, expired session
2. **Boundary conditions**: if a form was filled with valid data, suggest min/max/empty/special-character variants
3. **Auth states**: if a flow was tested while authenticated, suggest the unauthenticated equivalent
4. **Permissions**: if tested as one role, suggest other roles
5. **Error recovery**: if a flow completed successfully, suggest interruption scenarios (network drop, refresh, back button)
6. **Concurrency**: if single-user actions, suggest multi-tab/concurrent scenarios where relevant

## Rules

- Prioritize gaps that are CLOSE to what was tested (high adjacency = high practical value).
- Cap output at 10 most important gaps — don't list everything imaginable.
- Don't suggest gaps the action log already covers; cross-reference flows_observed.

### Evidence requirement (NEW in v2)

- **EVERY gap must be evidence-backed.** The `related_tested_flow` field must reference an action that actually appears in the action log. Do not infer the existence of UI elements (buttons, links, navigation items) that were not observed in the recording.
- If the tester verbally mentioned a UI element they didn't interact with, you may speculate it exists, but mark `priority: "low"` and add a note in the rationale: "Inferred from tester narration; existence not visually confirmed."
- Coverage gaps for "happy path" or "empty fields" or "boundary conditions" are always grounded in adjacency to a tested flow — never standalone speculation.
