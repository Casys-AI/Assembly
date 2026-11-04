# Assembly documentation

Assembly runs a system of agents from its SysML v2 model. Admitted SysML sources
define the system’s rights and behaviors. SysML Toolkit compiles them, Git keeps
their versions, and Assembly controls their execution.

## How Assembly works

```text
chat request → operator acts within its mandate → controlled execution → trace
                 └─ lacks a tool, a right or a collaborator → proposal
proposal → compile and validate → review and admission
         → new model version in Git → adoption → the operator acts again
```

The documentation is organized around eight topics. The first five follow this
loop, starting from the model; the last three surround it. Each Diátaxis
category below uses the same topics and folder names; a category lists only the
topics it has pages for.

1. **Model: the model is the system** (`modeles/`). Operators, mandates, tools,
   flows and policies are declared in textual SysML, kept in a local Git
   project. SysML Toolkit compiles and validates the sources. Verified builds
   feed a native index and the versioned projections that the System and Model
   places display.
2. **Operators: who acts, under which mandate** (`operateurs/`). Operators act
   under mandates declared in the admitted model. They talk through
   conversations and carry work in Cases: Requests, Jobs and Watches.
3. **Context and memory: what a decision may use** (`contexte-et-memoire/`).
   Each decision receives separated context sources: current facts,
   instructions, journal evidence and targeted reads of the model. Skills and
   memory notes enter that context only through governed operations.
4. **Execution: the agent requests, the host decides** (`execution/`). An
   adopted version runs as an execution contract compiled to LangGraph. The
   agent requests decisions as tool calls; the host checks and executes them,
   bounds the work with budgets and closes it only on verified results. Each
   execution records the model version that authorized it.
5. **Evolution: a proposal is not a right** (`evolution/`). When an operator
   lacks a tool, a right or a collaborator, it proposes one. The proposal is
   compiled, reviewed and admitted, becomes a Git commit, then is adopted for
   execution. Until then, rights remain those of the admitted model.
6. **Workbench: where people see and drive the system** (`atelier/`). The
   desktop, the Main Operator conversation, the Dock and Cases. This topic also
   covers installing and operating Assembly.
7. **APE library: the patterns behind the mechanisms** (`bibliotheque-ape/`).
   The _Agentic Process Engineering_ patterns become SysML constructs, engine
   mechanisms and model-doctor rules.
8. **Developing Assembly: code boundaries, decisions, qualification and BMAD**
   (`developpement/`). Where the code is strict and where it is flexible, the
   dated product and architecture decisions, how a flow is qualified, and how an
   increment reuses the existing plans.

Start with [Assembly at a glance](explanation/vue-d-ensemble.md), then
[start a system](how-to/atelier/demarrer-un-systeme.md) and
[evolve a mandate through chat](tutorials/evolution/evolution-mandat.md).

### APE patterns at work

Assembly applies patterns from the _Agentic Process Engineering_ book where the
work happens. Each page describes the current implementation and its limits.
These responsibilities can share services; they do not require one agent per
pattern.

| Pattern                                 | Where it acts                                                                        | Pages                                                                                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator Identity & Mandate             | Operators: narrow mandates, delegated editing rights                                 | [Delegate an editing scope](how-to/operateurs/droits-edition-par-mandat.md), [administer editing rights](how-to/operateurs/administration-deleguee.md)                                                                                             |
| Conversational Case Management          | Operators: one Case across contributions and resumptions                             | [Explanation](explanation/operateurs/gestion-conversationnelle-des-cases.md)                                                                                                                                                                       |
| Deterministic Envelope                  | Operators: scheduled Jobs                                                            | [Explanation](explanation/operateurs/requests-jobs-et-watches.md), [reference](reference/operateurs/cases.md#declared-jobs-and-watches)                                                                                                            |
| Event-Triggered Reassessment            | Operators: Watches                                                                   | [Explanation](explanation/operateurs/requests-jobs-et-watches.md), [reference](reference/operateurs/cases.md#declared-jobs-and-watches)                                                                                                            |
| Centralized Supervision                 | Operators: directed links, inbox and commissioned work                               | [How-to](how-to/operateurs/operer-plusieurs-agents.md), [explanation](explanation/operateurs/conversations-et-contrats-operateurs.md)                                                                                                              |
| Mandate-Based Escalation                | Operators: an authority request is escalated with its change and decided separately  | [Reference](reference/operateurs/autorite-des-operateurs.md#request-escalation-and-closure)                                                                                                                                                        |
| Context Separation                      | Context and memory: the sources a decision may use                                   | [Explanation](explanation/contexte-et-memoire/separation-du-contexte.md), [targeted consultation](reference/contexte-et-memoire/consultation-ciblee-modele.md)                                                                                     |
| Governed Memory Promotion               | Context and memory: from a recorded experience to guidance                           | [Explanation](explanation/contexte-et-memoire/promotion-gouvernee-de-la-memoire.md), [how-to](how-to/contexte-et-memoire/modeliser-contexte-et-memoire.md)                                                                                         |
| Closed-Catalog Selection                | Execution: a closed vocabulary of requests, filtered by context, then call admission | [Explanation](explanation/execution/decisions-par-outils.md)                                                                                                                                                                                       |
| Closed-Catalog Planning                 | Execution: a closed plan validated before dispatch                                   | [Closed work plans](reference/execution/work-plans.md)                                                                                                                                                                                             |
| Verified-Effect Closure                 | Execution: work closes on a verified effect                                          | [Explanation](explanation/execution/cloture-par-effet-verifie.md), [how-to](how-to/execution/verifier-un-resultat-de-travail.md), [reference](reference/execution/resultats-verifies.md)                                                           |
| Budget-Bounded Loop                     | Execution: a ceiling of agent invocations per Case                                   | [Explanation](explanation/execution/boucle-bornee-par-budget.md), [how-to](how-to/execution/borner-un-case.md), [reference](reference/execution/budget-de-travail.md)                                                                              |
| Proposal–Admission–Execution Separation | Evolution: proposing grants no right                                                 | [Explanation](explanation/evolution/proposition-admission-execution.md)                                                                                                                                                                            |
| Fail-Closed Admission                   | Evolution: what admission cannot decide is refused                                   | [Explanation](explanation/evolution/proposition-admission-execution.md), [section on refusing when admission cannot decide](explanation/evolution/proposition-admission-execution.md#refusing-when-admission-cannot-decide--fail-closed-admission) |
| Process Version Governance              | Evolution: accepting sources and putting a version in service are separate steps     | [How-to](how-to/evolution/reviser-systeme.md#adopt-the-version-for-execution), [reference](reference/evolution/revisions-et-historique.md)                                                                                                         |

The [pattern status](reference/bibliotheque-ape/etat-des-patterns.md) covers all
24 catalogue entries, including those without a dedicated page. The
[pattern classification](reference/bibliotheque-ape/patterns-mecanismes-et-guidage.md)
links each one to its book chapter, and the
[model doctor](reference/bibliotheque-ape/validation-du-modele.md) checks a
model against them. The [code map](../src/README.md) and
[model index](../models/README.md) link each pattern to its sources.

## Tutorials

Learn through a complete flow.

### Evolution

- [Evolve a mandate through chat](tutorials/evolution/evolution-mandat.md): a
  network refusal, a proposal, then the same read once authorized.

## How-to guides

Accomplish a task.

### Model

- [Enable the local SysML tools](how-to/modeles/activer-toolkit-local.md).
- [Create and find a local model project](how-to/modeles/projets-locaux.md).
- [Browse the System and Model places](how-to/modeles/parcourir-system-et-model.md).

### Operators

- [Operate several agents in one system](how-to/operateurs/operer-plusieurs-agents.md).
- [Delegate a SysML editing scope through a mandate](how-to/operateurs/droits-edition-par-mandat.md).
- [Administer editing rights through a mandate](how-to/operateurs/administration-deleguee.md).

### Context and memory

- [Explore the model graph](how-to/contexte-et-memoire/explorer-graphe-modele.md).
- [Model an operator’s context and memory](how-to/contexte-et-memoire/modeliser-contexte-et-memoire.md).
- [Install skills and load them into context](how-to/contexte-et-memoire/gerer-les-skills.md).

### Execution

- [Verify a work result](how-to/execution/verifier-un-resultat-de-travail.md).
- [Bound a Case’s agent invocations](how-to/execution/borner-un-case.md).
- [Check the Claude provider against the real API](how-to/execution/verifier-le-fournisseur-claude.md).

### Evolution

- [Propose, compare and adopt a revision](how-to/evolution/reviser-systeme.md).

### Workbench

- [Start a system with its initial foundation](how-to/atelier/demarrer-un-systeme.md).
- [Use a second instance](how-to/atelier/seconde-instance.md).
- [Navigate the desktop and Cases](how-to/atelier/parcourir-le-bureau-et-les-cases.md).

### Developing Assembly

- [Qualify the Request value flow](how-to/developpement/qualify-request-value.md).
- [Run an increment with BMAD and the existing plans](how-to/developpement/utiliser-bmad.md).

## Reference

Consult contracts and their limits.

### Model

- [Local SysML tools](reference/modeles/toolkit-local.md): Toolkit adapter and
  targeted edits.
- [Native model values](reference/modeles/valeurs-typees.md).
- [Model build identities and store](reference/modeles/magasin-des-builds.md).
- [Build service, projections and vault](reference/modeles/service-des-builds.md).
- [Native semantic index](reference/modeles/index-semantique-natif.md):
  identities, cache, transport and lifecycle.
- [Model projections](reference/modeles/projections-du-modele.md): board,
  rights, attention, views and version event.

### Operators

- [Model authority](reference/operateurs/autorite-du-modele.md): owner, root
  mandate and grant.
- [Authority of Request operators](reference/operateurs/autorite-des-operateurs.md).
- [Delegation coverage for the Main Operator](reference/operateurs/couverture-delegation.md).
- [Operator conversations and tools](reference/operateurs/operator-conversations.md).
- [Cases: Requests, Jobs and Watches](reference/operateurs/cases.md).

### Context and memory

- [Targeted SysML model consultation](reference/contexte-et-memoire/consultation-ciblee-modele.md).
- [Initial foundation, tools and skills](reference/contexte-et-memoire/socle-initial-et-skills.md).

### Execution

- [Executed SysML subset](reference/execution/sous-ensemble-sysml-execute.md).
- [Decision transport to the Claude API](reference/execution/transport-claude.md).
- [Closed work plans](reference/execution/work-plans.md).
- [Work budget: invocation contract](reference/execution/budget-de-travail.md).
- [Verified results](reference/execution/resultats-verifies.md).
- [Durable runtime snapshot encoding](reference/execution/snapshot-encoding.md).

### Evolution

- [Revisions and history](reference/evolution/revisions-et-historique.md).
- [Model source writer](reference/evolution/ecrivain-des-sources.md).
- [Concurrent revisions between operators](reference/evolution/multi-agent-revisions.md).
- [Network Impact consultation across versions](reference/evolution/analyse-retrait-reseau.md):
  how an operator’s network routes to a host changed between two model versions.

### Workbench

- [Desktop and Cases: interface contract](reference/atelier/bureau-et-cases.md).

### APE library

- [APE patterns: mechanisms, design choices and guidance](reference/bibliotheque-ape/patterns-mecanismes-et-guidage.md).
- [APE pattern status in the workbench](reference/bibliotheque-ape/etat-des-patterns.md).
- [Model validation and doctor](reference/bibliotheque-ape/validation-du-modele.md).
- [APE constructs and SysML identities](../models/README.md).
- [Find patterns in the current code](../src/README.md).

### Developing Assembly

- [Text limits and character counting](reference/developpement/bornes-de-texte.md).

## Explanation

Understand the choices.

- [Assembly at a glance](explanation/vue-d-ensemble.md): the two uses, the
  evolution loop and what the model describes.

### Model

- [Local models: current architecture](explanation/modeles/modeles-locaux.md).
- [From a verified build to the native index](explanation/modeles/pipeline-modele-natif.md):
  separate preparation and query processes, immutable KV references, and why
  server responsiveness differs from waiting for an index.
- [Why the model is read through versioned projections](explanation/modeles/projections-du-modele.md):
  one read per commit, a pinned and bounded Toolkit, the head followed through
  events.
- [Why System, Model and Activity are separate places](explanation/modeles/pages-system-et-model.md):
  places, navigation and the distinction between the current model and executed
  version.

### Operators

- [Operator conversations and contracts](explanation/operateurs/conversations-et-contrats-operateurs.md):
  distinct cases, cooperation and local authority.
- [Requests, Jobs and Watches](explanation/operateurs/requests-jobs-et-watches.md):
  distinct lifetimes and demo scope.
- [Conversational Case Management](explanation/operateurs/gestion-conversationnelle-des-cases.md):
  one Case across contributions, waiting and resumption.

### Context and memory

- [Context Separation](explanation/contexte-et-memoire/separation-du-contexte.md):
  the sources a decision uses, their provenance and their statuses.
- [Governed Memory Promotion](explanation/contexte-et-memoire/promotion-gouvernee-de-la-memoire.md):
  from a recorded experience to a reusable instruction.

### Execution

- [From SysML to execution](explanation/execution/sysml-et-execution.md): from
  compiled sources to LangGraph, and why a proposal grants no right.
- [Why agent decisions use tools](explanation/execution/decisions-par-outils.md):
  the agent requests, the host decides; limits of strict output and caching.
- [Verified-Effect Closure](explanation/execution/cloture-par-effet-verifie.md):
  a model-carried contract checked before the plan advances.
- [Budget-Bounded Loop](explanation/execution/boucle-bornee-par-budget.md):
  cumulative invocations per Case, kept across resumptions.

### Evolution

- [Proposal–Admission–Execution Separation](explanation/evolution/proposition-admission-execution.md):
  promoting a tool, evolving the sources and refusing when admission cannot
  decide.

### Workbench

- [The desktop and Cases](explanation/atelier/le-bureau-et-les-cases.md):
  workbench organization and the Main Operator’s place.

### APE library

- [Building with APE patterns](explanation/bibliotheque-ape/construire-avec-les-patterns-ape.md):
  constructs, the model doctor, and how guidance, mechanisms and evidence fit.

### Developing Assembly

- [Strict boundaries, flexible code](explanation/developpement/frontieres-du-code.md):
  where the code refuses an act and where it tolerates unknown data;
  responsibilities of the domain, use cases and adapters.
- [Product and architecture decisions, 23–25 October 2026](explanation/developpement/decisions-et-perimetre.md):
  dated choices that frame future work.

## Outside this documentation

The [application README](../README.md) contains notes about views, installation
and development. Work plans, dated reports and research are kept outside this
documentation.
