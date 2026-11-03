package AssemblyWorkPlans {
    private import ScalarValues::*;

    doc /* A closed plan describes a complete dependency graph before dispatch.
     * Each task references an exact BehaviorAccess already exposed to its caller.
     * The host admits every task input before the first invocation, correlates
     * each receipt, and preserves interrupted or waiting work for explicit resume.
     * tasksJson is the bounded transport representation of task records, not
     * permission to address arbitrary operators or inspect their histories.
     * This mechanism schedules admitted work dependencies; it is not a calendar. */

    item def WorkPlanRequest {
        attribute tasksJson : String {
            doc /* JSON text containing an array of 1 to 32 task objects.
             * Every task has exactly four required fields and no extra fields:
             * id: unique nonempty task identifier;
             * behaviorId: exact id of an available modeledBehaviors entry;
             * input: object matching that behavior's native inputSchema exactly;
             * dependsOn: array of task ids in this plan, [] for independent work.
             * Dependencies must form an acyclic graph. Submit the entire graph
             * before execution; every behavior and input is admitted before any
             * task starts. Structural example (replace the behaviorId placeholder
             * with an exact available id and input with its schema's fields):
             * [{"id":"task-1","behaviorId":"<exact modeledBehaviors id>","input":{"text":"Work matching the target inputSchema"},"dependsOn":[]}]
             * For resume, send this same complete graph, inputs and dependencies.
             * The host's assembly-work-plan-result/v1 response retains this exact
             * graph in result.graph; use JSON.stringify(result.graph) unchanged.
             * Task outputs are bounded actual observations, with explicit omitted
             * counts and a durable journal reference, not the full plan evidence. */
        }
        attribute resume : Boolean [0..1] {
            doc /* Optional; omitted or false creates a new plan. True resumes a
             * persisted plan and requires planId from its earlier receipt plus
             * exactly the same tasksJson graph and inputs. Completed tasks are
             * preserved; waiting or interrupted tasks keep their correlations. */
        }
        attribute planId : String [0..1] {
            doc /* Required only when resume is true. Use the exact id of the
             * previously returned persisted plan receipt, even from a new chat
             * message. Reuse its caller, admitted model and complete task graph;
             * do not create a new plan to continue waiting or interrupted work. */
        }
    }

    action def ExecuteClosedPlan {
        in request : WorkPlanRequest;
    }
}
