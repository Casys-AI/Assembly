package BehaviorExample {
    private import ScalarValues::*;
    item def EchoInput {
        attribute text : String;
        attribute times : Integer [0..1];
        attribute loud : Boolean [0..1];
    }
    action def EchoFlow { in request : EchoInput; }
    part def EchoSystem;
    part system : EchoSystem { perform action echo : EchoFlow; }
}
