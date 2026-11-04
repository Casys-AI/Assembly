import type { RequestReleaseProvenancePort } from "../saved-systems/request-release-ports.ts";
import type {
  OpeningSourcePort,
  OpeningStorePort,
  RequestBranchPort,
} from "./ports.ts";
import { assertRequestSpaceBirth } from "../runtime/initialization.ts";
import type { QueuedArtifactSourcePublication } from "../../../domain/work/artifacts/source-publication.ts";
import { isOpenCase } from "../../../domain/work/entities/cases.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { assertBaseForChoice } from "../../../domain/work/request-spaces/opening.ts";
import {
  requestSpaceDigest,
  RequestSpaceError,
} from "../../../domain/work/request-spaces/scope.ts";
import type { ResolvedOperatorScope } from "../native-execution/contract.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import { RequestSpaceModel } from "./request-space-model.ts";
import { SkillsBehavior } from "../../skills/behavior.ts";
import {
  assertRequestInitialSkillPublication,
  type RequestBundledSkillReader,
  type RequestInitialSkillPublicationContext,
} from "../../skills/request-initial-skills.ts";
import { requestSpaceSeed } from "../runtime/initialization.ts";

export interface RequestInitialSkillRuntimeReader {
  readonly scope: { projectId: string; systemId: string };
  resolve(executionSpaceId: string): Promise<
    Pick<ResolvedOperatorScope, "executionSpaceId" | "caseId"> | null
  >;
  readState(scope: {
    projectId: string;
    systemId: string;
    executionSpaceId: string;
    operatorId: string;
  }): Promise<SystemRuntimeState | null>;
}

interface RequestInitialSkillAuthorityOptions {
  runtime: RequestInitialSkillRuntimeReader;
  openings: OpeningStorePort;
  source: OpeningSourcePort;
  branches: RequestBranchPort;
  readBundledSkill: RequestBundledSkillReader;
  sourceProvenance?: Pick<RequestReleaseProvenancePort, "assertOriginRelation">;
}
function refused(): never {
  throw new RequestSpaceError(
    "FORBIDDEN",
    "The durable Request initial skill publication authority is unavailable",
  );
}

/** Source-writer verifier: read-only durable discovery, independent of factory
 * handles. In particular it must not wait for a handle whose seed retention is
 * currently awaiting the source writer, or enter a canonical store JS queue. */
export class RequestInitialSkillAuthority {
  constructor(private readonly options: RequestInitialSkillAuthorityOptions) {}

  async #context(
    executionSpaceId: string,
    operatorId: string,
  ): Promise<RequestInitialSkillPublicationContext> {
    const host = this.options.runtime.scope;
    const scope = await this.options.runtime.resolve(executionSpaceId);
    if (!scope?.caseId) refused();
    const record = await this.options.openings.forCase(scope.caseId);
    if (
      !record?.base || !record.baseDigest ||
      record.scope.projectId !== host.projectId ||
      record.scope.systemId !== host.systemId ||
      record.executionSpaceId !== scope.executionSpaceId ||
      record.caseId !== scope.caseId ||
      !["branch-ready", "runtime-ready", "admitted", "dispatched"].includes(
        record.phase,
      ) ||
      record.base.requestOwner.operatorId !== operatorId
    ) refused();
    assertBaseForChoice(record.base, record.command.source);
    if (
      record.base.manifest.origin.projectId !== host.projectId ||
      record.base.manifest.origin.systemId !== host.systemId ||
      await requestSpaceDigest(record.base) !== record.baseDigest ||
      await requestSpaceDigest(record.base.manifest) !==
        record.base.manifestDigest ||
      await requestSpaceDigest({
          scope: record.scope,
          ownerId: record.ownerId,
          command: record.command,
        }) !== record.commandDigest
    ) refused();
    await this.options.branches.assertVersion(
      record,
      record.base.manifest.source!.sourceVersion,
    );
    if (
      record.base.manifest.origin.executionSpaceId !== "main" &&
      !this.options.sourceProvenance
    ) refused();
    // Relation/visibility is fresh here. The following verified read retains
    // full physical ancestor inspection; do not duplicate it in this callback.
    await this.options.sourceProvenance?.assertOriginRelation(
      record.base.manifest,
    );
    // The verified read checks this exact base, host and assets afresh while
    // returning the models from that same traversal; no second verification.
    const models = await this.options.source.readModels(record.base);
    const matching = models.filter((model) =>
      model.identity.builderId === operatorId
    );
    if (matching.length !== 1) refused();
    const model = structuredClone(matching[0]);
    // Reuse the exact retained model/pin/native identity validation. This
    // read-only view performs no model or runtime initialization.
    new RequestSpaceModel({ base: record.base, model });
    const runtimeScope = { ...host, executionSpaceId, operatorId };
    // Never storage.caseSpace().operator() or state.load(): either can enter
    // registration/store queues while the source writer owns its SQL claim.
    const state = await this.options.runtime.readState(runtimeScope);
    if (!state) refused();
    const birth = requestSpaceSeed(record);
    assertRequestSpaceBirth(state, birth, model);
    if (
      !state.cases?.some((entry) =>
        entry.id === birth.caseId && isOpenCase(entry)
      )
    ) refused();
    return {
      scope: runtimeScope,
      birth,
      state,
      model,
      source: {
        repositoryId: record.base.manifest.source!.repositoryId,
        projectId: model.identity.projectId,
        version: record.base.manifest.source!.sourceVersion,
        sourceDigest: record.base.manifest.source!.sourceDigest,
      },
    };
  }

  readonly assertArtifactSourcePublication = async (
    publication: QueuedArtifactSourcePublication,
  ): Promise<void> => {
    const target = publication.target;
    const host = this.options.runtime.scope;
    if (
      target.projectId !== host.projectId ||
      target.systemId !== host.systemId ||
      target.executionSpaceId === "main" || !target.executionSpaceId ||
      !target.operatorId || target.ownerId !== target.operatorId ||
      publication.source.kind !== "skill-document" ||
      publication.proof.kind !== "skill-authority"
    ) refused();
    const context = await this.#context(
      target.executionSpaceId,
      target.operatorId,
    );
    const model = context.model;
    const skills = new SkillsBehavior({
      entries: new Map(
        (model.operatorEntries ?? []).map((
          entry,
        ) => [entry.id, {
          ownerId: model.identity.builderId,
          kind: entry.kind,
        }]),
      ),
      resolveCallerModel: async (callerId, version) => {
        if (
          callerId !== target.operatorId ||
          version.digest !== model.version.digest ||
          version.repositoryVersion !== model.version.repositoryVersion
        ) return null;
        const current = await this.#context(
          target.executionSpaceId,
          target.operatorId,
        );
        return canonical(current.model) === canonical(model)
          ? current.model
          : null;
      },
      skills() {
        throw new RequestSpaceError(
          "FORBIDDEN",
          "Publication verification cannot open or initialize a skill service",
        );
      },
    });
    await assertRequestInitialSkillPublication(publication, context, {
      readBundledSkill: this.options.readBundledSkill,
      assertCurrentAuthority: (authority, permission) =>
        skills.assertCurrentAuthority(authority, permission),
    });
  };
}
