part reviewer : AssemblyLiveBuilder::IndependentReviewer;
item reviewerMandate : AssemblyCore::ConfiguredMandate {
    attribute :>> id = "reviewer-v1";
    attribute :>> version = "1";
    attribute :>> scope = "Review the exact tested candidate and admit the reviewed candidate";
    attribute :>> source = "host configuration: src/domain/governance.ts; src/domain/mandates.ts; src/application/system-runtime.ts; src/adapters/agents.ts";
    attribute :>> evidenceLevel = "configured";
    attribute :>> grantingOperator = "unknown";
    attribute :>> mayProposeReadWebPage = false;
    attribute :>> mayProposeReadWebPageOutline = false;
    attribute :>> mayInvokeActiveCatalog = false;
    attribute :>> mayReviewExactCandidate = true;
    attribute :>> mayAdmit = true;
    attribute :>> mayActivate = false;
    attribute :>> mayChangeOwnMandate = false;
    attribute :>> mayCreateAgents = false;
}
bind reviewer.mandate = reviewerMandate;
bind reviewerMandate.holder = reviewer;
connect testSandbox.testedCandidates to reviewer.candidates;
connect testSandbox.results to reviewer.tests;
connect reviewer.decisions to admissionGate.reviews;
allocate promotion.review to reviewer;
