# Durable runtime snapshot encoding

`PostgresSystemStateStore` stores current and accepted historical
`SystemRuntimeState` payloads in scoped PostgreSQL `TEXT` columns. A save
captures the original JSON synchronously, then stores exactly one representation
in both tables inside the existing transaction. This encoding changes no domain
data, model or candidate digest, opaque provider content, event, projection or
history identity. `modelPayload` and projection payloads retain their existing
format.

Plain JSON remains readable without a new runtime size cap. Existing rows are
never re-encoded. When a current PostgreSQL state lacks a historical baseline,
backfill copies the original stored payload. Startup compares the decoded
original JSON of current state and history, refusing disagreement. This is not
an importer for former database files. The
[codec](../../../src/adapters/out/postgres/runtime-snapshot-codec.ts) retains
its existing framing and byte identities after removal of the old adapters.

Version 1 compressed payloads use this exact ASCII frame:

```text
assembly-runtime-snapshot:1:gzip:DDDDDDDDDD:HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH:BASE64
```

`D` is the original UTF-8 byte length as ten decimal digits; `H` is the
lowercase SHA-256 of those original bytes. The body is canonical padded base64
of standard gzip, encoded at level 6. The reserved non-JSON prefix identifies
the format; the prefix permits a bounded SQL header read. It is an explicit
storage tag, not heuristic detection. Readers never guess from JSON fields or
gzip-looking text. Unknown versions and codecs, malformed framing/base64,
invalid gzip, length/checksum disagreement and invalid UTF-8 fail closed.

Compression is attempted from 16 KiB through 64 MiB of original UTF-8 JSON.
Smaller, larger or nonbeneficial payloads stay plain. A compressed frame must be
strictly smaller than its original JSON and no larger than 64 MiB. This keeps
codec allocations finite while covering observed approximately 38 MB states; 64
MiB is a codec bound, not a newly imposed domain-state limit. Both declared
decoded size and stored encoded size are checked before inflation. The zlib
output cap equals the declared length; actual decoded bytes and SHA-256 are
checked afterwards. The hash detects corruption; it grants no authenticity or
authority.

Owner-backed PostgreSQL evidence readers first select only the stored byte count
and fixed-size header in SQL. Per-payload and total evidence budgets count
decoded UTF-8 bytes before fetching or decompressing a payload. `bytesRead`
reserves that declared decoded cost before the fetch, including when the payload
is later missing or corrupt. It measures admitted read/decode work, not only
successfully returned snapshots. Live readers propagate that charge to the
remaining global budget across sources. Invalid headers that require no payload
fetch do not consume this byte budget. The beneficial-size invariant also bounds
the encoded fetch by the admitted decoded budget. A dishonest declaration cannot
bypass the zlib output cap. Evidence exports continue returning original JSON
text. Runtime `load`, revision and time reads continue returning the same
validated state types; summary metadata is derived from the validated state.

Direct SQL consumers can still inspect revision, timestamp, summary and model
metadata. A `payload` column can now contain a tagged frame, so tools applying
JSON SQL functions directly to it must use this adapter codec first. Old
binaries that assume every payload is JSON cannot read newly compressed rows.
The schema is unchanged; copying/inspecting rows does not rewrite them. No
database-size or end-to-end latency reduction follows from a raw gzip ratio
alone: those need separate measured evidence.
