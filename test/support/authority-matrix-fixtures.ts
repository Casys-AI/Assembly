import type {
  AuthorityMatrix,
  AuthoritySchema,
  MatrixCell,
  MatrixCellCode,
  MatrixColumnId,
  MatrixRow,
} from "../../src/domain/governance/records/authority-matrix.ts";
import { parseModelRevisionId } from "../../src/domain/shared-kernel/revision-id.ts";

// Extracted from data-demo-ase.json, data-commercial-watch.json and the
// scratchpad's matrix-initial-lot1.json on 2026-10-25. No live Toolkit required.
export const fixtureColumnIds = [
  "behavior:context-evidence@ASELiveBuilder::liveBuilder",
  "behavior:inbox@ASEAnalysis::analyst",
  "behavior:inbox@ASECollect::collector",
  "behavior:memory-capture@ASELiveBuilder::liveBuilder",
  "behavior:memory-recall@ASELiveBuilder::liveBuilder",
  "behavior:memory-review@ASELiveBuilder::liveBuilder",
  "behavior:memory-revise@ASELiveBuilder::liveBuilder",
  "behavior:memory-withdraw@ASELiveBuilder::liveBuilder",
  "behavior:published-tools@ASEAnalysis::analyst",
  "behavior:published-tools@ASECollect::collector",
  "behavior:reuse-tool@ASEAnalysis::analyst",
  "behavior:reuse-tool@ASECollect::collector",
  "behavior:skill-install@ASELiveBuilder::liveBuilder",
  "behavior:skill-list@ASELiveBuilder::liveBuilder",
  "behavior:skill-load@ASELiveBuilder::liveBuilder",
  "behavior:skill-unload@ASELiveBuilder::liveBuilder",
  "behavior:work-plan@ASELiveBuilder::liveBuilder",
  "candidate.activate",
  "candidate.admit",
  "candidate.review",
  "mandate.change:network-hosts",
  "mandate.change:self-admission",
  "mandate.change:url-selection",
  "mandate.rewrite",
  "model.administer",
  "model.adopt",
  "model.consult",
  "model.decide",
  "model.edit",
  "network.reach",
  "operator.create:reviewer",
  "operator.spawn",
  "tool.build:read_web_page",
  "tool.build:read_web_page_outline",
  "tool.invoke",
] as const satisfies readonly MatrixColumnId[];
export const fixtureCellCodes = [
  "ADMISSION_BY_BUILDER",
  "ADMISSION_BY_HUMAN",
  "EFFECTIVELY_UNREACHABLE",
  "HARD_DENIED",
  "HOST_RESERVED",
  "HUMAN_ADMISSION_NOT_REQUIRED",
  "MODEL_POLICY_FORBIDS",
  "NEEDS_HUMAN_DECISION",
  "NETWORK_SCOPE_UNUSED",
  "NO_ADMINISTRATION_POLICY",
  "NO_EDIT_POLICY",
  "NO_HOSTS_DECLARED",
  "NO_REACHABLE_HOST",
  "OWNER_IMPLICIT",
  "OWNER_ONLY_PATH",
  "OWNER_ROOT_GRANT_UNDIFFERENTIATED",
  "PRIVATE_UNTIL_DECIDED",
  "RIGHT_WITHOUT_OBJECT",
  "SELF_ADMISSION_FORBIDDEN",
] as const satisfies readonly MatrixCellCode[];
export const fixtureOwners = [
  {
    "authoritySchema": "legacy-v1",
    "row": {
      "id": "owner@ASELiveBuilder::liveBuilder",
      "kind": "human",
      "role": "owner",
      "label": "Owner",
      "unit": "ASELiveBuilder::liveBuilder",
      "declared": false,
      "principal": "local-owner",
    },
    "cell": {
      "row": "owner@ASELiveBuilder::liveBuilder",
      "column": "candidate.admit",
      "state": "allowed",
      "mode": "admit",
      "basis": "host-rule",
      "sources": [
        {
          "role": "condition",
          "elementId": "941130c4-35a8-5cd1-bab8-7aa9c75ad65c",
          "qname": "ASELiveBuilder::liveBuilder::admissionMode",
          "file": "configuration.sysml",
          "line": 283,
          "column": 9,
        },
      ],
      "via": {
        "kind": "host-rule",
        "rule": "human-decides-candidate-admission-when-admissionMode-is-human",
        "enforcedAt": "humanAdmission",
      },
      "codes": [
        "OWNER_IMPLICIT",
      ],
      "origin": "host-rule",
      "scope": {
        "subject": "any-candidate",
        "requires": [
          "tests-passed",
          "exact-digest",
          "current-catalog-revision",
        ],
        "performedBy": [
          "ASELiveBuilder::liveBuilder::admissionGate",
        ],
      },
      "display": "allowed",
    },
  },
  {
    "authoritySchema": "legacy-v1",
    "row": {
      "id": "owner@ASEAnalysis::analyst",
      "kind": "human",
      "role": "owner",
      "label": "Owner",
      "unit": "ASEAnalysis::analyst",
      "declared": false,
      "principal": "local-owner",
    },
    "cell": {
      "row": "owner@ASEAnalysis::analyst",
      "column": "candidate.admit",
      "state": "denied",
      "basis": "host-rule",
      "sources": [
        {
          "role": "condition",
          "elementId": "406adaea-6cf9-5376-9d09-b28aef528031",
          "qname": "ASEAnalysis::analyst::admissionMode",
          "file": "analysis.sysml",
          "line": 21,
          "column": 9,
        },
      ],
      "via": {
        "kind": "host-rule",
        "rule": "human-decides-candidate-admission-when-admissionMode-is-human",
        "enforcedAt": "humanAdmission",
      },
      "codes": [
        "HUMAN_ADMISSION_NOT_REQUIRED",
      ],
      "origin": "host-rule",
      "display": "denied",
    },
  },
  {
    "authoritySchema": "owner-modeled",
    "row": {
      "id": "owner@ASELiveBuilder::liveBuilder",
      "kind": "human",
      "role": "owner",
      "label": "owner",
      "unit": "ASELiveBuilder::liveBuilder",
      "declared": true,
      "element": {
        "role": "holder",
        "elementId": "4af0de27-64b9-5ad3-87bb-474f1955aa9a",
        "qname": "ASELiveBuilder::liveBuilder::owner",
        "file": "configuration.sysml",
        "line": 286,
        "column": 9,
      },
      "principal": "local-owner",
    },
    "cell": {
      "row": "owner@ASELiveBuilder::liveBuilder",
      "column": "candidate.admit",
      "state": "allowed",
      "mode": "admit",
      "basis": "host-rule",
      "sources": [
        {
          "role": "root",
          "elementId": "752742c1-faba-589c-921f-eaed749d3783",
          "qname":
            "ASELiveBuilder::liveBuilder::owner::ownerMandate::rootGrant",
          "file": "configuration.sysml",
          "line": 293,
          "column": 17,
        },
        {
          "role": "holder",
          "elementId": "d8355eda-485a-586d-a9ed-426acf3b18d4",
          "qname": "ASELiveBuilder::liveBuilder::owner::ownerMandate",
          "file": "configuration.sysml",
          "line": 287,
          "column": 13,
        },
        {
          "role": "condition",
          "elementId": "941130c4-35a8-5cd1-bab8-7aa9c75ad65c",
          "qname": "ASELiveBuilder::liveBuilder::admissionMode",
          "file": "configuration.sysml",
          "line": 284,
          "column": 9,
        },
      ],
      "via": {
        "kind": "root-grant",
        "grant": "owner-root-grant",
        "mandate": "owner",
      },
      "codes": [
        "OWNER_ROOT_GRANT_UNDIFFERENTIATED",
      ],
      "origin": "host-rule",
      "scope": {
        "subject": "any-candidate",
        "requires": [
          "tests-passed",
          "exact-digest",
          "current-catalog-revision",
        ],
        "performedBy": [
          "ASELiveBuilder::liveBuilder::admissionGate",
        ],
      },
      "display": "allowed",
    },
  },
] as const satisfies readonly {
  authoritySchema: AuthoritySchema;
  row: MatrixRow;
  cell: MatrixCell;
}[];

export const MATRIX_VERSION = `commit:${"a".repeat(40)}`;
export const MATRIX_DIGEST = "d".repeat(64);

export function matrixFixture(version = MATRIX_VERSION): AuthorityMatrix {
  const sample = fixtureOwners[2];
  return {
    schema: "ase.authority-matrix/1",
    version: parseModelRevisionId(version),
    model: {
      name: "initial",
      sourceDigest: "s".repeat(64),
      toolkit: "0.10.10",
      authoritySchema: sample.authoritySchema,
      units: [{ system: sample.row.unit, executionDigest: "e".repeat(64) }],
    },
    groups: [],
    rows: [sample.row],
    columns: [],
    cells: [],
    delegations: [],
    diagnostics: [],
    caveats: ["ADOPTED_VERSION_ONLY"],
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
    digest: MATRIX_DIGEST,
  };
}
