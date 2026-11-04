import type { RequestInformationScopeValidationPort } from "./request-information-scope-validation.ts";
import type {
  ExecutionSpaceRef,
  ScopedOperatorRef,
} from "../../../domain/governance/authority.ts";
import type { MemoryProvenancePort } from "../../memory/ports/provenance.ts";
import { caseMessages } from "../cases/runtime.ts";
import type { MemoryContent } from "../../../domain/memory/entities/memory-record.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type { BehaviorModelVersion } from "../../../domain/shared-kernel/behavior-model-version.ts";
import type { ModelSourceRevision } from "../conversation/chat-context.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import {
  exactSourceVersion,
  RequestSpaceError,
} from "../../../domain/work/request-spaces/scope.ts";

/** Local information readers share one exact scoped identity. This adapter
 * resolves evidence only; neither a store handle nor a live snapshot grants
 * modeled permissions. Existing information services enforce those separately.
 */
export class RequestInformationScope implements MemoryProvenancePort {
  readonly #scope: ScopedOperatorRef;
  readonly #model: ExecutableModel;
  readonly #currentSnapshot: () => SystemRuntimeState | undefined;
  readonly #resolveExecutedModel?: (
    version: BehaviorModelVersion,
  ) => Promise<ExecutableModel | null>;

  constructor(input: {
    validation: RequestInformationScopeValidationPort;
    hostScope: Pick<ExecutionSpaceRef, "projectId" | "systemId">;
    sourceProjectId: string;
    scope: ScopedOperatorRef;
    model: ExecutableModel;
    currentSnapshot: () => SystemRuntimeState | undefined;
    /** Only exact executed lineage proved in this Case; never latest source or
     * caller authority. This resolver is exclusively for historical evidence. */
    resolveExecutedModel?: (
      version: BehaviorModelVersion,
    ) => Promise<ExecutableModel | null>;
  }) {
    const { scope, model } = structuredClone({
      scope: input.scope,
      model: input.model,
    });
    input.validation.assertSystemScope(input.hostScope);
    input.validation.assertRuntimeScope(scope);
    if (
      scope.projectId !== input.hostScope.projectId ||
      scope.systemId !== input.hostScope.systemId ||
      scope.executionSpaceId === "main" ||
      scope.operatorId !== model.identity.builderId ||
      model.identity.projectId !== input.sourceProjectId ||
      !model.version.digest ||
      !exactSourceVersion(model.version.repositoryVersion)
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "The Request stores or exact source model belong to another scope",
      );
    }
    this.#scope = scope;
    this.#model = model;
    this.#currentSnapshot = input.currentSnapshot;
    this.#resolveExecutedModel = input.resolveExecutedModel;
  }

  assertModel(requested: ExecutableModel): void {
    if (canonical(requested) !== canonical(this.#model)) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "The Request information model differs from its exact admission",
      );
    }
  }

  readonly snapshotForCaller = (
    callerId: string,
  ): SystemRuntimeState | undefined => {
    const ownerId = this.#model.identity.builderId;
    if (callerId !== ownerId) return undefined;
    const snapshot = this.#currentSnapshot();
    if (!snapshot) return undefined;
    if (
      snapshot.id !== `request:${this.#scope.executionSpaceId}:${ownerId}` ||
      canonical(snapshot.model) !== canonical(this.#model.identity) ||
      !snapshot.executionModel
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "The live snapshot belongs to another Request",
      );
    }
    this.assertModel(snapshot.executionModel);
    return snapshot;
  };

  readonly resolveCallerModel = (
    callerId: string,
    version: BehaviorModelVersion,
  ): Promise<ExecutableModel | null> => {
    const snapshot = this.snapshotForCaller(callerId);
    return Promise.resolve(
      snapshot && version.digest === this.#model.version.digest &&
        version.repositoryVersion === this.#model.version.repositoryVersion
        ? structuredClone(this.#model)
        : null,
    );
  };

  async readSourceRevision(
    callerId: string,
    read: (model: ExecutableModel) => Promise<ModelSourceRevision>,
  ): Promise<ModelSourceRevision> {
    if (!this.snapshotForCaller(callerId)) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The live Request source snapshot is unavailable",
      );
    }
    const revision = await read(structuredClone(this.#model));
    const design = revision.requestSource;
    const current = this.snapshotForCaller(callerId);
    const currentDesign = design?.kind === "admitted-request-source" &&
      design.executionSpaceId === this.#scope.executionSpaceId &&
      design.admittedSourceVersion === revision.version &&
      design.executedSourceVersion === this.#model.version.repositoryVersion &&
      exactSourceVersion(design.admittedSourceVersion) &&
      Number.isSafeInteger(design.sourceAdmissionRevision) &&
      design.sourceAdmissionRevision >= 1 &&
      /^[a-f0-9]{64}$/.test(design.sourceAdmissionManifestDigest) &&
      current?.cases?.some((record) =>
        record.owner === this.#scope.operatorId &&
        record.openedFrom.openingId === design.openingId
      );
    if (
      design && !currentDesign ||
      revision.version !== this.#model.version.repositoryVersion &&
        !currentDesign
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "The source reader returned another Request revision",
      );
    }
    if (!this.snapshotForCaller(callerId)) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The live Request source snapshot is unavailable",
      );
    }
    return revision;
  }

  async verify(callerId: string, content: MemoryContent): Promise<boolean> {
    const snapshot = this.snapshotForCaller(callerId);
    const messages = snapshot ? caseMessages(snapshot) : [];
    const decision = messages.find((message) =>
      message.id === content.origin.decisionId
    );
    const version = decision?.execution;
    if (!version?.digest || !version.repositoryVersion) return false;
    const current = version.digest === this.#model.version.digest &&
      version.repositoryVersion === this.#model.version.repositoryVersion;
    const executed = current
      ? this.#model
      : await this.#resolveExecutedModel?.({
        digest: version.digest,
        repositoryVersion: version.repositoryVersion,
      });
    if (
      !executed ||
      canonical(executed.identity) !== canonical(this.#model.identity) ||
      executed.version.digest !== version.digest ||
      executed.version.repositoryVersion !== version.repositoryVersion
    ) return false;
    // Every reference belongs to the decision's original pin. Current policy
    // still governs recall/review; an old executed model grants no authority.
    const exactExecution = (message: typeof decision) =>
      message?.execution?.digest === version.digest &&
      message.execution.repositoryVersion === version.repositoryVersion;
    const reference = (value: string, outcome = false) => {
      if (!value.startsWith("message:")) return false;
      const message = messages.find((entry) =>
        entry.id === value.slice("message:".length)
      );
      return exactExecution(message) && (!outcome ||
        message?.role === "tool" && !!message.execution?.actionId &&
          !!message.observation);
    };
    // Reject a handle which changed during the historical lineage read.
    if (canonical(this.snapshotForCaller(callerId)) !== canonical(snapshot)) {
      return false;
    }
    return (decision?.role === "assistant" && !!decision.execution?.actionId &&
      exactExecution(decision) &&
      content.origin.sourceRefs.every((value) => reference(value)) &&
      (content.outcome.status === "pending" ||
        content.outcome.evidenceRefs.every((value) => reference(value, true))));
  }
}
