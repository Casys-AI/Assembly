import {
  assertRequestNetworkChange,
} from "../../domain/governance/records/request-network-change.ts";
import {
  assertRequestTeamChange,
  requestChangeEffect,
  requestChangeProposalDigest,
} from "../../domain/governance/records/request-change.ts";
import type { CreationScope } from "../../domain/governance/policies/operator-creation-policy.ts";
import type { PendingChange } from "../../domain/governance/records/pending-change.ts";
import type { PreparedChangeDiff } from "../../domain/governance/operator-authority.ts";
import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";
import type { ModelRevision } from "../../domain/model/records/revision.ts";
import { canonical } from "../../domain/primitives/canonical-json.ts";
import { modelSourceDigest } from "../../domain/model/value-objects/sources.ts";
import {
  type OpeningRecord,
  requestSpaceDigest,
  RequestSpaceError,
} from "../../domain/work/request-spaces.ts";
import type { SourceModel } from "../model/sources/source-model.ts";

interface PreparedRequestNetworkChange {
  readonly diff: PreparedChangeDiff;
  readonly changes: readonly {
    readonly path: string;
    readonly text: string | null;
  }[];
  readonly expectedVersion: string;
  readonly proposalIntentDigest: string;
}
export interface RequestNetworkChangePreparationPort {
  prepare(
    opening: OpeningRecord,
    executing: ExecutableModel,
    change: PendingChange,
    branchTeamSize?: number,
  ): Promise<PreparedRequestNetworkChange>;
}
/** Read/compile only. Publication requires the independent real human D1/D2 writer. */
export class RequestNetworkChangeSources
  implements RequestNetworkChangePreparationPort {
  constructor(
    private readonly options: {
      /** Verify the requester and its exact admitted runtime, BO or member,
       * before compiling the displayed branch diff. Never inferred from a
       * caller-supplied model or from the opening's BO alone. */
      assertExecuting(
        opening: OpeningRecord,
        model: ExecutableModel,
      ): Promise<void>;
      admittedInspection(
        opening: OpeningRecord,
        version: string,
      ): Promise<string>;
      reader(): Promise<
        {
          readonly repositoryId: string;
          at(version: string): Promise<ModelRevision>;
        }
      >;
      prepareApprovedChangeAt: (
        identity: Parameters<SourceModel["prepareApprovedChangeAt"]>[0],
        revision: Parameters<SourceModel["prepareApprovedChangeAt"]>[1],
        change: Parameters<SourceModel["prepareApprovedChangeAt"]>[2],
        digest: Parameters<SourceModel["prepareApprovedChangeAt"]>[3],
        creationScope?: CreationScope,
      ) => ReturnType<SourceModel["prepareApprovedChangeAt"]>;
    },
  ) {}
  async prepare(
    input: OpeningRecord,
    executing: ExecutableModel,
    value: PendingChange,
    branchTeamSize?: number,
  ): Promise<PreparedRequestNetworkChange> {
    const opening = structuredClone(input),
      model = structuredClone(executing),
      change = structuredClone(value);
    const effect = requestChangeEffect(change);
    if (effect === "team-member") assertRequestTeamChange(change);
    else assertRequestNetworkChange(change);
    const executingVersion = model.version.repositoryVersion;
    const member =
      model.identity.builderId !== opening.base?.requestOwner.operatorId;
    if (
      !opening.base || !opening.baseDigest ||
      await requestSpaceDigest(opening.base) !== opening.baseDigest ||
      opening.executionSpaceId === "main" ||
      !["admitted", "dispatched"].includes(opening.phase) ||
      change.caseId !== opening.caseId ||
      model.identity.builderId !== change.requestedBy ||
      change.baseModelDigest !== model.version.digest ||
      change.baseRevision !== model.configuration.revision ||
      !executingVersion ||
      !member && change.diff &&
        change.diff.base.repositoryVersion !== executingVersion
    ) {
      throw new RequestSpaceError(
        "OPENING_CONFLICT",
        "The exact Case network proposal or executing source changed",
      );
    }
    await this.options.assertExecuting(opening, model);
    // A member retains its own R while another operator can advance the shared
    // admitted A. The existing exact compiler must still find this unchanged
    // target digest at A. BO proposals retain their qualified A=R boundary.
    const admittedVersion = await this.options.admittedInspection(
      opening,
      executingVersion,
    );
    const version = member ? admittedVersion : executingVersion;
    if (!member && admittedVersion !== executingVersion) {
      throw new RequestSpaceError(
        "OPENING_CONFLICT",
        "Adopt the current admitted source before proposing a network change",
      );
    }
    if (change.diff && change.diff.base.repositoryVersion !== version) {
      throw new RequestSpaceError(
        "OPENING_CONFLICT",
        "The prepared Case source differs from its displayed network proposal",
      );
    }
    const reader = await this.options.reader();
    if (reader.repositoryId !== opening.base.manifest.source?.repositoryId) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "The Request belongs to another source repository",
      );
    }
    const revision = await reader.at(version);
    if (revision.version !== version) {
      throw new RequestSpaceError(
        "OPENING_CONFLICT",
        "The exact Case source is unavailable",
      );
    }
    if (effect === "team-member" && branchTeamSize === undefined) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The branch team size is unavailable for this preview",
        {
          context: { changeId: change.id, caseId: opening.caseId },
          recovery: "Retry once the Request space binding is readable.",
        },
      );
    }
    const prepared = await this.options.prepareApprovedChangeAt(
      model.identity,
      revision,
      change,
      model.version.digest,
      effect === "team-member"
        ? {
          space: {
            projectId: model.identity.projectId,
            systemId: model.identity.systemId,
            executionSpaceId: opening.executionSpaceId,
          },
          branchTeamSize: branchTeamSize!,
        }
        : undefined,
    );
    if (
      prepared.diff.base.repositoryVersion !== version ||
      prepared.diff.base.modelDigest !== model.version.digest ||
      prepared.diff.base.sourceDigest !==
        await modelSourceDigest(revision.sources) ||
      prepared.diff.sourceDigest !==
        await modelSourceDigest(prepared.sources) ||
      change.diff && canonical(change.diff) !== canonical(prepared.diff)
    ) {
      throw new RequestSpaceError(
        "OPENING_CONFLICT",
        "The prepared Case source differs from its displayed network proposal",
      );
    }
    const changes = [
      ...new Set([
        ...Object.keys(revision.sources),
        ...Object.keys(prepared.sources),
      ]),
    ].sort().filter((path) => revision.sources[path] !== prepared.sources[path])
      .map((path) => ({ path, text: prepared.sources[path] ?? null }));
    if (!changes.length) {
      throw new RequestSpaceError(
        "INVALID_COMMAND",
        "The network change must alter its exact Case source",
      );
    }
    return {
      diff: structuredClone(prepared.diff),
      changes,
      expectedVersion: version,
      proposalIntentDigest: await requestChangeProposalDigest({
        ...change,
        diff: prepared.diff,
      }),
    };
  }
}
