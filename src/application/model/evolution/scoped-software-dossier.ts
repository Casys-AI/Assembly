import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  canonicalDigest,
  isSha256Hex,
} from "../../../domain/primitives/execution-digest.ts";
import {
  assertEvolutionDossier,
  assertEvolutionTransition,
} from "./invariants.ts";
import { type EvolutionDossier, EvolutionError } from "./ports.ts";
import {
  parseScopedSoftwareContext,
  type ScopedSoftwareContextV2,
} from "./scoped-software-context.ts";
import {
  parseScopedSoftwareProposal,
  scopedSoftwareProposalDigest,
  type ScopedSoftwareProposalV2,
} from "./scoped-software-proposal.ts";

/** Distinct persisted family; no human Request authority is represented here. */
export interface ScopedSoftwareEvolutionDossierV2
  extends Omit<EvolutionDossier, "v"> {
  v: 2;
  kind: "software-evolution-scoped";
  scope: ScopedSoftwareContextV2;
  scopedProposal: ScopedSoftwareProposalV2;
  callerCommandId: string;
  callerCommandDigest: string;
  intentDigest: string;
}

function invalid(message: string): never {
  throw new EvolutionError("EVOLUTION_INVALID", message);
}
function legacy(d: ScopedSoftwareEvolutionDossierV2): EvolutionDossier {
  const {
    kind: _kind,
    scope: _scope,
    scopedProposal: _proposal,
    callerCommandId: _command,
    callerCommandDigest: _commandDigest,
    intentDigest: _digest,
    ...common
  } = d;
  return { ...common, v: 1 };
}
function intent(d: ScopedSoftwareEvolutionDossierV2) {
  return {
    format: "software-evolution-intent/v2",
    id: d.id,
    repositoryId: d.repositoryId,
    origin: d.origin,
    finalizerActorId: d.finalizerActorId,
    accounting: d.accounting,
    createdAt: d.createdAt,
    proposal: d.proposal,
    preparation: d.preparation,
    scope: d.scope,
    scopedProposal: d.scopedProposal,
    callerCommandId: d.callerCommandId,
    callerCommandDigest: d.callerCommandDigest,
  };
}

/** Synchronous lifecycle validation. Hashes are independently verified by the
 * async parser at every persistence boundary. */
export function assertScopedSoftwareDossier(
  d: ScopedSoftwareEvolutionDossierV2,
): void {
  if (!d || d.v !== 2 || d.kind !== "software-evolution-scoped") {
    invalid("Scoped software dossier required");
  }
  const allowed = new Set([
    "v",
    "kind",
    "id",
    "repositoryId",
    "revision",
    "status",
    "origin",
    "finalizerActorId",
    "accounting",
    "createdAt",
    "updatedAt",
    "proposal",
    "preparation",
    "acceptance",
    "adoptionAuthorization",
    "cancellation",
    "publication",
    "adoptions",
    "blockers",
    "scope",
    "scopedProposal",
    "callerCommandId",
    "callerCommandDigest",
    "intentDigest",
  ]);
  if (
    Reflect.ownKeys(d).some((key) =>
      typeof key !== "string" || !allowed.has(key)
    )
  ) invalid("Unknown scoped dossier field");
  assertEvolutionDossier(legacy(d));
  const scope = parseScopedSoftwareContext(d.scope);
  const scoped = parseScopedSoftwareProposal(d.scopedProposal);
  if (
    canonical(scope) !== canonical(d.scope) ||
    canonical(scoped) !== canonical(d.scopedProposal) ||
    canonical(scope) !== canonical(scoped.context) ||
    canonical(d.proposal.scoped) !== canonical(scoped) ||
    scope.destination.repositoryId !== d.repositoryId ||
    scope.actor.operatorId !== d.origin.operatorId ||
    typeof d.callerCommandId !== "string" || !d.callerCommandId.trim() ||
    d.callerCommandId !== d.callerCommandId.trim() ||
    d.callerCommandId.length > 512 ||
    // deno-lint-ignore no-control-regex -- Command identity is a persisted locator.
    /[\x00-\x1f\x7f]/.test(d.callerCommandId) ||
    !/^[a-f0-9]{64}$/.test(d.callerCommandDigest) ||
    !/^[a-f0-9]{64}$/.test(d.intentDigest)
  ) invalid("Scoped intent differs from its destination");
  if (
    canonical([...d.proposal.categories].sort()) !==
      canonical([...scoped.categories].sort()) ||
    d.proposal.targets.length !== scoped.targets.length ||
    d.proposal.targets.some((t) => {
      const scopedTarget = scoped.targets.find((item) =>
        item.target.operatorId === t.operatorId
      );
      const original = scope.targets.find((item) =>
        item.target.operatorId === t.operatorId
      );
      return !scopedTarget || !original ||
        t.previousDigest !== original.previousPin.modelDigest ||
        t.candidateDigest !== scopedTarget.candidateDigest;
    })
  ) invalid("Scoped targets differ from the signed proposal");
  const exactKeys = (value: object, fields: readonly string[]) =>
    Reflect.ownKeys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
  if (d.publication) {
    const publication = d.publication as typeof d.publication & {
      sourceAdmission?: { revision: number; manifestDigest: string };
    };
    if (
      !exactKeys(publication, [
        "commandId",
        "commandDigest",
        "version",
        "sourceDigest",
        "proposalDigest",
        "sourceAdmission",
      ]) ||
      !publication.sourceAdmission ||
      !exactKeys(publication.sourceAdmission, ["revision", "manifestDigest"]) ||
      !Number.isSafeInteger(publication.sourceAdmission.revision) ||
      publication.sourceAdmission.revision < 2 ||
      !/^[a-f0-9]{64}$/.test(publication.sourceAdmission.manifestDigest)
    ) invalid("Exact software publication receipt required");
  }
  for (const receipt of d.adoptions) {
    const r = receipt as typeof receipt & {
      target?: unknown;
      manifestDigest?: string;
      journalRevision?: number;
      authorizationRuntimeRevision?: number;
      committedRuntimeRevision?: number;
    };
    if (
      !exactKeys(r, [
        "operatorId",
        "previousDigest",
        "candidateDigest",
        "version",
        "proposalDigest",
        "effectiveAt",
        "target",
        "manifestDigest",
        "journalRevision",
        "authorizationRuntimeRevision",
        "committedRuntimeRevision",
      ]) ||
      !scope.targets.some((item) =>
        canonical(item.target) === canonical(r.target) &&
        item.target.operatorId === r.operatorId
      ) ||
      !isSha256Hex(r.manifestDigest) ||
      !Number.isSafeInteger(r.journalRevision) ||
      Number(r.journalRevision) < 3 ||
      !Number.isSafeInteger(r.authorizationRuntimeRevision) ||
      Number(r.authorizationRuntimeRevision) < 1 ||
      !Number.isSafeInteger(r.committedRuntimeRevision) ||
      r.committedRuntimeRevision !==
        Number(r.authorizationRuntimeRevision) + 1 ||
      !Number.isFinite(Date.parse(r.effectiveAt))
    ) invalid("Exact software adoption receipt required");
  }
}
export async function parseScopedSoftwareDossier(
  value: unknown,
): Promise<ScopedSoftwareEvolutionDossierV2> {
  const d = structuredClone(value) as ScopedSoftwareEvolutionDossierV2;
  assertScopedSoftwareDossier(d);
  const expectedId = `software-evolution-scoped:${await canonicalDigest({
    format: "software-evolution-id/v2",
    host: d.scope.destination.host,
    repositoryId: d.repositoryId,
    preparer: d.scope.actor,
    callerCommandId: d.callerCommandId,
  })}`;
  if (
    d.id !== expectedId ||
    d.proposal.digest !==
      await scopedSoftwareProposalDigest(d.scopedProposal) ||
    d.intentDigest !== await canonicalDigest(intent(d))
  ) invalid("Scoped proposal or intent digest differs");
  return d;
}
export async function createScopedSoftwareDossier(
  draft: EvolutionDossier,
  proposal: ScopedSoftwareProposalV2,
  command: { callerCommandId: string; callerCommandDigest: string },
): Promise<ScopedSoftwareEvolutionDossierV2> {
  const scopedProposal = parseScopedSoftwareProposal(proposal);
  const d: ScopedSoftwareEvolutionDossierV2 = {
    ...structuredClone(draft),
    v: 2,
    kind: "software-evolution-scoped",
    scope: scopedProposal.context,
    scopedProposal,
    ...structuredClone(command),
    intentDigest: "0".repeat(64),
  };
  d.intentDigest = await canonicalDigest(intent(d));
  return await parseScopedSoftwareDossier(d);
}
export async function assertScopedSoftwareTransition(
  previous: ScopedSoftwareEvolutionDossierV2,
  next: ScopedSoftwareEvolutionDossierV2,
): Promise<void> {
  await parseScopedSoftwareDossier(previous);
  await parseScopedSoftwareDossier(next);
  assertEvolutionTransition(legacy(previous), legacy(next));
  if (
    canonical(intent(previous)) !== canonical(intent(next)) ||
    previous.intentDigest !== next.intentDigest
  ) invalid("Immutable scoped intent changed");
}
