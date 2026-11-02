package ASECases {
    private import ScalarValues::*;

    enum def EnvelopeKind { conversational; deterministic; reassessment; }

    enum def ScheduleUnit { minute; hour; day; }
    attribute def Schedule;
    attribute def Every :> Schedule {
        attribute count : Natural;
        attribute unit : ScheduleUnit;
    }
    attribute def DailyAt :> Schedule {
        attribute hour : Natural;
        attribute minute : Natural;
    }

    part def CaseType {
        attribute envelope : EnvelopeKind;
        ref action behavior : Actions::Action;
        ref part owner : ASECore::SoftwareOperator;
        attribute maxInvocations : Integer [0..1];
        attribute schedule : Schedule [0..1];
    }
}
