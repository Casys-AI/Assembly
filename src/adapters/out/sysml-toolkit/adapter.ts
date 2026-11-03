import { compareCodeUnits } from "../../../domain/primitives/canonical-json.ts";
import { sha256Bytes as sha256 } from "../../../domain/primitives/sha256-bytes.ts";
import { isNativeToolkitPanic } from "./runtime/native-addon.ts";
import { toolkitSourceTokens } from "./projections/source-tokens.ts";
import {
  MAX_TOKEN_SOURCE_BYTES,
  type SourceTokens,
} from "../../../domain/model/consultation/source-tokens.ts";
import { ToolkitCompiler } from "./compilation/compiler.ts";
import { projectToolkitBoard } from "./projections/board.ts";
import {
  projectToolkitViewDiagram,
  projectToolkitViewList,
  projectToolkitViewPlantuml,
} from "./projections/views.ts";
import type { ModelBoard } from "../../../domain/model/records/board.ts";
import type {
  ModelView,
  ModelViewList,
  ModelViewSummary,
} from "../../../domain/model/records/diagram-views.ts";
/** Required source tooling. The existing compiler/repository still publishes. */
import type { ModelToolingPort } from "../../../application/model/tooling.ts";
import type {
  ModelToolingDescription,
  ModelToolingDiagnostic,
  ModelToolingEditResult,
  ModelToolingTarget,
  ReferenceSiteFingerprint,
  ResolvedModelEdit,
} from "../../../domain/model/editing/tooling.ts";
import {
  isNativeReferenceId,
  isReferenceSiteFingerprint,
  isWholeMemberText,
} from "../../../domain/model/editing/tooling.ts";
import {
  parseSysmlQualifiedName,
  sameSysmlQualifiedName,
  spellSysmlQualifiedName,
} from "../../../domain/model/value-objects/sysml-qualified-name.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";

import { validateModelSources as validateSources } from "../../../domain/model/value-objects/sources.ts";
import {
  loadSysmlToolkit,
  type ToolkitElement,
  type ToolkitRuntime,
  type ToolkitSession,
} from "./runtime/loader.ts";
import {
  runSysmlToolkitWorker,
  SYSML_TOOLKIT_TIMEOUT_MS,
  SysmlToolkitWorkerError,
  type ToolkitWorkerOperation,
  validateToolkitTimeout,
} from "./worker-client.ts";

type Sources = Record<string, string>;
type JsonObject = Record<string, unknown>;
type Splice = ModelToolingEditResult["splices"][number];
interface Unit {
  unit: number;
  name: string;
  text: string;
}
interface EditReport {
  splices: Splice[];
  idMap: Array<[string, string]>;
  findings: unknown[];
  wouldCommit?: boolean;
  refusal?: string;
}

export class SysmlToolkitError extends Error {
  constructor(
    message: string,
    readonly diagnostics: ModelToolingDiagnostic[] = [],
    readonly code?: string,
  ) {
    super(message);
    this.name = "SysmlToolkitError";
  }
}

export interface SysmlToolkitAdapterOptions {
  packageDir: string;
  /** Execution deadline includes worker startup, library load and the operation. */
  timeoutMs?: number;
  /** Unit-test seam. Production always uses the version-pinned local loader. */
  loadRuntime?: () => Promise<ToolkitRuntime>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function ensure(
  condition: unknown,
  message: string,
  code = "TOOLKIT_REFUSED",
): asserts condition {
  if (!condition) throw new SysmlToolkitError(message, [], code);
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value: JsonObject, expected: string[], subject: string): void {
  ensure(
    Object.keys(value).length === expected.length &&
      expected.every((key) => Object.hasOwn(value, key)),
    `Invalid ${subject} fields`,
  );
}

function text(value: unknown, subject: string, maxBytes = 1_048_576): string {
  ensure(
    typeof value === "string" && value.trim().length > 0 &&
      !value.includes("\0") && encoder.encode(value).length <= maxBytes,
    `Invalid ${subject}`,
  );
  return value;
}

function json(input: string, subject: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    throw new SysmlToolkitError(`Malformed toolkit ${subject}`);
  }
}

function diagnostics(input: string): ModelToolingDiagnostic[] {
  const result = json(input, "diagnostics");
  ensure(Array.isArray(result), "Invalid toolkit diagnostics");
  return result.map((entry) => {
    ensure(
      object(entry) && typeof entry.severity === "string" &&
        typeof entry.message === "string",
      "Invalid toolkit diagnostic entry",
    );
    return {
      severity: entry.severity,
      message: entry.message,
      ...(typeof entry.stage === "string" ? { stage: entry.stage } : {}),
      ...(typeof entry.unit === "string" ? { unit: entry.unit } : {}),
      ...(Number.isSafeInteger(entry.line) ? { line: Number(entry.line) } : {}),
      ...(Number.isSafeInteger(entry.col) ? { col: Number(entry.col) } : {}),
    };
  });
}

function blocking(items: ModelToolingDiagnostic[], sources: Sources) {
  return items.filter((entry) =>
    entry.severity.toLowerCase() === "error" ||
    entry.stage === "referential" &&
      (entry.unit === undefined || Object.hasOwn(sources, entry.unit))
  );
}

function requireClean(items: ModelToolingDiagnostic[], sources: Sources): void {
  const errors = blocking(items, sources);
  if (errors.length) {
    throw new SysmlToolkitError(
      `Toolkit validation refused: ${errors[0].message}`,
      items,
      "COMPILE_ERROR",
    );
  }
}

function readUnits(session: ToolkitSession): Unit[] {
  const result = json(session.units(), "source units");
  ensure(Array.isArray(result), "Invalid toolkit source units");
  const paths = new Set<string>(), indices = new Set<number>();
  return result.map((entry) => {
    ensure(
      object(entry) && Number.isSafeInteger(entry.unit) &&
        typeof entry.name === "string" && typeof entry.text === "string" &&
        !paths.has(entry.name) && !indices.has(Number(entry.unit)),
      "Invalid or duplicate toolkit source unit",
    );
    paths.add(entry.name);
    indices.add(Number(entry.unit));
    return { unit: Number(entry.unit), name: entry.name, text: entry.text };
  });
}

function sourceTree(session: ToolkitSession, expected: Sources): Sources {
  const units = readUnits(session);
  const tree = validateSources(
    Object.fromEntries(units.map((unit) => [unit.name, unit.text])),
  );
  ensure(
    JSON.stringify(Object.keys(tree).sort()) ===
      JSON.stringify(Object.keys(expected).sort()),
    "Toolkit changed the source file set outside the requested member edits",
  );
  return tree;
}

function equalTree(before: Sources, after: Sources): boolean {
  return Object.keys(before).length === Object.keys(after).length &&
    Object.keys(before).every((path) => before[path] === after[path]);
}

function reference(
  session: ToolkitSession,
  element: ToolkitElement,
): { id: string; qualifiedName?: string; metaclass?: string } {
  const qualifiedName = session.qualifiedName(element);
  return {
    id: session.elementId(element),
    ...(qualifiedName ? { qualifiedName } : {}),
    metaclass: session.metaclass(element),
  };
}

function free(elements: readonly (ToolkitElement | undefined)[]): void {
  let trap: unknown;
  for (const element of elements) {
    try {
      element?.free();
    } catch (error) {
      // Attempt all handles before propagating a trap to #session, which
      // invalidates the runtime and prevents subsequent native operations.
      if (isNativeToolkitPanic(error)) trap ??= error;
    }
  }
  if (trap) throw trap;
}

function targetSpelling(target: ModelToolingTarget): string {
  if (target.qualifiedName.startsWith("@")) return target.qualifiedName;
  const segments = parseSysmlQualifiedName(target.qualifiedName);
  ensure(segments, "Invalid target qualified name");
  return spellSysmlQualifiedName(segments);
}

function describeTarget(
  session: ToolkitSession,
  sources: Sources,
  target: ModelToolingTarget,
): ModelToolingDescription {
  ensure(object(target), "Invalid tooling target");
  fields(target as unknown as JsonObject, [
    "qualifiedName",
    "metaclass",
    "source",
  ], "tooling target");
  text(target.qualifiedName, "target qualified name", 4096);
  text(target.metaclass, "target metaclass", 200);
  ensure(object(target.source), "Invalid target source preimage");
  fields(target.source, ["path", "text"], "target source preimage");
  ensure(
    typeof target.source.path === "string" &&
      Object.hasOwn(sources, target.source.path) &&
      typeof target.source.text === "string" && target.source.text.length > 0,
    "Target source preimage is outside the source snapshot",
  );
  const spelling = targetSpelling(target);
  const element = spelling.startsWith("@")
    ? session.elementById?.(spelling.slice(1))
    : session.resolve(spelling);
  ensure(
    element,
    `Toolkit target does not resolve: ${target.qualifiedName}`,
    "TARGET_MISSING",
  );
  let owner: ToolkitElement | undefined;
  let types: ToolkitElement[] = [];
  try {
    ensure(
      !session.isLibraryElement(element),
      "Toolkit library targets are read-only",
    );
    ensure(
      (spelling.startsWith("@")
        ? session.elementId(element) === spelling.slice(1)
        : sameSysmlQualifiedName(
          session.referenceSpelling(element) ??
            session.qualifiedName(element) ??
            "",
          target.qualifiedName,
        )) &&
        session.metaclass(element) === target.metaclass,
      "Toolkit target identity/metaclass differs from its source base",
      "TARGET_MODIFIED",
    );
    const rawExtent = session.memberExtent(element);
    ensure(rawExtent, "Toolkit target has no recorded source extent");
    const extent = json(rawExtent, "member extent");
    ensure(
      object(extent) && Number.isSafeInteger(extent.unit) &&
        Number.isSafeInteger(extent.start) && Number.isSafeInteger(extent.end),
      "Invalid toolkit member extent",
    );
    const unit = readUnits(session).find((entry) => entry.unit === extent.unit);
    ensure(
      unit && unit.name === target.source.path,
      "Toolkit target source path differs from its source base",
      "TARGET_MODIFIED",
    );
    ensure(
      unit.text === sources[unit.name],
      "Toolkit target source unit differs from its source base",
      "TARGET_MODIFIED",
    );
    const bytes = encoder.encode(unit.text);
    const startByte = Number(extent.start), endByte = Number(extent.end);
    ensure(
      startByte >= 0 && endByte > startByte && endByte <= bytes.length,
      "Toolkit target source extent is outside its snapshot",
    );
    const sourceText = decoder.decode(bytes.slice(startByte, endByte));
    ensure(
      sourceText === target.source.text &&
        sourceText === session.memberSource(spelling),
      "Toolkit target source preimage differs from its source base",
      "TARGET_MODIFIED",
    );
    owner = session.owner(element);
    types = session.typings(element);
    return {
      id: session.elementId(element),
      qualifiedName: target.qualifiedName,
      metaclass: target.metaclass,
      ...(owner ? { owner: reference(session, owner) } : {}),
      types: types.map((type) => reference(session, type)),
      source: { path: unit.name, startByte, endByte, text: sourceText },
    };
  } finally {
    free([element, owner, ...types]);
  }
}

/** Anchor a native site to the first writable containing member in its exact
 * owner chain. This does not grant permission to edit that member. */
function describeReferenceSite(
  session: ToolkitSession,
  sources: Sources,
  edit: Extract<ResolvedModelEdit, { kind: "retarget-reference" }>,
): ModelToolingDescription {
  const { site } = edit;
  ensure(
    isReferenceSiteFingerprint(site) && isNativeReferenceId(edit.fromId) &&
      isNativeReferenceId(edit.toId),
    "Invalid reference-site edit",
  );
  const result = json(
    session.references(JSON.stringify({ elementId: edit.fromId })),
    "native reference sites",
  );
  ensure(
    object(result) &&
      result.referenceSiteFormat === "assembly-native-reference-site/v1" &&
      Array.isArray(result.references),
    "Native reference-site fingerprints are unavailable",
    "REFERENCE_SITES_UNAVAILABLE",
  );
  ensure(
    Number.isSafeInteger(result.referenceSitesOmitted) &&
      result.referenceSitesOmitted === 0,
    "Native reference-site inventory is incomplete",
    "REFERENCE_SITES_INCOMPLETE",
  );
  const matches = result.references.filter((entry) =>
    object(entry) &&
    isReferenceSiteFingerprint(entry.siteFingerprint) &&
    canonical(entry.siteFingerprint) === canonical(site)
  );
  ensure(
    matches.length === 1,
    "The exact native reference site is missing or ambiguous",
    "TARGET_MODIFIED",
  );
  const source = sources[site.unit];
  ensure(
    typeof source === "string",
    "Reference site is outside the source snapshot",
    "TARGET_MODIFIED",
  );
  const lines = source.split(/\r\n|\r|\n/);
  const breaks = [...source.matchAll(/\r\n|\r|\n/g)].map((match) => match[0]);
  const offset = (line: number, col: number) => {
    ensure(
      line <= lines.length && col <= lines[line - 1]!.length + 1,
      "Reference-site position is outside the source",
    );
    let index = 0;
    for (let i = 0; i < line - 1; i++) {
      index += lines[i]!.length + breaks[i]!.length;
    }
    return index + col - 1;
  };
  const start = offset(site.line, site.col),
    end = offset(site.endLine, site.endCol);
  ensure(
    end > start && source.slice(start, end) === site.preimage,
    "Reference-site preimage differs from the source",
    "TARGET_MODIFIED",
  );
  const startByte = encoder.encode(source.slice(0, start)).length;
  const endByte = encoder.encode(source.slice(0, end)).length;
  const seen = new Set<string>();
  let current = session.elementById?.(site.ownerId);
  while (current) {
    const id = session.elementId(current);
    if (seen.has(id) || seen.size >= 128) {
      free([current]);
      throw new SysmlToolkitError(
        "Reference-site owner chain is cyclic or too deep",
      );
    }
    seen.add(id);
    let parent: ToolkitElement | undefined;
    try {
      if (!session.isLibraryElement(current)) {
        const raw = session.memberExtent(current);
        if (raw) {
          const extent = json(raw, "reference-site owner extent");
          if (
            object(extent) && Number.isSafeInteger(extent.unit) &&
            Number.isSafeInteger(extent.start) &&
            Number.isSafeInteger(extent.end)
          ) {
            const unit = readUnits(session).find((entry) =>
              entry.unit === extent.unit
            );
            if (
              unit?.name === site.unit && unit.text === source &&
              Number(extent.start) <= startByte && Number(extent.end) >= endByte
            ) {
              const text = decoder.decode(
                encoder.encode(source).slice(
                  Number(extent.start),
                  Number(extent.end),
                ),
              );
              const target = {
                qualifiedName: `@${id}`,
                metaclass: session.metaclass(current),
                source: { path: site.unit, text },
              };
              return describeTarget(session, sources, target);
            }
          }
        }
      }
      parent = session.owner(current);
    } finally {
      free([current]);
    }
    current = parent;
  }
  throw new SysmlToolkitError(
    "No writable containing owner for the exact native reference site",
  );
}

function sdkOperations(edits: readonly ResolvedModelEdit[]): JsonObject[] {
  ensure(
    Array.isArray(edits) && edits.length > 0 && edits.length <= 32,
    "Expected 1–32 targeted edits",
  );
  return edits.map((edit) => {
    ensure(
      edit !== null && typeof edit === "object" && !Array.isArray(edit),
      "Invalid targeted edit",
    );
    switch (edit.kind) {
      case "set-value":
        fields(
          edit as unknown as JsonObject,
          ["kind", "target", "expression"],
          "set-value edit",
        );
        return {
          op: "setFeatureValue",
          target: targetSpelling(edit.target),
          expr: text(edit.expression, "feature value expression"),
        };
      case "rename":
        fields(
          edit as unknown as JsonObject,
          ["kind", "target", "name"],
          "rename edit",
        );
        return {
          op: "rename",
          target: targetSpelling(edit.target),
          newName: text(edit.name, "new declared name", 4096),
        };
      case "insert-member":
        fields(
          edit as unknown as JsonObject,
          ["kind", "target", "text"],
          "insert-member edit",
        );
        return {
          op: "insertMember",
          owner: targetSpelling(edit.target),
          text: text(edit.text, "inserted member"),
        };
      case "replace-member":
        fields(
          edit as unknown as JsonObject,
          ["kind", "target", "text"],
          "host replacement",
        );
        return {
          op: "replaceMember",
          target: targetSpelling(edit.target),
          text: text(edit.text, "replacement declaration"),
        };
      case "set-type":
        fields(
          edit as unknown as JsonObject,
          ["kind", "target", "type"],
          "host type change",
        );
        return {
          op: "setFeatureType",
          target: targetSpelling(edit.target),
          type: text(edit.type, "feature type", 4096),
        };
      case "retarget-reference":
        fields(edit as unknown as JsonObject, [
          "kind",
          "fromId",
          "toId",
          "site",
        ], "reference-site edit");
        ensure(
          isNativeReferenceId(edit.fromId) && isNativeReferenceId(edit.toId) &&
            isReferenceSiteFingerprint(edit.site),
          "Invalid reference-site edit",
        );
        return {
          op: "retargetReference",
          fromId: edit.fromId,
          toId: edit.toId,
          site: edit.site,
        };
      case "remove":
        fields(
          edit as unknown as JsonObject,
          ["kind", "target"],
          "remove edit",
        );
        return { op: "remove", target: targetSpelling(edit.target) };
      default:
        throw new SysmlToolkitError("Unsupported targeted edit kind");
    }
  });
}

function readReport(
  input: string,
  sources: Sources,
  preview: boolean,
): EditReport {
  const result = json(input, "edit report");
  ensure(object(result), "Invalid toolkit edit report");
  if (preview && result.wouldCommit !== true) {
    throw new SysmlToolkitError(
      `Toolkit edit preview refused: ${
        String(result.refusal ?? "unknown refusal")
      }`,
      [],
      "TOOLKIT_REFUSED",
    );
  }
  ensure(
    Array.isArray(result.findings) && result.findings.length === 0,
    "Toolkit edit has dropped operations or partial findings",
  );
  ensure(
    Array.isArray(result.splices) && result.splices.length > 0,
    "Toolkit edit produced no source changes",
  );
  const splices = result.splices.map((entry) => {
    ensure(
      object(entry) && typeof entry.unit === "string" &&
        Object.hasOwn(sources, entry.unit) &&
        Number.isSafeInteger(entry.start) &&
        Number.isSafeInteger(entry.end) && Number(entry.start) >= 0 &&
        Number(entry.end) >= Number(entry.start) &&
        Number(entry.end) <= encoder.encode(sources[entry.unit]).length &&
        typeof entry.text === "string" && !entry.text.includes("\0"),
      "Invalid toolkit edit splice",
    );
    return {
      unit: entry.unit,
      start: Number(entry.start),
      end: Number(entry.end),
      text: entry.text,
    };
  });
  ensure(Array.isArray(result.idMap), "Invalid toolkit identity mapping");
  const idMap = result.idMap.map((entry) => {
    ensure(
      Array.isArray(entry) && entry.length === 2 &&
        entry.every((id) => typeof id === "string" && id.length > 0),
      "Invalid toolkit identity mapping entry",
    );
    return [entry[0], entry[1]] as [string, string];
  });
  return { findings: [], splices, idMap };
}

/** Verify that returned source trees are exactly the reviewed byte splices. */
function replay(sources: Sources, splices: Splice[]): Sources {
  const result = { ...sources };
  for (const path of new Set(splices.map((entry) => entry.unit))) {
    const edits = splices.filter((entry) => entry.unit === path).sort((a, b) =>
      a.start - b.start || a.end - b.end
    );
    for (let index = 1; index < edits.length; index++) {
      ensure(
        edits[index].start >= edits[index - 1].end &&
          edits[index].start !== edits[index - 1].start,
        "Ambiguous or overlapping toolkit source splices",
      );
    }
    let bytes = encoder.encode(result[path]);
    for (const edit of edits.toReversed()) {
      const inserted = encoder.encode(edit.text);
      const next = new Uint8Array(
        edit.start + inserted.length + bytes.length - edit.end,
      );
      next.set(bytes.subarray(0, edit.start));
      next.set(inserted, edit.start);
      next.set(bytes.subarray(edit.end), edit.start + inserted.length);
      bytes = next;
    }
    result[path] = decoder.decode(bytes);
  }
  return validateSources(result);
}

export class SysmlToolkitAdapter implements ModelToolingPort {
  constructor(readonly options: SysmlToolkitAdapterOptions) {
    validateToolkitTimeout(options.timeoutMs ?? SYSML_TOOLKIT_TIMEOUT_MS);
  }

  compile(sources: Sources) {
    return new ToolkitCompiler(this.options).compile(sources);
  }

  async #worker<T>(request: ToolkitWorkerOperation): Promise<T> {
    try {
      return await runSysmlToolkitWorker<T>(
        this.options.packageDir,
        request,
        this.options.timeoutMs,
      );
    } catch (error) {
      if (error instanceof SysmlToolkitWorkerError) {
        throw new SysmlToolkitError(
          error.message,
          error.diagnostics,
          error.code,
        );
      }
      throw error;
    }
  }

  async #runtime(): Promise<ToolkitRuntime> {
    return await (this.options.loadRuntime?.() ??
      loadSysmlToolkit(this.options.packageDir));
  }

  async #session<T>(
    input: Sources,
    operation: (
      session: ToolkitSession,
      sources: Sources,
      runtime: ToolkitRuntime,
    ) => T | Promise<T>,
  ): Promise<T> {
    const sources = validateSources(structuredClone(input));
    const runtime = await this.#runtime();
    const encoded = JSON.stringify(
      Object.entries(sources).sort(([a], [b]) => compareCodeUnits(a, b))
        .map(([name, text]) => ({ name, text })),
    );
    let session: ToolkitSession | undefined;
    try {
      requireClean(diagnostics(runtime.checkSyntax(encoded)), sources);
      session = runtime.createSession(encoded);
      ensure(
        equalTree(sources, sourceTree(session, sources)),
        "Toolkit session did not retain exact source bytes",
      );
      requireClean(diagnostics(session.check()), sources);
      return await operation(session, sources, runtime);
    } catch (error) {
      if (isNativeToolkitPanic(error)) {
        runtime.invalidate?.(error);
        throw new SysmlToolkitError(
          "sysml-toolkit native runtime failed; discard this runtime",
        );
      }
      throw error;
    } finally {
      try {
        session?.free();
      } catch (error) {
        // Preserve the operation's result/error, but never reuse a runtime
        // whose session disposal trapped.
        if (isNativeToolkitPanic(error)) {
          runtime.invalidate?.(error);
        }
      }
    }
  }

  async check(input: Sources): Promise<ModelToolingDiagnostic[]> {
    const sources = validateSources(structuredClone(input));
    if (!this.options.loadRuntime) {
      return await this.#worker({ operation: "check", sources });
    }
    const runtime = await this.#runtime();
    const encoded = JSON.stringify(
      Object.entries(sources).map(([name, text]) => ({ name, text })),
    );
    let session: ToolkitSession | undefined;
    try {
      const syntax = diagnostics(runtime.checkSyntax(encoded));
      if (blocking(syntax, sources).length) return syntax;
      session = runtime.createSession(encoded);
      ensure(
        equalTree(sources, sourceTree(session, sources)),
        "Toolkit session did not retain exact source bytes",
      );
      return [...syntax, ...diagnostics(session.check())];
    } catch (error) {
      if (isNativeToolkitPanic(error)) {
        runtime.invalidate?.(error);
        throw new SysmlToolkitError(
          "sysml-toolkit native runtime failed; discard this runtime",
        );
      }
      throw error;
    } finally {
      try {
        session?.free();
      } catch (error) {
        if (isNativeToolkitPanic(error)) {
          runtime.invalidate?.(error);
        }
      }
    }
  }

  async query(sources: Sources, expression: string): Promise<unknown> {
    text(expression, "model query expression", 16384);
    if (!this.options.loadRuntime) {
      return await this.#worker({
        operation: "query",
        sources: validateSources(structuredClone(sources)),
        expression,
      });
    }
    return await this.#session(
      sources,
      (session) => json(session.query(expression), "query result"),
    );
  }

  async board(
    input: Sources,
    options: { mode?: "ase" | "generic"; model?: string } = {},
  ): Promise<ModelBoard> {
    const sources = validateSources(structuredClone(input));
    const selection = structuredClone(options);
    if (!this.options.loadRuntime) {
      return await this.#worker({
        operation: "board",
        sources,
        options: selection,
      });
    }
    return await this.#session(
      sources,
      (session, snapshot, runtime) =>
        projectToolkitBoard(session, snapshot, {
          ...selection,
          toolkitVersion: runtime.version,
        }),
    );
  }

  async tokens(path: string, text: string): Promise<SourceTokens> {
    if (new TextEncoder().encode(text).length > MAX_TOKEN_SOURCE_BYTES) {
      throw new SysmlToolkitError(
        "Source exceeds the syntax token size limit",
        [],
        "INVALID_TOKEN_SOURCE_SIZE",
      );
    }
    if (!this.options.loadRuntime) {
      return await this.#worker({ operation: "tokens", path, text });
    }
    return toolkitSourceTokens(await this.#runtime(), path, text);
  }

  async views(input: Sources): Promise<ModelViewList> {
    const sources = validateSources(structuredClone(input));
    if (!this.options.loadRuntime) {
      return await this.#worker({ operation: "views", sources });
    }
    const projected = await this.#session(
      sources,
      (session, _snapshot, runtime) => {
        const { summaries, diagnostics } = projectToolkitViewList(session);
        return { toolkit: runtime.version, views: summaries, diagnostics };
      },
    );
    return {
      ...projected,
      digest: await sha256(canonical(projected)),
    };
  }

  async diagram(
    input: Sources,
    view: ModelViewSummary,
  ): Promise<ModelView> {
    const sources = validateSources(structuredClone(input));
    const summary = structuredClone(view);
    if (!this.options.loadRuntime) {
      return await this.#worker({
        operation: "diagram",
        sources,
        view: summary,
      });
    }
    return await this.#session(sources, (session) => ({
      ...summary,
      diagram: projectToolkitViewDiagram(session, summary),
    }));
  }

  async plantuml(input: Sources, view: ModelViewSummary): Promise<string> {
    const sources = validateSources(structuredClone(input));
    const summary = structuredClone(view);
    if (!this.options.loadRuntime) {
      return await this.#worker({
        operation: "plantuml",
        sources,
        view: summary,
      });
    }
    return await this.#session(
      sources,
      (session) => projectToolkitViewPlantuml(session, summary),
    );
  }

  async snapshot(sources: Sources) {
    const compiled = await new ToolkitCompiler(this.options).compile(sources);
    return { ...compiled, version: `host:${compiled.sourceDigest}` };
  }

  async describe(
    sources: Sources,
    target: ModelToolingTarget,
  ): Promise<ModelToolingDescription> {
    if (!this.options.loadRuntime) {
      return await this.#worker({
        operation: "describe",
        sources: validateSources(structuredClone(sources)),
        target: structuredClone(target),
      });
    }
    return await this.#session(
      sources,
      (session, snapshot) => describeTarget(session, snapshot, target),
    );
  }

  async referenceSites(
    sources: Sources,
    fromId: string,
  ): Promise<ReferenceSiteFingerprint[]> {
    ensure(
      isNativeReferenceId(fromId),
      "An exact native reference target is required",
    );
    if (!this.options.loadRuntime) {
      return await this.#worker({
        operation: "reference-sites",
        sources,
        fromId,
      });
    }
    return await this.#session(sources, (session, snapshot) => {
      const response = session.references(
        JSON.stringify({ elementId: fromId }),
      );
      ensure(
        new TextEncoder().encode(response).length <= 262144,
        "Native reference sites exceed the response limit",
        "REFERENCE_SITES_TOO_LARGE",
      );
      const result = json(response, "native reference sites");
      ensure(
        object(result) &&
          result.referenceSiteFormat === "assembly-native-reference-site/v1" &&
          Array.isArray(result.references),
        "Invalid or unsupported native reference-site result",
        "REFERENCE_SITES_UNAVAILABLE",
      );
      ensure(
        Number.isSafeInteger(result.referenceSitesOmitted) &&
          result.referenceSitesOmitted === 0,
        "Native reference-site inventory is incomplete",
        "REFERENCE_SITES_INCOMPLETE",
      );
      ensure(
        result.references.length <= 50,
        "Native reference sites exceed the page limit",
        "REFERENCE_SITES_TOO_LARGE",
      );
      const sites: ReferenceSiteFingerprint[] = [];
      for (const reference of result.references) {
        ensure(
          object(reference) && Object.hasOwn(reference, "siteFingerprint"),
          "Native reference-site fingerprints are unavailable",
          "REFERENCE_SITES_UNAVAILABLE",
        );
        ensure(
          reference.siteFingerprint !== null,
          "A native reference site is not editable",
          "REFERENCE_SITES_INCOMPLETE",
        );
        ensure(
          isReferenceSiteFingerprint(reference.siteFingerprint),
          "Invalid native reference-site fingerprint",
          "REFERENCE_SITES_UNAVAILABLE",
        );
        ensure(
          Object.hasOwn(snapshot, reference.siteFingerprint.unit),
          "Native site is outside the source snapshot",
          "REFERENCE_SITES_UNAVAILABLE",
        );
        sites.push(structuredClone(reference.siteFingerprint));
      }
      return sites;
    });
  }

  async edit(
    sources: Sources,
    edits: readonly ResolvedModelEdit[],
  ): Promise<ModelToolingEditResult> {
    const requested = structuredClone(edits);
    ensure(
      Array.isArray(requested) && requested.length > 0 &&
        requested.length <= 32,
      "Expected 1–32 targeted edits",
    );
    // The Toolkit only checks that inserted text parses, so text that closes
    // its owner would land beside it. Refuse it before any session opens.
    for (const edit of requested) {
      ensure(
        edit !== null && typeof edit === "object",
        "Invalid targeted edit",
      );
      if (edit.kind === "retarget-reference") continue;
      ensure(
        !edit.target?.qualifiedName?.startsWith("@") || edit.kind === "remove",
        "Anonymous targets are only supported for removal",
        "INVALID_TARGET_KIND",
      );
      if (
        (edit?.kind === "insert-member" || edit?.kind === "replace-member") &&
        typeof edit.text === "string" &&
        !isWholeMemberText(edit.text)
      ) {
        throw new SysmlToolkitError(
          edit.kind === "insert-member"
            ? "Inserted text must be whole members: its braces, comments, strings and quoted names must close inside it."
            : "Replaced text must be whole members: its braces, comments, strings and quoted names must close inside it.",
          [],
          edit.kind === "insert-member"
            ? "INSERT_TEXT_UNBALANCED"
            : "REPLACE_TEXT_UNBALANCED",
        );
      }
    }
    if (!this.options.loadRuntime) {
      return await this.#worker({
        operation: "edit",
        sources: validateSources(structuredClone(sources)),
        edits: requested,
      });
    }
    return await this.#session(sources, (session, snapshot, runtime) => {
      const targets = requested.map((edit) => {
        if (edit.kind === "retarget-reference") {
          return describeReferenceSite(session, snapshot, edit);
        }
        ensure(
          edit !== null && typeof edit === "object" && !Array.isArray(edit) &&
            edit.target !== null && typeof edit.target === "object",
          "Missing targeted edit identity",
        );
        return describeTarget(session, snapshot, edit.target);
      });
      const operations = JSON.stringify(sdkOperations(requested));
      const preview = readReport(session.checkEdit(operations), snapshot, true);
      ensure(
        equalTree(snapshot, sourceTree(session, snapshot)),
        "Toolkit edit preview changed its source snapshot",
      );
      const expected = replay(snapshot, preview.splices);
      const committed = readReport(session.edit(operations), snapshot, false);
      ensure(
        JSON.stringify(preview.splices) === JSON.stringify(committed.splices),
        "Toolkit edit differs from its reviewed preview",
      );
      const updated = sourceTree(session, snapshot);
      ensure(
        equalTree(expected, updated),
        "Toolkit edit changed source bytes outside its reviewed splices",
      );
      const finalSyntax = diagnostics(runtime.checkSyntax(JSON.stringify(
        Object.entries(updated).map(([name, text]) => ({ name, text })),
      )));
      const findings = [...finalSyntax, ...diagnostics(session.check())];
      requireClean(findings, updated);
      return {
        sources: updated,
        targets,
        splices: committed.splices,
        idMap: committed.idMap,
        diagnostics: findings,
        provider: { name: "sysml-toolkit", version: runtime.version },
      };
    });
  }
}
