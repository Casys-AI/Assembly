# Authority matrix reference snapshots

Copied unchanged on 2026-10-25 from the B0 prototype's logical
`scratchpad/board` export. The original scratchpad is external evidence and is
not included in this repository.

These Toolkit 0.10.10 snapshots document the prototype semantics. They predate
modeled owners and the B4 closed transport contract: host anchors contain old
file/line strings and some diagnostics have no recovery field. They are
reference inputs for semantic comparisons, not current output goldens. Current
tests build the synthetic sources locally with
`test/support/authority-matrix-source-fixtures.ts`. No test reads the scratchpad
at runtime.

## Historical `file:line` strings

The `enforcedAt` fields of these snapshots (144 strings in all, for example a
path under `src/` followed by a line range) cite source locations as they were
when the prototype ran. They are stale by construction and are kept only because
the files are copied unchanged. No test reads them: the only consumer,
`test/integration/authority-matrix-contract_test.ts`, reads column ids, cell
column references and cell codes. Production output never carries such a
citation: `enforcedAt` is one of the four symbolic anchors of
`src/adapters/authority-host-anchors.ts`, and
`test/support/assert-closed-authority-matrix.ts` fails any projected matrix that
contains a `.ts:` source citation.
