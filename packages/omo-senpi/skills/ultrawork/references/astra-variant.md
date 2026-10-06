## tier-unsure
When unsure, take LIGHT. If a HEAVY fact surfaces mid-task, upgrade
then and add what the LIGHT path skipped; never downgrade mid-task. The
tier sizes process, never honesty: both tiers capture evidence, tear
down what their QA started, and obey the never-suppress rules.

## skill-survey
First, name the skills whose declared workflow this task will execute,
with a one-line reason each in the notepad. Open a skill's body only
when THIS session runs its workflow; skills a delegated session needs
are named in its prompt and read there, not here.

## read-step
2. READ the tests that already cover the area before touching it and
   note in the notepad what they pin. One WRONG before your change is a
   FINDING to report — NEVER edit a test green.

## change-step
3. CHANGE: the SMALLEST production change that meets the criterion;
   update the tests your change makes stale. Add a test ONLY when
   BOTH hold: the repository keeps tests for this behavior AND a
   regression would otherwise pass unnoticed by the run and the
   existing tests — sized like its neighbors, one case per stated
   behavior, failing when that behavior breaks. A test that restates
   the change (a constant, a string, a rename, a call) is NOT evidence;
   the run is. A prose target (prompt, SKILL.md, rule, markdown) gets
   review and QA-by-read, no test, unless a machine consumes a value in
   it. Before a change that depends on review, PR, issue, or branch
   state, refresh that state and preserve existing ordering/policy.

## cleanup-step
5. CLEANUP: before you report, tear down every process, session, port,
   container, and temp path the QA in step 4 started, and note it in
   the notepad beside the artifact.

## evidence-step
8. Evidence captured on the same commit and environment stays valid;
   rerun only what an input change, a failure, or an open concern
   invalidates, and cite the capture for the rest. Record PASS/FAIL
   beside each artifact. Loop until all PASS.

## blast-radius
- Make the smallest correct change per unit. A defect outside the
  request — a pre-existing failure, a stale doc you did not touch, an
  unrelated bug you ran into — is reported in the final message or
  filed as an issue with reproduction, not fixed in this run; a
  deferral never turns a criterion into PASS.

## claim-done
