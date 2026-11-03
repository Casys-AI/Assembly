package AssemblyConversation {
    private import ScalarValues::*;
    private import AssemblyCore::*;

    doc /* APE 1.3 - Conversational Case Management.
     * Native description of a bounded conversational case.
     * The TypeScript host retains the session, reads its state, controls effects
     * and presents outcomes to the same builder. The host interprets the supported
     * native action occurrences, successions and decision guards; named action
     * definitions select implemented primitive mechanisms. This is a bounded
     * executable subset, not a complete SysML interpreter. Waiting suspends this
     * open case; it is not closure.
     * No verified closure or accepted-handoff mechanism exists in this slice. */

    item def CaseRecord {
        attribute sessionId : String;
        doc /* The host session identifies the continuing case. Its stored
         * messages, candidates, configuration and outcomes form the case record. */
    }
    item def NextMove {
        attribute kind : String;
        doc /* Host-validated builder decision: reply, invoke_tool, invoke_behavior, propose_tool,
         * propose_mandate_change or propose_agent_creation. This field describes
         * those existing choices; it adds no tool or permission. */
    }
    item def RequestedActionAdmission {
        attribute admitted : Boolean;
    }
    item def ActionOutcome {
        attribute succeeded : Boolean;
        attribute code : String;
        attribute details : String;
        doc /* Success, reported execution failure or refusal is retained for
         * the next choice. Admission alone never establishes execution success. */
    }
    item def ChangeSubmission {
        attribute awaitingInput : Boolean;
        doc /* A tested tool awaiting admission or a governance change proposal
         * yields control for an explicit human command. A completed/refused tool
         * promotion instead supplies feedback for another bounded choice. */
    }
    item def CaseContribution {
        attribute text : String;
        doc /* A new user message or an explicit admission/refusal command
         * resumes the stored session under its current approved configuration. */
    }
    action def ReadCaseState {
        out record : CaseRecord;
    }
    action def ChooseNextMove {
        in record : CaseRecord;
        out choice : NextMove;
    }
    action def ReplyOrClarify {
        out response : ConversationResponse;
    }
    action def AwaitCaseInput {
        accept contribution : CaseContribution;
        doc /* Suspension until another permitted input or admission command.
         * The model does not assert that the host has formally closed a case. */
    }
    action def CheckRequestedAction {
        in choice : NextMove;
        out decision : RequestedActionAdmission;
        doc /* The host validates the selected active tool, exact digest, target
         * URL and network scope under the current approved mandate, or the exact
         * source-owned behavior exposure, caller, typed input and source version. */
    }
    action def ExecuteRequestedAction {
        in decision : RequestedActionAdmission;
        out outcome : ActionOutcome;
        assert constraint admittedAttempt { decision.admitted }
        doc /* The host runner attempts the admitted catalog or modeled behavior invocation.
         * Reported success and failure both continue through observation. */
    }
    action def RecordActionRefusal {
        out outcome : ActionOutcome;
    }
    action def SubmitChangeProposal {
        in choice : NextMove;
        out submission : ChangeSubmission;
        out outcome : ActionOutcome;
        doc /* Dispatches the already chosen tool or governance proposal to the
         * existing host path. Tool construction uses CapabilityPromotion in the
         * configured system. Governance proposals await a separate human command.
         * This action neither grants rights nor creates an extra promotion part. */
    }
    action def ObserveOutcomeAndUpdateCase {
        in outcome : ActionOutcome;
        doc /* Host feedback retains the reported result or refusal in the same
         * session before the builder receives its next decision context. */
    }

    action def ConversationCase {
        item outcome : ActionOutcome;
        action readCaseState : ReadCaseState;
        action chooseNextMove : ChooseNextMove;
        action replyOrClarify : ReplyOrClarify;
        action waitForInput : AwaitCaseInput;
        action checkRequestedAction : CheckRequestedAction;
        action executeAction : ExecuteRequestedAction;
        action recordRefusal : RecordActionRefusal;
        action submitChangeProposal : SubmitChangeProposal;
        action observeOutcome : ObserveOutcomeAndUpdateCase;
        bind chooseNextMove.record = readCaseState.record;
        bind checkRequestedAction.choice = chooseNextMove.choice;
        bind executeAction.decision = checkRequestedAction.decision;
        bind submitChangeProposal.choice = chooseNextMove.choice;
        bind executeAction.outcome = outcome;
        bind recordRefusal.outcome = outcome;
        bind submitChangeProposal.outcome = outcome;
        bind observeOutcome.outcome = outcome;

        first start then resumeCase;
        merge resumeCase;
        first resumeCase then readCaseState;
        first readCaseState then chooseNextMove;
        first chooseNextMove then nextMove;
        decide nextMove;
            if chooseNextMove.choice.kind == "reply" then replyOrClarify;
            if (chooseNextMove.choice.kind == "invoke_tool") or
               (chooseNextMove.choice.kind == "invoke_behavior") then checkRequestedAction;
            else submitChangeProposal;
        first replyOrClarify then awaitingContribution;
        first checkRequestedAction then admissionOutcome;
        decide admissionOutcome;
            if checkRequestedAction.decision.admitted then executeAction;
            else recordRefusal;
        first executeAction then reportedOutcome;
        first recordRefusal then reportedOutcome;
        first submitChangeProposal then submissionOutcome;
        decide submissionOutcome;
            if submitChangeProposal.submission.awaitingInput then awaitingContribution;
            else reportedOutcome;
        merge reportedOutcome;
        first reportedOutcome then observeOutcome;
        first observeOutcome then resumeCase;
        merge awaitingContribution;
        first awaitingContribution then waitForInput;
        first waitForInput then resumeCase;
    }
}
