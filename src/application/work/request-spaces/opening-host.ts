import type { RequestSpaceRuntimeOptions } from "./runtime.ts";
import type { RequestOperatorStorage } from "./runtime-ports.ts";
import type { SourceExecutablesCompilationPort } from "../../model/source-compilation.ts";
import { assertRetainedCatalog } from "../tools/retained-catalog.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  SavedSystemManifest,
  SavedSystemPrerequisite,
  SavedSystemScope,
} from "../../../domain/work/saved-systems.ts";
import { caseTypesForModel } from "../../../domain/work/records/case-types.ts";
import {
  exactSourceVersion,
  RequestSpaceError,
} from "../../../domain/work/request-spaces.ts";
import { selectValidatedSourceExecutable } from "../../../domain/model/records/source-executables.ts";
import { discoverConversationUnits } from "../../../domain/model/records/source-identity.ts";
import type { ModelRepositoryPort } from "../../model/repository.ts";
import type { RequestOpeningHostSourceReaderPort } from "./opening-source-reader.ts";
import type { RequestOpeningRunnerPort } from "./opening-host-ports.ts";
import type { RequestInitialSkillsInspection } from "../../skills/request-initial-skills.ts";

interface RequestOpeningHostOptions<
  S extends RequestOperatorStorage = RequestOperatorStorage,
> {
  compilation: SourceExecutablesCompilationPort;
  scope: SavedSystemScope;
  sourceProjectId: string;
  repositoryId: string;
  repository: Pick<ModelRepositoryPort, "history" | "header">;
  reader(): Promise<RequestOpeningHostSourceReaderPort>;
  runner: RequestOpeningRunnerPort;
  dependencies: RequestSpaceRuntimeOptions<S>["dependencies"];
  /** Origin relation/current visibility only; this host still reads the exact
   * source model and RequestOpeningSources independently inspects full assets. */
  assertSourceOriginRelation?(manifest: SavedSystemManifest): Promise<void>;
  inspectInitialSkills(
    model: ExecutableModel,
  ): Promise<RequestInitialSkillsInspection>;
}

const runnerRequirements = new Set([
  "FRESH_CACHE_AND_ENVIRONMENT",
  "NO_REMOTE_OR_NPM_RESOLUTION",
  "DENIED_IMPORTS",
  "MACOS_DENY_DEFAULT_SANDBOX",
]);
const requiredHostRequirements = [
  ...runnerRequirements,
  "FRESH_PRIVATE_RESOURCE_BINDINGS",
];

/** Eligibility is checked on the exact retained executable, independently of
 * inert birth. Source-declared schedules remain outside this Request slice. */
export function requestOpeningModelIssues(model: ExecutableModel): string[] {
  const issues: string[] = [];
  if (caseTypesForModel(model).some((type) => type.schedule)) {
    issues.push("SOURCE_SCHEDULE_UNSUPPORTED");
  }
  return issues;
}

/** Check every exact seeded model even when its metadata is omitted. The one
 * known prerequisite is a dependency claim, never an installation or grant. */
export async function requestOpeningInitialSkillIssues(
  models: readonly ExecutableModel[],
  prerequisites: readonly SavedSystemPrerequisite[],
  inspectInitialSkills: RequestOpeningHostOptions["inspectInitialSkills"],
): Promise<string[]> {
  const issues: string[] = [];
  const inspected = new Map<string, RequestInitialSkillsInspection>();
  for (const model of models) {
    if (!model.initialSkills?.length) continue;
    const result = await inspectInitialSkills(model);
    inspected.set(model.identity.builderId, result);
    if (!result.supported) issues.push(...result.issues);
    if (
      !prerequisites.some((entry) =>
        entry.kind === "skill" && entry.code === "SKILL_DEPENDENCY" &&
        entry.operatorId === model.identity.builderId
      )
    ) issues.push("SOURCE_SKILL_REQUIREMENT_MISSING");
  }
  for (const entry of prerequisites.filter((entry) => entry.kind === "skill")) {
    const matches = models.filter((model) =>
      model.identity.builderId === entry.operatorId
    );
    if (
      entry.code !== "SKILL_DEPENDENCY" || !entry.operatorId ||
      matches.length !== 1 ||
      !matches[0].initialSkills?.length ||
      !inspected.get(entry.operatorId)?.supported
    ) issues.push("SOURCE_DEPENDENCY_UNSUPPORTED");
  }
  return [...new Set(issues)];
}

/** Host eligibility/access reads are adapter behavior, not composition. The
 * supplied builder is the same concrete Case factory paired by host composition;
 * no caller/session data selects private bindings or host readiness. */
export class RequestOpeningHost<
  S extends RequestOperatorStorage = RequestOperatorStorage,
> {
  constructor(private readonly options: RequestOpeningHostOptions<S>) {}

  readonly inspectHostSupport = async (
    manifest: SavedSystemManifest,
  ): Promise<{ supported: boolean; issues: string[] }> => {
    const issues: string[] = [];
    if (
      this.options.scope.executionSpaceId !== "main" ||
      manifest.origin.projectId !== this.options.scope.projectId ||
      manifest.origin.systemId !== this.options.scope.systemId ||
      manifest.source?.repositoryId !== this.options.repositoryId ||
      !exactSourceVersion(manifest.source?.sourceVersion)
    ) return { supported: false, issues: ["FOREIGN_SOURCE_PROVENANCE"] };
    if (
      manifest.origin.executionSpaceId !== "main" &&
      !this.options.assertSourceOriginRelation
    ) {
      return {
        supported: false,
        issues: ["REQUEST_SOURCE_PROVENANCE_UNAVAILABLE"],
      };
    }
    if (this.options.assertSourceOriginRelation) {
      try {
        await this.options.assertSourceOriginRelation(manifest);
      } catch {
        return { supported: false, issues: ["SOURCE_PROVENANCE_UNAVAILABLE"] };
      }
    }
    // Current source capture always records these requirements. Omitting their
    // metadata cannot turn a host probe or scoped dependency construction into
    // an optional constraint.
    for (const code of requiredHostRequirements) {
      if (
        !manifest.prerequisites.some((entry) =>
          entry.kind === "host-runtime" && entry.code === code
        )
      ) issues.push(`HOST_REQUIREMENT_MISSING_${code}`);
    }
    if (issues.length) return { supported: false, issues };
    if (
      !manifest.operators.length ||
      manifest.operators.some((operator) =>
        !operator.build ||
        operator.build.repositoryId !== this.options.repositoryId ||
        operator.build.sourceDigest !== manifest.source!.sourceDigest ||
        operator.repositoryVersion !== manifest.source!.sourceVersion ||
        operator.sourceDigest !== manifest.source!.sourceDigest
      )
    ) issues.push("SOURCE_BUILD_OR_DEPENDENCIES_UNAVAILABLE");
    // One real sentinel probe per inspection, using the same runner/execute path
    // as the Request factory. No ready result survives this inspection.
    const readiness =
      manifest.prerequisites.some((entry) =>
          entry.kind === "host-runtime" && runnerRequirements.has(entry.code)
        )
        ? await this.options.runner.inspectReadiness()
        : undefined;
    const runnerReady = readiness?.status === "ready";
    if (readiness?.status === "unavailable") {
      issues.push(
        readiness.reason === "unsupported-platform"
          ? "HOST_RUNNER_UNSUPPORTED_PLATFORM"
          : "HOST_RUNNER_SANDBOX_LAUNCH_FAILED",
      );
    }
    for (const prerequisite of manifest.prerequisites) {
      // Exact seeded-model matching and real bundle inspection happen below.
      if (prerequisite.kind === "skill") continue;
      if (prerequisite.kind !== "host-runtime") {
        issues.push("SOURCE_DEPENDENCY_UNSUPPORTED");
        continue;
      }
      switch (prerequisite.code) {
        case "FRESH_CACHE_AND_ENVIRONMENT":
          if (!runnerReady) {
            issues.push("HOST_FRESH_CACHE_AND_ENVIRONMENT_UNAVAILABLE");
          }
          break;
        case "NO_REMOTE_OR_NPM_RESOLUTION":
          if (!runnerReady) {
            issues.push("HOST_NO_REMOTE_OR_NPM_RESOLUTION_UNAVAILABLE");
          }
          break;
        case "DENIED_IMPORTS":
          if (!runnerReady) issues.push("HOST_DENIED_IMPORTS_UNAVAILABLE");
          break;
        case "MACOS_DENY_DEFAULT_SANDBOX":
          if (!runnerReady) {
            issues.push("HOST_MACOS_DENY_DEFAULT_SANDBOX_UNAVAILABLE");
          }
          break;
        case "FRESH_PRIVATE_RESOURCE_BINDINGS":
          // Production composition pairs the actual Case builder with this
          // inspector and the runtime. The builder creates local stores and
          // exact-model information afresh; source eligibility below excludes
          // resources it cannot bind. This trusted wiring is not a grant.
          if (typeof this.options.dependencies !== "function") {
            issues.push("HOST_FRESH_PRIVATE_RESOURCE_BINDINGS_UNAVAILABLE");
          }
          break;
        default:
          issues.push("HOST_REQUIREMENT_UNSUPPORTED");
      }
    }
    // Inspect exact retained source models even when a host requirement already
    // refuses: inert initialization does not prove source schedule eligibility.
    const exactReader = await this.options.reader();
    const revision = await exactReader.at(manifest.source!.sourceVersion);
    if (
      exactReader.repositoryId !== this.options.repositoryId ||
      revision.sourceDigest !== manifest.source!.sourceDigest
    ) return { supported: false, issues: [...issues, "SOURCE_DIGEST_DIFFERS"] };
    const units = discoverConversationUnits(
      revision,
      this.options.sourceProjectId,
    );
    if (units.length !== manifest.operators.length) {
      issues.push("SOURCE_MEMBERSHIP_DIFFERS");
    }
    const exactModels: ExecutableModel[] = [];
    const compiled = units.length
      ? await this.options.compilation.compile(
        revision,
        this.options.sourceProjectId,
      )
      : [];
    for (const unit of units) {
      const model = structuredClone(
        selectValidatedSourceExecutable(compiled, unit.systemQualifiedName),
      );
      const matches = manifest.operators.filter((operator) =>
        operator.operatorId === model.identity.builderId
      );
      if (
        matches.length !== 1 ||
        matches[0].modelDigest !== model.version.digest ||
        matches[0].systemQualifiedName !== unit.systemQualifiedName ||
        model.version.repositoryVersion !== manifest.source!.sourceVersion
      ) issues.push("SOURCE_MODEL_PIN_DIFFERS");
      try {
        await assertRetainedCatalog(model, matches[0]?.tools ?? []);
      } catch {
        issues.push("SOURCE_DEPENDENCY_UNSUPPORTED");
      }
      issues.push(...requestOpeningModelIssues(model));
      exactModels.push(model);
    }
    issues.push(
      ...await requestOpeningInitialSkillIssues(
        exactModels,
        manifest.prerequisites,
        this.options.inspectInitialSkills,
      ),
    );
    return { supported: issues.length === 0, issues: [...new Set(issues)] };
  };
  readonly supportsHost = async (
    manifest: SavedSystemManifest,
  ): Promise<boolean> => {
    return (await this.inspectHostSupport(manifest)).supported;
  };

  readonly currentMainVersion = async () => {
    // history() reads the authoritative admitted first-parent ref. header()
    // verifies its source bytes; admittedMainSource() independently establishes
    // eligibility. Workspace HEAD and mutable runtime pins are never used.
    const history = await this.options.repository.history({ limit: 1 });
    const version = history.headVersion;
    if (!exactSourceVersion(version)) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "Admitted main is unavailable.",
      );
    }
    const header = await this.options.repository.header(version);
    const evidence = await (await this.options.reader()).admittedMainSource(
      version,
    );
    if (
      header.version !== version || evidence.headVersion !== version ||
      evidence.sourceDigest !== header.sourceDigest
    ) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "Admitted main changed during source selection.",
      );
    }
    return version;
  };
}
