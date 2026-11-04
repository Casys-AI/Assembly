import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { OperatorEntry } from "../../../domain/model/records/operator-entry.ts";
import { discoverConversationUnits } from "../../../domain/model/records/source-identity.ts";
import { MAX_OPERATOR_UNITS } from "../../../domain/work/records/conversations.ts";
import { EvolutionError } from "../../model/evolution/ports.ts";
import type { NetworkImpactStateEvidenceSource } from "../../model/impact/evidence-sources.ts";
import type { ModelRepositoryPort } from "../../model/repository.ts";
import type { SourceCompilationPort } from "../../model/source-compilation.ts";
import type { ModelPort, StorePort } from "../runtime/ports.ts";
import type { SystemRuntime } from "../runtime/system.ts";
import {
  conversationUnit,
  OperatorConversationError,
  type OperatorConversationManifest,
  type OperatorConversations,
  type OperatorConversationUnit,
} from "./conversations.ts";

/** The live directory remains owned by composition; application readers retain its view. */
export interface WorkspaceRuntime {
  runtime: SystemRuntime;
  model: ModelPort;
  scope: string;
  store?: StorePort;
  history?: NetworkImpactStateEvidenceSource;
}

export function requireWorkspacePrimary(
  primary: ExecutableModel | undefined,
): ExecutableModel {
  if (!primary?.version.repositoryVersion) {
    throw new Error("Missing admitted operator source pin");
  }
  return primary;
}

/** Invoke at runtime admission, after the existing store and model construction. */
export function assertWorkspaceRuntimeAvailable(
  runtimes: ReadonlyMap<string, WorkspaceRuntime>,
  id: string,
): void {
  if (runtimes.has(id)) {
    throw new EvolutionError(
      "EVOLUTION_DUPLICATE_RUNTIME",
      "One live runtime per operator is required",
    );
  }
}

interface WorkspaceRegistryOptions {
  projectId: string;
  primaryId: string;
  primary(): ExecutableModel;
  runtimes: ReadonlyMap<string, WorkspaceRuntime>;
  repository: Pick<ModelRepositoryPort, "at">;
  compilation: SourceCompilationPort;
  loadOperatorState(operatorId: string): ReturnType<StorePort["load"]>;
  pins: Map<string, Promise<ExecutableModel | null>>;
  conversations(): Pick<
    OperatorConversations,
    "withAdmission" | "reconcileUnits" | "resumeCandidateContinuations"
  >;
  initializeSkills(model: ExecutableModel): Promise<void>;
  ensurePlanner(): void | Promise<void>;
  deliveriesActive(): boolean;
}

/** Admitted membership, shared behavior targets and adoption under one admission. */
export function createWorkspaceRegistry(options: WorkspaceRegistryOptions) {
  const { projectId, runtimes, pins } = options;
  const targets = new Map<string, string>();
  const observationOwners = new Map<string, string>();
  const reuseOwners = new Map<string, string>();
  const planOwners = new Map<string, string>();
  const publishedTargets = new Set<string>();
  const reuseTargets = new Set<string>();
  const planTargets = new Set<string>();
  const workTargets = new Set<string>();
  const informationEntries = new Map<
    string,
    { ownerId: string; kind: OperatorEntry["kind"] }
  >();
  async function manifest(
    primaryOverride?: ExecutableModel,
    operatorOverride?: ExecutableModel,
  ): Promise<OperatorConversationManifest> {
    const admitted = primaryOverride ??
      options.primary();
    const revision = await options.repository.at(
      admitted.version.repositoryVersion!,
    );
    const units: OperatorConversationUnit[] = [];
    const discovered = discoverConversationUnits(revision, projectId)
      .map((unit) => ({ unit, revision }));
    const discoveredIds = new Set(
      discovered.map(({ unit }) => unit.identity.builderId),
    );
    for (const { unit, revision: unitRevision } of discovered) {
      let model = unit.identity.builderId === admitted.identity.builderId
        ? structuredClone(admitted)
        : await options.compilation.compile(
          unitRevision,
          projectId,
          unit.systemQualifiedName,
        );
      if (unit.identity.builderId !== admitted.identity.builderId) {
        // Registry membership and executable admission are separate. Existing
        // operators retain their own immutable contract until explicit adoption.
        let local =
          operatorOverride?.identity.builderId === unit.identity.builderId
            ? operatorOverride
            : runtimes.get(unit.identity.builderId)?.runtime.snapshot
              .executionModel;
        if (!local) {
          local = (await options.loadOperatorState(unit.identity.builderId))
            ?.executionModel;
        }
        if (local) {
          const pin = local.version.repositoryVersion;
          if (!pin) throw new Error("Missing admitted operator source pin");
          const compiled = await options.compilation.compile(
            await options.repository.at(pin),
            projectId,
            unit.systemQualifiedName,
          );
          if (
            compiled.version.digest !== local.version.digest ||
            compiled.identity.builderId !== unit.identity.builderId ||
            compiled.identity.systemId !== unit.identity.systemId
          ) {
            throw new Error(
              "The persisted operator contract does not match its immutable source",
            );
          }
          model = compiled;
        }
      }
      // Each operator may admit creation in its own pinned contract while Main
      // remains on an older pin. Discover only that operator's admitted children,
      // then recursively use their own pins; repository HEAD grants no admission.
      const ownRevision =
        model.version.repositoryVersion === unitRevision.version
          ? unitRevision
          : await options.repository.at(model.version.repositoryVersion!);
      for (
        const candidate of discoverConversationUnits(ownRevision, projectId)
      ) {
        if (discoveredIds.has(candidate.identity.builderId)) continue;
        const child = await options.compilation.compile(
          ownRevision,
          projectId,
          candidate.systemQualifiedName,
        );
        if (
          child.operatorTeam?.parentOperatorId !== model.identity.builderId
        ) continue;
        if (discovered.length >= MAX_OPERATOR_UNITS) {
          throw new OperatorConversationError(
            "INVALID_MANIFEST",
            "The admitted operator registry exceeds its capacity",
            409,
          );
        }
        discoveredIds.add(candidate.identity.builderId);
        discovered.push({ unit: candidate, revision: ownRevision });
      }
      units.push(conversationUnit(unit.systemQualifiedName, model));
    }
    if (
      units.length > MAX_OPERATOR_UNITS ||
      units.filter((unit) => unit.model.operator?.primary).length > 1
    ) {
      throw new OperatorConversationError(
        "INVALID_MANIFEST",
        "The prospective registry does not have a unique primary contact",
        409,
      );
    }
    return { repositoryVersion: revision.version, units };
  }

  function registerTargets(units: readonly OperatorConversationUnit[]) {
    informationEntries.clear();
    targets.clear();
    observationOwners.clear();
    reuseOwners.clear();
    planOwners.clear();
    publishedTargets.clear();
    reuseTargets.clear();
    planTargets.clear();
    workTargets.clear();
    for (const unit of units) {
      const actor = unit.model.identity.builderId;
      for (const entry of unit.model.operatorEntries || []) {
        if (
          entry.kind === "context-evidence" ||
          entry.kind.startsWith("memory-") ||
          entry.kind.startsWith("skill-")
        ) {
          informationEntries.set(entry.id, {
            ownerId: actor,
            kind: entry.kind,
          });
        }
        if (entry.kind === "inbox") {
          targets.set(entry.id, actor);
          workTargets.add(entry.id);
        }
        if (entry.kind === "inspect-work-artifacts") {
          observationOwners.set(entry.id, actor);
        }
        if (entry.kind === "reuse-tool") {
          reuseOwners.set(entry.id, actor);
          reuseTargets.add(entry.id);
        }
        if (entry.kind === "work-plan") {
          planOwners.set(entry.id, actor);
          planTargets.add(entry.id);
        }
        if (entry.kind === "published-tools") publishedTargets.add(entry.id);
      }
    }
  }

  /** Publish admitted membership and clear cached pins inside the caller's reservation. */
  async function publishRegistry(): Promise<OperatorConversationManifest> {
    const next = await manifest();
    await options.conversations().reconcileUnits(next);
    registerTargets(next.units);
    pins.clear();
    return next;
  }

  async function reconcile({ onlyNew = false } = {}) {
    const known = new Set(runtimes.keys());
    const next = await publishRegistry();
    for (const unit of next.units) {
      if (onlyNew && known.has(unit.model.identity.builderId)) continue;
      await options.initializeSkills(unit.model);
      await runtimes.get(unit.model.identity.builderId)?.runtime
        .prepareInitialTools();
    }
    await options.ensurePlanner();
    if (options.deliveriesActive()) {
      await options.conversations().resumeCandidateContinuations();
    }
  }

  async function adopt(
    input: {
      agentId?: string;
      expectedDigest: string;
      expectedVersion: string;
    },
    adopt: () => Promise<void>,
  ) {
    await options.conversations().withAdmission(async () => {
      const actor = input.agentId ??
        options.primary().identity.builderId;
      const target = runtimes.get(actor);
      if (!target) {
        throw new OperatorConversationError(
          "UNKNOWN_AGENT",
          "Unknown admitted operator",
          404,
        );
      }
      const source = await options.repository.at(input.expectedVersion);
      const prospective = await options.compilation.compile(
        source,
        projectId,
        target.scope,
      );
      if (
        prospective.version.digest !== input.expectedDigest ||
        prospective.identity.builderId !== actor
      ) {
        throw new OperatorConversationError(
          "MODEL_MISMATCH",
          "The selected operator contract has changed",
          409,
        );
      }
      // Compile the entire prospective registry before the selected store is
      // mutated. Other operators keep their separately admitted contracts.
      await manifest(
        actor === options.primaryId ? prospective : undefined,
        prospective,
      );
      await adopt();
      await reconcile();
    });
  }

  return {
    targets,
    observationOwners,
    reuseOwners,
    planOwners,
    publishedTargets,
    reuseTargets,
    planTargets,
    workTargets,
    informationEntries,
    manifest,
    registerTargets,
    publishRegistry,
    reconcile,
    adopt,
  };
}
