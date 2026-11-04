import { sha256Bytes as sha256 } from "../../../domain/primitives/sha256-bytes.ts";
import { ExplicitTooling } from "../../../../test/support/explicit-tooling.ts";
import {
  SysmlToolkitTimeoutError,
  SysmlToolkitWorkerError,
} from "../../../adapters/out/sysml-toolkit/worker-client.ts";
import assert from "node:assert/strict";
import {
  applyEdits,
  assertSourceSplices,
  MAX_HOST_EDIT_DATA_CHARS,
  MAX_HOST_EDIT_TEXT_BYTES,
  readHostEditText,
  verifyEdits,
} from "./host-writer.ts";
import {
  HostEditError,
  type HostEditRequest,
  spelling,
} from "../../../domain/model/editing/host-edit.ts";
import { ToolkitCompiler } from "../../../adapters/out/sysml-toolkit/compilation/compiler.ts";
import { SysmlToolkitAdapter } from "../../../adapters/out/sysml-toolkit/adapter.ts";
import {
  modelSourceElement,
  modelToolingTarget,
} from "../../../domain/model/editing/source-index.ts";
import { sourceLiterals } from "../../../domain/model/projections/source-facts.ts";

import { toolkitIntegrationEnabled } from "../../../../test/support/toolkit-integration.ts";
import { MemorySourceRepository } from "../../../../test/support/memory-source-repository.ts";
import type { ModelToolingPort } from "../tooling.ts";
import {
  type ChangePublication,
  MAX_APPROVAL_RECEIPT_BYTES,
  publicationFailure,
} from "../../../domain/model/publication/change.ts";
import { exerciseOwnerAuthority } from "../../../domain/governance/authority.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { operatorAuthorityRequests } from "../../../composition/source-model-services.ts";

const sources = {
  "scalars.sysml": `package Scalars {
private import ScalarValues::*;
// 台灣: byte extents must include the UTF-8 prefix.
attribute json : String = "[]";
attribute label : String = "before";
attribute enabled : Boolean = false;
attribute count : Integer = 1;
}`,
};
const request = (
  name: string,
  value: Extract<HostEditRequest, { op: "setFeatureValue" }>["value"],
): Extract<HostEditRequest, { op: "setFeatureValue" }> => ({
  op: "setFeatureValue",
  target: { qualifiedName: `Scalars::${name}` },
  value,
});
const coded = (code: HostEditError["code"]) => (error: unknown) => {
  assert(error instanceof HostEditError);
  assert.equal(error.code, code);
  assert.equal(
    error.recovery,
    code === "TARGET_MODIFIED" ? error.recovery : "refuse",
  );
  if (code === "TARGET_MODIFIED") {
    assert.deepEqual(error.recovery, { action: "reload" });
  }
  assert.equal(typeof error.context.opIndex, "number");
  assert.equal(error.context.op, "setFeatureValue");
  return true;
};

function compiledSnapshotFixture() {
  const revision = (text: string) => ({
    version: "base",
    sources: { "test.sysml": text },
    elements: [{
      "@id": "p",
      "@type": "Package",
      qualifiedName: "P",
      declaredName: "P",
      "sysx:sourceDocument": "test.sysml",
      "sysx:sourceLine": 1,
      "sysx:sourceColumn": 1,
      "sysx:sourceEndLine": 1,
      "sysx:sourceEndColumn": text.length + 1,
    }],
  });
  const explicit = new ExplicitTooling();
  const tooling: ModelToolingPort = {
    compile: explicit.compile.bind(explicit),
    snapshot: explicit.snapshot.bind(explicit),
    query: explicit.query.bind(explicit),
    describe: explicit.describe.bind(explicit),
    check: explicit.check.bind(explicit),
    edit: (before, operations) => {
      const operation = operations[0]!;
      assert(operation.kind === "replace-member");
      const target = operation.target;
      return Promise.resolve({
        sources: { "test.sysml": operation.text },
        targets: [{
          ...target,
          id: "p",
          types: [],
          source: {
            ...target.source,
            startByte: 0,
            endByte: before["test.sysml"].length,
          },
        }],
        splices: [{
          unit: "test.sysml",
          start: 0,
          end: before["test.sysml"].length,
          text: operation.text,
        }],
        idMap: [],
        diagnostics: [],
        provider: { name: "fixture", version: "1" },
      });
    },
  };
  const edit = (text: string, batch: number): HostEditRequest => ({
    op: "replaceMember",
    target: { qualifiedName: "P" },
    text,
    batch,
  });
  return { revision, tooling, edit };
}

Deno.test("host writer exposes its final compiled revision when the source bytes match", async () => {
  const f = compiledSnapshotFixture();
  const result = await applyEdits(f.tooling, f.revision("package P {}"), [
    f.edit("package P { }", 0),
    f.edit("package P { }", 1),
  ], {
    compile: (sources) => Promise.resolve(f.revision(sources["test.sysml"])),
    retainCompiledRevision: true,
  });
  assert.deepEqual(result.compiledRevision, f.revision("package P { }"));
  const ordinary = await applyEdits(f.tooling, f.revision("package P {}"), [
    f.edit("package P { }", 0),
    f.edit("package P { }", 1),
  ], {
    compile: (sources) => Promise.resolve(f.revision(sources["test.sysml"])),
  });
  assert.equal(Object.hasOwn(ordinary, "compiledRevision"), false);
});

Deno.test("host writer does not expose a stale compiled revision after later source edits", async () => {
  const f = compiledSnapshotFixture();
  const result = await applyEdits(f.tooling, f.revision("package P {}"), [
    f.edit("package P { }", 0),
    f.edit("package P {  }", 1),
  ], {
    compile: (sources) => Promise.resolve(f.revision(sources["test.sysml"])),
    retainCompiledRevision: true,
  });
  assert.equal(result.compiledRevision, undefined);
  assert.equal(result.sources["test.sysml"], "package P {  }");
});
// Replays byte splices onto one unit text, latest offset first so earlier
// offsets stay valid. Pure byte arithmetic: no SysML text analysis.
const replaySplices = (
  text: string,
  splices: ReadonlyArray<{ start: number; end: number; text: string }>,
): string => {
  let bytes = new TextEncoder().encode(text);
  for (const splice of [...splices].sort((a, b) => b.start - a.start)) {
    const replacement = new TextEncoder().encode(splice.text);
    const next = new Uint8Array(
      bytes.length - (splice.end - splice.start) + replacement.length,
    );
    next.set(bytes.slice(0, splice.start));
    next.set(replacement, splice.start);
    next.set(bytes.slice(splice.end), splice.start + replacement.length);
    bytes = next;
  }
  return new TextDecoder().decode(bytes);
};
const replaySourceSplices = (
  sources: Record<string, string>,
  splices: ReadonlyArray<
    { unit: string; start: number; end: number; text: string }
  >,
): Record<string, string> => {
  const result = { ...sources };
  for (const unit of new Set(splices.map((splice) => splice.unit))) {
    result[unit] = replaySplices(
      sources[unit]!,
      splices.filter((splice) => splice.unit === unit),
    );
  }
  return result;
};
Deno.test("host text decoding bounds encoded input before atob and stops a small gzip bomb", async () => {
  const originalAtob = globalThis.atob;
  let calls = 0;
  globalThis.atob = (data) => {
    calls++;
    return originalAtob(data);
  };
  try {
    await assert.rejects(
      () =>
        readHostEditText({
          encoding: "gzip-base64",
          data: "A".repeat(MAX_HOST_EDIT_DATA_CHARS + 1),
        }),
      { code: "READ_BACK_MISMATCH" },
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.atob = originalAtob;
  }
  const chunk = new Uint8Array(64 * 1024).fill(32);
  let remaining = 36 * 1024 * 1024;
  const input = new ReadableStream<BufferSource>({
    pull(controller) {
      if (!remaining) return controller.close();
      controller.enqueue(chunk);
      remaining -= chunk.length;
    },
  });
  const compressed = new Uint8Array(
    await new Response(input.pipeThrough(new CompressionStream("gzip")))
      .arrayBuffer(),
  );
  let binary = "";
  for (const byte of compressed) binary += String.fromCharCode(byte);
  const text = { encoding: "gzip-base64" as const, data: btoa(binary) };
  assert(text.data.length < MAX_HOST_EDIT_DATA_CHARS);
  // Even a complete receipt envelope remains below the publication write limit.
  const receipt = {
    changeId: "bomb",
    authorityExercise: exerciseOwnerAuthority({
      identity: { systemId: "system" },
      version: { digest: "base" },
    }, "mandate-change"),
    baseModelDigest: "base",
    baseRevision: 0,
    adoptedPin: { digest: "base" },
    decidedAt: "now",
    edits: [{
      format: 1,
      op: "replaceMember",
      target: {
        id: "p",
        qualifiedName: "P",
        metaclass: "Package",
        preimage: "base",
      },
      text,
    }],
  };
  const trailerBytes =
    new TextEncoder().encode(`ASE-Approval: ${canonical(receipt)}\n`).length;
  assert(trailerBytes < MAX_APPROVAL_RECEIPT_BYTES);
  const before = Deno.memoryUsage().rss;
  const start = performance.now();
  await assert.rejects(() => readHostEditText(text), {
    code: "READ_BACK_MISMATCH",
  });
  console.log(JSON.stringify({
    bombOutputBytes: 36 * 1024 * 1024,
    compressedBytes: compressed.length,
    trailerBytes,
    limitBytes: MAX_HOST_EDIT_TEXT_BYTES,
    elapsedMs: Math.round(performance.now() - start),
    rssDeltaBytes: Deno.memoryUsage().rss - before,
  }));
});

Deno.test("host writer caps stored source text before emitting an unreadable receipt", async () => {
  const source = "package Limit {}";
  const base = {
    version: "base",
    sources: { "limit.sysml": source },
    elements: [{
      "@id": "p",
      "@type": "Package",
      qualifiedName: "Limit",
      declaredName: "Limit",
      "sysx:sourceDocument": "limit.sysml",
      "sysx:sourceLine": 1,
      "sysx:sourceColumn": 1,
      "sysx:sourceEndLine": 1,
      "sysx:sourceEndColumn": source.length + 1,
    }],
  };
  const text = `package Limit { /*${"x".repeat(MAX_HOST_EDIT_TEXT_BYTES)}*/ }`;
  const tooling = {
    edit(
      _sources: unknown,
      ops:
        import("../../../domain/model/editing/tooling.ts").ResolvedModelEdit[],
    ) {
      assert.equal(ops.length, 1);
      const operation = ops[0];
      assert.ok(operation?.kind === "replace-member");
      const target = operation.target;
      return Promise.resolve({
        sources: { "limit.sysml": text },
        targets: [{
          id: "p",
          qualifiedName: "Limit",
          metaclass: "Package",
          types: [],
          source: { ...target.source, startByte: 0, endByte: source.length },
        }],
        splices: [{ unit: "limit.sysml", start: 0, end: source.length, text }],
        idMap: [],
        diagnostics: [],
        provider: { name: "fixture", version: "1" },
      });
    },
  } as unknown as ModelToolingPort;
  await assert.rejects(
    () =>
      applyEdits(tooling, base, [{
        op: "replaceMember",
        target: { qualifiedName: "Limit" },
        text,
      }]),
    { code: "READ_BACK_MISMATCH" },
  );
});

Deno.test("splice guard rejects equal starts independently of their array order", () => {
  const context = {
    opIndex: -1,
    op: "proposeEdit",
    target: { qualifiedName: "P" },
  };
  for (
    const splices of [[{ unit: "a", start: 1, end: 1, text: "X" }, {
      unit: "a",
      start: 1,
      end: 1,
      text: "Y",
    }], [{ unit: "a", start: 1, end: 2, text: "X" }, {
      unit: "a",
      start: 1,
      end: 1,
      text: "Y",
    }]]
  ) {
    for (const ordered of [splices, [...splices].reverse()]) {
      for (const after of ["aXYb", "aYXb"]) {
        assert.throws(() =>
          assertSourceSplices(
            { a: "ab" },
            {
              sources: { a: after },
              splices: ordered,
              targets: [],
              idMap: [],
              diagnostics: [],
              provider: { name: "fixture", version: "1" },
            },
            context,
          ), (error: unknown) => {
          assert(error instanceof HostEditError);
          assert.equal(error.code, "SPLICE_OUT_OF_SCOPE");
          assert.deepEqual(error.context, context);
          return true;
        });
      }
    }
  }
});

Deno.test("host writer rejects unbounded request batches before any provider call", async () => {
  const base = { version: "base", sources: {}, elements: [] };
  const tooling = new ExplicitTooling();
  for (
    const requests of [
      [],
      Array.from({ length: 33 }, () => request("count", 2)),
    ]
  ) {
    await assert.rejects(
      () => applyEdits(tooling, base, requests),
      coded("TOOLKIT_REFUSED"),
    );
  }
});
Deno.test({
  name:
    "Toolkit host expectations: legacy literals, typed members and exact quoted source",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const base = {
      ...await compiler.compile({
        "proof.sysml": "package Proof { part owner {} }",
      }),
      version: "base",
    };
    const request: Extract<HostEditRequest, { op: "insertMember" }> = {
      op: "insertMember",
      owner: { qualifiedName: "Proof::owner" },
      text:
        'part child { attribute note : ScalarValues::String = "alpha  beta"; attribute count : ScalarValues::Integer = 4; }',
      expect: [
        { path: "child::count", value: 4 },
        { kind: "literal", path: "child::note", value: "alpha  beta" },
        {
          kind: "member",
          qualifiedName: "Proof::owner::child",
          metaclass: "PartUsage",
        },
      ],
    };
    const originalRequest = structuredClone(request);
    const prepared = await applyEdits(tooling, base, [request]);
    const candidate = {
      ...await compiler.compile(prepared.sources),
      version: "candidate",
    };
    await verifyEdits(candidate, prepared.edits, { base });
    assert.deepEqual(request, originalRequest);
    const receipt = prepared.edits[0]!;
    assert(receipt.op === "insertMember");
    assert.deepEqual(receipt.expect.slice(0, 2), [
      { kind: "literal", path: "child::count", value: 4 },
      { kind: "literal", path: "child::note", value: "alpha  beta" },
    ]);
    const member = receipt.expect[2]!;
    assert(member.kind === "member");
    const child = modelSourceElement(candidate, member.qualifiedName);
    const sourceText = modelToolingTarget(
      candidate,
      String(child["@id"]),
    ).source.text;
    assert.equal(member.sourceDigest, await sha256(sourceText));
    assert.equal("sourceText" in member, false);
    assert(sourceText.includes('"alpha  beta"'));
    await assert.rejects(() =>
      verifyEdits(candidate, [{
        ...receipt,
        expect: [],
      }]), { code: "READ_BACK_MISMATCH" });
    await assert.rejects(() =>
      verifyEdits(candidate, [{
        ...receipt,
        introduced: [],
      }]), { code: "READ_BACK_MISMATCH" });
    const emptyProof = [{ ...member, sourceDigest: "" }];
    const emptyProofDigest = await sha256(canonical(emptyProof));
    await assert.rejects(() =>
      verifyEdits(candidate, [{
        ...receipt,
        expect: emptyProof,
        expectDigest: emptyProofDigest,
      }]), { code: "READ_BACK_MISMATCH" });
    const explicit = await applyEdits(tooling, base, [{
      ...request,
      expect: [{
        kind: "member",
        qualifiedName: member.qualifiedName,
        metaclass: member.metaclass,
        sourceText,
      }],
    }]);
    assert.deepEqual(explicit.sources, prepared.sources);
    await verifyEdits(candidate, explicit.edits, { base });
    // Whitespace inside a quoted value remains part of the exact proof.
    const alteredSource = sourceText.replace("alpha  beta", "alpha beta");
    assert.notEqual(alteredSource, sourceText);
    const alteredExpect = [{
      ...member,
      sourceDigest: await sha256(alteredSource),
    }];
    const alteredExpectDigest = await sha256(canonical(alteredExpect));
    await assert.rejects(() =>
      verifyEdits(candidate, [{
        ...receipt,
        expect: alteredExpect,
        expectDigest: alteredExpectDigest,
      }]), { code: "READ_BACK_MISMATCH" });
    await assert.rejects(() =>
      applyEdits(tooling, base, [{
        ...request,
        expect: [{
          kind: "member",
          qualifiedName: member.qualifiedName,
          metaclass: member.metaclass,
          sourceText: alteredSource,
        }],
      }]), { code: "READ_BACK_MISMATCH" });
    await assert.rejects(() =>
      verifyEdits(candidate, [{
        ...receipt,
        expect: [{ ...member, metaclass: "ItemUsage" }],
      }]), { code: "READ_BACK_MISMATCH" });
    const unknown = { ...member, kind: "unknown" };
    await assert.rejects(() =>
      applyEdits(tooling, base, [{
        ...request,
        expect: [unknown],
      } as unknown as HostEditRequest]), { code: "TOOLKIT_REFUSED" });
    await assert.rejects(() =>
      verifyEdits(candidate, [
        {
          ...receipt,
          expect: [unknown],
        } as unknown as typeof receipt,
      ]), { code: "READ_BACK_MISMATCH" });
  },
});

Deno.test({
  name:
    "Toolkit host member proof captures the final child value after a later batch",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const base = {
      ...await compiler.compile({
        "final-proof.sysml": "package FinalProof { part owner {} }",
      }),
      version: "base",
    };
    const insertion: Extract<HostEditRequest, { op: "insertMember" }> = {
      op: "insertMember",
      owner: { qualifiedName: "FinalProof::owner" },
      text: "part child { attribute count : ScalarValues::Integer = 1; }",
      expect: [{
        kind: "member",
        qualifiedName: "FinalProof::owner::child",
        metaclass: "PartUsage",
      }],
      batch: 0,
    };
    const originalInsertion = structuredClone(insertion);
    const prepared = await applyEdits(tooling, base, [insertion, {
      op: "setFeatureValue",
      target: { qualifiedName: "FinalProof::owner::child::count" },
      value: 2,
      batch: 1,
    }]);
    assert.deepEqual(insertion, originalInsertion);
    assert.equal("sourceText" in insertion.expect[0]!, false);
    const candidate = {
      ...await compiler.compile(prepared.sources),
      version: "candidate",
    };
    const receipt = prepared.edits[0]!;
    assert(receipt.op === "insertMember");
    const member = receipt.expect[0]!;
    assert(member.kind === "member");
    const child = modelSourceElement(candidate, member.qualifiedName);
    const finalSource = modelToolingTarget(
      candidate,
      String(child["@id"]),
    ).source.text;
    assert(finalSource.includes("= 2;"));
    assert.equal(member.sourceDigest, await sha256(finalSource));
    assert.equal("sourceText" in member, false);
    await verifyEdits(candidate, prepared.edits, { base });
  },
});

Deno.test({
  name:
    "Toolkit host compact proofs retain exact large values after a later batch",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const base = {
      ...await compiler.compile({
        "compact.sysml": "package Compact { part owner {} }",
      }),
      version: "base",
    };
    const initialValue = 'start "quoted" '.repeat(120);
    const finalValue = 'final "quoted" '.repeat(120);
    const text =
      `part child {\n  attribute note : ScalarValues::String =\n    ${
        spelling(initialValue)
      };\n}`;
    const insertionRequest: Extract<HostEditRequest, { op: "insertMember" }> = {
      op: "insertMember",
      owner: { qualifiedName: "Compact::owner" },
      text,
      expect: [{
        kind: "member",
        qualifiedName: "Compact::owner::child",
        metaclass: "PartUsage",
      }],
      batch: 0,
    };
    const prepared = await applyEdits(tooling, base, [insertionRequest, {
      op: "setFeatureValue",
      target: { qualifiedName: "Compact::owner::child::note" },
      value: finalValue,
      batch: 1,
    }]);
    const candidate = {
      ...await compiler.compile(prepared.sources),
      version: "candidate",
    };
    const receipt = prepared.edits[0]!;
    assert(receipt.op === "insertMember");
    assert.equal(receipt.format, 1);
    assert.equal(typeof receipt.text, "object");
    assert.equal(await readHostEditText(receipt.text), text);
    const expected = receipt.expect[0]!;
    assert(expected.kind === "member");
    const child = modelSourceElement(candidate, expected.qualifiedName);
    assert.equal(
      expected.sourceDigest,
      await sha256(
        modelToolingTarget(candidate, String(child["@id"])).source.text,
      ),
    );
    assert.equal(receipt.expectDigest, await sha256(canonical(receipt.expect)));
    const introduced = receipt.introduced!.find((entry) =>
      entry.qualifiedName.endsWith("::'note'") ||
      entry.qualifiedName.endsWith("::note")
    );
    assert(introduced);
    assert.equal(introduced.value, initialValue);
    assert.equal("valueDigest" in introduced, false);
    await verifyEdits(candidate, prepared.edits, { base });
    await verifyEdits(candidate, prepared.edits);
    // The insertion inventory records its original image. A later explicit
    // scalar edit supersedes that value during verification. Corrupt the
    // original digest in a separate insertion with no such override.
    const insertOnly = await applyEdits(tooling, base, [insertionRequest]);
    const insertCandidate = {
      ...await compiler.compile(insertOnly.sources),
      version: "insert-only",
    };
    await verifyEdits(insertCandidate, insertOnly.edits, { base });
    const corrupted = structuredClone(insertOnly.edits);
    const insertion = corrupted[0]!;
    assert(insertion.op === "insertMember");
    insertion.introduced!.find((entry) => entry.valueDigest !== undefined)!
      .valueDigest = "0".repeat(64);
    await assert.rejects(
      () => verifyEdits(insertCandidate, corrupted, { base }),
      {
        code: "READ_BACK_MISMATCH",
      },
    );
  },
});

Deno.test({
  name:
    "Toolkit host readback refuses a foreign type change with unchanged metaclass and scalars",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const base = {
      ...await compiler.compile({
        "foreign.sysml": `package Foreign {
          part def A;
          part def B;
          part sibling : A;
          attribute count : ScalarValues::Integer = 1;
          part owner {}
        }`,
      }),
      version: "base",
    };
    const prepared = await applyEdits(tooling, base, [{
      op: "insertMember",
      owner: { qualifiedName: "Foreign::owner" },
      text: "part child;",
      expect: [],
    }]);
    const candidate = {
      ...await compiler.compile(prepared.sources),
      version: "candidate",
    };
    await verifyEdits(candidate, prepared.edits, { base });
    const changed = prepared.sources["foreign.sysml"]!.replace(
      "part sibling : A;",
      "part sibling : B;",
    );
    assert.notEqual(changed, prepared.sources["foreign.sysml"]);
    const corrupted = {
      ...await compiler.compile({ "foreign.sysml": changed }),
      version: "corrupted",
    };
    assert.equal(
      modelSourceElement(candidate, "Foreign::sibling")["@type"],
      modelSourceElement(corrupted, "Foreign::sibling")["@type"],
    );
    assert.deepEqual(
      sourceLiterals(candidate.elements).map(({ name, kind, value }) => ({
        name,
        kind,
        value,
      })),
      sourceLiterals(corrupted.elements).map(({ name, kind, value }) => ({
        name,
        kind,
        value,
      })),
    );
    // The inserted member and scalar facts still match without the base.
    await verifyEdits(corrupted, prepared.edits);
    await assert.rejects(
      () => verifyEdits(corrupted, prepared.edits, { base }),
      (error: unknown) => {
        assert(error instanceof HostEditError);
        assert.equal(error.code, "READ_BACK_MISMATCH");
        assert.equal(error.context.opIndex, -1);
        assert.match(
          error.message,
          /Existing declaration changed outside the host edit targets/,
        );
        return true;
      },
    );
  },
});

Deno.test({
  name: "Toolkit host writer refuses out-of-splice imports with honest splices",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const initial = { "guard.sysml": "package Guard { part owner {} }" };
    const base = { ...await compiler.compile(initial), version: "base" };
    let honestSplices = false;
    const tampering: ModelToolingPort = {
      query: tooling.query.bind(tooling),
      describe: tooling.describe.bind(tooling),
      check: tooling.check.bind(tooling),
      snapshot: tooling.snapshot!.bind(tooling),
      compile: tooling.compile.bind(tooling),
      async edit(sources, operations) {
        const result = await tooling.edit(sources, operations);
        assert.equal(
          replaySplices(sources["guard.sysml"]!, result.splices),
          result.sources["guard.sysml"],
        );
        honestSplices = true;
        const changed = result.sources["guard.sysml"]!.replace(
          "package Guard {",
          "package Guard { private import ISQ::*;",
        );
        assert.notEqual(changed, result.sources["guard.sysml"]);
        return {
          ...result,
          sources: { ...result.sources, "guard.sysml": changed },
        };
      },
    };
    await assert.rejects(() =>
      applyEdits(tampering, base, [{
        op: "insertMember",
        owner: { qualifiedName: "Guard::owner" },
        text: "part child;",
        expect: [],
      }]), { code: "SPLICE_OUT_OF_SCOPE" });
    assert(honestSplices);
  },
});

Deno.test({
  name:
    "Toolkit host writer verifies a lone anonymous removal against its base",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const initial = {
      "anonymous.sysml": `package Anonymous {
      part def D;
      part owner { part a : D; part b : D; allocate a to b; }
      part sibling;
    }`,
    };
    const base = { ...await compiler.compile(initial), version: "base" };
    const allocation = base.elements.find((element) =>
      element["@type"] === "AllocationUsage" &&
      element["sysx:sourceDocument"] === "anonymous.sysml"
    );
    assert(allocation);
    const prepared = await applyEdits(tooling, base, [{
      op: "remove",
      target: { elementId: String(allocation["@id"]) },
    }]);
    assert.equal(prepared.edits.length, 1);
    const candidate = {
      ...await compiler.compile(prepared.sources),
      version: "candidate",
    };
    await verifyEdits(candidate, prepared.edits, { base });
    await assert.rejects(() => verifyEdits(base, prepared.edits, { base }), {
      code: "READ_BACK_MISMATCH",
    });
  },
});

Deno.test({
  name:
    "Toolkit host member expectations must identify newly inserted children",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const base = {
      ...await compiler.compile({
        "existing.sysml":
          "package Existing { part owner { part existingChild; } }",
      }),
      version: "base",
    };
    await assert.rejects(() =>
      applyEdits(tooling, base, [{
        op: "insertMember",
        owner: { qualifiedName: "Existing::owner" },
        text: "part child;",
        expect: [{
          kind: "member",
          qualifiedName: "Existing::owner::existingChild",
          metaclass: "PartUsage",
        }],
      }]), { code: "READ_BACK_MISMATCH" });
    const prepared = await applyEdits(tooling, base, [{
      op: "insertMember",
      owner: { qualifiedName: "Existing::owner" },
      text: "part child;",
      expect: [{
        kind: "member",
        qualifiedName: "Existing::owner::child",
        metaclass: "PartUsage",
      }],
    }]);
    const candidate = {
      ...await compiler.compile(prepared.sources),
      version: "candidate",
    };
    const existing = modelSourceElement(
      candidate,
      "Existing::owner::existingChild",
    );
    const expect = [{
      kind: "member" as const,
      qualifiedName: "Existing::owner::existingChild",
      metaclass: "PartUsage",
      sourceDigest: await sha256(
        modelToolingTarget(
          candidate,
          String(existing["@id"]),
        ).source.text,
      ),
    }];
    const receipt = prepared.edits[0]!;
    assert(receipt.op === "insertMember");
    const forged = {
      ...receipt,
      expect,
      expectDigest: await sha256(canonical(expect)),
    };
    await assert.rejects(() => verifyEdits(candidate, [forged], { base }), {
      code: "READ_BACK_MISMATCH",
    });
  },
});

Deno.test({
  name:
    "Toolkit host operator authority: policy receipt keeps its member and eight tagged literals",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const base = {
      ...await compiler.compile({
        "policy.sysml": `package ASEAuthority {
          private import ScalarValues::*;
          part def OperatorAuthorityPolicy {
            attribute id : String;
            attribute revision : Integer;
            attribute enabled : Boolean;
            attribute recipients : String;
            attribute acts : String;
            attribute networkHosts : String;
            attribute toolIds : String;
            attribute maxDelegationDepth : Integer;
            ref part holder;
            ref part mandate;
            ref part issuer;
          }
        }
        package ASELiveBuilder {
          part liveBuilder {
            part builder;
            part builderMandate;
            part owner { part ownerMandate { part rootAuthority; } }
          }
        }`,
      }),
      version: "base",
    };
    // The bounded policy writer emits this authority insertion shape. The
    // integration path checks the complete executable; this test exercises its
    // member and literal proofs with only the declarations needed by Host.
    const requests = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../../../../test/fixtures/peer-operator-authority-policy-request.json",
          import.meta.url,
        ),
      ),
    ) as HostEditRequest[];
    const generated = await operatorAuthorityRequests(base, {
      op: "publishOperatorAuthorityPolicy",
      systemName: "ASELiveBuilder::liveBuilder",
      changeId: "research-network-grant",
      policy: {
        policyId: "research-network",
        expectedPolicyRevision: 0,
        enabled: true,
        recipients: ["0d618ac4-64e2-5036-a3b2-a6f350a1127b"],
        acts: ["addNetworkHosts"],
        networkHosts: ["example.org"],
        toolIds: [],
        maxDelegationDepth: 0,
      },
    });
    assert.deepEqual(requests, generated.requests);
    assert.equal(requests.length, 1);
    const originalRequests = structuredClone(requests);
    const request = requests[0]!;
    assert(request.op === "insertMember");
    assert.deepEqual(request.owner, {
      qualifiedName: "ASELiveBuilder::liveBuilder",
    });
    assert.equal(request.intent, "authority");
    assert.deepEqual(request.expect[0], {
      kind: "member",
      qualifiedName:
        "ASELiveBuilder::liveBuilder::'operator-authority-research-network-1'",
      metaclass: "PartUsage",
    });
    const prepared = await applyEdits(tooling, base, requests);
    assert.deepEqual(requests, originalRequests);
    const candidate = {
      ...await compiler.compile(prepared.sources),
      version: "candidate",
    };
    await verifyEdits(candidate, prepared.edits, { base });
    const receipt = prepared.edits[0]!;
    assert(receipt.op === "insertMember");
    const literals = receipt.expect.filter((expected) =>
      expected.kind === "literal"
    );
    assert.equal(literals.length, 8);
    assert.deepEqual(
      literals,
      request.expect.filter((expected) => expected.kind === "literal"),
    );
    const members = receipt.expect.filter((expected) =>
      expected.kind === "member"
    );
    assert.equal(receipt.intent, "authority");
    assert.equal(members.length, 1);
    assert.deepEqual(members[0], {
      ...request.expect[0],
      sourceDigest: members[0]!.sourceDigest,
    });
    assert.match(members[0]!.sourceDigest!, /^[a-f0-9]{64}$/);
    assert.deepEqual(literals.map((expected) => expected.value), [
      "research-network",
      1,
      true,
      '["0d618ac4-64e2-5036-a3b2-a6f350a1127b"]',
      '["addNetworkHosts"]',
      '["example.org"]',
      "[]",
      0,
    ]);
    assert.equal(request.expect[0]!.kind, "member");
  },
});

Deno.test("memory repository refuses approved no-op publications and verify failures before advancing head", async () => {
  const repository = new MemorySourceRepository({
    compile(sources) {
      return Promise.resolve({
        sources,
        elements: [],
        documents: [],
        sourceDigest: "fixture",
        semanticDigest: "fixture",
        provenanceDigest: "fixture",
        sourceHashes: {},
        engineVersion: "fixture",
      });
    },
    recipe: () => {
      throw new Error("Fixture compiler reports no build recipe");
    },
  });
  const head = await repository.initialize({ "fixture.sysml": "before" });
  const receipt: ChangePublication = {
    changeId: "memory-refusal",
    authorityExercise: exerciseOwnerAuthority({
      identity: { systemId: "system" },
      version: { digest: "base" },
    }, "mandate-change"),
    baseModelDigest: "base",
    baseRevision: 0,
    adoptedPin: { digest: "base" },
    decidedAt: "now",
    edits: [],
  };
  for (const noOp of [true, false]) {
    let verified = false;
    await assert.rejects(() =>
      repository.updateSystemSources(
        () => noOp ? head.sources : { "fixture.sysml": "after" },
        `ase:approved-change:${receipt.changeId}`,
        {
          publication: receipt,
          verify() {
            verified = true;
            throw new Error("verify refused");
          },
        },
      ), {
      code: "PUBLICATION_NOT_APPLICABLE",
      recovery: "refuse",
      message: noOp
        ? "Approved publication must change sources"
        : "verify refused",
    });
    assert.equal(verified, !noOp);
    assert.deepEqual(await repository.current(), head);
    assert.equal(repository.versions.size, 1);
    assert.equal(await repository.findPublication(receipt.changeId), null);
  }
});
Deno.test({
  name:
    "Toolkit host writer: scalar replay, no-op receipts, preimages, extents and readback invariants",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const base = { ...await compiler.compile(sources), version: "base" };
    const requests = [
      request("json", '["台灣.example"]'),
      request("enabled", true),
      request("count", 2),
      request("label", "after"),
    ];
    const prepared = await applyEdits(tooling, base, requests);
    assert.deepEqual(
      prepared.edits.map((edit) =>
        edit.op === "setFeatureValue" ? edit.value : undefined
      ),
      requests.map((edit) => edit.value),
    );
    assert.equal(prepared.splices.length, 4);
    for (const edit of prepared.edits) {
      assert(edit.op === "setFeatureValue");
      const target = modelToolingTarget(base, edit.target.id);
      assert.equal(edit.target.preimage, await sha256(target.source.text));
      const description = await tooling.describe(sources, target);
      const splice = prepared.splices.find((splice) =>
        splice.unit === description.source.path &&
        splice.start >= description.source.startByte &&
        splice.end <= description.source.endByte
      )!;
      assert(splice);
      assert.equal(splice.unit, description.source.path);
      assert(
        splice.start >= description.source.startByte &&
          splice.end <= description.source.endByte,
      );
      assert.equal(
        new TextDecoder().decode(
          new TextEncoder().encode(sources["scalars.sysml"]).slice(
            description.source.startByte,
            description.source.endByte,
          ),
        ),
        target.source.text,
      );
    }
    const candidate = {
      ...await compiler.compile(prepared.sources),
      version: "candidate",
    };
    await verifyEdits(candidate, prepared.edits, { base });
    // Replaying the returned splices accounts for every changed byte.
    let bytes = new TextEncoder().encode(sources["scalars.sysml"]);
    for (
      const splice of prepared.splices.toSorted((a, b) => b.start - a.start)
    ) {
      const text = new TextEncoder().encode(splice.text);
      const next = new Uint8Array(
        bytes.length - (splice.end - splice.start) + text.length,
      );
      next.set(bytes.slice(0, splice.start));
      next.set(text, splice.start);
      next.set(bytes.slice(splice.end), splice.start + text.length);
      bytes = next;
    }
    assert.equal(
      new TextDecoder().decode(bytes),
      prepared.sources["scalars.sysml"],
    );
    let calls = 0;
    const counted: ModelToolingPort = {
      snapshot: tooling.snapshot.bind(tooling),
      compile: tooling.compile.bind(tooling),
      query: tooling.query.bind(tooling),
      describe: tooling.describe.bind(tooling),
      check: tooling.check.bind(tooling),
      edit(...args) {
        calls++;
        return tooling.edit(...args);
      },
    };
    const noOp = await applyEdits(counted, base, [
      request("count", 1),
      request("json", "[]"),
      request("enabled", false),
    ]);
    assert.equal(calls, 0);
    assert.equal(noOp.edits.length, 3);
    assert.deepEqual(noOp.sources, base.sources);
    assert.deepEqual(noOp.splices, []);
    await verifyEdits(base, noOp.edits, { base });
    await assert.rejects(
      () => applyEdits(tooling, base, [request("missing", 1)]),
      coded("TARGET_MISSING"),
    );
    await assert.rejects(
      () =>
        applyEdits(tooling, {
          ...base,
          elements: [...base.elements, {
            ...base.elements.find((e) => e.qualifiedName === "Scalars::count")!,
            "@id": "duplicate",
          }],
        }, [request("count", 2)]),
      coded("TARGET_AMBIGUOUS"),
    );
    await assert.rejects(
      () => applyEdits(tooling, base, [request("count", "2")]),
      coded("LITERAL_KIND_CHANGED"),
    );
    const stale = structuredClone(base);
    stale.sources["scalars.sysml"] = stale.sources["scalars.sysml"]!.replace(
      "count : Integer = 1",
      "count : Integer = 3",
    );
    await assert.rejects(
      () => applyEdits(tooling, stale, [request("count", 2)]),
      coded("TARGET_MODIFIED"),
    );
    const modified = structuredClone(prepared.edits);
    assert(modified[0]!.op === "setFeatureValue");
    modified[0]!.target.preimage = "0".repeat(64);
    await assert.rejects(
      () => verifyEdits(candidate, modified, { base }),
      coded("TARGET_MODIFIED"),
    );
    await assert.rejects(
      () => verifyEdits(base, prepared.edits),
      coded("READ_BACK_MISMATCH"),
    );
    const extra = await compiler.compile({
      ...prepared.sources,
      "scalars.sysml": prepared.sources["scalars.sysml"]!.replace(
        "attribute count",
        'attribute intruder : String = "outside";\nattribute count',
      ),
    });
    await assert.rejects(
      () =>
        verifyEdits({ ...extra, version: "extra" }, prepared.edits, { base }),
      coded("READ_BACK_MISMATCH"),
    );
    const countOnly = await applyEdits(tooling, base, [request("count", 2)]);
    for (
      const text of [
        countOnly.sources["scalars.sysml"]!.replace(
          'label : String = "before"',
          'label : String = "outside"',
        ),
        countOnly.sources["scalars.sysml"]!.replace(
          "attribute label",
          "attribute renamed",
        ),
      ]
    ) {
      const outside = {
        ...await compiler.compile({ "scalars.sysml": text }),
        version: "outside",
      };
      await assert.rejects(
        () => verifyEdits(outside, countOnly.edits, { base }),
        coded("READ_BACK_MISMATCH"),
      );
    }
    const broken = {
      ...base,
      sources: {
        ...base.sources,
        "scalars.sysml": base.sources["scalars.sysml"] + "\ninvalid syntax !",
      },
    };
    await assert.rejects(
      () => applyEdits(tooling, broken, [request("count", 2)]),
      coded("COMPILE_ERROR"),
    );
    // Only the returned extent is simulated; the edit itself remains real.
    const escaped: ModelToolingPort = {
      ...counted,
      async edit(...args) {
        const result = await tooling.edit(...args);
        return {
          ...result,
          targets: result.targets.map((target) => ({
            ...target,
            source: { ...target.source, endByte: target.source.startByte },
          })),
        };
      },
    };
    await assert.rejects(
      () => applyEdits(escaped, base, [request("count", 2)]),
      coded("SPLICE_OUT_OF_SCOPE"),
    );
    for (
      const error of [
        new SysmlToolkitWorkerError(
          "unavailable",
          [],
          "TOOLKIT_WORKER_UNAVAILABLE",
        ),
        new SysmlToolkitTimeoutError(1000, true),
      ]
    ) {
      const unavailable = new SysmlToolkitAdapter({
        packageDir,
        loadRuntime: () => Promise.reject(error),
      });
      await assert.rejects(
        () => applyEdits(unavailable, base, [request("count", 2)]),
        (actual) => actual === error,
      );
      assert.equal(
        publicationFailure(error, { changeId: "test" }, "refuse").recovery,
        "retry",
      );
    }
    const repository = new MemorySourceRepository(compiler);
    const initial = await repository.initialize(sources);
    await assert.rejects(
      () =>
        repository.updateSystemSources(() => prepared.sources, "test", {
          verify() {
            throw new Error("verify refused");
          },
        }),
      /verify refused/,
    );
    assert.equal((await repository.current()).version, initial.version);
    assert.equal(repository.versions.size, 1);
    // Value corruption in the native readback also refuses publication.
    const divergent = structuredClone(candidate);
    const literal = sourceLiterals(divergent.elements).find((l) =>
      l.name === "count"
    )!;
    divergent.elements.find((e) => e["@id"] === literal.literalId)!.value = 99;
    await assert.rejects(
      () => verifyEdits(divergent, prepared.edits),
      coded("READ_BACK_MISMATCH"),
    );
  },
});

Deno.test({
  name:
    "Toolkit host structural operations: grouped members, dependent batches, quoted separators, replacement, type and anonymous removal",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const initial = {
      "structure.sysml": `package P {
    private import ScalarValues::*;
    // 台灣 🧭: offsets are UTF-8 bytes.
    attribute 'a::b' : Integer = 1;
    part a { attribute b : Integer = 2; }
    action def A { action review; }
    action def B { action review; action admit; }
    part x {
        attribute label : String = "before";
        part reviewer;
        perform action promotion : A;
        allocate promotion.review to reviewer;
    }
}`,
    };
    const base = { ...await compiler.compile(initial), version: "base" };
    // The provider's display spelling loses the boundary; the receipt must not.
    const quoted = base.elements.find((e) => e.declaredName === "a::b")!;
    const preparedName = await applyEdits(tooling, base, [{
      op: "setFeatureValue",
      target: { elementId: String(quoted["@id"]) },
      value: 3,
    }]);
    const changedName = {
      ...await compiler.compile(preparedName.sources),
      version: "name",
    };
    await verifyEdits(changedName, preparedName.edits, { base });
    const nested = changedName.elements.find((e) =>
      e.qualifiedName === "P::a::b" && e.declaredName === "b"
    )!;
    assert.equal(
      sourceLiterals(changedName.elements).find((l) =>
        l.attributeId === nested["@id"]
      )!.value,
      "2",
    );
    let structuralCalls = 0;
    const counting: ModelToolingPort = {
      snapshot: tooling.snapshot.bind(tooling),
      compile: tooling.compile.bind(tooling),
      query: tooling.query.bind(tooling),
      describe: tooling.describe.bind(tooling),
      check: tooling.check.bind(tooling),
      edit(...args) {
        structuralCalls++;
        return tooling.edit(...args);
      },
    };
    const inserted = await applyEdits(counting, base, [
      {
        op: "insertMember",
        owner: { qualifiedName: "P::x" },
        text: "part child { attribute count : ScalarValues::Integer = 4; }",
        expect: [{ path: "child::count", value: 4 }],
      },
      {
        op: "insertMember",
        owner: { qualifiedName: "P::x" },
        text: "part sibling;",
        expect: [],
      },
      {
        op: "setFeatureValue",
        target: { qualifiedName: "P::x::label" },
        value: "after",
      },
      {
        op: "insertMember",
        owner: { qualifiedName: "P::x::child" },
        text: "part grandchild;",
        expect: [],
      },
    ]);
    assert.equal(inserted.splices.length, 3);
    // C1/C10: the grandchild insert targets a member that only exists after
    // the first Toolkit call, so implicit batch 0 runs as two provider calls
    // on two different inputs. Each call gets its own batches entry keyed by
    // the unique sequential `call` number (both serve batch 0) with a single
    // byte frame, so replaying the entries in order recovers the sources.
    assert.equal(structuralCalls, 2);
    assert.equal(inserted.batches.length, structuralCalls);
    assert.deepEqual(
      inserted.batches.map((batch) => batch.call),
      [0, 1],
    );
    assert.deepEqual(
      inserted.batches.map((batch) => batch.batch),
      [0, 0],
    );
    assert.equal(
      inserted.batches.flatMap((batch) => batch.splices).length,
      inserted.splices.length,
    );
    const replayed = new Map<string, string>(Object.entries(initial));
    for (const entry of inserted.batches) {
      const units = new Map<string, typeof entry.splices>();
      for (const splice of entry.splices) {
        units.set(splice.unit, [...units.get(splice.unit) ?? [], splice]);
      }
      for (const [unit, unitSplices] of units) {
        replayed.set(unit, replaySplices(replayed.get(unit)!, unitSplices));
      }
    }
    assert.deepEqual(Object.fromEntries(replayed), inserted.sources);
    const candidate = {
      ...await compiler.compile(inserted.sources),
      version: "inserted",
    };
    await verifyEdits(candidate, inserted.edits, { base });
    const wrong = structuredClone(candidate);
    const count = sourceLiterals(wrong.elements).find((l) =>
      l.name === "count"
    )!;
    wrong.elements.find((e) => e["@id"] === count.literalId)!.value = "4";
    await assert.rejects(() => verifyEdits(wrong, inserted.edits), {
      code: "READ_BACK_MISMATCH",
    });
    const injected = {
      ...await compiler.compile({
        "structure.sysml": inserted.sources["structure.sysml"]!.replace(
          "part sibling;",
          "part sibling; attribute intruder : ScalarValues::Integer = 9;",
        ),
      }),
      version: "injected",
    };
    await assert.rejects(
      () => verifyEdits(injected, inserted.edits, { base }),
      { code: "READ_BACK_MISMATCH" },
    );
    const allocation = base.elements.find((e) =>
      e["@type"] === "AllocationUsage" &&
      e["sysx:sourceDocument"] === "structure.sysml"
    )!;
    assert(allocation);
    const structural = await applyEdits(tooling, base, [
      { op: "remove", target: { elementId: String(allocation["@id"]) } },
      {
        op: "setFeatureType",
        target: { qualifiedName: "P::x::promotion" },
        type: "P::B",
      },
      {
        op: "replaceMember",
        target: { qualifiedName: "P::x::reviewer" },
        text:
          'part reviewer { attribute token : ScalarValues::String = "present"; }',
      },
    ]);
    const replaced = {
      ...await compiler.compile(structural.sources),
      version: "structural",
    };
    await verifyEdits(replaced, structural.edits, { base });
    for (
      const edits of [[structural.edits[0]!], [structural.edits[1]!], [
        structural.edits[2]!,
      ]]
    ) {
      await assert.rejects(() => verifyEdits(base, edits), {
        code: "READ_BACK_MISMATCH",
      });
    }
    // Existing siblings remain protected even inside an insertion owner.
    const outside = {
      ...await compiler.compile({
        "structure.sysml": inserted.sources["structure.sysml"]!.replace(
          'label : String = "after"',
          'label : String = "outside"',
        ),
      }),
      version: "outside",
    };
    await assert.rejects(() => verifyEdits(outside, inserted.edits, { base }), {
      code: "READ_BACK_MISMATCH",
    });
  },
});

Deno.test("receipt targets compare canonical segments even when raw display names collide", async () => {
  const first = "attribute 'a::b' = 1;", second = "attribute b = 2;";
  const base = {
    version: "base",
    sources: {
      "names.sysml":
        `package P {\n  ${first}\n  part a {\n    ${second}\n  }\n}`,
    },
    elements: [
      {
        "@id": "p",
        "@type": "Package",
        declaredName: "P",
        qualifiedName: "P",
        "sysx:sourceDocument": "names.sysml",
      },
      {
        "@id": "flat",
        "@type": "AttributeUsage",
        declaredName: "a::b",
        qualifiedName: "P::a::b",
        owner: { "@id": "p" },
        "sysx:sourceLine": 2,
        "sysx:sourceColumn": 3,
        "sysx:sourceEndLine": 2,
        "sysx:sourceEndColumn": 3 + first.length,
      },
      {
        "@id": "a",
        "@type": "PartUsage",
        declaredName: "a",
        qualifiedName: "P::a",
        owner: { "@id": "p" },
      },
      {
        "@id": "nested",
        "@type": "AttributeUsage",
        declaredName: "b",
        qualifiedName: "P::a::b",
        owner: { "@id": "a" },
        "sysx:sourceLine": 4,
        "sysx:sourceColumn": 5,
        "sysx:sourceEndLine": 4,
        "sysx:sourceEndColumn": 5 + second.length,
      },
      {
        "@id": "f1",
        "@type": "FeatureValue",
        featureWithValue: { "@id": "flat" },
        value: { "@id": "l1" },
      },
      { "@id": "l1", "@type": "LiteralInteger", value: 1 },
      {
        "@id": "f2",
        "@type": "FeatureValue",
        featureWithValue: { "@id": "nested" },
        value: { "@id": "l2" },
      },
      { "@id": "l2", "@type": "LiteralInteger", value: 2 },
    ],
  };
  const receipt = [{
    op: "setFeatureValue" as const,
    target: {
      id: "flat",
      qualifiedName: "'P'::'a::b'",
      metaclass: "AttributeUsage",
      preimage: await sha256(first),
    },
    value: 1,
  }];
  await verifyEdits(base, receipt, { base });
  await assert.rejects(
    () => verifyEdits(base, [{ ...receipt[0]!, value: 2 }]),
    { code: "READ_BACK_MISMATCH" },
  );
});

Deno.test({
  name:
    "Toolkit host writer: off-target siblings, splice scope, expect, introduced splices, anonymous re-read and batch scheduling",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const initial = {
      "structure.sysml": `package P {
    private import ScalarValues::*;
    action def A { action review; action admit; action test; }
    action def B { action review; action admit; action test; }
    part x {
        attribute label : String = "before";
        part unused;
        part reviewer;
        part builder;
        perform action promotion : A;
        perform action typed : A;
        allocate promotion.review to reviewer;
        allocate promotion.test to builder;
    }
}`,
    };
    const base = { ...await compiler.compile(initial), version: "base" };
    const wrap = (
      edit: ModelToolingPort["edit"],
    ): ModelToolingPort => ({
      snapshot: tooling.snapshot.bind(tooling),
      compile: tooling.compile.bind(tooling),
      query: tooling.query.bind(tooling),
      describe: tooling.describe.bind(tooling),
      check: tooling.check.bind(tooling),
      edit,
    });
    const compile = async (
      sources: Record<string, string>,
      version: string,
    ) => ({
      ...await compiler.compile(sources),
      version,
    });
    const offTarget = (
      error: unknown,
    ) => {
      assert(error instanceof HostEditError);
      assert.equal(error.code, "READ_BACK_MISMATCH");
      assert.equal(error.context.opIndex, -1);
      assert.match(error.message, /outside the host edit targets/);
      return true;
    };
    const spliceRefusal = (error: unknown) => {
      assert(error instanceof HostEditError);
      assert.equal(error.code, "SPLICE_OUT_OF_SCOPE");
      return true;
    };
    // C3: an existing sibling literal under the owner/target is changed in the
    // candidate. Per-op read-back still passes; only the off-target check
    // (opIndex -1) can refuse, for each structural kind.
    const insertOnly = await applyEdits(tooling, base, [{
      op: "insertMember",
      owner: { qualifiedName: "P::x" },
      text: "part added;",
      expect: [],
    }]);
    const replaceOnly = await applyEdits(tooling, base, [{
      op: "replaceMember",
      target: { qualifiedName: "P::x::reviewer" },
      text:
        'part reviewer { attribute token : ScalarValues::String = "present"; }',
    }]);
    const removeOnly = await applyEdits(tooling, base, [{
      op: "remove",
      target: { qualifiedName: "P::x::unused" },
    }]);
    const typeOnly = await applyEdits(tooling, base, [{
      op: "setFeatureType",
      target: { qualifiedName: "P::x::typed" },
      type: "P::B",
    }]);
    for (
      const [name, prepared] of [
        ["insertMember", insertOnly],
        ["replaceMember", replaceOnly],
        ["remove", removeOnly],
        ["setFeatureType", typeOnly],
      ] as const
    ) {
      const candidate = await compile({
        "structure.sysml": prepared.sources["structure.sysml"]!.replace(
          'label : String = "before"',
          'label : String = "outside"',
        ),
      }, `c3-${name}`);
      await verifyEdits(candidate, prepared.edits);
      await assert.rejects(
        () => verifyEdits(candidate, prepared.edits, { base }),
        offTarget,
      );
    }
    // C5: a shrunk extent refuses every structural kind.
    const escaped = wrap(async (...args) => {
      const result = await tooling.edit(...args);
      return {
        ...result,
        targets: result.targets.map((target) => ({
          ...target,
          source: { ...target.source, endByte: target.source.startByte },
        })),
      };
    });
    await assert.rejects(
      () =>
        applyEdits(escaped, base, [{
          op: "insertMember",
          owner: { qualifiedName: "P::x" },
          text: "part escapedAdd;",
          expect: [],
        }]),
      spliceRefusal,
    );
    await assert.rejects(
      () =>
        applyEdits(escaped, base, [{
          op: "replaceMember",
          target: { qualifiedName: "P::x::reviewer" },
          text: "part reviewer;",
        }]),
      spliceRefusal,
    );
    await assert.rejects(
      () =>
        applyEdits(escaped, base, [{
          op: "setFeatureType",
          target: { qualifiedName: "P::x::typed" },
          type: "P::B",
        }]),
      spliceRefusal,
    );
    // C5: remove overflowing onto a code neighbour is refused, while an
    // overflow covering only whitespace is accepted.
    const overflowing = wrap(async (sources, operations) => {
      const result = await tooling.edit(sources, operations);
      const splices = result.splices.map((splice, index) => {
        if (index !== 0) return splice;
        const bytes = new TextEncoder().encode(sources[splice.unit]!);
        let end = splice.end;
        while (
          end < bytes.length &&
          " \t\r\n".includes(String.fromCharCode(bytes[end]!))
        ) end++;
        return { ...splice, end: end + 4 };
      });
      return {
        ...result,
        splices,
        sources: replaySourceSplices(sources, splices),
      };
    });
    await assert.rejects(
      () =>
        applyEdits(overflowing, base, [{
          op: "remove",
          target: { qualifiedName: "P::x::unused" },
        }]),
      spliceRefusal,
    );
    const whitespaceOnly = wrap(async (sources, operations) => {
      const result = await tooling.edit(sources, operations);
      const splices = result.splices.map((splice, index) => {
        if (index !== 0) return splice;
        const bytes = new TextEncoder().encode(sources[splice.unit]!);
        return " \t\r\n".includes(String.fromCharCode(bytes[splice.end]!))
          ? { ...splice, end: splice.end + 1 }
          : { ...splice, start: splice.start - 1 };
      });
      const next = { ...result.sources };
      for (const unit of new Set(splices.map((splice) => splice.unit))) {
        next[unit] = replaySplices(
          sources[unit]!,
          splices.filter((splice) => splice.unit === unit),
        );
      }
      return { ...result, splices, sources: next };
    });
    const removedWhitespace = await applyEdits(whitespaceOnly, base, [{
      op: "remove",
      target: { qualifiedName: "P::x::unused" },
    }]);
    assert(
      !removedWhitespace.sources["structure.sysml"]!.includes("part unused"),
    );
    // C6: a false expect is refused by the expect loop itself, while the
    // introduced manifest and the candidate agree.
    const withExpect = await applyEdits(tooling, base, [{
      op: "insertMember",
      owner: { qualifiedName: "P::x" },
      text: "part child { attribute count : ScalarValues::Integer = 4; }",
      expect: [{ path: "child::count", value: 4 }],
    }]);
    const expectCandidate = await compile(withExpect.sources, "expect");
    await verifyEdits(expectCandidate, withExpect.edits, { base });
    const falseExpect = structuredClone(withExpect.edits);
    assert(falseExpect[0]!.op === "insertMember");
    falseExpect[0].expect = [{
      kind: "literal",
      path: "child::count",
      value: 999,
    }];
    falseExpect[0].expectDigest = await sha256(
      canonical(falseExpect[0].expect),
    );
    await assert.rejects(
      () => verifyEdits(expectCandidate, falseExpect, { base }),
      (error: unknown) => {
        assert(error instanceof HostEditError);
        assert.equal(error.code, "READ_BACK_MISMATCH");
        assert.match(error.message, /Inserted literal differs: child::count/);
        return true;
      },
    );
    // S11 + S3: anonymous inserted text is re-read, and a later value rewrite
    // of an introduced member excuses only that member.
    const withAnonymous = await applyEdits(tooling, base, [
      {
        op: "insertMember",
        owner: { qualifiedName: "P::x" },
        text:
          "part child { attribute count : ScalarValues::Integer = 4; }\nallocate promotion.admit to reviewer;",
        expect: [],
      },
      {
        op: "setFeatureValue",
        target: { qualifiedName: "P::x::child::count" },
        value: 5,
      },
    ]);
    const anonymousCandidate = await compile(
      withAnonymous.sources,
      "anonymous",
    );
    await verifyEdits(anonymousCandidate, withAnonymous.edits, { base });
    for (
      const tampered of [
        withAnonymous.sources["structure.sysml"]!.replace(
          "allocate promotion.admit to reviewer;",
          "allocate promotion.admit to builder;",
        ),
        withAnonymous.sources["structure.sysml"]!.replace(
          "allocate promotion.admit to reviewer;\n",
          "",
        ),
      ]
    ) {
      const candidate = await compile(
        { "structure.sysml": tampered },
        "anonymous-tampered",
      );
      await assert.rejects(
        () => verifyEdits(candidate, withAnonymous.edits, { base }),
        (error: unknown) => {
          assert(error instanceof HostEditError);
          assert.equal(error.code, "READ_BACK_MISMATCH");
          assert.match(
            error.message,
            /Host member declaration differs after compilation/,
          );
          return true;
        },
      );
    }
    // S2: a named element added outside the reported insertion splice is
    // refused before the inconsistent provider result can become a receipt.
    const intruding = wrap(async (sources, operations) => {
      const result = await tooling.edit(sources, operations);
      const splice = result.splices[0]!;
      const bytes = new TextEncoder().encode(result.sources[splice.unit]!);
      const at = splice.start + new TextEncoder().encode(splice.text).length;
      const text = new TextEncoder().encode("\npart intruder;\n");
      const next = new Uint8Array(bytes.length + text.length);
      next.set(bytes.subarray(0, at));
      next.set(text, at);
      next.set(bytes.subarray(at), at + text.length);
      return {
        ...result,
        sources: {
          ...result.sources,
          [splice.unit]: new TextDecoder().decode(next),
        },
      };
    });
    await assert.rejects(() =>
      applyEdits(intruding, base, [{
        op: "insertMember",
        owner: { qualifiedName: "P::x" },
        text: "part legit;",
        expect: [],
      }]), spliceRefusal);
    // S1: an anonymous id captured in base must still bind to the same
    // preimage and owner in a later batch; shifting siblings refuse reload.
    const testAllocation = base.elements.find((element) =>
      element["@type"] === "AllocationUsage" &&
      String(element["sysx:sourceText"] ?? "").includes("promotion.test")
    )!;
    const anonymousId = String(testAllocation["@id"]);
    const laterAnonymous = await applyEdits(tooling, base, [
      {
        op: "setFeatureValue",
        target: { qualifiedName: "P::x::label" },
        value: "after",
        batch: 0,
      },
      { op: "remove", target: { elementId: anonymousId }, batch: 1 },
    ]);
    assert(
      !laterAnonymous.sources["structure.sysml"]!.includes(
        "allocate promotion.test",
      ),
    );
    await assert.rejects(
      () =>
        applyEdits(tooling, base, [
          {
            op: "remove",
            target: { qualifiedName: "P::x::unused" },
            batch: 0,
          },
          { op: "remove", target: { elementId: anonymousId }, batch: 1 },
        ]),
      (error: unknown) => {
        assert(error instanceof HostEditError);
        assert.equal(error.code, "TARGET_MODIFIED");
        assert.deepEqual(error.recovery, { action: "reload" });
        return true;
      },
    );
    // S4: an all-no-op batch proceeds to the next batch; batch keys unique.
    const afterNoOps = await applyEdits(tooling, base, [
      {
        op: "setFeatureValue",
        target: { qualifiedName: "P::x::label" },
        value: "before",
        batch: 0,
      },
      {
        op: "insertMember",
        owner: { qualifiedName: "P::x" },
        text: "part addedLater;",
        expect: [],
        batch: 1,
      },
    ]);
    assert(
      afterNoOps.sources["structure.sysml"]!.includes("part addedLater;"),
    );
    assert.deepEqual(
      afterNoOps.batches.map((batch) => batch.batch),
      [1],
    );
    assert.equal(
      new Set(afterNoOps.batches.map((batch) => batch.batch)).size,
      afterNoOps.batches.length,
    );
  },
});

Deno.test({
  name:
    "Toolkit host writer: later-batch anonymous id rebound onto another element refuses reload",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const initial = {
      "structure.sysml": `package P {
    private import ScalarValues::*;
    action def A { action review; action admit; action test; }
    action def B { action review; action admit; action test; }
    part x {
        attribute label : String = "before";
        part unused;
        part reviewer;
        part builder;
        perform action promotion : A;
        perform action typed : A;
        allocate promotion.review to reviewer;
        allocate promotion.test to builder;
    }
}`,
    };
    const base = { ...await compiler.compile(initial), version: "base" };
    // C2/C9: target the review allocation, whose id survives the removal of
    // `unused` but is rebound onto the test allocation (positional anonymous
    // ids). This reaches the sha256 preimage / ownerId re-check, unlike an id
    // that vanishes and only reaches the missing-id branch.
    const reviewAllocation = base.elements.find((element) =>
      element["@type"] === "AllocationUsage" &&
      String(element["sysx:sourceText"] ?? "").includes("promotion.review")
    )!;
    const reviewId = String(reviewAllocation["@id"]);
    const shifted = await applyEdits(tooling, base, [{
      op: "remove",
      target: { qualifiedName: "P::x::unused" },
    }]);
    const rebound = await compiler.compile(shifted.sources);
    const reboundElement = rebound.elements.find((element) =>
      element["@id"] === reviewId
    )!;
    assert(
      reboundElement,
      "the review id must still resolve after the shift, onto another element",
    );
    assert.match(
      String(reboundElement["sysx:sourceText"] ?? ""),
      /promotion\.test/,
    );
    await assert.rejects(
      () =>
        applyEdits(tooling, base, [
          {
            op: "remove",
            target: { qualifiedName: "P::x::unused" },
            batch: 0,
          },
          { op: "remove", target: { elementId: reviewId }, batch: 1 },
        ]),
      (error: unknown) => {
        assert(error instanceof HostEditError);
        assert.equal(error.code, "TARGET_MODIFIED");
        assert.deepEqual(error.recovery, { action: "reload" });
        assert.equal(error.context.opIndex, 1);
        assert.equal(error.context.op, "remove");
        assert.deepEqual(error.context.target, { elementId: reviewId });
        assert.equal(
          error.message,
          "Anonymous host target differs from its base preimage or owner",
        );
        return true;
      },
    );
  },
});

Deno.test({
  name:
    "Toolkit host writer: introduced-literal divergence refuses before the frozen expect loop",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const initial = {
      "structure.sysml": `package P {
    private import ScalarValues::*;
    part x {
        attribute label : String = "before";
    }
}`,
    };
    const base = { ...await compiler.compile(initial), version: "base" };
    const prepared = await applyEdits(tooling, base, [{
      op: "insertMember",
      owner: { qualifiedName: "P::x" },
      text: "part child { attribute count : ScalarValues::Integer = 4; }",
      expect: [{ path: "child::count", value: 4 }],
    }]);
    const candidate = {
      ...await compiler.compile(prepared.sources),
      version: "candidate",
    };
    await verifyEdits(candidate, prepared.edits, { base });
    // S7: diverge the compiled graph under an unchanged text, as a tampered
    // reviewer configuredName does. The refusal comes from the introduced
    // manifest loop ("Inserted member literal differs", no path, attached to
    // the insertion edit), which runs before the frozen expect loop
    // ("Inserted literal differs: <path>").
    const divergent = structuredClone(candidate);
    const literal = sourceLiterals(divergent.elements).find((entry) =>
      entry.name === "count"
    )!;
    divergent.elements.find((element) => element["@id"] === literal.literalId)!
      .value = 999;
    await assert.rejects(
      () => verifyEdits(divergent, prepared.edits, { base }),
      (error: unknown) => {
        assert(error instanceof HostEditError);
        assert.equal(error.code, "READ_BACK_MISMATCH");
        assert.equal(error.context.opIndex, 0);
        assert.equal(error.message, "Inserted member literal differs");
        return true;
      },
    );
  },
});

Deno.test({
  name:
    "Toolkit host writer: remove splice overflow on the leading side is refused, whitespace-only shifts pass",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const initial = {
      "structure.sysml": `package P {
    private import ScalarValues::*;
    part x {
        attribute label : String = "before";
        part unused;
        part reviewer;
    }
}`,
    };
    const base = { ...await compiler.compile(initial), version: "base" };
    const wrap = (
      edit: ModelToolingPort["edit"],
    ): ModelToolingPort => ({
      snapshot: tooling.snapshot.bind(tooling),
      compile: tooling.compile.bind(tooling),
      query: tooling.query.bind(tooling),
      describe: tooling.describe.bind(tooling),
      check: tooling.check.bind(tooling),
      edit,
    });
    const isWhitespace = (byte: number) =>
      " \t\r\n".includes(String.fromCharCode(byte));
    // C11: the remove exception checks the leading slice (splice.start to the
    // target start) independently of the trailing slice. A splice starting
    // inside code before the target is refused.
    const leadingOverflow = wrap(async (sources, operations) => {
      const result = await tooling.edit(sources, operations);
      const splices = result.splices.map((splice, index) => {
        if (index !== 0) return splice;
        const target = result.targets[0]!;
        const bytes = new TextEncoder().encode(sources[splice.unit]!);
        let start = target.source.startByte;
        while (start > 0 && isWhitespace(bytes[start - 1]!)) start--;
        start = Math.max(0, start - 1);
        assert(
          start < splice.start,
          "the fixture must leave code before the remove splice",
        );
        return { ...splice, start };
      });
      return {
        ...result,
        splices,
        sources: replaySourceSplices(sources, splices),
      };
    });
    await assert.rejects(
      () =>
        applyEdits(leadingOverflow, base, [{
          op: "remove",
          target: { qualifiedName: "P::x::unused" },
        }]),
      (error: unknown) => {
        assert(error instanceof HostEditError);
        assert.equal(error.code, "SPLICE_OUT_OF_SCOPE");
        return true;
      },
    );
    // C11: a leading shift covering only whitespace stays accepted.
    const leadingWhitespace = wrap(async (sources, operations) => {
      const result = await tooling.edit(sources, operations);
      const splices = result.splices.map((splice, index) => {
        if (index !== 0) return splice;
        const bytes = new TextEncoder().encode(sources[splice.unit]!);
        assert(
          isWhitespace(bytes[splice.start - 1]!),
          "the fixture must leave whitespace before the remove splice",
        );
        return { ...splice, start: splice.start - 1 };
      });
      return {
        ...result,
        splices,
        sources: replaySourceSplices(sources, splices),
      };
    });
    const removed = await applyEdits(leadingWhitespace, base, [{
      op: "remove",
      target: { qualifiedName: "P::x::unused" },
    }]);
    assert(!removed.sources["structure.sysml"]!.includes("part unused"));
  },
});
