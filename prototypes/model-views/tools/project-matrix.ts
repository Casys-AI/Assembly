/**
 * Authority matrix projector (prototype, read-only on every repository).
 *
 * Produces `ase.authority-matrix/1` JSON: operators x capabilities, each cell
 * { state, mode, basis, sources[], via?, scope?, codes[], uncertain? }.
 *
 * Principle ("read authority where the model declares it, no recomputation in
 * the interface"):
 *   - STATE comes from ASE's own compilers (ExecutableModel, NativeAuthority,
 *     compileBehaviorCatalog, delegation resolver). Nothing is re-derived from
 *     SysML text and no name heuristic is used to decide a right.
 *   - SOURCES (qualified name, file, line) come from the Toolkit: the native
 *     element ids carried by the compilers are resolved through the normalised
 *     Toolkit interchange (`sysx:source*`, built from Toolkit `memberExtent`)
 *     and cross-checked against direct Toolkit `rows`/`units` calls.
 *   - What a compiler drops (disabled exposures) is read back from the typed
 *     Toolkit graph and flagged `origin: "projector-fallback"`.
 *
 * Usage:
 *   deno run --config <app>/deno.json --no-lock --allow-read --allow-write=<out> --allow-env \
 *     project-matrix.ts [--app <repository root>] [--toolkit <package dir>] \
 *                       [--out <dir>] [--only demo-ase,commercial-watch,initial] \
 *                       [--fixtures <matrix-fixtures.ts>] [--suffix <text>]
 *
 *   Default: the three real models (demo-ase, commercial-watch, initial) ->
 *   matrix-<name>.json. `--fixtures` adds two SYNTHETIC models (reviewer + policies,
 *   delegation) that exercise paths absent from the real models. `--app` may point
 *   to another checkout (e.g. the authority lot-1 worktree) to compare compilers.
 *
 * Output is deterministic: same sources => same JSON (no timestamp, sorted).
 */

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const MATRIX_SCHEMA = "ase.authority-matrix/1" as const;

export type CellState =
  | "allowed"
  | "propose-only"
  | "denied"
  | "delegated"
  | "inherited";
/** Mirrors the planned typed `ASEAuthority::GrantMode`. */
export type GrantMode = "execute" | "propose" | "review" | "admit";
/** Why the state holds: a declaration, the absence of one, or a TS host rule. */
export type Basis = "declared" | "closed-world" | "host-rule";
export type SourceRole =
  | "grant"
  | "flag"
  | "scope"
  | "exposure"
  | "binding"
  | "allocation"
  | "condition"
  | "holder"
  | "target"
  | "root";

export interface SourceRef {
  role: SourceRole;
  elementId: string;
  qname: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
}
export type Via =
  | { kind: "own-declaration" }
  | { kind: "unit-configuration"; attribute: string }
  | { kind: "exposure"; accessName: string; accessId: string }
  | {
    kind: "delegation";
    record: string;
    revision: number;
    issuerSystem: string;
    chainDigest: string;
    /** Root policy first, then each delegation down to the holder. */
    chain: Array<
      { kind: "root" | "delegation"; id: string; revision: number; system: string }
    >;
  }
  | { kind: "root-grant"; grant: string; mandate: string }
  | { kind: "host-rule"; rule: string; enforcedAt: string };

export interface Cell {
  row: string;
  column: string;
  state: CellState;
  /** The three-way reading for the interface, derived here so no view recomputes it:
   * denied -> denied; mode propose -> propose-only; otherwise allowed. */
  display: "allowed" | "propose-only" | "denied";
  /** Strongest mode held; null when denied. Matches the typed Grant.mode. */
  mode: GrantMode | null;
  basis: Basis;
  sources: SourceRef[];
  via?: Via;
  /** Bounds that qualify the right (hosts, file/roots, scopes, limits). */
  scope?: Record<string, unknown>;
  /** Machine-readable qualifiers; no prose. */
  codes: string[];
  /** Never guessed: the state or its effect cannot be asserted from the model. */
  uncertain?: { code: string; reason: string };
  /** "compiler" = read from an ASE compiler output; fallback = Toolkit read. */
  origin: "compiler" | "projector-fallback" | "host-rule";
}

export type GroupId =
  | "tools"
  | "admission"
  | "mandate"
  | "model"
  | "memory-skills"
  | "behaviors";
export interface Group {
  id: GroupId;
  label: string;
  order: number;
}
export interface Column {
  id: string;
  group: GroupId;
  /** Capability name in the vocabulary of autorite-typee-et-docteur.md. */
  capability: string;
  /** True when the capability exists in the typed plan's ASECapabilities. */
  inTypedPlan: boolean;
  label: string;
  /** Best mode a full holder has (a cell can hold less). */
  mode: GrantMode;
  /** Declared at one place per instance (a column) or only as scope detail. */
  target?: { kind: "tool-kind" | "change" | "entry-kind"; ref: string; unit?: string };
  /** "detail" columns may be folded by default in the interface. */
  tier: "core" | "detail";
  /** Natural reading order inside the group (stable, data-independent). */
  order: number;
  /** Scope type that will carry this column's bounds in the typed authority plan. */
  typedScope: "NetworkScope" | "ModelScope" | "MandateScope" | "none" | "missing-in-plan";
  doc: string;
}
export interface Row {
  id: string;
  kind: "software" | "human";
  role: "builder" | "reviewer" | "owner";
  label: string;
  unit: string;
  /** False when the row is a host fact the model does not declare (legacy owner). */
  declared: boolean;
  element: SourceRef | null;
  endpoint?: { name: string; primary: boolean; humanInput: boolean };
  limits?: Record<string, number | string>;
  /** Same real person across units (legacy local owner). */
  principal?: string;
}
export interface Diagnostic {
  code: string;
  severity: "info" | "warning";
  context: Record<string, unknown>;
  recovery?: string;
}
export interface DelegationStatus {
  id: string;
  revision: number;
  issuerSystem: string;
  targetSystem: string;
  active: boolean;
  reason: string | null;
}
export interface AuthorityMatrix {
  schema: typeof MATRIX_SCHEMA;
  model: {
    name: string;
    sourceDigest: string;
    toolkit: string;
    /** legacy-v1: owner implicit. owner-modeled: lot-1 RootAuthority declared. */
    authoritySchema: "legacy-v1" | "owner-modeled";
    units: Array<{ system: string; executionDigest: string }>;
  };
  groups: Group[];
  rows: Row[];
  columns: Column[];
  cells: Cell[];
  delegations: DelegationStatus[];
  diagnostics: Diagnostic[];
  caveats: string[];
  summary: {
    byState: Record<CellState, number>;
    uncertain: number;
    hostRule: number;
    byRow: Record<string, Record<CellState, number>>;
    /** Coordinates re-read through direct Toolkit calls (rows/memberExtent + units). */
    coordinates: { checked: number; mismatches: number };
  };
  digest: string;
}

// ---------------------------------------------------------------------------
// Host rules that no SysML declaration expresses (verified in src/, file:line)
// ---------------------------------------------------------------------------

const RULES = {
  humanAdmission: {
    rule: "human-decides-candidate-admission-when-admissionMode-is-human",
    enforcedAt:
      "src/application/candidate-decisions.ts:78-81; src/domain/governance.ts:336-343",
  },
  humanApprovesChange: {
    rule: "human-approves-mandate-change-the-model-policy-allows",
    enforcedAt:
      "src/domain/governance.ts:248-296; src/adapters/source-model.ts:1509-1590",
  },
  localOwnerModel: {
    rule: "local-owner-bypasses-operator-edit-scope",
    enforcedAt: "src/adapters/model-source-authorization.ts:108-113",
  },
  ownerRevisions: {
    rule: "only-local-owner-proposes-decides-and-adopts-through-http",
    enforcedAt: "src/adapters/model-revisions-http.ts:249-437",
  },
} as const;

const GROUPS: Group[] = [
  { id: "tools", label: "Tools", order: 1 },
  { id: "admission", label: "Admission", order: 2 },
  { id: "mandate", label: "Mandate & operators", order: 3 },
  { id: "model", label: "Model", order: 4 },
  { id: "memory-skills", label: "Memory & skills", order: 5 },
  { id: "behaviors", label: "Exposed behaviors", order: 6 },
];

const INFO_KINDS = [
  "context-evidence",
  "memory-capture",
  "memory-recall",
  "memory-revise",
  "memory-review",
  "memory-withdraw",
  "skill-install",
  "skill-list",
  "skill-load",
  "skill-unload",
] as const;
const WORK_KINDS = [
  "work-plan",
  "inbox",
  "reuse-tool",
  "published-tools",
  "inspect-work-artifacts",
] as const;
const KIND_LABEL: Record<string, string> = {
  "context-evidence": "Read evidence",
  "memory-capture": "Memory · capture",
  "memory-recall": "Memory · recall",
  "memory-revise": "Memory · revise",
  "memory-review": "Memory · review",
  "memory-withdraw": "Memory · withdraw",
  "skill-install": "Skills · install",
  "skill-list": "Skills · list",
  "skill-load": "Skills · load",
  "skill-unload": "Skills · unload",
  "work-plan": "Run a work plan",
  "inbox": "Hand over work",
  "reuse-tool": "Reuse a published tool",
  "published-tools": "List published tools",
  "inspect-work-artifacts": "Inspect work artifacts",
  "native-action": "Native action",
};
// tool kind -> ConfiguredMandate boolean (only used to LOCATE the declaration;
// the state comes from NativeMandate.mayPropose).
const KIND_FLAG: Record<string, string> = {
  read_web_page: "mayProposeReadWebPage",
  read_web_page_outline: "mayProposeReadWebPageOutline",
};

// ---------------------------------------------------------------------------
// Loading the ASE compilers (never modified) from any app root
// ---------------------------------------------------------------------------

type Raw = Record<string, any>;

interface Ase {
  ToolkitCompiler: any;
  loadSysmlToolkit: any;
  loadInitialSources: any;
  validateSourceExecutables: any;
  compileNativeAuthority: any;
  sourceSnapshot: any;
  sourceLiterals: any;
  compileBehaviorCatalog: any;
  readModelDelegations: any;
  renderModelDelegations: any;
  migrateExplicitReviewerPromotionSources: any;
  delegationIdentity: any;
  resolveModelDelegations: any;
  executionDigest: any;
  TOOL_KINDS: readonly string[];
  MAX_NETWORK_HOSTS: number;
  MAX_NETWORK_HOST_ADDITIONS: number;
}

async function loadAse(app: string): Promise<Ase> {
  const m = (p: string) => import(`file://${app}/src/${p}`);
  const [tc, tl, sm, em, sg, bc, dl, ds, dm, dg, ty, np] = await Promise.all([
    m("adapters/toolkit-compiler.ts"),
    m("adapters/sysml-toolkit-loader.ts"),
    m("adapters/source-model.ts"),
    m("adapters/execution-model.ts"),
    m("adapters/source-graph.ts"),
    m("adapters/behavior-catalog.ts"),
    m("adapters/model-delegation-ledger.ts"),
    m("adapters/model-delegation-state.ts"),
    m("domain/model-delegation.ts"),
    m("domain/execution-digest.ts"),
    m("domain/types.ts"),
    m("domain/network-policy.ts"),
  ]);
  return {
    ToolkitCompiler: tc.ToolkitCompiler,
    loadSysmlToolkit: tl.loadSysmlToolkit,
    loadInitialSources: sm.loadInitialSources,
    validateSourceExecutables: sm.validateSourceExecutables,
    compileNativeAuthority: em.compileNativeAuthority,
    sourceSnapshot: sg.sourceSnapshot,
    sourceLiterals: sg.sourceLiterals,
    compileBehaviorCatalog: bc.compileBehaviorCatalog,
    readModelDelegations: dl.readModelDelegations,
    renderModelDelegations: dl.renderModelDelegations,
    migrateExplicitReviewerPromotionSources:
      sm.migrateExplicitReviewerPromotionSources,
    delegationIdentity: ds.delegationIdentity,
    resolveModelDelegations: dm.resolveModelDelegations,
    executionDigest: dg.executionDigest,
    TOOL_KINDS: ty.TOOL_KINDS,
    MAX_NETWORK_HOSTS: np.MAX_NETWORK_HOSTS,
    MAX_NETWORK_HOST_ADDITIONS: np.MAX_NETWORK_HOST_ADDITIONS,
  };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export interface ProjectInput {
  name: string;
  sources: Record<string, string>;
}
export interface ProjectContext {
  ase: Ase;
  toolkitDir: string;
  projectId: string;
}

const STATES: CellState[] = [
  "allowed",
  "propose-only",
  "denied",
  "delegated",
  "inherited",
];
const zero = (): Record<CellState, number> =>
  Object.fromEntries(STATES.map((s) => [s, 0])) as Record<CellState, number>;

export async function projectAuthorityMatrix(
  ctx: ProjectContext,
  input: ProjectInput,
): Promise<AuthorityMatrix> {
  const { ase } = ctx;
  const compiler = new ase.ToolkitCompiler({
    packageDir: ctx.toolkitDir,
    loadRuntime: () => ase.loadSysmlToolkit(ctx.toolkitDir),
  });
  // 1. Toolkit -> normalised interchange (ASE's own compiler).
  const compiled = await compiler.compile(input.sources);
  const elements: Raw[] = compiled.elements;
  const revision = {
    version: `scratch:${input.name}`,
    sources: input.sources,
    elements,
  };
  // 2. ASE executable models, one per ConversationSystem (fail-closed).
  const units: Array<{ unit: Raw; model: Raw }> = await ase
    .validateSourceExecutables(revision, ctx.projectId);
  const managedIds = units.map((u) => u.model.identity.systemId as string);
  const rootId = units[0]!.model.identity.rootId as string;
  const snapshot = ase.sourceSnapshot(elements, rootId);
  const literals: Raw[] = ase.sourceLiterals(elements);
  const rawById = new Map<string, Raw>(elements.map((e) => [e["@id"], e]));
  const snapById = new Map<string, Raw>(
    snapshot.elements.map((e: Raw) => [e.id, e]),
  );

  const diagnostics: Diagnostic[] = [];
  const diag = (d: Diagnostic) => diagnostics.push(d);

  // -- source resolution (Toolkit coordinates) -----------------------------
  const locate = (id: string, role: SourceRole): SourceRef => {
    const start = rawById.get(id);
    let cur = start;
    let guard = 0;
    while (cur && typeof cur["sysx:sourceLine"] !== "number" && guard++ < 32) {
      const ownerId = cur.owner?.["@id"];
      cur = ownerId ? rawById.get(ownerId) : undefined;
    }
    return {
      role,
      elementId: id,
      qname: (start?.qualifiedName as string | undefined) ?? null,
      file: (cur?.["sysx:sourceDocument"] as string | undefined) ?? null,
      line: (cur?.["sysx:sourceLine"] as number | undefined) ?? null,
      column: (cur?.["sysx:sourceColumn"] as number | undefined) ?? null,
    };
  };
  const literalIndex = new Map<string, Raw>();
  for (const l of literals) literalIndex.set(`${l.owner}\u0000${l.name}`, l);
  /** Declaration of `owner.name = literal` (the attribute usage). */
  const lit = (
    owner: string | undefined,
    name: string,
    role: SourceRole = "flag",
  ): SourceRef[] => {
    if (!owner) return [];
    const l = literalIndex.get(`${owner}\u0000${name}`);
    return l ? [locate(l.attributeId, role)] : [];
  };
  const dedupe = (refs: SourceRef[]): SourceRef[] => {
    const seen = new Set<string>();
    return refs.filter((r) => {
      const k = `${r.role}|${r.elementId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  // -- per-unit facts ------------------------------------------------------
  interface UnitFacts {
    qname: string;
    model: Raw;
    native: Raw;
    id: Raw;
    execPolicyOwner?: string;
    operators: Array<{ id: string; role: "builder" | "reviewer" }>;
    exposures: Map<string, Raw[]>;
  }
  const facts: UnitFacts[] = [];
  for (const { unit, model } of units) {
    const identity = model.identity as Raw;
    const native = ase.compileNativeAuthority(snapshot, literals, identity);
    // Locator only: the ExecutionPolicy occurrence under the `conversation` action.
    const conversation = snapshot.elements.find((e: Raw) =>
      e.ownerId === identity.systemId && e.name === "conversation" &&
      e.metaclass === "PerformActionUsage"
    );
    const policyItem = conversation && snapshot.elements.find((e: Raw) =>
      e.ownerId === conversation.id && e.name === "executionPolicy" &&
      e.metaclass === "ItemUsage"
    );
    const operators: UnitFacts["operators"] = [{
      id: identity.builderId,
      role: "builder",
    }];
    if (identity.reviewerId) {
      operators.push({ id: identity.reviewerId, role: "reviewer" });
    }
    const exposures = new Map<string, Raw[]>();
    for (const op of operators) {
      // ASE's compiler, parameterised by the operator (the builder slot).
      exposures.set(
        op.id,
        ase.compileBehaviorCatalog(
          revision,
          { ...identity, builderId: op.id },
          managedIds,
        ),
      );
    }
    // Consistency: the builder's exposures equal the executable model's.
    const compiledBuilder = JSON.stringify(
      (model.behaviors ?? []).map((b: Raw) => b.id).sort(),
    );
    const mine = JSON.stringify(
      exposures.get(identity.builderId)!.map((b) => b.id).sort(),
    );
    if (compiledBuilder !== mine) {
      diag({
        code: "EXPOSURE_MISMATCH",
        severity: "warning",
        context: { unit: unit.systemQualifiedName },
        recovery: "compare compileBehaviorCatalog with ExecutableModel.behaviors",
      });
    }
    facts.push({
      qname: unit.systemQualifiedName,
      model,
      native,
      id: identity,
      execPolicyOwner: policyItem?.id,
      operators,
      exposures,
    });
  }

  // delegation chain (ASE resolver, reconstructed exactly as applyModelDelegations does)
  const records: Raw[] = ase.readModelDelegations(input.sources);
  const roots: Raw[] = [];
  const identities: Raw[] = [];
  for (const f of facts) {
    const identity = ase.delegationIdentity(f.qname, f.model, revision);
    identities.push(identity);
    if (f.model.modelAdministrationPolicy) {
      roots.push({ ...identity, ...f.model.modelAdministrationPolicy });
    }
  }
  const delegations: DelegationStatus[] = [];
  if (roots.length || records.length) {
    const resolved = await ase.resolveModelDelegations(roots, records, identities);
    for (const s of resolved.statuses as Raw[]) {
      const rec = records.find((x) => x.id === s.id && x.revision === s.revision);
      delegations.push({
        id: s.id,
        revision: s.revision,
        issuerSystem: rec?.issuerSystem ?? "",
        targetSystem: rec?.targetSystem ?? "",
        active: !!s.active,
        reason: s.reason ?? null,
      });
    }
  }
  function chainOf(recordId: string): Array<
    { kind: "root" | "delegation"; id: string; revision: number; system: string }
  > {
    const out: Array<
      { kind: "root" | "delegation"; id: string; revision: number; system: string }
    > = [];
    const seen = new Set<string>();
    let cur = records.find((r) => r.id === recordId);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.unshift({
        kind: "delegation",
        id: cur.id,
        revision: cur.revision,
        system: cur.targetSystem,
      });
      if (cur.parent.kind === "root") {
        out.unshift({
          kind: "root",
          id: cur.parent.id,
          revision: cur.parent.revision,
          system: cur.issuerSystem,
        });
        break;
      }
      cur = records.find((r) => r.id === cur!.parent.id);
    }
    return out;
  }
  function delegationVia(recordId: string, revisionNo: number, chainDigest: string): Via {
    const rec = records.find((r) => r.id === recordId);
    return {
      kind: "delegation",
      record: recordId,
      revision: revisionNo,
      issuerSystem: String(rec?.issuerSystem ?? ""),
      chainDigest,
      chain: chainOf(recordId),
    };
  }
  /** Sources of a delegated right: the ledger attribute and the issuing root policy. */
  const ledgerSources = (recordId: string): SourceRef[] => {
    const ledger = snapshot.elements.find((e: Raw) =>
      e.qualifiedName === "ASEModelDelegations::records"
    );
    const chain = chainOf(recordId);
    const rootSystem = chain.find((c) => c.kind === "root")?.system;
    const issuer = facts.find((f) => f.qname === rootSystem);
    const rootPolicy = issuer?.model.modelAdministrationPolicy as Raw | undefined;
    return [
      ...(ledger ? [locate(ledger.id, "grant")] : []),
      ...(rootPolicy ? [locate(rootPolicy.elementId, "root")] : []),
    ];
  };

  // operator-entry index across units (target action -> kind, owning unit)
  const unitOf = new Map<string, string>();
  const systemQname = new Map(facts.map((f) => [f.id.systemId as string, f.qname]));
  const unitOfElement = (id: string): string | undefined => {
    if (unitOf.has(id)) return unitOf.get(id);
    let cur = snapById.get(id);
    let guard = 0;
    while (cur && guard++ < 64) {
      const q = systemQname.get(cur.id);
      if (q) {
        unitOf.set(id, q);
        return q;
      }
      cur = snapById.get(cur.ownerId);
    }
    return undefined;
  };
  const entryKind = new Map<string, string>();
  for (const f of facts) {
    for (const e of (f.model.operatorEntries ?? []) as Raw[]) {
      entryKind.set(e.id, e.kind);
    }
  }

  // -- owner provenance (lot 1: modeled; main: implicit) --------------------
  const ownerModeled = facts.some((f) =>
    f.model.ownerAuthority?.ownerSource === "modeled"
  );

  // -- rows ------------------------------------------------------------------
  const rows: Row[] = [];
  for (const f of facts) {
    const owner = f.model.ownerAuthority;
    const modeled = owner?.ownerSource === "modeled";
    rows.push({
      id: `owner@${f.qname}`,
      kind: "human",
      role: "owner",
      label: modeled ? String(owner.operatorId) : "Owner",
      unit: f.qname,
      declared: modeled,
      element: modeled ? locate(owner.operatorNativeId, "holder") : null,
      principal: "local-owner",
    });
    const op = f.model.operator as Raw | undefined;
    const p = f.native.policy as Raw;
    rows.push({
      id: f.id.builderId,
      kind: "software",
      role: "builder",
      label: `${f.qname}::builder`,
      unit: f.qname,
      declared: true,
      element: locate(f.id.builderId, "holder"),
      ...(op
        ? {
          endpoint: {
            name: op.name,
            primary: !!op.primary,
            humanInput: !!op.humanInput,
          },
        }
        : {}),
      limits: {
        maxAgentDecisions: p.maxAgentDecisions,
        maxToolProposals: p.maxToolProposals,
        maxFlowSteps: p.maxFlowSteps,
        urlSelectionMode: p.urlSelectionMode,
      },
    });
    if (f.id.reviewerId) {
      rows.push({
        id: f.id.reviewerId,
        kind: "software",
        role: "reviewer",
        label: `${f.qname}::reviewer`,
        unit: f.qname,
        declared: true,
        element: locate(f.id.reviewerId, "holder"),
      });
    }
  }

  // -- columns ---------------------------------------------------------------
  const columns = new Map<string, Column>();
  const typedScopeOf = (id: string): Column["typedScope"] =>
    id === "network.reach"
      ? "NetworkScope"
      : id === "model.edit" || id === "model.consult"
      ? "ModelScope"
      : id === "model.administer" || id.startsWith("mandate.change:") ||
          id.startsWith("operator.create")
      ? "MandateScope"
      : id.startsWith("tool.build") || id.startsWith("behavior:")
      ? "missing-in-plan"
      : "none";
  const READING_ORDER = [
    "tool.build:",
    "tool.invoke",
    "network.reach",
    "candidate.review",
    "candidate.admit",
    "candidate.activate",
    "mandate.change:network-hosts",
    "mandate.change:url-selection",
    "mandate.change:self-admission",
    "operator.create:reviewer",
    "mandate.rewrite",
    "operator.spawn",
    "model.consult",
    "model.edit",
    "model.administer",
    "model.decide",
    "model.adopt",
  ];
  const unitRank = new Map(facts.map((f, i) => [f.qname, i]));
  const orderOf = (id: string): number => {
    if (id.startsWith("behavior:")) {
      const [kind, unit = ""] = id.slice("behavior:".length).split("@");
      const k = [...INFO_KINDS, ...WORK_KINDS].indexOf(kind as never);
      return 1000 + (k < 0 ? 99 : k) * 100 + (unitRank.get(unit) ?? 0);
    }
    const i = READING_ORDER.findIndex((o) => id === o || id.startsWith(o));
    if (id.startsWith("tool.build:")) {
      return i * 10 + Math.max(0, kinds.indexOf(id.slice("tool.build:".length)));
    }
    return i * 10;
  };
  const col = (c: Omit<Column, "typedScope" | "order">) => {
    if (!columns.has(c.id)) {
      columns.set(c.id, {
        ...c,
        order: orderOf(c.id),
        typedScope: typedScopeOf(c.id),
      });
    }
    return c.id;
  };
  const cells: Cell[] = [];
  const put = (
    row: string,
    column: string,
    c: Omit<Cell, "row" | "column" | "display">,
  ) =>
    cells.push({
      row,
      column,
      ...c,
      display: c.state === "denied"
        ? "denied"
        : c.mode === "propose"
        ? "propose-only"
        : "allowed",
      sources: dedupe(c.sources),
    });

  const denied = (
    basis: Basis,
    sources: SourceRef[],
    extra: Partial<Cell> = {},
  ): Omit<Cell, "row" | "column" | "display"> => ({
    state: "denied",
    mode: null,
    basis,
    sources,
    codes: [],
    origin: basis === "host-rule" ? "host-rule" : "compiler",
    ...extra,
  });

  // Tools -------------------------------------------------------------------
  const kinds = [...ase.TOOL_KINDS];
  for (const kind of kinds) {
    col({
      id: `tool.build:${kind}`,
      group: "tools",
      capability: "ProposeTool",
      inTypedPlan: true,
      label: `Build tool · ${kind}`,
      mode: "propose",
      target: { kind: "tool-kind", ref: kind },
      tier: "core",
      doc:
        "Propose a candidate tool of this kind. A candidate is a proposal: it enters the catalog only after tests and an admission decision.",
    });
  }
  col({
    id: "tool.invoke",
    group: "tools",
    capability: "InvokeTool",
    inTypedPlan: true,
    label: "Use active tools",
    mode: "execute",
    tier: "core",
    doc:
      "Invoke a tool of the active catalog. Bounded by the network scope and the URL selection mode.",
  });
  col({
    id: "network.reach",
    group: "tools",
    capability: "AccessNetwork",
    inTypedPlan: true,
    label: "Reach network hosts",
    mode: "execute",
    tier: "core",
    doc: "Exact DNS hosts the operator's tool invocations may contact.",
  });
  // Admission ---------------------------------------------------------------
  col({
    id: "candidate.review",
    group: "admission",
    capability: "ReviewCandidate",
    inTypedPlan: true,
    label: "Review a tested tool",
    mode: "review",
    tier: "core",
    doc: "Give an approve/refuse opinion on the exact tested digest.",
  });
  col({
    id: "candidate.admit",
    group: "admission",
    capability: "AdmitCandidate",
    inTypedPlan: true,
    label: "Admit a tool",
    mode: "admit",
    tier: "core",
    doc:
      "Decide admission of the exact tested (and reviewed) candidate. Held by exactly one authority per unit (admissionMode).",
  });
  col({
    id: "candidate.activate",
    group: "admission",
    capability: "ActivateCandidate",
    inTypedPlan: false,
    label: "Activate an admitted tool",
    mode: "execute",
    tier: "detail",
    doc:
      "Reserved to the host mechanism that owns the catalog; no operator mandate may hold it (compile-time refusal).",
  });
  // Mandate -----------------------------------------------------------------
  const changeCols: Array<[string, string, string]> = [
    ["network-hosts", "Widen network scope", "mayAddNetworkHosts"],
    ["url-selection", "Change URL selection", "mayChangeUrlSelection"],
    ["self-admission", "Delegate own admission", "mayDelegateOwnAdmission"],
  ];
  for (const [ref, label] of changeCols) {
    col({
      id: `mandate.change:${ref}`,
      group: "mandate",
      capability: "ChangeMandate",
      inTypedPlan: true,
      label,
      mode: "propose",
      target: { kind: "change", ref },
      tier: "core",
      doc:
        "Operators propose this exact change; a human decision applies it. The model policy must allow it.",
    });
  }
  col({
    id: "operator.create:reviewer",
    group: "mandate",
    capability: "CreateOperator",
    inTypedPlan: true,
    label: "Create a reviewer",
    mode: "propose",
    target: { kind: "change", ref: "reviewer" },
    tier: "core",
    doc: "Propose an independent reviewer with the exact review+admit mandate.",
  });
  col({
    id: "mandate.rewrite",
    group: "mandate",
    capability: "ChangeMandate",
    inTypedPlan: true,
    label: "Rewrite own mandate directly",
    mode: "execute",
    tier: "detail",
    doc: "mayChangeOwnMandate: always false (compile-time refusal).",
  });
  col({
    id: "operator.spawn",
    group: "mandate",
    capability: "CreateOperator",
    inTypedPlan: true,
    label: "Create operators directly",
    mode: "execute",
    tier: "detail",
    doc: "mayCreateAgents: always false (compile-time refusal).",
  });
  // Model -------------------------------------------------------------------
  col({
    id: "model.consult",
    group: "model",
    capability: "ConsultModel",
    inTypedPlan: false,
    label: "Read the model sources",
    mode: "execute",
    tier: "core",
    doc:
      "Read model sources and selective model context. Unlocked by the same flag as source proposals (mayProposeSysmlRevision).",
  });
  col({
    id: "model.edit",
    group: "model",
    capability: "EditModel",
    inTypedPlan: true,
    label: "Propose model edits",
    mode: "propose",
    tier: "core",
    doc:
      "Propose source edits inside the (file, qualified roots) ceiling and the listed operations. Proposals are private until decided.",
  });
  col({
    id: "model.administer",
    group: "model",
    capability: "ChangeMandate",
    inTypedPlan: true,
    label: "Delegate edit rights",
    mode: "propose",
    tier: "core",
    doc:
      "Grant or revoke bounded model-edit rights to exact recipient systems (delegation ledger).",
  });
  col({
    id: "model.decide",
    group: "model",
    capability: "DecideModelRevision",
    inTypedPlan: false,
    label: "Accept a model revision",
    mode: "admit",
    tier: "core",
    doc: "Accept or refuse a proposed source revision. Owner HTTP path only.",
  });
  col({
    id: "model.adopt",
    group: "model",
    capability: "AdoptModelVersion",
    inTypedPlan: false,
    label: "Adopt a model version",
    mode: "admit",
    tier: "core",
    doc: "Make an accepted version the executable one. Owner HTTP path only.",
  });

  // Behaviors (dynamic, from compiler-produced exposures + operator entries) --
  const behaviorColumns = new Map<string, { kind: string; unit: string }>();
  const behaviorKey = (kind: string, unit: string) => `behavior:${kind}@${unit}`;
  for (const f of facts) {
    for (const list of f.exposures.values()) {
      for (const b of list) {
        const kind = entryKind.get(b.targetNativeId) ?? "native-action";
        const unit = unitOfElement(b.targetNativeId) ?? f.qname;
        behaviorColumns.set(behaviorKey(kind, unit), { kind, unit });
      }
    }
    // Entries declared but exposed to nobody still get a (denied) column.
    for (const e of (f.model.operatorEntries ?? []) as Raw[]) {
      behaviorColumns.set(behaviorKey(e.kind, f.qname), {
        kind: e.kind,
        unit: f.qname,
      });
    }
  }
  const unitsWith = (kind: string) =>
    new Set(
      [...behaviorColumns.values()].filter((c) => c.kind === kind).map((c) =>
        c.unit
      ),
    ).size;
  for (const [key, { kind, unit }] of behaviorColumns) {
    const info = (INFO_KINDS as readonly string[]).includes(kind);
    col({
      id: key,
      group: info ? "memory-skills" : "behaviors",
      capability: "InvokeBehavior",
      inTypedPlan: false,
      label: `${KIND_LABEL[kind] ?? kind}${
        unitsWith(kind) > 1 ? ` · ${unit.split("::").at(-1)}` : ""
      }`,
      mode: "execute",
      target: { kind: "entry-kind", ref: kind, unit },
      tier: "core",
      doc:
        "Call a native action exposed to this operator by a BehaviorAccess (caller, target, enabled). Allocation alone grants nothing.",
    });
  }

  // -- cells: per unit -----------------------------------------------------------
  for (const f of facts) {
    const { model, native } = f;
    // STATE is read from the executable contract (what the runtime enforces);
    // NativeAuthority supplies only what ExecutableModel does not surface
    // (the reviewer mandate, native element ids used to locate declarations).
    const em = model.mandate as Raw;
    const supported = new Set(
      (em.supportedChanges as Raw[]).map((c) => c.requestedRights as string),
    );
    const b = native.builderMandate as Raw;
    const r = native.reviewerMandate as Raw | undefined;
    const p = model.policy as Raw;
    const cfg = model.configuration as Raw;
    const am = cfg.builder.admissionAuthority as "human" | "builder" | "reviewer";
    const sys = f.id.systemId as string;
    const builderRow = f.id.builderId as string;
    const reviewerRow = f.id.reviewerId as string | undefined;
    const ownerRow = `owner@${f.qname}`;
    const ownerDecl = model.ownerAuthority;
    const ownerVia = (rule: { rule: string; enforcedAt: string }): Via =>
      ownerDecl?.ownerSource === "modeled"
        ? {
          kind: "root-grant",
          grant: String(ownerDecl.rootGrantId),
          mandate: String(ownerDecl.mandateId),
        }
        : { kind: "host-rule", ...rule };
    const ownerSources = (extra: SourceRef[] = []): SourceRef[] =>
      ownerDecl?.ownerSource === "modeled"
        ? [
          locate(ownerDecl.rootGrantNativeId, "root"),
          locate(ownerDecl.mandateNativeId, "holder"),
          ...extra,
        ]
        : extra;
    const ownerCell = (
      state: CellState,
      mode: GrantMode | null,
      rule: { rule: string; enforcedAt: string },
      sources: SourceRef[],
      extra: Partial<Cell> = {},
    ): Omit<Cell, "row" | "column" | "display"> => ({
      state,
      mode,
      basis: "host-rule",
      sources: ownerSources(sources),
      via: ownerVia(rule),
      codes: ownerDecl?.ownerSource === "modeled"
        ? ["OWNER_ROOT_GRANT_UNDIFFERENTIATED"]
        : ["OWNER_IMPLICIT"],
      origin: "host-rule",
      ...extra,
    });
    const admissionAttr = lit(sys, "admissionMode", "condition");
    const networkAttr = lit(sys, "networkHosts", "scope");
    const flag = (name: string) => lit(f.execPolicyOwner, name, "flag");
    const mand = (m: Raw | undefined, name: string) =>
      m ? lit(m.nativeId, name, "flag") : [];

    // tool.build ---------------------------------------------------------------
    for (const kind of kinds) {
      const colId = `tool.build:${kind}`;
      const contract = (model.contracts as Raw[]).find((c) => c.kind === kind);
      const flagName = KIND_FLAG[kind];
      const contractRef = contract ? [locate(contract.nativeId, "scope")] : [];
      if ((em.mayPropose as string[]).includes(kind)) {
        put(builderRow, colId, {
          state: "propose-only",
          mode: "propose",
          basis: "declared",
          sources: [...mand(b, flagName!), ...contractRef],
          via: { kind: "own-declaration" },
          scope: { maxToolProposals: p.maxToolProposals },
          codes: am === "human" ? ["ADMISSION_BY_HUMAN"] : [`ADMISSION_BY_${am.toUpperCase()}`],
          origin: "compiler",
        });
      } else {
        put(builderRow, colId, denied("declared", mand(b, flagName!)));
      }
      if (reviewerRow && r) {
        put(
          reviewerRow,
          colId,
          (r.mayPropose as string[]).includes(kind)
            ? {
              state: "propose-only",
              mode: "propose",
              basis: "declared",
              sources: mand(r, flagName!),
              via: { kind: "own-declaration" },
              codes: [],
              origin: "compiler",
            }
            : denied("declared", mand(r, flagName!)),
        );
      }
    }
    // tool.invoke / network.reach -----------------------------------------------
    const hosts = (em.network?.allowedHosts ?? []) as string[];
    const activeTools = (model.catalog as Raw[]).filter((e) =>
      e.status === "active"
    ).map((e) => e.name as string).sort();
    if (em.mayInvoke === "active-catalog-only") {
      put(builderRow, "tool.invoke", {
        state: "allowed",
        mode: "execute",
        basis: "declared",
        sources: [
          ...mand(b, "mayInvokeActiveCatalog"),
          ...lit(f.execPolicyOwner, "urlSelectionMode", "scope"),
        ],
        via: { kind: "own-declaration" },
        scope: {
          catalog: "active-only",
          activeTools,
          urlSelectionMode: p.urlSelectionMode,
          hosts,
        },
        codes: hosts.length ? [] : ["NO_REACHABLE_HOST"],
        origin: "compiler",
      });
    } else {
      put(builderRow, "tool.invoke", denied("declared", mand(b, "mayInvokeActiveCatalog")));
    }
    put(
      builderRow,
      "network.reach",
      hosts.length
        ? {
          state: "inherited",
          mode: "execute",
          basis: "declared",
          sources: networkAttr,
          via: { kind: "unit-configuration", attribute: "networkHosts" },
          scope: { hosts, ceiling: ase.MAX_NETWORK_HOSTS },
          codes: em.mayInvoke === "active-catalog-only" ? [] : ["NETWORK_SCOPE_UNUSED"],
          origin: "compiler",
        }
        : denied("declared", networkAttr, { codes: ["NO_HOSTS_DECLARED"] }),
    );
    if (reviewerRow && r) {
      put(reviewerRow, "tool.invoke", denied("declared", mand(r, "mayInvokeActiveCatalog")));
      put(reviewerRow, "network.reach", denied("closed-world", []));
    }

    // admission -----------------------------------------------------------------
    const performerOf = (mechanism: string): SourceRef[] => {
      const node = (model.flows.promotion.nodes as Raw[]).find((n) =>
        n.mechanism === mechanism
      );
      return node?.performerId ? [locate(node.performerId, "allocation")] : [];
    };
    put(
      builderRow,
      "candidate.review",
      em.mayReview
        ? {
          state: "allowed",
          mode: "review",
          basis: "declared",
          sources: mand(b, "mayReviewExactCandidate"),
          via: { kind: "own-declaration" },
          codes: [],
          origin: "compiler",
        }
        : denied("declared", mand(b, "mayReviewExactCandidate")),
    );
    if (reviewerRow && r) {
      put(reviewerRow, "candidate.review", {
        state: r.mayReviewExactCandidate ? "allowed" : "denied",
        mode: r.mayReviewExactCandidate ? "review" : null,
        basis: "declared",
        sources: [
          ...mand(r, "mayReviewExactCandidate"),
          ...performerOf("review_candidate"),
        ],
        via: { kind: "own-declaration" },
        scope: r.mayReviewExactCandidate
          ? { subject: "exact-tested-digest", opinionOnly: false }
          : undefined,
        codes: [],
        origin: "compiler",
      });
    }
    // admit: exactly one authority per unit, from admissionMode (+ mayAdmit)
    const admitScope = (subject: string) => ({
      subject,
      requires: ["tests-passed", "exact-digest", "current-catalog-revision"],
      performedBy: performerOf("decide_admission").map((s) => s.qname),
    });
    put(
      builderRow,
      "candidate.admit",
      em.mayAdmitOwnCandidates
        ? {
          state: "allowed",
          mode: "admit",
          basis: "declared",
          sources: [...mand(b, "mayAdmit"), ...admissionAttr],
          via: { kind: "own-declaration" },
          scope: admitScope("own-candidates"),
          codes: [
            ...((em.mayPropose as string[]).length ? [] : ["RIGHT_WITHOUT_OBJECT"]),
          ],
          origin: "compiler",
        }
        : denied("declared", [...mand(b, "mayAdmit"), ...admissionAttr]),
    );
    if (reviewerRow && r) {
      put(
        reviewerRow,
        "candidate.admit",
        am === "reviewer" && r.mayAdmit
          ? {
            state: "allowed",
            mode: "admit",
            basis: "declared",
            sources: [
              ...mand(r, "mayAdmit"),
              ...admissionAttr,
              ...performerOf("review_candidate"),
            ],
            via: { kind: "own-declaration" },
            scope: admitScope("reviewed-candidates"),
            codes: [],
            origin: "compiler",
          }
          : denied("declared", [...mand(r, "mayAdmit"), ...admissionAttr]),
      );
    }
    put(
      ownerRow,
      "candidate.admit",
      am === "human"
        ? ownerCell("allowed", "admit", RULES.humanAdmission, admissionAttr, {
          scope: admitScope("any-candidate"),
        })
        : ownerCell("denied", null, RULES.humanAdmission, admissionAttr, {
          codes: ["HUMAN_ADMISSION_NOT_REQUIRED"],
        }),
    );
    // activate: host only
    const activateScope = { performedBy: performerOf("activate_candidate").map((s) => s.qname) };
    put(builderRow, "candidate.activate", denied("declared", [
      ...mand(b, "mayActivate"),
      ...performerOf("activate_candidate"),
    ], { scope: activateScope, codes: ["HOST_RESERVED"] }));
    if (reviewerRow && r) {
      put(reviewerRow, "candidate.activate", denied("declared", [
        ...mand(r, "mayActivate"),
        ...performerOf("activate_candidate"),
      ], { scope: activateScope, codes: ["HOST_RESERVED"] }));
    }

    // mandate changes -----------------------------------------------------------
    // supportedChanges is the compiler's own projection of the three policy flags
    // (src/adapters/execution-model.ts:873-898); the flag is read only as a source.
    const changeRules: Array<[string, string, boolean, string[]]> = [
      ["network-hosts", "mayAddNetworkHosts", supported.has("addNetworkHosts"), []],
      ["url-selection", "mayChangeUrlSelection", supported.has("setUrlSelectionMode"), []],
      [
        "self-admission",
        "mayDelegateOwnAdmission",
        supported.has("mayAdmitOwnCandidates"),
        !!p.mayDelegateOwnAdmission && am !== "human" ? ["ALREADY_DELEGATED"] : [],
      ],
    ];
    for (const [ref, flagName, effective, extraCodes] of changeRules) {
      const colId = `mandate.change:${ref}`;
      const sources = [...flag(flagName), ...(ref === "self-admission" ? admissionAttr : [])];
      const scope = ref === "network-hosts"
        ? {
          perProposal: ase.MAX_NETWORK_HOST_ADDITIONS,
          ceiling: ase.MAX_NETWORK_HOSTS,
          current: hosts,
        }
        : ref === "url-selection"
        ? {
          values: ["user-provided", "authorized-host"],
          current: p.urlSelectionMode,
        }
        : { grants: "mayAdmitOwnCandidates", currentAdmissionMode: am };
      put(
        builderRow,
        colId,
        effective
          ? {
            state: "propose-only",
            mode: "propose",
            basis: "declared",
            sources,
            via: { kind: "own-declaration" },
            scope,
            codes: ["NEEDS_HUMAN_DECISION"],
            origin: "compiler",
          }
          : denied("declared", sources, { codes: extraCodes }),
      );
      put(
        ownerRow,
        colId,
        effective
          ? ownerCell("allowed", "admit", RULES.humanApprovesChange, flag(flagName), { scope })
          : ownerCell("denied", null, RULES.humanApprovesChange, flag(flagName), {
            codes: [...extraCodes, "MODEL_POLICY_FORBIDS"],
          }),
      );
    }
    const mayCreate = !!p.mayCreateReviewer && !cfg.reviewer;
    const createCodes = p.mayCreateReviewer && cfg.reviewer ? ["ALREADY_CREATED"] : [];
    put(
      builderRow,
      "operator.create:reviewer",
      mayCreate
        ? {
          state: "propose-only",
          mode: "propose",
          basis: "declared",
          sources: flag("mayCreateReviewer"),
          via: { kind: "own-declaration" },
          scope: { mandate: { mayReviewExactCandidate: true, mayAdmitReviewedCandidates: true } },
          codes: ["NEEDS_HUMAN_DECISION"],
          origin: "compiler",
        }
        : denied("declared", flag("mayCreateReviewer"), { codes: createCodes }),
    );
    put(
      ownerRow,
      "operator.create:reviewer",
      mayCreate
        ? ownerCell("allowed", "admit", RULES.humanApprovesChange, flag("mayCreateReviewer"))
        : ownerCell("denied", null, RULES.humanApprovesChange, flag("mayCreateReviewer"), {
          codes: [...createCodes, "MODEL_POLICY_FORBIDS"],
        }),
    );
    for (const [operator, mandate, role] of [
      [builderRow, b, "builder"],
      [reviewerRow, r, "reviewer"],
    ] as const) {
      if (!operator || !mandate) continue;
      put(operator, "mandate.rewrite", denied("declared", mand(mandate, "mayChangeOwnMandate"), { codes: ["HARD_DENIED"] }));
      put(operator, "operator.spawn", denied("declared", mand(mandate, "mayCreateAgents"), { codes: ["HARD_DENIED"] }));
      void role;
    }

    // model ---------------------------------------------------------------------
    const revFlag = flag("mayProposeSysmlRevision");
    const revisions = !!p.mayProposeSysmlRevision;
    const editPolicy = model.modelEditPolicy as Raw | undefined;
    const admin = model.modelAdministration as Raw | undefined;
    const adminPolicy = model.modelAdministrationPolicy as Raw | undefined;
    put(
      builderRow,
      "model.consult",
      revisions
        ? {
          state: "allowed",
          mode: "execute",
          basis: "declared",
          sources: revFlag,
          via: { kind: "own-declaration" },
          codes: [],
          origin: "compiler",
        }
        : denied("declared", revFlag),
    );
    // model.edit
    if (!revisions) {
      put(builderRow, "model.edit", denied("declared", revFlag, editPolicy ? { codes: ["POLICY_INACTIVE_WITHOUT_FLAG"] } : {}));
    } else if (!editPolicy) {
      put(builderRow, "model.edit", denied("closed-world", revFlag, { codes: ["NO_EDIT_POLICY"] }));
    } else {
      const delegated = typeof editPolicy.delegationDigest === "string";
      const scope = {
        policy: editPolicy.id,
        revision: editPolicy.revision,
        operations: editPolicy.operations,
        grants: editPolicy.grants,
      };
      put(builderRow, "model.edit", {
        state: delegated ? "delegated" : "propose-only",
        mode: "propose",
        basis: "declared",
        sources: delegated
          ? [...ledgerSources(String(editPolicy.id)), ...revFlag]
          : [locate(editPolicy.elementId, "grant"), ...revFlag],
        via: delegated
          ? delegationVia(
            String(editPolicy.id),
            Number(editPolicy.revision),
            String(editPolicy.delegationDigest),
          )
          : { kind: "own-declaration" },
        scope,
        codes: ["PRIVATE_UNTIL_DECIDED"],
        origin: "compiler",
      });
    }
    // model.administer
    if (!revisions || !admin) {
      put(
        builderRow,
        "model.administer",
        !revisions
          ? denied("declared", revFlag)
          : denied("closed-world", [], { codes: ["NO_ADMINISTRATION_POLICY"] }),
      );
    } else {
      const viaDelegation = admin.kind === "delegation";
      put(builderRow, "model.administer", {
        state: viaDelegation ? "delegated" : "propose-only",
        mode: "propose",
        basis: "declared",
        sources: [
          ...(viaDelegation ? ledgerSources(String(admin.id)) : []),
          ...(adminPolicy ? [locate(adminPolicy.elementId, "grant")] : []),
          ...revFlag,
        ],
        via: viaDelegation
          ? delegationVia(String(admin.id), Number(admin.revision), String(admin.digest))
          : { kind: "own-declaration" },
        scope: {
          operations: admin.operations,
          grants: admin.grants,
          recipients: admin.recipients,
          maxRedelegationDepth: admin.maxRedelegationDepth,
        },
        codes: ["PRIVATE_UNTIL_DECIDED"],
        origin: "compiler",
      });
    }
    for (const colId of ["model.consult", "model.edit", "model.administer"]) {
      put(ownerRow, colId, ownerCell("allowed", "execute", RULES.localOwnerModel, [], {
        scope: { bounds: "none" },
      }));
    }
    for (const colId of ["model.decide", "model.adopt"]) {
      put(ownerRow, colId, ownerCell("allowed", "admit", RULES.ownerRevisions, []));
      put(builderRow, colId, denied("closed-world", [], { codes: ["OWNER_ONLY_PATH"] }));
      if (reviewerRow) put(reviewerRow, colId, denied("closed-world", [], { codes: ["OWNER_ONLY_PATH"] }));
    }
    if (reviewerRow) {
      for (const colId of ["model.consult", "model.edit", "model.administer"]) {
        put(reviewerRow, colId, denied("closed-world", []));
      }
      for (const colId of [
        "mandate.change:network-hosts",
        "mandate.change:url-selection",
        "mandate.change:self-admission",
        "operator.create:reviewer",
      ]) put(reviewerRow, colId, denied("closed-world", []));
    }
  }

  // -- behaviors ----------------------------------------------------------------
  // Cells from compiler-produced exposures; denied(closed-world) elsewhere;
  // denied(declared) from the disabled-exposure fallback.
  const inactive = disabledExposures();
  for (const f of facts) {
    for (const op of f.operators) {
      const mine = f.exposures.get(op.id)!;
      const held = new Map<string, Raw>();
      for (const bhv of mine) {
        const kind = entryKind.get(bhv.targetNativeId) ?? "native-action";
        const unit = unitOfElement(bhv.targetNativeId) ?? f.qname;
        held.set(behaviorKey(kind, unit), bhv);
      }
      for (const [key, { kind, unit }] of behaviorColumns) {
        const bhv = held.get(key);
        if (bhv) {
          const enabled = lit(bhv.id, "enabled", "flag");
          const policy = f.model;
          const scope: Record<string, unknown> = { exposureName: bhv.name, targetUnit: unit };
          const codes: string[] = [];
          if (kind.startsWith("memory-") && policy.memoryPolicy) {
            const m = policy.memoryPolicy as Raw;
            Object.assign(scope, {
              allowedScopes: m.allowedScopes,
              requireSourceRefs: m.requireSourceRefs,
              requireKnownOutcome: m.requireKnownOutcome,
              maxValidityMs: m.maxValidityMs,
              allowSelfAdmission: m.allowSelfAdmission,
            });
            if (kind === "memory-review" && !m.allowSelfAdmission) {
              codes.push("SELF_ADMISSION_FORBIDDEN");
              // memory is local to its owner: nobody else can review its captures
              codes.push("EFFECTIVELY_UNREACHABLE");
              diag({
                code: "MEMORY_REVIEW_UNREACHABLE",
                severity: "warning",
                context: { unit: f.qname, operator: op.id },
                recovery:
                  "expose memory-review to a second operator of the same memory owner, or set allowSelfAdmission",
              });
            }
          }
          if (kind.startsWith("skill-") && policy.skillPolicy) {
            const s = policy.skillPolicy as Raw;
            Object.assign(scope, {
              allowedHosts: s.allowedHosts,
              maxSkillBytes: s.maxSkillBytes,
              maxInstalledSkills: s.maxInstalledSkills,
              maxLoadedSkills: s.maxLoadedSkills,
            });
          }
          if (kind === "work-plan" && policy.workBudgetPolicy) {
            scope.budget = "workBudgetPolicy";
          }
          put(op.id, key, {
            state: "allowed",
            mode: "execute",
            basis: "declared",
            sources: [
              locate(bhv.id, "exposure"),
              ...enabled,
              locate(bhv.targetNativeId, "target"),
            ],
            via: { kind: "exposure", accessName: String(bhv.name), accessId: String(bhv.id) },
            scope,
            codes,
            origin: "compiler",
          });
        } else if (inactive.has(`${op.id}|${key}`)) {
          const i = inactive.get(`${op.id}|${key}`)!;
          put(op.id, key, {
            ...denied("declared", i.sources),
            codes: ["EXPOSURE_DISABLED"],
            origin: "projector-fallback",
            uncertain: {
              code: "NOT_FROM_COMPILER",
              reason:
                "compileBehaviorCatalog drops disabled exposures; read back from the typed Toolkit graph (BehaviorAccess.enabled = false)",
            },
          });
        } else {
          put(op.id, key, denied("closed-world", []));
        }
      }
    }
  }

  /** Declared-but-disabled BehaviorAccess occurrences (dropped by the compiler). */
  function disabledExposures(): Map<string, { sources: SourceRef[] }> {
    const out = new Map<string, { sources: SourceRef[] }>();
    const accessType = snapshot.elements.find((e: Raw) =>
      e.qualifiedName === "ASEInvocations::BehaviorAccess" &&
      e.metaclass === "PartDefinition"
    );
    if (!accessType) return out;
    const base = (n: string) =>
      snapshot.elements.find((e: Raw) =>
        e.qualifiedName === `ASEInvocations::BehaviorAccess::${n}`
      );
    const callerBase = base("caller"), targetBase = base("target");
    if (!callerBase || !targetBase) return out;
    const isFeature = (segmentId: string, b: Raw) => {
      const seg = snapById.get(segmentId);
      return segmentId === b.id || !!seg?.redefinedIds?.includes(b.id);
    };
    for (const access of snapshot.elements as Raw[]) {
      if (
        access.metaclass !== "PartUsage" || access.isReference ||
        !access.typeIds.includes(accessType.id)
      ) continue;
      const l = literalIndex.get(`${access.id}\u0000enabled`);
      if (!l || l.value !== "false") continue;
      const ends = (snapshot.connectors as Raw[]).filter((c) =>
        c.metaclass === "BindingConnectorAsUsage" &&
        c.ends.some((end: Raw) => end.chain.some((s: Raw) => s.id === access.id))
      );
      let caller: string | undefined, target: string | undefined;
      for (const c of ends) {
        const mine = c.ends.find((end: Raw) =>
          end.chain.some((s: Raw) => s.id === access.id)
        );
        const other = c.ends.find((end: Raw) => end !== mine);
        const last = mine?.chain.at(-1)?.id;
        const o = other?.chain.at(-1)?.id;
        if (!last || !o) continue;
        if (isFeature(last, callerBase)) caller = o;
        if (isFeature(last, targetBase)) target = o;
      }
      if (!caller || !target) {
        diag({
          code: "DISABLED_EXPOSURE_UNRESOLVED",
          severity: "info",
          context: { access: access.qualifiedName },
        });
        continue;
      }
      const kind = entryKind.get(target) ?? "native-action";
      const unit = unitOfElement(target);
      if (!unit) continue;
      out.set(`${caller}|${behaviorKey(kind, unit)}`, {
        sources: [
          locate(access.id, "exposure"),
          locate(l.attributeId, "flag"),
          locate(target, "target"),
        ],
      });
      // make sure the column exists even when no unit exposes the target
      if (!behaviorColumns.has(behaviorKey(kind, unit))) {
        behaviorColumns.set(behaviorKey(kind, unit), { kind, unit });
        col({
          id: behaviorKey(kind, unit),
          group: (INFO_KINDS as readonly string[]).includes(kind) ? "memory-skills" : "behaviors",
          capability: "InvokeBehavior",
          inTypedPlan: false,
          label: KIND_LABEL[kind] ?? kind,
          mode: "execute",
          target: { kind: "entry-kind", ref: kind, unit },
          tier: "core",
          doc: "Call a native action exposed to this operator by a BehaviorAccess.",
        });
      }
    }
    return out;
  }

  // -- diagnostics that matter for the reader ---------------------------------------
  if (!ownerModeled) {
    diag({
      code: "OWNER_IMPLICIT",
      severity: "info",
      context: { units: facts.map((f) => f.qname) },
      recovery:
        "authority lot 1 models the owner (HumanOperator + RootAuthority + RootGrant); until then owner cells are host rules, not declarations",
    });
  }
  for (const f of facts) {
    const b = f.native.builderMandate as Raw;
    if (f.model.mandate.mayAdmitOwnCandidates && !(f.model.mandate.mayPropose as string[]).length) {
      diag({
        code: "RIGHT_WITHOUT_OBJECT",
        severity: "info",
        context: { unit: f.qname, right: "candidate.admit", reason: "builder may admit own candidates but may propose none" },
      });
    }
    if (f.native.policy.mayProposeSysmlRevision && !f.model.modelEditPolicy) {
      diag({
        code: "REVISION_FLAG_WITHOUT_EDIT_POLICY",
        severity: "info",
        context: { unit: f.qname, effect: "builder may read the model but has no edit scope (src/adapters/model-source-authorization.ts:34-37)" },
      });
    }
  }

  // -- cross-check of every source coordinate against direct Toolkit calls -----------
  const crossCheck = await crossCheckLocations(
    ctx,
    input.sources,
    cells.flatMap((c) => c.sources),
    rows.flatMap((r) => (r.element ? [r.element] : [])),
  );
  if (crossCheck.mismatches.length) {
    diag({
      code: "SOURCE_COORDINATE_MISMATCH",
      severity: "warning",
      context: { count: crossCheck.mismatches.length, sample: crossCheck.mismatches.slice(0, 5) },
    });
  }

  // -- assemble -------------------------------------------------------------------------
  const groupOrder = new Map(GROUPS.map((g) => [g.id, g.order]));
  const colList = [...columns.values()].sort((a, b) =>
    (groupOrder.get(a.group)! - groupOrder.get(b.group)!) ||
    (a.order - b.order) || a.id.localeCompare(b.id)
  );
  const rowRank = { owner: 0, builder: 1, reviewer: 2 } as const;
  const rowList = rows.sort((a, b) =>
    a.unit.localeCompare(b.unit) || rowRank[a.role] - rowRank[b.role]
  );
  const colIndex = new Map(colList.map((c, i) => [c.id, i]));
  const rowIndex = new Map(rowList.map((r, i) => [r.id, i]));
  const cellList = cells.sort((a, b) =>
    (rowIndex.get(a.row)! - rowIndex.get(b.row)!) ||
    (colIndex.get(a.column)! - colIndex.get(b.column)!)
  );
  const byState = zero();
  const byRow: Record<string, Record<CellState, number>> = {};
  for (const c of cellList) {
    byState[c.state]++;
    (byRow[c.row] ??= zero())[c.state]++;
  }
  const body = {
    schema: MATRIX_SCHEMA,
    model: {
      name: input.name,
      sourceDigest: compiled.sourceDigest as string,
      toolkit: "0.10.10",
      authoritySchema: ownerModeled ? "owner-modeled" as const : "legacy-v1" as const,
      units: facts.map((f) => ({
        system: f.qname,
        executionDigest: f.model.version.digest as string,
      })),
    },
    groups: GROUPS,
    rows: rowList,
    columns: colList,
    cells: cellList,
    delegations,
    diagnostics: diagnostics.sort((a, b) =>
      a.code.localeCompare(b.code) ||
      JSON.stringify(a.context).localeCompare(JSON.stringify(b.context))
    ),
    caveats: [
      "ALLOWED_IS_DECLARED_NOT_EXECUTED: a cell states declared authority; execution still passes the host checks at call time (digest, catalog revision, executor registration: src/application/behavior-call-admission.ts:57-66).",
      "ABSENT_CELL_IS_NOT_APPLICABLE: a missing (row, column) pair means no declaration or host rule concerns that pair.",
      "OWNER_CELLS_ARE_HOST_RULES_BEFORE_LOT_3: the owner is not a declared operator in main; its cells cite the TS enforcement point.",
      "ADOPTED_VERSION_ONLY: the matrix describes the compiled source version, not pending proposals.",
    ],
    summary: {
      byState,
      uncertain: cellList.filter((c) => c.uncertain).length,
      hostRule: cellList.filter((c) => c.basis === "host-rule").length,
      byRow,
      coordinates: {
        checked: crossCheck.checked,
        mismatches: crossCheck.mismatches.length,
      },
    },
  };
  // The digest identifies the content: the display name is not part of it.
  const { name: _name, ...modelIdentity } = body.model;
  const digest = await ase.executionDigest({ ...body, model: modelIdentity });
  return { ...body, digest };
}

// ---------------------------------------------------------------------------
// Direct Toolkit verification of the coordinates carried by the matrix
// ---------------------------------------------------------------------------

async function crossCheckLocations(
  ctx: ProjectContext,
  sources: Record<string, string>,
  refs: SourceRef[],
  extra: SourceRef[],
): Promise<{ checked: number; mismatches: Array<Record<string, unknown>> }> {
  const runtime = await ctx.ase.loadSysmlToolkit(ctx.toolkitDir);
  const encoded = JSON.stringify(
    Object.entries(sources).map(([name, text]) => ({ name, text })),
  );
  const session = runtime.createSession(encoded);
  try {
    const unitList = JSON.parse(session.units()) as Array<
      { unit: number; name: string; text: string }
    >;
    const units = new Map(unitList.map((u) => [u.unit, u]));
    const all = [...refs, ...extra];
    const ids = [...new Set(all.map((r) => r.elementId))];
    const rows = JSON.parse(
      session.rows(JSON.stringify(ids), JSON.stringify(["memberExtent"])),
    ) as Array<Raw | null>;
    const direct = new Map<string, { file: string; line: number }>();
    const enc = new TextEncoder(), dec = new TextDecoder();
    ids.forEach((id, i) => {
      const ext = rows[i]?.memberExtent as
        | { unit: number; start: number; end: number }
        | null
        | undefined;
      if (!ext) return;
      const unit = units.get(ext.unit);
      if (!unit) return;
      const prefix = dec.decode(enc.encode(unit.text).slice(0, ext.start));
      direct.set(id, { file: unit.name, line: prefix.split("\n").length });
    });
    const mismatches: Array<Record<string, unknown>> = [];
    let checked = 0;
    for (const r of all) {
      const d = direct.get(r.elementId);
      if (!d) continue; // inherits a coordinate from its owner: not independently checkable
      checked++;
      if (d.file !== r.file || d.line !== r.line) {
        mismatches.push({ element: r.elementId, qname: r.qname, matrix: [r.file, r.line], toolkit: [d.file, d.line] });
      }
    }
    return { checked, mismatches };
  } finally {
    session.free();
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

async function dirSources(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && e.name.endsWith(".sysml")) {
      out[e.name] = await Deno.readTextFile(`${dir}/${e.name}`);
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function arg(name: string, fallback?: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 ? Deno.args[i + 1] : fallback;
}

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLKIT_DIRECTORY } from "../../../src/adapters/sysml-toolkit-pin.ts";

if (import.meta.main) {
  if (Deno.args.includes("--help")) {
    console.log(
      JSON.stringify({
        usage:
          "project-matrix.ts [--app dir] [--toolkit dir] [--out dir] [--only a,b]",
        schema: MATRIX_SCHEMA,
      }),
    );
    Deno.exit(0);
  }
  const APP = resolve(arg("app", fileURLToPath(new URL("../../../", import.meta.url)))!);
  const TOOLKIT = resolve(arg(
    "toolkit",
    join(APP, ".data/toolchains", TOOLKIT_DIRECTORY, "package"),
  )!);
  const OUT = arg("out", join(APP, ".data/prototypes/model-views"))!;
  const only = arg("only")?.split(",");
  try {
    await Deno.stat(`${TOOLKIT}/package.json`);
  } catch {
    console.log(JSON.stringify({
      ok: false,
      error: {
        code: "TOOLKIT_NOT_FOUND",
        context: { toolkit: TOOLKIT },
        recovery: "pass --toolkit <sysml-toolkit-v0.10.10/package>",
      },
    }));
    Deno.exit(2);
  }
  await Deno.mkdir(OUT, { recursive: true });
  const MAIN = APP;
  const ase = await loadAse(APP);
  const ctx: ProjectContext = {
    ase,
    toolkitDir: TOOLKIT,
    projectId: "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf",
  };
  const catalog: Record<string, (c: ProjectContext) => Promise<Record<string, string>>> = {
    "demo-ase": () => dirSources(`${MAIN}/.data/systems/demo-ase/model-project/sources`),
    "commercial-watch": async () =>
      JSON.parse(await Deno.readTextFile(`${MAIN}/test/fixtures/commercial-watch/sources.json`)),
    "initial": () => ase.loadInitialSources(),
  };
  const extraDir = arg("fixtures");
  if (extraDir) {
    const mod = await import(`file://${extraDir}`);
    for (const [name, build] of Object.entries(mod.fixtures as Record<string, (c: ProjectContext) => Promise<Record<string, string>>>)) {
      catalog[name] = build;
    }
  }
  for (const [name, load] of Object.entries(catalog)) {
    if (only && !only.includes(name)) continue;
    try {
      const t0 = performance.now();
      const matrix = await projectAuthorityMatrix(ctx, { name, sources: await load(ctx) });
      const ms = Math.round(performance.now() - t0);
      const path = `${OUT}/matrix-${name}${arg("suffix", "")}.json`;
      await Deno.writeTextFile(path, JSON.stringify(matrix, null, 2) + "\n");
      console.log(JSON.stringify({
        ok: true,
        model: name,
        file: path,
        rows: matrix.rows.length,
        columns: matrix.columns.length,
        cells: matrix.cells.length,
        byState: matrix.summary.byState,
        uncertain: matrix.summary.uncertain,
        coordinates: matrix.summary.coordinates,
        digest: matrix.digest,
        ms,
      }));
    } catch (error) {
      console.log(JSON.stringify({
        ok: false,
        model: name,
        error: {
          code: "MATRIX_PROJECTION_FAILED",
          context: { message: String(error instanceof Error ? error.message : error).slice(0, 500) },
          recovery: "run the ASE compilers on the model; the matrix only projects compiled models",
        },
      }));
    }
  }
}
