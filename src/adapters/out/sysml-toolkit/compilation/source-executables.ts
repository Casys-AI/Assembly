import type {
  SourceCompilationPort,
  SourceEvolutionCompilationPort,
  SourceExecutablesCompilationPort,
} from "../../../../application/model/source-compilation.ts";
import { matchesExactRevision } from "../../../../domain/shared-kernel/revision-id.ts";
import {
  type ConversationUnitIdentity,
  discoverConversationUnits,
} from "../../../../domain/model/records/source-identity.ts";
import type { SourceRevision } from "../../../../domain/model/records/source-revision.ts";
import { assert } from "../../../../domain/primitives/assert.ts";
import { MAX_OPERATOR_UNITS } from "../../../../domain/work/records/conversations.ts";
import { modelEditingAuthorityRoots } from "../../../../application/governance/model-access/model-editing-authority-roots.ts";
import { OperatorAuthorityError } from "../../../../domain/governance/operator-authority-error.ts";
import { executionDigest } from "../../../../domain/primitives/execution-digest.ts";
import { applyModelDelegations } from "../../../../application/governance/model-access/delegation/state.ts";
import { compileModelAdministrationPolicy } from "../compilation-policies/governance/model-access/administration/policy.ts";
import { modelSourceDigest } from "../../../../domain/model/value-objects/sources.ts";
import type { ModelIdentity } from "../../../../domain/shared-kernel/model-identity.ts";
import { projectSourceGraph } from "../../../../domain/model/projections/source-graph.ts";
import { sourceValues } from "../graph/values/source-values.ts";
import {
  sourceLiterals,
  sourceSnapshot,
} from "../../../../domain/model/projections/source-facts.ts";
import { compileExecutableModel } from "../compilation-policies/work/execution-model.ts";
import { compileBehaviorCatalog } from "../compilation-policies/work/behavior-catalog.ts";
import { compileOperatorEntries } from "../compilation-policies/work/operator-entries.ts";
import { resolveNativeActionBaseIds } from "../compilation-policies/work/operator-flow.ts";
import { compileEvolutionPolicy } from "../compilation-policies/governance/model-access/evolution/policy.ts";
import { createEvolutionCompilationEvidence } from "../compilation-policies/governance/model-access/evolution/evidence.ts";
import type { ScopedExecutableModel } from "../../../../domain/model/evolution/semantic-effects.ts";
import { compileSpaceControlPolicy } from "../compilation-policies/governance/authority/space-execution-policy.ts";
import { compileModelEditPolicy } from "../compilation-policies/governance/model-access/editing/policy.ts";
import { compileInformationPolicies } from "../compilation-policies/work/information-policy.ts";
import { compileInitialTools } from "../compilation-policies/work/initial-catalog.ts";
import { compileWorkResultContracts } from "../compilation-policies/work/result-policy.ts";
import { compileWorkBudgetPolicy } from "../compilation-policies/work/budget-policy.ts";
import { compileCaseTypes } from "../compilation-policies/work/case-types.ts";
import type { ExecutableModel } from "../../../../domain/model/execution/executable-model.ts";
import {
  primarySourceExecutable,
  selectValidatedSourceExecutable,
  type ValidatedSourceExecutables,
} from "../../../../domain/model/records/source-executables.ts";

async function compileScopedExecutable(
  revision: SourceRevision,
  identity: ModelIdentity,
  managedSystemIds: readonly string[],
  captureDigestInput?: (input: Record<string, unknown>) => void,
): Promise<ExecutableModel> {
  const hash = (input: Record<string, unknown>) => {
    captureDigestInput?.(structuredClone(input));
    return executionDigest(input);
  };
  const snapshot = sourceSnapshot(revision.elements, identity.rootId);
  const graph = projectSourceGraph(revision.elements, identity);
  const caseTypes = compileCaseTypes(
    snapshot,
    sourceValues(revision.elements),
    identity,
  );
  const model = await compileExecutableModel(
    snapshot,
    { ...graph, diagnostics: graph.executionDiagnostics ?? graph.diagnostics },
    sourceLiterals(revision.elements),
    identity,
    caseTypes,
    captureDigestInput,
    resolveNativeActionBaseIds(revision.elements),
  );
  model.version.repositoryVersion = revision.version;
  const evolutionPolicy = compileEvolutionPolicy(
    snapshot,
    sourceLiterals(revision.elements),
    identity,
  );
  if (evolutionPolicy) {
    model.evolutionPolicy = evolutionPolicy;
    model.version.digest = await hash({
      base: model.version.digest,
      evolutionPolicy,
    });
    model.version.sourceIds = [
      ...new Set([...model.version.sourceIds, ...evolutionPolicy.sourceIds]),
    ].sort();
  }
  const behaviors = compileBehaviorCatalog(
    revision,
    identity,
    managedSystemIds,
  );
  if (behaviors.length) {
    model.behaviors = behaviors;
    model.version.digest = await hash({
      base: model.version.digest,
      behaviors,
    });
    model.version.sourceIds = [
      ...new Set([
        ...model.version.sourceIds,
        ...behaviors.flatMap((behavior) => behavior.sourceIds),
      ]),
    ].sort();
  }
  const teamLiterals = sourceLiterals(revision.elements).filter((literal) =>
    literal.owner === identity.systemId
  );
  const teamFields = [
    "creationParentOperatorId",
    "originatingRequestOperatorId",
    "originatingRequestId",
  ];
  if (teamLiterals.some((literal) => teamFields.includes(literal.name))) {
    const teamValue = (name: string) => {
      const found = teamLiterals.filter((literal) => literal.name === name);
      assert(
        found.length === 1 && found[0]!.kind === "LiteralString" &&
          found[0]!.typeNames.length === 1 &&
          found[0]!.typeNames[0] === "ScalarValues::String" &&
          !!found[0]!.value.trim(),
        `Expected one typed native team origin ${name}`,
      );
      return found[0]!;
    };
    const parent = teamValue("creationParentOperatorId"),
      owner = teamValue("originatingRequestOperatorId"),
      request = teamValue("originatingRequestId");
    const policy = teamLiterals.some((literal) =>
        literal.name === "creationPolicyId"
      )
      ? teamValue("creationPolicyId")
      : undefined;
    model.operatorTeam = {
      parentOperatorId: parent.value,
      requestOwnerId: owner.value,
      requestId: request.value,
      ...(policy ? { creationPolicyId: policy.value } : {}),
    };
    model.version.digest = await hash({
      base: model.version.digest,
      operatorTeam: model.operatorTeam,
    });
    model.version.sourceIds = [
      ...new Set([
        ...model.version.sourceIds,
        ...[parent, owner, request, ...(policy ? [policy] : [])].flatMap((
          literal,
        ) => [literal.attributeId, literal.literalId]),
      ]),
    ].sort();
  }
  const entries = compileOperatorEntries(revision.elements, identity);
  if (entries.length) {
    model.operatorEntries = entries;
    model.version.digest = await hash({
      base: model.version.digest,
      operatorEntries: entries,
    });
    model.version.sourceIds = [
      ...new Set([
        ...model.version.sourceIds,
        ...entries.flatMap((entry) => entry.sourceIds),
      ]),
    ].sort();
  }
  const spaceControlPolicy = compileSpaceControlPolicy(
    snapshot,
    sourceLiterals(revision.elements),
    identity,
  );
  if (spaceControlPolicy) {
    model.spaceControlPolicy = spaceControlPolicy;
    model.version.digest = await hash({
      base: model.version.digest,
      spaceControlPolicy,
    });
    model.version.sourceIds = [
      ...new Set([...model.version.sourceIds, ...spaceControlPolicy.sourceIds]),
    ].sort();
  }
  const modelEditPolicy = compileModelEditPolicy(
    snapshot,
    sourceLiterals(revision.elements),
    identity,
  );
  if (modelEditPolicy) {
    model.modelEditPolicy = modelEditPolicy;
    model.version.digest = await hash({
      base: model.version.digest,
      modelEditPolicy,
    });
    model.version.sourceIds = [
      ...new Set([...model.version.sourceIds, ...modelEditPolicy.sourceIds]),
    ].sort();
  }
  const administration = compileModelAdministrationPolicy(
    snapshot,
    sourceLiterals(revision.elements),
    identity,
  );
  if (administration) {
    model.modelAdministrationPolicy = administration;
    model.version.digest = await hash({
      base: model.version.digest,
      administration,
    });
    model.version.sourceIds = [
      ...new Set([...model.version.sourceIds, ...administration.sourceIds]),
    ].sort();
  }
  const information = compileInformationPolicies(
    snapshot,
    sourceLiterals(revision.elements),
    identity,
  );
  if (Object.keys(information).length) {
    Object.assign(model, information);
    model.version.digest = await hash({
      base: model.version.digest,
      information,
    });
    model.version.sourceIds = [
      ...new Set([
        ...model.version.sourceIds,
        ...[
          information.contextPolicy,
          information.memoryPolicy,
          information.skillPolicy,
          ...(information.initialSkills ?? []),
          ...(information.modelingGuidance ?? []),
        ].flatMap((policy) => policy?.sourceIds ?? []),
      ]),
    ].sort();
  }
  assert(
    !entries.some((entry) => entry.kind.startsWith("memory-")) ||
      !!model.memoryPolicy,
    "Native memory entries require their admitted local memory policy",
  );
  assert(
    !entries.some((entry) => entry.kind === "context-evidence") ||
      !!model.contextPolicy,
    "Native context evidence requires its admitted context policy",
  );
  assert(
    !entries.some((entry) => entry.kind.startsWith("skill-")) ||
      !!model.skillPolicy,
    "Native skill entries require their admitted local skill policy",
  );
  if (model.initialSkills?.length) {
    assert(
      entries.some((entry) =>
        entry.kind === "skill-install" &&
        behaviors.some((behavior) =>
          behavior.targetNativeId === entry.id &&
          behavior.callerNativeId === identity.builderId
        )
      ),
      "Initial skills require an admitted local installation exposure",
    );
  }
  if (model.initialSkills?.some((skill) => skill.loaded)) {
    for (const kind of ["skill-list", "skill-load"] as const) {
      assert(
        entries.some((entry) =>
          entry.kind === kind &&
          behaviors.some((behavior) =>
            behavior.targetNativeId === entry.id &&
            behavior.callerNativeId === identity.builderId
          )
        ),
        "Initial loaded skills require admitted local listing and loading exposures",
      );
    }
  }
  const initialTools = compileInitialTools(
    snapshot,
    sourceLiterals(revision.elements),
    identity,
  );
  if (initialTools.length) {
    model.initialTools = initialTools;
    model.version.digest = await hash({
      base: model.version.digest,
      initialTools,
    });
    model.version.sourceIds = [
      ...new Set([
        ...model.version.sourceIds,
        ...initialTools.flatMap((tool) => tool.sourceIds),
      ]),
    ].sort();
  }
  const workBudgetPolicy = compileWorkBudgetPolicy(
    snapshot,
    sourceLiterals(revision.elements),
    identity,
  );
  if (workBudgetPolicy) {
    model.workBudgetPolicy = workBudgetPolicy;
    model.version.digest = await hash({
      base: model.version.digest,
      workBudgetPolicy,
    });
    model.version.sourceIds = [
      ...new Set([...model.version.sourceIds, ...workBudgetPolicy.sourceIds]),
    ].sort();
  }
  const workResultContracts = compileWorkResultContracts(
    snapshot,
    sourceLiterals(revision.elements),
    identity,
    behaviors,
    revision.elements,
  );
  if (workResultContracts.length) {
    model.workResultContracts = workResultContracts;
    model.version.digest = await hash({
      base: model.version.digest,
      workResultContracts,
    });
    model.version.sourceIds = [
      ...new Set([
        ...model.version.sourceIds,
        ...workResultContracts.flatMap((contract) => contract.sourceIds),
      ]),
    ].sort();
  }
  if (caseTypes.length) {
    model.caseTypes = caseTypes;
    model.version.digest = await hash({
      base: model.version.digest,
      caseTypes,
    });
    model.version.sourceIds = [
      ...new Set([
        ...model.version.sourceIds,
        ...caseTypes.flatMap((caseType) => caseType.sourceIds),
      ]),
    ].sort();
  }
  return model;
}

const sourceExecutableCache = new Map<
  string,
  Promise<ValidatedSourceExecutables>
>();

/** Compile every admitted scope once, retaining the ordinary compilation refusals. */
export async function validateSourceExecutables(
  revision: SourceRevision,
  projectId: string,
): Promise<ValidatedSourceExecutables> {
  return structuredClone(await cachedSourceExecutables(revision, projectId));
}

async function cachedSourceExecutables(
  revision: SourceRevision,
  projectId: string,
): Promise<ValidatedSourceExecutables> {
  // Unpublished compilations and mutable fixture identities are never reusable.
  if (!matchesExactRevision(revision.version)) {
    return await compileSourceExecutables(revision, projectId);
  }
  // Verification can label changed sources with the base commit until admission.
  const sourceDigest = await modelSourceDigest(revision.sources);
  const key = JSON.stringify([projectId, revision.version, sourceDigest]);
  let entry = sourceExecutableCache.get(key);
  if (!entry) {
    entry = compileSourceExecutables(revision, projectId);
    sourceExecutableCache.set(key, entry);
    if (sourceExecutableCache.size > 16) {
      sourceExecutableCache.delete(sourceExecutableCache.keys().next().value!);
    }
  }
  try {
    return await entry;
  } catch (error) {
    if (sourceExecutableCache.get(key) === entry) {
      sourceExecutableCache.delete(key);
    }
    throw error;
  }
}

async function compileSourceExecutables(
  revision: SourceRevision,
  projectId: string,
  captured?: Map<string, Record<string, unknown>[]>,
): Promise<ValidatedSourceExecutables> {
  const units = discoverConversationUnits(revision, projectId);
  if (units.length > MAX_OPERATOR_UNITS) {
    throw new OperatorAuthorityError(
      "OPERATOR_CAPACITY_EXCEEDED",
      `The admitted source exceeds the technical registry limit of ${MAX_OPERATOR_UNITS} operators`,
    );
  }
  const managedSystemIds = units.map((unit) => unit.identity.systemId);
  const compiled: Array<
    { unit: ConversationUnitIdentity; model: ExecutableModel }
  > = [];
  for (const unit of units) {
    const inputs: Record<string, unknown>[] = [];
    if (captured) captured.set(unit.systemQualifiedName, inputs);
    compiled.push({
      unit,
      model: await compileScopedExecutable(
        revision,
        unit.identity,
        managedSystemIds,
        captured ? (input) => inputs.push(input) : undefined,
      ),
    });
  }
  const authorityRoots = modelEditingAuthorityRoots(
    sourceSnapshot(revision.elements, `${projectId}/root`).elements,
  );
  for (const { model } of compiled) {
    model.modelEditingAuthorityRoots = authorityRoots;
  }
  await applyModelDelegations(
    revision,
    compiled.map(({ unit, model }) => ({
      systemQualifiedName: unit.systemQualifiedName,
      model,
    })),
    captured
      ? (name, input) => captured.get(name)!.push(structuredClone(input))
      : undefined,
  );
  const primary = compiled.filter(({ model }) => model.operator?.primary);
  assert(primary.length <= 1, "Ambiguous native primary conversation endpoint");
  const primaryUnit = primarySourceExecutable(compiled);
  const membershipUnits = compiled.filter(({ model }) => !model.operatorTeam);
  if (membershipUnits.length > 1 && primaryUnit) {
    // Admission of the main contact covers who belongs to this operator system
    // and which human inboxes are exposed, without coupling it to a peer's
    // instructions, work state or tool-catalog observations. Request-scoped
    // teams belong to their admitted creator, not Main's human inbox contract.
    const operatorMembership = membershipUnits.map(({ unit, model }) => ({
      systemQualifiedName: unit.systemQualifiedName,
      systemId: model.identity.systemId,
      agentId: model.identity.builderId,
      ...(model.identity.reviewerId
        ? { reviewerId: model.identity.reviewerId }
        : {}),
      primary: model.operator?.primary ?? model === primaryUnit.model,
      humanInput: model.operator?.humanInput ?? model === primaryUnit.model,
    }));
    const membershipDigestInput = {
      base: primaryUnit.model.version.digest,
      operatorMembership,
    };
    if (captured) {
      captured.get(primaryUnit.unit.systemQualifiedName)!.push(
        structuredClone(membershipDigestInput),
      );
    }
    primaryUnit.model.version.digest = await executionDigest(
      membershipDigestInput,
    );
    primaryUnit.model.version.sourceIds = [
      ...new Set([
        ...primaryUnit.model.version.sourceIds,
        ...operatorMembership.flatMap((entry) => [
          entry.systemId,
          entry.agentId,
          ...(entry.reviewerId ? [entry.reviewerId] : []),
        ]),
      ]),
    ].sort();
  }
  return compiled;
}

/** Compile fresh, complete evidence for all consumers without changing legacy digests. */
export async function validateSourceEvolutionExecutables(
  revision: SourceRevision,
  projectId: string,
): Promise<ScopedExecutableModel[]> {
  const captured = new Map<string, Record<string, unknown>[]>();
  const compiled = await compileSourceExecutables(
    revision,
    projectId,
    captured,
  );
  return await Promise.all(compiled.map(async ({ unit, model }) => ({
    systemQualifiedName: unit.systemQualifiedName,
    model,
    evidence: await createEvolutionCompilationEvidence(
      model,
      captured.get(unit.systemQualifiedName)!,
      revision.elements,
    ),
  })));
}

/** Validate the complete shared source version before any scope is published. */
export async function validateSourceExecutable(
  revision: SourceRevision,
  projectId: string,
  systemQualifiedName?: string,
): Promise<ExecutableModel> {
  const compiled = await cachedSourceExecutables(revision, projectId);
  return structuredClone(
    selectValidatedSourceExecutable(compiled, systemQualifiedName),
  );
}

export const sourceCompilation: SourceCompilationPort = {
  compile: validateSourceExecutable,
};

export const sourceEvolutionCompilation: SourceEvolutionCompilationPort = {
  compile: validateSourceEvolutionExecutables,
};

export const sourceExecutablesCompilation: SourceExecutablesCompilationPort = {
  compile: validateSourceExecutables,
};
