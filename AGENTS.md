# Mandatory Code Quality Requirements

These requirements apply to every change, regardless of language, project size, or whether the change appears minor.

## 1. Full-code investigation when a defect is found

Whenever CodeRabbit, CodeQL, another automated tool, a test, or a human review identifies a defect or potential defect:

- Do not restrict the investigation to the reported line or finding.
- Read the entire affected file and inspect the surrounding implementation.
- Trace relevant callers, callees, dependencies, data flows, error paths, state transitions, and related features.
- Search the repository for other occurrences of the same pattern and for related defects.
- Review the wider codebase wherever the issue could have systemic implications.
- Identify and fix all confirmed defects discovered during the investigation, not merely the original finding.
- Add or update regression tests where appropriate.
- Re-run relevant tests, builds, linters, static analysis, and security checks after the fixes.
- Review the resulting changes again. Repeat the investigation and verification cycle until no known actionable issues remain.

Treat a finding as a signal to investigate the quality of the surrounding implementation, not as an isolated task to silence. Closing or resolving a review thread without correcting and verifying the underlying defect is not a fix.

## 2. Quality gate before every push

Never push code to GitHub unless it has been reviewed and verified to meet the highest reasonably achievable quality standard for the project.

Before pushing:

- Review the complete diff, including every changed and newly added file.
- Check correctness, security, reliability, error handling, edge cases, accessibility where relevant, maintainability, and consistency with the project's architecture and conventions.
- Consider regressions and interactions with existing functionality; do not assume that a small diff has a small risk.
- Run all relevant tests, builds, formatters, linters, static analysis, and security scans available for the project.
- Address all known actionable defects and review findings. Do not dismiss findings merely because they are inconvenient, difficult to reproduce, or outside the immediate scope of the change.
- Verify that tests actually exercise the changed behavior and that passing checks are not being mistaken for proof that the implementation is defect-free.
- Inspect the final diff once more after all fixes and checks.

Do not push incomplete, inadequately reviewed, knowingly defective, or questionable code simply to make progress or obtain feedback from CI or reviewers. CI, CodeRabbit, CodeQL, and human review are additional safeguards, not substitutes for doing the engineering work before pushing.

If a required check cannot be run, or a finding cannot be resolved, do not silently proceed with the push. Investigate alternatives and clearly report the specific blocker, its impact, and the evidence available. A push despite an unresolved blocker requires explicit authorization; never present such a push as fully verified.

**Quality is a prerequisite for pushing, not work to defer until after the push.**
