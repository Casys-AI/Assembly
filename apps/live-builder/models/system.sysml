package AssemblyLiveBuilder {
    private import ScalarValues::*;
    private import AssemblyCore::*;
    private import APEPromotion::*;
    private import AssemblyLifecycle::*;
    private import AssemblyRequirements::*;

    doc /* A conversational builder proposes a candidate capability; a separate
     * reviewer judges the tested bytes, and the host admits the exact candidate
     * before the catalog executes its activation. PAE is the assembled
     * behavior of these parts. It introduces no phantom runtime control parts.
     * Runtime evidence remains in the host store; this model grants no rights. */

    action def ReplyToConversation {
        out response : ConversationResponse;
        doc /* The builder's ordinary reply branch produces response text.
         * Reply and invocation request are alternative conversational choices,
         * not ordered phases of candidate promotion. Native allocation
         * documents responsibility, not observed execution. */
    }
    action def RequestToolInvocation {
        out request : ToolInvocationRequest;
        doc /* The builder requests invocation. The host checks the active
         * capability, unchanged digest and user-supplied HTTPS URL before
         * executing it. This action does not claim tool execution by builder. */
    }

    part def ConversationBuilder :> SoftwareOperator {
        port proposals : CandidatePort;
        doc /* Bounded software operator. It may propose candidates and invoke
         * active catalog tools, but cannot review or activate its own proposal. */
    }
    part def IndependentReviewer :> SoftwareOperator {
        port candidates : ~CandidatePort;
        port tests : ~TestResultPort;
        port decisions : ReviewDecisionPort;
        doc /* A separate model call forms an advisory review judgment on the
         * exact tested digest. It is not an authenticated approver and has no
         * admission authority. */
    }
    part def ToolCandidate :> ExecutableCapability {
        exhibit state lifecycle : CandidateLifecycle;
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
        doc /* Host admission authority. Checks passing tests, approval for this
         * digest, unchanged bytes, current base revision and unused active
         * name. Review approval alone cannot activate a capability. */
    }
    part def ToolCatalog {
        port candidates : ~CandidatePort;
        port admissions : ~AdmissionDecisionPort;
        doc /* Owns candidates and executes admitted activation. After the model
         * write is verified, the host exposes the active digest for invocation.
         * The later run of a tool is separate from this promotion behavior. */
    }
    part def ConversationSystem;

    part liveBuilder : ConversationSystem {
        attribute operatorName : String = "Main Operator";
        attribute operatorInstruction : String = "Design and evolve this system with the person, and create operators to handle Requests.";
        attribute primaryContact : Boolean = true;
        attribute humanInputEnabled : Boolean = true;
        part builder : ConversationBuilder;
        part reviewer : IndependentReviewer;
        part testSandbox : CandidateTestSandbox;
        part catalog : ToolCatalog;
        part admissionGate : CatalogAdmissionGate;

        item builderMandate : ConfiguredMandate {
            attribute :>> id = "builder-v1";
            attribute :>> version = "1";
            attribute :>> scope = "Propose read_web_page and read_web_page_outline; invoke active catalog tools";
            attribute :>> source = "host configuration: src/domain/mandates.ts; src/application/system-runtime.ts; src/adapters/agents.ts";
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
        }
        item reviewerMandate : ConfiguredMandate {
            attribute :>> id = "reviewer-v1";
            attribute :>> version = "1";
            attribute :>> scope = "Review the exact tested candidate and its test evidence";
            attribute :>> source = "host configuration: src/domain/mandates.ts; src/application/system-runtime.ts; src/adapters/agents.ts";
            attribute :>> evidenceLevel = "configured";
            attribute :>> grantingOperator = "unknown";
            attribute :>> mayProposeReadWebPage = false;
            attribute :>> mayProposeReadWebPageOutline = false;
            attribute :>> mayInvokeActiveCatalog = false;
            attribute :>> mayReviewExactCandidate = true;
            attribute :>> mayAdmit = false;
            attribute :>> mayActivate = false;
            attribute :>> mayChangeOwnMandate = false;
            attribute :>> mayCreateAgents = false;
        }
        bind builder.mandate = builderMandate;
        bind builderMandate.holder = builder;
        bind reviewer.mandate = reviewerMandate;
        bind reviewerMandate.holder = reviewer;

        connect builder.proposals to testSandbox.proposals;
        connect testSandbox.testedCandidates to reviewer.candidates;
        connect testSandbox.results to reviewer.tests;
        connect testSandbox.testedCandidates to admissionGate.candidates;
        connect testSandbox.results to admissionGate.tests;
        connect reviewer.decisions to admissionGate.reviews;
        connect testSandbox.testedCandidates to catalog.candidates;
        connect admissionGate.decisions to catalog.admissions;

        requirement exactReviewedCandidate : ExactReviewedCandidate;
        requirement activeOnlyCallable : ActiveOnlyCallable;
        requirement failClosedPromotion : FailClosedPromotion;
        satisfy exactReviewedCandidate by admissionGate;
        satisfy activeOnlyCallable by catalog;
        satisfy activeOnlyCallable by builder;
        satisfy failClosedPromotion by admissionGate;
        satisfy failClosedPromotion by catalog;

        perform action reply : ReplyToConversation;
        perform action invokeRequest : RequestToolInvocation;
        allocate reply to builder;
        allocate invokeRequest to builder;
        perform action promotion : ReviewedPromotion;
        allocate promotion.propose to builder;
        allocate promotion.test to testSandbox;
        allocate promotion.review to reviewer;
        allocate promotion.admit to admissionGate;
        allocate promotion.activate to catalog;
        allocate promotion.refuse to admissionGate;

        bind exactReviewedCandidate.candidate = promotion.candidate;
        bind exactReviewedCandidate.review = promotion.reviewDecision;
        bind promotion.candidate = builder.proposals.candidate;
        bind promotion.tests = testSandbox.results.result;
        bind promotion.reviewDecision = reviewer.decisions.decision;
        bind promotion.admissionDecision = admissionGate.decisions.decision;
    }
}
