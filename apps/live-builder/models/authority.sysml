package AssemblyAuthority {
    private import ScalarValues::*;

    part def RootAuthority {
        attribute id : String;
        doc /* Initial authority of one system, held by its modeled owner.
         * Creation and replacement require the local owner's decision. */
    }
    item def Mandate {
        ref part holder : AssemblyCore::Operator;
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
        subject system : AssemblyLiveBuilder::ConversationSystem;
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
        subject system : AssemblyLiveBuilder::ConversationSystem;
        doc /* Invariant 2 — Inclusion. A delegated grant remains within its
         * parent grant's capability, mode and scope, with strictly decreasing
         * delegation depth. Descendant grants never expand automatically. */
    }
    requirement def PriorStateAuthorization {
        subject system : AssemblyLiveBuilder::ConversationSystem;
        doc /* Invariant 3 — Prior-state authorization. A proposal and its
         * admission are authorized by grants in the base version, never by
         * rights they introduce. A mandate change grants only capabilities
         * within its authorized ceiling. */
    }
    requirement def ProposalIsNotGrant {
        subject system : AssemblyLiveBuilder::ConversationSystem;
        doc /* Invariant 4 — A proposal is not a grant. No right is granted
         * before the proposal has been admitted and adopted. */
    }
    requirement def CurrentAuthorityAtUse {
        subject system : AssemblyLiveBuilder::ConversationSystem;
        doc /* Invariant 5 — Authority at use. Before execution, each effect
         * checks its grant in the currently adopted version. */
    }
    part def SpaceControlPolicy {
        doc /* Explicit CAP-3 control for a modeled local owner. A bounded source
         * grant is distinct from authentication and each space's revocable
         * admission. Historical Release grants are never current authority.
         * This slice binds exactly one operator; acts use a canonical JSON array
         * of explicit open-request, execute-conversation, revoke-execution and
         * retain-release. Adding vocabulary never extends an old policy. */
        ref part holder : AssemblyCore::HumanOperator;
        ref item mandate : Mandate;
        ref part issuer : RootAuthority;
        ref part allowedOperator : AssemblyCore::SoftwareOperator;
        attribute id : String;
        attribute revision : Integer;
        attribute enabled : Boolean;
        attribute acts : String;
    }

    part def OperatorCreationPolicy {
        doc /* Bounded creation authority. A child receives creation authority
         * only through an explicit parent binding with narrower bounds and
         * strictly smaller delegation depth. Parenthood alone grants nothing.
         * Without mode the holder creates autonomously within the bound;
         * mode "per-creation" routes every creation to a decider instead.
         * Read in a Request branch the policy applies inside that branch
         * only, against the whole branch team. */
        ref holder : AssemblyCore::SoftwareOperator;
        ref item mandate : AssemblyCore::ConfiguredMandate;
        ref part issuer : RootAuthority;
        ref part parent : OperatorCreationPolicy[0..1];
        attribute id : String;
        attribute revision : Integer;
        attribute enabled : Boolean;
        attribute networkHosts : String;
        attribute maxChildren : Integer;
        attribute maxDelegationDepth : Integer;
        attribute mode : String;
    }
    part def OperatorAuthorityPolicy {
        doc /* M3: factor holder, mandate, issuer, id and revision into a shared
         * abstract DelegatedPolicy once native readers follow specialization.
         * M3: use typed multi-valued bounds once native readers support them.
         * Until then recipients, acts, networkHosts and toolIds use canonical
         * JSON arrays, with the same encoding as ModelEditPolicy.
         * Without recipientSpace, recipients are instances of the execution
         * space where the policy is read (main or a Request branch); with it,
         * they are instances of that space, effective only when read there
         * or in main. */
        ref holder : AssemblyCore::SoftwareOperator;
        ref item mandate : AssemblyCore::ConfiguredMandate;
        ref part issuer : RootAuthority;
        attribute id : String;
        attribute revision : Integer;
        attribute enabled : Boolean;
        attribute recipients : String;
        attribute recipientSpace : String;
        attribute acts : String;
        attribute networkHosts : String;
        attribute toolIds : String;
        attribute maxDelegationDepth : Integer;
    }
    part def ToolAdmissionPolicy {
        doc /* Bounded admission of another operator's exact tested candidate.
         * Recipients and toolKinds are canonical JSON arrays of native operator
         * identities and supported kinds. No delegation or file access follows.
         * recipientSpace scopes recipients as in OperatorAuthorityPolicy. */
        ref holder : AssemblyCore::SoftwareOperator;
        ref item mandate : AssemblyCore::ConfiguredMandate;
        ref part issuer : RootAuthority;
        attribute id : String;
        attribute revision : Integer;
        attribute enabled : Boolean;
        attribute recipients : String;
        attribute recipientSpace : String;
        attribute toolKinds : String;
        attribute maxDelegationDepth : Integer;
    }

}

package AssemblyEvolution {
    private import ScalarValues::*;
    part def EvolutionPolicy {
        doc /* Prior, bounded authority for prepare, accept and adopt. Grants
         * contain exact native targets and category-specific closed bounds.
         * Presence grants no general editing, creation or invocation right. */
        ref holder : AssemblyCore::SoftwareOperator;
        ref item mandate : AssemblyCore::ConfiguredMandate;
        ref part issuer : AssemblyAuthority::RootAuthority;
        attribute id : String;
        attribute revision : Integer;
        attribute grants : String;
    }
}
