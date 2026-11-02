import type { BehaviorModelVersion } from "../domain/shared-kernel/behavior-model-version.ts";
import { GovernedMemoryPromotionService } from "../application/memory/governed-memory-promotion.ts";
import { ContextSkillsService } from "../application/skills/context-skills.ts";
import type { ArtifactSourceServicePort } from "../application/work/artifacts/publication.ts";
import { bundledSkillReader } from "../adapters/out/filesystem/skill-bundles.ts";
import {
  inspectRequestInitialSkills,
  type RequestBundledSkillReader,
  type RequestInitialSkillsInspection,
} from "../adapters/skills/request-initial-skills.ts";
import type { ProviderCallContextPort } from "../application/telemetry/provider-call.ts";
import { BehaviorInvocationRegistry } from "../application/work/behaviors/invocation.ts";
import type { DecisionInformationPort } from "../application/work/context/information-ports.ts";
import {
  ModelContextInformation,
  type ModelContextInformationOptions,
} from "../application/model/consultation/context-information.ts";
import type { OperatorStorage } from "../adapters/out/postgres/host-storage.ts";
import {
  assertPostgresSystemScope,
  type PostgresRuntimeScope,
  type PostgresSystemScope,
} from "../adapters/out/postgres/scope.ts";
import { DenoToolRunner } from "../adapters/out/sandbox/runner.ts";
import { SkillsBehavior } from "../application/skills/behavior.ts";
import { InformationBehavior } from "../application/work/context/information-behavior.ts";
import { RequestInformationScope } from "../adapters/work/information/request-scope.ts";
import type { RequestSpaceRuntimeDependencies } from "../adapters/work/request-space-runtime.ts";
import type { ExecutableModel } from "../domain/model/execution/executable-model.ts";
import { SkillError } from "../domain/skills/context-skills.ts";
import type {
  ModelSourceRevision,
  SystemRuntimeState,
} from "../domain/work/dialogue.ts";
import { RequestSpaceError } from "../domain/work/request-spaces.ts";

export interface RequestRuntimeDependenciesOptions {
  hostScope: PostgresSystemScope;
  sourceProjectId: string;
  agents: RequestSpaceRuntimeDependencies["agents"];
  runner: DenoToolRunner;
  clock: RequestSpaceRuntimeDependencies["clock"];
  schemaValidator: RequestSpaceRuntimeDependencies["schemaValidator"];
  runtimeProvenance: NonNullable<
    RequestSpaceRuntimeDependencies["runtimeProvenance"]
  >;
  providerCallContext?: ProviderCallContextPort;
  /** Historical evidence resolver over verified executed lineage of this exact
   * store scope, independent from the current-only authority resolver. */
  resolveExecutedModel?(
    scope: PostgresRuntimeScope,
    version: BehaviorModelVersion,
  ): Promise<ExecutableModel | null>;
  /** Construct only the supplied trusted Case-store scope, never Main's service. */
  artifactSourcesForScope(
    scope: PostgresRuntimeScope,
  ): Promise<Pick<ArtifactSourceServicePort, "publishSkill" | "resolveSkill">>;
  /** One configured reader is shared by eligibility, initialization and the writer verifier. */
  readBundledSkill?: RequestBundledSkillReader;
  modelContext:
    & Pick<
      ModelContextInformationOptions,
      "reader" | "toolingQuery" | "toolingReferenceSites"
    >
    & {
      readSourceRevision(
        model: ExecutableModel,
        scope?: PostgresRuntimeScope,
      ): Promise<ModelSourceRevision>;
    };
}

function unavailable(operation: string): never {
  throw new RequestSpaceError(
    "UNAVAILABLE",
    `${operation} is unavailable in this Request space`,
  );
}

/** One concrete runner and its scoped builder travel together into source
 * support and runtime composition. No Main information, provider registry,
 * artifact authority or workspace action port is accepted by this constructor.
 */
export class RequestRuntimeDependencies {
  readonly #options: RequestRuntimeDependenciesOptions;
  readonly #readBundledSkill: RequestBundledSkillReader;

  constructor(options: RequestRuntimeDependenciesOptions) {
    assertPostgresSystemScope(options.hostScope);
    if (
      !options.sourceProjectId.trim() ||
      !(options.runner instanceof DenoToolRunner) ||
      typeof options.artifactSourcesForScope !== "function"
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "Exact source identity and a concrete Request runner are required",
      );
    }
    this.#readBundledSkill = options.readBundledSkill ?? bundledSkillReader();
    this.#options = {
      hostScope: Object.freeze({ ...options.hostScope }),
      sourceProjectId: options.sourceProjectId,
      agents: options.agents,
      runner: options.runner,
      clock: options.clock,
      schemaValidator: options.schemaValidator,
      runtimeProvenance: options.runtimeProvenance,
      providerCallContext: options.providerCallContext,
      resolveExecutedModel: options.resolveExecutedModel,
      artifactSourcesForScope: options.artifactSourcesForScope,
      readBundledSkill: this.#readBundledSkill,
      modelContext: { ...options.modelContext },
    };
  }

  get runner(): DenoToolRunner {
    return this.#options.runner;
  }

  get readBundledSkill(): RequestBundledSkillReader {
    return this.#readBundledSkill;
  }

  readonly inspectInitialSkills = (
    model: ExecutableModel,
  ): Promise<RequestInitialSkillsInspection> =>
    inspectRequestInitialSkills(model, this.#readBundledSkill);

  readonly create = (
    stores: OperatorStorage,
    exactModel: ExecutableModel,
    currentSnapshot: () => SystemRuntimeState | undefined,
  ): RequestSpaceRuntimeDependencies => {
    const options = this.#options;
    const model = structuredClone(exactModel);
    const ownerId = model.identity.builderId;
    const scope = new RequestInformationScope({
      hostScope: options.hostScope,
      sourceProjectId: options.sourceProjectId,
      scope: stores.scope,
      model,
      currentSnapshot,
      ...(options.resolveExecutedModel
        ? {
          resolveExecutedModel: (version: BehaviorModelVersion) =>
            options.resolveExecutedModel!(stores.scope, version),
        }
        : {}),
    });
    const skillScope = Object.freeze({ ...stores.scope });
    const entries = new Map((model.operatorEntries ?? []).map((entry) => [
      entry.id,
      { ownerId, kind: entry.kind },
    ]));
    const memory = new GovernedMemoryPromotionService({
      store: stores.memory,
      now: () => options.clock.now(),
      provenance: scope,
    });
    const memoryInformation = new InformationBehavior({
      entries,
      resolveCallerModel: scope.resolveCallerModel,
      snapshotForCaller: scope.snapshotForCaller,
      memory: () => Promise.resolve(memory),
    });
    const skills: ContextSkillsService = new ContextSkillsService({
      store: stores.skills,
      now: () => options.clock.now(),
      download: {
        download: () => {
          throw new SkillError(
            "forbidden",
            "Skill download is unavailable in this Request space",
          );
        },
      },
      artifactSources: (requestedOwnerId) => {
        if (requestedOwnerId !== ownerId || !scope.snapshotForCaller(ownerId)) {
          throw new SkillError(
            "forbidden",
            "The exact live Request skill scope is unavailable",
          );
        }
        return options.artifactSourcesForScope(skillScope);
      },
      assertCurrentAuthority: (authority, permission) =>
        skillInformation.assertCurrentAuthority(authority, permission),
    });
    const skillInformation: SkillsBehavior = new SkillsBehavior({
      entries,
      resolveCallerModel: scope.resolveCallerModel,
      skills: () => Promise.resolve(skills),
      readBundledSkill: this.#readBundledSkill,
    });
    const modelInformation = new ModelContextInformation({
      projectId: options.sourceProjectId,
      resolveCallerModel: scope.resolveCallerModel,
      snapshotForCaller: scope.snapshotForCaller,
      reader: options.modelContext.reader,
      toolingQuery: options.modelContext.toolingQuery,
      toolingReferenceSites: options.modelContext.toolingReferenceSites,
      readSourceRevision: (callerId) =>
        scope.readSourceRevision(
          callerId,
          (adopted) =>
            options.modelContext.readSourceRevision(adopted, stores.scope),
        ),
    });
    const information: DecisionInformationPort = {
      modelTools(requested) {
        // SystemRuntime.snapshot projects this catalogue: do not recursively
        // consult its live getter while computing the catalogue itself.
        scope.assertModel(requested);
        return modelInformation.modelTools(requested);
      },
      assertModelContextPin(requested, messages, pin) {
        scope.assertModel(requested);
        return modelInformation.assertModelContextPin(requested, messages, pin);
      },
      withModelContextPin(requested, messages, pin, operation) {
        scope.assertModel(requested);
        return modelInformation.withModelContextPin(
          requested,
          messages,
          pin,
          operation,
        );
      },
      consultModel(requested, input, messages, budget) {
        scope.assertModel(requested);
        return modelInformation.consultModel(
          requested,
          input,
          messages,
          budget,
        );
      },
      consultAdmittedModelSource(requested, input, messages, budget) {
        scope.assertModel(requested);
        return modelInformation.consultAdmittedModelSource(
          requested,
          input,
          messages,
          budget,
        );
      },
      async read(requested, messages) {
        scope.assertModel(requested);
        if (!scope.snapshotForCaller(ownerId)) {
          unavailable("Live Request information");
        }
        return {
          ...await modelInformation.read(requested, messages),
          ...await memoryInformation.read(requested),
          ...await skillInformation.read(requested),
        };
      },
    };
    return {
      agents: options.agents,
      runner: options.runner,
      clock: options.clock,
      schemaValidator: options.schemaValidator,
      runtimeProvenance: options.runtimeProvenance,
      providerCallContext: options.providerCallContext,
      information,
      ...(model.initialSkills?.length
        ? {
          initialSkills: {
            initialize: async () => {
              if (!scope.snapshotForCaller(ownerId)) {
                unavailable(
                  "Live Request skill initialization",
                );
              }
              const inspection = await this.inspectInitialSkills(model);
              if (!inspection.supported) {
                throw new RequestSpaceError(
                  "UNAVAILABLE",
                  inspection.issues.join(","),
                );
              }
              await skillInformation.initialize(model);
            },
          },
        }
        : {}),
      behaviors: new BehaviorInvocationRegistry([
        memoryInformation,
        skillInformation,
      ]),
    };
  };
}
