package AssemblyLiveBuilder {
    private import ScalarValues::*;
    private import AssemblyCore::*;
    private import AssemblyConversation::*;
    private import AssemblyExecution::*;
    private import APEPromotion::*;
    private import AssemblyLifecycle::*;
    private import AssemblyRequirements::*;

    doc /* A conversational builder starts alone and proposes candidate capabilities.
     * The host waits for human admission until an approved configuration change
     * assigns admission authority. A reviewer is added only by an approved change. PAE is the assembled
     * behavior of these parts. It introduces no phantom runtime control parts.
     * Runtime evidence remains in the host store. The host interprets the native
     * bounded action-flow subset and the configured policy and mandates;
     * definitions alone do not establish an admitted capability or execution. */

    action def ReplyToConversation {
        out response : ConversationResponse;
        doc /* The builder's ordinary reply branch produces response text.
         * Reply and invocation request are alternative conversational choices,
         * not ordered phases of candidate promotion. Native allocation
         * identifies the performer used by the bounded native-flow interpreter;
         * it does not establish observed execution. */
    }
    action def RequestToolInvocation {
        out request : ToolInvocationRequest;
        doc /* The builder requests invocation. The host checks the active
         * capability, unchanged digest and user-supplied HTTPS URL before
         * executing it. This action does not claim tool execution by builder. */
    }

    part def ConversationBuilder :> SoftwareOperator {
        port proposals : CandidatePort;
        doc /* Bounded software operator. It proposes candidates and requests
         * active catalog invocations. An approved mandate revision can admit
         * its tested candidates; activation remains a host responsibility. */
    }
    part def IndependentReviewer :> SoftwareOperator {
        port candidates : ~CandidatePort;
        port tests : ~TestResultPort;
        port decisions : ReviewDecisionPort;
        doc /* A separately configured operator reviews the exact tested digest
         * and may admit that reviewed candidate when its mandate permits it.
         * It is not an authenticated human approver; activation stays in host. */
    }
    item def HumanAdmissionRequested;
    item def HumanAdmissionAccepted;
    item def HumanAdmissionRefused;
    state def AdmissionCandidateLifecycle :> AssemblyLifecycle::CandidateLifecycle {
        state 'awaiting-admission';
        transition awaitAdmission first testing accept HumanAdmissionRequested then 'awaiting-admission';
        transition humanAdmits first 'awaiting-admission' accept HumanAdmissionAccepted then activating;
        transition humanRefuses first 'awaiting-admission' accept HumanAdmissionRefused then refused;
        transition pendingFailure first 'awaiting-admission' accept AssemblyLifecycle::PromotionFailed then failed;
        doc /* Awaiting human admission survives host restart. It does not
         * inherit the interrupted-stage restart behavior of testing/reviewing. */
    }
    part def ToolCandidate :> ExecutableCapability {
        ref item contract : CapabilityContract;
        exhibit state lifecycle : AdmissionCandidateLifecycle;
        doc /* Only admitted tools are inserted into the catalog. Each occurrence
         * owns its name, digest and candidateId. An absent status means active;
         * historical non-active statuses remain readable but are not invocable.
         * Candidate progress, source, tests and admission evidence live in the
         * durable host runtime state. Revocation removes the occurrence. */
    }
    part def CandidateTestSandbox {
        port proposals : ~CandidatePort;
        port testedCandidates : CandidatePort;
        port results : TestResultPort;
        doc /* The host tests the exact candidate in an isolated process.
         * This is a candidate test sandbox, not a persistent operator workspace. */
    }
    part def CatalogAdmissionGate {
        port candidates : ~CandidatePort;
        port tests : ~TestResultPort;
        port reviews : ~ReviewDecisionPort;
        port decisions : AdmissionDecisionPort;
        doc /* Host admission gate. Checks passing tests, current admission
         * authority, exact digest, unchanged bytes, current catalog revision and
         * unused active name. A pending human decision cannot activate a tool. */
    }
    part def ToolCatalog {
        port candidates : ~CandidatePort;
        port admissions : ~AdmissionDecisionPort;
        doc /* Owns candidates and executes admitted activation. After the model
         * write is verified, the host exposes the active digest for invocation.
         * The later run of a tool is separate from this promotion behavior. */
    }
    part def ConversationSystem;

    action def ConfiguredAdmission {
        in candidate : CandidateIdentity;
        in tests : TestResult;
        out decision : AdmissionDecision;
        assert constraint testedAdmission {
            decision.admitted implies tests.passed and
                decision.candidateDigest == candidate.digest
        }
        doc /* Host admission uses the current approved system configuration.
         * Human UI consent is not an authenticated approver receipt. */
    }
    action def CapabilityPromotion {
        action propose : ProposeCandidate;
        action test : TestCandidate;
        action admit : ConfiguredAdmission;
        action activate : ActivateCandidate;
        action refuse : RefuseCandidate;
        bind test.candidate = propose.candidate;
        bind admit.candidate = propose.candidate;
        bind admit.tests = test.result;
        bind activate.candidate = propose.candidate;
        bind activate.admission = admit.decision;
        bind refuse.candidate = propose.candidate;
        first start then propose;
        first propose then test;
        first test then testOutcome;
        decide testOutcome;
            if test.result.passed then admit;
            else refusal;
        first admit then admissionOutcome;
        decide admissionOutcome;
            if admit.decision.admitted then activate;
            else refusal;
        merge refusal;
        first refusal then refuse;
        first activate then completion;
        first refuse then completion;
        merge completion;
        first completion then done;
        doc /* Native responsibilities for the evolving system. The host controls
         * tests, pending admission, refusal and activation. These declarations
         * are configuration, not an observed execution trace. */
    }
    part liveBuilder : ConversationSystem {
        attribute operatorName : String = "Main Operator";
        attribute operatorInstruction : String = "Design and evolve this system with the person, and create operators to handle Requests.";
        attribute primaryContact : Boolean = true;
        attribute humanInputEnabled : Boolean = true;
        attribute authoritySchema : Integer = 2;
        attribute envelopeKind : String = "conversational-case-management";
        attribute envelopePattern : String = "1.3";
        attribute envelopeRevision : String = "1";
        attribute configurationId : String = "live-builder-native";
        attribute configurationRevision : String = "0";
        attribute admissionMode : String = "human";
        attribute networkHosts : String = "[]";
        part owner : AssemblyCore::HumanOperator {
            item ownerMandate : AssemblyAuthority::Mandate {
                attribute :>> id = "owner";
                attribute :>> revision = 1;
                part rootAuthority : AssemblyAuthority::RootAuthority {
                    attribute :>> id = "owner-root";
                }
                part rootGrant : AssemblyAuthority::RootGrant {
                    attribute :>> id = "owner-root-grant";
                }
                bind rootGrant.issuer = rootAuthority;
            }
        }
        bind owner.ownerMandate.holder = owner;
        part builder : ConversationBuilder;
        part requestControl : AssemblyAuthority::SpaceControlPolicy {
            attribute :>> id = "local-request-control";
            attribute :>> revision = 2;
            attribute :>> enabled = true;
            attribute :>> acts = "[\"open-request\",\"execute-conversation\",\"revoke-execution\",\"retain-release\"]";
        }
        bind requestControl.holder = owner;
        bind requestControl.mandate = owner.ownerMandate;
        bind requestControl.issuer = owner.ownerMandate.rootAuthority;
        bind requestControl.allowedOperator = builder;

        part testSandbox : CandidateTestSandbox;
        part catalog : ToolCatalog {
            item readWebPageContract : CapabilityContract {
                attribute :>> kind = "read_web_page";
                attribute :>> module = "default({url,html}) => {title,text}";
                attribute :>> acceptanceCriteria = "Return the actual nonempty HTML document title and readable text, decoding HTML entities.\nExclude script, style and comment contents; never execute HTML scripts.\nPure self-contained HTML transformation: no imports, DOMParser, fetch, network, files, environment, subprocesses or ambient permissions. URL is available for URL resolution.\nPreserve the meaningful body text, including prose and headings. Three varied full-text extraction fixtures must pass.";
            }
            item readWebPageOutlineContract : CapabilityContract {
                attribute :>> kind = "read_web_page_outline";
                attribute :>> module = "default({url,html}) => {title,text}";
                attribute :>> acceptanceCriteria = "Return the actual nonempty HTML document title and readable text, decoding HTML entities.\nExclude script, style and comment contents; never execute HTML scripts.\nPure self-contained HTML transformation: no imports, DOMParser, fetch, network, files, environment, subprocesses or ambient permissions. URL is available for URL resolution.\ntext conveys all h1-h6 heading texts in document order and the distinct canonical absolute http(s) URLs from anchor href attributes, in first occurrence order. Full body prose is not required.\nResolve relative paths, ../ paths, ?queries and //host URLs using new URL(href, url). Decode HTML entities in href; remove URL fragments, deduplicate after canonicalization, skip empty or fragment-only href and all non-http(s) schemes (including javascript:, data:, mailto:).\nRender each canonical URL intact in text, separated by whitespace or Markdown link delimiters. Three varied outline extraction fixtures must pass.";
            }
        }
        part admissionGate : CatalogAdmissionGate;
        item builderMandate : ConfiguredMandate {
            attribute :>> id = "builder-v1";
            attribute :>> version = "1";
            attribute :>> scope = "Propose read_web_page and read_web_page_outline; invoke active catalog tools";
            attribute :>> source = "host configuration: src/domain/governance.ts; src/domain/mandates.ts; src/application/system-runtime.ts; src/adapters/agents.ts";
            attribute :>> evidenceLevel = "configured";
            attribute :>> grantingOperator = "unknown";
            attribute :>> mayProposeReadWebPage = true;
            attribute :>> mayProposeReadWebPageOutline = true;
            attribute :>> mayInvokeActiveCatalog = true;
            attribute :>> mayReviewExactCandidate = false;
            attribute :>> mayAdmit = false;
            attribute :>> mayActivate = false;
            attribute :>> mayChangeOwnMandate = false;
            attribute :>> mayCreateAgents = false;
            attribute :>> mayOpenRequests = true;
        }
        bind builder.mandate = builderMandate;
        bind builderMandate.holder = builder;
        connect builder.proposals to testSandbox.proposals;
        connect testSandbox.testedCandidates to catalog.candidates;
        connect testSandbox.testedCandidates to admissionGate.candidates;
        connect testSandbox.results to admissionGate.tests;
        connect admissionGate.decisions to catalog.admissions;
        perform action reply : ReplyToConversation;
        perform action invokeRequest : RequestToolInvocation;
        allocate reply to builder;
        allocate invokeRequest to builder;
        perform action promotion : CapabilityPromotion;
        allocate promotion.propose to builder;
        allocate promotion.test to testSandbox;
        allocate promotion.admit to admissionGate;
        allocate promotion.activate to catalog;
        allocate promotion.refuse to admissionGate;
        perform action operatorFlowTemplate : ImmutableGroupConversationV1;
        attribute operatorFlowTemplateRevision : Integer = 2;
        perform action conversation : ImmutableGroupConversationV1 {
            item executionPolicy : ExecutionPolicy {
                attribute :>> maxAgentDecisions = 7;
                attribute :>> maxToolProposals = 2;
                attribute :>> maxFlowSteps = 128;
                attribute :>> urlSelectionMode = "user-provided";
                attribute :>> mayAddNetworkHosts = true;
                attribute :>> mayDelegateOwnAdmission = true;
                attribute :>> mayCreateReviewer = true;
                attribute :>> mayChangeUrlSelection = true;
                attribute :>> mayConsultModel = true;
                attribute :>> mayProposeSysmlRevision = true;
            }
        }
        allocate conversation.readCaseState to admissionGate;
        allocate conversation.executeOperatorCommand to admissionGate;
        allocate conversation.chooseNextMove to builder;
        allocate conversation.replyOrClarify to builder;
        allocate conversation.waitForInput to admissionGate;
        allocate conversation.checkRequestedAction to admissionGate;
        allocate conversation.executeAction to catalog;
        allocate conversation.recordRefusal to admissionGate;
        allocate conversation.submitChangeProposal to admissionGate;
        allocate conversation.observeOutcome to admissionGate;
    }
}
