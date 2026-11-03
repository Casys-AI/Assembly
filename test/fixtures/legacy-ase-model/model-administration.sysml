package ASEModelAdministration {
    private import ScalarValues::*;
    doc /* APE 4.1 Operator Identity & Mandate: bounded authority to grant and
     * redelegate source-editing rights. Proposals remain subject to 2.1
     * Proposal–Admission–Execution Separation. This declaration configures
     * permissions; it is not execution evidence. */
    part def ModelAdministrationPolicy {
        ref holder : ASECore::SoftwareOperator;
        ref item mandate : ASECore::ConfiguredMandate;
        ref part issuer : ASEAuthority::RootAuthority [0..1];
        doc /* A modeled owner requires an exact binding of issuer to its
         * RootAuthority. Omission is reserved for historical implicit owners. */
        attribute id : String;
        attribute revision : Integer;
        attribute operations : String;
        attribute grants : String;
        attribute recipients : String;
        attribute maxRedelegationDepth : Integer;
        doc /* Explicit source-admitted administration bounds for the bound
         * holder and current mandate. Operations, file/qualified-root pairs
         * and exact eligible ConversationSystem qualified names are canonical
         * JSON arrays. Depth is 0..8; zero permits direct editing grants but no
         * further administration grants. Administration grants no editing
         * power by itself. Definitions alone grant no authority. */
    }
}
