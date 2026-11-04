/** Closed operator commands over the existing deterministic dossier lifecycle. */
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import {
  isModelEditTypeName,
  isNativeReferenceId,
  isReferenceSiteFingerprint,
  type ModelEdit,
} from "../../../domain/model/editing/tooling.ts";
import type {
  EvolutionAct,
  EvolutionAuthorityExercise,
} from "../../../domain/model/evolution/policy.ts";
import type { OperatorEvolutionSummary } from "../conversation/chat-decision.ts";
import type { SystemRuntimeState } from "./state.ts";
import {
  caseExecutionContext,
  designerExecutionContext,
} from "../cases/runtime.ts";
import {
  type EvolutionDossierBase,
  EvolutionError,
  type EvolutionStorePort,
  type SoftwareEvolutionDossier,
} from "../../model/evolution/ports.ts";
import type { EvolutionService } from "../../model/evolution/service.ts";
import type { OperatorEvolutionCommandPort } from "./ports.ts";

export function evolutionCommandCapabilities(model: ExecutableModel) {
  const policy = model.evolutionPolicy;
  const valid = !!policy &&
    policy.holderNativeId === model.identity.builderId &&
    policy.mandateId === model.mandate.id &&
    policy.mandateRevision === model.configuration.builder.mandateRevision &&
    policy.rootAuthority?.ownerSource === "modeled";
  const has = (act: EvolutionAct) =>
    valid && policy!.grants.some((grant) => grant.act === act);
  const editing = model.modelEditPolicy;
  return {
    prepare: has("prepare") && !!editing &&
      editing.holderNativeId === model.identity.builderId &&
      editing.mandateId === model.mandate.id &&
      editing.mandateRevision === model.configuration.builder.mandateRevision &&
      editing.operations.some((op) => op !== "replace-source"),
    accept: has("accept"),
    adopt: has("adopt"),
  };
}

/** No base, authority, sources, destinations or origin can cross this boundary. */
export function parseEvolutionEdits(editJson: string): ModelEdit[] {
  const fail = (): never => {
    throw new EvolutionError(
      "EVOLUTION_EDIT_INVALID",
      "Expected a closed {edits:[...]} targeted edit request",
    );
  };
  if (typeof editJson !== "string" || editJson.length > 100_000) return fail();
  let value: unknown;
  try {
    value = JSON.parse(editJson);
  } catch {
    return fail();
  }
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).join() !== "edits"
  ) return fail();
  const edits = (value as { edits?: unknown }).edits;
  if (!Array.isArray(edits) || !edits.length || edits.length > 32) {
    return fail();
  }
  for (const edit of edits) {
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) return fail();
    if (edit.kind === "retarget-reference") {
      if (
        Object.keys(edit).sort().join(",") !== "fromId,kind,site,toId" ||
        !isNativeReferenceId(edit.fromId) || !isNativeReferenceId(edit.toId) ||
        !isReferenceSiteFingerprint(edit.site)
      ) return fail();
      continue;
    }
    const fields: Record<string, string[]> = {
      "set-value": ["kind", "elementId", "expression"],
      "set-type": ["kind", "elementId", "typeName"],
      rename: ["kind", "elementId", "name"],
      "insert-member": ["kind", "elementId", "text"],
      remove: ["kind", "elementId"],
    };
    if (typeof edit.kind !== "string" || !Object.hasOwn(fields, edit.kind)) {
      return fail();
    }
    const keys = fields[edit.kind];
    if (
      !keys || Object.keys(edit).sort().join() !== [...keys].sort().join() ||
      keys.some((key) => typeof edit[key] !== "string" || !edit[key].trim()) ||
      edit.elementId.length > 512 ||
      (edit.expression?.length ?? 0) > 4096 || (edit.name?.length ?? 0) > 512 ||
      (edit.text?.length ?? 0) > 100_000 ||
      edit.kind === "set-type" && !isModelEditTypeName(edit.typeName)
    ) return fail();
  }
  return structuredClone(edits) as ModelEdit[];
}

export function evolutionDossierSummary(
  d: EvolutionDossierBase,
): OperatorEvolutionSummary {
  const receipt = (r: EvolutionAuthorityExercise) => ({
    actorId: r.operatorNativeId,
    policyId: r.policyId,
    policyRevision: r.policyRevision,
  });
  return {
    id: d.id,
    revision: d.revision,
    status: d.status,
    baseVersion: d.proposal.baseVersion,
    candidateVersion: d.proposal.version,
    sourceDigest: d.proposal.sourceDigest,
    recipeDigest: d.proposal.recipeDigest,
    proposalDigest: d.proposal.digest,
    categories: [...d.proposal.categories],
    targets: structuredClone(d.proposal.targets),
    preparation: receipt(d.preparation),
    ...(d.acceptance ? { acceptance: receipt(d.acceptance) } : {}),
    ...(d.adoptionAuthorization
      ? { adoptionAuthorization: receipt(d.adoptionAuthorization) }
      : {}),
    ...(d.publication ? { publishedVersion: d.publication.version } : {}),
    adoptedOperatorIds: d.adoptions.map((r) => r.operatorId),
    blockers: d.blockers.slice(0, 16).map((b) => ({
      ...b,
      detail: b.detail.slice(0, 500),
    })),
  };
}

/** Visibility exposes metadata only, under the actor's prior admitted policy. */
function visibleEvolutionDossier(
  model: ExecutableModel,
  dossier: EvolutionDossierBase,
): boolean {
  if (dossier.origin.operatorId === model.identity.builderId) return true;
  return dossier.proposal.targets.every((target) =>
    dossier.proposal.categories.every((category) =>
      model.evolutionPolicy?.grants.some((grant) =>
        grant.targetNativeId === target.operatorId &&
        grant.category === category
      )
    )
  );
}

export function operatorEvolutionCommands<D extends SoftwareEvolutionDossier>(
  options: {
    repositoryId: string;
    store: EvolutionStorePort<D>;
    service: Pick<
      EvolutionService<D>,
      "prepare" | "accept" | "cancel" | "authorizeAdoption"
    >;
    snapshot(): SystemRuntimeState;
    armed(): void;
    /** Immutable host/space ownership gate, applied before any visibility or act. */
    owns?(dossier: D): boolean;
    preparationIdentity?(input: {
      command:
        import("../conversation/chat-decision.ts").OperatorEvolutionCommand;
      source: Pick<
        import("../conversation/chat-context.ts").ChatContext,
        "modelContext" | "modelSources"
      >;
      native?: { effectKey: string; inputMessageId: string };
    }): Promise<
      { id: string; callerCommandId: string; callerCommandDigest: string }
    >;
    matchesReplay?(dossier: D, digest: string): boolean;
    receipt?(
      dossier: D,
    ): Promise<
      import("../../../domain/work/records/operator-evolution.ts").EvolutionConversationRecord
    >;
  },
): OperatorEvolutionCommandPort {
  return {
    async context(model) {
      const capabilities = evolutionCommandCapabilities(model);
      if (!Object.values(capabilities).some(Boolean)) return undefined;
      const recent = options.store.listRecent
        ? await options.store.listRecent(options.repositoryId, 256)
        : await options.store.listPending(options.repositoryId);
      const visible = recent.filter((d) =>
        (!options.owns || options.owns(d)) && visibleEvolutionDossier(model, d)
      );
      return {
        policy: structuredClone(model.evolutionPolicy!),
        capabilities,
        dossiers: visible.slice(0, 16).map(evolutionDossierSummary),
        truncated: visible.length > 16 || recent.length >= 256,
      };
    },
    async execute(command, model, source, native) {
      const snapshot = options.snapshot();
      if (
        snapshot.executionModel?.version.digest !== model.version.digest ||
        snapshot.executionModel.identity.builderId !== model.identity.builderId
      ) {
        throw new EvolutionError(
          "EVOLUTION_ADMISSION_CHANGED",
          "The actor's admitted model changed",
        );
      }
      const capabilities = evolutionCommandCapabilities(
        snapshot.executionModel,
      );
      const act = command.kind === "prepare_operator_evolution"
        ? "prepare"
        : command.kind === "decide_operator_evolution"
        ? "accept"
        : "adopt";
      if (!capabilities[act]) {
        throw new EvolutionError(
          "EVOLUTION_AUTHORITY_DENIED",
          `No admitted ${act} evolution grant`,
        );
      }
      const actorId = model.identity.builderId;
      let result: D;
      if (command.kind === "prepare_operator_evolution") {
        const edits = parseEvolutionEdits(command.editJson);
        if (
          edits.some((edit) =>
            !model.modelEditPolicy!.operations.includes(edit.kind)
          )
        ) {
          throw new EvolutionError(
            "EVOLUTION_EDIT_DENIED",
            "Targeted operations exceed the admitted source-edit policy",
          );
        }
        if (
          !source.modelContext || !source.modelSources ||
          source.modelContext.version !== source.modelSources.version
        ) {
          throw new EvolutionError(
            "EVOLUTION_SOURCE_REQUIRED",
            "Consult the exact current source base before preparing evolution",
          );
        }
        const requestId = caseExecutionContext(snapshot)?.caseId;
        const designerScopeId = designerExecutionContext(snapshot)?.scopeId;
        if (!requestId && !designerScopeId) {
          throw new EvolutionError(
            "EVOLUTION_ORIGIN_INVALID",
            "Evolution requires an actual Request or Main Operator invocation",
          );
        }
        const identity = await options.preparationIdentity?.({
          command,
          source,
          ...(native ? { native } : {}),
        });
        const existing = identity ? await options.store.get(identity.id) : null;
        if (existing) {
          if (
            options.owns && !options.owns(existing) ||
            !options.matchesReplay?.(existing, identity!.callerCommandDigest)
          ) {
            throw new EvolutionError(
              "EVOLUTION_CONFLICT",
              "The native command identity already names another immutable intent",
            );
          }
          result = existing;
        } else {result = await options.service.prepare({
            id: identity?.id ?? crypto.randomUUID(),
            ...(identity
              ? {
                callerCommandId: identity.callerCommandId,
                callerCommandDigest: identity.callerCommandDigest,
              }
              : {}),
            repositoryId: options.repositoryId,
            actorId,
            finalizerActorId: actorId,
            origin: {
              operatorId: actorId,
              ...(requestId ? { requestId } : {}),
              ...(designerScopeId ? { designerScopeId } : {}),
            },
            expectedVersion: source.modelContext.version,
            reason: command.reason,
            edit: {
              baseVersion: source.modelContext.version,
              sourceDigest: source.modelContext.sourceDigest,
              reason: command.reason,
              edits,
            },
          });}
      } else {
        const dossier = await options.store.get(command.dossierId);
        if (
          !dossier || dossier.repositoryId !== options.repositoryId ||
          options.owns && !options.owns(dossier) ||
          !visibleEvolutionDossier(model, dossier)
        ) {
          throw new EvolutionError(
            "EVOLUTION_NOT_FOUND",
            "Unknown or uncovered evolution dossier",
          );
        }
        if (command.kind === "decide_operator_evolution") {
          result = command.decision === "accept"
            ? await options.service.accept(dossier.id, actorId)
            : await options.service.cancel(dossier.id, actorId);
        } else {
          result = await options.service.authorizeAdoption(dossier.id, actorId);
          // Never await finalization from the contribution whose completion it needs.
          options.armed();
        }
      }
      let conversationRecord;
      let conversationReceiptUnavailable: true | undefined;
      try {
        conversationRecord = await options.receipt?.(result);
      } catch {
        conversationReceiptUnavailable = true;
      }
      // The act is already committed. An unavailable UI read must never turn
      // success into a retry that prepares or decides a second dossier.
      return {
        ...(conversationReceiptUnavailable
          ? { conversationReceiptUnavailable }
          : {}),
        ...evolutionDossierSummary(result),
        ...(conversationRecord ? { conversationRecord } : {}),
      };
    },
  };
}

/** Coalesced event-driven work, with no timers, model calls or Case invocation. */
export class EvolutionFinalizationJob {
  #running?: Promise<void>;
  #again = false;
  constructor(
    private readonly finalize: () => Promise<void>,
    private readonly failed: (error: unknown) => void,
  ) {}
  schedule(): void {
    this.#again = true;
    if (this.#running) return;
    this.#running = Promise.resolve().then(async () => {
      while (this.#again) {
        this.#again = false;
        try {
          await this.finalize();
        } catch (error) {
          this.failed(error);
        }
      }
    }).finally(() => {
      this.#running = undefined;
      // A state event can arrive after the drain loop returns but before this
      // cleanup microtask. Preserve that late trigger without a recurring timer.
      if (this.#again) this.schedule();
    });
  }
  async idle(): Promise<void> {
    while (this.#running) await this.#running;
  }
}
