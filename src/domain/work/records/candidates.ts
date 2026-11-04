/** Tool candidate lifecycle: drafts, tests, review, admission. */
import type { AuthorityExercise } from "../../governance/authority.ts";
import type { ToolKind } from "../../shared-kernel/tool-kind.ts";

export interface ToolContract {
  kind: ToolKind;
  module: "default({url,html}) => {title,text}";
  acceptanceCriteria: readonly string[];
}
const COMMON_CRITERIA = [
  "Return the actual nonempty HTML document title and readable text, decoding HTML entities.",
  "Exclude script, style and comment contents; never execute HTML scripts.",
  "Pure self-contained HTML transformation: no imports, DOMParser, fetch, network, files, environment, subprocesses or ambient permissions. URL is available for URL resolution.",
] as const;

export const TOOL_CONTRACTS: readonly ToolContract[] = [
  {
    kind: "read_web_page",
    module: "default({url,html}) => {title,text}",
    acceptanceCriteria: [
      ...COMMON_CRITERIA,
      "Preserve the meaningful body text, including prose and headings. Three varied full-text extraction fixtures must pass.",
    ],
  },
  {
    kind: "read_web_page_outline",
    module: "default({url,html}) => {title,text}",
    acceptanceCriteria: [
      ...COMMON_CRITERIA,
      "text conveys all h1-h6 heading texts in document order and the distinct canonical absolute http(s) URLs from anchor href attributes, in first occurrence order. Full body prose is not required.",
      "Resolve relative paths, ../ paths, ?queries and //host URLs using new URL(href, url). Decode HTML entities in href; remove URL fragments, deduplicate after canonicalization, skip empty or fragment-only href and all non-http(s) schemes (including javascript:, data:, mailto:).",
      "Render each canonical URL intact in text, separated by whitespace or Markdown link delimiters. Three varied outline extraction fixtures must pass.",
    ],
  },
];

/** A contract occurrence identified by the admitted native source. */
export interface NativeToolContract extends ToolContract {
  nativeId: string;
}

/** The target system's conversation and capability lifecycle, independent of its editor/provider. */
export interface ToolDraft {
  name: string;
  description: string;
  kind: ToolKind;
  /** ES module exporting default ({url, html}) => {title, text}; no ambient permissions. */
  code: string;
}

export type Stage =
  | "proposed"
  | "testing"
  | "reviewing"
  | "awaiting-admission"
  | "refused"
  | "activating"
  | "active"
  | "failed";

export interface ExecutableCatalogEntry {
  nativeId: string;
  candidateId: string;
  contractId: string;
  name: string;
  kind: ToolKind;
  digest: string;
  status: Stage;
}

export interface TestReport {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

export interface ReviewDecision {
  authorityExercise?: AuthorityExercise;
  candidateDigest: string;
  verdict: "approve" | "refuse";
  reason: string;
}

export interface ModelBinding {
  elementId: string;
  graphPath: string;
}

/** Immutable source provenance, distinct from admission under the local mandate. */
export interface ArtifactReuseOrigin {
  sourceReference?:
    import("../artifacts/source-reference.ts").ArtifactSourceReference;
  agentId: string;
  candidateId: string;
  digest: string;
  correlationId: string;
  behaviorId: string;
  sourceModelDigest: string;
  sourceRepositoryVersion: string;
}

export interface Candidate extends ToolDraft {
  /** Retained Git source plus immutable target-local PostgreSQL binding. */
  sourceBinding?:
    import("../artifacts/source-reference.ts").ArtifactSourceBindingReference;
  designerScopeId?: string;
  id: string;
  /** Written at creation or legacy migration; excluded from the draft digest. */
  caseId?: string;
  digest: string;
  stage: Stage;
  createdAt: string;
  baseCatalogRevision: number;
  /** Host attribution to one validated provider response; never supplied by a draft. */
  batchCall?: { batchId: string; callId: string };
  /** Exact successful test inputs, retained across catalog-only sibling publications. */
  preparationEvidence?: {
    modelDigest: string;
    testsDigest: string;
    contractDigest: string;
  };
  /** Explicit safe base refreshes after verified publication of an exact sibling. */
  catalogRefreshes?: Array<{
    publishedCandidateId: string;
    fromCatalogRevision: number;
    toCatalogRevision: number;
    modelDigest: string;
    testsDigest: string;
    contractDigest: string;
    at: string;
  }>;
  tests?: TestReport;
  review?: ReviewDecision;
  /** Evidence from the explicit native review action, never an admission grant. */
  reviewExecution?: {
    modelDigest: string;
    actionId: string;
    reviewerId: string;
    testsDigest: string;
    contractDigest: string;
  };
  binding?: ModelBinding;
  /** Durable activation intent; replay is allowed only under this admitted contract. */
  activationModelDigest?: string;
  /** Publications requested of the port for the admitted activation; bounded by MAX_ACTIVATION_ATTEMPTS. */
  activationAttempts?: number;
  error?: string;
  /** Stable code of a terminal failure; absent for transient or legacy errors. */
  errorCode?: string;
  admission?: AdmissionRecord;
  admissionDecision?: ReviewDecision;
  /** One exact closed-preparation to open-control transition, never a general Case resume. */
  initialAdmissionTransfer?: InitialToolAdmissionTransfer;
  /** Exact native conversation to finish after an interrupted delegated activation. */
  admissionContinuation?: {
    modelDigest: string;
    fingerprint: string;
    inputMessageId: string;
    messageStart: number;
    priorCandidateIds: string[];
    work?: {
      receipt: import("../execution/case-context.ts").OperatorWorkReceipt;
      messageRanges: Array<{ start: number; end: number }>;
      candidateIds: string[];
    };
  };
  requiredAuthority?: "human" | "builder" | "reviewer";
  proposedConfigurationRevision?: number;
  /** Adopted grants captured before preparing this exact candidate. */
  toolAdmissionPolicyPins?: Array<{
    policyId: string;
    policyRevision: number;
    holderNativeId: string;
    policyElementId: string;
  }>;
  /** Exact contract already admitted before tests for delegated admission. */
  toolAdmissionContract?: NativeToolContract;
  /** Framework-owned continuation identity; no checkpoint bytes in business state. */
  promotionExecution?: {
    subjectId: string;
    threadId?: string;
    modelDigest: string;
    inputMessageId?: string;
  };
  promotionCursor?: { nodeId: string };
  promotionModelDigest?: string;
  promotionContext?: Record<string, unknown>;
  /** Exact batch promotion outputs retained across interruption, without re-drafting. */
  promotionActionResults?: Record<
    string,
    import("../../model/execution/flow.ts").FlowActionResult
  >;
  reusedFrom?: ArtifactReuseOrigin;
  /** Exact source-selected bytes still follow ordinary candidate promotion. */
  initialToolSeed?: {
    id: string;
    nativeId: string;
    selectionDigest: string;
    modelVersion: { digest: string; repositoryVersion: string };
  };
}

export interface AdmissionRecord {
  authorityExercise?: AuthorityExercise;
  candidateId: string;
  mandateRevision: number;
  authority: "human" | "builder" | "reviewer" | "delegate";
  actorId: string;
  candidateDigest: string;
  configurationRevision: number;
  reason: string;
  at: string;
}

/** Frozen host intent. Checkpoint bytes and mutable transfer phases belong to the
 * native ledger, not the candidate journal. */
export interface InitialToolAdmissionTransfer {
  kind: "initial-tool-admission-transfer";
  key: string;
  runtimeId: string;
  projectId: string;
  systemId: string;
  operatorId: string;
  candidateId: string;
  candidateDigest: string;
  seed: NonNullable<Candidate["initialToolSeed"]>;
  sourceBinding: NonNullable<Candidate["sourceBinding"]>;
  preparationEvidence: NonNullable<Candidate["preparationEvidence"]>;
  testsDigest: string;
  decision: ReviewDecision;
  decisionDigest: string;
  contribution: { id: string; kind: "resume" };
  sourceRevision: number;
  source: {
    identity: InitialAdmissionExecutionIdentity;
    threadId: string;
    runId: string;
    checkpointNamespace: string;
    checkpointId: string;
    contributionId: string;
    snapshotDigest: string;
    caseId: string;
    caseDigest: string;
    occurrenceId: string;
    actionId: string;
    preparedNodeId: string;
    settledEffectKey: string;
  };
  target: {
    identity: InitialAdmissionExecutionIdentity;
    caseId: string;
    /** Immutable birth record, excluding status/closedAt; lifecycle is revalidated separately. */
    caseDigest: string;
  };
  pin: {
    modelDigest: string;
    repositoryVersion: string;
    flowRootId: string;
    flowOccurrenceId: string;
    flowDigest: string;
    maxSteps: number;
  };
}
export interface InitialAdmissionExecutionIdentity {
  operatorId: string;
  invocationKey: string;
  scope: { kind: "request"; scopeId: string; rootRequestId: string };
  purpose: "promotion";
  subjectId?: string;
}
