package ASEInitialTools {
    private import ScalarValues::*;

    item def ToolSeed {
        attribute id : String;
        attribute name : String;
        attribute description : String;
        attribute kind : String;
        attribute code : String;
        doc /* An optional source-owned selection in a classic ToolCatalog.
         * These exact bytes enter the normal candidate tests and admission flow.
         * A selected seed is neither a ToolCandidate nor an active capability;
         * it carries no verdict, admission receipt or ambient permission. */
    }
}
