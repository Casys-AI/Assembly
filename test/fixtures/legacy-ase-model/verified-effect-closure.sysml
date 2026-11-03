package APEVerifiedEffectClosure {
    private import ScalarValues::*;
    private import ASEInvocations::*;

    doc /* APE 3.4: source-owned expected values, observed state type and native
     * constraint. Work and observation remain separately admitted actions.
     * The bounded runtime evaluates scalar items and native constraints; this
     * library does not claim support for native verification-case execution. */
    part def WorkResultContract {
        ref part work : BehaviorAccess;
        ref part observation : BehaviorAccess;
        ref item input : Items::Item [0..1];
        item expected : Items::Item;
        ref item observed : Items::Item;
        item query : Items::Item [0..1];
        constraint condition;
        attribute maxObservations : Integer;
    }
}
