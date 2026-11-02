import type {
  AuthorityMatrix as Body,
  MatrixCell as BodyCell,
  MatrixColumn as BodyColumn,
  MatrixColumnId,
  MatrixGrantMode,
  MatrixGroup as BodyGroup,
  MatrixRow as BodyRow,
} from "../../../src/domain/governance/records/authority-matrix.ts";
import {
  type AuthorityMatrix,
  parseMatrix,
} from "../../lib/system/rights/api.ts";
import { BUILDER, HEAD } from "./board-fixture.ts";
import { versionedHost, type VersionedHostOptions } from "./versioned-host.ts";

/**
 * Authority matrices as the host projects them (schema `ase.authority-matrix/1`,
 * typed by the host's own contract: the rows, the cells, and each column's
 * identifier, family and the facts every column has are checked, so a fixture
 * that drifts from them does not compile; what the column's kind implies for
 * its target is the fixture's to keep), for the initial model: one unit,
 * `liveBuilder`, with a human owner and a software builder. Two ways the host tells the owner: modeled, a holder
 * the model declares (`owner-modeled`), and implicit, a rule of the host
 * (`legacy-v1`). The matrix has the columns a page needs to draw each kind of
 * mark, not all the host has.
 */

export const UNIT = "ASELiveBuilder::liveBuilder";
export const OWNER = `owner@${UNIT}`;
export { BUILDER };

const GROUPS: readonly BodyGroup[] = [
  { id: "tools", label: "Tools", order: 1 },
  { id: "admission", label: "Admission", order: 2 },
  { id: "mandate", label: "Mandate & operators", order: 3 },
  { id: "model", label: "Model", order: 4 },
  { id: "memory-skills", label: "Memory & skills", order: 5 },
  { id: "behaviors", label: "Exposed behaviors", order: 6 },
];

/** A column of the host: what it does, and where. The identifier is the host's; the rest follows from it. */
function column(
  id: MatrixColumnId,
  group: BodyGroup["id"],
  label: string,
  mode: MatrixGrantMode,
  order: number,
  extra: Partial<Pick<BodyColumn, "target">> = {},
): BodyColumn {
  const { capability, kind } = id.startsWith("tool.build:")
    ? { capability: "ProposeTool", kind: "tool-build" as const }
    : id.startsWith("mandate.change:")
    ? { capability: "ProposeMandateChange", kind: "mandate-change" as const }
    : id.startsWith("behavior:")
    ? { capability: "InvokeBehavior", kind: "behavior" as const }
    : { capability: id, kind: "fixed" as const };
  const common: Pick<
    BodyColumn,
    | "capability"
    | "inTypedPlan"
    | "label"
    | "mode"
    | "tier"
    | "order"
    | "typedScope"
    | "doc"
  > = {
    capability,
    inTypedPlan: true,
    label,
    mode,
    tier: "core",
    order,
    typedScope: "none",
    doc: `What "${label}" lets one do.`,
  };
  // The identifier and the family are checked above; the pairing of a kind with its target is not.
  return { id, kind, group, ...common, ...extra } as BodyColumn;
}

const COLUMNS: readonly BodyColumn[] = [
  column(
    "tool.build:read_web_page",
    "tools",
    "Build tool · read_web_page",
    "propose",
    0,
    {
      target: { kind: "tool-kind", ref: "read_web_page" },
    },
  ),
  column("tool.invoke", "tools", "Use active tools", "execute", 100),
  column("network.reach", "tools", "Reach network hosts", "execute", 110),
  column(
    "candidate.review",
    "admission",
    "Review a tested tool",
    "review",
    200,
  ),
  column("candidate.admit", "admission", "Admit a tool", "admit", 210),
  column(
    "mandate.rewrite",
    "mandate",
    "Rewrite own mandate directly",
    "execute",
    300,
  ),
  column(
    "operator.spawn",
    "mandate",
    "Create operators directly",
    "execute",
    310,
  ),
  column("model.consult", "model", "Read the model sources", "execute", 400),
  column("model.edit", "model", "Propose model edits", "propose", 410),
  column("model.decide", "model", "Accept a model revision", "admit", 420),
  column(
    `behavior:memory-capture@${UNIT}`,
    "memory-skills",
    "Memory · capture",
    "execute",
    1000,
    { target: { kind: "entry-kind", ref: "memory-capture", unit: UNIT } },
  ),
];

/** The place in `configuration.sysml` an element of the owner's mandate is declared at. */
const ownerSource = (
  role: "root" | "holder" | "condition",
  qname: string,
  line: number,
) => ({
  role,
  elementId: `element-${line}`,
  qname,
  file: "configuration.sysml",
  line,
  column: 9,
});

function cell(
  row: string,
  column: BodyCell["column"],
  state: BodyCell["state"],
  more: Partial<BodyCell> = {},
): BodyCell {
  return {
    row,
    column,
    state,
    display: state === "denied"
      ? "denied"
      : state === "propose-only" || more.mode === "propose"
      ? "propose-only"
      : "allowed",
    basis: "declared",
    sources: [],
    codes: [],
    origin: "compiler",
    ...more,
  };
}

const builderSource = {
  role: "grant",
  elementId: "element-mandate",
  qname: `${UNIT}::builderMandate`,
  file: "configuration.sysml",
  line: 295,
  column: 13,
} as const;

/** What the builder holds in both models. */
const BUILDER_CELLS: readonly BodyCell[] = [
  cell(BUILDER, "tool.build:read_web_page", "propose-only", {
    mode: "propose",
    sources: [builderSource],
    via: { kind: "own-declaration" },
    codes: ["ADMISSION_BY_HUMAN"],
  }),
  // Granted, and of no use: the tools it may use are none.
  cell(BUILDER, "tool.invoke", "allowed", {
    mode: "execute",
    sources: [builderSource],
    via: { kind: "unit-configuration", attribute: "mayInvokeActiveCatalog" },
    codes: ["RIGHT_WITHOUT_OBJECT"],
  }),
  cell(BUILDER, "network.reach", "denied", {
    basis: "closed-world",
    codes: ["NO_HOSTS_DECLARED"],
  }),
  cell(BUILDER, "candidate.review", "denied", {
    basis: "closed-world",
    codes: ["SELF_ADMISSION_FORBIDDEN"],
  }),
  cell(BUILDER, "candidate.admit", "denied", {
    basis: "host-rule",
    via: {
      kind: "host-rule",
      rule: "human-decides-candidate-admission-when-admissionMode-is-human",
      enforcedAt: "humanAdmission",
    },
    codes: ["ADMISSION_BY_HUMAN"],
    origin: "host-rule",
  }),
  cell(BUILDER, "mandate.rewrite", "denied", {
    basis: "host-rule",
    codes: ["HARD_DENIED"],
    origin: "host-rule",
  }),
  cell(BUILDER, "operator.spawn", "denied", {
    basis: "host-rule",
    codes: ["HOST_RESERVED"],
    origin: "host-rule",
  }),
  cell(BUILDER, "model.consult", "allowed", {
    mode: "execute",
    sources: [builderSource],
    via: { kind: "own-declaration" },
  }),
  cell(BUILDER, "model.edit", "propose-only", {
    mode: "propose",
    sources: [builderSource],
    via: { kind: "own-declaration" },
    codes: ["PRIVATE_UNTIL_DECIDED"],
    scope: { operations: ["set-value", "insert-member"] },
  }),
  cell(BUILDER, "model.decide", "denied", {
    basis: "host-rule",
    codes: ["OWNER_ONLY_PATH"],
    origin: "host-rule",
  }),
  cell(BUILDER, `behavior:memory-capture@${UNIT}`, "allowed", {
    mode: "execute",
    sources: [builderSource],
    via: { kind: "exposure", accessName: "memoryAccess", accessId: "access-1" },
  }),
];

/** The owner as the model declares it: a holder with a root grant of the whole mandate. */
const OWNER_MODELED_CELLS: readonly BodyCell[] = [
  cell(OWNER, "candidate.review", "allowed", {
    mode: "review",
    basis: "host-rule",
    sources: [
      ownerSource("root", `${UNIT}::owner::ownerMandate::rootGrant`, 293),
    ],
    via: { kind: "root-grant", grant: "owner-root-grant", mandate: "owner" },
    codes: ["OWNER_ROOT_GRANT_UNDIFFERENTIATED"],
    origin: "host-rule",
  }),
  cell(OWNER, "candidate.admit", "allowed", {
    mode: "admit",
    basis: "host-rule",
    sources: [
      ownerSource("root", `${UNIT}::owner::ownerMandate::rootGrant`, 293),
      ownerSource("holder", `${UNIT}::owner::ownerMandate`, 287),
      ownerSource("condition", `${UNIT}::admissionMode`, 284),
    ],
    via: {
      kind: "host-rule",
      rule: "human-decides-candidate-admission-when-admissionMode-is-human",
      enforcedAt: "humanAdmission",
    },
    codes: ["OWNER_ROOT_GRANT_UNDIFFERENTIATED"],
    origin: "host-rule",
  }),
  cell(OWNER, "model.decide", "allowed", {
    mode: "admit",
    basis: "host-rule",
    sources: [
      ownerSource("root", `${UNIT}::owner::ownerMandate::rootGrant`, 293),
    ],
    via: {
      kind: "host-rule",
      rule: "only-local-owner-proposes-decides-and-adopts-through-http",
      enforcedAt: "ownerRevisions",
    },
    codes: ["OWNER_ONLY_PATH"],
    origin: "host-rule",
  }),
];

/** The owner as the host assumes it: nothing in the model, rules of the host. */
const OWNER_IMPLICIT_CELLS: readonly BodyCell[] = [
  cell(OWNER, "candidate.review", "allowed", {
    mode: "review",
    basis: "host-rule",
    sources: [ownerSource("condition", `${UNIT}::admissionMode`, 283)],
    via: {
      kind: "host-rule",
      rule: "human-decides-candidate-admission-when-admissionMode-is-human",
      enforcedAt: "humanAdmission",
    },
    codes: ["OWNER_IMPLICIT"],
    origin: "host-rule",
  }),
  cell(OWNER, "candidate.admit", "allowed", {
    mode: "admit",
    basis: "host-rule",
    sources: [ownerSource("condition", `${UNIT}::admissionMode`, 283)],
    via: {
      kind: "host-rule",
      rule: "human-decides-candidate-admission-when-admissionMode-is-human",
      enforcedAt: "humanAdmission",
    },
    codes: ["OWNER_IMPLICIT"],
    origin: "host-rule",
  }),
];

function matrix(
  authoritySchema: "owner-modeled" | "legacy-v1",
  version: string,
  owner: BodyRow,
  cells: readonly BodyCell[],
): Body {
  return {
    schema: "ase.authority-matrix/1",
    version: version as Body["version"],
    model: {
      name: "initial",
      sourceDigest: "s".repeat(64),
      toolkit: "0.10.10",
      authoritySchema,
      units: [{ system: UNIT, executionDigest: "e".repeat(64) }],
    },
    groups: GROUPS,
    rows: [owner, {
      id: BUILDER,
      kind: "software",
      role: "builder",
      label: `${UNIT}::builder`,
      unit: UNIT,
      declared: true,
      element: {
        role: "holder",
        elementId: BUILDER,
        qname: `${UNIT}::builder`,
        file: "configuration.sysml",
        line: 285,
        column: 9,
      },
    }],
    columns: COLUMNS,
    cells: [...cells, ...BUILDER_CELLS],
    delegations: [],
    diagnostics: [{
      code: "MEMORY_REVIEW_UNREACHABLE",
      severity: "warning",
      context: { unit: UNIT, operator: BUILDER },
      recovery:
        "expose memory-review to a second operator of the same memory owner",
    }],
    caveats: [
      "ADOPTED_VERSION_ONLY",
      "ALLOWED_IS_DECLARED_NOT_EXECUTED",
      "ABSENT_CELL_IS_NOT_APPLICABLE",
    ],
    summary: {
      byState: {
        allowed: 0,
        "propose-only": 0,
        denied: 0,
        inherited: 0,
        delegated: 0,
      },
      uncertain: 0,
      hostRule: 0,
      byRow: {},
      coordinates: { checked: 0, mismatches: 0 },
    },
    digest: (authoritySchema === "legacy-v1" ? "1" : "2").repeat(64),
  };
}

/** The matrix of the initial model whose owner the model declares, as the host sends it. */
export function ownerModeledBody(version: string = HEAD): Body {
  return matrix("owner-modeled", version, {
    id: OWNER,
    kind: "human",
    role: "owner",
    label: "owner",
    unit: UNIT,
    declared: true,
    element: {
      role: "holder",
      elementId: "owner-element",
      qname: `${UNIT}::owner`,
      file: "configuration.sysml",
      line: 286,
      column: 9,
    },
    principal: "local-owner",
  }, OWNER_MODELED_CELLS);
}

/** The matrix of the initial model with the implicit owner of an older model. */
export function legacyBody(version: string = HEAD): Body {
  return matrix("legacy-v1", version, {
    id: OWNER,
    kind: "human",
    role: "owner",
    label: "Owner",
    unit: UNIT,
    declared: false,
    principal: "local-owner",
  }, OWNER_IMPLICIT_CELLS);
}

/** What a page is given: the body, read once. */
export const ownerModeled = (version?: string): AuthorityMatrix =>
  parseMatrix(ownerModeledBody(version));
export const legacy = (version?: string): AuthorityMatrix =>
  parseMatrix(legacyBody(version));

/** A body with a cell changed, or one more: what the host may say that the page has not met. */
export function withCell(
  body: Body,
  row: string,
  column: string,
  patch: Record<string, unknown>,
): Body {
  const found = body.cells.some((one) =>
    one.row === row && one.column === column
  );
  const cells = found
    ? body.cells.map((one) =>
      one.row === row && one.column === column ? { ...one, ...patch } : one
    )
    : [...body.cells, { row, column, sources: [], codes: [], ...patch }];
  return { ...body, cells } as Body;
}

/**
 * A model in which the builder admits its own tools and nobody may review
 * them: the build cell says the builder admits, the builder may admit, and no
 * row may review.
 */
export function selfApprovingBody(version?: string): Body {
  let body = withCell(
    ownerModeledBody(version),
    BUILDER,
    "tool.build:read_web_page",
    {
      codes: ["ADMISSION_BY_BUILDER"],
    },
  );
  body = withCell(body, BUILDER, "candidate.admit", {
    state: "allowed",
    display: "allowed",
    mode: "admit",
    codes: ["ADMISSION_BY_BUILDER"],
    via: { kind: "own-declaration" },
    origin: "compiler",
  });
  return {
    ...body,
    cells: body.cells.filter((one) =>
      !(one.row === OWNER && one.column === "candidate.review")
    ),
  };
}

/** The host's authority matrix route, serving matrices by commit (the owner-modeled one at the head). */
export function matrixHost(
  options: Partial<
    Pick<VersionedHostOptions<Body>, "head" | "bodies" | "fail" | "gate">
  > = {},
) {
  const head = options.head ?? HEAD;
  const host = versionedHost<Body>({
    path: "/api/model/authority-matrix",
    recovery: "Read the authority matrix again.",
    head,
    bodies: options.bodies ?? { [head]: ownerModeledBody(head) },
    fail: options.fail,
    gate: options.gate,
  });
  return {
    fetch: host.fetch,
    requests: host.requests,
    state: host.state,
    matrices: host.bodies,
  };
}
