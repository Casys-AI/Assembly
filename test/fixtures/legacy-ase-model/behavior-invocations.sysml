package ASEInvocations {
    private import ScalarValues::*;
    private import ASECore::*;

    doc /* Explicit source-owned exposure of a performed behavior to an operator.
     * Allocation alone does not authorize invocation. The actual caller and
     * target are fixed by native bindings on each enabled occurrence.
     * Input is a schema reference, refined to a model-owned item definition;
     * it is not a stored request and has no binding to mutable case facts. */

    part def BehaviorAccess {
        attribute name : String;
        attribute description : String;
        attribute enabled : Boolean;
        ref part caller : SoftwareOperator;
        ref action target : Actions::Action;
        ref item input : Items::Item;
    }
}
