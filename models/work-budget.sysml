package APEWorkBudget {
    private import ScalarValues::*;

    doc /* APE 3.6 - Budget-Bounded Loop. Bounded realization for cumulative
     * agent invocations in one durable operator dossier; not tokens or cost.
     * Definitions alone grant no permission and select no budget. Instantiate
     * exactly one policy directly inside the concrete ConversationSystem.
     * Only an admitted source revision can change this policy. Runtime counters
     * live outside the model and cannot be written by the agent. */

    part def InvocationBudgetPolicy {
        attribute id : String;
        attribute revision : Integer {
            doc /* Positive safe integer, increased by an admitted source edit. */
        }
        attribute unit : String {
            doc /* Exactly "agent-invocation". One unit reserves one invocation
             * of AgentPort.decide, review or admit, including failed calls.
             * This is neither tokens, monetary cost nor actual HTTP calls:
             * a Muse invocation may internally perform three provider steps. */
        }
        attribute limit : Integer {
            doc /* Inclusive range 0 to 1000000, a safe integer. This supported
             * ceiling prevents unbounded operational profiles; it is not a
             * promise of storage capacity or provider quota. Consumption is
             * cumulative across the durable dossier, including source edits. */
        }
        attribute onExhausted : String {
            doc /* Exactly "wait". Exhaustion dispatches no further invocation. */
        }
        attribute exhaustionRecipient : String {
            doc /* Exactly "local-control": the local design/adoption command.
             * This recipient does not prove an authenticated human identity. */
        }
    }
}
