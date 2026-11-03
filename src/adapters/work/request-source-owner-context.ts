import type {
  RequestExecutionBinding,
  RequestExecutionBindingPort,
} from "../../application/model/evolution/request-adoption-ports.ts";
import type { SystemRuntimeState } from "../../domain/work/dialogue.ts";
import type { RequestSourceOwnerContextPort } from "../../application/model/source-admission/owner-authorization.ts";
import { assertRequestSpaceBirth } from "../../application/work/runtime/initialization.ts";
import type { OpeningStorePort } from "../../application/work/request-spaces/ports.ts";
import {
  parseRequestSourceOwnerPhaseBinding,
  type RequestSourceOwnerContext,
  RequestSourceOwnerError,
  type RequestSourceOwnerPhaseBinding,
} from "../../application/model/source-admission/request-source-owner.ts";
import { parseRequestModelWriteDestination } from "../../domain/model/editing/request-write-destination.ts";
import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";
import type { ScopedOperatorRef } from "../../domain/governance/authority.ts";
import type { ModelRevision } from "../../domain/model/records/revision.ts";
import { modelSourceDigest } from "../../domain/model/value-objects/sources.ts";
import { canonical } from "../../domain/primitives/canonical-json.ts";
import { isOpenCase } from "../../domain/work/entities/cases.ts";
import {
  assertBaseForChoice,
  assertOpeningBase,
  type OpeningRecord,
  requestSpaceDigest,
  type SpaceController,
} from "../../domain/work/request-spaces.ts";
import type { PostgresHostStorage } from "../out/postgres/host-storage.ts";
import type { AdmittedSourceChain } from "../out/postgres/request-source-admission-store.ts";
import type { GitModelRepositoryReader } from "../out/git/repository.ts";
import { validateSourceExecutables } from "../model/sources/source-model.ts";
import { RequestSpaceModel } from "../../application/work/request-spaces/request-space-model.ts";
import { requestSpaceSeed } from "./request-space-runtime.ts";

type Storage = Pick<PostgresHostStorage, "scope" | "readCaseRuntimeState"> & {
  readonly client: {
    readonly executionSpace: Pick<
      PostgresHostStorage["client"]["executionSpace"],
      "findUnique"
    >;
    readonly sourceRepository: Pick<
      PostgresHostStorage["client"]["sourceRepository"],
      "findUnique"
    >;
  };
};
interface SourceContextSnapshot {
  binding: RequestExecutionBinding;
  ownerState: SystemRuntimeState;
  chain: AdmittedSourceChain;
}
export interface RequestSourceOwnerContextOptions {
  readonly storage: Storage;
  readonly openings: Pick<OpeningStorePort, "forCase">;
  readonly repositoryId: string;
  readonly sourceProjectId: string;
  /** Host composes one coherent read-only D2 snapshot. No Git/source I/O may
   * occur within that SQL transaction; its verified chain is not a grant. */
  readonly executionBindings?: RequestExecutionBindingPort & {
    readSourceContext(
      opening: OpeningRecord,
      requester: ScopedOperatorRef,
    ): Promise<SourceContextSnapshot>;
  };
  readonly readAdmittedSource: (
    opening: OpeningRecord,
  ) => Promise<AdmittedSourceChain>;
  readonly reader: () => Promise<
    Pick<
      GitModelRepositoryReader,
      "repositoryId" | "projectId" | "at" | "descriptorAt"
    >
  >;
}
function refuse(reason: string): never {
  throw new RequestSourceOwnerError(reason);
}
function openingIdentity(record: OpeningRecord): string {
  return canonical({
    id: record.id,
    ownerId: record.ownerId,
    scope: record.scope,
    caseId: record.caseId,
    executionSpaceId: record.executionSpaceId,
    branchId: record.branchId,
    phase: record.phase,
    admissionId: record.admissionId ?? null,
    seed: requestSpaceSeed(record),
    base: record.base,
    baseDigest: record.baseDigest,
    command: record.command,
    commandDigest: record.commandDigest,
  });
}

/** New-effect source context only. Reads no inspected I or raw branch HEAD,
 * opens no stores and never initializes/adopts/mutates B0, R0 or admission.
 * Current channel, prior RootGrant/native semantic validation, SQL locks and
 * Git CAS remain independent mandatory boundaries in D1/D3. */
export class RequestSourceOwnerContexts
  implements RequestSourceOwnerContextPort {
  private readonly host: PostgresHostStorage["scope"];
  private readonly repositoryId: string;
  private readonly sourceProjectId: string;
  constructor(private readonly options: RequestSourceOwnerContextOptions) {
    this.host = structuredClone(options.storage.scope);
    this.repositoryId = options.repositoryId;
    this.sourceProjectId = options.sourceProjectId;
    if (this.sourceProjectId !== `git:${this.repositoryId}`) {
      refuse("source-repository-namespace-differs");
    }
  }

  /** Existing native validation owns compilation and its immutable source
   * cache. Tests may substitute controlled compiler output, never a grant. */
  protected async compile(
    revision: ModelRevision,
  ): Promise<readonly ExecutableModel[]> {
    return (await validateSourceExecutables(revision, this.sourceProjectId))
      .map((entry) => entry.model);
  }

  /** `controller` null: the host's own delegated write (4.8c), owned by no
   * session; every other source and opening check is the same. */
  private async current(
    caseId: string,
    controller: SpaceController | null,
    requester?: ScopedOperatorRef,
  ) {
    if (
      canonical(this.options.storage.scope) !== canonical(this.host) ||
      !!controller &&
        canonical(controller.authority.scope) !== canonical(this.host)
    ) refuse("host-scope-differs");
    const record = structuredClone(await this.options.openings.forCase(caseId));
    if (
      !record?.base || !record.baseDigest || record.caseId !== caseId ||
      !!controller && record.ownerId !== controller.ownerId ||
      canonical(record.scope) !== canonical(this.host) ||
      record.executionSpaceId === "main" ||
      !["runtime-ready", "admitted", "dispatched"].includes(record.phase)
    ) refuse("owned-initialized-request-required");
    const base = record.base;
    assertOpeningBase(base);
    assertBaseForChoice(base, record.command.source);
    if (
      base.manifest.origin.projectId !== this.host.projectId ||
      base.manifest.origin.systemId !== this.host.systemId ||
      base.manifest.source?.repositoryId !== this.repositoryId ||
      await requestSpaceDigest(base) !== record.baseDigest ||
      await requestSpaceDigest(base.manifest) !== base.manifestDigest ||
      await requestSpaceDigest({
          scope: record.scope,
          ownerId: record.ownerId,
          command: record.command,
        }) !== record.commandDigest
    ) refuse("opening-birth-integrity-differs");
    const space = await this.options.storage.client.executionSpace.findUnique({
      where: {
        projectId_systemId_executionSpaceId: {
          ...this.host,
          executionSpaceId: record.executionSpaceId,
        },
      },
    });
    if (
      !space || space.caseId !== record.caseId ||
      space.parentExecutionSpaceId !== "main" ||
      space.lifecycle !== "active" || space.closedAt !== null
    ) refuse("active-request-required");
    // This is the existing pure retained-state/history reader, never caseSpace()
    // or operator(), whose provisioning paths could create stores.
    const preAdmission = record.phase === "runtime-ready" &&
      !record.admissionId;
    if (!preAdmission && !this.options.executionBindings) {
      refuse("execution-binding-unavailable");
    }
    const admittedMember = !preAdmission && !!requester &&
      requester.operatorId !== base.requestOwner.operatorId;
    let memberSnapshot: SourceContextSnapshot | undefined;
    if (admittedMember) {
      memberSnapshot = await this.options.executionBindings!.readSourceContext(
        record,
        requester,
      );
    }
    const executionBinding = admittedMember
      ? memberSnapshot!.binding
      : preAdmission
      ? undefined
      : await this.options.executionBindings!.read(record, requester);
    const state = executionBinding?.state ??
      await this.options.storage.readCaseRuntimeState(
        record.executionSpaceId,
        record.caseId,
        base.requestOwner.operatorId,
      );
    const runtime = state?.executionModel;
    if (!state || !runtime) refuse("request-runtime-birth-unavailable");
    if (
      requester && (
        preAdmission ||
        requester.executionSpaceId !== record.executionSpaceId ||
        requester.operatorId !== runtime.identity.builderId ||
        requester.projectId !== runtime.identity.projectId ||
        requester.systemId !== runtime.identity.systemId
      )
    ) refuse("requester-execution-target-differs");
    new RequestSpaceModel({
      base,
      model: runtime,
      ...(requester && requester.operatorId !== base.requestOwner.operatorId
        ? {
          teamPin: {
            modelDigest: executionBinding!.pin.modelDigest,
            repositoryVersion: executionBinding!.pin.source.version,
          },
        }
        : executionBinding
        ? { executionPin: executionBinding.pin }
        : {}),
    });
    if (!executionBinding) {
      assertRequestSpaceBirth(state, requestSpaceSeed(record), runtime);
    }
    const ownerState = admittedMember ? memberSnapshot!.ownerState : state;
    if (
      !ownerState.cases?.some((entry) =>
        entry.id === record.caseId && isOpenCase(entry)
      )
    ) refuse("open-request-required");
    const repository = await this.options.storage.client.sourceRepository
      .findUnique({
        where: {
          projectId_systemId_repositoryId: {
            ...this.host,
            repositoryId: this.repositoryId,
          },
        },
      });
    // PostgresHostStorage registers sourceScopeId === host systemId. No caller
    // or native model ID may override that production visibility boundary.
    if (!repository || repository.sourceScopeId !== this.host.systemId) {
      refuse("source-repository-unavailable");
    }
    const chain = admittedMember
      ? structuredClone(memberSnapshot!.chain)
      : structuredClone(
        await this.options.readAdmittedSource(structuredClone(record)),
      );
    if (
      preAdmission && (
        chain.execution.adoptions.length !== 0 ||
        chain.execution.softwareAdoptions.length !== 0 ||
        chain.execution.pin.adoption !== null ||
        chain.execution.pin.source.version !==
          base.manifest.source!.sourceVersion ||
        chain.execution.pin.modelDigest !== runtime.version.digest ||
        state.events.some((event) =>
          event.kind === "model-version-admission-authorized" ||
          event.kind === "model-version-admitted" ||
          !!event.modelAdoptionAuthorization || !!event.effectiveModelUpdate
        )
      )
    ) refuse("pre-admission-adoption-evidence");
    const baseline = {
      revision: 1,
      manifestDigest: base.manifestDigest,
      source: {
        repositoryId: this.repositoryId,
        version: base.manifest.source!.sourceVersion,
      },
      sourceDigest: base.manifest.source!.sourceDigest,
    };
    if (canonical(chain.baseline) !== canonical(baseline)) {
      refuse("admitted-baseline-differs");
    }
    const lastHuman = chain.receipts.at(-1),
      lastSoftware = chain.softwareReceipts.at(-1);
    const softwareLatest =
      lastSoftware && (!lastHuman || lastSoftware.revision > lastHuman.revision)
        ? lastSoftware
        : undefined;
    const last = softwareLatest ?? lastHuman;
    const expectedHead = last
      ? {
        revision: last.revision,
        manifestDigest: last.manifestDigest,
        source: last.payload.result.source,
        sourceDigest: last.payload.result.sourceDigest,
      }
      : baseline;
    if (
      canonical(chain.head) !== canonical(expectedHead) ||
      chain.head.source.repositoryId !== this.repositoryId
    ) refuse("admitted-source-head-differs");
    const selected = base.manifest.operators.filter((entry) =>
      entry.operatorId === base.requestOwner.operatorId
    );
    if (selected.length !== 1) refuse("unique-request-owner-required");
    // R0 supplies identity only at D2's initial baseline. A0 version/digest/head
    // always come from D2; an advanced source never resolves from execution R0.
    const targetOperatorId = requester?.operatorId ??
      base.requestOwner.operatorId;
    const targetResults = [
      ...chain.receipts.flatMap((receipt) =>
        receipt.payload.result.model.identity.builderId === targetOperatorId
          ? [{
            revision: receipt.revision,
            model: receipt.payload.result.model,
          }]
          : []
      ),
      ...chain.softwareReceipts.flatMap((receipt) =>
        receipt.payload.result.targets.filter((target) =>
          target.operatorId === targetOperatorId
        ).map((target) => ({ revision: receipt.revision, model: target }))
      ),
    ].sort((a, b) => b.revision - a.revision);
    const expectedModel = targetResults[0]?.model ?? {
      identity: runtime.identity,
      digest: requester ? runtime.version.digest : selected[0].modelDigest,
    };
    const build = last?.payload.result.build ?? selected[0].build;
    if (
      !build || build.repositoryId !== this.repositoryId ||
      build.sourceDigest !== chain.head.sourceDigest ||
      expectedModel.identity.builderId !== targetOperatorId ||
      requester &&
        canonical(expectedModel.identity) !== canonical(runtime.identity)
    ) refuse("admitted-source-model-unavailable");
    const destination = parseRequestModelWriteDestination({
      v: 1,
      kind: "request",
      repositoryId: this.repositoryId,
      host: this.host,
      openingId: record.id,
      caseId: record.caseId,
      executionSpaceId: record.executionSpaceId,
      branchId: record.branchId,
      ref: `refs/heads/requests/${record.branchId}`,
      expectedAdmittedSource: {
        revision: chain.head.revision,
        source: chain.head.source,
        sourceDigest: chain.head.sourceDigest,
      },
    });
    return {
      record,
      destination,
      expectedModel,
      build,
      head: chain.head,
      targetOperatorId,
    };
  }

  async resolve(
    caseId: string,
    inputController: SpaceController,
  ): Promise<RequestSourceOwnerContext> {
    return await this.#resolve(caseId, structuredClone(inputController));
  }
  /** Host-internal: the same exact source context for a delegated decision of
   * the Main Operator, which no session owns. Never reached from a person. */
  async resolveForHost(
    caseId: string,
    requester?: ScopedOperatorRef,
  ): Promise<RequestSourceOwnerContext> {
    return await this.#resolve(caseId, null, structuredClone(requester));
  }
  async #resolve(
    caseId: string,
    controller: SpaceController | null,
    requester?: ScopedOperatorRef,
  ): Promise<RequestSourceOwnerContext> {
    const before = await this.current(caseId, controller, requester);
    const reader = await this.options.reader();
    if (
      reader.repositoryId !== this.repositoryId ||
      reader.projectId !== this.sourceProjectId
    ) refuse("exact-reader-host-differs");
    const version = before.head.source.version;
    const revision = await reader.at(version);
    if (
      revision.version !== version ||
      revision.sourceDigest !== before.head.sourceDigest ||
      await modelSourceDigest(revision.sources) !== before.head.sourceDigest
    ) refuse("exact-admitted-source-differs");
    const descriptor = await reader.descriptorAt(version);
    if (canonical(descriptor) !== canonical(before.build)) {
      refuse("exact-admitted-build-differs");
    }
    const models = await this.compile(revision);
    const selected = models.filter((model) =>
      model.identity.builderId === before.targetOperatorId
    );
    if (selected.length !== 1) refuse("unique-admitted-native-owner-required");
    const model = structuredClone(selected[0]);
    if (
      canonical(model.identity) !== canonical(before.expectedModel.identity) ||
      model.identity.projectId !== this.sourceProjectId ||
      model.version.digest !== before.expectedModel.digest ||
      model.version.repositoryVersion !== version
    ) refuse("admitted-native-model-differs");
    const after = await this.current(caseId, controller, requester);
    if (
      openingIdentity(before.record) !== openingIdentity(after.record) ||
      canonical(before.destination) !== canonical(after.destination) ||
      canonical(before.expectedModel) !== canonical(after.expectedModel) ||
      canonical(before.build) !== canonical(after.build)
    ) refuse("request-source-changed-during-read");
    return structuredClone({
      destination: before.destination,
      openingOwnerId: before.record.ownerId,
      targetOperatorId: before.targetOperatorId,
      priorModel: {
        identity: model.identity,
        version: model.version,
        ...(model.ownerAuthority
          ? { ownerAuthority: model.ownerAuthority }
          : {}),
      },
    });
  }

  /** Metadata recheck, not a model/authority cache. D1 obtained and checked the
   * native prior owner independently; final publication still needs SQL + Git. */
  async assertCurrent(input: RequestSourceOwnerPhaseBinding): Promise<void> {
    const binding = parseRequestSourceOwnerPhaseBinding(input, input.phase);
    const fresh = await this.current(
      binding.destination.caseId,
      binding.principal.controller,
    );
    if (
      canonical(binding.destination) !== canonical(fresh.destination) ||
      canonical(binding.priorModel.identity) !==
        canonical(fresh.expectedModel.identity) ||
      binding.priorModel.version.digest !== fresh.expectedModel.digest ||
      binding.priorModel.version.repositoryVersion !== fresh.head.source.version
    ) refuse("captured-source-context-is-stale");
  }
}
