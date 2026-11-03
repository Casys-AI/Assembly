package ASEAuthority {
    private import ScalarValues::*;

    part def RootAuthority {
        attribute id : String;
        doc /* Initial authority of one system, held by its modeled owner.
         * Creation and replacement require the local owner's decision. */
    }
    item def Mandate {
        ref part holder : ASECore::Operator;
        attribute id : String;
        attribute revision : Integer;
        doc /* Stable authority identity and its revision. The owner's mandate
         * contains the root authority and its root grant. Existing software
         * ConfiguredMandate declarations retain their historical encoding. */
    }
    part def RootGrant {
        attribute id : String;
        ref part issuer : RootAuthority;
        doc /* Root grant carried by the owner's mandate. It authorizes the
         * existing local owner decisions: mandate changes, tool admission,
         * model revision and adoption, memory promotion and skill installation.
         * Delegation still uses each existing bounded mechanism; this grant
         * creates no software permission by itself. */
    }

    requirement def ExplicitAuthorityRoot {
        subject system : ASELiveBuilder::ConversationSystem;
        doc /* Invariant 1 — Explicit root. Every grant traces back to a
         * RootAuthority through a valid chain of issuers and parents.
         * A legacy system without a modeled owner retains only its previous
         * rights and reports ownerSource as implicit-legacy.
         * The reserved schema marker is a direct system AttributeUsage named
         * authoritySchema, typed ScalarValues::Integer, with an integer literal.
         * Its supported value is 2 and it requires a modeled owner. Other uses
         * of this name, including String attributes, are business members. */
    }
    requirement def DelegatedAuthorityInclusion {
        subject system : ASELiveBuilder::ConversationSystem;
        doc /* Invariant 2 — Inclusion. A delegated grant remains within its
         * parent grant's capability, mode and scope, with strictly decreasing
         * delegation depth. Descendant grants never expand automatically. */
    }
    requirement def PriorStateAuthorization {
        subject system : ASELiveBuilder::ConversationSystem;
        doc /* Invariant 3 — Prior-state authorization. A proposal and its
         * admission are authorized by grants in the base version, never by
         * rights they introduce. A mandate change grants only capabilities
         * within its authorized ceiling. */
    }
    requirement def ProposalIsNotGrant {
        subject system : ASELiveBuilder::ConversationSystem;
        doc /* Invariant 4 — A proposal is not a grant. No right is granted
         * before the proposal has been admitted and adopted. */
    }
    requirement def CurrentAuthorityAtUse {
        subject system : ASELiveBuilder::ConversationSystem;
        doc /* Invariant 5 — Authority at use. Before execution, each effect
         * checks its grant in the currently adopted version. */
    }
    part def OperatorAuthorityPolicy {
        doc /* M3: factor holder, mandate, issuer, id and revision into a shared
         * abstract DelegatedPolicy once native readers follow specialization.
         * M3: use typed multi-valued bounds once native readers support them.
         * Until then recipients, acts, networkHosts and toolIds use canonical
         * JSON arrays, with the same encoding as ModelEditPolicy. */
        ref holder : ASECore::SoftwareOperator;
        ref item mandate : ASECore::ConfiguredMandate;
        ref part issuer : RootAuthority;
        attribute id : String;
        attribute revision : Integer;
        attribute enabled : Boolean;
        attribute recipients : String;
        attribute acts : String;
        attribute networkHosts : String;
        attribute toolIds : String;
        attribute maxDelegationDepth : Integer;
    }
    part def ToolAdmissionPolicy {
        doc /* Bounded admission of another operator's exact tested candidate.
         * Recipients and toolKinds are canonical JSON arrays of native operator
         * identities and supported kinds. No delegation or file access follows. */
        ref holder : ASECore::SoftwareOperator;
        ref item mandate : ASECore::ConfiguredMandate;
        ref part issuer : RootAuthority;
        attribute id : String;
        attribute revision : Integer;
        attribute enabled : Boolean;
        attribute recipients : String;
        attribute toolKinds : String;
        attribute maxDelegationDepth : Integer;
    }

}
