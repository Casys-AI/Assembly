package TypedValues {
    private import ScalarValues::*;

    enum def Mode { propose; execute; review; }
    action def Capability;
    action invoke : Capability;

    part policy {
        attribute label : String = "legacy";
        attribute enabled : Boolean = true;
        attribute depth : Integer = 2;
        attribute ratio : Real = 1.5;
        attribute hosts : String[0..*] = ("a", "b");
        attribute modes : Mode[0..*] = (Mode::review, Mode::execute, Mode::propose);
        attribute mode : Mode = Mode::execute;
        ref capability = TypedValues::invoke;
        attribute computed : Integer = 1 + 2;
        attribute legacyHosts : String = "[\"a\",\"b\"]";
        attribute legacyMode : String = "execute";
        attribute singletonHosts : String[0..*] = ("a");
        attribute emptyHosts : String[0..*] = ();
        attribute singletonModes : Mode[0..*] = (Mode::execute);
    }
}
