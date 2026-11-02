package AssemblyWork {
    private import ScalarValues::*;

    doc /* Generic technical entries into modeled operator runtimes and their
     * artifact catalogs. A performed occurrence must be allocated to the exact
     * operator or catalog in its owning ConversationSystem. BehaviorAccess
     * separately fixes every authorized caller. These definitions grant no
     * admission, network scope or access to another conversation. */

    item def WorkRequest {
        attribute text : String;
    }
    item def EmptyRequest;
    item def WorkArtifactQuery {
        attribute workInvocationId : String;
        attribute workBehaviorId : String;
        attribute workInputDigest : String;
        attribute artifactName : String;
    }
    action def InspectWorkArtifacts {
        in request : WorkArtifactQuery;
        out result : AssemblyToolPublicationResult::PublicationObservation;
        doc /* Read source-owned active artifact facts correlated to one exact
         * work invocation. This action grants no construction or admission. */
    }
    item def ReuseToolRequest {
        attribute sourceAgentId : String;
        attribute candidateId : String;
        attribute digest : String;
    }
    action def AgentInbox {
        in request : WorkRequest;
        doc /* The host correlates one admitted request with one operator's
         * own modeled flow. It transmits this request, never peer history. */
    }
    action def ReuseTool {
        in request : ReuseToolRequest;
        doc /* Reuse exact published bytes as a local proposal. Local tests,
         * mandate, admission and activation remain mandatory. */
    }
    action def ListPublishedTools {
        in request : EmptyRequest;
        doc /* Read metadata of exact active artifacts in the same modeled
         * system. Neither source code nor conversations nor rights are copied. */
    }
}
