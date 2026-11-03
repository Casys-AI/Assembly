import { errorMessage } from "../../../../domain/primitives/error-message.ts";
/** Structural N-API addon contract, structured errors and direct .node loading.
 *
 * This module is the only place that names the addon's JS surface
 * (native/toolkit/API-CONTRACT.md). It never imports the napi-generated
 * index.js: that loader carries a WASI fallback, and the active product is
 * native-only. Loading is a direct require of the single pinned .node file
 * whose bytes the bundle reader just verified.
 */
import { createRequire } from "node:module";

/** One source unit crossing the boundary, as typed objects. */
export interface NativeSourceText {
  name: string;
  text: string;
}

/** Ephemeral element designation from the addon. Internal to adapters only:
 * never persisted, never sent to the browser. `nativeId` is the interchange
 * `@id`; session and generation must also match before any use. */
export interface ElementRefSnapshot {
  sessionId: string;
  generation: number;
  nativeId: string;
}

/** Adapter-controlled session reference: the addon snapshot plus the epoch of
 * the runtime/process instance that produced it. Still adapter-ephemeral. */
export interface NativeSessionRef extends ElementRefSnapshot {
  processEpoch: string;
}

export interface NativeResourceCounts {
  librariesAlive: number;
  sessionsAlive: number;
  librariesCreated: number;
  librariesDisposed: number;
  sessionsCreated: number;
  sessionsDisposed: number;
  preparedGraphsAlive: number;
  preparedRetains: number;
  lspServersAlive: number;
  lspServersCreated: number;
  lspServersDisposed: number;
}

export interface NativeToolkitLibrary {
  readonly libraryId: string;
  readonly isClosed: boolean;
  preparedRetains(): number;
  createSession(sources: NativeSourceText[]): NativeToolkitSession;
  createSessionFromInterchangeJson(interchange: string): NativeToolkitSession;
  close(): void;
  dispose(): void;
}

/** Synchronous addon session. JSON-text methods mirror the historical wrapper
 * payloads field for field; element designations are snapshots. */
export interface NativeToolkitSession {
  readonly sessionId: string;
  readonly generation: number;
  readonly isClosed: boolean;
  close(): void;
  dispose(): void;
  resolve(qualifiedName: string): ElementRefSnapshot | null;
  checkJson(): string;
  toFullJson(recoverRefs: boolean): string;
  query(expression: string): string;
  elementById(nativeId: string): ElementRefSnapshot | null;
  property(reference: ElementRefSnapshot, name: string): string;
  derived(reference: ElementRefSnapshot, name: string): string;
  derivedElements(
    reference: ElementRefSnapshot,
    name: string,
  ): ElementRefSnapshot[];
  valueSource(reference: ElementRefSnapshot): string | null;
  valueIsDefault?(reference: ElementRefSnapshot): boolean | null;
  redefinitionRoot(reference: ElementRefSnapshot): ElementRefSnapshot;
  outline(options?: string | null): string;
  toGraph(options?: string | null): string;
  toPlantuml(options?: string | null): string;
  viewInfo(qualifiedName: string): string;
  name(reference: ElementRefSnapshot): string | null;
  shortName?(reference: ElementRefSnapshot): string | null;
  members(reference: ElementRefSnapshot): ElementRefSnapshot[];
  features?(reference: ElementRefSnapshot): ElementRefSnapshot[];
  evaluate(reference: ElementRefSnapshot): string;
  elementsOfMetaclass(metaclass: string): ElementRefSnapshot[];
  docs(reference: ElementRefSnapshot): string[];
  conforms(
    reference: ElementRefSnapshot,
    ancestor: ElementRefSnapshot,
  ): boolean;
  declarationSite(reference: ElementRefSnapshot): string | null;
  elementId(reference: ElementRefSnapshot): string;
  qualifiedName(reference: ElementRefSnapshot): string | null;
  referenceSpelling(reference: ElementRefSnapshot): string | null;
  metaclass(reference: ElementRefSnapshot): string;
  isLibraryElement(reference: ElementRefSnapshot): boolean;
  owner(reference: ElementRefSnapshot): ElementRefSnapshot | null;
  typings(reference: ElementRefSnapshot): ElementRefSnapshot[];
  rows(idsJson: string, fieldsJson: string): string;
  memberSource(target: string): string;
  memberExtent(reference: ElementRefSnapshot): string | null;
  references(selectorJson: string): string;
  roots?(): ElementRefSnapshot[];
  unitsJson(): string;
  checkEdit(operationsJson: string): string;
  edit(operationsJson: string): string;
  exportCompactText?(): string;
}

export interface NativeLspServerInstance {
  readonly serverId: string;
  readonly isClosed: boolean;
  handle(message: string): string[];
  close(): void;
  dispose(): void;
}

export interface NativeAddonModule {
  toolkitVersion(): string;
  addonVersion(): string;
  checkSyntax(sourcesJson: string): string;
  nativeResourceCounts(): NativeResourceCounts;
  ToolkitLibrary: {
    new (
      sources: NativeSourceText[],
      recording?: Uint8Array | null,
    ): NativeToolkitLibrary;
    fromPreparedSnapshot(
      sources: NativeSourceText[],
      snapshot: Uint8Array,
      recording?: Uint8Array | null,
      keepHostParts?: boolean | null,
    ): NativeToolkitLibrary;
  };
  ToolkitSession: {
    new (sources: NativeSourceText[]): NativeToolkitSession;
  };
  NativeLspServer: {
    new (): NativeLspServerInstance;
    withLibrarySources(
      sources: NativeSourceText[],
      snapshot?: Uint8Array | null,
    ): NativeLspServerInstance;
    withPreparedLibrary(
      library: NativeToolkitLibrary,
    ): NativeLspServerInstance;
  };
}

interface NativeErrorOptions {
  context?: Record<string, unknown>;
  recovery?: string;
  cause?: unknown;
}

/** A refused native call with its stable addon code preserved. */
export class NativeToolkitError extends Error {
  readonly code: string;
  readonly context?: Record<string, unknown>;
  readonly recovery?: string;
  constructor(code: string, message: string, options: NativeErrorOptions = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "NativeToolkitError";
    this.code = code;
    if (options.context) this.context = options.context;
    if (options.recovery) this.recovery = options.recovery;
  }
}

/** A Rust panic crossed the N-API boundary. The owning session/runtime (and
 * its process) must be discarded and recreated; nothing is retried in place. */
export class NativeToolkitPanicError extends NativeToolkitError {
  constructor(message: string, options: NativeErrorOptions = {}) {
    super("NATIVE_TOOLKIT_PANIC", message, {
      recovery: "Discard this toolkit runtime/process and recreate it.",
      ...options,
    });
    this.name = "NativeToolkitPanic";
  }
}
/** Short alias matching the structured-error vocabulary of the task. */
export const NativeToolkitPanic = NativeToolkitPanicError;

/** The pinned .node file could not be loaded at all. */
export class NativeToolkitUnavailableError extends NativeToolkitError {
  constructor(message: string, options: NativeErrorOptions = {}) {
    super("TOOLKIT_NATIVE_UNAVAILABLE", message, {
      recovery:
        "Install the pinned native toolkit package (deno task model:toolkit:setup) and verify the platform addon.",
      ...options,
    });
    this.name = "NativeToolkitUnavailableError";
  }
}

/** The loaded addon does not expose a capability the facade requires. */
export class NativeToolkitCapabilityError extends NativeToolkitError {
  constructor(missing: readonly string[], origin: string) {
    super(
      "TOOLKIT_CAPABILITY_MISSING",
      `Native toolkit addon is missing required capabilities: ${
        missing.join(", ")
      }`,
      {
        context: { missing: [...missing], origin },
        recovery:
          "Rebuild the pinned native toolkit addon; no fallback is available.",
      },
    );
    this.name = "NativeToolkitCapabilityError";
  }
}

const NATIVE_CODE = /^([A-Z][A-Z0-9_]+):\s?/;

/** Stable code prefixing an addon error message, when present. */
export function nativeErrorCode(error: unknown): string | null {
  if (error instanceof NativeToolkitError) return error.code;
  const message = errorMessage(error);
  const match = NATIVE_CODE.exec(message);
  return match ? match[1] : null;
}

const PANIC_CODES = new Set([
  "NATIVE_PANIC",
  "SESSION_POISONED",
  "LSP_POISONED",
]);

/** True when the failure poisoned native state and forces recreation. */
export function isNativeToolkitPanic(error: unknown): boolean {
  if (error instanceof NativeToolkitPanicError) return true;
  const code = nativeErrorCode(error);
  return code !== null &&
    (PANIC_CODES.has(code) || code === "NATIVE_TOOLKIT_PANIC");
}

/** Convert a raw addon throw into the structured facade errors. Already
 * structured errors pass through unchanged. */
export function mapNativeError(error: unknown): Error {
  if (error instanceof NativeToolkitError) return error;
  const message = errorMessage(error);
  const code = nativeErrorCode(error);
  if (code !== null && PANIC_CODES.has(code)) {
    return new NativeToolkitPanicError(message, {
      cause: error,
      context: { nativeCode: code },
    });
  }
  if (code !== null) {
    return new NativeToolkitError(code, message, { cause: error });
  }
  return error instanceof Error ? error : new Error(message);
}

let epochCounter = 0;
/** Fresh epoch for one loaded runtime (or one spawned process). */
export function createProcessEpoch(): string {
  epochCounter += 1;
  return `tk-${Deno.pid}-${epochCounter}-${crypto.randomUUID()}`;
}

/** Parse the `[{name, text}]` JSON the historical runtime API carries. */
export function parseSourcesJson(input: string): NativeSourceText[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new NativeToolkitError(
      "INVALID_INPUT",
      `sources must be [{name, text}] JSON: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new NativeToolkitError(
      "INVALID_INPUT",
      "sources must be [{name, text}]: expected an array",
    );
  }
  return parsed.map((entry, index) => {
    const record = entry as Record<string, unknown> | null;
    if (
      !record || typeof record !== "object" || Array.isArray(record) ||
      typeof record.name !== "string" || typeof record.text !== "string"
    ) {
      throw new NativeToolkitError(
        "INVALID_INPUT",
        `sources must be [{name, text}]: source ${index} is malformed`,
      );
    }
    if (record.name.length === 0) {
      throw new NativeToolkitError(
        "INVALID_INPUT",
        `sources must be [{name, text}]: source ${index} has an empty name`,
      );
    }
    return { name: record.name, text: record.text };
  });
}

export const REQUIRED_MODULE_EXPORTS = [
  "toolkitVersion",
  "addonVersion",
  "checkSyntax",
  "nativeResourceCounts",
  "ToolkitLibrary",
  "ToolkitSession",
  "NativeLspServer",
] as const;

export const REQUIRED_SESSION_METHODS = [
  "close",
  "resolve",
  "checkJson",
  "toFullJson",
  "query",
  "elementById",
  "property",
  "derived",
  "derivedElements",
  "valueSource",
  "redefinitionRoot",
  "outline",
  "toGraph",
  "toPlantuml",
  "viewInfo",
  "name",
  "members",
  "evaluate",
  "elementsOfMetaclass",
  "docs",
  "conforms",
  "declarationSite",
  "elementId",
  "qualifiedName",
  "referenceSpelling",
  "metaclass",
  "isLibraryElement",
  "owner",
  "typings",
  "rows",
  "memberSource",
  "memberExtent",
  "references",
  "unitsJson",
  "checkEdit",
  "edit",
] as const;

function hasMethod(prototype: unknown, name: string): boolean {
  if (!prototype || typeof prototype !== "object") return false;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
  return typeof descriptor?.value === "function";
}

function hasGetter(prototype: unknown, name: string): boolean {
  if (!prototype || typeof prototype !== "object") return false;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
  return typeof descriptor?.get === "function" || "value" in (descriptor ?? {});
}

/** Verify the full addon contract before any native call. Missing capability
 * is a closed, named failure; the facade never paper over it in TypeScript. */
export function assertAddonCapabilities(
  value: unknown,
  origin: string,
): NativeAddonModule {
  const missing: string[] = [];
  if (!value || typeof value !== "object") {
    throw new NativeToolkitUnavailableError(
      `Native toolkit addon did not load as an object: ${origin}`,
      { context: { origin } },
    );
  }
  const record = value as Record<string, unknown>;
  for (const name of REQUIRED_MODULE_EXPORTS) {
    if (typeof record[name] !== "function") missing.push(name);
  }
  const library = record.ToolkitLibrary as
    | Record<string, unknown>
    | undefined;
  if (typeof library?.fromPreparedSnapshot !== "function") {
    missing.push("ToolkitLibrary.fromPreparedSnapshot");
  }
  const libraryPrototype =
    (record.ToolkitLibrary as { prototype?: unknown } | undefined)
      ?.prototype;
  for (
    const name of [
      "createSession",
      "createSessionFromInterchangeJson",
      "close",
      "preparedRetains",
    ] as const
  ) {
    if (!hasMethod(libraryPrototype, name)) {
      missing.push(`ToolkitLibrary.prototype.${name}`);
    }
  }
  const sessionPrototype =
    (record.ToolkitSession as { prototype?: unknown } | undefined)
      ?.prototype;
  for (const name of REQUIRED_SESSION_METHODS) {
    if (!hasMethod(sessionPrototype, name)) {
      missing.push(`ToolkitSession.prototype.${name}`);
    }
  }
  for (const name of ["sessionId", "generation", "isClosed"] as const) {
    if (!hasGetter(sessionPrototype, name)) {
      missing.push(`ToolkitSession.prototype.${name}`);
    }
  }
  const lsp = record.NativeLspServer as Record<string, unknown> | undefined;
  for (const name of ["withLibrarySources", "withPreparedLibrary"] as const) {
    if (typeof lsp?.[name] !== "function") {
      missing.push(`NativeLspServer.${name}`);
    }
  }
  const lspPrototype =
    (record.NativeLspServer as { prototype?: unknown } | undefined)
      ?.prototype;
  for (const name of ["handle", "close"] as const) {
    if (!hasMethod(lspPrototype, name)) {
      missing.push(`NativeLspServer.prototype.${name}`);
    }
  }
  if (missing.length > 0) {
    throw new NativeToolkitCapabilityError(missing, origin);
  }
  return value as NativeAddonModule;
}

export type AddonRequire = (path: string) => unknown;

/** Load the pinned .node bytes path directly. No generated index.js, no WASI. */
export function loadNativeAddon(
  addonPath: string,
  requireAddon: AddonRequire = createRequire(import.meta.url) as AddonRequire,
): NativeAddonModule {
  let loaded: unknown;
  try {
    loaded = requireAddon(addonPath);
  } catch (error) {
    throw new NativeToolkitUnavailableError(
      `Native toolkit addon could not be loaded: ${addonPath}: ${
        errorMessage(error)
      }`,
      { cause: error, context: { addonPath } },
    );
  }
  return assertAddonCapabilities(loaded, addonPath);
}
