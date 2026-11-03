import { sha256Bytes as sha256 } from "../../../../domain/primitives/sha256-bytes.ts";
/** Local pinned native SDK loader and compatibility facade.
 *
 * The historical ToolkitRuntime/ToolkitSession/ToolkitElement shapes are
 * preserved for the existing projectors, but every call now delegates to the
 * N-API addon. Element handles are local fakes carrying only a controlled
 * NativeSessionRef; no second SysML interpretation lives here. Runtime and
 * library state last only for the hosting process (the bounded child process
 * in production; a direct test process otherwise). There is no WASM path and
 * no fallback: a missing, drifted or incapable native package fails closed.
 */
import { resolve } from "node:path";
import {
  DEFAULT_NATIVE_ADDON_SNAPSHOT_DIRECTORY,
  materializeNativeAddonSnapshot,
  type NativeAddonSnapshot,
  type NativeAddonSnapshotFileSystem,
} from "../../../../infrastructure/native/addon-snapshot.ts";
import { canonical } from "../../../../domain/primitives/canonical-json.ts";

import {
  TOOLKIT_COMMIT,
  TOOLKIT_NAPI_ABI,
  TOOLKIT_NATIVE_PLATFORMS,
  TOOLKIT_PACKAGE_NAME,
  TOOLKIT_RELEASE,
  toolkitAddonPath,
  type ToolkitNativePlatform,
  toolkitNativePlatform,
} from "../../../sysml-toolkit-pin.ts";
import {
  createProcessEpoch,
  type ElementRefSnapshot,
  isNativeToolkitPanic,
  loadNativeAddon,
  mapNativeError,
  type NativeAddonModule,
  type NativeSessionRef,
  NativeToolkitError,
  type NativeToolkitLibrary,
  NativeToolkitPanicError,
  type NativeToolkitSession,
  NativeToolkitUnavailableError,
  parseSourcesJson,
} from "./native-addon.ts";

export const SYSML_TOOLKIT_VERSION = TOOLKIT_RELEASE;

export type { NativeSessionRef };

export interface ToolkitElement {
  free(): void;
}

export interface ToolkitSession {
  free(): void;
  check(): string;
  toFullJson?(recoverRefs: boolean): string;
  toCompactJson?(): string;
  query(expression: string): string;
  resolve(name: string): ToolkitElement | undefined;
  elementById?(id: string): ToolkitElement | undefined;
  property?(element: ToolkitElement, name: string): string;
  derived?(element: ToolkitElement, name: string): string;
  derivedElements?(element: ToolkitElement, name: string): ToolkitElement[];
  valueSource?(element: ToolkitElement): string | undefined;
  valueIsDefault?(element: ToolkitElement): boolean | undefined;
  redefinitionRoot?(element: ToolkitElement): ToolkitElement;
  outline?(options?: string | null): string;
  toGraph?(options?: string | null): string;
  toPlantuml?(options?: string | null): string;
  viewInfo?(qualifiedName: string): string;
  name?(element: ToolkitElement): string | undefined;
  shortName?(element: ToolkitElement): string | undefined;
  members?(element: ToolkitElement): ToolkitElement[];
  features?(element: ToolkitElement): ToolkitElement[];
  evaluate?(element: ToolkitElement): string;
  elementsOfMetaclass?(metaclass: string): ToolkitElement[];
  docs?(element: ToolkitElement): string[];
  conforms?(element: ToolkitElement, ancestor: ToolkitElement): boolean;
  declarationSite?(element: ToolkitElement): string | undefined;
  elementId(element: ToolkitElement): string;
  qualifiedName(element: ToolkitElement): string | undefined;
  referenceSpelling(element: ToolkitElement): string | undefined;
  metaclass(element: ToolkitElement): string;
  isLibraryElement(element: ToolkitElement): boolean;
  owner(element: ToolkitElement): ToolkitElement | undefined;
  typings(element: ToolkitElement): ToolkitElement[];
  rows(ids: string, fields: string): string;
  memberSource(target: string): string;
  memberExtent(element: ToolkitElement): string | undefined;
  references(selector: string): string;
  roots?(): ToolkitElement[];
  units(): string;
  checkEdit(operations: string): string;
  edit(operations: string): string;
}

export interface ToolkitLspServer {
  handle(message: string): string[];
  free(): void;
}

/** Small seam for unit tests; the production implementation loads only local files. */
export interface ToolkitRuntime {
  readonly version: string;
  readonly bundle?: ToolkitBundlePin;
  /** Epoch of this loaded runtime instance; adapter-ephemeral. */
  readonly epoch?: string;
  /** Fingerprint of the bytes used by this loaded runtime, computed on request. */
  provenance?(): Promise<ToolkitBundleProvenance>;
  checkSyntax(sources: string): string;
  createSession(sources: string): ToolkitSession;
  createSessionFromInterchangeJson?(interchange: string): ToolkitSession;
  createLspServer?(): ToolkitLspServer;
  /** A panicked native runtime must never be reused, including by other adapters. */
  invalidate?(error: unknown): void;
  /** Direct SDK owners free their sessions, then close to release the library
   * and its private snapshot. Native code itself unloads at process exit. */
  close?(): Promise<void>;
}

export interface ToolkitBundleProvenance {
  version: string;
  digest: string;
}

/** Host-local pin, never included in the public canonical provenance. */
export interface ToolkitBundlePin extends ToolkitBundleProvenance {
  directory: string;
  /** Declared platform whose addon binary the digest covers. Additive field;
   * older in-process pins without it resolve the host platform. */
  platform?: ToolkitNativePlatform;
}

export class ToolkitBundleDriftError extends Error {
  readonly code = "TOOLKIT_BUNDLE_DRIFT";
  constructor() {
    super("Toolkit bundle differs from its startup pin");
    this.name = "ToolkitBundleDriftError";
  }
}
/** Short alias matching the structured-error vocabulary of the task. */
export const ToolkitBundleDrift = ToolkitBundleDriftError;

export interface ToolkitRuntimeLoadOptions {
  /** Writable owner-only staging root. A new private child directory is always
   * created inside it; installation paths and caller-selected files are unused. */
  snapshotDirectory?: string;
  /** A child process leaves cleanup to its parent after its real exit status. */
  snapshotCleanup?: "runtime" | "process";
}

export class ToolkitNativeSnapshotError extends Error {
  readonly code = "TOOLKIT_NATIVE_SNAPSHOT_UNAVAILABLE";
  readonly recovery = "PROVISION_PRIVATE_NATIVE_SNAPSHOT_DIRECTORY";
  constructor(cause: unknown) {
    super(
      "Cannot materialize the verified native Toolkit snapshot; provision a private snapshotDirectory with read, write and ffi permission",
      { cause },
    );
    this.name = "ToolkitNativeSnapshotError";
  }
}

/** Toolkit aliases preserve the public loader vocabulary over shared infrastructure. */
export const DEFAULT_TOOLKIT_SNAPSHOT_DIRECTORY =
  DEFAULT_NATIVE_ADDON_SNAPSHOT_DIRECTORY;
export type ToolkitSnapshotFileSystem = NativeAddonSnapshotFileSystem;
export async function materializeToolkitNativeSnapshot(
  addonBytes: Uint8Array<ArrayBuffer>,
  digest: string,
  directory = DEFAULT_TOOLKIT_SNAPSHOT_DIRECTORY,
  fs: ToolkitSnapshotFileSystem = Deno,
): Promise<NativeAddonSnapshot> {
  try {
    return await materializeNativeAddonSnapshot(
      addonBytes,
      digest,
      directory,
      fs,
    );
  } catch (error) {
    throw new ToolkitNativeSnapshotError(error);
  }
}

/** Fixed package files covered by the fingerprint, plus the platform addon. */
export const TOOLKIT_BUNDLE_FILES = [
  "package.json",
  "buildinfo.json",
  "LICENSE",
  "LICENSE-EPL-2.0",
  "THIRD-PARTY-NOTICES.md",
  "stdlib/manifest.json",
  "stdlib/sysml-library.json.gz",
  "stdlib/sysml-library.libcache.gz",
  "stdlib/sysml-library.prepared.gz",
] as const;

export function toolkitBundleFilesFor(
  platform: ToolkitNativePlatform,
): string[] {
  return [...TOOLKIT_BUNDLE_FILES, toolkitAddonPath(platform)];
}

interface BundleReader {
  realPath(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
}

function hostPlatform(expected?: ToolkitBundlePin): ToolkitNativePlatform {
  const platform = expected?.platform ??
    toolkitNativePlatform(Deno.build.os, Deno.build.arch);
  if (!platform) {
    throw new NativeToolkitUnavailableError(
      `No native sysml-toolkit addon is declared for ${Deno.build.os}-${Deno.build.arch}`,
      {
        context: {
          os: Deno.build.os,
          arch: Deno.build.arch,
          declared: Object.keys(TOOLKIT_NATIVE_PLATFORMS),
        },
      },
    );
  }
  return platform;
}

/** Verify before loading the addon; consume these exact bytes afterwards. */
export async function readToolkitBundle(
  packageDirectory: string,
  expected?: ToolkitBundlePin,
  reader: BundleReader = Deno,
): Promise<{
  pin: ToolkitBundlePin;
  files: Record<string, Uint8Array<ArrayBuffer>>;
}> {
  expected = expected ? { ...expected } : undefined;
  if (!packageDirectory || /^(?:https?|data):/i.test(packageDirectory)) {
    throw new Error("A local sysml-toolkit package directory is required");
  }
  try {
    const platform = hostPlatform(expected);
    const resolved = await reader.realPath(resolve(packageDirectory));
    if (expected && resolved !== expected.directory) {
      throw new ToolkitBundleDriftError();
    }
    const directory = expected?.directory ?? resolved;
    const files = Object.fromEntries(
      await Promise.all(
        toolkitBundleFilesFor(platform).map(async (name) =>
          [
            name,
            await reader.readFile(`${directory}/${name}`),
          ] as const
        ),
      ),
    );
    const provenance = await toolkitBundleProvenance(
      SYSML_TOOLKIT_VERSION,
      files,
    );
    if (
      expected && (provenance.digest !== expected.digest ||
        provenance.version !== expected.version)
    ) throw new ToolkitBundleDriftError();
    return { pin: { directory, platform, ...provenance }, files };
  } catch (error) {
    // A missing/replaced/unreadable pinned bundle is also a closed failure.
    if (expected) throw new ToolkitBundleDriftError();
    throw error;
  }
}

/** File names participate in the fingerprint; paths on the host do not. */
export async function toolkitBundleProvenance(
  version: string,
  files: Readonly<Record<string, Uint8Array>>,
): Promise<ToolkitBundleProvenance> {
  const hashes = Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(async (
        [name, bytes],
      ) => [name, await sha256(bytes)]),
    ),
  );
  return {
    version,
    digest: await sha256(canonical({ version, files: hashes })),
  };
}

/** Local fake handle: only the controlled NativeSessionRef and a free flag. */
class FacadeElement implements ToolkitElement {
  #freed = false;
  constructor(readonly ref: NativeSessionRef) {}
  free(): void {
    this.#freed = true;
  }
  snapshot(): ElementRefSnapshot {
    if (this.#freed) {
      throw new NativeToolkitError(
        "ELEMENT_RELEASED",
        "Toolkit element handle was already freed",
      );
    }
    return {
      sessionId: this.ref.sessionId,
      generation: this.ref.generation,
      nativeId: this.ref.nativeId,
    };
  }
}

interface RuntimeState {
  broken: boolean;
  poison(error: unknown): void;
}

function assertSnapshot(value: unknown): asserts value is ElementRefSnapshot {
  const record = value as Record<string, unknown> | null;
  if (
    !record || typeof record !== "object" ||
    typeof record.sessionId !== "string" || record.sessionId.length === 0 ||
    !Number.isSafeInteger(record.generation) || Number(record.generation) < 0 ||
    typeof record.nativeId !== "string" || record.nativeId.length === 0
  ) {
    throw new NativeToolkitError(
      "TOOLKIT_INVALID_RESPONSE",
      "Native toolkit returned a malformed element reference",
    );
  }
}

class FacadeSession implements ToolkitSession {
  #freed = false;
  constructor(
    private readonly native: NativeToolkitSession,
    private readonly epoch: string,
    private readonly state: RuntimeState,
  ) {}

  #call<T>(operation: () => T): T {
    if (this.#freed) {
      throw new NativeToolkitError(
        "SESSION_CLOSED",
        "Toolkit session was already freed",
      );
    }
    if (this.state.broken) {
      throw new NativeToolkitPanicError(
        "sysml-toolkit native runtime failed; discard this runtime",
      );
    }
    try {
      return operation();
    } catch (error) {
      const mapped = mapNativeError(error);
      if (isNativeToolkitPanic(mapped)) this.state.poison(mapped);
      throw mapped;
    }
  }

  #element(snapshot: ElementRefSnapshot | null): FacadeElement | undefined {
    if (snapshot === null || snapshot === undefined) return undefined;
    assertSnapshot(snapshot);
    return new FacadeElement({ processEpoch: this.epoch, ...snapshot });
  }

  #elements(snapshots: ElementRefSnapshot[]): FacadeElement[] {
    return snapshots.map((snapshot) => this.#element(snapshot)!);
  }

  #unwrap(element: ToolkitElement): ElementRefSnapshot {
    if (!(element instanceof FacadeElement)) {
      throw new NativeToolkitError(
        "WRONG_SESSION",
        "Toolkit element handle does not belong to a native session facade",
      );
    }
    const snapshot = element.snapshot();
    if (
      element.ref.processEpoch !== this.epoch ||
      snapshot.sessionId !== this.native.sessionId
    ) {
      throw new NativeToolkitError(
        "WRONG_SESSION",
        "Toolkit element handle belongs to another runtime or session",
      );
    }
    if (snapshot.generation !== this.native.generation) {
      throw new NativeToolkitError(
        "STALE_GENERATION",
        "Toolkit element handle is from a stale session generation; re-resolve the element",
      );
    }
    return snapshot;
  }

  free(): void {
    if (this.#freed) return;
    this.#freed = true;
    try {
      this.native.close();
    } catch (error) {
      const mapped = mapNativeError(error);
      if (isNativeToolkitPanic(mapped)) this.state.poison(mapped);
      throw mapped;
    }
  }

  check(): string {
    return this.#call(() => this.native.checkJson());
  }
  toFullJson(recoverRefs: boolean): string {
    return this.#call(() => this.native.toFullJson(recoverRefs));
  }
  toCompactJson(): string {
    return this.#call(() => {
      if (!this.native.exportCompactText) {
        throw new NativeToolkitError(
          "TOOLKIT_CAPABILITY_MISSING",
          "Native toolkit compact interchange API unavailable",
        );
      }
      return this.native.exportCompactText();
    });
  }
  query(expression: string): string {
    return this.#call(() => this.native.query(expression));
  }
  resolve(name: string): ToolkitElement | undefined {
    return this.#call(() => this.#element(this.native.resolve(name)));
  }
  elementById(id: string): ToolkitElement | undefined {
    return this.#call(() => this.#element(this.native.elementById(id)));
  }
  property(element: ToolkitElement, name: string): string {
    const snapshot = this.#unwrap(element);
    return this.#call(() => this.native.property(snapshot, name));
  }
  derived(element: ToolkitElement, name: string): string {
    const snapshot = this.#unwrap(element);
    return this.#call(() => this.native.derived(snapshot, name));
  }
  derivedElements(element: ToolkitElement, name: string): ToolkitElement[] {
    const snapshot = this.#unwrap(element);
    return this.#call(() =>
      this.#elements(this.native.derivedElements(snapshot, name))
    );
  }
  valueSource(element: ToolkitElement): string | undefined {
    const snapshot = this.#unwrap(element);
    return this.#call(() => this.native.valueSource(snapshot) ?? undefined);
  }
  valueIsDefault(element: ToolkitElement): boolean | undefined {
    const snapshot = this.#unwrap(element);
    return this.#call(() =>
      this.native.valueIsDefault?.(snapshot) ?? undefined
    );
  }
  redefinitionRoot(element: ToolkitElement): ToolkitElement {
    const snapshot = this.#unwrap(element);
    return this.#call(() =>
      this.#element(this.native.redefinitionRoot(snapshot))!
    );
  }
  outline(options?: string | null): string {
    return this.#call(() => this.native.outline(options ?? null));
  }
  toGraph(options?: string | null): string {
    return this.#call(() => this.native.toGraph(options ?? null));
  }
  toPlantuml(options?: string | null): string {
    return this.#call(() => this.native.toPlantuml(options ?? null));
  }
  viewInfo(qualifiedName: string): string {
    return this.#call(() => this.native.viewInfo(qualifiedName));
  }
  name(element: ToolkitElement): string | undefined {
    const snapshot = this.#unwrap(element);
    return this.#call(() => this.native.name(snapshot) ?? undefined);
  }
  shortName(element: ToolkitElement): string | undefined {
    const snapshot = this.#unwrap(element);
    return this.#call(() => this.native.shortName?.(snapshot) ?? undefined);
  }
  members(element: ToolkitElement): ToolkitElement[] {
    const snapshot = this.#unwrap(element);
    return this.#call(() => this.#elements(this.native.members(snapshot)));
  }
  features(element: ToolkitElement): ToolkitElement[] {
    const snapshot = this.#unwrap(element);
    return this.#call(() =>
      this.#elements(this.native.features?.(snapshot) ?? [])
    );
  }
  evaluate(element: ToolkitElement): string {
    const snapshot = this.#unwrap(element);
    return this.#call(() => this.native.evaluate(snapshot));
  }
  elementsOfMetaclass(metaclass: string): ToolkitElement[] {
    return this.#call(() =>
      this.#elements(this.native.elementsOfMetaclass(metaclass))
    );
  }
  docs(element: ToolkitElement): string[] {
    const snapshot = this.#unwrap(element);
    return this.#call(() => this.native.docs(snapshot));
  }
  conforms(element: ToolkitElement, ancestor: ToolkitElement): boolean {
    const snapshot = this.#unwrap(element);
    const ancestorSnapshot = this.#unwrap(ancestor);
    return this.#call(() => this.native.conforms(snapshot, ancestorSnapshot));
  }
  declarationSite(element: ToolkitElement): string | undefined {
    const snapshot = this.#unwrap(element);
    return this.#call(() => this.native.declarationSite(snapshot) ?? undefined);
  }
  elementId(element: ToolkitElement): string {
    const snapshot = this.#unwrap(element);
    return this.#call(() => this.native.elementId(snapshot));
  }
  qualifiedName(element: ToolkitElement): string | undefined {
    const snapshot = this.#unwrap(element);
    return this.#call(() => this.native.qualifiedName(snapshot) ?? undefined);
  }
  referenceSpelling(element: ToolkitElement): string | undefined {
    const snapshot = this.#unwrap(element);
    return this.#call(() =>
      this.native.referenceSpelling(snapshot) ?? undefined
    );
  }
  metaclass(element: ToolkitElement): string {
    const snapshot = this.#unwrap(element);
    return this.#call(() => this.native.metaclass(snapshot));
  }
  isLibraryElement(element: ToolkitElement): boolean {
    const snapshot = this.#unwrap(element);
    return this.#call(() => this.native.isLibraryElement(snapshot));
  }
  owner(element: ToolkitElement): ToolkitElement | undefined {
    const snapshot = this.#unwrap(element);
    return this.#call(() => this.#element(this.native.owner(snapshot)));
  }
  typings(element: ToolkitElement): ToolkitElement[] {
    const snapshot = this.#unwrap(element);
    return this.#call(() => this.#elements(this.native.typings(snapshot)));
  }
  rows(ids: string, fields: string): string {
    return this.#call(() => this.native.rows(ids, fields));
  }
  memberSource(target: string): string {
    return this.#call(() => this.native.memberSource(target));
  }
  memberExtent(element: ToolkitElement): string | undefined {
    const snapshot = this.#unwrap(element);
    return this.#call(() => this.native.memberExtent(snapshot) ?? undefined);
  }
  references(selector: string): string {
    return this.#call(() => this.native.references(selector));
  }
  roots(): ToolkitElement[] {
    return this.#call(() => this.#elements(this.native.roots?.() ?? []));
  }
  units(): string {
    return this.#call(() => this.native.unitsJson());
  }
  checkEdit(operations: string): string {
    return this.#call(() => this.native.checkEdit(operations));
  }
  edit(operations: string): string {
    return this.#call(() => this.native.edit(operations));
  }
}

/** Build the compatibility runtime over a loaded addon and prepared library.
 * Exported as the unit-test seam; production goes through loadSysmlToolkit. */
export function createFacadeRuntime(
  addon: NativeAddonModule,
  library: NativeToolkitLibrary,
  pin: ToolkitBundlePin,
): ToolkitRuntime {
  const runtimePin = Object.freeze({ ...pin });
  const epoch = createProcessEpoch();
  let closed = false;
  const state: RuntimeState = {
    broken: false,
    poison() {
      state.broken = true;
    },
  };
  const available = () => {
    if (closed) {
      throw new NativeToolkitError(
        "RUNTIME_CLOSED",
        "Toolkit runtime was closed",
      );
    }
    if (state.broken) {
      throw new NativeToolkitPanicError(
        "sysml-toolkit native runtime failed; discard this runtime",
      );
    }
  };
  const guarded = <T>(operation: () => T): T => {
    available();
    try {
      return operation();
    } catch (error) {
      const mapped = mapNativeError(error);
      if (isNativeToolkitPanic(mapped)) state.poison(mapped);
      throw mapped;
    }
  };
  return {
    version: SYSML_TOOLKIT_VERSION,
    bundle: runtimePin,
    epoch,
    provenance: () =>
      Promise.resolve({
        version: runtimePin.version,
        digest: runtimePin.digest,
      }),
    checkSyntax: (input) => guarded(() => addon.checkSyntax(input)),
    createLspServer: () => {
      const server = guarded(() => new addon.NativeLspServer());
      let freed = false;
      return {
        handle: (message) => {
          if (freed) {
            throw new NativeToolkitError(
              "LSP_CLOSED",
              "Toolkit syntax LSP server was already freed",
            );
          }
          return guarded(() => server.handle(message));
        },
        free: () => {
          if (freed) return;
          freed = true;
          try {
            server.close();
          } catch (error) {
            const mapped = mapNativeError(error);
            if (isNativeToolkitPanic(mapped)) state.poison(mapped);
            throw mapped;
          }
        },
      };
    },
    createSession: (input) => {
      const sources = parseSourcesJson(input);
      const native = guarded(() => library.createSession(sources));
      return new FacadeSession(native, epoch, state);
    },
    createSessionFromInterchangeJson: (input) => {
      const native = guarded(() =>
        library.createSessionFromInterchangeJson(input)
      );
      return new FacadeSession(native, epoch, state);
    },
    invalidate: () => {
      state.broken = true;
    },
    close: () => {
      if (!closed) {
        closed = true;
        library.close();
      }
      return Promise.resolve();
    },
  };
}

async function gunzip(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const input = new Response(data).body!;
  const expanded = new Response(
    input.pipeThrough(new DecompressionStream("gzip")),
  );
  return new Uint8Array(await expanded.arrayBuffer());
}

function parseJsonFile(
  files: Record<string, Uint8Array<ArrayBuffer>>,
  name: string,
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(files[name]));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new NativeToolkitUnavailableError(
      `Native toolkit package file is malformed: ${name}`,
      { cause: error, context: { file: name } },
    );
  }
}

/** Unit seam exercises the same snapshot and load sequence without native code. */
export async function openVerifiedToolkitRuntime(
  bundle: Awaited<ReturnType<typeof readToolkitBundle>>,
  options: ToolkitRuntimeLoadOptions = {},
  deps: {
    fs?: ToolkitSnapshotFileSystem;
    loadAddon?: typeof loadNativeAddon;
  } = {},
): Promise<ToolkitRuntime> {
  options = { ...options };
  const pin = { ...bundle.pin };
  const files = Object.fromEntries(
    Object.entries(bundle.files).map(([name, bytes]) => [name, bytes.slice()]),
  );
  if (
    (await toolkitBundleProvenance(pin.version, files)).digest !== pin.digest
  ) throw new ToolkitBundleDriftError();
  const platform = pin.platform ?? hostPlatform(pin);
  const manifest = parseJsonFile(files, "package.json");
  if (
    manifest.name !== TOOLKIT_PACKAGE_NAME ||
    manifest.version !== SYSML_TOOLKIT_VERSION ||
    manifest.toolkitCommit !== TOOLKIT_COMMIT
  ) {
    throw new NativeToolkitUnavailableError(
      `Expected ${TOOLKIT_PACKAGE_NAME} ${SYSML_TOOLKIT_VERSION} (${TOOLKIT_COMMIT})`,
      { context: { name: manifest.name, version: manifest.version } },
    );
  }
  const build = parseJsonFile(files, "buildinfo.json");
  const expectedTarget = TOOLKIT_NATIVE_PLATFORMS[platform].target;
  if (
    build.toolkitVersion !== SYSML_TOOLKIT_VERSION ||
    build.toolkitCommit !== TOOLKIT_COMMIT ||
    build.target !== expectedTarget ||
    build.abi !== TOOLKIT_NAPI_ABI
  ) {
    throw new NativeToolkitUnavailableError(
      "Native toolkit build identity differs from the pin",
      {
        context: {
          target: build.target,
          expectedTarget,
          abi: build.abi,
          expectedAbi: TOOLKIT_NAPI_ABI,
        },
      },
    );
  }
  // require never reopens the installation. Its only path is our newly created
  // read-only regular file, populated from the buffers covered by the pin.
  const nativeSnapshot = await materializeToolkitNativeSnapshot(
    files[toolkitAddonPath(platform)],
    pin.digest,
    options.snapshotDirectory,
    deps.fs,
  );
  const cleanupOnExit = () => {
    try {
      nativeSnapshot.removeSync?.();
    } catch { /* Runtime close is the deterministic cleanup contract. */ }
  };
  const ownsCleanup = options.snapshotCleanup !== "process";
  if (ownsCleanup && nativeSnapshot.removeSync) {
    globalThis.addEventListener("unload", cleanupOnExit);
  }
  const cleanup = () => {
    if (!ownsCleanup) return Promise.resolve();
    globalThis.removeEventListener("unload", cleanupOnExit);
    return nativeSnapshot.remove();
  };
  let library: NativeToolkitLibrary | undefined;
  try {
    const addon = (deps.loadAddon ?? loadNativeAddon)(nativeSnapshot.path);
    let toolkitVersion: string;
    try {
      toolkitVersion = addon.toolkitVersion();
    } catch (error) {
      throw mapNativeError(error);
    }
    if (toolkitVersion !== SYSML_TOOLKIT_VERSION) {
      throw new NativeToolkitUnavailableError(
        "sysml-toolkit package and native addon versions disagree",
        { context: { toolkitVersion, expected: SYSML_TOOLKIT_VERSION } },
      );
    }
    const [sourcesBytes, recording, snapshot] = await Promise.all([
      gunzip(files["stdlib/sysml-library.json.gz"]),
      gunzip(files["stdlib/sysml-library.libcache.gz"]),
      gunzip(files["stdlib/sysml-library.prepared.gz"]),
    ]);
    const stdlibSources = parseSourcesJson(
      new TextDecoder().decode(sourcesBytes),
    );
    // Immutable for this process lifetime. Sessions retain the prepared graph
    // independently; every operation creates and closes its own session.
    try {
      library = addon.ToolkitLibrary.fromPreparedSnapshot(
        stdlibSources,
        snapshot,
        recording,
      );
    } catch (error) {
      throw mapNativeError(error);
    }
    const runtime = createFacadeRuntime(addon, library, pin);
    let closing: Promise<void> | undefined;
    return {
      ...runtime,
      close: () =>
        closing ??= (async () => {
          try {
            await runtime.close!();
          } finally {
            await cleanup();
          }
        })(),
    };
  } catch (error) {
    try {
      library?.close();
    } finally {
      await cleanup();
    }
    throw error;
  }
}

const loaded = new Map<string, Promise<ToolkitRuntime>>();

export async function loadSysmlToolkit(
  packageDirectory: string,
  expected?: ToolkitBundlePin,
  options: ToolkitRuntimeLoadOptions = {},
): Promise<ToolkitRuntime> {
  options = { ...options };
  const bundle = await readToolkitBundle(packageDirectory, expected);
  const key = JSON.stringify([
    bundle.pin.directory,
    bundle.pin.digest,
    resolve(options.snapshotDirectory ?? DEFAULT_TOOLKIT_SNAPSHOT_DIRECTORY),
    options.snapshotCleanup ?? "runtime",
  ]);
  let pending = loaded.get(key);
  if (!pending) {
    pending = openVerifiedToolkitRuntime(bundle, options).then((runtime) => ({
      ...runtime,
      close: async () => {
        if (loaded.get(key) === pending) loaded.delete(key);
        await runtime.close!();
      },
    }));
    loaded.set(key, pending);
    pending.catch((error) => {
      if (!isNativeToolkitPanic(error)) loaded.delete(key);
    });
  }
  return await pending;
}
