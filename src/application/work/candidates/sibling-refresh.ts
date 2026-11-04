import type { ClockPort } from "../runtime/ports.ts";
import type { NativeExecutionSnapshot } from "../native-execution/contract.ts";
import {
  canonical,
  compareCodeUnits,
} from "../../../domain/primitives/canonical-json.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { CompiledFlow } from "../../../domain/model/execution/flow.ts";
import type { Candidate } from "../../../domain/work/records/candidates.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import { draftDigest, makeEvent, valueDigest } from "../runtime/values.ts";

interface SiblingRefresh {
  candidateId: string;
  fingerprint: string;
  evidence: NonNullable<Candidate["preparationEvidence"]>;
}

interface SiblingCatalogRefresh {
  publishedCandidateId: string;
  fromCatalogRevision: number;
  modelFingerprint: string;
  siblings: SiblingRefresh[];
}

/** Catalog publication may advance the source commit, never the admitted rights. */
function structure(model: ExecutableModel): string {
  const { catalog: _catalog, version, ...rest } = model;
  const { repositoryVersion: _repositoryVersion, ...structuralVersion } =
    version;
  // Native source excerpts/locations are evidence, excluded from the executable
  // digest as well: inserting a catalog entry can move their source positions.
  const flow = (compiled: CompiledFlow) => {
    const { source: _source, ...semantics } = compiled;
    return {
      ...semantics,
      nodes: compiled.nodes.map(({ source: _source, assertions, ...node }) => ({
        ...node,
        assertions: assertions.map(({ source: _source, ...assertion }) =>
          assertion
        ),
      })),
      edges: compiled.edges.map(({ sourceEvidence: _source, ...edge }) => edge),
      bindings: compiled.bindings.map((
        { sourceEvidence: _source, ...binding },
      ) => binding),
    };
  };
  return canonical({
    ...rest,
    version: structuralVersion,
    flows: Object.fromEntries(
      Object.entries(model.flows).map((
        [key, compiled],
      ) => [key, flow(compiled)]),
    ),
    ...(model.caseFlows
      ? {
        caseFlows: Object.fromEntries(
          Object.entries(model.caseFlows).map((
            [key, compiled],
          ) => [key, flow(compiled)]),
        ),
      }
      : {}),
  });
}

function catalog(model: ExecutableModel): string[] {
  return model.catalog.map(canonical).sort(compareCodeUnits);
}

function sameScope(left: Candidate, right: Candidate): boolean {
  return !!left.caseId && left.caseId === right.caseId &&
      !left.designerScopeId && !right.designerScopeId ||
    !!left.designerScopeId && left.designerScopeId === right.designerScopeId &&
      !left.caseId && !right.caseId;
}

/** Only a verified, single-entry publication can refresh exact prepared siblings.
 * A model adoption, another catalog edit, a recorded decision or incomplete
 * historical evidence keeps the ordinary stale-base refusal. */
export async function prepareSiblingCatalogRefresh(
  state: SystemRuntimeState,
  published: Candidate,
  native: ExecutableModel,
  executions: readonly NativeExecutionSnapshot[] = [],
): Promise<SiblingCatalogRefresh | undefined> {
  const previous = state.executionModel;
  const batch = published.batchCall;
  if (
    !previous || !batch || !batch.batchId || !batch.callId ||
    published.baseCatalogRevision !== state.catalogRevision ||
    structure(previous) !== structure(native)
  ) return undefined;
  const entries = native.catalog.filter((entry) =>
    entry.candidateId === published.id && entry.digest === published.digest &&
    entry.name === published.name && entry.kind === published.kind &&
    entry.status === "active" && native.contracts.filter((contract) =>
        contract.nativeId === entry.contractId &&
        contract.kind === published.kind
      ).length === 1
  );
  if (
    entries.length !== 1 ||
    previous.catalog.some((entry) =>
      entry.nativeId === entries[0]!.nativeId ||
      entry.candidateId === published.id
    ) || canonical(catalog(previous)) !== canonical(catalog({
        ...native,
        catalog: native.catalog.filter((entry) => entry !== entries[0]),
      }))
  ) return undefined;
  const siblings: SiblingRefresh[] = [];
  for (const candidate of state.candidates) {
    const evidence = candidate.preparationEvidence;
    const promotion = executions.find((execution) =>
      execution.identity.purpose === "promotion" &&
      execution.identity.subjectId ===
        candidate.promotionExecution?.subjectId &&
      execution.status === "waiting" &&
      !execution.unsettledEffects.length &&
      execution.modelDigest === native.version.digest
    );
    if (
      candidate.id === published.id ||
      candidate.batchCall?.batchId !== batch.batchId ||
      !candidate.batchCall.callId ||
      candidate.batchCall.callId === batch.callId ||
      !sameScope(candidate, published) ||
      candidate.stage !== "awaiting-admission" || candidate.admission ||
      candidate.admissionDecision || candidate.activationModelDigest ||
      candidate.admissionContinuation ||
      candidate.baseCatalogRevision !== state.catalogRevision ||
      candidate.promotionModelDigest !== native.version.digest ||
      !promotion?.waits.some((wait) =>
        wait.mechanism === "decide_admission" && wait.kind === "decision"
      ) ||
      candidate.proposedConfigurationRevision !==
        native.configuration.revision ||
      candidate.requiredAuthority !==
        native.configuration.builder.admissionAuthority ||
      !native.mandate.mayPropose.includes(candidate.kind) ||
      !candidate.tests?.passed || !candidate.tests.checks.length ||
      candidate.tests.checks.some((check) => !check.passed) || !evidence ||
      evidence.modelDigest !== native.version.digest ||
      await draftDigest(candidate) !== candidate.digest ||
      evidence.testsDigest !== await valueDigest(candidate.tests)
    ) continue;
    const contracts = native.contracts.filter((contract) =>
      contract.kind === candidate.kind
    );
    if (
      contracts.length !== 1 ||
      evidence.contractDigest !== await valueDigest(contracts[0]) ||
      candidate.toolAdmissionContract &&
        canonical(candidate.toolAdmissionContract) !== canonical(contracts[0])
    ) continue;
    if (candidate.review) {
      const proof = candidate.reviewExecution;
      if (
        candidate.review.candidateDigest !== candidate.digest ||
        candidate.review.verdict !== "approve" || !proof ||
        proof.modelDigest !== native.version.digest ||
        proof.testsDigest !== evidence.testsDigest ||
        proof.contractDigest !== evidence.contractDigest ||
        proof.reviewerId !== native.configuration.reviewer?.id ||
        native.flows.promotion.nodes.find((node) =>
            node.nativeId === proof.actionId &&
            node.mechanism === "review_candidate"
          )?.performerId !== native.identity.reviewerId
      ) continue;
    }
    siblings.push({
      candidateId: candidate.id,
      fingerprint: canonical(candidate),
      evidence: structuredClone(evidence),
    });
  }
  return siblings.length
    ? {
      publishedCandidateId: published.id,
      fromCatalogRevision: state.catalogRevision,
      modelFingerprint: canonical(previous),
      siblings,
    }
    : undefined;
}

/** Refresh only the base in native candidate references; arguments, tests and
 * authority-bearing outputs remain exact. */
function refreshReferences(value: unknown, candidate: Candidate, from: number) {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (
    record.id === candidate.id && record.digest === candidate.digest &&
    record.baseCatalogRevision === from
  ) record.baseCatalogRevision = candidate.baseCatalogRevision;
  for (const child of Object.values(record)) {
    refreshReferences(child, candidate, from);
  }
}

/** Applied atomically with the first sibling's adoption. The serialized state
 * must still be the exact state whose tests and catalog were revalidated. */
export function applySiblingCatalogRefresh(
  clock: ClockPort,
  state: SystemRuntimeState,
  refresh: SiblingCatalogRefresh | undefined,
): void {
  if (
    !refresh || state.catalogRevision !== refresh.fromCatalogRevision + 1 ||
    canonical(state.executionModel) !== refresh.modelFingerprint
  ) return;
  for (const prepared of refresh.siblings) {
    const candidate = state.candidates.find((entry) =>
      entry.id === prepared.candidateId
    );
    if (!candidate || canonical(candidate) !== prepared.fingerprint) continue;
    candidate.baseCatalogRevision = state.catalogRevision;
    refreshReferences(
      candidate.promotionContext,
      candidate,
      refresh.fromCatalogRevision,
    );
    (candidate.catalogRefreshes ??= []).push({
      publishedCandidateId: refresh.publishedCandidateId,
      fromCatalogRevision: refresh.fromCatalogRevision,
      toCatalogRevision: state.catalogRevision,
      ...prepared.evidence,
      at: clock.now(),
    });
    state.events.push(
      makeEvent(
        clock,
        "candidate-catalog-base-refreshed",
        `Exact tested sibling revalidated after ${refresh.publishedCandidateId}: catalog ${refresh.fromCatalogRevision} → ${state.catalogRevision}; a separate admission is still required`,
        candidate,
      ),
    );
  }
}
