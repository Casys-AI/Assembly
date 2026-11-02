package APEPromotion {
    private import ScalarValues::*;
    private import ASECore::*;

    doc /* APE 2.1 - Proposal–Admission–Execution Separation, with
     * APE 2.2 - Fail-Closed Admission. Bounded PAE assembly for candidate
     * promotion. PAE abbreviates proposal, admission and execution. Proposing,
     * judging and admitting are separate actions allocated to the concrete
     * system's existing parts. The assembly is behavior, not an extra runtime
     * part. Here execution means activating the admitted candidate; a later
     * invocation of that capability is a separate operation.
     * Related use cases: Task Automation and Change Control. These are
     * compositions, not patterns 3.1 Decision-to-Effect Traceability or
     * 3.2 Instance-Bound Controls. This bounded slice does not establish full
     * composition conformance, authenticated approval, rollback or closure.
     * Historical source identity 7: composition-7-agent-built-deterministic-capability.mjs.
     * Historical source identity 8: composition-8-sandboxed-candidate-construction-with-controlled-promotion.mjs.
     * These filenames identify sources, not the public titles or chapter numbers. */

    action def ProposeCandidate {
        out candidate : CandidateIdentity;
    }
    action def TestCandidate {
        in candidate : CandidateIdentity;
        out result : TestResult;
    }
    action def ReviewCandidate {
        in candidate : CandidateIdentity;
        in tests : TestResult;
        out decision : ReviewDecision;
    }
    action def AdmitCandidate {
        in candidate : CandidateIdentity;
        in tests : TestResult;
        in review : ReviewDecision;
        in currentCatalogRevision : Integer;
        in exactBytesUnchanged : Boolean;
        in nameAvailable : Boolean;
        out decision : AdmissionDecision;
        assert constraint exactAdmission {
            decision.admitted implies
                tests.passed and review.approved and
                review.candidateDigest == candidate.digest and
                decision.candidateDigest == candidate.digest and
                exactBytesUnchanged and nameAvailable and
                candidate.baseCatalogRevision == currentCatalogRevision
        }
    }
    action def ActivateCandidate {
        in candidate : CandidateIdentity;
        in admission : AdmissionDecision;
        assert constraint admittedExecution {
            admission.admitted and admission.candidateDigest == candidate.digest
        }
        doc /* Executes the admitted catalog change. The host first writes and
         * verifies the active state through the native-model adapter, then marks
         * this candidate active
         * and advances the host catalog revision. Those adapter integrity checks
         * are implementation details inside activation, not PAE phases.
         * An exception leaves the candidate failed and unavailable. */
    }
    action def RefuseCandidate {
        in candidate : CandidateIdentity;
        doc /* Leaves the candidate outside the active catalog and returns the
         * refusal to the builder. Integrity exceptions instead end the attempt
         * as failed; they never grant permission or trigger activation. */
    }

    action def ReviewedPromotion {
        item candidate : CandidateIdentity;
        item tests : TestResult;
        item reviewDecision : ReviewDecision;
        item admissionDecision : AdmissionDecision;
        attribute currentCatalogRevision : Integer;
        attribute exactBytesUnchanged : Boolean;
        attribute nameAvailable : Boolean;

        action propose : ProposeCandidate;
        action test : TestCandidate;
        action review : ReviewCandidate;
        action admit : AdmitCandidate;
        action activate : ActivateCandidate;
        action refuse : RefuseCandidate;

        bind propose.candidate = candidate;
        bind test.candidate = candidate;
        bind test.result = tests;
        bind review.candidate = candidate;
        bind review.tests = tests;
        bind review.decision = reviewDecision;
        bind admit.candidate = candidate;
        bind admit.tests = tests;
        bind admit.review = reviewDecision;
        bind admit.currentCatalogRevision = currentCatalogRevision;
        bind admit.exactBytesUnchanged = exactBytesUnchanged;
        bind admit.nameAvailable = nameAvailable;
        bind admit.decision = admissionDecision;
        bind activate.candidate = candidate;
        bind activate.admission = admissionDecision;
        bind refuse.candidate = candidate;

        first start then propose;
        first propose then test;
        first test then testOutcome;
        decide testOutcome;
            if tests.passed then review;
            else refusal;
        first review then reviewOutcome;
        decide reviewOutcome;
            if reviewDecision.approved then admit;
            else refusal;
        first admit then admissionOutcome;
        decide admissionOutcome;
            if admissionDecision.admitted then activate;
            else refusal;
        merge refusal;
        first refusal then refuse;
        first activate then completion;
        first refuse then completion;
        merge completion;
        first completion then done;

        doc /* Native control flow specifies the successful completion and
         * refusal routes. Test failure skips review; review refusal skips
         * admission. Admission alone authorizes activation. The constraints
         * state obligations; the TypeScript host interprets the supported native
         * model constructs. Digest
         * mismatch, stale base, duplicate active name and write failures abort
         * the host attempt as failed, with no activation. */
    }
}
