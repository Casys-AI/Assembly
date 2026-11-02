package Loops {
    private import ScalarValues::*;
    private import AssemblyCore::*;
    item def Ev;
    action def Step1;
    action def Cyc {
        in item n : Integer;
        action a : Step1;
        action b : Step1;
        action c : Step1;
        first start then a;
        first a then b;
        first b then d1;
        decide d1;
            if n > 3 then c;
            else a;
        first c then done;
        action unreachableOne : Step1;
        action unreachableTwo : Step1;
        first unreachableOne then unreachableTwo;
        first unreachableTwo then unreachableOne;
    }
    state def Ring {
        entry; then s1;
        state s1;
        state s2;
        state s3;
        transition t1 first s1 accept Ev then s2;
        transition t2 first s2 accept Ev then s3;
        transition t3 first s3 accept Ev then s1;
        transition t4 first s2 accept Ev then s2;
    }
    part def Host {
        part op : HumanOperator { attribute operatorName : String = "L"; }
        perform action cyc : Cyc;
        exhibit state ring : Ring;
    }
    part host : Host;
}
