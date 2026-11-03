import {
  artifactSourceBindingId,
  type ArtifactSourceRuntimeScope,
} from "../../application/work/artifacts/publication.ts";
import {
  assertRequestSpaceBirth,
  type RequestSpaceSeed,
} from "../../application/work/runtime/initialization.ts";
import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";
import type { NativeInitialSkill } from "../../domain/model/execution/native-contracts.ts";
import { executionDigest } from "../../domain/primitives/execution-digest.ts";
import {
  requireSkillContent,
  skillContentDigest,
  skillDigest,
  SkillError,
  skillIdentity,
  validateSkillPolicy,
} from "../../domain/skills/context-skills.ts";
import type { SystemRuntimeState } from "../../domain/work/dialogue.ts";
import { isOpenCase } from "../../domain/work/entities/cases.ts";
import {
  assertQueuedArtifactSourcePublication,
  type QueuedArtifactSourcePublication,
} from "../../domain/work/artifacts/source-publication.ts";
import {
  requireSource,
  sourceDigest,
  sourceIdentity,
} from "../../domain/work/artifacts/source-reference.ts";
import { exactSourceVersion } from "../../domain/work/request-spaces.ts";
import {
  initialSkillInvocationId,
  matchesLocalSkillExposure,
  SkillsBehavior,
  type SkillsBehaviorOptions,
} from "../../application/skills/behavior.ts";
import { BundledSkillReadError } from "../out/filesystem/skill-bundles.ts";

export type RequestBundledSkillReader = NonNullable<
  SkillsBehaviorOptions["readBundledSkill"]
>;

type RequestInitialSkillsIssue =
  | "INITIAL_SKILL_MODEL_INVALID"
  | "INITIAL_SKILL_POLICY_UNAVAILABLE"
  | "INITIAL_SKILL_EXPOSURE_UNAVAILABLE"
  | "INITIAL_SKILL_BUNDLE_UNAVAILABLE"
  | "INITIAL_SKILL_CONTENT_INVALID"
  | "INITIAL_SKILL_CONTENT_DIFFERS"
  | "INITIAL_SKILL_LIMIT_EXCEEDED";

export type RequestInitialSkillsInspection =
  | { supported: true; issues: [] }
  | { supported: false; issues: [RequestInitialSkillsIssue] };

class UnsupportedInitialSkill extends Error {
  constructor(readonly issue: RequestInitialSkillsIssue) {
    super(issue);
  }
}

function supported(
  condition: unknown,
  issue: RequestInitialSkillsIssue,
): asserts condition {
  if (!condition) throw new UnsupportedInitialSkill(issue);
}

/** This reader checks the supplied model only. It never discovers admission or
 * opens a service/store, and its success is not an execution or publication grant. */
function modelSkills(model: ExecutableModel): SkillsBehavior {
  const ownerId = model.identity.builderId;
  return new SkillsBehavior({
    entries: new Map((model.operatorEntries ?? []).map((entry) => [
      entry.id,
      { ownerId, kind: entry.kind },
    ])),
    resolveCallerModel(callerId, version) {
      return Promise.resolve(
        callerId === ownerId && version.digest === model.version.digest &&
          version.repositoryVersion === model.version.repositoryVersion
          ? structuredClone(model)
          : null,
      );
    },
    skills() {
      throw new SkillError(
        "forbidden",
        "Initial skill inspection has no skill service",
      );
    },
  });
}

function localExposure(
  model: ExecutableModel,
  kind: "skill-install" | "skill-list" | "skill-load",
) {
  const entries = modelSkills(model).options.entries;
  return model.behaviors?.find((behavior) =>
    matchesLocalSkillExposure(model, behavior, kind, entries)
  );
}

async function inspect(
  model: ExecutableModel,
  readBundledSkill: RequestBundledSkillReader,
): Promise<void> {
  const seeds = model.initialSkills ?? [];
  if (seeds.length === 0) return;
  supported(
    Array.isArray(seeds) && seeds.length <= 32 &&
      skillIdentity(model.identity.builderId) &&
      skillDigest(model.version.digest) &&
      exactSourceVersion(model.version.repositoryVersion) &&
      new Set(seeds.map((seed) => seed.id)).size === seeds.length &&
      new Set(seeds.map((seed) => seed.nativeId)).size === seeds.length &&
      seeds.every((seed) =>
        skillIdentity(seed.nativeId) && typeof seed.id === "string" &&
        seed.id.length <= 120 &&
        /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(seed.id) &&
        typeof seed.source === "string" && seed.source.length <= 127 &&
        /^bundle:[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(seed.source) &&
        skillDigest(seed.digest) && typeof seed.loaded === "boolean" &&
        skillIdentity(initialSkillInvocationId(seed, model.version))
      ),
    "INITIAL_SKILL_MODEL_INVALID",
  );
  const policy = model.skillPolicy;
  supported(
    policy && policy.ownerId === model.identity.builderId,
    "INITIAL_SKILL_POLICY_UNAVAILABLE",
  );
  try {
    validateSkillPolicy(policy);
  } catch (error) {
    if (!(error instanceof SkillError)) throw error;
    throw new UnsupportedInitialSkill("INITIAL_SKILL_POLICY_UNAVAILABLE");
  }
  const loaded = seeds.filter((seed) => seed.loaded);
  supported(
    seeds.length <= policy.maxInstalledSkills &&
      loaded.length <= policy.maxLoadedSkills,
    "INITIAL_SKILL_LIMIT_EXCEEDED",
  );
  const skills = modelSkills(model);
  const version = {
    digest: model.version.digest,
    repositoryVersion: model.version.repositoryVersion!,
  };
  const kinds = [
    "skill-install",
    "skill-list",
    ...(loaded.length ? ["skill-load"] as const : []),
  ] as const;
  for (const kind of kinds) {
    const behavior = localExposure(model, kind);
    supported(
      behavior && await skills.supports(behavior, version),
      "INITIAL_SKILL_EXPOSURE_UNAVAILABLE",
    );
  }
  let loadedCharacters = 0;
  for (const seed of seeds) {
    let content: string;
    try {
      content = await readBundledSkill(seed.source, policy.maxSkillBytes);
    } catch (error) {
      if (!(error instanceof BundledSkillReadError)) throw error;
      throw new UnsupportedInitialSkill(
        error.code === "unavailable"
          ? "INITIAL_SKILL_BUNDLE_UNAVAILABLE"
          : error.code === "limit"
          ? "INITIAL_SKILL_LIMIT_EXCEEDED"
          : "INITIAL_SKILL_CONTENT_INVALID",
      );
    }
    try {
      requireSkillContent(content, policy.maxSkillBytes);
    } catch (error) {
      if (!(error instanceof SkillError)) throw error;
      throw new UnsupportedInitialSkill(
        error.code === "limit"
          ? "INITIAL_SKILL_LIMIT_EXCEEDED"
          : "INITIAL_SKILL_CONTENT_INVALID",
      );
    }
    supported(
      await skillContentDigest(content) === seed.digest,
      "INITIAL_SKILL_CONTENT_DIFFERS",
    );
    if (seed.loaded) loadedCharacters += content.length;
    supported(
      loadedCharacters <= policy.maxLoadedCharacters,
      "INITIAL_SKILL_LIMIT_EXCEEDED",
    );
  }
}

/** Bounded diagnostics cover known asset failures and omit paths/bytes/text.
 * Unexpected reader failures propagate; this is never ongoing authority. */
export async function inspectRequestInitialSkills(
  model: ExecutableModel,
  readBundledSkill: RequestBundledSkillReader,
): Promise<RequestInitialSkillsInspection> {
  try {
    await inspect(structuredClone(model), readBundledSkill);
    return { supported: true, issues: [] };
  } catch (error) {
    if (!(error instanceof UnsupportedInitialSkill)) throw error;
    return { supported: false, issues: [error.issue] };
  }
}

export interface RequestInitialSkillPublicationContext {
  /** Host-resolved Case scope, never publication/body fields copied as context. */
  scope: ArtifactSourceRuntimeScope;
  /** Actual persisted birth, state and exact source/model, read by the caller. */
  birth: RequestSpaceSeed;
  state: SystemRuntimeState;
  model: ExecutableModel;
  source: {
    repositoryId: string;
    projectId: string;
    version: string;
    sourceDigest: string;
  };
}

interface RequestInitialSkillPublicationValidation {
  readBundledSkill: RequestBundledSkillReader;
  /** Bind this to the actual scoped SkillsBehavior and live/durable resolver.
   * The supplied context and this helper do not discover current admission. */
  assertCurrentAuthority: SkillsBehavior["assertCurrentAuthority"];
}

/** Validates only one source-declared bundled seed. The caller must separately
 * resolve the active execution space/opening/branch durably before invoking it.
 * No storage, source publication, runtime provisioning or authority is created. */
export async function assertRequestInitialSkillPublication(
  input: QueuedArtifactSourcePublication,
  context: RequestInitialSkillPublicationContext,
  validation: RequestInitialSkillPublicationValidation,
): Promise<void> {
  const publication = structuredClone(input);
  const { scope, birth, state, model, source } = structuredClone(context);
  await assertQueuedArtifactSourcePublication(publication, source.repositoryId);
  const scopeFields = [
    "projectId",
    "systemId",
    "executionSpaceId",
    "operatorId",
  ] as const;
  requireSource(
    scopeFields.every((key) => sourceIdentity(scope[key])) &&
      scope.executionSpaceId !== "main" &&
      scope.operatorId === model.identity.builderId &&
      birth.runtimeId ===
        `request:${scope.executionSpaceId}:${scope.operatorId}` &&
      sourceIdentity(source.projectId) &&
      source.projectId === model.identity.projectId &&
      source.version === model.version.repositoryVersion &&
      exactSourceVersion(source.version) && sourceDigest(source.sourceDigest) &&
      publication.baseVersion === source.version &&
      publication.baseSourceDigest === source.sourceDigest &&
      scopeFields.every((key) => publication.target[key] === scope[key]) &&
      publication.target.ownerId === scope.operatorId &&
      publication.source.kind === "skill-document" &&
      publication.proof.kind === "skill-authority" &&
      publication.upstream === undefined,
    "scope",
  );
  assertRequestSpaceBirth(state, birth, model);
  requireSource(
    state.cases?.some((record) =>
      record.id === birth.caseId && isOpenCase(record)
    ),
    "scope",
  );
  const inspection = await inspectRequestInitialSkills(
    model,
    validation.readBundledSkill,
  );
  requireSource(inspection.supported, "scope");
  const proof = publication.proof;
  // Keep the discriminant after the compound admission above explicit for TS.
  requireSource(
    proof.kind === "skill-authority" &&
      publication.source.kind === "skill-document",
    "scope",
  );
  const authority = proof.authority;
  const matching = (model.initialSkills ?? []).filter((seed) =>
    seed.id === publication.target.localArtifactId &&
    initialSkillInvocationId(seed, model.version) ===
      publication.target.invocationId
  );
  requireSource(matching.length === 1, "scope");
  const seed: NativeInitialSkill = matching[0]!;
  requireSource(
    authority.behaviorId === localExposure(model, "skill-install")?.id &&
      publication.source.artifactId ===
        `skill:${await executionDigest({
          ownerId: scope.operatorId,
          id: seed.id,
        })}` &&
      publication.publicationId ===
        `source-${
          (await artifactSourceBindingId(publication.target)).slice(
            "source-binding:".length,
          )
        }`,
    "scope",
  );
  await modelSkills(model).assertCurrentAuthority(authority, "install");
  if (seed.loaded) {
    await modelSkills(model).assertCurrentAuthority(authority, "list");
    await modelSkills(model).assertCurrentAuthority(authority, "load");
  }
  await validation.assertCurrentAuthority(
    structuredClone(authority),
    "install",
  );
  const content = await validation.readBundledSkill(
    seed.source,
    model.skillPolicy!.maxSkillBytes,
  );
  requireSkillContent(content, model.skillPolicy!.maxSkillBytes);
  requireSource(
    content === publication.source.content &&
      await skillContentDigest(content) === seed.digest,
    "integrity",
  );
  await validation.assertCurrentAuthority(
    structuredClone(authority),
    "install",
  );
}
