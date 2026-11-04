package APEAccountability {
    doc /* Diagnostic declaration only. Direct containment selects one
     * conversation or plan. This assignment grants no authority and does not
     * establish the person's acceptance of accountability. */
    part def AccountabilityAssignment {
        ref part accountable : AssemblyCore::HumanOperator;
    }
}
