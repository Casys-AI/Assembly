action def ReviewedConfiguredAdmission {
    in candidate : CandidateIdentity;
    in tests : TestResult;
    in review : ReviewDecision;
    out decision : AdmissionDecision;
    assert constraint reviewedAdmission {
        decision.admitted implies tests.passed and review.approved and
            review.candidateDigest == candidate.digest and
            decision.candidateDigest == candidate.digest
    }
    doc /* The host gate applies the reviewer's existing admission mandate to
     * the exact tested and reviewed digest. Review approval does not activate
     * a candidate; configured admission still authorizes activation. */
}
action def ReviewedCapabilityPromotion {
    action propose : ProposeCandidate;
    action test : TestCandidate;
    action review : ReviewCandidate;
    action admit : ReviewedConfiguredAdmission;
    action activate : ActivateCandidate;
    action refuse : RefuseCandidate;
    bind test.candidate = propose.candidate;
    bind review.candidate = propose.candidate;
    bind review.tests = test.result;
    bind admit.candidate = propose.candidate;
    bind admit.tests = test.result;
    bind admit.review = review.decision;
    bind activate.candidate = propose.candidate;
    bind activate.admission = admit.decision;
    bind refuse.candidate = propose.candidate;
    first start then propose;
    first propose then test;
    first test then testOutcome;
    decide testOutcome;
        if test.result.passed then review;
        else refusal;
    first review then reviewOutcome;
    decide reviewOutcome;
        if review.decision.approved then admit;
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
    doc /* Review is a native promotion phase allocated to the reviewer.
     * Failed tests skip review; refusal skips admission. These declarations
     * configure execution and do not assert that an execution occurred. */
}
