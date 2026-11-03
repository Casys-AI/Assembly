package ASECore {
    private import ScalarValues::*;

    doc /* Neutral structural primitives. These definitions carry values and
     * communication contracts; they do not create runtime control actors. */

    part def Operator;
    part def HumanOperator :> Operator;
    part def SoftwareOperator :> Operator {
        ref item mandate : ConfiguredMandate;
    }
    item def ConfiguredMandate {
        ref holder : SoftwareOperator;
        attribute id : String;
        attribute version : String;
        attribute scope : String;
        attribute source : String;
        attribute evidenceLevel : String;
        attribute grantingOperator : String;
        attribute mayProposeReadWebPage : Boolean;
        attribute mayProposeReadWebPageOutline : Boolean;
        attribute mayInvokeActiveCatalog : Boolean;
        attribute mayReviewExactCandidate : Boolean;
        attribute mayAdmit : Boolean;
        attribute mayActivate : Boolean;
        attribute mayChangeOwnMandate : Boolean;
        attribute mayCreateAgents : Boolean;
        doc /* Fixed host configuration for a software-operator role. The holder
         * binding identifies the concrete operator. This item does not implement
         * a grant/revocation registry or authenticate a delegating operator.
         * evidenceLevel configured records the source level, not execution proof.
         * grantingOperator unknown means no authenticated grantor is established. */
    }
    part def ExecutableCapability;

    item def ConversationResponse {
        attribute text : String;
    }
    item def ToolInvocationRequest {
        attribute toolId : String;
        attribute url : String;
        doc /* The builder requests a capability by its host catalog identity.
         * This request is not evidence that the host executed the tool. */
    }

    item def CandidateIdentity {
        attribute candidateId : String;
        attribute digest : String;
        attribute baseCatalogRevision : Integer;
        doc /* Digest of the exact name, description, kind and source bytes
         * proposed by the builder. Identity remains stable through promotion.
         * This identifies a candidate and its basis; it is not the canonical
         * promotion contract governing proofs, admission and closure. */
    }
    item def TestResult {
        attribute passed : Boolean;
        doc /* Test evidence belongs to the candidate passed to the test sandbox.
         * The host retains that association; its TestReport has no digest field. */
    }
    item def ReviewDecision {
        attribute candidateDigest : String;
        attribute approved : Boolean;
        attribute reason : String;
        doc /* approved represents the host review verdict "approve".
         * A review expresses an advisory judgment; it grants no catalog authority
         * and is not an authenticated-approver receipt. */
    }
    item def AdmissionDecision {
        attribute candidateDigest : String;
        attribute admitted : Boolean;
        doc /* The admission gate's decision about promotion of these exact bytes.
         * This is distinct from the independent review decision. It represents
         * the logical host branch, not an additional persisted verdict record. */
    }

    port def CandidatePort { out item candidate : CandidateIdentity; }
    port def TestResultPort { out item result : TestResult; }
    port def ReviewDecisionPort { out item decision : ReviewDecision; }
    port def AdmissionDecisionPort { out item decision : AdmissionDecision; }
}
