import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import type { BehaviorModelVersion } from "../../../domain/shared-kernel/behavior-model-version.ts";
import { canContributeFromMain } from "../../../domain/work/request-spaces/branch-team.ts";
import type { ModelRepositoryPort } from "../../model/repository.ts";
import type { SourceCompilationPort } from "../../model/source-compilation.ts";
import type {
  PublishedToolArtifact,
  ToolReuseImport,
} from "../artifacts/catalog.ts";
import { pinnedResolution } from "../behaviors/invocation.ts";
import { caseExecutionContext } from "../cases/runtime.ts";
import type { WorkspaceRuntime } from "./workspace-registry.ts";

/** Reads use the live admitted directory and the registry's shared pin cache. */
export function createWorkspaceReaders(options: {
  projectId: string;
  runtimes: ReadonlyMap<string, WorkspaceRuntime>;
  pins: Map<string, Promise<ExecutableModel | null>>;
  targets: ReadonlyMap<string, string>;
  repository: Pick<ModelRepositoryPort, "at">;
  compilation: SourceCompilationPort;
}) {
  const { projectId, runtimes, pins, targets } = options;
  async function resolveCallerModel(
    callerId: string,
    version: BehaviorModelVersion,
  ): Promise<ExecutableModel | null> {
    const entry = runtimes.get(callerId);
    if (
      !entry ||
      entry.runtime.snapshot.executionModel?.version.digest !== version.digest
    ) return null;
    const key = JSON.stringify([
      callerId,
      version.digest,
      version.repositoryVersion,
    ]);
    const result = await pinnedResolution(pins, key, async () => {
      const revision = await options.repository.at(version.repositoryVersion);
      const model = await options.compilation.compile(
        revision,
        projectId,
        entry.scope,
      );
      return model.identity.builderId === callerId &&
          model.version.digest === version.digest
        ? model
        : null;
    });
    return entry.runtime.snapshot.executionModel?.version.digest ===
          version.digest && result
      ? structuredClone(result)
      : null;
  }

  async function ownEvidenceScope(callerId: string) {
    const entry = runtimes.get(callerId);
    if (
      !entry?.history || !entry.runtime.snapshot.executionModel ||
      entry.runtime.snapshot.executionModel.identity.builderId !== callerId
    ) return null;
    return {
      id: `own-history:${projectId}:${await sha256(callerId)}`,
      ownerId: callerId,
    };
  }
  async function readSourceRevision(callerId: string) {
    const runtime = runtimes.get(callerId);
    const identity = runtime?.runtime.snapshot.model;
    if (!identity || !runtime?.model.readSourceRevision) {
      throw new Error(
        "The model context caller has no source revision reader",
      );
    }
    return await runtime.model.readSourceRevision(identity);
  }
  function canContribute(callerId: string, targetNativeId: string) {
    const target = targets.get(targetNativeId);
    const model = target
      ? runtimes.get(target)?.runtime.snapshot.executionModel
      : undefined;
    if (!model) return true;
    const caller = runtimes.get(callerId);
    const context = caller && caseExecutionContext(caller.runtime.snapshot);
    return canContributeFromMain(model, callerId, context);
  }
  function observationTarget(operatorId: string) {
    const entry = runtimes.get(operatorId);
    return entry
      ? {
        model: entry.model,
        store: {
          load: () =>
            entry.store
              ? entry.store.load()
              : entry.runtime.readPersistedState(),
        },
      }
      : undefined;
  }
  async function listArtifacts(): Promise<PublishedToolArtifact[]> {
    const result: PublishedToolArtifact[] = [];
    for (const [agentId, entry] of runtimes) {
      const state = entry.runtime.snapshot;
      const native = await entry.model.readExecutableModel(state.model!);
      if (native.version.digest !== state.executionModel?.version.digest) {
        continue;
      }
      for (
        const candidate of state.candidates.filter((value) =>
          value.stage === "active"
        )
      ) {
        const verified = await entry.runtime.resolveBoundCandidateSource(
          candidate.id,
          candidate.digest,
        );
        result.push({ agentId, candidate: verified, model: native });
      }
    }
    return result;
  }

  async function findArtifact(
    sourceAgentId: string,
    candidateId: string,
    digest: string,
  ) {
    const entry = runtimes.get(sourceAgentId);
    if (!entry) return null;
    const state = entry.runtime.snapshot;
    const native = await entry.model.readExecutableModel(state.model!);
    if (native.version.digest !== state.executionModel?.version.digest) {
      return null;
    }
    const candidate = state.candidates.find((value) =>
      value.id === candidateId && value.digest === digest &&
      value.stage === "active"
    );
    if (!candidate) return null;
    const verified = await entry.runtime.resolveBoundCandidateSource(
      candidate.id,
      candidate.digest,
    );
    return { agentId: sourceAgentId, candidate: verified, model: native };
  }
  async function importForCaller(callerId: string, input: ToolReuseImport) {
    const entry = runtimes.get(callerId);
    if (!entry) throw new Error("Unknown admitted importing operator");
    return await entry.runtime.importAdmittedArtifact(input);
  }

  return {
    resolveCallerModel,
    ownEvidenceScope,
    readSourceRevision,
    canContribute,
    observationTarget,
    listArtifacts,
    findArtifact,
    importForCaller,
  };
}
