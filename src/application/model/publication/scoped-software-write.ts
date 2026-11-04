import type { EvolutionAuthorityExercise } from "../../../domain/model/evolution/policy.ts";
import { EVOLUTION_CATEGORIES } from "../../../domain/model/evolution/policy.ts";
import {
  assertOperationJournal,
  assertWholeFilesOperations,
} from "../../../domain/model/editing/operation-journal.ts";
import {
  type ModelWriteOperations,
  modelWriteOperationsDigest,
  parseModelWriteCommand,
} from "../../../domain/model/editing/write-command.ts";
import { ModelWriteCommandError } from "../../../domain/model/editing/write-command-error.ts";
import {
  parseRequestModelWriteDestination,
  type RequestModelWriteDestination,
} from "../../../domain/model/editing/request-write-destination.ts";
import type { ModelRevisionRef } from "../../../domain/model/value-objects/element-ref.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  canonicalDigest,
  isSha256Hex,
} from "../../../domain/primitives/execution-digest.ts";
import {
  parseScopedSoftwareDossier,
  type ScopedSoftwareEvolutionDossierV2,
} from "../evolution/scoped-software-dossier.ts";

/** A separate software family: it is never interpreted as a human owner dossier. */
export interface ScopedSoftwareWriteCommandV2 {
  readonly v: 2;
  readonly kind: "publish-software-evolution";
  readonly repositoryId: string;
  readonly commandId: string;
  readonly approvedBase: ModelRevisionRef;
  readonly destination: RequestModelWriteDestination;
  readonly intentDigest: string;
  readonly operationsRef: { readonly digest: string };
  readonly decisionRef: { readonly id: string; readonly digest: string };
  readonly recipeDigest: string;
  readonly authorityRef: {
    readonly kind: "software-evolution-scoped-authority/v2";
    readonly digest: string;
  };
}
interface ScopedSoftwareWriteDecisionV2 {
  readonly dossierId: string;
  readonly evolutionIntentDigest: string;
  readonly proposalDigest: string;
  readonly preparation: EvolutionAuthorityExercise;
  readonly acceptance: EvolutionAuthorityExercise;
  readonly adoptionAuthorization: EvolutionAuthorityExercise;
}
export interface ScopedSoftwareWriteDossierV2 {
  readonly v: 2;
  readonly kind: "software-evolution-scoped-publication";
  readonly command: ScopedSoftwareWriteCommandV2;
  readonly operations: Exclude<
    ModelWriteOperations,
    { kind: "artifact-source" }
  >;
  readonly decision: ScopedSoftwareWriteDecisionV2;
}
const fail = (): never => {
  throw new ModelWriteCommandError("WRITE_DOSSIER_MISMATCH", {
    reason: "Invalid scoped software publication",
  }, "Invalid scoped software publication");
};
function obj(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail();
  }
  const v = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  ) return fail();
  return v;
}
const hash = (v: unknown): v is string => isSha256Hex(v);
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 512 && v.trim() === v;
function exercise(
  value: unknown,
  act: string,
  digest: string,
): EvolutionAuthorityExercise {
  const v = obj(value, [
    "act",
    "operatorNativeId",
    "systemQualifiedName",
    "authorityDigest",
    "policyId",
    "policyRevision",
    "mandateNativeId",
    "mandateId",
    "mandateRevision",
    "targets",
    "categories",
    "proposalDigest",
  ]);
  if (
    v.act !== act || v.proposalDigest !== digest || !hash(v.authorityDigest) ||
    ![
      v.operatorNativeId,
      v.systemQualifiedName,
      v.policyId,
      v.mandateNativeId,
      v.mandateId,
    ].every(text) ||
    !Number.isSafeInteger(v.policyRevision) || Number(v.policyRevision) < 0 ||
    !Number.isSafeInteger(v.mandateRevision) || Number(v.mandateRevision) < 0 ||
    !Array.isArray(v.targets) || !v.targets.length || !v.targets.every(text) ||
    new Set(v.targets).size !== v.targets.length ||
    !Array.isArray(v.categories) || !v.categories.length ||
    !v.categories.every((c) => EVOLUTION_CATEGORIES.includes(c)) ||
    new Set(v.categories).size !== v.categories.length
  ) return fail();
  return v as unknown as EvolutionAuthorityExercise;
}
export function parseScopedSoftwareWriteCommand(
  value: unknown,
): ScopedSoftwareWriteCommandV2 {
  const v = obj(structuredClone(value), [
    "v",
    "kind",
    "repositoryId",
    "commandId",
    "approvedBase",
    "destination",
    "intentDigest",
    "operationsRef",
    "decisionRef",
    "recipeDigest",
    "authorityRef",
  ]);
  if (v.v !== 2 || v.kind !== "publish-software-evolution") return fail();
  const authority = obj(v.authorityRef, ["kind", "digest"]);
  if (
    authority.kind !== "software-evolution-scoped-authority/v2" ||
    !hash(authority.digest)
  ) return fail();
  const { destination: d, authorityRef: _a, ...body } = v;
  const legacy = parseModelWriteCommand({
    ...body,
    v: 1,
    kind: "accept-proposal",
  });
  const destination = parseRequestModelWriteDestination(d);
  if (
    legacy.repositoryId !== destination.repositoryId ||
    canonical(legacy.approvedBase) !==
      canonical(destination.expectedAdmittedSource.source) ||
    legacy.decisionRef.id !== legacy.commandId
  ) return fail();
  return {
    ...legacy,
    v: 2,
    kind: "publish-software-evolution",
    destination,
    authorityRef: {
      kind: "software-evolution-scoped-authority/v2",
      digest: authority.digest,
    },
  };
}
/** This validates immutable evidence, not current grants, barriers or a Git effect. */
export async function parseScopedSoftwareWriteDossier(
  value: unknown,
): Promise<ScopedSoftwareWriteDossierV2> {
  const snapshot = structuredClone(value);
  const v = obj(snapshot, ["v", "kind", "command", "operations", "decision"]);
  if (v.v !== 2 || v.kind !== "software-evolution-scoped-publication") {
    return fail();
  }
  const command = parseScopedSoftwareWriteCommand(v.command);
  const decision = obj(v.decision, [
    "dossierId",
    "evolutionIntentDigest",
    "proposalDigest",
    "preparation",
    "acceptance",
    "adoptionAuthorization",
  ]);
  if (
    !text(decision.dossierId) || !hash(decision.evolutionIntentDigest) ||
    !hash(decision.proposalDigest)
  ) return fail();
  const a = exercise(decision.preparation, "prepare", decision.proposalDigest);
  const b = exercise(decision.acceptance, "accept", decision.proposalDigest);
  const c = exercise(
    decision.adoptionAuthorization,
    "adopt",
    decision.proposalDigest,
  );
  if (
    canonical([...a.targets].sort()) !== canonical([...b.targets].sort()) ||
    canonical([...a.targets].sort()) !== canonical([...c.targets].sort()) ||
    canonical([...a.categories].sort()) !==
      canonical([...b.categories].sort()) ||
    canonical([...a.categories].sort()) !== canonical([...c.categories].sort())
  ) return fail();
  const operations = v.operations as ScopedSoftwareWriteDossierV2["operations"];
  if (!operations || typeof operations !== "object") return fail();
  let base: ModelRevisionRef, baseDigest: string;
  if (operations.kind === "host-edits") {
    obj(operations, ["kind", "journal"]);
    assertOperationJournal(operations.journal);
    base = operations.journal.base;
    baseDigest = operations.journal.baseSourceDigest;
  } else if (operations.kind === "whole-files") {
    obj(operations, ["kind", "files"]);
    assertWholeFilesOperations(operations.files);
    base = operations.files.base;
    baseDigest = operations.files.baseSourceDigest;
  } else return fail();
  const { intentDigest: _digest, ...intent } = command;
  if (
    canonical(base) !== canonical(command.approvedBase) ||
    baseDigest !== command.destination.expectedAdmittedSource.sourceDigest ||
    await modelWriteOperationsDigest(operations) !==
      command.operationsRef.digest ||
    await canonicalDigest(decision) !== command.decisionRef.digest ||
    await canonicalDigest({
        format: "software-evolution-scoped-authority/v2",
        preparation: a,
        acceptance: b,
        adoptionAuthorization: c,
      }) !== command.authorityRef.digest ||
    await canonicalDigest(intent) !== command.intentDigest
  ) return fail();
  return snapshot as ScopedSoftwareWriteDossierV2;
}
export async function scopedSoftwareWriteCommandDigest(
  value: unknown,
): Promise<string> {
  return await canonicalDigest(parseScopedSoftwareWriteCommand(value));
}
export async function scopedSoftwareWriteDossierDigest(
  value: unknown,
): Promise<string> {
  return await canonicalDigest(await parseScopedSoftwareWriteDossier(value));
}

/** Build only from a server-resolved lifecycle and captured operations. This
 * constructs evidence; it does not check live source-edit rights. */
export async function buildScopedSoftwareWriteDossier(input: {
  evolution: ScopedSoftwareEvolutionDossierV2;
  operations: ScopedSoftwareWriteDossierV2["operations"];
}): Promise<ScopedSoftwareWriteDossierV2> {
  const owned = structuredClone(input);
  const evolution = await parseScopedSoftwareDossier(owned.evolution);
  if (
    !evolution.acceptance || !evolution.adoptionAuthorization ||
    evolution.status !== "publishing"
  ) return fail();
  const decision: ScopedSoftwareWriteDecisionV2 = {
    dossierId: evolution.id,
    evolutionIntentDigest: evolution.intentDigest,
    proposalDigest: evolution.proposal.digest,
    preparation: evolution.preparation,
    acceptance: evolution.acceptance,
    adoptionAuthorization: evolution.adoptionAuthorization,
  };
  const command = {
    v: 2 as const,
    kind: "publish-software-evolution" as const,
    repositoryId: evolution.repositoryId,
    commandId: evolution.proposal.id,
    approvedBase: evolution.scope.destination.expectedAdmittedSource.source,
    destination: evolution.scope.destination,
    operationsRef: {
      digest: await modelWriteOperationsDigest(owned.operations),
    },
    decisionRef: {
      id: evolution.proposal.id,
      digest: await canonicalDigest(decision),
    },
    recipeDigest: evolution.proposal.recipeDigest,
    authorityRef: {
      kind: "software-evolution-scoped-authority/v2" as const,
      digest: await canonicalDigest({
        format: "software-evolution-scoped-authority/v2",
        preparation: decision.preparation,
        acceptance: decision.acceptance,
        adoptionAuthorization: decision.adoptionAuthorization,
      }),
    },
  };
  const dossier = await parseScopedSoftwareWriteDossier({
    v: 2,
    kind: "software-evolution-scoped-publication",
    command: { ...command, intentDigest: await canonicalDigest(command) },
    operations: owned.operations,
    decision,
  });
  await assertScopedSoftwareWriteMatchesEvolution(dossier, evolution);
  return dossier;
}

/** Join the independently stored lifecycle to the immutable queue payload.
 * Rechecking current grants and the durable barrier is the caller's duty. */
export async function assertScopedSoftwareWriteMatchesEvolution(
  writeInput: unknown,
  evolutionInput: unknown,
): Promise<
  {
    write: ScopedSoftwareWriteDossierV2;
    evolution: ScopedSoftwareEvolutionDossierV2;
  }
> {
  const write = await parseScopedSoftwareWriteDossier(writeInput);
  const evolution = await parseScopedSoftwareDossier(evolutionInput);
  const d = write.decision;
  if (
    !evolution.acceptance || !evolution.adoptionAuthorization ||
    !["armed", "publishing", "published-awaiting-adoption", "adopted"].includes(
      evolution.status,
    ) ||
    d.dossierId !== evolution.id ||
    d.evolutionIntentDigest !== evolution.intentDigest ||
    d.proposalDigest !== evolution.proposal.digest ||
    canonical(d.preparation) !== canonical(evolution.preparation) ||
    canonical(d.acceptance) !== canonical(evolution.acceptance) ||
    canonical(d.adoptionAuthorization) !==
      canonical(evolution.adoptionAuthorization) ||
    canonical(write.command.destination) !==
      canonical(evolution.scope.destination) ||
    write.command.commandId !== evolution.proposal.id ||
    write.command.approvedBase.version !== evolution.proposal.baseVersion ||
    write.command.recipeDigest !== evolution.proposal.recipeDigest
  ) return fail();
  return { write, evolution };
}
