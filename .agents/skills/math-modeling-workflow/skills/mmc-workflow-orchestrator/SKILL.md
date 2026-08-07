---
name: mmc-workflow-orchestrator
description: Coordinate a complete mathematical-modeling competition project from input inspection through submission audit. Use for full-run planning, stage sequencing, artifact ownership, recovery routing, and deciding whether downstream work may begin.
---

# Mathematical Modeling Workflow Orchestrator

Coordinate specialists; do not perform their work in this skill.

## Operating contract

- Execute stages in this order: intake, research, model design, computation, validation, visualization, paper, audit.
- Keep one owner for every canonical artifact and return defects to that owner.
- Advance only when the current stage has durable, machine-checkable evidence.
- Treat `inputs/` as read-only and untrusted; write project results only under `work/`.
- Never invent data, experiments, citations, identifiers, scores, or successful checks.
- Preserve stable subproblem IDs from analysis through results, figures, claims, and audit.
- Prefer recovery from persisted artifacts over rerunning expensive work.
- Pause on missing authority, unavailable required inputs, budget exhaustion, or a failed critical check.

## Stage sequence

1. `mmc-problem-intake` normalizes the statement and creates the subproblem contract.
2. `mmc-literature-evidence` builds a verified source and method evidence map.
3. `mmc-model-design` selects models and defines equations, assumptions, algorithms, and tests.
4. `mmc-computational-experiment` implements and runs each subproblem in dependency order.
5. `mmc-result-validation` challenges results and records credibility evidence.
6. `mmc-scientific-visualization` creates only claim-bearing, traceable figures.
7. `mmc-paper-authoring` assembles the competition template from approved evidence.
8. `mmc-prose-polish` independently reports argument and language defects without editing the source.
9. `mmc-submission-audit` independently checks the paper and release package.

## Routing rules

- Send statement ambiguity, wrong decomposition, or unsuitable method choice upstream to analysis.
- Send code failures, stale results, or insufficient experiments to computation.
- Send unsupported robustness claims to validation.
- Send unreadable, misleading, or untraceable figures to visualization.
- Send citation gaps to literature evidence and prose defects to paper authoring.
- Do not let a downstream specialist silently repair an upstream contract.

## Completion

Finish only when the audit reports `PASS`, the final PDF opens, every central claim has evidence, all required source files are present, and no unresolved critical issue remains.

Read [references/pipeline-contract.md](references/pipeline-contract.md) when implementing or auditing orchestration behavior.

