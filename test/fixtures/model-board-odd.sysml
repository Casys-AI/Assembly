package Odd {
    private import AssemblyCore::*;
    part def Host { part op : HumanOperator; port p; }
    part host : Host;
    state def NoInitial { state one; }
}
package DocProbe {
    doc /* Rules apply:
     * * first rule
     * * second rule */
    item def D;
}
package 'Weird::Pkg' { doc /* A quoted package. More detail. */ item def E; }
