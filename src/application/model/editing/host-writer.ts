import { elementByteRange } from "../../../domain/model/editing/source-byte-range.ts";
import { normalizeMember } from "../../../domain/model/editing/source-text.ts";
import { sha256Bytes as sha256 } from "../../../domain/primitives/sha256-bytes.ts";
import type { ModelToolingEditResult, ModelToolingPort } from "../tooling.ts";
import {
  type EditTarget,
  type HostEdit,
  HostEditError,
  type HostEditRequest,
  hostEditTarget,
  type HostTarget,
  spelling,
  type StoredSourceText,
} from "../../../domain/model/editing/host-edit.ts";
import type { ResolvedModelEdit } from "../../../domain/model/editing/tooling.ts";
type ResolvedHostEdit = Exclude<
  ResolvedModelEdit,
  { kind: "retarget-reference" }
>;
import {
  parseSysmlQualifiedName,
  sameSysmlQualifiedName,
  spellSysmlQualifiedName,
} from "../../../domain/model/value-objects/sysml-qualified-name.ts";

import {
  createModelSourceIndex as buildIndex,
  modelSourceElement,
  type ModelSourceIndex as RevisionIndex,
  modelTargetId,
  modelToolingTarget,
  ownerId as ownerOf,
  qualifiedSegments,
} from "../../../domain/model/editing/source-index.ts";
import { sourceLiterals } from "../../../domain/model/projections/source-facts.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { MAX_APPROVAL_RECEIPT_BYTES } from "../../../domain/model/publication/change.ts";
import type { SourceRevision } from "../../../domain/model/records/source-revision.ts";
import type { ModelSources as Sources } from "../../../domain/model/value-objects/sources.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";
import type { ElementIncarnationRef } from "../../../domain/model/editing/operation-journal.ts";
import type { IncarnationInventory } from "../../../domain/model/editing/journal-replay.ts";
import type { HostEditExecutorPort } from "../publication/ports/out/host-edit-executor.port.ts";

function failure(
  code: HostEditError["code"],
  opIndex: number,
  edit: HostEditRequest | HostEdit,
  message: string,
): never {
  throw new HostEditError(
    code,
    { opIndex, op: edit.op, target: hostEditTarget(edit) },
    message,
  );
}
type Element = SourceRevision["elements"][number];
type WorkingEdit =
  | Exclude<HostEdit, { op: "insertMember" | "replaceMember" }>
  | (Omit<Extract<HostEdit, { op: "insertMember" }>, "text"> & { text: string })
  | (Omit<Extract<HostEdit, { op: "replaceMember" }>, "text"> & {
    text: string;
  });
function resolveTarget(
  source: SourceRevision | RevisionIndex,
  target: HostTarget | EditTarget,
  edit: HostEditRequest | HostEdit,
  opIndex: number,
) {
  try {
    return modelSourceElement(source, target);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "TARGET_MISSING") {
        failure("TARGET_MISSING", opIndex, edit, "Host edit target is missing");
      }
      if (error.code === "TARGET_AMBIGUOUS") {
        failure(
          "TARGET_AMBIGUOUS",
          opIndex,
          edit,
          "Host edit target is ambiguous",
        );
      }
      if (error.code === "READ_BACK_MISMATCH") {
        failure(
          "READ_BACK_MISMATCH",
          opIndex,
          edit,
          "Host edit target metaclass differs",
        );
      }
    }
    providerFailure(error, edit, opIndex);
  }
}
function resolve(
  source: SourceRevision | RevisionIndex,
  edit: HostEditRequest | HostEdit,
  opIndex: number,
) {
  return resolveTarget(source, hostEditTarget(edit), edit, opIndex);
}

function value(
  revision: SourceRevision,
  element: Record<string, unknown>,
  edit: HostEditRequest | HostEdit,
  opIndex: number,
) {
  const literals = sourceLiterals(revision.elements).filter((literal) =>
    literal.attributeId === element["@id"]
  );
  if (literals.length !== 1) {
    failure(
      "LITERAL_KIND_CHANGED",
      opIndex,
      edit,
      "Host edit requires one explicit scalar literal",
    );
  }
  return revision.elements.find((element) =>
    element["@id"] === literals[0]!.literalId
  )?.value;
}
function providerFailure(
  error: unknown,
  edit: HostEditRequest | HostEdit,
  opIndex: number,
): never {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
  if (
    code === "TOOLKIT_WORKER_UNAVAILABLE" ||
    error instanceof Error && error.name === "SysmlToolkitTimeoutError"
  ) throw error;
  if (error instanceof HostEditError) throw error;
  const mapped = [
      "TARGET_MISSING",
      "TARGET_AMBIGUOUS",
      "TARGET_MODIFIED",
      "COMPILE_ERROR",
      "READ_BACK_MISMATCH",
    ]
      .includes(code ?? "")
    ? code as HostEditError["code"]
    : "TOOLKIT_REFUSED";
  failure(
    mapped,
    opIndex,
    edit,
    error instanceof Error ? error.message : String(error),
  );
}

/** Read exact source, including whitespace and quoted bytes, from a current receipt. */
export const MAX_HOST_EDIT_TEXT_BYTES = 16 * MAX_APPROVAL_RECEIPT_BYTES;
export const MAX_HOST_EDIT_DATA_CHARS = MAX_APPROVAL_RECEIPT_BYTES;

function textLimitFailure(): never {
  throw new HostEditError("READ_BACK_MISMATCH", {
    opIndex: -1,
    op: "insertMember",
    target: { qualifiedName: "" },
  }, "Stored host source text exceeds its size limit");
}
function assertTextLimit(text: string): void {
  if (
    text.length > MAX_HOST_EDIT_TEXT_BYTES ||
    new TextEncoder().encode(text).length > MAX_HOST_EDIT_TEXT_BYTES
  ) textLimitFailure();
}
export async function readHostEditText(
  text: StoredSourceText,
): Promise<string> {
  if (typeof text === "string") {
    assertTextLimit(text);
    return text;
  }
  if (
    !text || text.encoding !== "gzip-base64" || typeof text.data !== "string" ||
    !text.data
  ) throw new Error("Invalid stored source text");
  if (text.data.length > MAX_HOST_EDIT_DATA_CHARS) textLimitFailure();
  const bytes = Uint8Array.from(atob(text.data), (c) => c.charCodeAt(0));
  // Small compressed input chunks also bound output queued by the native
  // transform before backpressure reaches this consumer.
  let inputOffset = 0;
  const input = new ReadableStream<BufferSource>({
    pull(controller) {
      if (inputOffset === bytes.length) return controller.close();
      const end = Math.min(inputOffset + 256, bytes.length);
      controller.enqueue(bytes.subarray(inputOffset, end));
      inputOffset = end;
    },
  });
  const reader = input.pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > MAX_HOST_EDIT_TEXT_BYTES) {
        try {
          await reader.cancel();
        } catch { /* Preserve the size refusal. */ }
        textLimitFailure();
      }
      chunks.push(value);
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}
async function storeHostEditText(text: string): Promise<StoredSourceText> {
  assertTextLimit(text);
  if (new TextEncoder().encode(text).length <= 1024) return text;
  const stream = new Blob([text]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const packed = { encoding: "gzip-base64" as const, data: btoa(binary) };
  return packed.data.length <= MAX_HOST_EDIT_DATA_CHARS &&
      new TextEncoder().encode(canonical(packed)).length <
        new TextEncoder().encode(canonical(text)).length
    ? packed
    : text;
}
async function compileSnapshot(
  compile:
    | ((sources: SourceRevision["sources"]) => Promise<SourceRevision>)
    | undefined,
  sources: SourceRevision["sources"],
  edit: HostEditRequest | HostEdit,
  opIndex: number,
): Promise<SourceRevision> {
  try {
    if (!compile) {
      failure(
        "TOOLKIT_REFUSED",
        opIndex,
        edit,
        "Structural writes require Toolkit snapshots",
      );
    }
    const snapshot = await compile(sources);
    if (canonical(snapshot.sources) !== canonical(sources)) {
      failure(
        "READ_BACK_MISMATCH",
        opIndex,
        edit,
        "Compiled sources differ from the prepared candidate",
      );
    }
    return snapshot;
  } catch (error) {
    providerFailure(error, edit, opIndex);
  }
}
/** Splices are byte coordinates in the call's input, never a license for other changes. */
export function assertSourceSplices(
  before: SourceRevision["sources"],
  result: ModelToolingEditResult,
  context: HostEditError["context"],
): void {
  const fail = (message: string): never => {
    throw new HostEditError("SPLICE_OUT_OF_SCOPE", context, message);
  };
  if (
    canonical(Object.keys(before).sort()) !==
      canonical(Object.keys(result.sources).sort())
  ) fail("Toolkit changed the source unit set");
  const encoder = new TextEncoder();
  for (const splice of result.splices) {
    if (!Object.hasOwn(before, splice.unit)) {
      fail("Toolkit splice refers to an unknown unit");
    }
  }
  for (const [unit, text] of Object.entries(before)) {
    const bytes = encoder.encode(text);
    const pieces: Uint8Array[] = [];
    let cursor = 0;
    let previousStart = -1;
    for (
      const splice of result.splices.filter((s) => s.unit === unit).sort((
        a,
        b,
      ) => a.start - b.start)
    ) {
      if (
        !Number.isSafeInteger(splice.start) ||
        !Number.isSafeInteger(splice.end) || splice.start < cursor ||
        splice.start === previousStart ||
        splice.end < splice.start || splice.end > bytes.length ||
        typeof splice.text !== "string"
      ) fail("Toolkit splices overlap or have invalid byte extents");
      previousStart = splice.start;
      pieces.push(
        bytes.slice(cursor, splice.start),
        encoder.encode(splice.text),
      );
      cursor = splice.end;
    }
    pieces.push(bytes.slice(cursor));
    const actual = encoder.encode(result.sources[unit]!);
    if (pieces.reduce((n, part) => n + part.length, 0) !== actual.length) {
      fail("Toolkit sources differ from the replayed splices");
    }
    let offset = 0;
    for (const piece of pieces) {
      for (const byte of piece) {
        if (actual[offset++] !== byte) {
          fail("Toolkit sources differ from the replayed splices");
        }
      }
    }
  }
}

function toolingTarget(base: SourceRevision, elementId: string) {
  return modelToolingTarget(base, elementId, { allowAnonymous: true });
}

function descendsFrom(
  element: SourceRevision["elements"][number],
  ancestor: string,
  byId: ReadonlyMap<string, SourceRevision["elements"][number]>,
): boolean {
  const seen = new Set<string>();
  let current = element;
  while (current && !seen.has(String(current["@id"]))) {
    seen.add(String(current["@id"]));
    const ownerId = ownerOf(current) ?? "";
    if (ownerId === ancestor) return true;
    current = byId.get(ownerId)!;
  }
  return false;
}

/** Pure preparation boundary: (immutable base, ordered changeset) -> candidate
 * sources and durable edit plan. Planning/resolution and application are interleaved
 * only for dependencies on earlier insertions. Toolkit and compilation are injected;
 * this module knows neither Git nor locks. The publisher calls verifyEdits on its
 * compiled candidate with this plan and the SAME base before publishing the receipt.
 */
export async function applyEdits(
  tooling: ModelToolingPort,
  base: SourceRevision,
  requests: readonly HostEditRequest[],
  options: {
    compile?: (sources: SourceRevision["sources"]) => Promise<SourceRevision>;
    retainCompiledRevision?: boolean;
  } = {},
) {
  if (requests.length < 1 || requests.length > 32) {
    throw new HostEditError(
      "TOOLKIT_REFUSED",
      {
        opIndex: -1,
        op: "setFeatureValue",
        target: { qualifiedName: "" },
      },
      "Expected 1–32 host edits",
    );
  }
  for (const [index, request] of requests.entries()) {
    if (
      request.batch !== undefined &&
      (!Number.isSafeInteger(request.batch) || request.batch < 0 ||
        request.batch > 31)
    ) failure("TOOLKIT_REFUSED", index, request, "Invalid host edit batch");
    if (request.op === "insertMember") {
      if (
        !Array.isArray(request.expect) || request.expect.some((expected) => {
          if (!expected || typeof expected !== "object") return true;
          if (expected.kind === "member") {
            return !parseSysmlQualifiedName(expected.qualifiedName) ||
              typeof expected.metaclass !== "string" || !expected.metaclass ||
              expected.sourceText !== undefined &&
                (typeof expected.sourceText !== "string" ||
                  !expected.sourceText.trim());
          }
          return expected.kind !== undefined && expected.kind !== "literal" ||
            !parseSysmlQualifiedName(expected.path) ||
            !(typeof expected.value === "string" ||
              typeof expected.value === "boolean" ||
              typeof expected.value === "number" &&
                Number.isFinite(expected.value));
        })
      ) {
        failure(
          "TOOLKIT_REFUSED",
          index,
          request,
          "Invalid insertion expectations",
        );
      }
    }
  }
  const compile = options.compile ??
    ((sources: SourceRevision["sources"]) => tooling.snapshot(sources));
  const edits: WorkingEdit[] = [];
  const splices: ModelToolingEditResult["splices"] = [];
  // Byte offsets are relative to each Toolkit call's input, not the original
  // revision. One entry per call: `call` is the unique sequential key, `batch`
  // is the requested batch number that call served.
  const batches: Array<
    { call: number; batch: number; splices: ModelToolingEditResult["splices"] }
  > = [];
  // Cumulative toolkit renames across calls, for the M1b operation journal.
  const idMap: Array<[string, string]> = [];
  let callSequence = 0;
  let snapshot = base;
  let compiledSources = base.sources;
  let compiledRevision: SourceRevision | undefined;
  let pending = requests.map((request, index) => ({ request, index }));
  while (pending.length) {
    const batch = Math.min(...pending.map(({ request }) => request.batch ?? 0));
    const batchEditsStart = edits.length;
    const operations: ResolvedHostEdit[] = [];
    const indices: number[] = [];
    const deferred: typeof pending = [];
    const inserted = new Map<string, number>();
    const seenTargets = new Map<string, number>();
    for (const { request, index } of pending) {
      if ((request.batch ?? 0) !== batch) {
        deferred.push({ request, index });
        continue;
      }
      try {
        let element;
        try {
          element = resolve(snapshot, request, index);
        } catch (error) {
          const missingTarget = hostEditTarget(request);
          const missingAnonymousId = modelTargetId(missingTarget);
          if (
            error instanceof HostEditError && error.code === "TARGET_MISSING" &&
            missingAnonymousId !== undefined && snapshot !== base &&
            base.elements.some((e) => e["@id"] === missingAnonymousId)
          ) {
            failure(
              "TARGET_MODIFIED",
              index,
              request,
              "Anonymous host target differs from its base preimage or owner",
            );
          }
          if (
            error instanceof HostEditError && error.code === "TARGET_MISSING" &&
            pending.some(({ request: candidate }) =>
              candidate.op === "insertMember"
            )
          ) {
            deferred.push({ request, index });
            continue;
          }
          throw error;
        }
        const target = toolingTarget(snapshot, String(element["@id"]));
        const requestedTarget = hostEditTarget(request);
        const anonymousId = modelTargetId(requestedTarget);
        if (
          anonymousId !== undefined &&
          !(typeof element.qualifiedName === "string" && element.qualifiedName)
        ) {
          const baseElement = base.elements.find((e) =>
            e["@id"] === anonymousId
          );
          if (
            !baseElement ||
            await sha256(
                toolingTarget(base, String(baseElement["@id"])).source.text,
              ) !== await sha256(target.source.text) ||
            ownerOf(baseElement) !== ownerOf(element)
          ) {
            failure(
              "TARGET_MODIFIED",
              index,
              request,
              "Anonymous host target differs from its base preimage or owner",
            );
          }
        }
        if (
          typeof element["sysx:sourceText"] === "string" &&
          element["sysx:sourceText"] !== target.source.text
        ) {
          failure(
            "TARGET_MODIFIED",
            index,
            request,
            "Host target source differs from its compiled preimage",
          );
        }
        const original = base.elements.find((e) => e["@id"] === element["@id"]);
        const identity = {
          id: String(element["@id"]),
          qualifiedName: target.qualifiedName,
          metaclass: target.metaclass,
          ...(request.op === "remove" ? { ownerId: ownerOf(element) } : {}),
          preimage: await sha256(
            original && !target.qualifiedName.startsWith("@")
              ? toolingTarget(base, String(original["@id"])).source.text
              : target.source.text,
          ),
        };
        if (request.op !== "insertMember") {
          const seenKey = `${request.op}:${identity.qualifiedName}`;
          if (seenTargets.has(seenKey)) {
            failure(
              "TARGET_AMBIGUOUS",
              index,
              request,
              "Duplicate host edit target",
            );
          }
          seenTargets.set(seenKey, index);
        }
        let operation: ResolvedHostEdit | undefined;
        switch (request.op) {
          case "setFeatureValue": {
            const previous = value(snapshot, element, request, index);
            if (typeof previous !== typeof request.value) {
              failure(
                "LITERAL_KIND_CHANGED",
                index,
                request,
                "Literal kind cannot change through a value write",
              );
            }
            const expression = spelling(request.value);
            edits.push({ ...request, target: identity });
            if (previous !== request.value) {
              operation = { kind: "set-value", target, expression };
            }
            break;
          }
          case "insertMember": {
            const at = inserted.get(identity.id);
            if (at !== undefined) {
              const previous = operations[at]!;
              if (previous.kind !== "insert-member") {
                throw new Error("Invalid insertion group");
              }
              previous.text += "\n" + request.text.trim();
            } else {
              inserted.set(identity.id, operations.length);
              operation = {
                kind: "insert-member",
                target,
                text: request.text.trim(),
              };
            }
            edits.push({
              ...request,
              owner: identity,
              expect: request.expect.map((expected) =>
                expected.kind === "member"
                  ? { ...expected }
                  : { ...expected, kind: expected.kind ?? "literal" }
              ),
            });
            break;
          }
          case "replaceMember":
            edits.push({ ...request, target: identity });
            operation = { kind: "replace-member", target, text: request.text };
            break;
          case "setFeatureType":
            edits.push({ ...request, target: identity });
            operation = { kind: "set-type", target, type: request.type };
            break;
          case "remove":
            edits.push({ ...request, target: identity });
            operation = { kind: "remove", target };
            break;
          default:
            failure(
              "TOOLKIT_REFUSED",
              index,
              request,
              "Unsupported host operation",
            );
        }
        if (operation) {
          if (
            request.op !== "insertMember" &&
            operations.some((op) =>
              op.kind === operation!.kind &&
              op.target.qualifiedName === target.qualifiedName
            )
          ) {
            failure(
              "TARGET_AMBIGUOUS",
              index,
              request,
              "Duplicate host edit target",
            );
          }
          operations.push(operation);
          indices.push(index);
        }
      } catch (error) {
        providerFailure(error, request, index);
      }
    }
    if (!operations.length) {
      if (
        deferred.length &&
        deferred.every(({ request }) => (request.batch ?? 0) > batch)
      ) {
        pending = deferred;
        continue;
      }
      if (deferred.length) {
        failure(
          "TARGET_MISSING",
          deferred[0]!.index,
          deferred[0]!.request,
          "Host edit dependency did not create its target",
        );
      }
      break;
    }
    let result: ModelToolingEditResult;
    try {
      result = await tooling.edit(
        structuredClone(snapshot.sources),
        operations,
      );
    } catch (error) {
      providerFailure(error, requests[indices[0]!]!, indices[0]!);
    }
    idMap.push(...result.idMap);
    assertSourceSplices(snapshot.sources, result, {
      opIndex: indices[0]!,
      op: requests[indices[0]!]!.op,
      target: hostEditTarget(requests[indices[0]!]!),
    });
    const spliceOperation: number[] = [];
    for (const splice of result.splices) {
      const contains = (
        target: (typeof result.targets)[number],
        index: number,
      ) =>
        target.qualifiedName === operations[index]?.target.qualifiedName &&
        target.metaclass === operations[index]?.target.metaclass &&
        target.source.path === splice.unit &&
        Number.isSafeInteger(splice.start) &&
        Number.isSafeInteger(splice.end) &&
        splice.end >= splice.start && splice.start >= 0 &&
        (splice.start >= target.source.startByte &&
            splice.end <= target.source.endByte ||
          operations[index]?.kind === "remove" && splice.text === "" &&
            splice.start <= target.source.startByte &&
            splice.end >= target.source.endByte &&
            !new TextDecoder().decode(
              new TextEncoder().encode(snapshot.sources[splice.unit]!).slice(
                splice.start,
                target.source.startByte,
              ),
            ).trim() &&
            !new TextDecoder().decode(
              new TextEncoder().encode(snapshot.sources[splice.unit]!).slice(
                target.source.endByte,
                splice.end,
              ),
            ).trim()) &&
        splice.end <=
          new TextEncoder().encode(snapshot.sources[splice.unit]!).length;
      // Attribute to the most inner containing target (smallest extent),
      // never merely the first enclosing one.
      let index = -1;
      let bestExtent = Infinity;
      for (const [candidateIndex, target] of result.targets.entries()) {
        if (!contains(target, candidateIndex)) continue;
        const extent = target.source.endByte - target.source.startByte;
        if (extent < bestExtent) {
          bestExtent = extent;
          index = candidateIndex;
        }
      }
      if (index < 0) {
        failure(
          "SPLICE_OUT_OF_SCOPE",
          indices[0]!,
          requests[indices[0]!]!,
          "Toolkit splice is outside the requested members",
        );
      }
      spliceOperation.push(index);
    }
    // S3: each insertion splice, normalized, must equal the requested text,
    // normalized. Refuse before any snapshot is compiled or returned.
    for (const [operationIndex, operation] of operations.entries()) {
      if (operation.kind !== "insert-member") continue;
      const texts = result.splices.filter((_, spliceIndex) =>
        spliceOperation[spliceIndex] === operationIndex
      ).map((splice) => splice.text);
      if (
        !texts.length ||
        normalizeMember(texts.join("\n")) !== normalizeMember(operation.text)
      ) {
        failure(
          "SPLICE_OUT_OF_SCOPE",
          indices[operationIndex]!,
          requests[indices[operationIndex]!]!,
          "Toolkit insertion splice differs from the requested text",
        );
      }
    }
    // Post-edit byte ranges of each splice, shifted by earlier splices.
    const splicePostRange = result.splices.map((splice, spliceIndex) => {
      let shift = 0;
      for (const [otherIndex, other] of result.splices.entries()) {
        if (
          other.unit === splice.unit &&
          (other.start < splice.start ||
            other.start === splice.start && otherIndex < spliceIndex)
        ) {
          shift += new TextEncoder().encode(other.text).length -
            (other.end - other.start);
        }
      }
      const start = splice.start + shift;
      return {
        unit: splice.unit,
        start,
        end: start + new TextEncoder().encode(splice.text).length,
        operation: spliceOperation[spliceIndex]!,
      };
    });
    splices.push(...result.splices);
    batches.push({
      call: callSequence++,
      batch,
      splices: [...result.splices],
    });
    const previous = snapshot;
    snapshot = { ...snapshot, sources: result.sources };
    const insertions = edits.slice(batchEditsStart).filter((e) =>
      e.op === "insertMember"
    );
    if (deferred.length || insertions.length) {
      snapshot = await compileSnapshot(
        compile,
        result.sources,
        requests[indices[0]!]!,
        indices[0]!,
      );
      compiledSources = snapshot.sources;
      compiledRevision = snapshot;
    }
    if (insertions.length) {
      const before = new Set(previous.elements.map((e) => e["@id"]));
      const byId = new Map(snapshot.elements.map((e) => [String(e["@id"]), e]));
      const literals = new Map(
        sourceLiterals(snapshot.elements).map((
          l,
        ) => [l.attributeId, byId.get(l.literalId)?.value]),
      );
      // Each insertion edit gets its own introduced members. Same-owner
      // edits share one Toolkit operation, so partition the new elements
      // by the top-level member each edit's text declares.
      const claimed = new Set<string>();
      const unassigned = new Map<WorkingEdit, Element[]>();
      for (const edit of insertions) {
        edit.introduced = [];
        const ownerOperation = inserted.get(hostEditTarget(edit).id);
        const ownerRanges = splicePostRange.filter((range) =>
          range.operation === ownerOperation
        );
        const candidates: Array<{ element: Element; start: number }> = [];
        for (const element of snapshot.elements) {
          if (before.has(element["@id"])) continue;
          if (claimed.has(String(element["@id"]))) continue;
          const segments = qualifiedSegments(element, byId);
          if (
            !segments || !descendsFrom(element, hostEditTarget(edit).id, byId)
          ) continue;
          const range = elementByteRange(snapshot, element, byId);
          if (
            !range ||
            !ownerRanges.some((splice) =>
              splice.unit === range.path && range.start >= splice.start &&
              range.end <= splice.end
            )
          ) continue;
          candidates.push({ element, start: range.start });
        }
        candidates.sort((a, b) => a.start - b.start);
        const candidateIds = new Set(
          candidates.map(({ element }) => String(element["@id"])),
        );
        const tops = candidates.filter(({ element }) => {
          const ownerId = ownerOf(element);
          return ownerId === hostEditTarget(edit).id ||
            !candidateIds.has(ownerId ?? "");
        });
        const requested = normalizeMember(edit.text);
        const matched: Element[] = [];
        const matchedTops = new Set<string>();
        for (const { element: top } of tops) {
          const declaration = normalizeMember(
            toolingTarget(snapshot, String(top["@id"])).source.text,
          );
          if (!requested.includes(declaration)) continue;
          matchedTops.add(String(top["@id"]));
          for (const { element } of candidates) {
            let current: Element | undefined = element;
            const seen = new Set<string>();
            while (current && !seen.has(String(current["@id"]))) {
              seen.add(String(current["@id"]));
              if (String(current["@id"]) === String(top["@id"])) {
                matched.push(element);
                break;
              }
              current = byId.get(ownerOf(current) ?? "");
            }
          }
        }
        const assigned = matched.length ? matched : [];
        if (!assigned.length) {
          unassigned.set(
            edit,
            candidates.map((c) => c.element),
          );
        }
        for (const element of assigned) claimed.add(String(element["@id"]));
        for (const element of assigned) {
          const segments = qualifiedSegments(element, byId)!;
          const literal = literals.get(String(element["@id"]));
          edit.introduced.push({
            qualifiedName: spellSysmlQualifiedName(segments),
            metaclass: String(element["@type"]),
            ...(literal === undefined ? {} : {
              value:
                literal as import("../../../domain/model/editing/host-edit.ts").Scalar,
            }),
          });
        }
      }
      // Any candidate no text matched (formatting drift) goes to the first
      // unassigned edit of its owner, so no new member is silently dropped.
      for (const [edit, candidates] of unassigned) {
        const remaining = candidates.filter((e) =>
          !claimed.has(String(e["@id"]))
        );
        if (!remaining.length) continue;
        const laterClaimed = insertions.some((other) =>
          other !== edit &&
          (other.introduced ?? []).length > 0 &&
          hostEditTarget(other).id === hostEditTarget(edit).id
        );
        if (laterClaimed && edit.introduced!.length) continue;
        for (const element of remaining) {
          if (claimed.has(String(element["@id"]))) continue;
          claimed.add(String(element["@id"]));
          const segments = qualifiedSegments(element, byId)!;
          const literal = literals.get(String(element["@id"]));
          edit.introduced!.push({
            qualifiedName: spellSysmlQualifiedName(segments),
            metaclass: String(element["@type"]),
            ...(literal === undefined ? {} : {
              value:
                literal as import("../../../domain/model/editing/host-edit.ts").Scalar,
            }),
          });
        }
      }
    }
    pending = deferred;
  }
  const memberInsertions = edits.filter((
    edit,
  ): edit is Extract<WorkingEdit, { op: "insertMember" }> =>
    edit.op === "insertMember" &&
    edit.expect.some((expected) => expected.kind === "member")
  );
  if (memberInsertions.length) {
    // Expectations describe the final changeset, including later child edits.
    // A trailing scalar/type/removal batch need not have compiled its sources.
    if (canonical(compiledSources) !== canonical(snapshot.sources)) {
      const edit = memberInsertions[0]!;
      snapshot = await compileSnapshot(
        compile,
        snapshot.sources,
        edit,
        edits.indexOf(edit),
      );
      compiledSources = snapshot.sources;
      compiledRevision = snapshot;
    }
    // Freeze exact compiled member bytes in new receipts. Explicit sourceText
    // remains an assertion supplied by the builder and is never overwritten.
    const index = buildIndex(snapshot);
    for (const edit of memberInsertions) {
      for (const expected of edit.expect) {
        if (expected.kind !== "member") continue;
        const member = resolveTarget(
          index,
          { qualifiedName: expected.qualifiedName },
          edit,
          edits.indexOf(edit),
        );
        if (
          member["@type"] !== expected.metaclass ||
          !edit.introduced?.some((m) =>
            sameSysmlQualifiedName(m.qualifiedName, expected.qualifiedName) &&
            m.metaclass === expected.metaclass
          ) ||
          !descendsFrom(
            member,
            String(resolve(index, edit, edits.indexOf(edit))["@id"]),
            index.byId,
          )
        ) {
          failure(
            "READ_BACK_MISMATCH",
            edits.indexOf(edit),
            edit,
            "Inserted member metaclass differs",
          );
        }
        const sourceText =
          toolingTarget(snapshot, String(member["@id"])).source.text;
        const sourceDigest = await sha256(sourceText);
        if (
          expected.sourceText !== undefined &&
            expected.sourceText !== sourceText ||
          expected.sourceDigest !== undefined &&
            expected.sourceDigest !== sourceDigest
        ) {
          failure(
            "READ_BACK_MISMATCH",
            edits.indexOf(edit),
            edit,
            "Inserted member source differs",
          );
        }
        delete expected.sourceText;
        expected.sourceDigest = sourceDigest;
      }
    }
  }
  const durable: HostEdit[] = [];
  for (const edit of edits) {
    if (edit.op === "insertMember") {
      if (
        edit.intent === "authority" &&
        !edit.expect.some((e) => e.kind === "member")
      ) {
        failure(
          "READ_BACK_MISMATCH",
          edits.indexOf(edit),
          edit,
          "Authority insertion requires member expectations",
        );
      }
      for (const member of edit.introduced ?? []) {
        const changedLater = edits.slice(edits.indexOf(edit) + 1).some((next) =>
          next.op === "setFeatureValue" &&
          sameSysmlQualifiedName(
            next.target.qualifiedName,
            member.qualifiedName,
          )
        );
        if (
          member.value !== undefined &&
          !changedLater &&
          new TextEncoder().encode(canonical(member.value)).length > 128
        ) {
          member.valueDigest = await sha256(canonical(member.value));
          delete member.value;
        }
      }
      durable.push({
        ...edit,
        format: 1,
        text: await storeHostEditText(edit.text),
        expectDigest: await sha256(canonical(edit.expect)),
      });
    } else if (edit.op === "replaceMember") {
      durable.push({
        ...edit,
        format: 1,
        text: await storeHostEditText(edit.text),
      });
    } else durable.push({ ...edit, format: 1 });
  }
  return {
    sources: structuredClone(snapshot.sources),
    // Transient compiler output only: this is neither an admitted pin nor authority.
    ...(options.retainCompiledRevision && compiledRevision &&
        canonical(compiledSources) === canonical(snapshot.sources)
      ? { compiledRevision }
      : {}),
    edits: durable,
    splices,
    batches,
    idMap,
  };
}

/** Verify(candidate, plan, { base }): final postconditions plus base preimages and
 * preservation of unrelated declarations. Omit base only for immutable publication
 * readback, where historical preimages can refer to different intermediate bases.
 */
export async function verifyEdits(
  revision: SourceRevision,
  stored: readonly HostEdit[],
  { base }: { base?: SourceRevision } = {},
): Promise<void> {
  const edits: WorkingEdit[] = [];
  for (const [index, edit] of stored.entries()) {
    if (edit.format !== undefined && edit.format !== 1) {
      failure(
        "READ_BACK_MISMATCH",
        index,
        edit,
        "Unsupported host receipt format",
      );
    }
    if (
      edit.op === "insertMember" && (
        edit.format === 1 &&
          (typeof edit.expectDigest !== "string" || !edit.expectDigest ||
            await sha256(canonical(edit.expect)) !== edit.expectDigest) ||
        edit.intent === "authority" &&
          !edit.expect.some((e) => e.kind === "member")
      )
    ) {
      failure(
        "READ_BACK_MISMATCH",
        index,
        edit,
        "Insertion expectations differ from the receipt proof",
      );
    }
    if (edit.op === "insertMember" || edit.op === "replaceMember") {
      try {
        edits.push({ ...edit, text: await readHostEditText(edit.text) });
      } catch {
        failure(
          "READ_BACK_MISMATCH",
          index,
          edit,
          "Invalid stored source text",
        );
      }
    } else edits.push(edit);
  }
  const revisionIndex = buildIndex(revision);
  const baseIndex = base ? buildIndex(base) : undefined;
  for (const [opIndex, edit] of edits.entries()) {
    const later = edits.slice(opIndex + 1);
    if (
      later.some((next) =>
        next.op === edit.op && edit.op !== "insertMember" &&
        hostEditTarget(next).qualifiedName ===
          hostEditTarget(edit).qualifiedName
      )
    ) continue;
    if (edit.op === "remove") {
      let remaining: SourceRevision["elements"];
      if (edit.target.qualifiedName.startsWith("@")) {
        remaining = [];
        for (
          const candidate of revision.elements.filter((e) =>
            e["@type"] === edit.target.metaclass &&
            ownerOf(e) === edit.target.ownerId
          )
        ) {
          const current = toolingTarget(revision, String(candidate["@id"]));
          if (await sha256(current.source.text) === edit.target.preimage) {
            remaining.push(candidate);
          }
        }
      } else {
        try {
          remaining = [resolve(revisionIndex, edit, opIndex)];
        } catch (error) {
          if (
            error instanceof HostEditError && error.code === "TARGET_MISSING"
          ) remaining = [];
          else throw error;
        }
      }
      if (!remaining.length) continue;
      // A removed member is excused only when a later insertMember for the
      // same owner reinserts it: compare whole normalized member texts as
      // line multisets, never single lines against a multi-line
      // declaration. Extra lines are allowed only because a later op may
      // insert a child into the reinserted member; a changed or missing
      // reinserted line stays refused.
      const allowedReinsertions = later.filter((next) =>
        next.op === "insertMember" && next.owner.id === ownerOf(remaining[0]!)
      ).map((next) =>
        next.op === "insertMember" ? normalizeMember(next.text) : ""
      );
      const lineCounts = (text: string) => {
        const counts = new Map<string, number>();
        for (const line of text.split("\n")) {
          counts.set(line, (counts.get(line) ?? 0) + 1);
        }
        return counts;
      };
      if (
        remaining.every((current) => {
          const declaration = lineCounts(normalizeMember(
            toolingTarget(revision, String(current["@id"])).source.text,
          ));
          return allowedReinsertions.some((text) => {
            const needed = lineCounts(text);
            return [...needed].every(([line, count]) =>
              (declaration.get(line) ?? 0) >= count
            );
          });
        })
      ) continue;
      failure(
        "READ_BACK_MISMATCH",
        opIndex,
        edit,
        `Removed host target still exists: ${edit.target.qualifiedName}`,
      );
    }
    const element = resolve(revisionIndex, edit, opIndex);
    const target = toolingTarget(revision, String(element["@id"]));
    if (edit.op === "setFeatureValue") {
      if (value(revision, element, edit, opIndex) !== edit.value) {
        failure(
          "READ_BACK_MISMATCH",
          opIndex,
          edit,
          `Host edit value differs after compilation: ${edit.target.qualifiedName}`,
        );
      }
    } else if (edit.op === "insertMember" || edit.op === "replaceMember") {
      const actual = normalizeMember(target.source.text),
        expected = normalizeMember(edit.text);
      let declarationOk = edit.op === "replaceMember"
        ? actual === expected
        : actual.includes(expected);
      if (!declarationOk && edit.op === "insertMember") {
        let rewritten = expected;
        const excusedMembers: Array<
          {
            qualifiedName: string;
            value?: import("../../../domain/model/editing/host-edit.ts").Scalar;
          }
        > = [];
        for (const next of later) {
          const nextName = hostEditTarget(next).qualifiedName;
          const members = (edit.introduced ?? []).filter((candidate) => {
            const memberSegments = parseSysmlQualifiedName(
              candidate.qualifiedName,
            );
            const nextSegments = parseSysmlQualifiedName(nextName);
            return !!memberSegments && !!nextSegments &&
              nextSegments.length >= memberSegments.length &&
              memberSegments.every((s, i) => s === nextSegments[i]);
          });
          for (const member of members) {
            if (
              next.op === "setFeatureValue" &&
              sameSysmlQualifiedName(member.qualifiedName, nextName) &&
              member.value !== undefined
            ) {
              rewritten = rewritten.replace(
                spelling(member.value),
                spelling(next.value),
              );
            }
            if (
              !excusedMembers.some((excused) =>
                sameSysmlQualifiedName(
                  excused.qualifiedName,
                  member.qualifiedName,
                )
              )
            ) excusedMembers.push(member);
          }
        }
        declarationOk = actual.includes(rewritten);
        if (!declarationOk && excusedMembers.length) {
          // Excuse per member only: a line is excused only when it equals a
          // line of that member's own describe text (candidate), with the
          // rewritten literal substituted back. Never by substring, so an
          // anonymous sibling falsified or deleted stays refused even when
          // a neighbouring member is excused.
          const excusedLines = new Set<string>();
          for (const member of excusedMembers) {
            let memberElement;
            try {
              memberElement = resolveTarget(
                revisionIndex,
                { qualifiedName: member.qualifiedName },
                edit,
                opIndex,
              );
            } catch {
              continue;
            }
            let describeText = normalizeMember(
              toolingTarget(revision, String(memberElement["@id"])).source
                .text,
            );
            for (const next of later) {
              if (
                next.op === "setFeatureValue" &&
                sameSysmlQualifiedName(
                  next.target.qualifiedName,
                  member.qualifiedName,
                ) && member.value !== undefined
              ) {
                describeText = describeText.replace(
                  spelling(next.value),
                  spelling(member.value),
                );
              }
            }
            for (const line of describeText.split("\n")) {
              excusedLines.add(line);
            }
            excusedLines.add(describeText);
          }
          // A declaration line of an excused member is also recognised by
          // the member's name as a whole token (never a substring): this
          // covers a member whose body later gained an inserted child.
          const excusedTokens = new Set(
            excusedMembers.map((member) =>
              parseSysmlQualifiedName(member.qualifiedName)?.at(-1)
            ).filter((segment) => !!segment),
          );
          const tokensOf = (line: string) => {
            const tokens: string[] = [];
            let current = "";
            for (const char of line) {
              if (char === " " || char === "\t") {
                if (current) tokens.push(current);
                current = "";
              } else current += char;
            }
            if (current) tokens.push(current);
            return tokens.map((token) => {
              let start = 0, end = token.length;
              while (start < end && "{}();,".includes(token[start]!)) start++;
              while (end > start && "{}();,".includes(token[end - 1]!)) end--;
              return token.slice(start, end);
            });
          };
          declarationOk = rewritten.split("\n").filter((line) =>
            !excusedLines.has(line) &&
            !tokensOf(line).some((token) => excusedTokens.has(token))
          ).every((line) => actual.includes(line));
        }
      }
      if (!declarationOk && edit.op !== "insertMember") {
        failure(
          "READ_BACK_MISMATCH",
          opIndex,
          edit,
          "Host member declaration differs after compilation",
        );
      }
      if (edit.op === "insertMember") {
        for (const member of edit.introduced ?? []) {
          const child = resolveTarget(
            revisionIndex,
            { qualifiedName: member.qualifiedName },
            edit,
            opIndex,
          );
          if (child["@type"] !== member.metaclass) {
            failure(
              "READ_BACK_MISMATCH",
              opIndex,
              edit,
              "Inserted member metaclass differs",
            );
          }
          const changed = later.findLast((next) =>
            next.op === "setFeatureValue" &&
            sameSysmlQualifiedName(
              next.target.qualifiedName,
              member.qualifiedName,
            )
          );
          const expectedValue = changed?.op === "setFeatureValue"
            ? changed.value
            : member.value;
          if (
            expectedValue !== undefined &&
              value(revision, child, edit, opIndex) !== expectedValue ||
            expectedValue === undefined && member.valueDigest !== undefined &&
              await sha256(canonical(value(revision, child, edit, opIndex))) !==
                member.valueDigest
          ) {
            failure(
              "READ_BACK_MISMATCH",
              opIndex,
              edit,
              "Inserted member literal differs",
            );
          }
        }
        for (const expectation of edit.expect) {
          if (expectation.kind === "member") {
            const child = resolveTarget(
              revisionIndex,
              { qualifiedName: expectation.qualifiedName },
              edit,
              opIndex,
            );
            if (
              child["@type"] !== expectation.metaclass ||
              !edit.introduced?.some((m) =>
                sameSysmlQualifiedName(
                  m.qualifiedName,
                  expectation.qualifiedName,
                ) && m.metaclass === expectation.metaclass
              ) ||
              !(typeof expectation.sourceText === "string" &&
                  expectation.sourceText.trim() ||
                typeof expectation.sourceDigest === "string" &&
                  expectation.sourceDigest.length === 64) ||
              expectation.sourceDigest !== undefined &&
                await sha256(
                    toolingTarget(revision, String(child["@id"])).source.text,
                  ) !== expectation.sourceDigest ||
              !descendsFrom(
                child,
                String(element["@id"]),
                revisionIndex.byId,
              ) ||
              expectation.sourceText !== undefined && (
                  typeof expectation.sourceText !== "string" ||
                  !expectation.sourceText.trim() ||
                  toolingTarget(revision, String(child["@id"])).source.text !==
                    expectation.sourceText
                )
            ) {
              failure(
                "READ_BACK_MISMATCH",
                opIndex,
                edit,
                `Inserted member differs: ${expectation.qualifiedName}`,
              );
            }
            continue;
          }
          if (expectation.kind !== "literal") {
            failure(
              "READ_BACK_MISMATCH",
              opIndex,
              edit,
              "Unknown insertion expectation kind",
            );
          }
          const child = resolveTarget(
            revisionIndex,
            {
              qualifiedName: `${edit.owner.qualifiedName}::${expectation.path}`,
            },
            edit,
            opIndex,
          );
          if (value(revision, child, edit, opIndex) !== expectation.value) {
            failure(
              "READ_BACK_MISMATCH",
              opIndex,
              edit,
              `Inserted literal differs: ${expectation.path}`,
            );
          }
        }
        // The introduced/expect literal checks above name the exact frozen
        // literal that diverged; only a divergence they do not cover falls
        // back to the generic declaration refusal.
        if (!declarationOk) {
          failure(
            "READ_BACK_MISMATCH",
            opIndex,
            edit,
            "Host member declaration differs after compilation",
          );
        }
      }
    } else if (edit.op === "setFeatureType") {
      const ids = Array.isArray(element.type) ? element.type : [element.type];
      const typeIds = ids.map((v) =>
        typeof v === "string"
          ? v
          : v && typeof v === "object" && "@id" in v
          ? v["@id"]
          : undefined
      );
      const matches = (revisionIndex.byName.get(
        JSON.stringify(parseSysmlQualifiedName(edit.type)),
      ) ?? []).filter((e) => typeIds.includes(e["@id"]));
      if (matches.length !== 1) {
        failure(
          "READ_BACK_MISMATCH",
          opIndex,
          edit,
          "Host feature type differs after compilation",
        );
      }
    } else {failure(
        "READ_BACK_MISMATCH",
        opIndex,
        edit,
        "Unsupported receipt operation",
      );}
  }
  if (!base) return;
  // Preimages are checked against the immutable preparation base, never against
  // the candidate whose edited member is expected to differ.
  for (const [opIndex, edit] of edits.entries()) {
    let element;
    const identity = hostEditTarget(edit);
    if (identity.qualifiedName.startsWith("@")) {
      const matches = [];
      for (
        const candidate of base.elements.filter((e) =>
          e["@type"] === identity.metaclass && ownerOf(e) === identity.ownerId
        )
      ) {
        if (
          await sha256(
            toolingTarget(base, String(candidate["@id"])).source.text,
          ) === identity.preimage
        ) matches.push(candidate);
      }
      if (matches.length !== 1) {
        failure(
          matches.length ? "TARGET_AMBIGUOUS" : "TARGET_MODIFIED",
          opIndex,
          edit,
          "Host removal base preimage differs",
        );
      }
      continue;
    }
    try {
      element = resolve(baseIndex!, edit, opIndex);
    } catch (error) {
      if (
        error instanceof HostEditError && error.code === "TARGET_MISSING" &&
        edits.slice(0, opIndex).some((prior) =>
          prior.op === "insertMember" &&
          prior.introduced?.some((member) =>
            sameSysmlQualifiedName(
              member.qualifiedName,
              hostEditTarget(edit).qualifiedName,
            )
          )
        )
      ) continue;
      throw error;
    }
    const target = toolingTarget(base, String(element["@id"]));
    if (await sha256(target.source.text) !== hostEditTarget(edit).preimage) {
      failure(
        "TARGET_MODIFIED",
        opIndex,
        edit,
        "Host edit base preimage differs",
      );
    }
  }
  const nameKey = (name: string) =>
    JSON.stringify(parseSysmlQualifiedName(name) ?? [name]);
  const allowed = new Set(
    edits.filter((edit) => edit.op !== "insertMember").map((edit) =>
      nameKey(hostEditTarget(edit).qualifiedName)
    ),
  );
  const allowedDescendants = new Set<string>();
  for (const edit of edits) {
    if (edit.op === "insertMember") {
      for (const member of edit.introduced ?? []) {
        allowedDescendants.add(nameKey(member.qualifiedName));
      }
    }
    if (
      edit.op === "replaceMember" ||
      edit.op === "remove"
    ) {
      const targetName = hostEditTarget(edit).qualifiedName;
      for (const source of [base, revision]) {
        const byId = new Map(source.elements.map((e) => [String(e["@id"]), e]));
        const parent = source.elements.find((e) =>
          e["@id"] === hostEditTarget(edit).id
        );
        for (const child of source.elements) {
          let current = child;
          const seen = new Set<string>();
          while (current && !seen.has(String(current["@id"]))) {
            if (current === parent && child !== parent) {
              // Insertions permit only new descendants, never edits to existing siblings.
              {
                const segments = qualifiedSegments(child, byId);
                if (segments) allowedDescendants.add(JSON.stringify(segments));
              }
              break;
            }
            seen.add(String(current["@id"]));
            current = byId.get(ownerOf(current) ?? "")!;
          }
        }
      }
      allowed.add(nameKey(targetName));
    }
  }
  const facts = (source: SourceRevision) => {
    const byId = new Map(
      source.elements.map((element) => [String(element["@id"]), element]),
    );
    const inSource = (element: SourceRevision["elements"][number]) => {
      let current = element;
      const seen = new Set<string>();
      while (current && !seen.has(String(current["@id"]))) {
        seen.add(String(current["@id"]));
        if (typeof current["sysx:sourceDocument"] === "string") {
          return Object.hasOwn(source.sources, current["sysx:sourceDocument"]);
        }
        current = byId.get(ownerOf(current) ?? "")!;
      }
      return false;
    };
    const named = source.elements.filter((element) =>
      typeof element.qualifiedName === "string" && inSource(element)
    );
    const result = new Map<string, string[]>();
    const add = (element: SourceRevision["elements"][number], fact: string) => {
      const key = JSON.stringify(
        qualifiedSegments(element, byId) ?? [String(element.qualifiedName)],
      );
      result.set(key, [...(result.get(key) ?? []), fact]);
    };
    for (const element of named) {
      add(element, String(element["@type"]));
    }
    for (const literal of sourceLiterals(source.elements)) {
      const attribute = byId.get(literal.attributeId);
      if (typeof attribute?.qualifiedName === "string" && inSource(attribute)) {
        add(
          attribute,
          JSON.stringify([
            attribute["@type"],
            literal.kind,
            byId.get(literal.literalId)?.value,
          ]),
        );
      }
    }
    return new Map(
      [...result].map(([key, facts]) => [key, JSON.stringify(facts.sort())]),
    );
  };
  const before = facts(base), after = facts(revision);
  // Metaclass and scalar facts alone cannot detect a changed reference, binding
  // or type. Preserve the exact source of every unrelated existing declaration.
  // Target ancestors necessarily contain the edit; replace/remove explicitly own
  // their descendants. Insertion owners never authorize edits to existing siblings.
  const targetNames = edits.map((edit) =>
    parseSysmlQualifiedName(hostEditTarget(edit).qualifiedName)
  );
  const anonymousAncestors = new Set<string>();
  for (const edit of edits) {
    const target = hostEditTarget(edit);
    if (!target.qualifiedName.startsWith("@")) continue;
    let current = baseIndex!.byId.get(target.id);
    const seen = new Set<string>();
    while (current && !seen.has(String(current["@id"]))) {
      seen.add(String(current["@id"]));
      const segments = qualifiedSegments(current, baseIndex!.byId);
      if (segments) anonymousAncestors.add(JSON.stringify(segments));
      current = baseIndex!.byId.get(ownerOf(current) ?? "");
    }
  }
  for (const element of base.elements) {
    const segments = qualifiedSegments(element, baseIndex!.byId);
    if (!segments || typeof element["sysx:sourceText"] !== "string") continue;
    const key = JSON.stringify(segments);
    if (
      allowed.has(key) || allowedDescendants.has(key) ||
      anonymousAncestors.has(key) ||
      targetNames.some((target) =>
        target && target.length >= segments.length &&
        segments.every((part, i) => part === target[i])
      )
    ) continue;
    const matches = revisionIndex.byName.get(key) ?? [];
    if (
      matches.length !== 1 ||
      matches[0]!["sysx:sourceText"] !== element["sysx:sourceText"]
    ) {
      throw new HostEditError(
        "READ_BACK_MISMATCH",
        {
          opIndex: -1,
          op: edits[0]?.op ?? "setFeatureValue",
          target: { qualifiedName: spellSysmlQualifiedName(segments) },
        },
        `Existing declaration changed outside the host edit targets: ${
          spellSysmlQualifiedName(segments)
        }`,
      );
    }
  }
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (
      before.get(name) !== after.get(name) && !allowed.has(name) &&
      !allowedDescendants.has(name)
    ) {
      throw new HostEditError("READ_BACK_MISMATCH", {
        opIndex: -1,
        op: "setFeatureValue",
        target: { qualifiedName: (JSON.parse(name) as string[]).join("::") },
      }, `Compiled change is outside the host edit targets: ${name}`);
    }
  }
}

/** Incarnation inventory of one immutable base for the M1b replay planner.
 * Preimages use the exact member text the writer anchors in EditTargets.
 * Unresolvable elements are omitted: the planner then refuses, never guesses. */
export async function incarnationInventory(
  revision: SourceRevision,
  query: { nativeIds: readonly string[]; qualifiedNames: readonly string[] },
): Promise<IncarnationInventory> {
  const index = buildIndex(revision);
  const qualifiedNames: string[] = [];
  for (const element of revision.elements) {
    const segments = qualifiedSegments(element, index.byId);
    if (segments) qualifiedNames.push(spellSysmlQualifiedName(segments));
  }
  const incarnations: ElementIncarnationRef[] = [];
  for (const nativeId of new Set(query.nativeIds)) {
    const element = index.byId.get(nativeId);
    if (!element) continue;
    try {
      const target = toolingTarget(revision, nativeId);
      const ownerNativeId = ownerOf(element);
      incarnations.push({
        nativeId,
        qualifiedName: target.qualifiedName,
        metaclass: target.metaclass,
        preimageDigest: await sha256(target.source.text),
        ...(ownerNativeId ? { ownerNativeId } : {}),
      });
    } catch { /* omitted: replay planning fails closed for this target */ }
  }
  return { incarnations, qualifiedNames };
}

async function toEditRequest(edit: HostEdit): Promise<HostEditRequest> {
  const batch = edit.batch !== undefined ? { batch: edit.batch } : {};
  switch (edit.op) {
    case "setFeatureValue":
      return {
        op: edit.op,
        target: { qualifiedName: edit.target.qualifiedName },
        value: edit.value,
        ...batch,
      };
    case "insertMember":
      return {
        op: edit.op,
        owner: { qualifiedName: edit.owner.qualifiedName },
        text: await readHostEditText(edit.text),
        expect: structuredClone(edit.expect),
        ...(edit.intent ? { intent: edit.intent } : {}),
        ...batch,
      };
    case "replaceMember":
      return {
        op: edit.op,
        target: { qualifiedName: edit.target.qualifiedName },
        text: await readHostEditText(edit.text),
        ...batch,
      };
    case "setFeatureType":
      return {
        op: edit.op,
        target: { qualifiedName: edit.target.qualifiedName },
        type: edit.type,
        ...batch,
      };
    case "remove":
      return {
        op: edit.op,
        target: { qualifiedName: edit.target.qualifiedName },
        ...batch,
      };
  }
}

/** W3 executor over the existing W1 writer. Applying journal edits only
 * produces candidate sources in memory; `verifyEdits` with the journal edits
 * and the execution base is what enforces M1b preimages before publication.
 * Any native session behind `tooling` stays inside that adapter: this façade
 * only ever sees immutable revisions identified by version and sources. */
export function createHostEditExecutor(
  tooling: ModelToolingPort,
): HostEditExecutorPort {
  return {
    async apply(base: ModelRevision, edits: readonly HostEdit[]) {
      const requests: HostEditRequest[] = [];
      for (const edit of edits) requests.push(await toEditRequest(edit));
      const result = await applyEdits(tooling, base, requests);
      return {
        sources: result.sources as Sources,
        resolvedEdits: result.edits,
      };
    },
    async verify(
      candidate: ModelRevision,
      edits: readonly HostEdit[],
      base: ModelRevision,
    ): Promise<void> {
      await verifyEdits(candidate, edits, { base });
    },
    async incarnationInventory(
      base: ModelRevision,
      query: {
        nativeIds: readonly string[];
        qualifiedNames: readonly string[];
      },
    ): Promise<IncarnationInventory> {
      return await incarnationInventory(base, query);
    },
  };
}
