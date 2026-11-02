# Mechanical migration helper

Run from `apps/live-builder` with the pinned Deno runtime:

```sh
.data/toolchains/deno-v2.9.7/deno run --allow-read tools/migration/move.ts --manifest moves.json
.data/toolchains/deno-v2.9.7/deno run --allow-read --allow-write tools/migration/move.ts --manifest moves.json --write
```

The manifest is an array of `{ "from": "src/old.ts", "to": "src/new/old.ts" }`
objects. Paths are relative to the workbench and use only ASCII segments
`[A-Za-z0-9_.-]+` separated by `/`. Empty, `.` and `..` segments are refused, as
are spaces, quotes, escapes, query/hash and percent encodings. A neighboring
`_test.ts` or `_test.tsx` follows its source automatically. Existing
destinations are refused. All preflight validation and rewrite planning finish
before the first write. The default invocation only prints the deterministic
JSON report.

The report contains `moves`, module `rewrites`, `importMetaUrl`, living-document
`docLinks` and coded `errors` with context and recovery. Errors produce exit
code `1`. Unknown or repeated CLI options are errors. Files mentioning
`import.meta.url` are reported for manual loader review; their URL literals
remain unchanged.

Module literals in imports, exports, side-effect imports and dynamic imports are
updated in `src`, `test`, `tools`, `frontend` (excluding `_fresh`) and
`examples`. Relative dependencies of moved importers are recalculated too.
Comments, ordinary strings, template literal text and provenance values remain
unchanged. This narrow lexer is not a TypeScript parser. Template literal text
remains opaque while imports in interpolated expressions, including nested
templates, are recognized. JSX tag text and quoted attributes in `.jsx` and
`.tsx` are opaque; JavaScript expressions in attributes and children are scanned
recursively. Unterminated JSX produces a coded refusal rather than an incomplete
rewrite. Specifiers with escape sequences and percent-encoded file names require
manual review; this helper targets the repository's ordinary relative file
paths.

Relative inline Markdown links (including titles and angle-wrapped targets) and
reference-definition links are updated in living `docs`, repository
`CONTRIBUTING.md`, `src/README.md` and workbench `AGENTS.md`. Planning history
is untouched. Fenced and inline code examples remain literal. HTML links and
targets containing spaces are outside this tool's scope.

The entry point, Toolkit pins, data, frontend routes and generated Fresh files,
project configuration, `vendor`, `native`, `models` and `prototypes` are
protected. The SHACL diagnostics shape must move with its owning diagnostics
module. Symlink traversal is refused. Known Toolkit, authority-matrix and
semantic process groups must move with their clients and fixtures.
`.codex-hot-files.txt` at repository root blocks moves and document changes; hot
code may only receive imports rewritten for moved targets.

A filesystem error during application is reported, but application is not an
atomic transaction. Inspect a partial write before retrying. Run a dry run
first, review loader URLs, then use the repository's pinned test tasks to
qualify the result. The setup profile explicitly registers
`tools/migration/move_test.ts`. Run this focused selection through the shared
lock:

```sh
nice -n 10 .data/toolchains/deno-v2.9.7/deno task test:setup tools/migration/move_test.ts
```
