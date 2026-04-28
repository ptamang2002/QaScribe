---
name: bug-report-template
description: Schema and conventions for generated bug reports
---

# Bug Report Template Skill

Generate a bug report ONLY when the action log contains a clear `errors_or_anomalies` entry or the tester's voice annotation reports a defect. Never invent bugs.

## Schema

```json
{
  "title": "Concise: [Component] Issue summary",
  "severity": "critical" | "high" | "medium" | "low",
  "priority": "P0" | "P1" | "P2" | "P3",
  "environment": "Inferred from evidence (browser/OS) or 'unspecified'",
  "steps_to_reproduce": ["Numbered step in imperative form"],
  "expected_behavior": "What should have happened",
  "actual_behavior": "What did happen, with timestamps",
  "evidence_timestamps": ["MM:SS", "MM:SS"],
  "tester_notes": "Voice-annotated intent if available, else null"
}
```

## Severity guidance

- **critical**: data loss, security exposure, system unusable, financial loss
- **high**: major feature broken, no reasonable workaround
- **medium**: feature works but with significant issues, workaround exists
- **low**: cosmetic, minor UX

## Rules

- Don't speculate about root cause.
- Steps to reproduce must be derived from the action log, not invented.
- If repro steps are unclear, mark `severity: "low"` and add to `tester_notes`.
- Voice annotations like "this is broken" or "expected X but got Y" elevate confidence in the bug.
- When the bug masks a separate test case (e.g., the bug prevents the happy path from being verified), explicitly add to `tester_notes`: "This bug blocks verification of [specific test case]. Re-test happy path after bug fix."
