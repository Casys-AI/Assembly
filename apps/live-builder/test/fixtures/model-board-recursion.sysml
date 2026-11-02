package RecLab {
    private import AssemblyCore::*;
    part def Node {
        part op : HumanOperator;
        part kids : Node;
    }
    part tree : Node;

    part def Leaf { part op : HumanOperator; }
    part def Pair { part left : Leaf; part right : Leaf; }
    part twins : Pair;

    part def Layer0 { part op : HumanOperator; part next : Layer1; }
    part def Layer1 { part next : Layer2; }
    part def Layer2 { part next : Layer3; }
    part def Layer3 { part next : Layer4; }
    part def Layer4 { part next : Layer5; }
    part def Layer5 { part next : Layer6; }
    part def Layer6 { part next : Layer7; }
    part def Layer7 { part next : Layer8; }
    part def Layer8 { part next : Layer9; }
    part def Layer9 { part next : Layer10; }
    part def Layer10 { part next : Layer11; }
    part def Layer11 { part next : Layer12; }
    part def Layer12 { part next : Layer13; }
    part def Layer13 { part next : Layer14; }
    part def Layer14;
    part deep : Layer0;
}
