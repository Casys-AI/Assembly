package AssemblyRequirements {
    private import ScalarValues::*;
    private import AssemblyCore::*;

    doc /* Bounded design requirements from SystemRuntime.build and runTurn in
     * src/application/system-runtime.ts. Satisfaction links assign design
     * responsibilities; they are neither test results nor execution evidence.
     * Runtime behavior and exact checks are governed by that host source. */

    requirement def ExactReviewedCandidate {
        item candidate : CandidateIdentity;
        item review : ReviewDecision;
        attribute activationRequested : Boolean;
        require constraint sameReviewedBytes {
            activationRequested implies
                review.approved and review.candidateDigest == candidate.digest
        }
        doc /* Activation requires approval for the same candidate digest.
         * The host rejects a review with a mismatched digest and rechecks the
         * current draft digest before entering activation. */
    }
    requirement def ActiveOnlyCallable {
        attribute invocationRequested : Boolean;
        attribute candidateActive : Boolean;
        attribute bytesMatch : Boolean;
        require constraint invocationGate {
            invocationRequested implies candidateActive and bytesMatch
        }
        doc /* A later invocation resolves an active candidate by identifier
         * and rechecks its digest. Proposal, review or admission alone does
         * not make a candidate callable. These values describe the host gate;
         * they are not inferred execution evidence from the diagram. */
    }
    requirement def FailClosedPromotion {
        attribute candidateRefused : Boolean;
        attribute candidateFailed : Boolean;
        attribute activationRequested : Boolean;
        require constraint unavailableCannotActivate {
            (candidateRefused or candidateFailed) implies not activationRequested
        }
        doc /* A refused or failed candidate remains outside the active
         * catalog. Pending candidates become failed on restart. A correction
         * is a new proposal, not automatic promotion of the old candidate. */
    }
}
