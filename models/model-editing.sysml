package AssemblyModelEditing {
    private import ScalarValues::*;
    doc /* APE 4.1 Operator Identity & Mandate: bounded source-editing delegation.
     * Proposals remain subject to 2.1 Proposal–Admission–Execution Separation.
     * This declaration configures permissions; it is not execution evidence. */
    part def ModelEditPolicy {
        doc /* M3: factor holder, mandate, issuer, id and revision into a shared
         * abstract AssemblyAuthority::DelegatedPolicy once native readers follow
         * specialization, retaining the optional issuer for implicit owners. */
        ref holder : AssemblyCore::SoftwareOperator;
        ref item mandate : AssemblyCore::ConfiguredMandate;
        ref part issuer : AssemblyAuthority::RootAuthority [0..1];
        doc /* A modeled owner requires an exact binding of issuer to its
         * RootAuthority. Omission is reserved for historical implicit owners. */
        attribute id : String;
        attribute revision : Integer;
        attribute operations : String;
        attribute grants : String;
        doc /* Explicit source-admitted editing bounds for the bound holder and
         * current mandate. Operations and file/qualified-root pairs are canonical
         * JSON arrays. Definitions alone grant no editing authority. */
    }
}
