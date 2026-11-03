# Strict boundaries, flexible code

Assembly must refuse an act that exceeds a mandate without making its own
history unreadable at the first unknown field. These needs concern different
moments and objects: deciding an act commits authority; displaying information
grants none.

This distinction was retained in the flexibility review of October 25, 2026. It
explains development choices; it does not mean that all current readers already
comply. Historical reports are kept in the October 25 audit.

## What remains strict

Controls stay closed where data becomes a decision or a right:

- agent outputs, HTTP commands, and file or network inputs;
- operator identity, mandate and delegation resolution;
- admission, testing and activation of the exact candidate under the admitted
  model;
- source-writer preimages, digests, versions and publication receipts;
- network policy and budget reservation before a call;
- conditions that enable an action button, even when its presentation can
  display unknown values.

Text in a conversation does not become approval. An unknown value, read error or
outage never grants more rights. Controls at decision time remain necessary:
state may have changed since the card was prepared.

The [code boundaries](../../../CONTRIBUTING.md#frontières-du-code) separate
domain rules, their orchestration and technical implementations. Extracting a
file must not introduce a second rule in place of the one it moves.

## Read without inventing

The agreed direction for host-written data is to verify its integrity and
revision chain without rejecting a read because of an additional key that grants
no rights. Tolerance must not hide a corrupt row: it requires a localized error
or visible degradation. Migrating stores to this reading strategy remains an
open work package.

The same principle applies to the frontend. An unknown value should be
presentable as such, including its raw value, while actions remain conditional
on an exact match. This is the target of D2; it is not yet generalized across
interface parsers.

Two existing examples illustrate this direction:

- `source-values.ts` produces an `unsupported` value with its reason rather than
  omitting it;
- `board-store.ts` keeps the last readable version and a coded problem when a
  refresh fails.

## An outage is not a refusal

Since D3 (`c1395dd`), `BehaviorInvocationPort.supports()` returns `false` for a
contract the provider does not serve. A Toolkit or Git outage, or a timeout,
surfaces with its cause; it does not become an admission refusal. Admission
remains controlled within the invocation.

`pinnedResolution`, in `src/application/work/behaviors/invocation.ts`, caches
successful resolutions, including `null` when the pin does not match. A rejected
promise is removed from the cache and its error propagates. A transient outage
therefore does not condemn subsequent calls until cache eviction.

Budget settlement and its display also have separate obligations. In
`budgeted-agent.ts`, a failed `settle` makes the call fail. After successful
settlement, a failed `snapshot`/`observed` refresh is reported without
discarding an agent response that has already been paid for.

The Claude transport preserves the original error as `cause`. The
`transport failure` category covers fetch, stream reading or an abort; other
failures keep their category. The
[transport reference](../../reference/execution/transport-claude.md) describes
exposed errors. Preserving the cause does not replace bounded Ajv details, which
still need to be added to the final error after repair.

## An explicit bound for each use

For a human message, D1 (`ea55739`) selected an explicit limit and a refusal
beyond that limit. The field never silently cuts typed or pasted text; it shows
a counter near the limit and retains the text if sending fails.

The projection sent to the language model may instead be truncated with a
marker. The journal keeps the full message. These two representations therefore
make different promises. Details are in the
[text bounds](../../reference/developpement/bornes-de-texte.md).

`MAX_USER_MESSAGE_CHARS` is a human-text limit measured in UTF-16 units
(`String.length`). `characterCount` counts code points for bounds matching JSON
schemas. The presence of this helper does not prove that all constants are
shared: the rest of D6 still targets this single source.

## Proportionate changes

The review rejected a general candidate state machine in favor of narrower
`stage()` typing, and limited type extraction to the boundaries that need it. It
also abandoned a complete reorganization by subdomain. These are scope choices,
not claims that all code has already been refactored.

A fix must protect observed behavior: persisted formats, digests, rights,
refusals and recovery. Sorting changes only when a test reveals drift in
persisted order; an activation rule is relaxed only after a dedicated review.
