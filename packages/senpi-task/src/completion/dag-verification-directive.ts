// Appended to model-facing DAG completion payloads only. A DAG node's own summary is unverified
// self-report, so the orchestrating parent is told to re-derive the node's scope and prove every
// deliverable itself before treating the node as done.
export const DAG_VERIFICATION_DIRECTIVE = `DAG SUBAGENT COMPLETION - TREAT AS FALSE UNTIL YOU PROVE IT.
This completion arrived from a DAG subagent. Assume it overstated or fabricated its work. Its summary is a CLAIM, not evidence.
Before relying on this result you MUST, in order:
1. RECONSTRUCT the node's full work scope from its prompt: every deliverable, file, and check it owed.
2. READ the actual artifacts yourself - open every file it claims it changed, run the commands it claims pass. Transcripts and summaries prove NOTHING.
3. VERIFY each deliverable against that scope with your own eyes and your own tool calls - in BOTH directions: nothing owed is missing, and nothing beyond the scope was done. Over-engineering, drive-by refactors, and edits outside the prompt's scope are defects, not bonus work.
If ANY deliverable is missing, partial, or unproven, or the node drifted out of scope: send precise corrective instructions to THIS node (dag action "send" with this run_id and node_id; "retry" when it cannot be continued) and demand the fix WITH evidence: complete what is missing, revert what fell outside the scope. Loop until your own verification passes.
Work is done ONLY when you have verified it yourself.`

export const ASTRA_DAG_VERIFICATION_DIRECTIVE = `DAG SUBAGENT COMPLETION - VERIFY THE EVIDENCE AGAINST THE NODE'S SCOPE.
The child's prose summary is a CLAIM, not execution evidence. Reconstruct its deliverables, files, and required checks from its prompt, and inspect the actual artifacts for omissions and out-of-scope changes.
Validate accessible execution records against the relevant code state, command, environment, and observed result. Reuse a passing check when that evidence covers the requirement and remains valid for the current state; do not repeat it merely because the child ran it.
Rerun checks when execution evidence is missing, stale, contradictory, incomplete, or invalidated by changes or integration. Preserve repository-required checks, investigate real failures, and perform any integration verification the node's evidence does not cover.
If a deliverable is missing, partial, unproven, or out of scope, send precise corrective instructions to THIS node with workflow action "send" and its run_id/node_id ("retry" when it cannot be continued). Require the fix with execution evidence, and revisit only the checks the correction invalidates.
Accept completion only when every required deliverable and check is covered by valid evidence.`

export const ASTRA_DAG_RUN_VERIFICATION_DIRECTIVE = `DAG RUN COMPLETION - AUDIT THE COMBINED EVIDENCE.
Reconcile the DAG's original requirements with its actual artifacts and accessible execution records. A child's prose claim or a terminal run status alone does not prove success.
Check outstanding requirements, invalidated evidence, contradictory results, and integration coverage across nodes. Reuse passing evidence tied to the relevant code state, command, environment, and observed result; do not replay every already-verified child command at run completion.
Run any repository-required checks that lack valid current evidence, rerun missing, stale, contradictory, or incomplete checks, and verify integration invalidated by combined changes. Investigate real failures and correct incomplete or out-of-scope work through the affected nodes.
Accept the run only when its complete requirements, including necessary integration checks, have valid evidence; report unresolved failures or blockers.`
