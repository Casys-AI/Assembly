// project-board.ts — projection of the ASE "board" (home table) from a SysML model.
//
// Reads SysML ONLY through SysML Toolkit 0.10.10 (WASM): no regex on SysML text,
// no heuristic on element names. Read-only on the models; writes only <outDir>.
//
//   deno run --allow-read --allow-write=<outDir> project-board.ts \
//        [--out <outDir>] [--toolkit <pkgDir>] [--model name=path]... [--only name]
//        [--mode ase|generic] [--repeat N]
//
// Model path: a directory of .sysml files, a JSON file { "name.sysml": "text" },
// or one .sysml file. Default models: demo-ase, commercial-watch, initial
// (initial-sources.json is written by dump-initial.ts, which calls the repo's
// loadInitialSources(); the board script itself imports nothing from the repo).
//
// Output  board-<model>.json = { schema, meta, columns, links, index }
//   columns[] : { id, title, rule, items[] }   (ase: team, cando, rules, guarantees, information;
//                                                generic: parts, behaviors, requirements)
//   item      : { id, element, keyword, title, summary, summarySource, qname, file, line, col, kind,
//                 type?, group?, scope?, children?, ports?, steps?, io?, values?, track?, clauses?,
//                 access?, ... }   id = SysML element id, or "<owner id>#<element id>" for things
//                 seen through an owner (ports, steps, states, clauses, inherited features)
//   links[]   : { id, kind, role?, from, to, via, file, line, exact, derived?, strength? }
//                 from/to are ids that exist in `index`; via = SysML element carrying the relation
//   index     : { <id>: { column, card } }  every displayed id -> the card that contains it
//   meta      : mode, modeRule, anchors, linkLabels, counts, diagnostics[{code,severity,context,recovery}],
//                 fieldSources, timingMs, digest (sha256 of columns+links+index; same sources = same digest)
// Exit code 2 when a model cannot be projected (diagnostic with code + recovery on stdout).

// deno-lint-ignore no-explicit-any
type Any = any;

const HERE = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const LB = new URL("../../..", import.meta.url).pathname.replace(/\/$/, ""); // repository root
const DEFAULT_PKG = `${LB}/.data/toolchains/sysml-toolkit-v0.10.10/package`;
const DEFAULT_MODELS: Record<string, string> = {
  "demo-ase": `${LB}/.data/systems/demo-ase/model-project/sources`,
  "commercial-watch": `${LB}/test/fixtures/commercial-watch/sources.json`,
  "initial": `${HERE}/initial-sources.json`,
};

// ───────────────────────────── diagnostics (AX) ─────────────────────────────
interface Diag {
  code: string;
  severity: "error" | "warning" | "info";
  context: Record<string, unknown>;
  recovery: string;
}
const diag = (
  d: Diag[],
  code: string,
  severity: Diag["severity"],
  context: Record<string, unknown>,
  recovery: string,
) => d.push({ code, severity, context, recovery });

// ───────────────────────────── registry (ASE mode) ──────────────────────────
// Concept membership is expressed with constructs of the ASE library: a usage
// belongs to a column when it CONFORMS (typing / specialization closure,
// Session.conforms) to one of these definitions. Anchors that do not exist in
// the model are skipped and reported (ANCHOR_UNRESOLVED). Target state: replace
// the lists by one abstract marker definition per column in the library.
const REGISTRY = {
  operator: ["ASECore::Operator", "ASECore::HumanOperator", "ASECore::SoftwareOperator"],
  human: ["ASECore::HumanOperator"],
  capabilityType: ["ASECore::ExecutableCapability"],
  tool: ["ASEExecution::CapabilityContract"],
  skill: ["APESkills::InitialSkill"],
  access: ["ASEInvocations::BehaviorAccess"],
  mandate: ["ASECore::ConfiguredMandate", "ASEAuthority::Mandate"],
  policy: [
    "ASEExecution::ExecutionPolicy",
    "ASEModelEditing::ModelEditPolicy",
    "ASEModelAdministration::ModelAdministrationPolicy",
    "APEContext::DecisionContextPolicy",
    "APESkills::SkillPolicy",
    "APEMemory::GovernedMemoryPolicy",
    "APEWorkBudget::InvocationBudgetPolicy",
  ],
  authority: ["ASEAuthority::RootAuthority", "ASEAuthority::RootGrant"],
  // Library features whose `bind` gives a role (subject = element owning the
  // feature in the chain, object = the other end).
  roles: {
    "ASEInvocations::BehaviorAccess::caller": "caller",
    "ASEInvocations::BehaviorAccess::target": "target",
    "ASECore::SoftwareOperator::mandate": "mandate",
    "ASECore::ConfiguredMandate::holder": "holder",
    "ASEModelEditing::ModelEditPolicy::holder": "holder",
    "ASEModelEditing::ModelEditPolicy::mandate": "mandate",
    "ASEModelEditing::ModelEditPolicy::issuer": "issuer",
    "ASEModelAdministration::ModelAdministrationPolicy::holder": "holder",
    "ASEModelAdministration::ModelAdministrationPolicy::mandate": "mandate",
    "ASEModelAdministration::ModelAdministrationPolicy::issuer": "issuer",
    "ASEAuthority::Mandate::holder": "holder",
    "ASEAuthority::RootGrant::issuer": "issuer",
  } as Record<string, string>,
  // Library attributes read for the title / summary of a kind (found by
  // redefinition root, never by instance name).
  titleFeature: {
    "ASEInvocations::BehaviorAccess": "ASEInvocations::BehaviorAccess::name",
    "ASEExecution::CapabilityContract": "ASEExecution::CapabilityContract::kind",
  } as Record<string, string>,
  summaryFeature: {
    "ASEInvocations::BehaviorAccess": "ASEInvocations::BehaviorAccess::description",
    "ASECore::ConfiguredMandate": "ASECore::ConfiguredMandate::scope",
    "ASEExecution::CapabilityContract": "ASEExecution::CapabilityContract::acceptanceCriteria",
    "APESkills::InitialSkill": "APESkills::InitialSkill::source",
  } as Record<string, string>,
};

const KEYWORD: Record<string, string> = {
  PartUsage: "part", ItemUsage: "item", PortUsage: "port", ActionUsage: "action",
  PerformActionUsage: "perform action", AcceptActionUsage: "accept", SendActionUsage: "send",
  StateUsage: "state", ExhibitStateUsage: "exhibit state", TransitionUsage: "transition",
  DecisionNode: "decide", MergeNode: "merge", ForkNode: "fork", JoinNode: "join",
  PartDefinition: "part def", ItemDefinition: "item def", ActionDefinition: "action def",
  StateDefinition: "state def", RequirementDefinition: "requirement def",
  RequirementUsage: "requirement", ConstraintUsage: "constraint",
  AssertConstraintUsage: "assert constraint", AttributeUsage: "attribute",
  ReferenceUsage: "ref", ViewUsage: "view", AllocationUsage: "allocate",
  ConnectionUsage: "connect", BindingConnectorAsUsage: "bind", SuccessionAsUsage: "succession",
  SatisfyRequirementUsage: "satisfy", Package: "package",
};
const keywordOf = (mc: string) => KEYWORD[mc] ?? mc;
const isDefinitionMc = (mc: string) => mc.endsWith("Definition");

// ───────────────────────────── toolkit loading ──────────────────────────────
const gunzip = async (p: string) =>
  new Uint8Array(
    await new Response((await Deno.open(p)).readable.pipeThrough(new DecompressionStream("gzip")))
      .arrayBuffer(),
  );

async function loadToolkit(pkg: string) {
  const t0 = performance.now();
  const mod = await import(`file://${pkg}/sysmlv2.js`);
  await mod.default({ module_or_path: await Deno.readFile(`${pkg}/sysmlv2_bg.wasm`) });
  const [src, rec, snap] = await Promise.all([
    gunzip(`${pkg}/stdlib/sysml-library.json.gz`),
    gunzip(`${pkg}/stdlib/sysml-library.libcache.gz`),
    gunzip(`${pkg}/stdlib/sysml-library.prepared.gz`),
  ]);
  const lib = mod.PreparedLibrary.fromSnapshot(snap, new TextDecoder().decode(src), rec);
  let version = "unknown";
  try {
    version = JSON.parse(await Deno.readTextFile(`${pkg}/package.json`)).version ?? version;
  } catch { /* keep */ }
  return { mod, lib, version, loadMs: performance.now() - t0 };
}

async function readSources(spec: string): Promise<Record<string, string>> {
  let st: Deno.FileInfo;
  try {
    st = await Deno.stat(spec);
  } catch {
    throw {
      code: "MODEL_SOURCES_NOT_FOUND",
      context: { path: spec },
      recovery: "Pass a directory of .sysml files, a JSON file { name: text }, or one .sysml file; for the initial model run dump-initial.ts first.",
    };
  }
  if (st.isFile && /\.(sysml|kerml)$/.test(spec)) {
    return { [spec.split("/").pop()!]: await Deno.readTextFile(spec) };
  }
  if (st.isDirectory) {
    const out: Record<string, string> = {};
    for await (const e of Deno.readDir(spec)) {
      if (e.name.endsWith(".sysml")) out[e.name] = await Deno.readTextFile(`${spec}/${e.name}`);
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
  }
  return JSON.parse(await Deno.readTextFile(spec));
}

async function sha256(text: string): Promise<string> {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ───────────────────────────── semantic reader ──────────────────────────────
interface Unit {
  name: string;
  bytes: Uint8Array;
  lineStarts: number[];
}
interface Site {
  file: string;
  line: number;
  col: number;
}

class Reader {
  s: Any;
  units = new Map<number, Unit>();
  private cache = new Map<string, Any>();
  private confCache = new Map<string, boolean>();
  calls = 0;
  /** Toolkit calls by method name (the Proxy below counts every call made through this reader). */
  callsByMethod: Record<string, number> = {};
  constructor(session: Any) {
    const counts = this.callsByMethod;
    this.s = new Proxy(session, {
      get(target, prop) {
        const v = target[prop];
        if (typeof v !== "function") return v;
        return (...a: unknown[]) => {
          counts[String(prop)] = (counts[String(prop)] ?? 0) + 1;
          return v.apply(target, a);
        };
      },
    });
    const enc = new TextEncoder();
    for (const u of JSON.parse(this.s.units()) as { unit: number; name: string; text: string }[]) {
      const bytes = enc.encode(u.text);
      const ls = [0];
      for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) ls.push(i + 1);
      this.units.set(u.unit, { name: u.name, bytes, lineStarts: ls });
    }
  }
  private ids = new WeakMap<object, string>();
  private mcs = new WeakMap<object, string>();
  intern(e: Any): Any {
    const id = this.id(e);
    const c = this.cache.get(id);
    if (c) return c;
    this.cache.set(id, e);
    return e;
  }
  byId(id: string): Any | undefined {
    let h = this.cache.get(id);
    if (!h) {
      h = this.s.elementById(id);
      if (h) this.cache.set(id, h);
    }
    return h;
  }
  id(e: Any): string {
    let v = this.ids.get(e);
    if (v === undefined) {
      v = this.s.elementId(e) as string;
      this.ids.set(e, v);
    }
    return v;
  }
  mc(e: Any): string {
    let v = this.mcs.get(e);
    if (v === undefined) {
      v = this.s.metaclass(e) as string;
      this.mcs.set(e, v);
    }
    return v;
  }
  isLib(e: Any): boolean {
    return this.s.isLibraryElement(e);
  }
  qname(e: Any): string | null {
    return this.s.qualifiedName(e) ?? null;
  }
  name(e: Any): string | null {
    try {
      const d = JSON.parse(this.s.derived(e, "name"));
      if (typeof d === "string") return d;
    } catch { /* not derived on this metaclass */ }
    return this.s.name(e) ?? null;
  }
  owner(e: Any): Any | undefined {
    const o = this.s.owner(e);
    return o ? this.intern(o) : undefined;
  }
  dEls(e: Any, prop: string): Any[] {
    try {
      return this.s.derivedElements(e, prop).map((x: Any) => this.intern(x));
    } catch {
      return [];
    }
  }
  dOne(e: Any, prop: string): Any | undefined {
    return this.dEls(e, prop)[0];
  }
  prop(e: Any, name: string): Any {
    try {
      return JSON.parse(this.s.property(e, name));
    } catch {
      return undefined;
    }
  }
  members(e: Any): Any[] {
    return this.s.members(e).map((x: Any) => this.intern(x));
  }
  typings(e: Any): Any[] {
    return this.s.typings(e).map((x: Any) => this.intern(x));
  }
  chain(e: Any): Any[] {
    const c = this.dEls(e, "chainingFeature");
    return c.length ? c : [e];
  }
  /** own features, then inherited ones (base first), user model only */
  effective(e: Any): { el: Any; inherited: boolean }[] {
    const inh = this.dEls(e, "inheritedFeature").filter((x) => !this.isLib(x))
      .map((el) => ({ el, inherited: true }));
    const own = this.dEls(e, "ownedFeature").map((el) => ({ el, inherited: false }));
    return [...inh, ...own];
  }
  conforms(e: Any, anchors: { id: string; el: Any }[]): boolean {
    const eid = this.id(e);
    for (const a of anchors) {
      const k = `${eid}|${a.id}`;
      let v = this.confCache.get(k);
      if (v === undefined) {
        this.calls++;
        try {
          v = this.s.conforms(e, a.el) as boolean;
        } catch {
          v = false;
        }
        this.confCache.set(k, v);
      }
      if (v) return true;
    }
    return false;
  }
  isRef(e: Any): boolean {
    try {
      return JSON.parse(this.s.derived(e, "isReference")) === true;
    } catch {
      return false;
    }
  }
  doc(e: Any): string | null {
    try {
      const d = this.s.docs(e) as string[];
      return d.length ? d[0] : null;
    } catch {
      return null;
    }
  }
  private offsetSite(unit: number, start: number): Site | undefined {
    const u = this.units.get(unit);
    if (!u) return undefined;
    let lo = 0, hi = u.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (u.lineStarts[mid] <= start) lo = mid;
      else hi = mid - 1;
    }
    const col = new TextDecoder().decode(u.bytes.slice(u.lineStarts[lo], start)).length + 1;
    return { file: u.name, line: lo + 1, col };
  }
  site(e: Any): Site {
    for (const f of ["declarationSite", "memberExtent"]) {
      try {
        const r = this.s[f](e) as string | undefined;
        if (r) {
          const j = JSON.parse(r) as { unit: number; start: number };
          const s = this.offsetSite(j.unit, j.start);
          if (s) return s;
        }
      } catch { /* try next */ }
    }
    return { file: "", line: 0, col: 0 };
  }
  /** literal / evaluated value of an attribute-like feature (null when unavailable) */
  value(e: Any): string | number | boolean | null {
    try {
      const v = JSON.parse(this.s.evaluate(e));
      if (v === null || ["string", "number", "boolean"].includes(typeof v)) return v;
    } catch { /* fall back */ }
    try {
      const v = this.s.valueSource(e) as string | undefined;
      return v ?? null;
    } catch {
      return null;
    }
  }
  /** root feature a redefining feature stands for */
  rootId(e: Any): string {
    try {
      return this.id(this.s.redefinitionRoot(e));
    } catch {
      return this.id(e);
    }
  }
}

// ───────────────────── expression text (guards, constraints) ────────────────
const PREC: Record<string, number> = {
  "implies": 1, "or": 2, "||": 2, "xor": 2, "and": 3, "&&": 3, "==": 5, "!=": 5, "===": 5, "!==": 5,
  "<": 6, ">": 6, "<=": 6, ">=": 6, "+": 7, "-": 7, "*": 8, "/": 8, "%": 8,
};

function exprText(R: Reader, e: Any, depth = 0): string {
  if (depth > 24) return "…";
  const mc = R.mc(e);
  const kids = (n: string) => R.dEls(e, n);
  switch (mc) {
    case "OperatorExpression": {
      const op = String(R.prop(e, "operator") ?? "?");
      const a = kids("argument");
      const sub = (x: Any) => {
        const t = exprText(R, x, depth + 1);
        if (R.mc(x) === "OperatorExpression") {
          const xp = PREC[String(R.prop(x, "operator"))] ?? 0, mp = PREC[op] ?? 0;
          if (xp && mp && xp < mp) return `(${t})`;
        }
        return t;
      };
      return a.length === 2 ? `${sub(a[0])} ${op} ${sub(a[1])}` : `${op} ${a.map(sub).join(", ")}`;
    }
    case "FeatureChainExpression": {
      const tf = kids("targetFeature")[0];
      let t = "?";
      if (tf) {
        const ch = R.dEls(tf, "chainingFeature");
        t = ch.length ? ch.map((c) => R.name(c) ?? "?").join(".") : (R.name(tf) ?? "?");
      }
      return `${kids("argument").map((x) => exprText(R, x, depth + 1))[0] ?? "?"}.${t}`;
    }
    case "FeatureReferenceExpression":
      return kids("referent").map((r) => R.name(r))[0] ?? "?";
    case "LiteralString":
      return JSON.stringify(R.prop(e, "value") ?? "");
    case "LiteralBoolean":
    case "LiteralInteger":
    case "LiteralRational":
      return String(R.prop(e, "value"));
    case "NullExpression":
      return "null";
    default:
      return `<${mc}>`;
  }
}

function firstSentence(doc: string | null, max = 150): string | null {
  if (!doc) return null;
  const flat = doc.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const m = flat.match(/^(.+?[.!?])(\s|$)/);
  let s = m ? m[1] : flat;
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
  return s;
}
function cut(v: string, max = 90): { value: string; truncated: boolean } {
  const flat = v.replace(/\s+/g, " ").trim();
  return flat.length > max
    ? { value: flat.slice(0, max - 1).trimEnd() + "…", truncated: true }
    : { value: flat, truncated: false };
}

// ───────────────────────────── board types ──────────────────────────────────
interface Ref {
  title: string;
  qname: string | null;
}
interface Item {
  id: string;
  element: string;
  keyword: string;
  title: string;
  summary: string | null;
  summarySource: string | null;
  qname: string | null;
  file: string;
  line: number;
  col: number;
  kind: string;
  type?: Ref;
  definition?: boolean;
  group?: { element: string; title: string }[];
  scope?: string;
  children?: Item[];
  ports?: Any[];
  steps?: Any[];
  io?: Any[];
  values?: Any[];
  track?: Any;
  clauses?: Any[];
  access?: Any[];
  /** operator: "human" | "software" (Team) */
  operatorKind?: string;
  /** library attribute that supplied the title */
  titleSource?: string;
  /** flow statistics (Can do) */
  flow?: Any;
  /** assert constraint / clause expression, rebuilt from the expression tree */
  expression?: string | null;
  /** assert constraint: true when a performed action contains a step typed by its owner definition */
  inForce?: boolean;
  /** assert constraint: definition that owns it */
  owner?: Ref;
  /** requirement: type of the declared subject */
  subject?: Ref;
  /** requirement: number of satisfy links */
  satisfiedBy?: number;
  /** panels: nesting depth below the scope card (0 = scope) */
  depth?: number;
  /** panels: expanded when the board first opens */
  open?: boolean;
}

interface ShapeNode {
  id: string;
  name: string;
  qualifiedName: string;
  metaclass: string;
  owner: number;
  idx: number;
}

// ───────────────────────────── the projection ───────────────────────────────
interface Anchors {
  [k: string]: { id: string; el: Any; qname: string }[];
}

async function project(
  tk: Awaited<ReturnType<typeof loadToolkit>>,
  modelName: string,
  sources: Record<string, string>,
  forceMode?: "ase" | "generic",
) {
  const T: Record<string, number> = {};
  const lap = (() => {
    let t = performance.now();
    return (k: string) => {
      const n = performance.now();
      T[k] = Math.round((n - t) * 10) / 10;
      t = n;
    };
  })();
  const D: Diag[] = [];

  // Units are given to the Toolkit in name order, so item order never depends on the input dictionary order.
  const arr = Object.entries(sources).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, text]) => ({ name, text }));
  let session: Any;
  try {
    session = tk.mod.Session.fromSourcesWithPreparedLibrary(JSON.stringify(arr), tk.lib);
  } catch (e) {
    throw {
      code: "MODEL_DOES_NOT_PARSE",
      context: { model: modelName, message: String(e).slice(0, 400) },
      recovery: "Fix the SysML syntax error reported in message; the Toolkit refuses the whole source set.",
    };
  }
  lap("session");
  const R = new Reader(session);
  const s = R.s;
  try {
    const findings = JSON.parse(s.check()) as { severity: string; message: string; unit?: string; line?: number }[];
    for (const f of findings.filter((x) => x.severity === "error").slice(0, 20)) {
      diag(D, "MODEL_CHECK_ERROR", "warning", { message: f.message, file: f.unit, line: f.line },
        "Fix the model; the board is projected from a model the Toolkit reports as invalid.");
    }
  } catch { /* check is advisory here */ }

  // ── index: every named user element, in visiting (= source) order ──
  const outline = JSON.parse(s.outline(JSON.stringify({ shapeNodes: 200000, outlineNodes: 1 })));
  const shape: ShapeNode[] = outline.shape.nodes.map((n: Any, idx: number) => ({ ...n, idx }));
  if (outline.shape.truncated) {
    diag(D, "SHAPE_TRUNCATED", "error", { nodes: shape.length }, "Raise shapeNodes in the outline call.");
  }
  const kidsOf: number[][] = shape.map(() => []);
  const rootsIdx: number[] = [];
  for (const n of shape) (n.owner >= 0 ? kidsOf[n.owner] : rootsIdx).push(n.idx);
  const nodeById = new Map(shape.map((n) => [n.id, n]));
  const ancestors = (n: ShapeNode): ShapeNode[] => {
    const out: ShapeNode[] = [];
    let o = n.owner;
    while (o >= 0) {
      out.push(shape[o]);
      o = shape[o].owner;
    }
    return out.reverse(); // root first
  };
  const usageLevel = (n: ShapeNode) => !ancestors(n).some((a) => isDefinitionMc(a.metaclass));
  lap("index");

  // ── anchors ──
  const anchors: Anchors = {};
  for (const [k, list] of Object.entries(REGISTRY)) {
    if (!Array.isArray(list)) continue;
    anchors[k] = [];
    for (const q of list) {
      const el = s.resolve(q);
      if (el) anchors[k].push({ id: R.id(el), el: R.intern(el), qname: q });
    }
  }
  const unresolved = Object.entries(REGISTRY)
    .filter(([, v]) => Array.isArray(v))
    .flatMap(([k, v]) => (v as string[]).filter((q) => !anchors[k].some((a) => a.qname === q)).map((q) => ({ concept: k, anchor: q })));
  const roleFeature = new Map<string, string>(); // feature id -> role
  for (const [q, role] of Object.entries(REGISTRY.roles)) {
    const el = s.resolve(q);
    if (el) roleFeature.set(R.id(el), role);
  }
  const libFeatureId = (q: string): string | undefined => {
    const el = s.resolve(q);
    return el ? R.id(el) : undefined;
  };
  lap("anchors");

  // ── root parts, operators and mode ──
  const rootParts = shape.filter((n) => {
    if (n.metaclass !== "PartUsage" || !usageLevel(n)) return false;
    const o = n.owner >= 0 ? shape[n.owner] : undefined;
    return !o || o.metaclass === "Package";
  });
  const opCache = new Map<string, boolean>();
  const isOperatorEl = (el: Any): boolean => {
    const id = R.id(el);
    let v = opCache.get(id);
    if (v === undefined) {
      v = anchors.operator.length > 0 && R.conforms(el, anchors.operator);
      opCache.set(id, v);
    }
    return v;
  };
  const belowCache = new Map<string, boolean>();
  const hasOperatorBelow = (el: Any, depth = 0): boolean => {
    const id = R.id(el);
    const c = belowCache.get(id);
    if (c !== undefined) return c;
    let v = isOperatorEl(el);
    if (!v && depth < 12) {
      for (const { el: f } of R.effective(el)) {
        if (R.mc(f) === "PartUsage" && !R.isRef(f) && hasOperatorBelow(f, depth + 1)) {
          v = true;
          break;
        }
      }
    }
    belowCache.set(id, v);
    return v;
  };
  const detected: "ase" | "generic" = rootParts.some((n) => hasOperatorBelow(R.byId(n.id)!)) ? "ase" : "generic";
  const mode: "ase" | "generic" = forceMode ?? detected;

  // ── per-model structures ──
  const board = new Map<string, { column: string; card: string }>();
  const displayed: { id: string; el: Any }[] = []; // every panel / card with its SysML element
  const registerId = (id: string, v: { column: string; card: string }) => {
    if (board.has(id)) diag(D, "DUPLICATE_ID", "error", { id }, "Two displayed things share one id; ids are element ids or <owner id>#<element id>.");
    board.set(id, v);
  };
  const registerTree = (it: Item, column: string, card: string) => {
    registerId(it.id, { column, card });
    const el = R.byId(it.element);
    if (el) displayed.push({ id: it.id, el });
    for (const c of it.children ?? []) registerTree(c, column, card);
    for (const p of it.ports ?? []) registerId(p.id, { column, card });
    for (const st of it.steps ?? []) registerId(st.id, { column, card });
    for (const st of it.track?.states ?? []) registerId(st.id, { column, card });
    for (const c of it.clauses ?? []) registerId(c.id, { column, card });
  };

  const conformsEl = (el: Any, key: string) => (anchors[key]?.length ?? 0) > 0 && R.conforms(el, anchors[key]);
  const RULE_KEYS = ["mandate", "policy", "access", "authority"];
  const claimedByRules = (el: Any) =>
    mode === "ase" && [...RULE_KEYS, "tool", "skill"].some((k) => conformsEl(el, k));

  const mkBase = (el: Any, id: string, kind: string): Item => {
    const mc = R.mc(el);
    const site = R.site(el);
    const typ = R.typings(el)[0];
    const it: Item = {
      id,
      element: R.id(el),
      keyword: keywordOf(mc),
      title: R.name(el) ?? `<${mc}>`,
      summary: null,
      summarySource: null,
      qname: R.qname(el),
      file: site.file,
      line: site.line,
      col: site.col,
      kind,
    };
    if (typ) it.type = { title: R.name(typ) ?? "?", qname: R.qname(typ) };
    if (isDefinitionMc(mc)) it.definition = true;
    const own = firstSentence(R.doc(el));
    if (own) {
      it.summary = own;
      it.summarySource = "doc";
    }
    return it;
  };

  /** Attribute members of an element, with the library feature they redefine (by root id). */
  const attrsOf = (el: Any) => {
    const out: { name: string; el: Any; root: string; value: string | number | boolean | null }[] = [];
    for (const m of R.members(el)) {
      if (R.mc(m) !== "AttributeUsage") continue;
      out.push({ name: R.name(m) ?? "?", el: m, root: R.rootId(m), value: R.value(m) });
    }
    return out;
  };
  const conceptOfAnchor = (anchorQ: string) =>
    Object.keys(REGISTRY).find((k) => Array.isArray((REGISTRY as Any)[k]) && (REGISTRY as Any)[k].includes(anchorQ));
  const designated = (el: Any, table: Record<string, string>, attrs: ReturnType<typeof attrsOf>) => {
    for (const [anchorQ, featQ] of Object.entries(table)) {
      const a = anchors[conceptOfAnchor(anchorQ)!]?.find((x) => x.qname === anchorQ);
      if (!a || !R.conforms(el, [a])) continue;
      const fid = libFeatureId(featQ);
      const hit = attrs.find((x) => x.root === fid && x.value !== null);
      if (hit) return { value: String(hit.value), source: featQ };
    }
    return undefined;
  };
  const typeDocSummary = (it: Item, el: Any) => {
    if (it.summary) return;
    const typ = R.typings(el)[0];
    const s1 = typ ? firstSentence(R.doc(typ)) : null;
    if (s1) {
      it.summary = s1;
      it.summarySource = "type-doc";
    }
  };
  const panelIdSet = new Set<string>();
  const groupOf = (el: Any, composite: boolean): NonNullable<Item["group"]> => {
    if (composite) return [];
    const chain: Any[] = [];
    for (let o = R.owner(el); o; o = R.owner(o)) chain.push(o);
    return chain.reverse()
      .filter((a) => R.mc(a) === "PartUsage" && !panelIdSet.has(R.id(a)))
      .map((a) => ({ element: R.id(a), title: R.name(a) ?? "?" }));
  };

  // ───────────────────────── ports, panels (Team / Parts) ─────────────────────────
  const portChips = (partEl: Any, partId: string) => {
    const out: Any[] = [];
    for (const { el: f, inherited } of R.effective(partEl)) {
      if (R.mc(f) !== "PortUsage") continue;
      const t = R.typings(f)[0];
      const conj = !!t && R.mc(t) === "ConjugatedPortDefinition";
      const base = conj ? (R.dOne(t, "originalPortDefinition") ?? t) : t;
      const items: Any[] = [];
      if (base) {
        for (const m of R.dEls(base, "ownedFeature")) {
          const dir = R.prop(m, "direction") as string | undefined;
          if (!dir) continue;
          const flip = conj ? ({ in: "out", out: "in" } as Record<string, string>)[dir] ?? dir : dir;
          const ty = R.typings(m)[0];
          items.push({ dir: flip, title: R.name(m) ?? "?", type: ty ? R.name(ty) : null });
        }
      }
      const site = R.site(f);
      out.push({
        id: `${partId}#${R.id(f)}`,
        element: R.id(f),
        keyword: "port",
        title: R.name(f) ?? "?",
        qname: R.qname(f),
        file: site.file,
        line: site.line,
        col: site.col,
        type: base ? { title: R.name(base) ?? "?", qname: R.qname(base) } : null,
        conjugated: conj,
        inherited,
        items,
      });
    }
    return out;
  };

  const attrValues = (el: Any, skipRoots: Set<string>, cap = 12) => {
    const out: Any[] = [];
    for (const a of attrsOf(el)) {
      if (a.value === null || skipRoots.has(a.root)) continue;
      const site = R.site(a.el);
      const root = R.byId(a.root);
      const row: Any = { name: a.name, line: site.line, defines: root && R.id(root) !== R.id(a.el) ? R.qname(root) : null };
      if (typeof a.value === "string") {
        const c = cut(a.value, 320);
        row.value = c.value;
        if (c.truncated) row.truncated = true;
      } else row.value = a.value;
      out.push(row);
      if (out.length >= cap) break;
    }
    return out;
  };

  const panelEls = new Map<string, { el: Any; item: Item; root: string }>();
  const packageDocOf = (el: Any): string | null => {
    for (let o = R.owner(el); o; o = R.owner(o)) {
      if (R.mc(o) === "Package") return firstSentence(R.doc(o));
    }
    return null;
  };
  /** Nested panels follow effective features (own, then inherited) in source order. */
  const panelOf = (el: Any, id: string, isRoot: boolean, root: string, depth = 0): Item | undefined => {
    const op = mode === "ase" && isOperatorEl(el);
    const kids: Item[] = [];
    for (const { el: c } of R.effective(el)) {
      if (R.mc(c) !== "PartUsage" || R.isRef(c) || claimedByRules(c)) continue;
      const own = R.owner(c);
      const cid = own && R.id(own) === R.id(el) ? R.id(c) : `${id}#${R.id(c)}`;
      const sub = panelOf(c, cid, false, root, depth + 1);
      if (sub) kids.push(sub);
    }
    const typed = R.typings(el).length > 0;
    if (!isRoot && !op && !typed && kids.length === 0) return undefined; // pure grouping namespace
    const kind = isRoot ? "scope" : op ? "operator" : typed ? "machine" : "group";
    const it = mkBase(el, id, kind);
    it.depth = depth;
    it.open = isRoot || op || depth <= 1; // shown expanded at first sight: root, operators, first level; deeper panels collapsed
    if (op) it.operatorKind = anchors.human.length > 0 && R.conforms(el, anchors.human) ? "human" : "software";
    typeDocSummary(it, el);
    if (isRoot && !it.summary) {
      const pd = packageDocOf(el);
      if (pd) {
        it.summary = pd;
        it.summarySource = "package-doc";
      }
    }
    const ports = portChips(el, id);
    if (ports.length) it.ports = ports;
    if (kids.length) it.children = kids;
    if (isRoot) {
      const v = attrValues(el, new Set(), 10);
      if (v.length) it.values = v;
    }
    panelEls.set(id, { el, item: it, root });
    panelIdSet.add(id);
    return it;
  };

  // ───────────────────────── flows (action defs) ─────────────────────────
  const NODE_KIND = (mc: string): string | undefined => {
    if (mc === "DecisionNode") return "decision";
    if (mc === "MergeNode") return "merge";
    if (mc === "ForkNode") return "fork";
    if (mc === "JoinNode") return "join";
    if (mc === "AcceptActionUsage") return "accept";
    if (mc === "SendActionUsage") return "send";
    if (mc.endsWith("ActionUsage")) return "action";
    return undefined;
  };

  interface FNode { id: string; el: Any; kind: string; title: string; idx: number; lib?: "start" | "done" }
  interface FEdge { id: string; el: Any; from: string; to: string; idx: number; guard: string | null; branch: boolean; supp: boolean; back: boolean }

  const buildFlow = (cardId: string, defEl: Any): { steps: Any[]; stats: Any } | undefined => {
    const feats = R.effective(defEl).map((x) => x.el);
    const nodes = new Map<string, FNode>();
    const edges: FEdge[] = [];
    let idx = 0;
    for (const m of feats) {
      const kind = NODE_KIND(R.mc(m));
      if (kind) nodes.set(R.id(m), { id: R.id(m), el: m, kind, title: R.name(m) ?? `<${R.mc(m)}>`, idx: idx++ });
    }
    const asNode = (e: Any | undefined): FNode | undefined => {
      if (!e) return undefined;
      const id = R.id(e);
      const n = nodes.get(id);
      if (n) return n;
      if (R.isLib(e)) {
        const q = R.qname(e) ?? "";
        const lib = q.endsWith("::start") ? "start" : q.endsWith("::done") ? "done" : undefined;
        if (!lib) return undefined;
        const key = `@${lib}`;
        let ln = nodes.get(key);
        if (!ln) {
          ln = { id: key, el: e, kind: lib === "start" ? "start" : "end", title: lib, idx: lib === "start" ? -1 : 1e9, lib };
          nodes.set(key, ln);
        }
        return ln;
      }
      return undefined;
    };
    let last: FNode | undefined; // nearest preceding node member (for implicit transition source)
    let supplemented = 0, unresolved = 0, eidx = 0;
    for (const m of feats) {
      const mc = R.mc(m);
      if (NODE_KIND(mc)) {
        last = nodes.get(R.id(m));
        continue;
      }
      if (mc === "SuccessionAsUsage") {
        const a = asNode(R.dOne(m, "sourceFeature")), b = asNode(R.dEls(m, "targetFeature")[0]);
        if (a && b) edges.push({ id: R.id(m), el: m, from: a.id, to: b.id, idx: eidx++, guard: null, branch: false, supp: false, back: false });
        else unresolved++;
      } else if (mc === "TransitionUsage") {
        const srcEl = R.dOne(m, "source");
        let a = asNode(srcEl);
        let supp = false;
        if (!a && !srcEl && last) {
          a = last;
          supp = true; // Toolkit leaves the branch source empty (Open-MBEE/sysml-toolkit#13)
          supplemented++;
        }
        const b = asNode(R.dOne(m, "target"));
        const ge = R.dOne(m, "guardExpression");
        const guard = ge ? exprText(R, ge) : null;
        if (a && b) edges.push({ id: R.id(m), el: m, from: a.id, to: b.id, idx: eidx++, guard, branch: true, supp, back: false });
        else unresolved++;
      }
    }
    if (nodes.size === 0 || edges.length === 0) {
      return nodes.size === 0 ? undefined : {
        steps: [...nodes.values()].filter((n) => !n.lib).sort((x, y) => x.idx - y.idx).map((n, i) => stepRow(cardId, n, i + 1, 0, null, [])),
        stats: { nodes: nodes.size, edges: 0, supplemented, unresolved, sequential: false },
      };
    }
    const out = new Map<string, FEdge[]>();
    const inc = new Map<string, FEdge[]>();
    for (const e of edges) {
      (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
      (inc.get(e.to) ?? inc.set(e.to, []).get(e.to)!).push(e);
    }
    // back edges: DFS from the start node (or from nodes without incoming edges)
    const color = new Map<string, number>();
    const dfs = (u: string) => {
      color.set(u, 1);
      for (const e of out.get(u) ?? []) {
        const c = color.get(e.to) ?? 0;
        if (c === 1) e.back = true;
        else if (c === 0) dfs(e.to);
      }
      color.set(u, 2);
    };
    const starts = [...nodes.values()].filter((n) => n.lib === "start" || (!(inc.get(n.id)?.length) && !n.lib))
      .sort((a, b) => a.idx - b.idx);
    for (const st of starts) if (!color.get(st.id)) dfs(st.id);
    const indeg = (id: string) => (inc.get(id) ?? []).filter((e) => !e.back).length;

    // structured outline
    const rows: Any[] = [];
    const emitted = new Set<string>();
    const numberOf = new Map<string, number>();
    const deferred: string[] = [];
    interface Frame { edges: Set<string>; depth: number }
    const frames: Frame[] = [{ edges: new Set(), depth: 0 }];
    let counter = 0;
    const arrive = (e: FEdge) => frames.forEach((f) => f.edges.add(e.id));
    const ready = (id: string, f: Frame) => (inc.get(id) ?? []).filter((e) => !e.back).every((e) => f.edges.has(e.id));

    const emit = (n: FNode, depth: number, guard: string | null, branchKind: string | null) => {
      emitted.add(n.id);
      const num = n.lib === "start" ? 0 : ++counter;
      numberOf.set(n.id, num);
      const gotos: Any[] = [];
      for (const e of out.get(n.id) ?? []) if (e.back) gotos.push({ to: nodes.get(e.to)!, loop: true });
      rows.push({ n: n.lib ? undefined : num, node: n, depth, guard, branchKind, gotos });
    };

    const chain = (startId: string, depth: number, guard: string | null, via: FEdge | null, branchKind: string | null) => {
      let u: FNode | undefined = nodes.get(startId);
      let g = guard, bk = branchKind;
      while (u) {
        if (u.lib === "start") {
          const o = out.get(u.id) ?? [];
          if (!o.length) return;
          const e = o.find((x) => !x.back)!;
          arrive(e);
          u = nodes.get(e.to);
          via = e;
          continue;
        }
        if (via && indeg(u.id) > 1) {
          // reached by several paths: placed once, after the open decision completes
          const top = frames[frames.length - 1];
          if (!emitted.has(u.id) && (frames.length === 1 && ready(u.id, top) && depth === top.depth)) {
            // root level, all arrivals in: fall through and emit here
          } else {
            if (!emitted.has(u.id) && !deferred.includes(u.id)) deferred.push(u.id);
            rows.push({ goto: u, depth, from: via, forwardRef: !emitted.has(u.id), guard: g, branchKind: bk });
            return;
          }
        } else if (via && emitted.has(u.id)) {
          rows.push({ goto: u, depth, from: via, forwardRef: false, guard: g, branchKind: bk });
          return;
        }
        if (u.lib === "done") {
          if (!emitted.has(u.id)) emit(u, depth, g, bk);
          return;
        }
        emit(u, depth, g, bk);
        g = null;
        bk = null;
        const outs = (out.get(u.id) ?? []).filter((e) => !e.back);
        if (outs.length === 0) return;
        if (outs.length === 1 && !(u.kind === "decision" || u.kind === "fork")) {
          arrive(outs[0]);
          via = outs[0];
          u = nodes.get(outs[0].to);
          continue;
        }
        // decision / fork / several successors: one indented branch per edge, in source order
        const frame: Frame = { edges: new Set(), depth };
        frames.push(frame);
        for (const e of outs) {
          arrive(e);
          chain(e.to, depth + 1, e.branch ? e.guard : null, e, e.branch ? (e.guard === null ? "else" : "if") : (u.kind === "fork" ? "parallel" : "then"));
        }
        frames.pop();
        frame.edges.forEach((x) => frames[frames.length - 1].edges.add(x));
        flush(frame, depth);
        return;
      }
    };
    const flush = (frame: Frame, depth: number) => {
      let progress = true;
      while (progress) {
        progress = false;
        for (const id of [...deferred]) {
          if (emitted.has(id)) continue;
          if (ready(id, frame)) {
            const idxD = deferred.indexOf(id);
            deferred.splice(idxD, 1);
            const wasVia = (inc.get(id) ?? []).find((e) => !e.back) ?? null;
            // emit at the decision's depth, then follow its chain
            const n = nodes.get(id)!;
            emit(n, depth, null, null);
            const outs = (out.get(id) ?? []).filter((e) => !e.back);
            if (outs.length) {
              arrive(outs[0]);
              chain(outs[0].to, depth, null, outs[0], null);
            }
            void wasVia;
            progress = true;
            break;
          }
        }
      }
    };

    for (const st of starts) {
      if (st.lib === "start") chain(st.id, 0, null, null, null);
      else if (!emitted.has(st.id)) chain(st.id, 0, null, null, null);
    }
    // anything never reached keeps its source position and is flagged
    const orphans = [...nodes.values()].filter((n) => !n.lib && !emitted.has(n.id)).sort((a, b) => a.idx - b.idx);
    for (const n of orphans) emit(n, 0, null, null), rows[rows.length - 1].unreachable = true;

    const steps: Any[] = [];
    for (const r of rows) {
      if (r.goto) {
        const t: FNode = r.goto;
        steps.push({
          id: `${cardId}#goto:${r.from.id}`,
          element: r.from.id,
          kind: "goto",
          depth: r.depth,
          guard: r.guard ?? undefined,
          branch: r.branchKind ?? undefined,
          to: `${cardId}#${t.lib ? "@" + t.lib : R.id(t.el)}`,
          toTitle: t.title,
          forward: r.forwardRef,
        });
        continue;
      }
      if (r.node.lib === "start") continue;
      steps.push(stepRow(cardId, r.node, r.n, r.depth, r.guard, r.gotos, r.branchKind, r.unreachable));
    }
    const real = steps.filter((x) => x.kind !== "goto");
    const kindCount = (k: string) => real.filter((x) => x.kind === k).length;
    return {
      steps,
      stats: {
        nodes: nodes.size,
        edges: edges.length,
        back: edges.filter((e) => e.back).length,
        supplemented,
        unresolved,
        sequential: true,
        summary: {
          steps: kindCount("action") + kindCount("accept") + kindCount("send"),
          decisions: kindCount("decision"),
          merges: kindCount("merge") + kindCount("join"),
          forks: kindCount("fork"),
          loops: edges.filter((e) => e.back).length,
          unreachable: real.filter((x) => x.unreachable).length,
        },
      },
    };
  };

  const stepRow = (cardId: string, n: FNode, num: number, depth: number, guard: string | null, gotos: Any[], branch?: string | null, unreachable?: boolean) => {
    const site = n.lib ? { file: "", line: 0, col: 0 } : R.site(n.el);
    const typ = n.lib ? undefined : R.typings(n.el)[0];
    const row: Any = {
      id: `${cardId}#${n.lib ? "@" + n.lib : R.id(n.el)}`,
      element: n.lib ? null : R.id(n.el),
      n: num,
      kind: n.kind,
      keyword: n.lib ? n.kind : keywordOf(R.mc(n.el)),
      title: n.title,
      depth,
    };
    if (typ) row.type = { title: R.name(typ) ?? "?", qname: R.qname(typ) };
    if (guard !== null && guard !== undefined) row.guard = guard;
    if (branch) row.branch = branch;
    if (!n.lib) Object.assign(row, { qname: R.qname(n.el), file: site.file, line: site.line, col: site.col });
    if (gotos.length) row.loops = gotos.map((g: Any) => ({ to: `${cardId}#${R.id(g.to.el)}`, toTitle: g.to.title }));
    if (unreachable) row.unreachable = true;
    return row;
  };

  // ───────────────────────── state machines ─────────────────────────
  const buildTrack = (cardId: string, defEl: Any) => {
    const feats = R.effective(defEl);
    const states: { el: Any; id: string; title: string; order: number; inherited: boolean }[] = [];
    const trans: { el: Any; id: string; inherited: boolean; order: number }[] = [];
    let entry: Any | undefined;
    const succs: Any[] = [];
    feats.forEach(({ el, inherited }, order) => {
      const mc = R.mc(el);
      if (mc === "StateUsage") states.push({ el, id: R.id(el), title: R.name(el) ?? "?", order, inherited });
      else if (mc === "TransitionUsage") trans.push({ el, id: R.id(el), inherited, order });
      else if (mc === "SuccessionAsUsage") succs.push(el);
    });
    const generalOf = (sp: Any): Any | undefined => {
      try {
        const g = R.byId(JSON.parse(s.property(sp, "general"))["@id"]);
        return g && !R.isLib(g) ? g : undefined;
      } catch {
        return undefined;
      }
    };
    const lineage: Any[] = [defEl];
    for (let i = 0; i < lineage.length && i < 8; i++) {
      for (const sp of R.dEls(lineage[i], "ownedSpecialization")) {
        const g = generalOf(sp);
        if (g && !lineage.some((x) => R.id(x) === R.id(g))) lineage.push(g);
      }
    }
    entry = lineage.map((d) => R.dOne(d, "entryAction")).find(Boolean);
    let initial: string | undefined;
    if (entry) {
      for (const sc of succs) {
        const a = R.dOne(sc, "sourceFeature");
        if (a && R.id(a) === R.id(entry)) {
          const b = R.dEls(sc, "targetFeature")[0];
          if (b) initial = R.id(b);
        }
      }
    }
    const sid = new Map(states.map((x) => [x.id, x]));
    interface TEdge { id: string; el: Any; from: string; to: string; on: string | null; guard: string | null; name: string | null; inherited: boolean; order: number; back?: boolean }
    const edges: TEdge[] = [];
    for (const t of trans) {
      const a = R.dOne(t.el, "source"), b = R.dOne(t.el, "target");
      if (!a || !b || !sid.has(R.id(a)) || !sid.has(R.id(b))) continue;
      const trig = R.dOne(t.el, "triggerAction");
      let on: string | null = null;
      if (trig) {
        const pp = R.dOne(trig, "payloadParameter") ?? trig;
        const ty = R.typings(pp)[0];
        on = ty ? (R.name(ty) ?? null) : null;
      }
      const ge = R.dOne(t.el, "guardExpression");
      edges.push({ id: t.id, el: t.el, from: R.id(a), to: R.id(b), on, guard: ge ? exprText(R, ge) : null, name: R.name(t.el), inherited: t.inherited, order: t.order });
    }
    const outE = new Map<string, TEdge[]>();
    for (const e of edges) (outE.get(e.from) ?? outE.set(e.from, []).get(e.from)!).push(e);
    // longest-path rank from the initial state, back edges removed
    const rank = new Map<string, number>();
    const color = new Map<string, number>();
    const topo: string[] = [];
    const dfs = (u: string) => {
      color.set(u, 1);
      for (const e of outE.get(u) ?? []) {
        const c = color.get(e.to) ?? 0;
        if (c === 1) e.back = true;
        else if (c === 0) dfs(e.to);
      }
      color.set(u, 2);
      topo.push(u);
    };
    if (initial) dfs(initial);
    for (const st of states) if (!color.get(st.id)) dfs(st.id);
    if (initial) rank.set(initial, 0);
    for (const u of [...topo].reverse()) {
      const ru = rank.get(u);
      if (ru === undefined) continue;
      for (const e of outE.get(u) ?? []) {
        if (e.back) continue;
        rank.set(e.to, Math.max(rank.get(e.to) ?? 0, ru + 1));
      }
    }
    const terminal = (id: string) => (outE.get(id) ?? []).length === 0;
    const rankOf = (id: string) => rank.get(id) ?? -1;
    const main = states.filter((x) => !terminal(x.id)).sort((a, b) => (rankOf(a.id) === -1 ? 1e6 : rankOf(a.id)) - (rankOf(b.id) === -1 ? 1e6 : rankOf(b.id)) || a.order - b.order);
    const ends = states.filter((x) => terminal(x.id)).sort((a, b) => a.order - b.order);
    const stOut = (x: typeof states[0]) => {
      const site = R.site(x.el);
      const row: Any = {
        id: `${cardId}#${x.id}`,
        element: x.id,
        keyword: "state",
        title: x.title,
        qname: R.qname(x.el),
        file: site.file,
        line: site.line,
        col: site.col,
        rank: rankOf(x.id) === -1 ? null : rankOf(x.id),
        initial: x.id === initial,
        terminal: terminal(x.id),
        inherited: x.inherited,
        out: (outE.get(x.id) ?? []).map((e) => {
          const ts = R.site(e.el);
          return {
            id: `${cardId}#${e.id}`,
            element: e.id,
            name: e.name,
            on: e.on,
            guard: e.guard,
            to: `${cardId}#${e.to}`,
            toTitle: sid.get(e.to)!.title,
            back: !!e.back,
            inherited: e.inherited,
            file: ts.file,
            line: ts.line,
          };
        }),
      };
      return row;
    };
    const ext = lineage.slice(1, 2).map((g) => ({ title: R.name(g) ?? "?", qname: R.qname(g) }));
    return {
      initial: initial ? `${cardId}#${initial}` : null,
      extends: ext[0] ?? null,
      states: [...main, ...ends].map(stOut),
      mainCount: main.length,
      transitions: edges.length,
    };
  };

  // ───────────────────────── columns ─────────────────────────
  const columns: { id: string; title: string; rule: Any; items: Item[] }[] = [];
  const cardById = new Map<string, Item>();
  const pushCard = (col: Item[], colId: string, it: Item) => {
    col.push(it);
    cardById.set(it.id, it);
    registerTree(it, colId, it.id);
  };
  const qnameOf = (n: ShapeNode | undefined) => n?.qualifiedName ?? "?";
  void qnameOf;

  const actionCard = (el: Any, id: string, composite: boolean, label: string): Item => {
    const it = mkBase(el, id, "capability");
    typeDocSummary(it, el);
    const g = groupOf(el, composite);
    if (g.length) it.group = g;
    const typ = R.typings(el).find((t) => R.mc(t) === "ActionDefinition");
    const flow = buildFlow(id, typ ?? el);
    if (flow && flow.steps.length) {
      it.steps = flow.steps;
      it.flow = flow.stats;
      if (flow.stats.supplemented) {
        diag(D, "BRANCH_SOURCE_SUPPLEMENTED", "info", { card: label, branches: flow.stats.supplemented },
          "Toolkit leaves the source of decision branches empty (Open-MBEE/sysml-toolkit#13); the preceding decision node is used.");
      }
      if (flow.stats.unresolved) {
        diag(D, "FLOW_EDGE_UNRESOLVED", "warning", { card: label, edges: flow.stats.unresolved }, "Check successions whose ends are not members of the action definition.");
      }
    }
    if (typ) {
      const io: Any[] = [];
      for (const m of R.dEls(typ, "ownedFeature")) {
        const dir = R.prop(m, "direction") as string | undefined;
        if (!dir) continue;
        const ty = R.typings(m)[0];
        io.push({ dir, title: R.name(m) ?? "?", type: ty ? R.name(ty) : null, element: R.id(m) });
      }
      if (io.length) it.io = io;
    }
    return it;
  };

  // panels: Team (ASE) or Parts (generic)
  const panelItems: Item[] = [];
  const panelColumnId = mode === "ase" ? "team" : "parts";
  for (const r of rootParts) {
    const el = R.byId(r.id)!;
    if (mode === "ase" && !hasOperatorBelow(el)) {
      diag(D, "ROOT_PART_WITHOUT_OPERATOR", "info", { part: r.qualifiedName }, "Root parts holding no operator are not shown in Team; give one a type conforming to ASECore::Operator to make it a team.");
      continue;
    }
    const p = panelOf(el, r.id, true, r.id);
    if (p) pushCard(panelItems, panelColumnId, p);
  }
  columns.push({
    id: panelColumnId,
    title: mode === "ase" ? "Team" : "Parts",
    rule: mode === "ase"
      ? {
        select: "root PartUsage (owned by a package) whose subtree contains a PartUsage conforming to one of the operator anchors",
        anchors: REGISTRY.operator,
        panels: "child PartUsage among ownedFeature + inheritedFeature, in source order; kept when it is an operator, typed, or contains a kept part; parts conforming to Rules / Can do anchors live in their own column",
        ports: "PortUsage among ownedFeature + inheritedFeature of the part; conjugated port types show their original definition",
      }
      : { select: "root PartUsage (owned by a package); nested PartUsage as panels (own + inherited, source order)" },
    items: panelItems,
  });

  // candidates: usage-level named elements, then type-level features inherited by displayed panels
  interface Cand { el: Any; id: string; mc: string; node?: ShapeNode; composite: boolean; root?: string }
  const cands: Cand[] = [];
  for (const n of shape) {
    if (!usageLevel(n) || isDefinitionMc(n.metaclass) || panelEls.has(n.id) || n.metaclass === "Package") continue;
    cands.push({ el: R.byId(n.id)!, id: n.id, mc: n.metaclass, node: n, composite: false });
  }
  for (const [pid, p] of panelEls) {
    for (const { el: f } of R.effective(p.el)) {
      const o = R.owner(f);
      if (o && R.id(o) === R.id(p.el)) continue; // owned by the usage itself: already scanned
      const mc = R.mc(f);
      // `perform` / `exhibit` usages are reference-like by nature; `ref part|item` features are not configuration
      if (R.isLib(f) || (R.isRef(f) && mc !== "PerformActionUsage" && mc !== "ExhibitStateUsage")) continue;
      if (mc === "PortUsage" || (mc === "PartUsage" && !claimedByRules(f))) continue;
      cands.push({ el: f, id: `${pid}#${R.id(f)}`, mc, composite: true, root: p.root });
    }
  }
  const candScope = new Map<string, string>(); // item id -> Team root id (type-level candidates)
  for (const c of cands) if (c.root) candScope.set(c.id, c.root);

  const cdoName = mode === "ase" ? "cando" : "behaviors";
  const canItems: Item[] = [];
  const ruleCands: Cand[] = [];
  const infoCands: Cand[] = [];
  for (const c of cands) {
    const { el } = c;
    if (c.mc === "PerformActionUsage" || (mode === "generic" && c.mc === "ActionUsage" && c.node && (c.node.owner < 0 || ["Package", "PartUsage"].includes(shape[c.node.owner].metaclass)))) {
      pushCard(canItems, cdoName, actionCard(el, c.id, c.composite, c.node?.qualifiedName ?? c.id));
    } else if (mode === "ase" && c.mc === "ItemUsage" && conformsEl(el, "tool")) {
      const attrs = attrsOf(el);
      const it = mkBase(el, c.id, "tool");
      const t = designated(el, REGISTRY.titleFeature, attrs);
      if (t) it.title = t.value, it.titleSource = t.source;
      const sm = designated(el, REGISTRY.summaryFeature, attrs);
      if (sm) {
        it.summary = cut(sm.value.split("\n")[0], 140).value;
        it.summarySource = `attribute:${sm.source}`;
      }
      const g = groupOf(el, c.composite);
      if (g.length) it.group = g;
      const own = new Set([libFeatureId("ASEExecution::CapabilityContract::kind"), libFeatureId("ASEExecution::CapabilityContract::acceptanceCriteria")].filter(Boolean) as string[]);
      const v = attrValues(el, own, 8);
      if (v.length) it.values = v;
      pushCard(canItems, cdoName, it);
    } else if (mode === "ase" && c.mc === "PartUsage" && conformsEl(el, "skill")) {
      const attrs = attrsOf(el);
      const it = mkBase(el, c.id, "skill");
      const sm = designated(el, REGISTRY.summaryFeature, attrs);
      if (sm) {
        it.summary = `Source ${cut(sm.value, 100).value}`;
        it.summarySource = `attribute:${sm.source}`;
      }
      typeDocSummary(it, el);
      const g = groupOf(el, c.composite);
      if (g.length) it.group = g;
      const v = attrValues(el, new Set(), 8);
      if (v.length) it.values = v;
      pushCard(canItems, cdoName, it);
    } else if (mode === "ase" && (c.mc === "PartUsage" || c.mc === "ItemUsage") && RULE_KEYS.some((k) => conformsEl(el, k))) {
      ruleCands.push(c);
    } else if (mode === "ase" && c.mc === "ItemUsage" && c.node && (c.node.owner < 0 || shape[c.node.owner].metaclass === "Package")) {
      infoCands.push(c); // domain data declared at package level
    }
  }
  if (mode === "ase") {
    for (const n of shape) {
      if (n.metaclass !== "PartDefinition") continue;
      const el = R.byId(n.id)!;
      if (anchors.capabilityType.length && R.conforms(el, anchors.capabilityType) && !anchors.capabilityType.some((a) => a.id === n.id)) {
        const it = mkBase(el, n.id, "capability-type");
        typeDocSummary(it, el);
        pushCard(canItems, cdoName, it);
      }
    }
  }
  columns.push({
    id: cdoName,
    title: mode === "ase" ? "Can do" : "Behaviors",
    rule: mode === "ase"
      ? {
        select: [
          "PerformActionUsage (usage-level or inherited by a displayed part); steps from the typing ActionDefinition",
          "ItemUsage conforming to " + REGISTRY.tool.join(", "),
          "PartUsage conforming to " + REGISTRY.skill.join(", "),
          "PartDefinition conforming to " + REGISTRY.capabilityType.join(", "),
        ],
      }
      : { select: "PerformActionUsage, and ActionUsage owned by a package or a part" },
    items: canItems,
  });

  if (mode === "ase") {
    // Rules: a rule nested in a rule becomes its child; cards are registered once the forest is complete
    const ruleIds = new Set(ruleCands.filter((c) => !c.composite).map((c) => c.id));
    const ruleItem = new Map<string, Item>();
    const ruleKind = (el: Any) =>
      conformsEl(el, "access") ? "access" : conformsEl(el, "mandate") ? "mandate" : conformsEl(el, "authority") ? "authority" : "policy";
    const skipTitleSummary = new Set<string>();
    for (const fq of [...Object.values(REGISTRY.titleFeature), ...Object.values(REGISTRY.summaryFeature)]) {
      const f = libFeatureId(fq);
      if (f) skipTitleSummary.add(f);
    }
    for (const c of ruleCands) {
      const { el } = c;
      const kind = ruleKind(el);
      const attrs = attrsOf(el);
      const it = mkBase(el, c.id, kind);
      const t = designated(el, REGISTRY.titleFeature, attrs);
      if (t) it.title = t.value, it.titleSource = t.source;
      const sm = designated(el, REGISTRY.summaryFeature, attrs);
      if (sm && !it.summary) {
        it.summary = cut(sm.value.split("\n")[0], 160).value;
        it.summarySource = `attribute:${sm.source}`;
      }
      typeDocSummary(it, el);
      const v = attrValues(el, kind === "mandate" ? new Set() : skipTitleSummary, kind === "mandate" ? 11 : 10);
      if (v.length) it.values = v;
      const g = groupOf(el, c.composite).filter((x) => !ruleIds.has(x.element));
      if (g.length) it.group = g;
      ruleItem.set(c.id, it);
    }
    const ruleItems: Item[] = [];
    for (const c of ruleCands) {
      const it = ruleItem.get(c.id)!;
      let parent: Item | undefined;
      if (c.node) {
        for (const a of ancestors(c.node).reverse()) {
          if (ruleItem.has(a.id)) {
            parent = ruleItem.get(a.id);
            break;
          }
        }
      }
      if (parent) (parent.children ??= []).push(it);
      else ruleItems.push(it);
    }
    for (const it of ruleItems) pushCard([], "rules", it), cardById.set(it.id, it);
    columns.push({
      id: "rules",
      title: "Rules",
      rule: {
        select: "PartUsage / ItemUsage conforming to the anchors below; a rule nested in a rule is its child",
        mandate: REGISTRY.mandate,
        policy: REGISTRY.policy,
        access: REGISTRY.access,
        authority: REGISTRY.authority,
      },
      items: ruleItems,
    });
  }

  // ── Guarantees / Requirements & states (both modes) ──
  const guarItems: Item[] = [];
  const guarId = mode === "ase" ? "guarantees" : "requirements";
  const reqNodes = shape.filter((n) => n.metaclass === "RequirementDefinition" || (n.metaclass === "RequirementUsage" && usageLevel(n)));
  const usedDefs = new Set<string>();
  for (const n of reqNodes.filter((x) => x.metaclass === "RequirementUsage")) {
    for (const t of R.typings(R.byId(n.id)!)) usedDefs.add(R.id(t));
  }
  const exprOfConstraint = (c: Any): string | null => {
    const e0 = R.members(c).find((x) => R.mc(x).endsWith("Expression")) ?? R.dEls(c, "ownedFeature").find((x) => R.mc(x).endsWith("Expression"));
    return e0 ? exprText(R, e0) : null;
  };
  for (const n of reqNodes) {
    if (n.metaclass === "RequirementDefinition" && usedDefs.has(n.id)) continue;
    const el = R.byId(n.id)!;
    const it = mkBase(el, n.id, "requirement");
    const req = R.dEls(el, "requiredConstraint");
    const cl = req.map((c, i) => {
      const site = R.site(c);
      return {
        id: `${n.id}#${R.id(c)}`,
        element: R.id(c),
        keyword: "require constraint",
        title: R.name(c) ?? `clause ${i + 1}`,
        qname: R.qname(c),
        file: site.file,
        line: site.line,
        col: site.col,
        expression: exprOfConstraint(c),
      };
    });
    if (cl.length) it.clauses = cl;
    const subj = R.dOne(el, "subjectParameter");
    if (subj) {
      const st = R.typings(subj)[0];
      if (st) it.subject = { title: R.name(st) ?? "?", qname: R.qname(st) };
    }
    typeDocSummary(it, el);
    pushCard(guarItems, guarId, it);
  }
  const assertNodes = shape.filter((n) => n.metaclass === "AssertConstraintUsage" && n.owner >= 0 && ["ActionDefinition", "ActionUsage", "PerformActionUsage", "PartDefinition", "PartUsage"].includes(shape[n.owner].metaclass));
  for (const n of assertNodes) {
    const el = R.byId(n.id)!;
    const it = mkBase(el, n.id, "constraint");
    const text = exprOfConstraint(el);
    const own = shape[n.owner];
    it.type = { title: own.name, qname: own.qualifiedName };
    it.expression = text;
    it.owner = { title: own.name, qname: own.qualifiedName };
    if (!it.summary && text) {
      it.summary = text;
      it.summarySource = "expression";
    }
    pushCard(guarItems, guarId, it);
  }
  const stateDefs = shape.filter((n) => n.metaclass === "StateDefinition");
  const specialized = new Set<string>(); // state defs that another state def specializes
  const stateEl = new Map(stateDefs.map((n) => [n.id, R.byId(n.id)!]));
  for (const a of stateDefs) {
    for (const b of stateDefs) {
      if (a.id !== b.id && R.conforms(stateEl.get(a.id)!, [{ id: b.id, el: stateEl.get(b.id)! }])) specialized.add(b.id);
    }
  }
  for (const n of stateDefs) {
    if (specialized.has(n.id)) continue;
    const el = stateEl.get(n.id)!;
    const it = mkBase(el, n.id, "lifecycle");
    it.track = buildTrack(n.id, el);
    typeDocSummary(it, el);
    pushCard(guarItems, guarId, it);
  }
  columns.push({
    id: guarId,
    title: mode === "ase" ? "Guarantees" : "Requirements & states",
    rule: {
      select: [
        "RequirementDefinition (when no usage-level RequirementUsage is typed by it) and usage-level RequirementUsage; clauses = requiredConstraint",
        "AssertConstraintUsage owned by an action/part definition or usage",
        "StateDefinition that no other StateDefinition specializes (track includes inherited states)",
      ],
    },
    items: guarItems,
  });
  if (mode === "ase") {
    const infoItems: Item[] = [];
    for (const c of infoCands) {
      const it = mkBase(c.el, c.id, "information");
      typeDocSummary(it, c.el);
      const v = attrValues(c.el, new Set(), 8);
      if (v.length) it.values = v;
      pushCard(infoItems, "information", it);
    }
    columns.push({
      id: "information",
      title: "Information",
      rule: { select: "ItemUsage owned by a package that no other column claims (domain data); hidden by the interface when empty", optional: true },
      items: infoItems,
    });
  }

  lap("cards");

  // ───────────────────────── links ─────────────────────────
  const links: Any[] = [];
  const dropped: Any[] = [];
  const linkCount: Record<string, number> = {};
  const addLink = (l: Any) => {
    links.push(l);
    const k = l.role ? `${l.kind}:${l.role}` : l.kind;
    linkCount[k] = (linkCount[k] ?? 0) + 1;
  };
  /** Walk a feature chain from a context (a displayed panel/card); composite ids encode the instantiation path. */
  const resolveChain = (ctx: string | null, ch: Any[]): { id: string; exact: boolean } | undefined => {
    let cur: string | undefined = ctx ?? undefined;
    let last: string | undefined;
    let exact = false;
    ch.forEach((e, i) => {
      const eid = R.id(e);
      const comp = cur ? `${cur}#${eid}` : undefined;
      const hit = comp && board.has(comp) ? comp : board.has(eid) ? eid : undefined;
      if (hit) {
        cur = hit;
        last = hit;
      }
      exact = !!hit && i === ch.length - 1;
    });
    if (last) return { id: last, exact };
    for (let o = R.owner(ch[ch.length - 1]); o; o = R.owner(o)) {
      const oid = R.id(o);
      if (board.has(oid)) return { id: oid, exact: false };
    }
    return undefined;
  };
  /** Contexts in which a relationship declared in `r`'s owner is read. */
  const ctxsFor = (r: Any): (string | null)[] => {
    const o = R.owner(r);
    if (!o) return [null];
    const oid = R.id(o);
    if (board.has(oid)) return [oid];
    if (isDefinitionMc(R.mc(o))) {
      const hits = displayed.filter((d) => R.conforms(d.el, [{ id: oid, el: o }])).map((d) => d.id);
      return hits.length ? hits : [null];
    }
    for (let a: Any | undefined = o; a; a = R.owner(a)) if (board.has(R.id(a))) return [R.id(a)];
    return [null];
  };
  const linkId = (r: Any, ctx: string | null) => (ctx && ctx !== (R.owner(r) ? R.id(R.owner(r)) : "") ? `${R.id(r)}@${ctx}` : R.id(r));
  const relSite = (e: Any) => {
    const st = R.site(e);
    return { file: st.file, line: st.line };
  };
  const userOf = (mc: string) => (s.elementsOfMetaclass(mc) as Any[]).filter((e) => !s.isLibraryElement(e)).map((e) => R.intern(e));

  // allocate
  for (const e of userOf("AllocationUsage")) {
    const a = R.dOne(e, "sourceFeature"), b = R.dEls(e, "targetFeature")[0];
    let any = false;
    for (const ctx of ctxsFor(e)) {
      const A = a && resolveChain(ctx, R.chain(a)), B = b && resolveChain(ctx, R.chain(b));
      if (A && B) {
        any = true;
        addLink({ id: linkId(e, ctx), kind: "allocate", from: A.id, to: B.id, via: R.id(e), ...relSite(e), exact: A.exact && B.exact });
      }
    }
    if (!any) dropped.push({ kind: "allocate", element: R.id(e), ...relSite(e) });
  }
  // connect (via ports)
  for (const e of userOf("ConnectionUsage")) {
    const rf = R.dEls(e, "relatedFeature");
    let any = false;
    for (const ctx of ctxsFor(e)) {
      const A = rf[0] && resolveChain(ctx, R.chain(rf[0])), B = rf[1] && resolveChain(ctx, R.chain(rf[1]));
      if (A && B) {
        any = true;
        addLink({ id: linkId(e, ctx), kind: "connect", from: A.id, to: B.id, via: R.id(e), ...relSite(e), exact: A.exact && B.exact });
      }
    }
    if (!any) dropped.push({ kind: "connect", element: R.id(e), ...relSite(e) });
  }
  // bind (library roles); data bindings inside behaviors are only counted
  let dataBinds = 0;
  const accessInfo = new Map<string, { caller?: string; target?: string; enabled: boolean | null; via: string[] }>();
  for (const e of userOf("BindingConnectorAsUsage")) {
    const rf = R.dEls(e, "relatedFeature");
    if (rf.length < 2) continue;
    const chains = rf.map((f) => R.chain(f));
    let role: string | undefined, subjIdx = -1;
    for (let i = 0; i < 2 && !role; i++) {
      const ch = chains[i], leaf = ch[ch.length - 1];
      const r = roleFeature.get(R.id(leaf)) ?? roleFeature.get(R.rootId(leaf));
      if (r && ch.length >= 2) {
        role = r;
        subjIdx = i;
      }
    }
    if (!role) {
      dataBinds++;
      continue;
    }
    let any = false;
    for (const ctx of ctxsFor(e)) {
      const subject = resolveChain(ctx, chains[subjIdx].slice(0, -1));
      const object = resolveChain(ctx, chains[1 - subjIdx]);
      if (subject && object) {
        any = true;
        addLink({ id: linkId(e, ctx), kind: "bind", role, from: subject.id, to: object.id, via: R.id(e), ...relSite(e), exact: subject.exact && object.exact });
        if (role === "caller" || role === "target") {
          const acc = accessInfo.get(subject.id) ?? { enabled: null, via: [] };
          acc[role] = object.id;
          acc.via.push(R.id(e));
          accessInfo.set(subject.id, acc);
        }
      }
    }
    if (!any) dropped.push({ kind: "bind", role, element: R.id(e), ...relSite(e) });
  }
  // access -> can-call (2-hop composition, flagged derived)
  const enabledFeature = libFeatureId("ASEInvocations::BehaviorAccess::enabled");
  for (const [accId, acc] of accessInfo) {
    const el = R.byId(accId);
    if (el && enabledFeature) {
      const hit = attrsOf(el).find((a) => a.root === enabledFeature);
      acc.enabled = hit && typeof hit.value === "boolean" ? hit.value : null;
    }
    if (acc.caller && acc.target) {
      const st = el ? R.site(el) : { file: "", line: 0 };
      addLink({ id: `${accId}>can-call`, kind: "can-call", derived: true, from: acc.caller, to: acc.target, via: accId, enabled: acc.enabled, file: st.file, line: st.line, exact: true });
    }
  }
  // exhibit
  for (const e of userOf("ExhibitStateUsage")) {
    const o = R.owner(e);
    const ty = R.typings(e)[0] ?? R.dOne(e, "exhibitedState");
    let T: string | undefined;
    if (ty) {
      const tid = R.id(ty);
      if (board.has(tid)) T = tid;
      else {
        for (const it of cardById.values()) {
          if (it.kind === "lifecycle" && R.conforms(R.byId(it.id)!, [{ id: tid, el: ty }])) T = it.id;
        }
      }
    }
    let any = false;
    for (const ctx of ctxsFor(e)) {
      const A = o && (board.has(R.id(o)) ? { id: R.id(o) } : ctx ? { id: ctx } : undefined);
      if (A && T) {
        any = true;
        addLink({ id: linkId(e, ctx), kind: "exhibit", from: A.id, to: T, via: R.id(e), ...relSite(e), exact: true });
      }
    }
    if (!any) dropped.push({ kind: "exhibit", element: R.id(e), ...relSite(e) });
  }
  // satisfy
  const reqCardOf = (reqEl: Any): string | undefined => {
    const rid = R.id(reqEl);
    if (board.has(rid)) return rid;
    for (const t of R.typings(reqEl)) if (board.has(R.id(t))) return R.id(t);
    return undefined;
  };
  for (const e of userOf("SatisfyRequirementUsage")) {
    const r = R.dOne(e, "satisfiedRequirement"), by = R.dOne(e, "satisfyingFeature");
    const B = r && reqCardOf(r);
    let any = false;
    for (const ctx of ctxsFor(e)) {
      const A = by && resolveChain(ctx, R.chain(by));
      if (A && B) {
        any = true;
        addLink({ id: linkId(e, ctx), kind: "satisfy", from: A.id, to: B, via: R.id(e), ...relSite(e), exact: A.exact });
        const rc = cardById.get(B);
        if (rc) rc.satisfiedBy = (rc.satisfiedBy ?? 0) + 1;
      }
    }
    if (!any) dropped.push({ kind: "satisfy", element: R.id(e), ...relSite(e) });
  }
  for (const it of cardById.values()) if (it.kind === "requirement" && it.satisfiedBy === undefined) it.satisfiedBy = 0;
  // subject: a requirement declares the type of system it constrains
  for (const it of cardById.values()) {
    if (it.kind !== "requirement" || !it.subject?.qname) continue;
    const subjEl = s.resolve(it.subject.qname);
    if (!subjEl) continue;
    for (const col of columns) {
      for (const root of col.items) {
        if (root.kind === "scope" && R.conforms(R.byId(root.id)!, [{ id: R.id(subjEl), el: R.intern(subjEl) }])) {
          addLink({ id: `${it.id}>subject>${root.id}`, kind: "subject", from: it.id, to: root.id, via: it.id, file: it.file, line: it.line, exact: true });
        }
      }
    }
  }
  // constrain: assert constraint -> steps typed by the owner definition (or a specialization)
  const constraints = [...cardById.values()].filter((c) => c.kind === "constraint");
  for (const c of constraints) {
    const ownerEl = c.owner?.qname ? s.resolve(c.owner.qname) : undefined;
    if (!ownerEl) continue;
    const oid = R.id(ownerEl);
    const matches = (ty: Any | undefined) => !!ty && (R.id(ty) === oid || R.conforms(ty, [{ id: oid, el: R.intern(ownerEl) }]));
    for (const card of cardById.values()) {
      for (const st of card.steps ?? []) {
        if (!st.element || st.kind === "goto") continue;
        if (matches(R.typings(R.byId(st.element)!)[0])) {
          addLink({ id: `${c.id}>constrain>${st.id}`, kind: "constrain", from: c.id, to: st.id, via: c.id, file: c.file, line: c.line, exact: true });
          c.inForce = true;
        }
      }
      if (card.kind === "capability" && !card.steps?.length && matches(R.typings(R.byId(card.element)!)[0])) {
        addLink({ id: `${c.id}>constrain>${card.id}`, kind: "constrain", from: c.id, to: card.id, via: c.id, file: c.file, line: c.line, exact: true });
        c.inForce = true;
      }
    }
    if (!c.inForce) c.inForce = false;
  }
  // own / perform: nearest displayed container of a card in another column or panel
  const scopeRoots = new Set(panelItems.map((i) => i.id));
  const ownerOf = (id: string): string | undefined => {
    const hash = id.lastIndexOf("#");
    if (hash > 0) return id.slice(0, hash);
    const n = nodeById.get(id);
    if (!n) return undefined;
    for (const a of ancestors(n).reverse()) if (board.has(a.id)) return a.id;
    return undefined;
  };
  for (const col of columns) {
    if (col.id === panelColumnId) continue;
    const walk = (it: Item, parentItem?: Item) => {
      const o = ownerOf(it.id);
      if (o && (!parentItem || o !== parentItem.id)) {
        addLink({ id: `${o}>${it.id}`, kind: it.keyword === "perform action" ? "perform" : "own", from: o, to: it.id, via: null, strength: scopeRoots.has(o) ? "scope" : "direct", file: it.file, line: it.line, exact: true });
      }
      it.children?.forEach((c) => walk(c, it));
    };
    col.items.forEach((it) => walk(it));
  }
  // scope of every card
  for (const col of columns) {
    for (const it of col.items) {
      const rid = candScope.get(it.id);
      if (rid) {
        it.scope = rid;
        continue;
      }
      const n = nodeById.get(it.id);
      if (!n) continue;
      const root = ancestors(n).find((a) => scopeRoots.has(a.id));
      if (root) it.scope = root.id;
    }
  }
  // ports: connection counts
  const portItems = new Map<string, Any>();
  const collectPorts = (x: Item) => {
    for (const p of x.ports ?? []) portItems.set(p.id, p);
    x.children?.forEach(collectPorts);
  };
  panelItems.forEach(collectPorts);
  for (const l of links.filter((x) => x.kind === "connect")) {
    for (const end of [l.from, l.to]) {
      const p = portItems.get(end);
      if (p) p.linked = (p.linked ?? 0) + 1;
    }
  }
  // access chips on the actions they expose
  const itemById = new Map<string, Item>();
  const indexItems = (x: Item) => {
    itemById.set(x.id, x);
    x.children?.forEach(indexItems);
  };
  for (const col of columns) col.items.forEach(indexItems);
  for (const [accId, acc] of accessInfo) {
    if (!acc.target) continue;
    const reg = board.get(acc.target);
    const cardItem = itemById.get(acc.target) ?? (reg ? itemById.get(reg.card) : undefined);
    if (!cardItem) continue;
    (cardItem.access ??= []).push({ access: accId, title: itemById.get(accId)?.title ?? null, caller: acc.caller ?? null, enabled: acc.enabled });
  }
  // stable order of links: kind priority, then source position
  const KIND_ORDER = ["perform", "own", "allocate", "connect", "bind", "can-call", "exhibit", "constrain", "satisfy", "subject"];
  links.sort((a, b) =>
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
    (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0) ||
    String(a.id).localeCompare(String(b.id))
  );
  lap("links");

  // ── scope order: callers before callees (cross-scope can-call), ties by source order ──
  {
    const scopeOfId = (id: string): string | undefined => {
      const reg = board.get(id);
      const card = reg ? cardById.get(reg.card) : undefined;
      return card ? (scopeRoots.has(card.id) ? card.id : card.scope) : undefined;
    };
    const rank = new Map<string, number>();
    const ids = panelItems.map((i) => i.id);
    const edgesOut = new Map<string, Set<string>>();
    for (const l of links) {
      if (l.kind !== "can-call") continue;
      const a = scopeOfId(l.from), b = scopeOfId(l.to);
      if (a && b && a !== b) (edgesOut.get(a) ?? edgesOut.set(a, new Set()).get(a)!).add(b);
    }
    const remaining = [...ids];
    let r = 0;
    while (remaining.length) {
      const pick = remaining.find((x) => !remaining.some((y) => y !== x && edgesOut.get(y)?.has(x))) ?? remaining[0];
      rank.set(pick, r++);
      remaining.splice(remaining.indexOf(pick), 1);
    }
    const byRank = (it: Item) => rank.get(scopeRoots.has(it.id) ? it.id : (it.scope ?? "")) ?? 1e6;
    for (const col of columns) {
      if (col.id === guarId) continue;
      const withPos = col.items.map((it, i) => ({ it, i }));
      withPos.sort((x, y) => byRank(x.it) - byRank(y.it) || x.i - y.i);
      col.items = withPos.map((x) => x.it);
    }
  }

  // ── unclaimed usage-level elements (coverage) ──
  const shown = new Set(board.keys());
  const interesting = new Set(["PartUsage", "PerformActionUsage", "ItemUsage", "AssertConstraintUsage", "RequirementUsage"]);
  const cand = shape.filter((n) => interesting.has(n.metaclass) && usageLevel(n));
  const covered = (n: ShapeNode) => shown.has(n.id) || ancestors(n).some((a) => shown.has(a.id) && a.metaclass !== "Package" && !isDefinitionMc(a.metaclass));
  const unclaimed = cand.filter((n) => !shown.has(n.id));
  // elements below a displayed item are details of that item, not orphans
  const detail = unclaimed.filter(covered);
  const orphans = unclaimed.filter((n) => !covered(n));
  // an unshown element that is the target of a shown access is still reported with its reason
  for (const o of orphans.slice(0, 40)) {
    diag(D, "ELEMENT_NOT_SHOWN", "info", { qname: o.qualifiedName, metaclass: o.metaclass }, "Not matched by any column rule; add its definition to the registry or ignore.");
  }
  if (dropped.length) {
    diag(D, "LINK_ENDPOINT_NOT_SHOWN", "info", { count: dropped.length, byKind: dropped.reduce((a: Any, d) => (a[d.kind] = (a[d.kind] ?? 0) + 1, a), {}) }, "The relationship exists in the model but one end is not a displayed element.");
  }
  if (unresolved.length) {
    diag(D, "ANCHOR_UNRESOLVED", "info", { anchors: unresolved }, "Anchor definitions absent from this model are skipped (expected for a model without that part of the library).");
  }

  const index: Record<string, { column: string; card: string }> = {};
  for (const [id, v] of board) index[id] = v;

  // ── invariants (fail loudly, with codes) ──
  let checked = 0, violations = 0;
  const violate = (code: string, context: Record<string, unknown>) => {
    violations++;
    diag(D, code, "error", context, "Projection bug: the board must never expose a thing without source, or a link to something not displayed.");
  };
  const seenLinks = new Set<string>();
  for (const l of links) {
    checked += 3;
    if (seenLinks.has(l.id)) violate("DUPLICATE_LINK_ID", { link: l.id });
    seenLinks.add(l.id);
    for (const end of [l.from, l.to]) if (!board.has(end)) violate("LINK_ENDPOINT_UNKNOWN", { link: l.id, end });
  }
  const needsSource = (x: Any, where: string) => {
    checked++;
    if (!x.element || !x.file || !(x.line > 0)) violate("THING_WITHOUT_SOURCE", { id: x.id, title: x.title, where });
  };
  const walkSources = (it: Item) => {
    needsSource(it, "item");
    it.ports?.forEach((p) => needsSource(p, "port"));
    it.steps?.forEach((st) => st.kind !== "goto" && st.element && needsSource(st, "step"));
    it.track?.states?.forEach((st: Any) => needsSource(st, "state"));
    it.clauses?.forEach((c) => needsSource(c, "clause"));
    it.children?.forEach(walkSources);
  };
  for (const col of columns) col.items.forEach(walkSources);

  const total = performance.now();
  void total;
  const counts = {
    files: Object.keys(sources).length,
    namedElements: shape.length,
    items: columns.map((c) => ({ column: c.id, items: c.items.length })),
    nested: {
      ids: board.size,
      panels: countPanels(columns.find((c) => c.id === panelColumnId)?.items ?? []),
      ports: [...cardById.values()].reduce((a, c) => a + countPorts(c), 0),
      steps: [...cardById.values()].reduce((a, c) => a + (c.steps?.length ?? 0), 0),
      states: [...cardById.values()].reduce((a, c) => a + (c.track?.states?.length ?? 0), 0),
      clauses: [...cardById.values()].reduce((a, c) => a + (c.clauses?.length ?? 0), 0),
    },
    links: linkCount,
    linksTotal: links.length,
    dataBindsIgnored: dataBinds,
    droppedLinks: dropped.length,
    coverage: { candidates: cand.length, shown: cand.length - unclaimed.length, details: detail.length, orphans: orphans.length },
    orphans: orphans.map((o) => ({ qname: o.qualifiedName, metaclass: o.metaclass })),
    toolkitCalls: Object.values(R.callsByMethod).reduce((a, b) => a + b, 0),
    toolkitCallsByMethod: Object.fromEntries(Object.entries(R.callsByMethod).sort(([, a], [, b]) => b - a).slice(0, 12)),
    invariants: { checked, violations },
  };
  function countPanels(xs: Item[]): number {
    return xs.reduce((a, x) => a + 1 + countPanels(x.children ?? []), 0);
  }
  function countPorts(c: Item): number {
    return (c.ports?.length ?? 0) + (c.children ?? []).reduce((a, x) => a + countPorts(x), 0);
  }


  // Top-level user packages with their documentation: where a model states its purpose.
  const packages = userOf("Package").filter((p) => { const q = R.qname(p); return q && !q.includes("::"); }).map((p) => {
    const doc = R.doc(p);
    return { qname: R.qname(p), doc: doc ? doc.replace(/\s*\n\s*\*?\s*/g, " ").replace(/\s+/g, " ").trim() : null, ...relSite(p) };
  });
  return { mode, columns, links, index, counts, dropped, D, T, packages, anchors: Object.fromEntries(Object.entries(anchors).map(([k, v]) => [k, v.map((a) => a.qname)])), R, lap, shape };
}

// ───────────────────────────── main ─────────────────────────────────────────
function arg(name: string, all = false): string[] {
  const out: string[] = [];
  for (let i = 0; i < Deno.args.length; i++) {
    if (Deno.args[i] === `--${name}` && Deno.args[i + 1]) out.push(Deno.args[i + 1]);
  }
  return all ? out : out.slice(0, 1);
}

const FIELD_SOURCES = {
  id: "Session.elementId (UUIDv5, stable for the same qualified name); steps/ports/states are `<card id>#<SysML element id>`",
  element: "Session.elementId of the SysML element behind the item",
  keyword: "Session.metaclass mapped through the closed SysML keyword table",
  title: "derived(e,'name'); tool: value of the library attribute CapabilityContract::kind; access: BehaviorAccess::name (found by redefinition root)",
  summary: "firstSentence(Session.docs(e)); else a designated library attribute (access description, mandate scope, contract criteria); else docs of the typing definition",
  qname: "Session.qualifiedName",
  "file:line:col": "Session.declarationSite (fallback memberExtent) + Session.units() byte offset to line",
  type: "Session.typings(e)[0]",
  "ports": "PortUsage in ownedFeature + inheritedFeature; type via typings (ConjugatedPortDefinition -> originalPortDefinition)",
  "steps": "members of the typing ActionDefinition: SuccessionAsUsage(sourceFeature,targetFeature), TransitionUsage(source,target,guardExpression), DecisionNode/MergeNode/ForkNode/JoinNode",
  "guard": "text rebuilt from the guard expression tree (OperatorExpression.operator, FeatureChainExpression, FeatureReferenceExpression, Literal*), never from source text",
  "track": "StateUsage/TransitionUsage among ownedFeature+inheritedFeature of the StateDefinition; entryAction + succession for the initial state; trigger = type of accept payload",
  "clauses": "derived(requirement,'requiredConstraint') + expression tree",
  "values": "AttributeUsage members evaluated (Session.evaluate), library feature found by redefinitionRoot",
  "links": "AllocationUsage/ConnectionUsage/BindingConnectorAsUsage.relatedFeature (chainingFeature for paths), ExhibitStateUsage, SatisfyRequirementUsage, ownership",
};

// Label of a link seen from each end: what the lit card shows next to its title (no line is drawn).
const LINK_LABELS: Record<string, { forward: string; reverse: string; derived?: boolean }> = {
  "allocate": { forward: "performed by", reverse: "performs" },
  "connect": { forward: "connected to", reverse: "connected to" },
  "bind:caller": { forward: "called by", reverse: "calls through" },
  "bind:target": { forward: "exposes", reverse: "exposed by" },
  "bind:mandate": { forward: "holds mandate", reverse: "mandate of" },
  "bind:holder": { forward: "held by", reverse: "holds" },
  "bind:issuer": { forward: "issued by", reverse: "issues" },
  "can-call": { forward: "may call", reverse: "callable by", derived: true },
  "exhibit": { forward: "exhibits lifecycle", reverse: "exhibited by" },
  "constrain": { forward: "constrains", reverse: "constrained by" },
  "satisfy": { forward: "satisfies", reverse: "satisfied by" },
  "subject": { forward: "applies to", reverse: "subject of" },
  "perform": { forward: "performs", reverse: "performed within" },
  "own": { forward: "contains", reverse: "contained in" },
};
const MODE_RULE = "mode = ase when at least one root PartUsage (owned by a package) has, in its subtree, a PartUsage that Session.conforms to ASECore::Operator, ASECore::HumanOperator or ASECore::SoftwareOperator; otherwise generic";

async function main() {
  const out = arg("out")[0] ?? HERE;
  const pkg = arg("toolkit")[0] ?? DEFAULT_PKG;
  const only = arg("only")[0];
  const models: Record<string, string> = { ...DEFAULT_MODELS };
  for (const m of arg("model", true)) {
    const i = m.indexOf("=");
    models[m.slice(0, i)] = m.slice(i + 1);
  }
  const t0 = performance.now();
  const tk = await loadToolkit(pkg);
  const summary: Any[] = [];
  for (const [name, spec] of Object.entries(models)) {
    if (only && only !== name) continue;
    try {
      const sources = await readSources(spec);
      const repeat = Math.max(1, Number(arg("repeat")[0] ?? "1"));
      const runs: number[] = [];
      let P!: Awaited<ReturnType<typeof project>>;
      for (let i = 0; i < repeat; i++) {
        const tm = performance.now();
        P = await project(tk, name, sources, (arg("mode")[0] as "ase" | "generic" | undefined));
        runs.push(Math.round((performance.now() - tm) * 10) / 10);
      }
      P.T.total = runs[runs.length - 1];
      if (repeat > 1) (P.T as Any).runs = runs;
      const doc = {
        schema: "ase.board/1",
        meta: {
          model: name,
          mode: P.mode,
          toolkit: { version: tk.version },
          sourceDigest: await sha256(Object.entries(sources).map(([k, v]) => `${k}\n${v}`).join("\n\u0000\n")),
          modeRule: MODE_RULE,
          anchors: P.anchors,
          linkLabels: LINK_LABELS,
          counts: P.counts,
          packages: P.packages,
          diagnostics: P.D,
          fieldSources: FIELD_SOURCES,
          timingMs: P.T,
        },
        columns: P.columns,
        links: P.links,
        index: P.index,
      };
      // determinism: digest of the document without timings
      const digest = await sha256(JSON.stringify({ columns: doc.columns, links: doc.links, index: doc.index }));
      (doc.meta as Any).digest = digest;
      const file = `${out}/board-${name}${arg("mode")[0] ? "-" + arg("mode")[0] : ""}.json`;
      await Deno.writeTextFile(file, JSON.stringify(doc, null, 1));
      summary.push({ model: name, status: "ok", file, mode: P.mode, ms: P.T.total, runs: repeat > 1 ? runs : undefined, phases: P.T, invariants: P.counts.invariants, digest: digest.slice(0, 12), bytes: JSON.stringify(doc).length, items: P.counts.items, links: P.counts.linksTotal });
    } catch (e) {
      const err = (e as Any)?.code ? e as Any : { code: "PROJECTION_FAILED", context: { model: name, message: String((e as Error)?.stack ?? e).slice(0, 800) }, recovery: "See context.message" };
      summary.push({ model: name, status: "error", ...err });
    }
  }
  const totalMs = Math.round(performance.now() - t0);
  const doc = { toolkitLoadMs: Math.round(tk.loadMs), totalMs, runs: summary };
  console.log(JSON.stringify(doc));
  if (summary.some((r) => r.status === "error")) Deno.exit(2);
  Deno.exit(0);
}

if (import.meta.main) await main();
