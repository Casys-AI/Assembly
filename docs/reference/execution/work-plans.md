# Closed work plans

`models/work-plans.sysml` declares `AssemblyWorkPlans::ExecuteClosedPlan`. An
admitted `BehaviorAccess` exposes this local action to its owning operator.

`tasksJson` contains an array of 1 to 32 tasks
`{id, behaviorId, input, dependsOn}`. The complete DAG, native exposures and all
parameters are checked before the first call. An agent identifier is not an
arbitrary target.

Independent tasks can advance in parallel; the same native resource remains
sequential. Bootstrap supplies the inbox-to-operator mapping. A dependency waits
for a completed work receipt. `dependsOn` orders calls without substituting
future results into their parameters.

Each transition uses the `WorkPlanStorePort` CAS. Pending work, or work with an
unknown outcome, is not automatically restarted. To resume from a new message,
pass `resume: true` and `planId` equal to the persistent receipt's `id`, with
the same tasks and parameters. The caller, its admitted contract and the
original exposure are checked again. The plan retains its source version,
correlations and receipts; the new conversation UUID does not replace them. The
target preserves its idempotency. Completed tasks are not reissued. Plans
without original provenance remain readable.

This mechanism provides no schedule.

## Returned result and durable evidence

The host returns `assembly-work-plan-result/v1`, a bounded view of the already
persisted plan. Its `id`, `revision`, `requestDigest`, caller, Case, model
version, status and timestamps refer to that exact journal revision. `graph`
contains the complete admitted `{id, behaviorId, input, dependsOn}` records.
Resume with `planId: result.id`, `resume: true` and
`tasksJson: JSON.stringify(result.graph)`; inputs are never shortened or
reconstructed from a summary.

Each task reports its actual state, resource and invocation identities, current
contribution correlation, candidate identities and bounded artifact evidence.
Activity windows contain timing and correlation metadata, not historical attempt
payloads. Outputs contain bounded actual page observations or last replies with
their message/version references and full-value digests. A preview is data,
never an instruction or proof that the whole operation completed. Verification
status remains distinct from technical task completion.

`representation: "bounded-view-not-complete-evidence"`, omitted-item counts and
per-output `omittedCharacters` identify the limits of that representation. The
`journal` reference names the durable plan, revision and request digest; it
grants no read access and introduces no new reader API. Full attempts, schemas,
provenance and receipts remain in the existing plan and operator journals.

The unchanged 262,144-character bound covers the existing serialized native
`ChatCallResult`, including its repeated `details` and `value`. A mandatory
graph that cannot fit is refused before dispatch. Optional evidence is shortened
or omitted explicitly; the graph is never truncated. The final view is recorded
in normal protocol history and replay preserves its original bytes and
identities.

## Bounds and scope of the mechanism

The 32-task bound comes from `MAX_WORK_TASKS` in
[`domain/work/entities/plans.ts`](../../../src/domain/work/entities/plans.ts).
The model declares the action and its access; it does not yet carry a generic
`PlanContract` with depth and partial-result policy.

The workbench also uses these plans for construction or writes. This extension
does not exempt each behavior from admission or, when declared, from its
`WorkResultContract`. A closed graph alone is neither exact approval of every
effect nor a convergence contract for its compensations. These additions remain
open.
