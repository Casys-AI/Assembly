import type { SourceExecutablesCompilationPort } from "../../model/source-compilation.ts";
import { assertRetainedCatalog } from "../tools/retained-catalog.ts";
import type { OpeningSourcePort } from "./ports.ts";
import type {
  SavedSystemAssetsPort,
  SavedSystemOpeningReadiness,
  SavedSystemRegistryPort,
} from "../saved-systems/ports.ts";
import {
  assertOpeningBase,
  exactSourceVersion,
  type OpeningBase,
  type OpeningSourceChoice,
  requestSpaceDigest,
  RequestSpaceError,
  type SpaceControlPrincipal,
} from "../../../domain/work/request-spaces.ts";
import {
  savedManifest,
  type SavedSystemManifest,
  type SavedSystemScope,
  type SavedSystemView,
} from "../../../domain/work/saved-systems.ts";
import { caseTypesForModel } from "../../../domain/work/records/case-types.ts";
import type { RequestOpeningSourceReaderPort } from "./opening-source-reader.ts";
import { selectValidatedSourceExecutable } from "../../../domain/model/records/source-executables.ts";
import { discoverConversationUnits } from "../../../domain/model/records/source-identity.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";

/** Public diagnostic vocabulary, never exception text or host paths. */
const openingIssueCodes = new Set([
  "SOURCE_OPENING_UNAVAILABLE",
  "OPENING_READINESS_UNAVAILABLE",
  "FOREIGN_SOURCE_PROVENANCE",
  "REQUEST_SOURCE_PROVENANCE_UNAVAILABLE",
  "SOURCE_PROVENANCE_UNAVAILABLE",
  "SOURCE_BUILD_OR_DEPENDENCIES_UNAVAILABLE",
  "SOURCE_DEPENDENCY_UNSUPPORTED",
  "SOURCE_DIGEST_DIFFERS",
  "SOURCE_MEMBERSHIP_DIFFERS",
  "SOURCE_MODEL_PIN_DIFFERS",
  "SOURCE_SCHEDULE_UNSUPPORTED",
  "SOURCE_SKILL_REQUIREMENT_MISSING",
  "HOST_REQUIREMENT_UNSUPPORTED",
  "HOST_RUNNER_UNSUPPORTED_PLATFORM",
  "HOST_RUNNER_SANDBOX_LAUNCH_FAILED",
  "HOST_FRESH_CACHE_AND_ENVIRONMENT_UNAVAILABLE",
  "HOST_NO_REMOTE_OR_NPM_RESOLUTION_UNAVAILABLE",
  "HOST_DENIED_IMPORTS_UNAVAILABLE",
  "HOST_MACOS_DENY_DEFAULT_SANDBOX_UNAVAILABLE",
  "HOST_FRESH_PRIVATE_RESOURCE_BINDINGS_UNAVAILABLE",
  "HOST_REQUIREMENT_MISSING_FRESH_CACHE_AND_ENVIRONMENT",
  "HOST_REQUIREMENT_MISSING_NO_REMOTE_OR_NPM_RESOLUTION",
  "HOST_REQUIREMENT_MISSING_DENIED_IMPORTS",
  "HOST_REQUIREMENT_MISSING_MACOS_DENY_DEFAULT_SANDBOX",
  "HOST_REQUIREMENT_MISSING_FRESH_PRIVATE_RESOURCE_BINDINGS",
  "INITIAL_SKILL_MODEL_INVALID",
  "INITIAL_SKILL_POLICY_UNAVAILABLE",
  "INITIAL_SKILL_LIMIT_EXCEEDED",
  "INITIAL_SKILL_EXPOSURE_UNAVAILABLE",
  "INITIAL_SKILL_BUNDLE_UNAVAILABLE",
  "INITIAL_SKILL_CONTENT_INVALID",
  "INITIAL_SKILL_CONTENT_DIFFERS",
]);
function unavailableOpening(
  issues: readonly string[],
): SavedSystemOpeningReadiness {
  const safe = [...new Set(issues)].filter((code) =>
    openingIssueCodes.has(code)
  );
  if (!safe.length || issues.some((code) => !openingIssueCodes.has(code))) {
    safe.push("SOURCE_OPENING_UNAVAILABLE");
  }
  return {
    openingAvailability: "unavailable",
    openingIssues: [...new Set(safe)],
  };
}

/** One source-selection mechanism: the qualified Release registry/assets ports.
 * Dynamic main is resolved only for an unselected durable opening; all recovery
 * reads use the recorded immutable manifest/sourceVersion. No synthetic Release. */
export class RequestOpeningSources implements OpeningSourcePort {
  constructor(
    private readonly options: {
      compilation: SourceExecutablesCompilationPort;
      sourceScope: SavedSystemScope;
      sourceProjectId: string;
      registry: SavedSystemRegistryPort;
      assets: SavedSystemAssetsPort;
      reader(): Promise<RequestOpeningSourceReaderPort>;
      /** Host resolves the authoritative admitted main ref, never a runtime pin. */
      currentMainVersion(): Promise<string>;
      releases: {
        inspect(
          id: string,
          controller?: SpaceControlPrincipal,
        ): Promise<SavedSystemView>;
      };
      /** Concrete host constraints must be checked; there is no permissive default. */
      supportsHost(manifest: SavedSystemManifest): Promise<boolean>;
      /** Same production host inspector, used only by the selected read path. */
      inspectHostSupport?(manifest: SavedSystemManifest): Promise<{
        supported: boolean;
        issues: string[];
      }>;
    },
  ) {}
  async resolve(
    choice: OpeningSourceChoice,
    controller?: SpaceControlPrincipal,
  ): Promise<OpeningBase> {
    let manifest: SavedSystemManifest;
    let release: OpeningBase["release"];
    if (choice.kind === "current-main") {
      const version = await this.options.currentMainVersion();
      if (!exactSourceVersion(version)) {
        throw new RequestSpaceError(
          "UNAVAILABLE",
          "The admitted main source is unavailable.",
        );
      }
      if (choice.expectedVersion && choice.expectedVersion !== version) {
        throw new RequestSpaceError(
          "OPENING_CONFLICT",
          "Main differs from the explicitly expected version.",
        );
      }
      const capture = await this.options.registry.resolveSource({
        branch: { kind: "main" },
        sourceVersion: version,
      }, this.options.sourceScope);
      if (capture.source?.sourceVersion !== version || !capture.admission) {
        throw new RequestSpaceError(
          "UNAVAILABLE",
          "The admitted main source cannot be verified.",
        );
      }
      const operators = [];
      for (const operator of capture.operators) {
        operators.push(await this.options.assets.retain(operator));
      }
      manifest = savedManifest({
        origin: capture.origin,
        source: capture.source,
        registeredOperatorIds: capture.registeredOperatorIds,
        operators,
        prerequisites: [
          ...capture.prerequisites,
          ...capture.admission.prerequisites,
        ],
      });
    } else {
      const view = await this.options.releases.inspect(
        choice.releaseId,
        controller,
      );
      manifest = await this.releaseManifest(view, choice);
      release = { id: choice.releaseId, digest: choice.digest };
    }
    const base = await this.base(manifest, choice.kind, release);
    await this.verify(base);
    return base;
  }
  private async releaseManifest(
    view: SavedSystemView,
    choice: Extract<OpeningSourceChoice, { kind: "release" }>,
  ): Promise<SavedSystemManifest> {
    // Retention records a dependency; the actual host must verify its support.
    const retained = view.status === "retained" && view.issues.length === 0;
    const localSkillCandidate = view.status === "incomplete" &&
      view.issues.length === 1 &&
      view.issues[0] === "PREREQUISITES_REQUIRED" &&
      view.manifest?.prerequisites.some((entry) => entry.kind === "skill");
    if (
      view.publication !== undefined &&
        !["completed", "incomplete"].includes(view.publication.outcome) ||
      (!retained && !localSkillCandidate) ||
      view.id !== choice.releaseId || view.assetAvailability !== "verified" ||
      !view.manifest?.source || view.digest !== choice.digest ||
      await requestSpaceDigest(view.manifest) !== choice.digest
    ) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The exact retained Release is unavailable.",
      );
    }
    return structuredClone(view.manifest);
  }
  /** Selected compatibility read. It never calls releases.inspect (which is also
   * used by opening), provisions a runtime, installs a skill or issues a grant. */
  readonly inspectRelease = async (
    view: SavedSystemView,
  ): Promise<SavedSystemOpeningReadiness> => {
    try {
      const manifest = await this.releaseManifest(view, {
        kind: "release",
        releaseId: view.id,
        digest: view.digest ?? "",
      });
      if (!this.options.inspectHostSupport) {
        return unavailableOpening(["OPENING_READINESS_UNAVAILABLE"]);
      }
      const host = await this.options.inspectHostSupport(manifest);
      if (!host.supported || host.issues.length) {
        return unavailableOpening(host.issues);
      }
      const base = await this.base(manifest, "release", {
        id: view.id,
        digest: view.digest!,
      });
      await this.assertBase(base);
      await this.options.assets.inspect(base.manifest);
      return { openingAvailability: "ready", openingIssues: [] };
    } catch {
      return unavailableOpening(["SOURCE_OPENING_UNAVAILABLE"]);
    }
  };
  private async base(
    manifest: SavedSystemManifest,
    sourceKind: OpeningSourceChoice["kind"],
    release?: OpeningBase["release"],
  ): Promise<OpeningBase> {
    const models = await this.models(manifest);
    // Resolve an actual source-owned Request occurrence. Primary identifies a
    // source target, never the human actor or an execution permission.
    const owners = models.filter((model) => model.operator?.primary === true)
      .flatMap((model) =>
        caseTypesForModel(model).filter((type) =>
          type.type === "request" &&
          type.ownerId === model.identity.builderId &&
          type.behaviorId === model.flows.conversation.rootNativeId
        ).map((type) => ({
          operatorId: model.identity.builderId,
          caseTypeId: type.id,
        }))
      );
    if (owners.length !== 1) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "This source has no unique supported Request owner and type.",
      );
    }
    const base: OpeningBase = {
      sourceKind,
      ...(release ? { release } : {}),
      manifest,
      manifestDigest: await requestSpaceDigest(manifest),
      requestOwner: owners[0],
    };
    return base;
  }
  /** A manifest names only content-addressed inputs (exact commit, digests,
   * retained tools), so its verified models are reused by digest. Host and
   * retained asset checks around this read stay live; failures are not kept. */
  readonly #models = new Map<string, Promise<ExecutableModel[]>>();
  private async models(
    manifest: SavedSystemManifest,
  ): Promise<ExecutableModel[]> {
    const exact = structuredClone(manifest);
    const key = await requestSpaceDigest(exact);
    const known = this.#models.get(key);
    if (known) return structuredClone(await known);
    const pending = this.exactModels(exact);
    this.#models.set(key, pending);
    if (this.#models.size > 16) {
      this.#models.delete(this.#models.keys().next().value!);
    }
    pending.catch(() => {
      if (this.#models.get(key) === pending) this.#models.delete(key);
    });
    return structuredClone(await pending);
  }
  private async exactModels(
    manifest: SavedSystemManifest,
  ): Promise<ExecutableModel[]> {
    if (
      manifest.origin.projectId !== this.options.sourceScope.projectId ||
      manifest.origin.systemId !== this.options.sourceScope.systemId
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "The source is outside this host system scope.",
      );
    }
    if (!manifest.source) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The source has no exact model provenance.",
      );
    }
    const reader = await this.options.reader();
    if (reader.repositoryId !== manifest.source.repositoryId) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "The source repository is outside this host scope.",
      );
    }
    const revision = await reader.at(manifest.source.sourceVersion);
    if (revision.sourceDigest !== manifest.source.sourceDigest) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The retained source digest differs.",
      );
    }
    const units = discoverConversationUnits(
      revision,
      this.options.sourceProjectId,
    );
    if (units.length !== manifest.operators.length) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The selected whole-system membership differs.",
      );
    }
    const models: ExecutableModel[] = [];
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
      const selected = manifest.operators.find((operator) =>
        operator.operatorId === model.identity.builderId
      );
      if (
        !selected ||
        selected.repositoryVersion !== manifest.source.sourceVersion ||
        selected.modelDigest !== model.version.digest ||
        selected.systemQualifiedName &&
          selected.systemQualifiedName !== unit.systemQualifiedName
      ) {
        throw new RequestSpaceError(
          "UNAVAILABLE",
          "The selected source model or its retained dependencies differ.",
        );
      }
      await assertRetainedCatalog(model, selected.tools);
      models.push(model);
    }
    return models;
  }
  private async assertBase(base: OpeningBase): Promise<void> {
    assertOpeningBase(base);
    if (await requestSpaceDigest(base.manifest) !== base.manifestDigest) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The exact source closure or required host constraints are unavailable.",
      );
    }
  }
  private async retainedModels(base: OpeningBase): Promise<ExecutableModel[]> {
    await this.options.assets.inspect(base.manifest);
    return await this.models(base.manifest);
  }
  private async verifiedModels(base: OpeningBase): Promise<ExecutableModel[]> {
    await this.assertBase(base);
    if (!await this.options.supportsHost(base.manifest)) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The exact source closure or required host constraints are unavailable.",
      );
    }
    return await this.retainedModels(base);
  }
  async readTool(base: OpeningBase, operatorId: string, candidateId: string) {
    await this.assertBase(base);
    return await this.options.assets.readTool(
      base.manifest,
      operatorId,
      candidateId,
    );
  }
  async verify(base: OpeningBase): Promise<void> {
    await this.verifiedModels(base);
  }
  async readModels(base: OpeningBase): Promise<readonly ExecutableModel[]> {
    return await this.verifiedModels(base);
  }
  async readModelsForInspection(
    base: OpeningBase,
  ): Promise<readonly ExecutableModel[]> {
    await this.assertBase(base);
    return await this.retainedModels(base);
  }
}
