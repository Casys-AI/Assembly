import { mayConsultModel } from "../../../../../domain/model/consultation/model-read-policy.ts";
import { sameProductName } from "../../../../../domain/model/sysml-product-names.ts";
/** Read-only authority projection from a compiled repository artifact. */
import {
  type AuthorityMatrix,
  MATRIX_MANDATE_CHANGES,
  MATRIX_SCHEMA,
  type MatrixBasis as Basis,
  type MatrixBehaviorKind,
  type MatrixCell as Cell,
  type MatrixCellCode,
  type MatrixCellState as CellState,
  type MatrixColumn as Column,
  type MatrixColumnId,
  type MatrixDelegationStatus as DelegationStatus,
  type MatrixDiagnostic as Diagnostic,
  type MatrixEnforcementAnchor,
  type MatrixFamily,
  type MatrixGrantMode as GrantMode,
  type MatrixGroup as Group,
  type MatrixRow as Row,
  type MatrixSourceRef as SourceRef,
  type MatrixSourceRole as SourceRole,
  type MatrixVia as Via,
  parseMatrixColumnId,
} from "../../../../../domain/governance/records/authority-matrix.ts";
import { parseModelRevisionId } from "../../../../../domain/shared-kernel/revision-id.ts";
import type { ModelRevision } from "../../../../../domain/model/records/revision.ts";
import type { ModelIdentity } from "../../../../../domain/shared-kernel/model-identity.ts";
import { TOOL_KINDS } from "../../../../../domain/shared-kernel/tool-kind.ts";
import {
  MAX_NETWORK_HOST_ADDITIONS,
  MAX_NETWORK_HOSTS,
} from "../../../../../domain/governance/policies/network-policy.ts";
import type { ExecutableModel } from "../../../../../domain/model/execution/executable-model.ts";
import type { NativeBehaviorContract } from "../../../../../domain/model/execution/native-contracts.ts";
import type { ElementRecord } from "../../../../../domain/model/records/snapshot.ts";
import {
  type ModelDelegationIdentity,
  type ModelRootAuthority,
  resolveModelDelegations,
} from "../../../../../domain/governance/policies/model-delegation.ts";
import { executionDigest } from "../../../../../domain/primitives/execution-digest.ts";
import { compareCodeUnits } from "../../../../../domain/primitives/canonical-json.ts";
import type { validateSourceExecutables } from "../../compilation/source-executables.ts";
import {
  compileNativeAuthority,
  type NativeAuthority,
  type NativeMandate,
} from "../../compilation-policies/work/execution-model.ts";
import { type NativeLiteral } from "../../../../../domain/model/records/native-literal.ts";
import { compileBehaviorCatalog } from "../../compilation-policies/work/behavior-catalog.ts";
import { readModelDelegations } from "../../../../../domain/governance/policies/model-delegation-ledger.ts";
import { delegationIdentity } from "../../../../../application/governance/model-access/delegation/state.ts";
import {
  sourceLiterals,
  sourceRefs,
  sourceSnapshot,
} from "../../../../../domain/model/projections/source-facts.ts";
/** Executable units are validated by the caller once for this immutable revision.
 * Projection itself performs no source compilation, Toolkit operation or I/O. */
export type AuthorityMatrixArtifact = Pick<
  ModelRevision,
  | "version"
  | "sources"
  | "elements"
  | "sourceDigest"
  | "engineVersion"
  | "provider"
  | "provenanceDigest"
>;

export interface AuthorityMatrixProjectionInput {
  revision: AuthorityMatrixArtifact;
  units: Awaited<ReturnType<typeof validateSourceExecutables>>;
  name?: string;
}

const RULES = {
  humanAdmission: {
    rule: "human-decides-candidate-admission-when-admissionMode-is-human",
    enforcedAt: "humanAdmission",
  },
  humanApprovesChange: {
    rule: "human-approves-mandate-change-the-model-policy-allows",
    enforcedAt: "humanApprovesChange",
  },
  localOwnerModel: {
    rule: "local-owner-bypasses-operator-edit-scope",
    enforcedAt: "localOwnerModel",
  },
  ownerRevisions: {
    rule: "only-local-owner-proposes-decides-and-adopts-through-http",
    enforcedAt: "ownerRevisions",
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
};
// tool kind -> ConfiguredMandate boolean (only used to LOCATE the declaration;
// the state comes from NativeMandate.mayPropose).
const KIND_FLAG: Record<string, string> = {
  read_web_page: "mayProposeReadWebPage",
  read_web_page_outline: "mayProposeReadWebPageOutline",
};

const zero = (): Record<CellState, number> => ({
  allowed: 0,
  "propose-only": 0,
  denied: 0,
  delegated: 0,
  inherited: 0,
});

export async function projectAuthorityMatrix(
  input: AuthorityMatrixProjectionInput,
): Promise<AuthorityMatrix> {
  const { revision, units } = input;
  const version = parseModelRevisionId(revision.version);
  const elements = revision.elements;
  if (!units.length) {
    throw new Error("Authority matrix requires a conversation unit");
  }
  const managedIds = units.map((u) => u.model.identity.systemId);
  const rootId = units[0]!.model.identity.rootId;
  const snapshot = sourceSnapshot(elements, rootId);
  const literals = sourceLiterals(elements);
  const rawById = new Map(elements.map((e) => [String(e["@id"]), e]));
  const snapById = new Map(snapshot.elements.map((e) => [e.id, e]));

  const diagnostics: Diagnostic[] = [];
  const diag = (d: Diagnostic) => diagnostics.push(d);

  // -- source resolution (Toolkit coordinates) -----------------------------
  const locate = (id: string, role: SourceRole): SourceRef => {
    const start = rawById.get(id);
    let cur = start;
    let guard = 0;
    while (cur && typeof cur["sysx:sourceLine"] !== "number" && guard++ < 32) {
      const ownerId = sourceRefs(cur.owner)[0];
      cur = ownerId ? rawById.get(ownerId) : undefined;
    }
    return {
      role,
      elementId: id,
      ...(typeof start?.qualifiedName === "string"
        ? { qname: start.qualifiedName }
        : {}),
      ...(typeof cur?.["sysx:sourceDocument"] === "string"
        ? { file: cur["sysx:sourceDocument"] }
        : {}),
      ...(typeof cur?.["sysx:sourceLine"] === "number"
        ? { line: cur["sysx:sourceLine"] }
        : {}),
      ...(typeof cur?.["sysx:sourceColumn"] === "number"
        ? { column: cur["sysx:sourceColumn"] }
        : {}),
    };
  };
  const literalIndex = new Map<string, NativeLiteral>();
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
  const dedupe = (refs: readonly SourceRef[]): SourceRef[] => {
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
    model: ExecutableModel;
    native: NativeAuthority;
    id: ModelIdentity;
    execPolicyOwner?: string;
    operators: Array<{ id: string; role: "builder" | "reviewer" }>;
    exposures: Map<string, NativeBehaviorContract[]>;
  }
  const facts: UnitFacts[] = [];
  for (const { unit, model } of units) {
    const identity = model.identity;
    const native = compileNativeAuthority(snapshot, literals, identity);
    // Locator only: the ExecutionPolicy occurrence under the `conversation` action.
    const conversation = snapshot.elements.find((e) =>
      e.ownerId === identity.systemId && e.name === "conversation" &&
      e.metaclass === "PerformActionUsage"
    );
    const policyItem = conversation &&
      snapshot.elements.find((e) =>
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
    const exposures = new Map<string, NativeBehaviorContract[]>();
    for (const op of operators) {
      // Assembly's compiler, parameterised by the operator (the builder slot).
      exposures.set(
        op.id,
        compileBehaviorCatalog(
          revision,
          { ...identity, builderId: op.id },
          managedIds,
        ),
      );
    }
    // Consistency: the builder's exposures equal the executable model's.
    const compiledBuilder = JSON.stringify(
      (model.behaviors ?? []).map((b) => b.id).sort(compareCodeUnits),
    );
    const mine = JSON.stringify(
      exposures.get(identity.builderId)!.map((b) => b.id).sort(
        compareCodeUnits,
      ),
    );
    if (compiledBuilder !== mine) {
      diag({
        code: "EXPOSURE_MISMATCH",
        severity: "warning",
        context: { unit: unit.systemQualifiedName },
        recovery:
          "compare compileBehaviorCatalog with ExecutableModel.behaviors",
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

  // delegation chain (Assembly resolver, reconstructed exactly as applyModelDelegations does)
  const records = readModelDelegations(revision.sources);
  const roots: ModelRootAuthority[] = [];
  const identities: ModelDelegationIdentity[] = [];
  for (const f of facts) {
    const identity = delegationIdentity(f.qname, f.model, revision);
    identities.push(identity);
    if (f.model.modelAdministrationPolicy) {
      roots.push({ ...identity, ...f.model.modelAdministrationPolicy });
    }
  }
  const delegations: DelegationStatus[] = [];
  if (roots.length || records.length) {
    const resolved = await resolveModelDelegations(roots, records, identities);
    for (const s of resolved.statuses) {
      const rec = records.find((x) =>
        x.id === s.id && x.revision === s.revision
      );
      delegations.push({
        id: s.id,
        revision: s.revision,
        issuerSystem: rec?.issuerSystem ?? "",
        targetSystem: rec?.targetSystem ?? "",
        active: !!s.active,
        ...(s.reason === null ? {} : { reason: s.reason }),
      });
    }
  }
  function chainOf(recordId: string): Array<
    {
      kind: "root" | "delegation";
      id: string;
      revision: number;
      system: string;
    }
  > {
    const out: Array<
      {
        kind: "root" | "delegation";
        id: string;
        revision: number;
        system: string;
      }
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
  function delegationVia(
    recordId: string,
    revisionNo: number,
    chainDigest: string,
  ): Via {
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
    const ledger = snapshot.elements.find((e) =>
      sameProductName(e.qualifiedName, "AssemblyModelDelegations::records")
    );
    const chain = chainOf(recordId);
    const rootSystem = chain.find((c) => c.kind === "root")?.system;
    const issuer = facts.find((f) => f.qname === rootSystem);
    const rootPolicy = issuer?.model.modelAdministrationPolicy;
    return [
      ...(ledger ? [locate(ledger.id, "grant")] : []),
      ...(rootPolicy ? [locate(rootPolicy.elementId, "root")] : []),
    ];
  };

  // operator-entry index across units (target action -> kind, owning unit)
  const unitOf = new Map<string, string>();
  const systemQname = new Map(facts.map((f) => [f.id.systemId, f.qname]));
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
  const entryKind = new Map<string, MatrixBehaviorKind>();
  for (const f of facts) {
    for (const e of (f.model.operatorEntries ?? [])) {
      entryKind.set(e.id, e.kind);
    }
  }

  const unsupportedTargets = new Set<string>();
  const kindOf = (
    access: string,
    target: string,
  ): MatrixBehaviorKind | undefined => {
    const kind = entryKind.get(target);
    if (!kind) {
      const key = `${access}\u0000${target}`;
      if (!unsupportedTargets.has(key)) {
        unsupportedTargets.add(key);
        diag({
          code: "UNSUPPORTED_BEHAVIOR_TARGET",
          severity: "info",
          context: {
            access: snapById.get(access)?.qualifiedName || access,
            target: snapById.get(target)?.qualifiedName || target,
          },
          recovery:
            "Bind this exposure to a supported operator entry to represent it in the authority matrix",
        });
      }
    }
    return kind;
  };

  // -- owner provenance (lot 1: modeled; main: implicit) --------------------
  // The global schema records the presence of a modeled owner anywhere.
  // Each row's declared flag retains the authority provenance of its own unit.
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
      label: modeled ? String(owner!.operatorId) : "Owner",
      unit: f.qname,
      declared: modeled,
      ...(modeled
        ? { element: locate(owner!.operatorNativeId, "holder") }
        : {}),
      principal: "local-owner",
    });
    const op = f.model.operator;
    const p = f.native.policy;
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
  const columns = new Map<MatrixColumnId, Column>();
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
      const k = [...INFO_KINDS, ...WORK_KINDS].findIndex((entry) =>
        entry === kind
      );
      return 1000 + (k < 0 ? 99 : k) * 100 + (unitRank.get(unit) ?? 0);
    }
    const i = READING_ORDER.findIndex((o) => id === o || id.startsWith(o));
    if (id.startsWith("tool.build:")) {
      return i * 10 +
        Math.max(0, kinds.findIndex((kind) => id === `tool.build:${kind}`));
    }
    return i * 10;
  };
  const col = (c: ColumnInput) => {
    const column = matrixColumn(c, orderOf(c.id), typedScopeOf(c.id));
    if (!columns.has(column.id)) {
      columns.set(column.id, column);
    }
    return column.id;
  };
  const cells: Cell[] = [];
  const put = (
    row: string,
    column: string,
    c: Omit<Cell, "row" | "column" | "display">,
  ) =>
    cells.push({
      row,
      column: parseMatrixColumnId(column).id,
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
    basis,
    sources,
    codes: [],
    origin: basis === "host-rule" ? "host-rule" : "compiler",
    ...extra,
  });

  // Tools -------------------------------------------------------------------
  const kinds = [...TOOL_KINDS];
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
  const changeCols: Array<
    [typeof MATRIX_MANDATE_CHANGES[number], string, string]
  > = [
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
      "Read model sources and selective model context under mayConsultModel, independently of revision proposals. Historical pins without that field retain their original grant.",
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
  const behaviorColumns = new Map<
    string,
    { kind: MatrixBehaviorKind; unit: string }
  >();
  const behaviorKey = (
    kind: MatrixBehaviorKind,
    unit: string,
  ): MatrixColumnId => `behavior:${kind}@${unit}`;
  for (const f of facts) {
    for (const list of f.exposures.values()) {
      for (const b of list) {
        const kind = kindOf(b.id, b.targetNativeId);
        if (!kind) continue;
        const unit = unitOfElement(b.targetNativeId) ?? f.qname;
        behaviorColumns.set(behaviorKey(kind, unit), { kind, unit });
      }
    }
    // Entries declared but exposed to nobody still get a (denied) column.
    for (const e of (f.model.operatorEntries ?? [])) {
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
    const em = model.mandate;
    const supported = new Set(
      em.supportedChanges.map((c) => c.requestedRights),
    );
    const b = native.builderMandate;
    const r = native.reviewerMandate;
    const p = model.policy;
    const cfg = model.configuration;
    const am = cfg.builder.admissionAuthority;
    const sys = f.id.systemId;
    const builderRow = f.id.builderId;
    const reviewerRow = f.id.reviewerId;
    const ownerRow = `owner@${f.qname}`;
    const ownerDecl = model.ownerAuthority;
    const ownerVia = (
      rule: { rule: string; enforcedAt: MatrixEnforcementAnchor },
    ): Via =>
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
      mode: GrantMode | undefined,
      rule: { rule: string; enforcedAt: MatrixEnforcementAnchor },
      sources: SourceRef[],
      extra: Partial<Cell> = {},
    ): Omit<Cell, "row" | "column" | "display"> => ({
      state,
      ...(mode ? { mode } : {}),
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
    const mand = (m: NativeMandate | undefined, name: string) =>
      m ? lit(m.nativeId, name, "flag") : [];

    // tool.build ---------------------------------------------------------------
    for (const kind of kinds) {
      const colId = `tool.build:${kind}`;
      const contract = model.contracts.find((c) => c.kind === kind);
      const flagName = KIND_FLAG[kind];
      const contractRef = contract ? [locate(contract.nativeId, "scope")] : [];
      if (em.mayPropose.includes(kind)) {
        put(builderRow, colId, {
          state: "propose-only",
          mode: "propose",
          basis: "declared",
          sources: [...mand(b, flagName!), ...contractRef],
          via: { kind: "own-declaration" },
          scope: { maxToolProposals: p.maxToolProposals },
          codes: am === "human" ? ["ADMISSION_BY_HUMAN"] : [
            am === "builder" ? "ADMISSION_BY_BUILDER" : "ADMISSION_BY_REVIEWER",
          ],
          origin: "compiler",
        });
      } else {
        put(builderRow, colId, denied("declared", mand(b, flagName!)));
      }
      if (reviewerRow && r) {
        put(
          reviewerRow,
          colId,
          r.mayPropose.includes(kind)
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
    const hosts = em.network?.allowedHosts ?? [];
    const activeTools = model.catalog.filter((e) => e.status === "active").map((
      e,
    ) => e.name).sort(compareCodeUnits);
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
      put(
        builderRow,
        "tool.invoke",
        denied("declared", mand(b, "mayInvokeActiveCatalog")),
      );
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
          scope: { hosts, ceiling: MAX_NETWORK_HOSTS },
          codes: em.mayInvoke === "active-catalog-only"
            ? []
            : ["NETWORK_SCOPE_UNUSED"],
          origin: "compiler",
        }
        : denied("declared", networkAttr, { codes: ["NO_HOSTS_DECLARED"] }),
    );
    if (reviewerRow && r) {
      put(
        reviewerRow,
        "tool.invoke",
        denied("declared", mand(r, "mayInvokeActiveCatalog")),
      );
      put(reviewerRow, "network.reach", denied("closed-world", []));
    }

    // admission -----------------------------------------------------------------
    const performerOf = (mechanism: string): SourceRef[] => {
      const node = model.flows.promotion.nodes.find((n) =>
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
        ...(r.mayReviewExactCandidate ? { mode: "review" as const } : {}),
        basis: "declared",
        sources: [
          ...mand(r, "mayReviewExactCandidate"),
          ...performerOf("review_candidate"),
        ],
        via: { kind: "own-declaration" },
        ...(r.mayReviewExactCandidate
          ? { scope: { subject: "exact-tested-digest", opinionOnly: false } }
          : {}),
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
            ...(em.mayPropose.length ? [] : ["RIGHT_WITHOUT_OBJECT" as const]),
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
        : ownerCell("denied", undefined, RULES.humanAdmission, admissionAttr, {
          codes: ["HUMAN_ADMISSION_NOT_REQUIRED"],
        }),
    );
    // activate: host only
    const activateScope = {
      performedBy: performerOf("activate_candidate").map((s) => s.qname),
    };
    put(
      builderRow,
      "candidate.activate",
      denied("declared", [
        ...mand(b, "mayActivate"),
        ...performerOf("activate_candidate"),
      ], { scope: activateScope, codes: ["HOST_RESERVED"] }),
    );
    if (reviewerRow && r) {
      put(
        reviewerRow,
        "candidate.activate",
        denied("declared", [
          ...mand(r, "mayActivate"),
          ...performerOf("activate_candidate"),
        ], { scope: activateScope, codes: ["HOST_RESERVED"] }),
      );
    }

    // mandate changes -----------------------------------------------------------
    // supportedChanges is the executable compiler's projection of these policy
    // flags; their declarations are read here only to locate sources.
    const changeRules: Array<
      [typeof MATRIX_MANDATE_CHANGES[number], string, boolean, MatrixCellCode[]]
    > = [
      [
        "network-hosts",
        "mayAddNetworkHosts",
        supported.has("addNetworkHosts"),
        [],
      ],
      [
        "url-selection",
        "mayChangeUrlSelection",
        supported.has("setUrlSelectionMode"),
        [],
      ],
      [
        "self-admission",
        "mayDelegateOwnAdmission",
        supported.has("mayAdmitOwnCandidates"),
        !!p.mayDelegateOwnAdmission && am !== "human"
          ? ["ALREADY_DELEGATED"]
          : [],
      ],
    ];
    for (const [ref, flagName, effective, extraCodes] of changeRules) {
      const colId = `mandate.change:${ref}`;
      const sources = [
        ...flag(flagName),
        ...(ref === "self-admission" ? admissionAttr : []),
      ];
      const scope = ref === "network-hosts"
        ? {
          perProposal: MAX_NETWORK_HOST_ADDITIONS,
          ceiling: MAX_NETWORK_HOSTS,
          current: hosts,
        }
        : ref === "url-selection"
        ? {
          values: ["user-provided", "authorized-host"],
          current: p.urlSelectionMode,
        }
        : { requestedRight: "mayAdmitOwnCandidates", currentAdmissionMode: am };
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
          ? ownerCell(
            "allowed",
            "admit",
            RULES.humanApprovesChange,
            flag(flagName),
            { scope },
          )
          : ownerCell(
            "denied",
            undefined,
            RULES.humanApprovesChange,
            flag(flagName),
            {
              codes: [...extraCodes, "MODEL_POLICY_FORBIDS"],
            },
          ),
      );
    }
    const mayCreate = !!p.mayCreateReviewer && !cfg.reviewer;
    const createCodes: MatrixCellCode[] = p.mayCreateReviewer && cfg.reviewer
      ? ["ALREADY_CREATED"]
      : [];
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
          scope: {
            mandate: {
              mayReviewExactCandidate: true,
              mayAdmitReviewedCandidates: true,
            },
          },
          codes: ["NEEDS_HUMAN_DECISION"],
          origin: "compiler",
        }
        : denied("declared", flag("mayCreateReviewer"), { codes: createCodes }),
    );
    put(
      ownerRow,
      "operator.create:reviewer",
      mayCreate
        ? ownerCell(
          "allowed",
          "admit",
          RULES.humanApprovesChange,
          flag("mayCreateReviewer"),
        )
        : ownerCell(
          "denied",
          undefined,
          RULES.humanApprovesChange,
          flag("mayCreateReviewer"),
          {
            codes: [...createCodes, "MODEL_POLICY_FORBIDS"],
          },
        ),
    );
    for (
      const [operator, mandate, role] of [
        [builderRow, b, "builder"],
        [reviewerRow, r, "reviewer"],
      ] as const
    ) {
      if (!operator || !mandate) continue;
      put(
        operator,
        "mandate.rewrite",
        denied("declared", mand(mandate, "mayChangeOwnMandate"), {
          codes: ["HARD_DENIED"],
        }),
      );
      put(
        operator,
        "operator.spawn",
        denied("declared", mand(mandate, "mayCreateAgents"), {
          codes: ["HARD_DENIED"],
        }),
      );
      void role;
    }

    // model ---------------------------------------------------------------------
    const revFlag = flag("mayProposeSysmlRevision");
    const revisions = !!p.mayProposeSysmlRevision;
    const readFlag = p.mayConsultModel === undefined
      ? revFlag
      : flag("mayConsultModel");
    const editPolicy = model.modelEditPolicy;
    const admin = model.modelAdministration;
    const adminPolicy = model.modelAdministrationPolicy;
    put(
      builderRow,
      "model.consult",
      mayConsultModel(p)
        ? {
          state: "allowed",
          mode: "execute",
          basis: "declared",
          sources: readFlag,
          via: { kind: "own-declaration" },
          codes: [],
          origin: "compiler",
        }
        : denied("declared", readFlag),
    );
    // model.edit
    if (!revisions) {
      put(
        builderRow,
        "model.edit",
        denied(
          "declared",
          revFlag,
          editPolicy ? { codes: ["POLICY_INACTIVE_WITHOUT_FLAG"] } : {},
        ),
      );
    } else if (!editPolicy) {
      put(
        builderRow,
        "model.edit",
        denied("closed-world", revFlag, { codes: ["NO_EDIT_POLICY"] }),
      );
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
          ? delegationVia(
            String(admin.id),
            Number(admin.revision),
            String(admin.digest),
          )
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
      put(
        ownerRow,
        colId,
        ownerCell("allowed", "execute", RULES.localOwnerModel, [], {
          scope: { bounds: "none" },
        }),
      );
    }
    for (const colId of ["model.decide", "model.adopt"]) {
      put(
        ownerRow,
        colId,
        ownerCell("allowed", "admit", RULES.ownerRevisions, []),
      );
      put(
        builderRow,
        colId,
        denied("closed-world", [], { codes: ["OWNER_ONLY_PATH"] }),
      );
      if (reviewerRow) {
        put(
          reviewerRow,
          colId,
          denied("closed-world", [], { codes: ["OWNER_ONLY_PATH"] }),
        );
      }
    }
    if (reviewerRow) {
      for (const colId of ["model.consult", "model.edit", "model.administer"]) {
        put(reviewerRow, colId, denied("closed-world", []));
      }
      for (
        const colId of [
          "mandate.change:network-hosts",
          "mandate.change:url-selection",
          "mandate.change:self-admission",
          "operator.create:reviewer",
        ]
      ) put(reviewerRow, colId, denied("closed-world", []));
    }
  }

  // -- behaviors ----------------------------------------------------------------
  // Cells from compiler-produced exposures; denied(closed-world) elsewhere;
  // denied(declared) from the disabled-exposure fallback.
  const inactive = disabledExposures();
  for (const f of facts) {
    for (const op of f.operators) {
      const mine = f.exposures.get(op.id)!;
      const held = new Map<string, NativeBehaviorContract>();
      for (const bhv of mine) {
        const kind = kindOf(bhv.id, bhv.targetNativeId);
        if (!kind) continue;
        const unit = unitOfElement(bhv.targetNativeId) ?? f.qname;
        held.set(behaviorKey(kind, unit), bhv);
      }
      for (const [key, { kind, unit }] of behaviorColumns) {
        const bhv = held.get(key);
        if (bhv) {
          const enabled = lit(bhv.id, "enabled", "flag");
          const policy = f.model;
          const scope: Record<string, unknown> = {
            exposureName: bhv.name,
            targetUnit: unit,
          };
          const codes: MatrixCellCode[] = [];
          if (kind.startsWith("memory-") && policy.memoryPolicy) {
            const m = policy.memoryPolicy;
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
                  "After reviewing the memory policy, enable allowSelfAdmission for the local owner or remove the unreachable memory-review exposure",
              });
            }
          }
          if (kind.startsWith("skill-") && policy.skillPolicy) {
            const s = policy.skillPolicy;
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
            via: {
              kind: "exposure",
              accessName: String(bhv.name),
              accessId: String(bhv.id),
            },
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
    const accessType = snapshot.elements.find((e) =>
      sameProductName(e.qualifiedName, "AssemblyInvocations::BehaviorAccess") &&
      e.metaclass === "PartDefinition"
    );
    if (!accessType) return out;
    const base = (n: string) =>
      snapshot.elements.find((e) =>
        sameProductName(
          e.qualifiedName,
          `AssemblyInvocations::BehaviorAccess::${n}`,
        )
      );
    const callerBase = base("caller"), targetBase = base("target");
    if (!callerBase || !targetBase) return out;
    const isFeature = (segmentId: string, b: ElementRecord) => {
      const seg = snapById.get(segmentId);
      return segmentId === b.id || !!seg?.redefinedIds?.includes(b.id);
    };
    for (const access of snapshot.elements) {
      if (
        access.metaclass !== "PartUsage" || access.isReference ||
        !access.typeIds.includes(accessType.id)
      ) continue;
      const l = literalIndex.get(`${access.id}\u0000enabled`);
      if (!l || l.value !== "false") continue;
      const ends = snapshot.connectors.filter((c) =>
        c.metaclass === "BindingConnectorAsUsage" &&
        c.ends.some((end) => end.chain.some((s) => s.id === access.id))
      );
      let caller: string | undefined, target: string | undefined;
      for (const c of ends) {
        const mine = c.ends.find((end) =>
          end.chain.some((s) => s.id === access.id)
        );
        const other = c.ends.find((end) => end !== mine);
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
          recovery:
            "Bind the disabled BehaviorAccess to an exact caller and target",
        });
        continue;
      }
      const kind = kindOf(access.id, target);
      if (!kind) continue;
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
          group: (INFO_KINDS as readonly string[]).includes(kind)
            ? "memory-skills"
            : "behaviors",
          capability: "InvokeBehavior",
          inTypedPlan: false,
          label: KIND_LABEL[kind] ?? kind,
          mode: "execute",
          target: { kind: "entry-kind", ref: kind, unit },
          tier: "core",
          doc:
            "Call a native action exposed to this operator by a BehaviorAccess.",
        });
      }
    }
    return out;
  }

  // -- diagnostics that matter for the reader ---------------------------------------
  const implicitOwners = facts.filter((f) =>
    f.model.ownerAuthority?.ownerSource !== "modeled"
  );
  if (implicitOwners.length) {
    diag({
      code: "OWNER_IMPLICIT",
      severity: "info",
      context: { units: implicitOwners.map((f) => f.qname) },
      recovery:
        "Declare each listed unit's owner (HumanOperator + RootAuthority + RootGrant); until then its owner cells cite host rules",
    });
  }
  for (const f of facts) {
    if (
      f.model.mandate.mayAdmitOwnCandidates &&
      !f.model.mandate.mayPropose.length
    ) {
      diag({
        code: "RIGHT_WITHOUT_OBJECT",
        severity: "info",
        context: {
          unit: f.qname,
          right: "candidate.admit",
          reason: "builder may admit own candidates but may propose none",
        },
        recovery:
          "Declare at least one candidate tool kind or remove own admission authority",
      });
    }
    if (f.native.policy.mayProposeSysmlRevision && !f.model.modelEditPolicy) {
      diag({
        code: "REVISION_FLAG_WITHOUT_EDIT_POLICY",
        severity: "info",
        context: {
          unit: f.qname,
          effect: "builder may read the model but has no edit scope",
        },
        recovery:
          "Declare a model edit policy with bounded grants to enable edit proposals",
      });
    }
  }

  // Check artifact coordinates against their exact source bytes, without parsing.
  const crossCheck = checkAuthorityMatrixCoordinates(revision, [
    ...cells.flatMap((c) => c.sources),
    ...rows.flatMap((r) => r.element ? [r.element] : []),
  ]);
  if (crossCheck.mismatches.length) {
    diag({
      code: "SOURCE_COORDINATE_MISMATCH",
      severity: "warning",
      context: {
        count: crossCheck.mismatches.length,
        sample: crossCheck.mismatches.slice(0, 5),
      },
      recovery:
        "Restore the compiled artifact coordinates and source bytes for the reported elements",
    });
  }

  // -- assemble -------------------------------------------------------------------------
  const groupOrder = new Map(GROUPS.map((g) => [g.id, g.order]));
  const colList = [...columns.values()].sort((a, b) =>
    (groupOrder.get(a.group)! - groupOrder.get(b.group)!) ||
    (a.order - b.order) || compareCodeUnits(a.id, b.id)
  );
  const rowRank = { owner: 0, builder: 1, reviewer: 2 } as const;
  const rowList = rows.sort((a, b) =>
    compareCodeUnits(a.unit, b.unit) || rowRank[a.role] - rowRank[b.role]
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
  const body: Omit<AuthorityMatrix, "digest"> = {
    version,
    schema: MATRIX_SCHEMA,
    model: {
      name: input.name ?? revision.version,
      sourceDigest: revision.sourceDigest,
      toolkit: revision.engineVersion,
      authoritySchema: ownerModeled
        ? "owner-modeled" as const
        : "legacy-v1" as const,
      units: facts.map((f) => ({
        system: f.qname,
        executionDigest: f.model.version.digest,
      })),
    },
    groups: GROUPS,
    rows: rowList,
    columns: colList,
    cells: cellList,
    delegations,
    diagnostics: diagnostics.sort((a, b) =>
      compareCodeUnits(a.code, b.code) ||
      compareCodeUnits(JSON.stringify(a.context), JSON.stringify(b.context))
    ),
    caveats: [
      "ADOPTED_VERSION_ONLY",
      "ALLOWED_IS_DECLARED_NOT_EXECUTED",
      "ABSENT_CELL_IS_NOT_APPLICABLE",
      "OWNER_CELLS_ARE_HOST_RULES_BEFORE_LOT_3",
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
  const digest = await executionDigest({ ...body, model: modelIdentity });
  return { ...body, digest };
}

// ---------------------------------------------------------------------------
// Compiled-artifact verification of the coordinates carried by the matrix
// ---------------------------------------------------------------------------

interface ColumnInput {
  id: string;
  group: MatrixFamily;
  capability: string;
  inTypedPlan: boolean;
  label: string;
  mode: GrantMode;
  target?: {
    kind: "tool-kind" | "change" | "entry-kind";
    ref: string;
    unit?: string;
  };
  tier: "core" | "detail";
  doc: string;
}

/** The closed B4 key owns the family and target; reject inconsistent metadata. */
function matrixColumn(
  input: ColumnInput,
  order: number,
  typedScope: Column["typedScope"],
): Column {
  const key = parseMatrixColumnId(input.id);
  let group: MatrixFamily;
  let target: ColumnInput["target"];
  switch (key.kind) {
    case "fixed":
      group = key.id === "tool.invoke" || key.id === "network.reach"
        ? "tools"
        : key.id.startsWith("candidate.")
        ? "admission"
        : key.id.startsWith("model.")
        ? "model"
        : "mandate";
      target = key.id === "operator.create:reviewer"
        ? { kind: "change", ref: "reviewer" }
        : undefined;
      break;
    case "tool-build":
      group = "tools";
      target = { kind: "tool-kind", ref: key.id.slice("tool.build:".length) };
      break;
    case "mandate-change":
      group = "mandate";
      target = { kind: "change", ref: key.id.slice("mandate.change:".length) };
      break;
    case "behavior": {
      const suffix = key.id.slice("behavior:".length);
      const at = suffix.indexOf("@");
      const kind = suffix.slice(0, at);
      group = kind.startsWith("context-") || kind.startsWith("memory-") ||
          kind.startsWith("skill-")
        ? "memory-skills"
        : "behaviors";
      target = { kind: "entry-kind", ref: kind, unit: suffix.slice(at + 1) };
      break;
    }
  }
  if (
    input.group !== group ||
    JSON.stringify(input.target) !== JSON.stringify(target)
  ) throw new Error(`Inconsistent authority matrix column: ${input.id}`);
  // parseMatrixColumnId plus the checks above validate the dependent union.
  return { ...input, ...key, order, typedScope } as Column;
}

const SOURCE_COORDINATE_FIELDS = [
  "sysx:sourceDocument",
  "sysx:sourceText",
  "sysx:sourceLine",
  "sysx:sourceColumn",
  "sysx:sourceEndLine",
  "sysx:sourceEndColumn",
] as const;

interface SourceBytes {
  bytes: Uint8Array;
  lineStarts: number[];
  lineEnds: number[];
}

/** These are byte positions in the stored source, not a SysML interpretation. */
function sourceByteIndex(source: string): SourceBytes {
  const bytes = new TextEncoder().encode(source);
  const lineStarts = [0], lineEnds: number[] = [];
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 10) {
      lineEnds.push(index);
      lineStarts.push(index + 1);
    }
  }
  lineEnds.push(bytes.length);
  return { bytes, lineStarts, lineEnds };
}

function sourceByteOffset(
  source: SourceBytes,
  line: number,
  column: number,
): number | undefined {
  if (
    !Number.isSafeInteger(line) || !Number.isSafeInteger(column) ||
    line < 1 || column < 1
  ) return undefined;
  const start = source.lineStarts[line - 1], end = source.lineEnds[line - 1];
  if (start === undefined || end === undefined) return undefined;
  const offset = start + column - 1;
  if (
    offset > end ||
    (offset < source.bytes.length && (source.bytes[offset]! & 0xc0) === 0x80)
  ) return undefined;
  return offset;
}

/** Verify emitted refs against normalized artifact metadata and exact UTF8
 * excerpts. References inheriting an owner's coordinates are checked against
 * that owner but are not counted as independently located native elements.
 * There is no fresh Toolkit observation here; the repository artifact is the
 * authority for the native extent and qualified name. */
export function checkAuthorityMatrixCoordinates(
  revision: Pick<ModelRevision, "elements" | "sources">,
  refs: readonly SourceRef[],
): { checked: number; mismatches: Array<Record<string, unknown>> } {
  const byId = new Map(
    revision.elements.map((element) => [String(element["@id"]), element]),
  );
  const documents = new Map<string, SourceBytes>();
  const encoder = new TextEncoder();
  const coordinateErrors = new Map<string, string | undefined>();
  const hasCoordinates = (element: Record<string, unknown>) =>
    SOURCE_COORDINATE_FIELDS.some((field) => Object.hasOwn(element, field));
  const validateCoordinates = (
    id: string,
    element: Record<string, unknown>,
  ): string | undefined => {
    if (coordinateErrors.has(id)) return coordinateErrors.get(id);
    const file = element["sysx:sourceDocument"];
    const text = element["sysx:sourceText"];
    const line = element["sysx:sourceLine"];
    const column = element["sysx:sourceColumn"];
    const endLine = element["sysx:sourceEndLine"];
    const endColumn = element["sysx:sourceEndColumn"];
    let error: string | undefined;
    if (
      typeof file !== "string" || typeof text !== "string" ||
      typeof line !== "number" || typeof column !== "number" ||
      typeof endLine !== "number" || typeof endColumn !== "number"
    ) {
      error = "INCOMPLETE_ARTIFACT_COORDINATES";
    } else if (!Object.hasOwn(revision.sources, file)) {
      error = "ARTIFACT_SOURCE_FILE_MISSING";
    } else {
      let source = documents.get(file);
      if (!source) {
        source = sourceByteIndex(revision.sources[file]!);
        documents.set(file, source);
      }
      const start = sourceByteOffset(source, line, column);
      const end = sourceByteOffset(source, endLine, endColumn);
      if (start === undefined || end === undefined || end < start) {
        error = "ARTIFACT_COORDINATES_OUT_OF_BOUNDS";
      } else {
        const excerpt = source.bytes.subarray(start, end);
        const expected = encoder.encode(text);
        if (
          excerpt.length !== expected.length ||
          excerpt.some((value, index) => value !== expected[index])
        ) error = "ARTIFACT_SOURCE_EXCERPT_MISMATCH";
      }
    }
    coordinateErrors.set(id, error);
    return error;
  };
  const mismatches: Array<Record<string, unknown>> = [];
  let checked = 0;
  for (const ref of refs) {
    const element = byId.get(ref.elementId);
    if (!element) {
      mismatches.push({
        element: ref.elementId,
        reason: "UNKNOWN_ARTIFACT_ELEMENT",
      });
      continue;
    }
    let location = element;
    const seen = new Set<string>([ref.elementId]);
    while (!hasCoordinates(location)) {
      const ownerId = sourceRefs(location.owner)[0];
      const owner = ownerId ? byId.get(ownerId) : undefined;
      if (!owner || seen.has(ownerId)) break;
      seen.add(ownerId);
      location = owner;
    }
    // A source-free library or implicit element has no independent extent.
    if (!hasCoordinates(location)) {
      if (
        ref.file !== undefined || ref.line !== undefined ||
        ref.column !== undefined
      ) {
        mismatches.push({
          element: ref.elementId,
          reason: "UNLOCATED_ARTIFACT_ELEMENT",
        });
      }
      continue;
    }
    const inherited = location !== element;
    if (!inherited) checked++;
    const coordinateId = String(location["@id"]);
    const error = validateCoordinates(coordinateId, location);
    const expectedQname = typeof element.qualifiedName === "string"
      ? element.qualifiedName
      : undefined;
    if (
      error || ref.file !== location["sysx:sourceDocument"] ||
      ref.line !== location["sysx:sourceLine"] ||
      ref.column !== location["sysx:sourceColumn"] ||
      ref.qname !== expectedQname
    ) {
      mismatches.push({
        element: ref.elementId,
        ...(ref.qname ? { qname: ref.qname } : {}),
        ...(inherited ? { inheritedFrom: coordinateId } : {}),
        reason: error ?? "REFERENCE_ARTIFACT_COORDINATE_MISMATCH",
        matrix: [ref.file ?? null, ref.line ?? null, ref.column ?? null],
        artifact: [
          location["sysx:sourceDocument"] ?? null,
          location["sysx:sourceLine"] ?? null,
          location["sysx:sourceColumn"] ?? null,
        ],
      });
    }
  }
  return { checked, mismatches };
}
