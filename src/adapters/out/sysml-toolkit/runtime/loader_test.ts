import {
  deepEqual,
  equal,
  notEqual,
  rejects,
  throws,
} from "node:assert/strict";
import {
  createFacadeRuntime,
  materializeToolkitNativeSnapshot,
  openVerifiedToolkitRuntime,
  readToolkitBundle,
  TOOLKIT_BUNDLE_FILES,
  toolkitBundleFilesFor,
  toolkitBundleProvenance,
  type ToolkitSnapshotFileSystem,
} from "./loader.ts";
import {
  TOOLKIT_COMMIT,
  TOOLKIT_NAPI_ABI,
  TOOLKIT_NATIVE_PLATFORMS,
  TOOLKIT_PACKAGE_NAME,
  TOOLKIT_RELEASE,
  toolkitAddonPath,
  toolkitNativePlatform,
} from "../../../sysml-toolkit-pin.ts";
import {
  assertAddonCapabilities,
  type ElementRefSnapshot,
  loadNativeAddon,
  type NativeAddonModule,
  NativeToolkitCapabilityError,
  type NativeToolkitLibrary,
  NativeToolkitPanicError,
  type NativeToolkitSession,
  NativeToolkitUnavailableError,
  parseSourcesJson,
} from "./native-addon.ts";

class FakeSnapshotFileSystem implements ToolkitSnapshotFileSystem {
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>();
  readonly modes = new Map<string, number>();
  readonly removed: string[] = [];
  existing = false;
  symlink = false;
  deny = false;
  onCreate?: () => void;
  makeTempDir(options: { dir: string; prefix: string }): Promise<string> {
    this.onCreate?.();
    return this.deny
      ? Promise.reject(new Error("write permission denied"))
      : Promise.resolve(`${options.dir}/${options.prefix}private`);
  }
  chmod(path: string, mode: number): Promise<void> {
    this.modes.set(path, mode);
    return Promise.resolve();
  }
  open(path: string, options: Deno.OpenOptions) {
    equal(options.createNew, true);
    equal(options.mode, 0o600);
    if (this.existing) return Promise.reject(new Error("AlreadyExists"));
    this.files.set(path, new Uint8Array());
    return Promise.resolve({
      write: (bytes: Uint8Array) => {
        // Deliberately short writes exercise the production write loop.
        const part = bytes.slice(0, 2);
        const old = this.files.get(path)!;
        const joined = new Uint8Array(old.length + part.length);
        joined.set(old);
        joined.set(part, old.length);
        this.files.set(path, joined);
        return Promise.resolve(part.length);
      },
      close() {},
    });
  }
  lstat(_path: string) {
    return Promise.resolve({ isFile: !this.symlink, isSymlink: this.symlink });
  }
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>> {
    return Promise.resolve(this.files.get(path)!.slice());
  }
  remove(path: string, _options: { recursive: boolean }): Promise<void> {
    this.removed.push(path);
    for (const entry of this.files.keys()) {
      if (entry.startsWith(`${path}/`)) this.files.delete(entry);
    }
    return Promise.resolve();
  }
}

Deno.test("native snapshot owns verified bytes before awaits and seals a new regular file", async () => {
  const fs = new FakeSnapshotFileSystem();
  const original = new Uint8Array([1, 2, 3, 4, 5]);
  fs.onCreate = () => {
    original.fill(9);
  };
  const snapshot = await materializeToolkitNativeSnapshot(
    original,
    "digest",
    "/private",
    fs,
  );
  deepEqual(await fs.readFile(snapshot.path), new Uint8Array([1, 2, 3, 4, 5]));
  equal(fs.modes.get(snapshot.path), 0o400);
  equal(fs.modes.get(snapshot.path.slice(0, -"/addon.node".length)), 0o700);
  await snapshot.remove();
  await snapshot.remove();
  equal(fs.removed.length, 1);
});

Deno.test("native snapshot refuses existing files, symlinks and read-only materialization", async () => {
  for (const refusal of ["existing", "symlink", "deny"] as const) {
    const fs = new FakeSnapshotFileSystem();
    fs[refusal] = true;
    await rejects(
      () =>
        materializeToolkitNativeSnapshot(
          new Uint8Array([1]),
          "digest",
          "/private",
          fs,
        ),
      (error: unknown) => {
        const detail = error as { code?: string; recovery?: string };
        return detail.code === "TOOLKIT_NATIVE_SNAPSHOT_UNAVAILABLE" &&
          detail.recovery === "PROVISION_PRIVATE_NATIVE_SNAPSHOT_DIRECTORY";
      },
    );
    equal(fs.removed.length, refusal === "deny" ? 0 : 1);
  }
});

async function verifiedFakeBundle() {
  const platform = "darwin-arm64" as const;
  const bytes = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const compressed = async (value: unknown) =>
    new Uint8Array(
      await new Response(
        new Response(bytes(value)).body!.pipeThrough(
          new CompressionStream("gzip"),
        ),
      ).arrayBuffer(),
    );
  const files: Record<string, Uint8Array<ArrayBuffer>> = Object.fromEntries(
    TOOLKIT_BUNDLE_FILES.map((name) => [name, new Uint8Array([1])]),
  );
  files["package.json"] = bytes({
    name: TOOLKIT_PACKAGE_NAME,
    version: TOOLKIT_RELEASE,
    toolkitCommit: TOOLKIT_COMMIT,
  });
  files["buildinfo.json"] = bytes({
    toolkitVersion: TOOLKIT_RELEASE,
    toolkitCommit: TOOLKIT_COMMIT,
    target: TOOLKIT_NATIVE_PLATFORMS[platform].target,
    abi: TOOLKIT_NAPI_ABI,
  });
  files["stdlib/sysml-library.json.gz"] = await compressed([
    { name: "Kernel.sysml", text: "package Kernel;" },
  ]);
  files["stdlib/sysml-library.libcache.gz"] = await compressed({});
  files["stdlib/sysml-library.prepared.gz"] = await compressed({});
  files[toolkitAddonPath(platform)] = new Uint8Array([65, 65, 65]);
  return {
    pin: {
      directory: "/installation",
      platform,
      ...await toolkitBundleProvenance(TOOLKIT_RELEASE, files),
    },
    files,
  };
}

Deno.test("runtime requires the private verified A snapshot when installation becomes B", async () => {
  const bundle = await verifiedFakeBundle();
  const originalDigest = bundle.pin.digest;
  const fs = new FakeSnapshotFileSystem();
  let calls = 0;
  fs.onCreate = () => bundle.files[toolkitAddonPath("darwin-arm64")].fill(66);
  const runtime = await openVerifiedToolkitRuntime(bundle, {
    snapshotDirectory: "/private",
  }, {
    fs,
    loadAddon: (path) => {
      calls++;
      equal(path.startsWith("/private/"), true);
      deepEqual(fs.files.get(path), new Uint8Array([65, 65, 65]));
      equal(fs.modes.get(path), 0o400);
      return completeAddon() as unknown as NativeAddonModule;
    },
  });
  equal(calls, 1);
  equal((await runtime.provenance!()).digest, originalDigest);
  equal(runtime.bundle!.directory, "/installation");
  throws(() => {
    runtime.bundle!.digest = "caller-spoof";
  }, TypeError);
  equal((await runtime.provenance!()).digest, originalDigest);
  await runtime.close!();
  await runtime.close!();
  equal(fs.removed.length, 1);
  throws(() => runtime.checkSyntax("[]"), { code: "RUNTIME_CLOSED" });
});

Deno.test("child runtime leaves private snapshot removal to its parent after exit", async () => {
  const fs = new FakeSnapshotFileSystem();
  const runtime = await openVerifiedToolkitRuntime(await verifiedFakeBundle(), {
    snapshotDirectory: "/private/epoch",
    snapshotCleanup: "process",
  }, { fs, loadAddon: () => completeAddon() as unknown as NativeAddonModule });
  await runtime.close!();
  equal(fs.removed.length, 0);
});

Deno.test("snapshot failure refuses before any require or fallback", async () => {
  const bundle = await verifiedFakeBundle();
  const fs = new FakeSnapshotFileSystem();
  fs.deny = true;
  let loaded = false;
  await rejects(() =>
    openVerifiedToolkitRuntime(bundle, {}, {
      fs,
      loadAddon: () => {
        loaded = true;
        throw new Error("must not execute");
      },
    }), { code: "TOOLKIT_NATIVE_SNAPSHOT_UNAVAILABLE" });
  equal(loaded, false);
});

Deno.test("loaded toolkit fingerprint is canonical and binds file contents, names and version", async () => {
  const manifest = new TextEncoder().encode(
    '{"name":"ase-sysml-toolkit-native"}',
  );
  const addon = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]);
  const first = await toolkitBundleProvenance("0.10.10+ase.2", {
    "package.json": manifest,
    "native/ase-toolkit-napi.darwin-arm64.node": addon,
  });
  equal(first.version, "0.10.10+ase.2");
  equal(
    first.digest,
    (await toolkitBundleProvenance("0.10.10+ase.2", {
      "native/ase-toolkit-napi.darwin-arm64.node": addon,
      "package.json": manifest,
    })).digest,
  );
  notEqual(
    first.digest,
    (await toolkitBundleProvenance("0.10.10+ase.2", {
      "package.json": manifest,
      "native/ase-toolkit-napi.darwin-arm64.node": new Uint8Array([1]),
    })).digest,
  );
  notEqual(
    first.digest,
    (await toolkitBundleProvenance("0.10.11", {
      "package.json": manifest,
      "native/ase-toolkit-napi.darwin-arm64.node": addon,
    })).digest,
  );
});

Deno.test("native platform mapping declares only pinned targets", () => {
  equal(toolkitNativePlatform("darwin", "aarch64"), "darwin-arm64");
  equal(toolkitNativePlatform("darwin", "x86_64"), "darwin-x64");
  equal(toolkitNativePlatform("linux", "x86_64"), "linux-x64-gnu");
  equal(toolkitNativePlatform("linux", "aarch64"), "linux-arm64-gnu");
  equal(toolkitNativePlatform("windows", "x86_64"), undefined);
  equal(
    toolkitAddonPath("darwin-arm64"),
    "native/ase-toolkit-napi.darwin-arm64.node",
  );
  equal(
    toolkitBundleFilesFor("darwin-arm64").length,
    TOOLKIT_BUNDLE_FILES.length + 1,
  );
});

Deno.test("toolkit pin refuses a redirected package link even at the same version", async () => {
  let directory = "/bundles/first";
  const reads: string[] = [];
  const reader = {
    realPath: () => Promise.resolve(directory),
    readFile(path: string) {
      reads.push(path);
      return Promise.resolve(new TextEncoder().encode("same-version-bundle"));
    },
  };
  const startup = await readToolkitBundle(
    "/configured/link",
    undefined,
    reader,
  );
  equal(startup.pin.directory, "/bundles/first");
  equal(
    startup.pin.platform,
    toolkitNativePlatform(Deno.build.os, Deno.build.arch),
  );
  await readToolkitBundle("/configured/link", startup.pin, reader);
  const fileCount = toolkitBundleFilesFor(startup.pin.platform!).length;
  equal(reads.length, 2 * fileCount);
  equal(
    reads.some((path) => path.endsWith(".node")),
    true,
  );
  equal(reads.some((path) => path.includes("wasm")), false);
  directory = "/bundles/second";
  await rejects(
    () => readToolkitBundle("/configured/link", startup.pin, reader),
    { code: "TOOLKIT_BUNDLE_DRIFT" },
  );
  equal(reads.some((path) => path.startsWith("/bundles/second")), false);
});

Deno.test("toolkit pin refuses changed bytes or missing files before loading", async () => {
  let content = "original";
  let missing = false;
  const reader = {
    realPath: () => Promise.resolve("/bundles/first"),
    readFile(path: string) {
      if (missing) return Promise.reject(new Error("missing file"));
      return Promise.resolve(new TextEncoder().encode(
        path.endsWith(".node") ? content : "unchanged",
      ));
    },
  };
  const { pin } = await readToolkitBundle(
    "/configured/link",
    undefined,
    reader,
  );
  content = "modified";
  await rejects(
    () => readToolkitBundle("/configured/link", pin, reader),
    { code: "TOOLKIT_BUNDLE_DRIFT" },
  );
  content = "original";
  missing = true;
  await rejects(
    () => readToolkitBundle("/configured/link", pin, reader),
    { code: "TOOLKIT_BUNDLE_DRIFT" },
  );
});

Deno.test("malformed sources JSON is refused before any native call", () => {
  throws(() => parseSourcesJson("not json"), { code: "INVALID_INPUT" });
  throws(() => parseSourcesJson("{}"), { code: "INVALID_INPUT" });
  throws(() => parseSourcesJson('[{"name":"","text":"x"}]'), {
    code: "INVALID_INPUT",
  });
  throws(() => parseSourcesJson('[{"name":"a.sysml"}]'), {
    code: "INVALID_INPUT",
  });
  equal(
    parseSourcesJson('[{"name":"a.sysml","text":"package A;"}]')[0].name,
    "a.sysml",
  );
});

// ---- Fake addon: capability validation and facade delegation ----

function completeAddon(): Record<string, unknown> {
  class FakeSession {
    get sessionId() {
      return "tk-session-1";
    }
    get generation() {
      return 0;
    }
    get isClosed() {
      return false;
    }
  }
  for (
    const name of [
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
    ]
  ) {
    Object.assign(FakeSession.prototype, { [name]: () => null });
  }
  class FakeLibrary {
    static fromPreparedSnapshot() {
      return new FakeLibrary();
    }
  }
  Object.assign(FakeLibrary.prototype, {
    createSession: () => new FakeSession(),
    createSessionFromInterchangeJson: () => new FakeSession(),
    close: () => undefined,
    preparedRetains: () => 1,
  });
  class FakeLsp {
    static withLibrarySources() {
      return new FakeLsp();
    }
    static withPreparedLibrary() {
      return new FakeLsp();
    }
  }
  Object.assign(FakeLsp.prototype, {
    handle: () => [],
    close: () => undefined,
  });
  return {
    toolkitVersion: () => "0.10.10+ase.2",
    addonVersion: () => "0.1.0",
    checkSyntax: () => "[]",
    nativeResourceCounts: () => ({}),
    ToolkitLibrary: FakeLibrary,
    ToolkitSession: FakeSession,
    NativeLspServer: FakeLsp,
  };
}

Deno.test("capability validation names every missing export and method", () => {
  const complete = assertAddonCapabilities(completeAddon(), "fake.node");
  equal(typeof complete.checkSyntax, "function");
  const incomplete = completeAddon();
  delete incomplete.checkSyntax;
  delete (incomplete.ToolkitSession as { prototype: object }).prototype[
    "rows" as never
  ];
  throws(
    () => assertAddonCapabilities(incomplete, "fake.node"),
    (error: unknown) =>
      error instanceof NativeToolkitCapabilityError &&
      error.code === "TOOLKIT_CAPABILITY_MISSING" &&
      JSON.stringify(error.context?.missing).includes("checkSyntax") &&
      JSON.stringify(error.context?.missing).includes(
        "ToolkitSession.prototype.rows",
      ),
  );
  throws(
    () => assertAddonCapabilities(null, "fake.node"),
    NativeToolkitUnavailableError,
  );
});

Deno.test("addon loading is direct and fails closed when unloadable", () => {
  const seen: string[] = [];
  const addon = loadNativeAddon("/pinned/addon.node", (path) => {
    seen.push(path);
    return completeAddon();
  });
  deepEqual(seen, ["/pinned/addon.node"]);
  equal(addon.toolkitVersion(), "0.10.10+ase.2");
  throws(
    () =>
      loadNativeAddon("/missing/addon.node", () => {
        throw new Error("dlopen failed");
      }),
    (error: unknown) =>
      error instanceof NativeToolkitUnavailableError &&
      error.code === "TOOLKIT_NATIVE_UNAVAILABLE",
  );
});

// ---- Facade over a scripted native session ----

class ScriptedSession implements NativeToolkitSession {
  generation = 0;
  isClosed = false;
  closes = 0;
  panicOn = new Set<string>();
  readonly calls: string[] = [];
  constructor(readonly sessionId: string) {}
  #snap(nativeId: string): ElementRefSnapshot {
    return { sessionId: this.sessionId, generation: this.generation, nativeId };
  }
  #guard(name: string) {
    this.calls.push(name);
    if (this.panicOn.has(name)) throw new Error(`NATIVE_PANIC: fake ${name}`);
  }
  close() {
    this.closes++;
    this.isClosed = true;
  }
  dispose() {
    this.close();
  }
  resolve(name: string) {
    this.#guard("resolve");
    return name === "A::B" ? this.#snap("id-b") : null;
  }
  checkJson() {
    this.#guard("checkJson");
    return '[{"severity":"warning","message":"w"}]';
  }
  toFullJson(recoverRefs: boolean) {
    this.#guard("toFullJson");
    return `full:${recoverRefs}`;
  }
  exportCompactText() {
    return "compact";
  }
  query(expression: string) {
    this.#guard("query");
    return `query:${expression}`;
  }
  elementById(id: string) {
    return id === "id-b" ? this.#snap(id) : null;
  }
  property(_r: ElementRefSnapshot, name: string) {
    return `property:${name}`;
  }
  derived(_r: ElementRefSnapshot, name: string) {
    return `derived:${name}`;
  }
  derivedElements() {
    return [this.#snap("id-c")];
  }
  valueSource() {
    return "42";
  }
  valueIsDefault() {
    return false;
  }
  redefinitionRoot(reference: ElementRefSnapshot) {
    return reference;
  }
  outline(options?: string | null) {
    return `outline:${options ?? ""}`;
  }
  toGraph() {
    return "graph";
  }
  toPlantuml() {
    return "@startuml\n@enduml";
  }
  viewInfo(name: string) {
    return `view:${name}`;
  }
  name() {
    return "B";
  }
  shortName() {
    return null;
  }
  members() {
    return [this.#snap("id-c")];
  }
  features() {
    return [];
  }
  evaluate() {
    return "7";
  }
  elementsOfMetaclass() {
    return [this.#snap("id-b")];
  }
  docs() {
    return ["doc text"];
  }
  conforms() {
    return true;
  }
  declarationSite() {
    return '{"unit":0,"start":1,"end":9}';
  }
  elementId(reference: ElementRefSnapshot) {
    return reference.nativeId;
  }
  qualifiedName() {
    return "A::B";
  }
  referenceSpelling() {
    return "A::B";
  }
  metaclass() {
    return "PartDefinition";
  }
  isLibraryElement() {
    return false;
  }
  owner() {
    return this.#snap("id-a");
  }
  typings() {
    return [this.#snap("id-t")];
  }
  rows(ids: string, fields: string) {
    return `rows:${ids}:${fields}`;
  }
  memberSource(target: string) {
    return `source:${target}`;
  }
  memberExtent() {
    return '{"unit":0,"start":0,"end":20}';
  }
  references(selector: string) {
    return `refs:${selector}`;
  }
  roots() {
    return [this.#snap("id-a")];
  }
  unitsJson() {
    return '[{"unit":0,"name":"a.sysml","text":"package A;"}]';
  }
  checkEdit(operations: string) {
    return `checkEdit:${operations}`;
  }
  edit(operations: string) {
    this.#guard("edit");
    this.generation++;
    return `edit:${operations}`;
  }
}

function scriptedRuntime() {
  const sessions: ScriptedSession[] = [];
  let next = 0;
  const library: NativeToolkitLibrary = {
    libraryId: "tk-library-1",
    isClosed: false,
    preparedRetains: () => 1 + sessions.length,
    createSession: () => {
      const session = new ScriptedSession(`tk-session-${++next}`);
      sessions.push(session);
      return session;
    },
    createSessionFromInterchangeJson: () => {
      const session = new ScriptedSession(`tk-session-${++next}`);
      sessions.push(session);
      return session;
    },
    close: () => undefined,
    dispose: () => undefined,
  };
  const addon = completeAddon() as unknown as NativeAddonModule;
  addon.checkSyntax = () => '[{"severity":"error","message":"syntax"}]';
  const pin = { directory: "/pinned", version: "0.10.10+ase.2", digest: "d" };
  return { runtime: createFacadeRuntime(addon, library, pin), sessions, addon };
}

const SOURCES = JSON.stringify([{ name: "a.sysml", text: "package A;" }]);

Deno.test("facade reproduces every projector capability over the native session", async () => {
  const { runtime } = scriptedRuntime();
  equal(runtime.version, "0.10.10+ase.2");
  equal((await runtime.provenance!()).digest, "d");
  equal(
    runtime.checkSyntax(SOURCES),
    '[{"severity":"error","message":"syntax"}]',
  );
  const session = runtime.createSession(SOURCES);
  equal(session.check(), '[{"severity":"warning","message":"w"}]');
  equal(session.toFullJson!(false), "full:false");
  equal(session.toFullJson!(true), "full:true");
  equal(session.toCompactJson!(), "compact");
  equal(session.query("A::B"), "query:A::B");
  equal(session.rows('["id-b"]', '["name"]'), 'rows:["id-b"]:["name"]');
  equal(session.units(), '[{"unit":0,"name":"a.sysml","text":"package A;"}]');
  equal(session.outline!(), "outline:");
  equal(session.toGraph!("{}"), "graph");
  equal(session.toPlantuml!(), "@startuml\n@enduml");
  equal(session.viewInfo!("A::V"), "view:A::V");
  equal(session.memberSource("A::B"), "source:A::B");
  equal(session.references("A::B"), "refs:A::B");
  equal(session.checkEdit("[]"), "checkEdit:[]");

  const element = session.resolve("A::B")!;
  equal(session.elementId(element), "id-b");
  equal(session.qualifiedName(element), "A::B");
  equal(session.referenceSpelling(element), "A::B");
  equal(session.metaclass(element), "PartDefinition");
  equal(session.isLibraryElement(element), false);
  equal(session.name!(element), "B");
  equal(session.shortName!(element), undefined);
  equal(session.property!(element, "declaredName"), "property:declaredName");
  equal(session.derived!(element, "owner"), "derived:owner");
  equal(session.derivedElements!(element, "ownedMember").length, 1);
  equal(session.valueSource!(element), "42");
  equal(session.valueIsDefault!(element), false);
  equal(session.evaluate!(element), "7");
  deepEqual(session.docs!(element), ["doc text"]);
  equal(session.conforms!(element, element), true);
  equal(session.declarationSite!(element), '{"unit":0,"start":1,"end":9}');
  equal(session.memberExtent(element), '{"unit":0,"start":0,"end":20}');
  equal(session.members!(element).length, 1);
  equal(session.features!(element).length, 0);
  equal(session.elementsOfMetaclass!("PartDefinition").length, 1);
  equal(session.roots!().length, 1);
  const owner = session.owner(element)!;
  equal(session.elementId(owner), "id-a");
  equal(session.typings(element).length, 1);
  equal(session.elementId(session.redefinitionRoot!(element)), "id-b");
  equal(session.elementId(session.elementById!("id-b")!), "id-b");
  equal(session.resolve("A::Missing"), undefined);
  session.free();
});

Deno.test("facade handles refuse freed, foreign and stale uses with coded errors", () => {
  const { runtime } = scriptedRuntime();
  const first = runtime.createSession(SOURCES);
  const second = runtime.createSession(SOURCES);
  const element = first.resolve("A::B")!;
  throws(() => second.elementId(element), { code: "WRONG_SESSION" });
  first.edit("[]");
  throws(() => first.elementId(element), { code: "STALE_GENERATION" });
  const fresh = first.resolve("A::B")!;
  fresh.free();
  throws(() => first.elementId(fresh), { code: "ELEMENT_RELEASED" });
  throws(() => first.elementId({ free() {} }), { code: "WRONG_SESSION" });
  first.free();
  first.free();
  throws(() => first.check(), { code: "SESSION_CLOSED" });
  second.free();
});

Deno.test("a native panic poisons the whole facade runtime", () => {
  const { runtime, sessions } = scriptedRuntime();
  const session = runtime.createSession(SOURCES);
  sessions[0].panicOn.add("checkJson");
  throws(
    () => session.check(),
    (error: unknown) =>
      error instanceof NativeToolkitPanicError &&
      error.code === "NATIVE_TOOLKIT_PANIC",
  );
  throws(() => runtime.createSession(SOURCES), NativeToolkitPanicError);
  throws(() => runtime.checkSyntax(SOURCES), NativeToolkitPanicError);
  throws(() => session.query("x"), NativeToolkitPanicError);
  // Disposal stays possible and idempotent after poisoning.
  session.free();
  session.free();
  equal(sessions[0].closes, 1);
});

Deno.test("invalidate refuses later work without masking disposal", () => {
  const { runtime, sessions } = scriptedRuntime();
  const session = runtime.createSession(SOURCES);
  runtime.invalidate!(new Error("caller decided"));
  throws(() => runtime.createSession(SOURCES), NativeToolkitPanicError);
  session.free();
  equal(sessions[0].closes, 1);
});

Deno.test("facade LSP forwards messages and frees idempotently", () => {
  const { runtime, addon } = scriptedRuntime();
  const handled: string[] = [];
  let closes = 0;
  (addon as unknown as Record<string, unknown>).NativeLspServer = class {
    serverId = "lsp-1";
    isClosed = false;
    handle(message: string) {
      handled.push(message);
      return ['{"jsonrpc":"2.0","id":1,"result":{}}'];
    }
    close() {
      closes++;
      this.isClosed = true;
    }
    dispose() {
      this.close();
    }
  };
  const server = runtime.createLspServer!();
  deepEqual(server.handle('{"id":1}'), [
    '{"jsonrpc":"2.0","id":1,"result":{}}',
  ]);
  deepEqual(handled, ['{"id":1}']);
  server.free();
  server.free();
  equal(closes, 1);
  throws(() => server.handle("{}"), { code: "LSP_CLOSED" });
});
