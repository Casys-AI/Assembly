import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import type {
  NativeExecutionRequest,
  NativeExecutionSnapshot,
  NativeThreadAdvanceAuthorization,
  RequestNetworkContinuation,
} from "../native-execution/contract.ts";
import type { OperatorExecutionDelivery } from "../operators/execution.ts";
import { requestExecutionPinFor } from "../../model/evolution/request-execution-pin.ts";
import type { RequestSourceAdmission } from "../../model/source-admission/request-source-admission.ts";
import {
  assertRequestTeamPublicationBase,
  parseRequestAdoptionManifest,
  parseRequestAdoptionReceipt,
} from "../../model/evolution/request-adoption-invariants.ts";
import { requestWriteAuthorityPrior } from "../../model/source-admission/request-delegated-authority.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { ScopedSoftwareNeverStartedSuccessorContext } from "./scoped-software-adoption-successor.ts";
import {
  canonicalDigest,
  executionDigest,
  isSha256Hex,
} from "../../../domain/primitives/execution-digest.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  RequestAdoptionManifest,
  RequestAdoptionReceipt,
  RequestExecutionPin,
} from "../../model/evolution/request-adoption-ports.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";

interface OwnerSuccessorSelection {
  authorization: Extract<
    NativeThreadAdvanceAuthorization,
    { kind: "owner-adoption" }
  >;
  source: unknown;
  target: unknown;
}

/** Retained lineage facts. A prior receipt or an inert row grants no current
 * adoption authority and is never represented as an executed native snapshot. */

export interface RequestNeverStartedSuccessorContext {
  readonly currentPin: RequestExecutionPin;
  readonly adoptions: readonly {
    readonly manifest: RequestAdoptionManifest;
    readonly receipt: RequestAdoptionReceipt;
  }[];
}
export interface NeverStartedAdoptionSource {
  readonly v: 1;
  readonly kind: "never-started-adoption-successor";
  readonly threadId: string;
  readonly predecessorThreadId: string;
  readonly identityDigest: string;
  readonly previousCommandId: string;
  readonly previousReceiptDigest: string;
  readonly previousAuthorizationRuntimeRevision: number;
  readonly previousCommittedRuntimeRevision: number;
  readonly authorizedPinDigest: string;
  readonly advanceAuthorizationDigest: string;
}
const fields = [
  "v",
  "kind",
  "threadId",
  "predecessorThreadId",
  "identityDigest",
  "previousCommandId",
  "previousReceiptDigest",
  "previousAuthorizationRuntimeRevision",
  "previousCommittedRuntimeRevision",
  "authorizedPinDigest",
  "advanceAuthorizationDigest",
] as const;
export function parseNeverStartedAdoptionSource(
  input: unknown,
): NeverStartedAdoptionSource {
  const value = structuredClone(input);
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key))
  ) throw new Error("Closed never-started adoption source required");
  const row = value as Record<string, unknown>;
  if (row.v !== 1 || row.kind !== "never-started-adoption-successor") {
    throw new Error("Unknown never-started adoption source");
  }
  for (
    const key of [
      "threadId",
      "predecessorThreadId",
      "previousCommandId",
    ] as const
  ) {
    if (
      typeof row[key] !== "string" || !row[key] || row[key].length > 1024 ||
      [...row[key]].some((character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )
    ) throw new Error("Invalid never-started source identity");
  }
  for (
    const key of [
      "identityDigest",
      "previousReceiptDigest",
      "authorizedPinDigest",
      "advanceAuthorizationDigest",
    ] as const
  ) {
    if (!isSha256Hex(row[key])) {
      throw new Error("Invalid never-started source digest");
    }
  }
  if (
    !Number.isSafeInteger(row.previousAuthorizationRuntimeRevision) ||
    Number(row.previousAuthorizationRuntimeRevision) < 1 ||
    row.previousCommittedRuntimeRevision !==
      Number(row.previousAuthorizationRuntimeRevision) + 1 ||
    row.threadId === row.predecessorThreadId
  ) throw new Error("Invalid never-started source revision lineage");
  return value as NeverStartedAdoptionSource;
}
export async function parseRequestNeverStartedSuccessorContext(
  input: RequestNeverStartedSuccessorContext,
): Promise<RequestNeverStartedSuccessorContext> {
  const value = structuredClone(input);
  if (
    !value || Object.keys(value).sort().join(",") !== "adoptions,currentPin" ||
    !value.currentPin || !Array.isArray(value.adoptions) ||
    value.adoptions.length > 1 ||
    (value.currentPin.adoption === null
      ? value.adoptions.length !== 0
      : value.adoptions.length !== 1)
  ) {
    throw new Error("Only the exact latest executing adoption is permitted");
  }
  if (value.currentPin.adoption === null) return value;
  for (const entry of value.adoptions) {
    if (!entry || Object.keys(entry).sort().join(",") !== "manifest,receipt") {
      throw new Error("Closed prior adoption proof required");
    }
    const manifest = await parseRequestAdoptionManifest(entry.manifest),
      receipt = await parseRequestAdoptionReceipt(entry.receipt);
    if (
      receipt.commandId !== manifest.commandId ||
      receipt.committedRuntimeRevision !== manifest.committedRuntimeRevision ||
      receipt.journalRevision !== manifest.predecessor.revision + 1 ||
      receipt.journalDigest !== await canonicalDigest(manifest)
    ) throw new Error("Prior adoption receipt and manifest disagree");
  }
  const latest = value.adoptions.at(-1)!, pin = value.currentPin;
  if (
    canonical(pin.adoption) !==
      canonical({
        commandId: latest.receipt.commandId,
        receiptDigest: latest.receipt.receiptDigest,
        committedRuntimeRevision: latest.receipt.committedRuntimeRevision,
      }) ||
    pin.modelDigest !== latest.manifest.intent.candidate.model.version.digest ||
    canonical(pin.source) !==
      canonical(latest.manifest.intent.candidate.source) ||
    canonical(pin.sourceAdmission) !==
      canonical(latest.manifest.intent.candidate.sourceAdmission) ||
    value.adoptions.some((entry) =>
      canonical(entry.manifest.intent.target) !==
        canonical(latest.manifest.intent.target)
    )
  ) {
    throw new Error(
      "Never-started proof is not the exact latest executing adoption",
    );
  }
  return value;
}
/** The one change proof an owner-adoption retirement carries (4.8e): the
 * network proof or its team twin, read through the same exact fields. */
export type OwnerAdoptionChange = {
  /** Network is the historical receipt-bound continuation transport. */
  kind: "network" | "team";
  creationPolicy?: true;
  proof: {
    changeId: string;
    proposalIntentDigest: string;
    approvedChangeDigest: string;
    sourceAdmission: { revision: number };
    publicationBase?: ExecutableModel;
  };
  compatibilityDigest?: string;
  checkpointDigest?: string;
};
export function ownerAdoptionChange(
  authorization: unknown,
): OwnerAdoptionChange | undefined {
  if (
    !authorization || typeof authorization !== "object" ||
    (authorization as { kind?: unknown }).kind !== "owner-adoption"
  ) return undefined;
  const value = authorization as {
    network?: OwnerAdoptionChange["proof"];
    networkCompatibilityDigest?: string;
    creationPolicy?: OwnerAdoptionChange["proof"];
    creationPolicyCompatibilityDigest?: string;
    networkCheckpointDigest?: string;
    team?: OwnerAdoptionChange["proof"];
    teamCompatibilityDigest?: string;
    teamCheckpointDigest?: string;
  };
  if (value.creationPolicy) {
    return {
      kind: "network",
      creationPolicy: true,
      proof: value.creationPolicy,
      compatibilityDigest: value.creationPolicyCompatibilityDigest,
      checkpointDigest: value.networkCheckpointDigest,
    };
  }
  if (value.network) {
    return {
      kind: "network",
      proof: value.network,
      compatibilityDigest: value.networkCompatibilityDigest,
      checkpointDigest: value.networkCheckpointDigest,
    };
  }
  if (value.team) {
    return {
      kind: "team",
      proof: value.team,
      compatibilityDigest: value.teamCompatibilityDigest,
      checkpointDigest: value.teamCheckpointDigest,
    };
  }
  return undefined;
}

/** Read one exact successor authorization at a time in persisted manifest order. */
export async function verifyPriorNativeRetirementDigest(
  context:
    | RequestNeverStartedSuccessorContext
    | ScopedSoftwareNeverStartedSuccessorContext,
  readAuthorization: (threadId: string) => Promise<string>,
): Promise<void> {
  const prior = "previous" in context
      ? context.previous
      : context.adoptions.at(-1)!,
    waiting: string[] = [],
    inert: string[] = [];
  let first: { authorization: unknown; target: unknown } | undefined;
  for (const threadId of prior.manifest.nativeRetirement.successorThreadIds) {
    const authorizationJson = await readAuthorization(threadId);
    const value = JSON.parse(authorizationJson);
    if (canonical(value) !== authorizationJson) {
      throw new Error(
        "Prior native successor authorization bytes are noncanonical",
      );
    }
    first ??= value;
    if (value.source?.kind === "never-started-adoption-successor") {
      parseNeverStartedAdoptionSource(value.source);
      inert.push(authorizationJson);
    } else {
      if (value.source?.kind !== undefined) {
        throw new Error("Unknown native adoption source kind");
      }
      waiting.push(authorizationJson);
    }
  }
  if (!first) {
    throw new Error("Prior adoption has no selected native successor proof");
  }
  const actual = await executionDigest({
    predecessorThreadIds: prior.manifest.nativeRetirement.predecessorThreadIds,
    successorThreadIds: prior.manifest.nativeRetirement.successorThreadIds,
    emptyAuthorization: waiting.length ? null : canonical({
      authorization: first.authorization,
      source: null,
      target: first.target,
    }),
    ...(inert.length ? { neverStartedAuthorizations: inert } : {}),
    authorizations: waiting,
  });
  if (actual !== prior.manifest.nativeRetirement.digest) {
    throw new Error(
      "Prior native retirement digest differs from retained successor bytes",
    );
  }
}

export function assertOwnerSuccessorCurrentPin(
  context: RequestNeverStartedSuccessorContext,
  current: SystemRuntimeState,
) {
  if (
    current.executionModel?.version.digest !==
      context.currentPin.modelDigest ||
    current.executionModel.version.repositoryVersion !==
      context.currentPin.source.version
  ) throw new Error("Never-started successor current execution pin changed");
}

export function assertOwnerSuccessorSelection(
  manifest: RequestAdoptionManifest,
  priorAuthorization: OwnerSuccessorSelection,
  authorizationJson: string,
) {
  if (
    canonical(priorAuthorization) !== authorizationJson ||
    Object.keys(priorAuthorization).sort().join(",") !==
      "authorization,source,target" ||
    priorAuthorization.authorization?.kind !== "owner-adoption" ||
    priorAuthorization.authorization.authorizationEventId !==
      `${manifest.commandId}:authorization` ||
    priorAuthorization.authorization.businessRevision
        ?.__assemblyRuntimeRevision?.revision !==
      manifest.authorizationRuntimeRevision ||
    canonical(priorAuthorization.target) !==
      canonical({
        identity: manifest.intent.candidate.model.identity,
        version: manifest.intent.candidate.model.version,
      })
  ) {
    throw new Error(
      "Never-started successor lacks its exact prior selection authorization",
    );
  }
}

export function assertOwnerSuccessorAuthorizationHistory(
  manifest: RequestAdoptionManifest,
  priorAuthorization: OwnerSuccessorSelection,
  authorized: SystemRuntimeState,
) {
  const authorizationEvents = authorized.events.filter((event) =>
    event.id === `${manifest.commandId}:authorization`
  );
  const event = authorizationEvents[0];
  if (
    authorized.executionModel?.version.digest !==
      manifest.intent.previous.pin.modelDigest ||
    authorizationEvents.length !== 1 || !event ||
    event.kind !== "model-version-admission-authorized" ||
    authorized.executionModel.version.repositoryVersion !==
      manifest.intent.previous.pin.source.version ||
    canonical(authorized.executionModel.identity) !==
      canonical(manifest.intent.previous.identity) ||
    canonical(event.authorityExercise) !==
      canonical(manifest.intent.decision.exercise) ||
    canonical(event.modelAdoptionAuthorization?.target) !==
      canonical(priorAuthorization.target)
  ) {
    throw new Error(
      "Prior owner authorization history does not prove native selection",
    );
  }
}

export function assertOwnerSuccessorCommittedHistory(
  context: RequestNeverStartedSuccessorContext,
  committed: SystemRuntimeState,
) {
  const manifest = context.adoptions.at(-1)!.manifest,
    target = manifest.intent.target;
  const admittedEvents = committed.events.filter((event) =>
    event.id === `${manifest.commandId}:admitted`
  );
  const effectiveEvents = committed.events.filter((event) =>
    event.effectiveModelUpdate?.dossierId === manifest.commandId &&
    event.effectiveModelUpdate.caseId === target.caseId &&
    event.effectiveModelUpdate.to.digest === context.currentPin.modelDigest &&
    event.effectiveModelUpdate.to.repositoryVersion ===
      context.currentPin.source.version
  );
  if (
    admittedEvents.length !== 1 || effectiveEvents.length !== 1 ||
    canonical(committed.executionModel) !==
      canonical(manifest.intent.candidate.model) ||
    canonical(committed.model) !==
      canonical(manifest.intent.candidate.model.identity) ||
    committed.executionModel?.version.repositoryVersion !==
      context.currentPin.source.version ||
    !committed.events.some((event) =>
      event.id === `${manifest.commandId}:admitted` &&
      event.kind === "model-version-admitted" &&
      event.caseId === target.caseId &&
      canonical(event.authorityExercise) ===
        canonical(manifest.intent.decision.exercise) &&
      event.execution?.digest === context.currentPin.modelDigest &&
      event.execution.repositoryVersion === context.currentPin.source.version
    )
  ) throw new Error("Prior committed adoption history is unavailable");
}

export function assertChangeAdoptionClaim(
  request: NativeExecutionRequest,
  delivery: OperatorExecutionDelivery,
  proof: RequestNetworkContinuation,
  kind: "network" | "team",
) {
  if (
    delivery.kind !== "continuation" ||
    delivery.id !== `${kind}-adoption:${proof.receiptDigest}` ||
    request.contribution.id !== delivery.id ||
    request.contribution.kind !== "resume" ||
    request.contribution.inputMessageId !== proof.originalInputMessageId ||
    canonical(
        kind === "team"
          ? request.contribution.teamAdoptionContinuation
          : request.contribution.networkAdoptionContinuation,
      ) !== canonical(proof) ||
    canonical(
        kind === "team"
          ? delivery.payload?.teamAdoption
          : delivery.payload?.networkAdoption,
      ) !== canonical(proof) ||
    delivery.payload?.inputMessageId !== proof.originalInputMessageId ||
    canonical(delivery.identity) !== canonical(request.identity) ||
    request.identity.scope.kind !== "request" ||
    request.identity.subjectId !== proof.originalInputMessageId
  ) {
    throw new Error("The exact network continuation claim is unavailable");
  }
}

export function changeAdoptionLineage(
  request: NativeExecutionRequest,
  proof: RequestNetworkContinuation,
  kind: "network" | "team",
  lineage: {
    authorization?: NativeThreadAdvanceAuthorization;
    source?: NativeExecutionSnapshot;
    target?: unknown;
  },
) {
  const authorization = lineage.authorization, snapshot = lineage.source;
  const changeProof = ownerAdoptionChange(authorization);
  if (
    !snapshot || authorization?.kind !== "owner-adoption" ||
    changeProof?.kind !== kind || !changeProof.checkpointDigest ||
    snapshot.threadId !== proof.predecessorThreadId ||
    snapshot.checkpointId !== proof.checkpointId ||
    snapshot.identity.subjectId !== proof.originalInputMessageId ||
    canonical(snapshot.identity) !== canonical(request.identity) ||
    canonical(lineage.target) !==
      canonical({
        identity: request.model.identity,
        version: request.model.version,
      }) ||
    changeProof.proof.changeId !== proof.changeId ||
    changeProof.proof.proposalIntentDigest !==
      proof.proposalIntentDigest ||
    authorization.authorizationEventId !==
      `${proof.commandId}:authorization`
  ) throw new Error("The network continuation lineage differs");
  return { authorization, snapshot, changeProof };
}

export function changeAdoptionRetirement(
  request: NativeExecutionRequest,
  proof: RequestNetworkContinuation,
  kind: "network" | "team",
  changeProof: OwnerAdoptionChange,
  execution: Parameters<typeof requestExecutionPinFor>[0],
  base: Parameters<typeof requestExecutionPinFor>[2],
) {
  const admitted = execution.adoptions.find((entry) =>
    entry.manifest.commandId === proof.commandId
  );
  const pin = requestExecutionPinFor(
    execution,
    request.identity.operatorId,
    base,
  );
  if (
    !admitted || admitted.receipt.receiptDigest !== proof.receiptDigest ||
    admitted.manifest.intent.target.operatorId !==
      request.identity.operatorId ||
    pin.adoption?.commandId !== proof.commandId ||
    pin.adoption.receiptDigest !== proof.receiptDigest ||
    canonical(
        kind === "team"
          ? admitted.manifest.intent.team
          : changeProof.creationPolicy
          ? admitted.manifest.intent.creationPolicy
          : admitted.manifest.intent.network,
      ) !== canonical(changeProof.proof) ||
    admitted.manifest.intent.candidate.model.version.digest !==
      request.model.version.digest ||
    admitted.manifest.intent.candidate.source.version !==
      request.model.version.repositoryVersion
  ) throw new Error("The network adoption receipt differs");
  const index = admitted.manifest.nativeRetirement.predecessorThreadIds
    .indexOf(proof.predecessorThreadId);
  if (
    index < 0 ||
    admitted.manifest.nativeRetirement.successorThreadIds[index] !==
      proof.successorThreadId
  ) throw new Error("The network retirement pair differs");
  const retirement = admitted.manifest.nativeRetirement;
  if (
    !retirement.predecessorThreadIds.length ||
    retirement.predecessorThreadIds.length !==
      retirement.successorThreadIds.length ||
    retirement.predecessorThreadIds.length > 256
  ) throw new Error("The network retirement set differs");
  return retirement;
}

export function assertChangeAdoptionPublication(
  kind: "network" | "team",
  changeProof: OwnerAdoptionChange,
  sourceReceipt: { payload: RequestSourceAdmission } | undefined,
  reread: OwnerAdoptionChange["proof"] | undefined,
) {
  if (kind === "team" && sourceReceipt) {
    assertRequestTeamPublicationBase(
      changeProof.proof.publicationBase,
      sourceReceipt.payload.predecessor.source.version,
      requestWriteAuthorityPrior(sourceReceipt.payload.authority),
    );
  }
  if (
    !sourceReceipt || !reread ||
    canonical(
        kind === "team"
          ? {
            kind: "request-team-creation-adoption/v1",
            changeId: reread.changeId,
            proposalIntentDigest: reread.proposalIntentDigest,
            approvedChangeDigest: reread.approvedChangeDigest,
            sourceAdmission: reread.sourceAdmission,
            // The child and the candidate team were derived from the
            // published source at preparation; the publication facts
            // above are what is re-read.
            childSystemId: (changeProof.proof as { childSystemId?: string })
              .childSystemId,
            team: (changeProof.proof as { team?: unknown }).team,
            ...(changeProof.proof.publicationBase !== undefined
              ? { publicationBase: changeProof.proof.publicationBase }
              : {}),
          }
          : {
            kind: changeProof.creationPolicy
              ? "request-creation-policy-adoption/v1"
              : "request-network-host-adoption/v1",
            ...reread,
          },
      ) !==
      canonical(changeProof.proof)
  ) throw new Error("The network publication receipt differs");
}

/** Exact predecessor strings and identity are retained provenance, never authority. */
export interface RetainedInertPredecessor {
  threadId: unknown;
  predecessorThreadId: unknown;
  authorizedPinJson: unknown;
  advanceAuthorizationJson: unknown;
}

export async function assertOwnerInertSourceMarker(
  marker: NeverStartedAdoptionSource,
  earlier: RequestExecutionPin["adoption"],
  authorizationRuntimeRevision: number,
  identityDigest: string,
  retained: RetainedInertPredecessor,
) {
  if (
    marker.threadId !== retained.threadId ||
    marker.predecessorThreadId !== retained.predecessorThreadId ||
    marker.identityDigest !== identityDigest ||
    !earlier || earlier.commandId !== marker.previousCommandId ||
    earlier.receiptDigest !== marker.previousReceiptDigest ||
    earlier.committedRuntimeRevision - 1 !==
      marker.previousAuthorizationRuntimeRevision ||
    earlier.committedRuntimeRevision !==
      marker.previousCommittedRuntimeRevision ||
    earlier.committedRuntimeRevision >=
      authorizationRuntimeRevision ||
    typeof retained.authorizedPinJson !== "string" ||
    typeof retained.advanceAuthorizationJson !== "string" ||
    await sha256(retained.authorizedPinJson) !==
      marker.authorizedPinDigest ||
    await sha256(retained.advanceAuthorizationJson) !==
      marker.advanceAuthorizationDigest
  ) {
    throw new Error(
      "Prior never-started source marker differs from retained native evidence",
    );
  }
}
