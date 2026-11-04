import type {
  ModelPort,
  StorePort,
} from "../application/work/runtime/ports.ts";
import type { ExecutableModel } from "../domain/model/execution/executable-model.ts";
import type { SystemRuntimeState } from "../domain/work/dialogue.ts";
import type { ModelIdentity } from "../domain/shared-kernel/model-identity.ts";
import { exactSourceVersion } from "../domain/work/request-spaces.ts";
import { spaceControlSourceFromModel } from "../domain/work/space-control-source.ts";
import { canonical } from "../domain/primitives/canonical-json.ts";
import type { PostgresSystemScope } from "../adapters/out/postgres/scope.ts";
import { resolveHostPrimaryOperator } from "../infrastructure/system-identity.ts";

const validId = (value: unknown): value is string =>
  typeof value === "string" && Boolean(value.trim()) && !value.includes("\0");

/** Validate retained admission evidence, without consulting or repairing source. */
function assertModel(
  model: ExecutableModel | undefined,
  owner: string,
  projectId: string,
): asserts model is ExecutableModel {
  const identity = model?.identity;
  if (
    !identity || identity.projectId !== projectId ||
    identity.builderId !== owner ||
    ![
      identity.projectId,
      identity.editingContextId,
      identity.rootId,
      identity.systemId,
      identity.catalogId,
      identity.builderId,
    ].every(validId) ||
    !model?.version || !/^[a-f0-9]{64}$/.test(model.version.digest) ||
    !exactSourceVersion(model.version.repositoryVersion) ||
    model.version.rootId !== identity.rootId ||
    !model.configuration || !model.mandate || !model.policy ||
    !validId(model.configuration.id) || !validId(model.mandate.id) ||
    !Number.isSafeInteger(model.configuration.revision) ||
    model.configuration.revision < 0 ||
    model.version.configurationId !== model.configuration.id ||
    model.version.configurationRevision !== model.configuration.revision ||
    !Array.isArray(model.contracts) || !Array.isArray(model.catalog) ||
    !Array.isArray(model.version.sourceIds) ||
    ![model.flows?.conversation, model.flows?.promotion].every((flow) =>
      flow && validId(flow.rootNativeId) && validId(flow.startNodeId) &&
      Number.isSafeInteger(flow.maxSteps) && flow.maxSteps > 0 &&
      Array.isArray(flow.nodes) &&
      flow.nodes.some((node) => node.id === flow.startNodeId) &&
      Array.isArray(flow.edges) && Array.isArray(flow.bindings)
    )
  ) {
    throw new Error(
      "The PRIMARY requires a coherent exact adopted execution model",
    );
  }
}

function assertState(
  state: SystemRuntimeState,
  owner: string,
  projectId: string,
): ExecutableModel {
  assertModel(state.executionModel, owner, projectId);
  if (canonical(state.model) !== canonical(state.executionModel.identity)) {
    throw new Error(
      "The persisted PRIMARY model differs from its host owner locator",
    );
  }
  return state.executionModel;
}

/** Resolve the persisted PRIMARY before opening stores. A locator conveys no
 * rights; even a policy-free Main must bind its actual native system identity. */
export async function bootstrapPrimaryRuntime<
  T extends { state: Pick<StorePort, "load"> },
>(options: {
  directory: string;
  storage: {
    readonly scope: PostgresSystemScope;
    readonly executionSpaceId: string;
    readPrimaryRuntimeState(
      operatorId: string,
    ): Promise<SystemRuntimeState | null>;
    bindPrimarySpaceControl(binding: {
      primaryOperatorId: string;
      sourceSystemNativeId: string;
    }): unknown;
    operator(operatorId: string): Promise<T>;
  };
  model: Pick<ModelPort, "initialize" | "readExecutableModel">;
  hasPersistedRuntimes(): Promise<boolean>;
  resolvePrimaryOperator?: typeof resolveHostPrimaryOperator;
}) {
  const { storage, model } = options;
  const { projectId, systemId } = storage.scope;
  if (storage.executionSpaceId !== "main") {
    throw new Error("PRIMARY bootstrap requires the host Main execution space");
  }
  let fresh: Promise<ExecutableModel> | undefined;
  const initialize = () =>
    fresh ??= (async () => {
      const identity: ModelIdentity = await model.initialize();
      const initial = await model.readExecutableModel(identity);
      assertModel(initial, identity.builderId, projectId);
      if (canonical(identity) !== canonical(initial.identity)) {
        throw new Error(
          "The source identity changed during PRIMARY initialization",
        );
      }
      return initial;
    })();
  const primaryOperatorId = await (options.resolvePrimaryOperator ??
    resolveHostPrimaryOperator)({
      directory: options.directory,
      projectId,
      systemId,
      hasPersistedRuntimes: options.hasPersistedRuntimes,
      initialize: async () => (await initialize()).identity.builderId,
    });
  const persisted = await storage.readPrimaryRuntimeState(primaryOperatorId);
  const adopted = persisted
    ? assertState(persisted, primaryOperatorId, projectId)
    : await initialize();
  assertModel(adopted, primaryOperatorId, projectId);
  const controlBinding = {
    scope: storage.scope,
    sourceSystemNativeId: adopted.identity.systemId,
  };
  // Reuse canonical control validation before a store can backfill history.
  // Absent/disabled policy remains representable and grants no Request rights.
  spaceControlSourceFromModel(adopted, controlBinding);
  storage.bindPrimarySpaceControl({
    primaryOperatorId,
    sourceSystemNativeId: adopted.identity.systemId,
  });
  const primaryStorage = await storage.operator(primaryOperatorId);
  const loaded = await primaryStorage.state.load();
  if (loaded) {
    const current = assertState(loaded, primaryOperatorId, projectId);
    if (
      canonical(current.identity) !== canonical(adopted.identity) ||
      persisted && loaded.id !== persisted.id ||
      !persisted && canonical(current) !== canonical(adopted)
    ) {
      throw new Error(
        "The opened PRIMARY state differs from its bootstrap binding",
      );
    }
    spaceControlSourceFromModel(current, controlBinding);
  } else if (persisted) {
    throw new Error("The persisted PRIMARY state disappeared during bootstrap");
  }
  return {
    primaryOperatorId,
    primaryStorage,
    admittedInitialModel: persisted ? undefined : adopted,
  };
}
