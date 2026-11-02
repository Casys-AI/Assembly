package ASEExecution {
    private import ScalarValues::*;

    doc /* Policy consumed from the selected native model by the host's bounded
     * action-flow interpreter. Native successions and guards determine order;
     * named action definitions select the standalone primitive-handler registry
     * of implemented mechanisms. Unknown primitives fail closed. This
     * package does not claim support for the complete SysML execution language.
     * Revision permissions permit proposals subject to approved configuration
     * changes. They do not immediately widen the active mandate or network scope. */

    item def CapabilityContract {
        attribute kind : String;
        attribute module : String;
        attribute acceptanceCriteria : String;
        doc /* Approved capability contract source. Criteria are newline-separated
         * text. Implemented host test mechanisms remain selected by the supported
         * kind and module identity; a candidate does not invent its contract. */
    }

    item def ExecutionPolicy {
        attribute maxAgentDecisions : Integer;
        attribute maxToolProposals : Integer;
        attribute maxFlowSteps : Integer;
        attribute urlSelectionMode : String;
        attribute mayAddNetworkHosts : Boolean;
        attribute mayDelegateOwnAdmission : Boolean;
        attribute mayCreateReviewer : Boolean;
        attribute mayChangeUrlSelection : Boolean;
        attribute mayProposeSysmlRevision : Boolean;
    }
}
