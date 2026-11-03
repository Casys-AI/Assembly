package ASEToolPublicationResult {
    private import ScalarValues::*;
    doc /* Technical publication facts supplied by the allocated catalog reader.
     * Verification criteria belong to the caller's WorkResultContract. */
    item def PublicationExpectation {
        attribute name : String;
        attribute kind : String;
        attribute status : String;
        attribute count : Integer;
    }
    item def PublicationQuery {
        attribute artifactName : String;
    }
    item def PublicationObservation {
        attribute nativeCount : Integer;
        attribute nativeName : String;
        attribute nativeKind : String;
        attribute nativeContractCount : Integer;
        attribute nativeContractKind : String;
        attribute count : Integer;
        attribute name : String;
        attribute kind : String;
        attribute localStatus : String;
        attribute nativeStatus : String;
        attribute storedDigest : String;
        attribute actualDigest : String;
        attribute nativeDigest : String;
        attribute admittedDigest : String;
        attribute admittedCandidateId : String;
        attribute candidateId : String;
        attribute testsPassed : Boolean;
        attribute nativeId : String;
        attribute bindingId : String;
    }
}
