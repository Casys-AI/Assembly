package AssemblyModelEditing {
    private import ScalarValues::*;
    doc /* APE 4.1 Operator Identity & Mandate: bounded source-editing delegation.
     * Proposals remain subject to 2.1 Proposal–Admission–Execution Separation.
     * This declaration configures permissions; it is not execution evidence. */
    part def ModelEditPolicy {
        ref holder : AssemblyCore::SoftwareOperator;
        ref item mandate : AssemblyCore::ConfiguredMandate;
        attribute id : String;
        attribute revision : Integer;
        attribute operations : String;
        attribute grants : String;
        doc /* Explicit source-admitted editing bounds for the bound holder and
         * current mandate. Operations and file/qualified-root pairs are canonical
         * JSON arrays. Definitions alone grant no editing authority. */
    }
}
