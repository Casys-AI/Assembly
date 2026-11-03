package InheritedValues {
    private import ScalarValues::*;

    part def Base {
        attribute hosts : String[0..*];
        attribute legacyHosts : String;
    }
    part def Middle :> Base {
        attribute :>> hosts;
        attribute :>> legacyHosts;
    }
    part direct : Base {
        attribute :>> hosts = ("a");
    }
    part twoLevels : Middle {
        attribute :>> hosts = ("b");
        attribute :>> legacyHosts = "[\"legacy\"]";
        attribute selected subsets hosts = ("selected");
    }
    part jsonItem : Base {
        attribute :>> hosts = ("[\"literal\"]");
    }
    part narrowed : Base {
        attribute :>> hosts[1] = "[\"narrowed\"]";
    }

    enum def Mode { a; b; }
    enum current : Mode = Mode::a;
    ref packageReference = InheritedValues::current;
    part enumOwner {
        enum current : Mode = Mode::b;
        ref partReference = current;
    }
}
