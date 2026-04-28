---
name: test-case-format
description: Format and schema for test cases generated from QA sessions
---

# Test Case Format Skill

Generate structured test cases from session evidence. Every test case must trace to actual recorded actions.

## Schema

```json
{
  "title": "Short imperative title (e.g. 'Login with valid credentials')",
  "preconditions": ["List of state assumptions before test starts"],
  "steps": [
    {"step_number": 1, "action": "What the user does", "expected_result": "What should happen"}
  ],
  "actual_observed_outcome": "What actually happened in the session",
  "outcome": "pass" | "fail" | "blocked",
  "severity_if_failed": "critical" | "high" | "medium" | "low" | null,
  "tags": ["functional", "ui", "regression", "validation:browser-native", ...],
  "source_timestamps": ["MM:SS", "MM:SS"]
}
```

## Rules

- Each test case must trace back to specific timestamps in the action log.
- Use the exact UI labels seen in the action log — don't paraphrase ("Sign In" not "login button").
- One test case = one user-facing scenario. Don't combine unrelated flows.

### Scope discipline (NEW in v2)

- **NEVER generate a test case for something the tester did not actually perform.** If the tester verbally mentioned a flow they intended to test but didn't actually execute (no corresponding action log entries), do NOT generate a test case for it. Mark it as a coverage gap instead.
- If the action log starts mid-flow (e.g., recording began on /solutions instead of homepage), ONLY generate test cases for what was actually recorded. The "missing" prefix is not a blocked test, it is simply out of scope.

### Step quality

- Test case `steps` must be ACTIONS performed by the tester (Click X, Type Y, Select Z), not state assertions ("Ensure field contains X"). State assertions belong in `preconditions` if the state was already established, or in `expected_result` of the relevant action step.

### Validation type tagging

Always add a `validation_type` tag when validation is involved:
- `validation:browser-native` — HTML5 default validation (e.g., "Please include an '@' in the email")
- `validation:application` — custom app-level validation (rendered by the app's own JS)
- `validation:server-side` — only triggered after submit, returned from server

### Outcome tagging

- Mark `outcome: "fail"` only if there's clear evidence of a bug — don't infer failure from missing steps.
- Use `outcome: "blocked"` ONLY if the tester attempted something but was prevented from completing it by a defect — not for "the tester didn't try this."

### Voice annotation context

If the tester's voice annotation provides intent ("I'm testing the negative path"), include that context in the title or tags.

## Examples

### Good
```json
{
  "title": "Submit feedback form with empty required field",
  "preconditions": ["User is logged in", "On feedback page"],
  "steps": [
    {"step_number": 1, "action": "Click 'Submit' without filling 'Email' field",
     "expected_result": "Validation error shown"}
  ],
  "actual_observed_outcome": "Form submitted successfully without validation",
  "outcome": "fail",
  "severity_if_failed": "high",
  "tags": ["form-validation", "negative", "validation:application"],
  "source_timestamps": ["02:14"]
}
```
