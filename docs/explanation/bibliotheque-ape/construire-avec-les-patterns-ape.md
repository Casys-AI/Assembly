# Building with APE patterns

APE patterns describe responsibilities, conditions and evidence to preserve. A
SysML library must give them reusable forms that the engine can interpret. The
modeling skill helps the operator choose and assemble these forms; execution
controls enforce the obligations that protect changes.

The initial inventory of 22 October distinguishes the starting constructs, their
tests and proposed additions. It does not claim that all 24 entries are already
executable.

The first implementation increment for Context Separation and Governed Memory
Promotion now has a
[modeling guide](../../how-to/contexte-et-memoire/modeliser-contexte-et-memoire.md)
and a separate qualification. The
[classification of the 24 entries](../../reference/bibliotheque-ape/patterns-mecanismes-et-guidage.md)
clarifies what belongs to design choice, mechanism and diagnostics.

## The doctor advises on the model

The doctor reads compiled facts to flag a missing construct or an undetermined
property. It does not make every pattern mandatory: a model may execute without
following them. A good-practice warning is distinct from a compilation or
authority error that blocks an operation.

This first level lets the system examine its design before adding new
mechanisms. A proposed correction follows the normal revision path and its
rights. Hiding a diagnostic is a local instance preference; it does not change
the shared model. The Main Operator's context may receive diagnostics, without
this demonstrating that the future complete panel exists.

The
[validation reference](../../reference/bibliotheque-ape/validation-du-modele.md)
gives the scope of the five rules currently present. The
[pattern inventory](../../reference/bibliotheque-ape/etat-des-patterns.md)
distinguishes these mechanisms from their planned extensions. A declared form
establishes neither its execution nor acceptance of a responsibility.

## A construct is more than a pattern name

For PAE, writing "apply PAE" in instructions does not connect admission to the
tool actually enabled. The model must identify the candidate, its arguments,
version and applicable decision; the activation mechanism must verify that
decision before changing the catalog.

Assembly already provides a basis for this case: promotion follows admitted
native flows, and activation requires an approved decision for the exact digest.
This is not yet a universal control component for every effect.

Proposal, admission and execution responsibilities may reside in the same
service. Independent review is an additional requirement a system may declare.
The number of agents does not define separation.

## The role of the skill and library

The bundled [`assembly-modeling`](../../../skills/assembly-modeling/SKILL.md)
skill guides the builder through admitted sources, bindings, revisions and the
distinction between declarations and evidence. It is not yet a detailed manual
of the 21 patterns. Completing it requires describing their applicability
conditions, invariants, variants and actually available mechanisms, with
examples and tests that establish the controls.

The library carries reusable data contracts, parts, ports, behaviors, guards and
requirements. The concrete system chooses holders, policies, limits and allowed
links. Importing a definition does not instantiate it or provide an executor.

An explicit list of required patterns for the system may specify their scope and
parameters: PAE for governed changes, Context Separation for decision sources,
Memory Promotion if experience should become shared guidance. This does not
impose every envelope and control on every operation.

## Why separate tools, context, memory and skills

A conventional tool performs an operation. Its initial selection or proposal
provides a candidate; its tests and admission determine whether it may enter the
active catalog. Context organizes the information presented to choose the next
action. It exists from the start, with a policy and access to exact journal
evidence.

Memory retains the operator's contributions and distinguishes their status. A
captured note remains a candidate until authorized admission promotes it. The
initial baseline forbids self-admission; it therefore does not automatically
turn the builder's observations into guidance. This policy decision is separate
from having memory available.

Skills belong to context because they provide work instructions. Their catalog
retains versioned texts, and their selection indicates which ones are loaded.
Installing, loading and unloading are three separate operations. A skill may
help an agent build a tool or propose a memory policy, but its text grants no
right.

In the initial model, these sets are grouped together, and their access remains
tied to the caller and the relevant operation. The organization makes their
roles readable; guards and the engine enforce controls. The
[baseline reference](../../reference/contexte-et-memoire/socle-initial-et-skills.md)
describes this concrete assembly.

## Context, memory and consumption

Context Separation distinguishes contributions that inform a choice: current
state, shared guidance, applicable instructions and temporary information.
Context preparation retains their origin, version, status, scope, freshness and
permitted use. An older expectation in a message must not silently replace the
current state of the case.

Governed Memory Promotion concerns a different transition: an observation may
become a candidate note, then be admitted as reusable guidance. Contribution and
admission have separately established rights. Recall may make a candidate note
visible with its status without promoting it. Admitting a note does not
implicitly change a skill or mandate; their own change paths still apply.

The complete journal preserves evidence. The view supplied for a decision may
select useful facts and retrievable references. Making this selection evolvable
requires a policy contract and a mechanism that actually consumes it; a new
uninterpreted SysML declaration is insufficient.

A record of the latest call and cumulative consumption may give the operator
compact visibility into usage; a read tool may supply detail on request. If a
limit must block continued work, Budget-Bounded Loop requires more: a stable
scope, persistent counters, a ceiling, a check before continuation and an
exhaustion disposition. A cost display or a per-call output limit does not
provide this governance.

Assembly now implements this control for a specific unit:
[agent invocation per case](../execution/boucle-bornee-par-budget.md). The model
sets the ceiling and stop disposition; the registry retains reservations and
consumption across messages and restarts. This unit is distinct from tokens or
provider cost.

## Evolving the system without hiding developer work

Straightforward engine fixes remain legitimate. It is necessary to identify what
belongs to the generic mechanism and what is a system policy intended to become
modifiable by its operators.

The coordinator may diagnose and propose an improvement if it receives the
necessary observations and has an appropriate revision route. Proposal,
validation, merge and adoption remain separate under the admitted delegations.
Adding observation and a configurable mechanism may initially be developer work;
it does not demonstrate that the operator discovered the policy to apply.

An explainable qualification therefore retains the assigned objective, initially
supplied capabilities, operator decisions, developer interventions, admitted
changes and measured effects. Comparison must check both the intended
improvement and preservation of facts and controls necessary for the work.

## Qualifying constructs progressively

Structural validation may establish types, references and some required links.
Guards must block forbidden operations before their effects. Execution
observations and trials then establish what actually happened: a compiled model
does not prove a durable write or acceptance of a responsibility.

For the next constructs, the proposed path is to clarify the book's contract and
its variants, describe the SysML assembly, identify the required primitives,
then qualify the nominal case and relevant refusals. The three 6.x warning signs
become review questions and negative tests for the affected paths; they do not
require three new subsystems.
