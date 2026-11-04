import type { EvolutionSettingsValidationTargetsPort } from "../../work/runtime/evolution-settings-validation-targets.ts";
import { caseBudgetPolicy as evolutionCaseBudgetPolicy } from "../../work/cases/runtime.ts";
import {
  captureEvolutionOrigin,
  evolutionBudgetScopes,
} from "../../work/runtime/evolution.ts";
import { EvolutionService } from "../../model/evolution/service.ts";
import {
  type EvolutionAuthorityPort,
  type EvolutionCheckpoint,
  EvolutionError,
  type EvolutionRepositoryPort,
  type EvolutionStorePort,
  type EvolutionTargetPort,
} from "../../model/evolution/ports.ts";
import type { ScopedExecutableModel } from "../../../domain/model/evolution/semantic-effects.ts";
import type { BehaviorSettingsValidationTarget } from "../../work/runtime/behavior-settings-validation.ts";
import type { ClockPort, ModelPort } from "../../work/runtime/ports.ts";
import type { WorkBudgetPort } from "../../work/budget/ports.ts";
import { SystemRuntime } from "../../work/runtime/system.ts";
import {
  OperatorConversationError,
  type OperatorConversationManifest,
  OperatorConversations,
} from "../../work/operators/conversations.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { ModelRepositoryPort } from "../../model/repository.ts";
import type { MemoryStorePort } from "../../memory/ports/store.ts";
import type { SourceCompilationPort } from "../../model/source-compilation.ts";
import type { WorkspaceRuntime } from "../operators/workspace-registry.ts";
export interface WorkspaceEvolutionPorts {
  repositoryId: string;
  store: EvolutionStorePort;
  authority: EvolutionAuthorityPort;
  repository: EvolutionRepositoryPort;
}
export interface WorkspaceEvolutionContext
  extends EvolutionSettingsValidationTargetsPort {
  targets: EvolutionTargetPort;
  runtimeFor(
    operatorId: string,
  ): { runtime: SystemRuntime; model: ModelPort; scope: string } | undefined;
}

/** Evolution decisions share the host's live directory and reservations. */
export function createWorkspaceEvolutionTargets(options: {
  runtimes: ReadonlyMap<string, Pick<WorkspaceRuntime, "runtime" | "scope">>;
  primaryId: string;
  projectId: string;
  repository: Pick<ModelRepositoryPort, "at">;
  compilation: SourceCompilationPort;
  workBudget?: WorkBudgetPort;
  clock: ClockPort;
  memoryRecords: MemoryStorePort["list"];
  evolutionPorts(): WorkspaceEvolutionPorts | undefined;
  withAdmission: OperatorConversations["withAdmission"];
  manifest(
    primary?: ExecutableModel,
    prospective?: ExecutableModel,
  ): Promise<OperatorConversationManifest>;
  reconcileRegistry(): Promise<void>;
}) {
  const { runtimes, projectId } = options;
  const evolutionTargets: EvolutionTargetPort = {
    async withArmingTargets(dossier, saveArmed) {
      const targets = [...dossier.proposal.targets].sort((a, b) =>
        a.operatorId < b.operatorId ? -1 : a.operatorId > b.operatorId ? 1 : 0
      );
      const reserve = async (
        index: number,
      ): Promise<Awaited<ReturnType<typeof saveArmed>>> => {
        if (index === targets.length) return await saveArmed();
        const runtime = runtimes.get(targets[index]!.operatorId)?.runtime;
        if (!runtime) {
          throw new EvolutionError(
            "EVOLUTION_TARGET_MISSING",
            "An arming target has no admitted runtime",
          );
        }
        return await runtime.withEvolutionArming(() => reserve(index + 1));
      };
      return await reserve(0);
    },
    captureOrigin(input, proposal) {
      return Promise.resolve(
        captureEvolutionOrigin(
          input,
          proposal,
          [...runtimes.values()].map((entry) => entry.runtime.snapshot),
        ),
      );
    },
    async withReservedTargets(dossier, operation) {
      const ordered = [...dossier.proposal.targets].sort((a, b) =>
        a.operatorId < b.operatorId ? -1 : a.operatorId > b.operatorId ? 1 : 0
      );
      const reserve = async (
        index: number,
      ): Promise<Awaited<ReturnType<typeof operation>>> => {
        if (index < ordered.length) {
          const entry = runtimes.get(ordered[index]!.operatorId);
          if (!entry) {
            throw new EvolutionError(
              "EVOLUTION_TARGET_MISSING",
              "Target operator is not admitted",
            );
          }
          return await entry.runtime.withEvolutionReservation(
            dossier.id,
            () => reserve(index + 1),
          );
        }
        // Only a published, validated target may explain a policy already
        // advanced by an interrupted adoption. Ordinary HEAD is never proof.
        const replacements = new Map<
          string,
          ExecutableModel
        >();
        if (dossier.publication) {
          for (const target of dossier.proposal.targets) {
            const entry = runtimes.get(target.operatorId);
            if (!entry) continue;
            const replacement = await options.compilation.compile(
              await options.repository.at(dossier.publication.version),
              projectId,
              entry.scope,
            );
            if (
              replacement.version.digest !== target.candidateDigest ||
              replacement.version.repositoryVersion !==
                dossier.publication.version
            ) {
              throw new EvolutionError(
                "EVOLUTION_ADOPTION_MISMATCH",
                "Published replacement budget source differs",
              );
            }
            replacements.set(target.operatorId, replacement);
          }
        }
        const evaluate = async (): Promise<EvolutionCheckpoint> => {
          const checkpoint: EvolutionCheckpoint = { safe: true, blockers: [] };
          for (const target of ordered) {
            const boundary = await runtimes.get(target.operatorId)!.runtime
              .evolutionBoundary(dossier.id, (scope) => {
                const owner = runtimes.get(scope.ownerId)?.runtime.snapshot
                  .executionModel;
                const replacement = replacements.get(scope.ownerId);
                const policy = (model: typeof owner) =>
                  model &&
                  (scope.designer
                    ? model.workBudgetPolicy
                    : evolutionCaseBudgetPolicy(
                      model,
                      scope.caseTypeId,
                      scope.ceiling,
                    ));
                return [policy(owner), policy(replacement)].filter((
                  value,
                ): value is NonNullable<typeof value> => value !== undefined);
              });
            checkpoint.safe &&= boundary.safe;
            checkpoint.blockers.push(...boundary.blockers);
            const runtimeState =
              runtimes.get(target.operatorId)!.runtime.snapshot;
            for (const scope of evolutionBudgetScopes(runtimeState)) {
              const owner = runtimes.get(scope.ownerId)?.runtime.snapshot
                .executionModel;
              const policy = owner &&
                (scope.designer
                  ? owner.workBudgetPolicy
                  : evolutionCaseBudgetPolicy(
                    owner,
                    scope.caseTypeId,
                    scope.ceiling,
                  ));
              if (!owner || policy && !options.workBudget) {
                checkpoint.safe = false;
                checkpoint.blockers.push({
                  code: "EVOLUTION_BUDGET_OWNER_MISSING",
                  operatorId: target.operatorId,
                  detail:
                    `Budget ${scope.scopeId} has no available owner/reader`,
                });
                continue;
              }
              if (!policy) continue;
              try {
                let view;
                try {
                  view = await options.workBudget!.snapshot(
                    scope.scopeId,
                    scope.ownerId,
                    policy,
                  );
                } catch (error) {
                  if (
                    scope.pending && error instanceof Error &&
                    "code" in error &&
                    error.code === "missing-state"
                  ) continue;
                  // A prior adoption attempt may have durably adopted its ledger
                  // immediately before crashing, without changing the runtime pin.
                  if (
                    !dossier.publication ||
                    !dossier.proposal.targets.some((item) =>
                      item.operatorId === scope.ownerId
                    )
                  ) throw error;
                  const ownerEntry = runtimes.get(scope.ownerId)!;
                  const replacement = await options.compilation.compile(
                    await options.repository.at(dossier.publication.version),
                    projectId,
                    ownerEntry.scope,
                  );
                  const next = scope.designer
                    ? replacement.workBudgetPolicy
                    : evolutionCaseBudgetPolicy(
                      replacement,
                      scope.caseTypeId,
                      scope.ceiling,
                    );
                  view = await options.workBudget!.snapshot(
                    scope.scopeId,
                    scope.ownerId,
                    next,
                  );
                }
                if (view?.reserved) {
                  checkpoint.safe = false;
                  checkpoint.blockers.push({
                    code: "EVOLUTION_BUDGET_UNSETTLED",
                    operatorId: target.operatorId,
                    detail:
                      `Budget ${scope.scopeId} retains ${view.reserved} reserved attempts`,
                  });
                }
              } catch (error) {
                checkpoint.safe = false;
                checkpoint.blockers.push({
                  code: "EVOLUTION_BUDGET_UNPROVEN",
                  operatorId: target.operatorId,
                  detail: error instanceof Error
                    ? error.message
                    : String(error),
                });
              }
            }
          }
          return checkpoint;
        };
        const checkpoint = await evaluate();
        const result = await operation(checkpoint, evaluate);
        // Runtime pins changed inside this same reservation. Publish their
        // actual admitted registry before reopening any command surface.
        await options.reconcileRegistry();
        return result;
      };
      try {
        return await options.withAdmission(() => reserve(0));
      } catch (error) {
        if (
          error instanceof EvolutionError &&
            error.code === "EVOLUTION_RUNTIME_BUSY" ||
          error instanceof OperatorConversationError &&
            error.code === "AGENT_BUSY"
        ) {
          return await operation({
            safe: false,
            blockers: [{
              code: "EVOLUTION_RUNTIME_BUSY",
              detail:
                "An operator command is still running; retry finalization after it settles",
            }],
          });
        }
        throw error;
      }
    },
    async inspectAdoption(dossier, target, publication) {
      const entry = runtimes.get(target.operatorId);
      if (!entry) {
        throw new EvolutionError(
          "EVOLUTION_TARGET_MISSING",
          "Target operator is not admitted",
        );
      }
      const persisted = await entry.runtime.readPersistedState();
      if (
        !persisted || persisted.revision !== entry.runtime.snapshot.revision
      ) {
        throw new EvolutionError(
          "EVOLUTION_STATE_DRIFT",
          "The durable target journal changed",
        );
      }
      return entry.runtime.inspectEvolutionAdoption(
        dossier,
        target,
        publication,
      );
    },
    async adoptExact(dossier, target, publication) {
      const entry = runtimes.get(target.operatorId);
      const ports = options.evolutionPorts();
      if (!entry || !ports) {
        throw new EvolutionError(
          "EVOLUTION_TARGET_MISSING",
          "Target adoption is unavailable",
        );
      }
      if (
        await ports.store.targetOwner(
          dossier.repositoryId,
          target.operatorId,
        ) !== dossier.id
      ) {
        throw new EvolutionError(
          "EVOLUTION_BARRIER_LOST",
          "The durable target reservation changed",
        );
      }
      await ports.authority.revalidate(
        dossier.adoptionAuthorization!,
        dossier.proposal,
      );
      const source = await options.repository.at(publication.version);
      const native = await options.compilation.compile(
        source,
        projectId,
        entry.scope,
      );
      await options.manifest(
        target.operatorId === options.primaryId ? native : undefined,
        native,
      );
      await entry.runtime.adoptEvolution(dossier, target, publication, native);
      const receipt = await evolutionTargets.inspectAdoption(
        dossier,
        target,
        publication,
      );
      if (!receipt) {
        throw new EvolutionError(
          "EVOLUTION_RECEIPT_MISSING",
          "Native adoption has no durable receipt",
        );
      }
      return receipt;
    },
  };
  const validationTargets = async (
    models: readonly ScopedExecutableModel[],
  ) => {
    const targets: BehaviorSettingsValidationTarget[] = [];
    for (const { model } of models) {
      const entry = runtimes.get(model.identity.builderId);
      if (!entry) {
        throw new EvolutionError(
          "EVOLUTION_TARGET_MISSING",
          "A settings consumer has no admitted runtime",
        );
      }
      const target = await entry.runtime.evolutionValidationTarget(model);
      // This audit loads retained notes without changing their admission state.
      target.memoryRecords = await options.memoryRecords(
        model.identity.builderId,
      );
      target.memoryAuditAt = options.clock.now();
      targets.push(target);
    }
    return targets;
  };
  return { targets: evolutionTargets, validationTargets };
}

/** Finalize only armed dossiers, after their targets have reached idle. */
export async function finalizeWorkspaceEvolution(options: {
  ports: WorkspaceEvolutionPorts | undefined;
  service: Pick<EvolutionService, "finalize"> | undefined;
  runtimes: ReadonlyMap<string, { runtime: Pick<SystemRuntime, "idle"> }>;
}): Promise<void> {
  const { ports: evolutionPorts, service: evolution, runtimes } = options;
  if (!evolution || !evolutionPorts) return;
  // Only armed dossiers require a finalizer. Prepared/accepted ones never
  // reserve work or cause compilation, even when runtime state changes.
  for (
    const dossier of await evolutionPorts.store.listPending(
      evolutionPorts.repositoryId,
    )
  ) {
    if (
      !["armed", "publishing", "published-awaiting-adoption"].includes(
        dossier.status,
      )
    ) continue;
    for (const target of dossier.proposal.targets) {
      await runtimes.get(target.operatorId)?.runtime.idle();
    }
    await evolution.finalize(dossier.id);
  }
}
