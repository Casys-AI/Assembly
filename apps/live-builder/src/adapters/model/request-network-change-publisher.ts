import { SourceModel, type SourceRepository } from "./sources/source-model.ts";
import type { ModelToolingPort } from "../../application/model/tooling.ts";
import type { ModelWriteSubmissionPort } from "../../application/model/publication/submission.ts";
import { buildModelWriteDossierV2 } from "../../application/model/publication/write-command-v2.ts";
import { assertRequestChangeDossier } from "../../application/model/publication/request-change.ts";
import { assertRequestNetworkChange } from "../../domain/governance/records/request-network-change.ts";
import {
  assertRequestTeamChange,
  requestChangeEffect,
} from "../../domain/governance/records/request-change.ts";
import {
  isCreationGrantRequestAuthority,
  type RequestWriteAuthority,
  requestWriteAuthorityDestination,
  requestWriteCreationScope,
} from "../../application/model/source-admission/request-delegated-authority.ts";
import { changePublication } from "../../domain/model/publication/change.ts";
import type { PendingChange } from "../../domain/governance/records/pending-change.ts";
import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";
import type { ModelRevision } from "../../domain/model/records/revision.ts";
import type { RequestModelWriteDestination } from "../../domain/model/editing/request-write-destination.ts";
import {
  type OpeningRecord,
  RequestSpaceError,
} from "../../domain/work/request-spaces.ts";
import { canonical } from "../../domain/primitives/canonical-json.ts";

/** Exact approved-change producer over the existing Request writer, with no Main HEAD/write surface. */
export class RequestNetworkChangePublisher {
  constructor(
    private readonly options: {
      repositoryId: string;
      projectId: string;
      tooling: ModelToolingPort;
      reader(): Promise<
        {
          readonly repositoryId: string;
          at(version: string): Promise<ModelRevision>;
        }
      >;
      writer: ModelWriteSubmissionPort;
      /** The verified whole-team size of a branch, for a person's team
       * decision (the creation-grant envelope carries its own). */
      branchTeamSize?(opening: OpeningRecord): Promise<number>;
    },
  ) {}
  resume(
    commandId: string,
    destination: RequestModelWriteDestination,
  ): Promise<ModelRevision | null> {
    return this.options.writer.resume(commandId, undefined, destination);
  }
  async publish(
    value: {
      opening: OpeningRecord;
      model: ExecutableModel;
      change: PendingChange;
      authority: RequestWriteAuthority;
    },
  ): Promise<ExecutableModel> {
    const { opening, model, change, authority } = structuredClone(value),
      target = requestWriteAuthorityDestination(authority);
    const effect = requestChangeEffect(change);
    if (effect === "team-member") assertRequestTeamChange(change);
    else assertRequestNetworkChange(change);
    const requester = authority.kind === "request-delegated-authority" ||
        authority.kind === "request-creation-grant"
      ? authority.requester
      : undefined;
    const member = requester &&
      model.identity.builderId !== opening.base?.requestOwner.operatorId;
    if (
      !opening.base || opening.executionSpaceId === "main" ||
      target.repositoryId !== this.options.repositoryId ||
      this.options.writer.repositoryId !== this.options.repositoryId ||
      target.caseId !== opening.caseId || target.openingId !== opening.id ||
      target.executionSpaceId !== opening.executionSpaceId ||
      target.branchId !== opening.branchId ||
      canonical(target.host) !== canonical(opening.scope) ||
      change.caseId !== opening.caseId ||
      change.requestedBy !== model.identity.builderId ||
      (requester
        ? requester.operatorId !== model.identity.builderId ||
          requester.projectId !== model.identity.projectId ||
          requester.systemId !== model.identity.systemId ||
          requester.executionSpaceId !== opening.executionSpaceId
        : change.requestedBy !== opening.base.requestOwner.operatorId) ||
      (member
          ? change.diff?.base.repositoryVersion
          : model.version.repositoryVersion) !==
        target.expectedAdmittedSource.source.version ||
      model.version.digest !== change.baseModelDigest
    ) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "The approved network publication differs from its exact Case target",
      );
    }
    const reader = await this.options.reader();
    if (reader.repositoryId !== this.options.repositoryId) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "The Case source repository changed",
      );
    }
    const forbidden = (): Promise<never> =>
      Promise.reject(
        new RequestSpaceError(
          "FORBIDDEN",
          "Main reads and direct writes are unavailable to the Case publisher",
        ),
      );
    const repository: SourceRepository = {
      current: forbidden,
      at: (version) => reader.at(version),
      initialize: forbidden,
      propose: forbidden,
      publishSystemSources: forbidden,
      updateSystemSources: forbidden,
      findPublication: forbidden,
    };
    const writer: ModelWriteSubmissionPort = {
      repositoryId: this.options.repositoryId,
      recipeDigest: () => this.options.writer.recipeDigest(),
      resume: (id, approval) =>
        this.options.writer.resume(id, approval, target),
      publish: async (dossier) => {
        if (
          dossier.v !== 1 || dossier.command.kind !== "approved-change" ||
          dossier.decision.kind !== "approved-change" ||
          dossier.operations.kind !== "host-edits"
        ) {
          throw new RequestSpaceError(
            "FORBIDDEN",
            "Only the exact Case approved network change can be published",
          );
        }
        const scoped = await buildModelWriteDossierV2({
          repositoryId: this.options.repositoryId,
          commandId: change.id,
          kind: "approved-change",
          operations: dossier.operations,
          decision: dossier.decision,
          recipeDigest: dossier.command.recipeDigest,
          destination: target,
          authority,
        });
        assertRequestChangeDossier(scoped);
        if (canonical(scoped.decision.change) !== canonical(change)) {
          throw new RequestSpaceError(
            "OPENING_CONFLICT",
            "The approved Case decision changed before publication",
          );
        }
        return await this.options.writer.publish(scoped);
      },
    };
    // A creation is read in the requester's branch (E1): the envelope's
    // scope for a grant, the destination's branch and the current verified
    // team size for the person's decision.
    let creationScope;
    if (effect === "team-member") {
      creationScope = requestWriteCreationScope(authority, target);
      if (!isCreationGrantRequestAuthority(authority)) {
        if (!this.options.branchTeamSize) {
          throw new RequestSpaceError(
            "UNAVAILABLE",
            "The branch team size is unavailable for this publication",
            {
              context: { changeId: change.id, caseId: opening.caseId },
              recovery: "Retry once the Request space binding is readable.",
            },
          );
        }
        creationScope = {
          ...creationScope!,
          branchTeamSize: await this.options.branchTeamSize(opening),
        };
      }
    }
    const source = new SourceModel({
      repository,
      projectId: this.options.projectId,
      systemQualifiedName: model.identity.systemQualifiedName,
      tooling: this.options.tooling,
      writer,
      ...(authority.kind === "request-delegated-authority"
        ? { recordedDelegation: { exercise: authority.exercise } }
        : {}),
      ...(creationScope ? { creationScope } : {}),
    });
    return await source.applyApprovedChange(
      model.identity,
      change,
      model.version.digest,
      changePublication(change, model.version),
    );
  }
}
