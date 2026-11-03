package ASELifecycle {
    doc /* Candidate promotion lifecycle specified from SystemRuntime.build,
     * stage and initialize in src/application/system-runtime.ts. The host owns
     * execution and retained status; this state machine is a native design
     * description, not proof that a transition occurred in a live session. */

    item def TestingStarted;
    item def TestsPassed;
    item def TestsRefused;
    item def ReviewRefused;
    item def AdmissionAccepted;
    item def ActivationCompleted;
    item def PromotionFailed;
    item def SessionRestarted;

    state def CandidateLifecycle {
        entry; then proposed;
        state proposed;
        state testing;
        state reviewing;
        state activating;
        state active;
        state refused;
        state failed;

        transition startTesting first proposed accept TestingStarted then testing;
        transition testsPass first testing accept TestsPassed then reviewing;
        transition testsReject first testing accept TestsRefused then refused;
        transition reviewReject first reviewing accept ReviewRefused then refused;
        transition admit first reviewing accept AdmissionAccepted then activating;
        transition activate first activating accept ActivationCompleted then active;

        transition proposalFailure first proposed accept PromotionFailed then failed;
        transition testFailure first testing accept PromotionFailed then failed;
        transition reviewFailure first reviewing accept PromotionFailed then failed;
        transition activationFailure first activating accept PromotionFailed then failed;
        transition restartProposed first proposed accept SessionRestarted then failed;
        transition restartTesting first testing accept SessionRestarted then failed;
        transition restartReviewing first reviewing accept SessionRestarted then failed;
        transition restartActivating first activating accept SessionRestarted then failed;

        doc /* AdmissionAccepted means the host has checked passing tests,
         * approval for the exact digest, unchanged candidate bytes, the current
         * base catalog revision and an unused active name. ActivationCompleted
         * follows verified model write and host catalog update. A digest/base/
         * name mismatch or an exception ends the pending attempt as failed.
         * Restart never promotes a pending candidate. active, refused and
         * failed have no outgoing promotion transition; a correction creates
         * a new candidate. Later invocation does not change this lifecycle. */
    }
}
