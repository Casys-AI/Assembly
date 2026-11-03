# Executed SysML subset

Code state inspected on 30 October 2026. Assembly compiles a subset of SysML
behavior into an execution contract, then into a LangGraph graph. A SysML file's
validity, its visibility in a view and its executability by Assembly are
distinct properties.

This page maps the implemented path and its test entry points. It claims neither
conformance with all of SysML v2 nor a new execution of these tests during this
documentation pass.

See [From SysML to execution](../../explanation/execution/sysml-et-execution.md)
for the compilation, publication and runtime boundaries.

<a id="pipeline-at-the-inspected-revision"></a>

## Current pipeline

SysML Toolkit compiles and checks sources through the Rust N-API addon in a
child process. Assembly normalizes its full interchange, materializes compiled
facts and validates the executable contract. Executable compilation reads these
facts, not the layout graph or RDF index. The runtime adapter maps the admitted
flow's nodes and edges to LangGraph; host handlers implement the primitives.

The normalizer retains native identities and source extents. It also recognizes
source spelling such as `else` and retains a compatibility repair for Toolkit
implicit transitions whose source points to themselves. `semanticDigest` is the
informational digest of a reduced IR; it is not the model's identity.

Sources:
[compiler](../../../src/adapters/out/sysml-toolkit/compilation/compiler.ts),
[normalizer](../../../src/adapters/out/sysml-toolkit/compilation/normalizer.ts),
[materialization](../../../src/adapters/model/builds/materialization/artifact.ts),
[compiled contract](../../../src/domain/model/records/compiled-model.ts),
[LangGraph adapter](../../../src/adapters/work/runtime/native-graph.ts).

## Flow coverage

| Construct   | Implemented behavior                                                                          | Limit or refusal                                                            |
| ----------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Root        | Concrete native occurrence, resolved before flow compilation                                  | Missing or ambiguous root refused; the workbench assembly is still required |
| Actions     | Direct children of the root, typed by a single definition associated with a primitive         | Unknown types, ambiguous names and nested executable elements refused       |
| Registry    | A closed registry of fully qualified types can replace the historical table                   | Registering an implementation grants it no rights                           |
| Control     | Start, end, decision and merge; successions and transitions without events                    | `ForkNode`, `JoinNode` and events unsupported                               |
| Branches    | Decision guards, at most one `else`, unambiguous control and reachable nodes                  | Several true guards or no admissible branch: error                          |
| Expressions | Booleans, numbers, strings, paths, `not`, `and`, `or`, `implies`, comparisons and parentheses | No general arithmetic; missing value or incompatible comparison: error      |
| Bindings    | Checked local paths, directions and a single provider for each input                          | Unsafe path, inconsistent binding or duplicate provider refused             |
| Assertions  | Primitive assertions: inputs before the call, inputs/outputs after return                     | Composite assertions and unsupported placements refused                     |
| Waiting     | LangGraph interrupts and checkpoint resumption under the exact admitted model                 | This mechanism is not a general SysML event or timer engine                 |
| Budget      | Flow-step ceiling checked at runtime                                                          | Explicit overrun; this ceiling does not replace other budgets               |

The runtime expects a primitive's declared outputs, propagates bindings and
preserves execution state in checkpoints. Its events retain native identity and
source provenance. Logical operators evaluate both operands: they do not promise
JavaScript-style short-circuiting.

Sources:
[flow compilation and expression evaluation](../../../src/domain/model/execution/flow.ts),
[flow tests](../../../src/domain/model/execution/flow_test.ts),
[runtime graph](../../../src/adapters/work/runtime/native-graph.ts).

## Bounded immutable consultation profile

The current source also declares `operator-command-immutable-group-v1` as a
standalone operator flow profile. An eligible command occurrence can be refined
into at most four immutable consultation workers and a durable join before the
flow continues. Other commands retain their ordered scalar behavior. This
profile does not add general SysML fork/join support; its implementation and
qualification are distinct from adoption of the profile by a configuration.
Existing admitted pins retain their selected profile.

Sources: [conversation template](../../../models/conversation.sysml),
[profile compiler](../../../src/adapters/out/sysml-toolkit/compilation-policies/work/operator-flow.ts),
[native graph](../../../src/adapters/work/runtime/native-graph.ts).

## Workbench coupling

The core is not yet generic across all assemblies:

- `ExecutableModel.flows` requires `conversation` and `promotion`;
- native authority expects a `ConversationSystem` occurrence;
- the central envelope remains `conversational-case-management`, the
  Conversational Case Management pattern;
- `compileExecutableModel` expects roots named `conversation` and `promotion`;
  promotion remains typed by `CapabilityPromotion` or
  `ReviewedCapabilityPromotion`;
- conversation accepts the historical `ConversationCase` or a standalone action
  definition declaring `executionProfile = "operator-command-v1"` or
  `"operator-command-immutable-group-v1"` and a positive `templateRevision`.
  Both require explicit consultation and command actions, with successful fresh
  consultation on every path to a new decision. The command submission guard
  waits after a successfully recorded decision on the exact waking authority
  notice; other command outcomes return through observation. The template
  revision remains 1 for these profiles: the changed admitted source and flow
  produce new compiled identities, while existing pins retain their contract;
- scheduled Case flows are optional, but remain bounded by the registry of
  admitted conversational primitives.

Removing these requirements from the core, while retaining them in the current
assembly, remains to be done. The existence of a primitive registry does not
complete it.

Sources:
[executable model](../../../src/domain/model/execution/executable-model.ts),
[workbench compilation](../../../src/adapters/out/sysml-toolkit/compilation-policies/work/execution-model.ts),
[operator flow selection](../../../src/adapters/out/sysml-toolkit/compilation-policies/work/operator-flow.ts).

## Verification and recovery

The flow tests already cover conversation and promotion flows, changes to a
guard or destination, suspension without repeating earlier steps, refusal of
unknown constructs, assertions before effects and permutation of projection
arrays.

Assembled flows are covered in the integration tests: `system-runtime_test.ts`,
`review-native-integration_test.ts`, `operator-case-continuations_test.ts` and
`source-execution_test.ts`. Work package 0 must still establish the complete
scenario → test → expected trace table, then run qualification on the selected
head. The list of files is not that qualification result.

Production uses PostgreSQL-backed LangGraph checkpoints and an execution ledger
that binds contributions, model pins and effect receipts. Completed effect
receipts can be reused; an uncertain effect blocks fresh dispatch pending
reconciliation. Checkpoint persistence does not establish exactly-once behavior
for an external service.

Adoption is explicit and checks retained executions. A verified empty input wait
can be retired in favor of an authorized successor; an unfinished promotion
cannot silently switch to a different promotion flow. Legacy cursor fields
remain readable but are not the current runtime scheduler.

Sources:
[conversation turn](../../../src/application/work/conversation/turn.ts),
[promotion flow](../../../src/application/work/candidates/promotion-flow.ts),
[PostgreSQL runtime](../../../src/adapters/work/runtime/postgres.ts),
[execution ledger](../../../src/adapters/work/runtime/postgres-ledger.ts),
[model adoption](../../../src/application/work/runtime/model-adoption.ts).
