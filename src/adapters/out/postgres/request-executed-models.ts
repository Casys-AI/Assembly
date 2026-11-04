import { retainedMember } from "../../../domain/work/request-spaces.ts";
import { scopedOperator } from "../../../domain/governance/policies/delegation-scope.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { BehaviorModelVersion } from "../../../domain/shared-kernel/behavior-model-version.ts";
import type { RequestExecutionBinding } from "../../../application/model/evolution/request-adoption-ports.ts";
import { requestExecutionPinFor } from "../../../application/model/evolution/request-execution-pin.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";
import { RequestAdoptionError } from "../../../application/model/evolution/request-adoption-ports.ts";
import type { OpeningRecord } from "../../../domain/work/request-spaces.ts";
import type {
  OpeningSourcePort,
  OpeningStorePort,
} from "../../../application/work/request-spaces/ports.ts";
import type { PostgresHostStorage } from "./host-storage.ts";
import type { PostgresRuntimeScope } from "./scope.ts";
import type { PostgresRequestExecutionBindingReader } from "./request-execution-binding.ts";
import type { PostgresRequestSourceAdmissionStore } from "./request-source-admission-store.ts";
import type { GitModelRepositoryReader } from "../git/repository.ts";
import { validateSourceExecutables } from "../sysml-toolkit/compilation/source-executables.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { readScopedSoftwareSourceAdmissionProof } from "./scoped-software-source-publication-participant.ts";
import { decodeHistorical } from "./system-state-store.ts";
import type { ScopedSoftwareSourceAdmissionV2 } from "../../../application/model/source-admission/scoped-software-source-admission.ts";

function unavailable(): never {
  throw new RequestAdoptionError(
    "UNAVAILABLE",
    "The exact executed Request model is unavailable.",
  );
}
/** Exact executed lineage only. Source head/inspection alone never enrolls a
 * historical model as authority or creates a current executable binding. */
export class RequestExecutedModels {
  constructor(
    private readonly options: {
      storage: Pick<PostgresHostStorage, "client" | "scope">;
      openings: Pick<OpeningStorePort, "get">;
      source: Pick<OpeningSourcePort, "readModelsForInspection">;
      binding: PostgresRequestExecutionBindingReader;
      journal: PostgresRequestSourceAdmissionStore;
      reader(): Promise<
        Pick<
          GitModelRepositoryReader,
          "repositoryId" | "projectId" | "at" | "descriptorAt"
        > & {
          verifyScopedSoftwareSourceAdmission?(
            admission: ScopedSoftwareSourceAdmissionV2,
          ): Promise<void>;
        }
      >;
    },
  ) {}
  async #compiled(
    opening: OpeningRecord,
    version: string,
    load: () => Promise<{ revision: ModelRevision; projectId: string }>,
  ) {
    const key = canonical([
      opening.base!.manifest.source!.repositoryId,
      version,
    ]);
    let models = this.#pinModels.get(key);
    if (!models) {
      models = (async () => {
        const { revision, projectId } = await load();
        return (await validateSourceExecutables(revision, projectId)).map(
          (entry) => entry.model,
        );
      })();
      this.#pinModels.set(key, models);
      if (this.#pinModels.size > 16) {
        this.#pinModels.delete(this.#pinModels.keys().next().value!);
      }
      models.catch(() => {
        if (this.#pinModels.get(key) === models) this.#pinModels.delete(key);
      });
    }
    return await models;
  }
  /** An executed pin's lineage and compiled model are immutable: each pin of
   * an opening is proved once (a failure is not kept), and every caller still
   * compares its own expected model. */
  private async exact(
    opening: OpeningRecord,
    pin: BehaviorModelVersion,
    expected?: ExecutableModel,
    operatorId = expected?.identity.builderId ??
      opening.base!.requestOwner.operatorId,
  ): Promise<ExecutableModel> {
    const key = canonical([
      opening.id,
      opening.baseDigest,
      operatorId,
      pin.digest,
      pin.repositoryVersion,
    ]);
    let proved = this.#proofs.get(key);
    if (!proved) {
      proved = this.#prove(opening, pin, operatorId);
      this.#proofs.set(key, proved);
      if (this.#proofs.size > 16) {
        this.#proofs.delete(this.#proofs.keys().next().value!);
      }
      proved.catch(() => {
        if (this.#proofs.get(key) === proved) this.#proofs.delete(key);
      });
    }
    const model = await proved;
    if (expected && canonical(model) !== canonical(expected)) unavailable();
    return structuredClone(model);
  }
  readonly #proofs = new Map<string, Promise<ExecutableModel>>();
  async #prove(
    opening: OpeningRecord,
    pin: BehaviorModelVersion,
    operatorId: string,
  ): Promise<ExecutableModel> {
    const base = opening.base!;
    const retained = retainedMember(base, operatorId);
    const baseline = operatorId === base.requestOwner.operatorId
      ? base.manifest.operators.find((member) =>
        member.operatorId === operatorId
      )
      : retained;
    if (
      baseline?.modelDigest === pin.digest &&
      baseline.repositoryVersion === pin.repositoryVersion
    ) {
      const models = await this.options.source.readModelsForInspection(base),
        selected = models.filter((model) =>
          model.identity.builderId === operatorId &&
          model.version.digest === pin.digest &&
          model.version.repositoryVersion === pin.repositoryVersion
        );
      if (selected.length !== 1) unavailable();
      return structuredClone(selected[0]);
    }
    const reader = await this.options.reader(),
      revision = await reader.at(pin.repositoryVersion),
      build = await reader.descriptorAt(pin.repositoryVersion);
    const chain = await this.options.storage.client.$transaction(
      (tx) => this.options.journal.readAdmittedSource(tx, opening),
      { isolationLevel: "RepeatableRead" },
    );
    const adopted = chain.execution.adoptions.find((entry) =>
      entry.manifest.intent.target.operatorId === operatorId &&
      entry.manifest.intent.candidate.source.version ===
        pin.repositoryVersion &&
      entry.manifest.intent.candidate.model.version.digest === pin.digest
    );
    const birth = operatorId !== base.requestOwner.operatorId
      ? chain.execution.adoptions.find((entry) =>
        entry.manifest.intent.candidate.source.version ===
          pin.repositoryVersion &&
        entry.manifest.intent.team?.team.some((member) =>
          member.operatorId === operatorId && member.modelDigest === pin.digest
        )
      )
      : undefined;
    const software = chain.execution.softwareAdoptions.find((entry) => {
      const source = chain.softwareReceipts.find((item) =>
        item.revision === entry.manifest.sourceAdmission.revision &&
        item.manifestDigest === entry.manifest.sourceAdmission.manifestDigest
      );
      return source?.payload.result.source.version === pin.repositoryVersion &&
        source.payload.result.targets.some((target) =>
          target.operatorId === operatorId &&
          target.digest === pin.digest
        );
    });
    if (software) {
      const source = chain.softwareReceipts.find((item) =>
        item.revision === software.manifest.sourceAdmission.revision &&
        item.manifestDigest === software.manifest.sourceAdmission.manifestDigest
      );
      if (
        !source || !reader.verifyScopedSoftwareSourceAdmission ||
        reader.repositoryId !== base.manifest.source!.repositoryId ||
        reader.projectId !== `git:${reader.repositoryId}` ||
        revision.version !== pin.repositoryVersion ||
        await modelSourceDigest(revision.sources) !==
          source.payload.result.sourceDigest ||
        canonical(build) !== canonical(source.payload.result.build)
      ) unavailable();
      await reader.verifyScopedSoftwareSourceAdmission(source.payload);
      const recorded = await this.options.storage.client.$transaction(
        async (tx) => {
          await readScopedSoftwareSourceAdmissionProof(
            tx,
            this.options.storage.client,
            source,
          );
          const row = await tx.runtimeRevision.findFirst({
            where: {
              ...opening.scope,
              executionSpaceId: opening.executionSpaceId,
              operatorId,
              revision: BigInt(software.manifest.committedRuntimeRevision),
            },
          });
          if (!row) unavailable();
          return decodeHistorical(row);
        },
        { isolationLevel: "RepeatableRead" },
      );
      const target = source.payload.result.targets.find((item) =>
        item.operatorId === operatorId &&
        item.digest === pin.digest
      );
      const selected =
        (await this.#compiled(opening, pin.repositoryVersion, () =>
          Promise.resolve({ revision, projectId: reader.projectId }))).filter((
            model,
          ) =>
            model.identity.builderId === operatorId &&
            model.version.digest === pin.digest &&
            model.version.repositoryVersion === pin.repositoryVersion
          );
      if (
        !target || selected.length !== 1 ||
        canonical(selected[0].identity) !== canonical(target.identity) ||
        canonical(recorded.executionModel) !== canonical(selected[0]) ||
        recorded.events.filter((event) =>
            event.effectiveModelUpdate?.dossierId ===
              software.manifest.dossierId &&
            event.effectiveModelUpdate.caseId === opening.caseId &&
            event.effectiveModelUpdate.to.digest === pin.digest
          ).length !== 1
      ) {
        unavailable();
      }
      return structuredClone(selected[0]);
    }
    if (
      (!adopted && !birth) ||
      reader.repositoryId !== base.manifest.source!.repositoryId ||
      reader.projectId !== `git:${reader.repositoryId}` ||
      revision.version !== pin.repositoryVersion ||
      await modelSourceDigest(revision.sources) !==
        (adopted ?? birth)!.manifest.intent.candidate.sourceDigest ||
      canonical(build) !==
        canonical((adopted ?? birth)!.manifest.intent.candidate.build)
    ) unavailable();
    const models = await this.#compiled(
        opening,
        pin.repositoryVersion,
        () => Promise.resolve({ revision, projectId: reader.projectId }),
      ),
      selected = models.filter((model) =>
        model.identity.builderId === operatorId &&
        model.version.digest === pin.digest &&
        model.version.repositoryVersion === pin.repositoryVersion
      );
    if (
      selected.length !== 1 ||
      (adopted
        ? canonical(selected[0]) !==
          canonical(adopted.manifest.intent.candidate.model)
        : selected[0].identity.systemId !==
          birth!.manifest.intent.team!.childSystemId)
    ) unavailable();
    return structuredClone(selected[0]);
  }
  readonly current = async (
    opening: OpeningRecord,
    binding: RequestExecutionBinding,
  ): Promise<ExecutableModel> => {
    const model = await this.exact(opening, {
      digest: binding.pin.modelDigest,
      repositoryVersion: binding.pin.source.version,
    }, binding.state.executionModel);
    const requester =
      model.identity.builderId === opening.base!.requestOwner.operatorId
        ? undefined
        : scopedOperator({
          ...model.identity,
          executionSpaceId: opening.executionSpaceId,
        }, model.identity.builderId);
    const rechecked = await this.options.binding.read(opening, requester);
    if (
      canonical(rechecked.pin) !== canonical(binding.pin) ||
      rechecked.admission.revision !== binding.admission.revision
    ) unavailable();
    return model;
  };
  /** A member's first verified team adoption fixes its creation image. Later
   * rights adoptions change its execution pin, never this membership proof. */
  readonly creationModels = async (
    opening: OpeningRecord,
    operatorIds: readonly string[],
  ): Promise<ReadonlyMap<string, ExecutableModel>> => {
    if (!operatorIds.length) return new Map();
    const chain = await this.options.storage.client.$transaction(
      (tx) => this.options.journal.readAdmittedSource(tx, opening),
      { isolationLevel: "RepeatableRead" },
    );
    return new Map(
      await Promise.all(operatorIds.map(async (operatorId) => {
        const birth = chain.execution.adoptions.find((entry) =>
          entry.manifest.intent.team?.team.some((member) =>
            member.operatorId === operatorId
          )
        );
        const member = birth?.manifest.intent.team?.team.find((entry) =>
          entry.operatorId === operatorId
        );
        const retained = retainedMember(opening.base!, operatorId);
        if ((!birth || !member) && !retained) unavailable();
        const pin = retained
          ? {
            digest: retained.modelDigest,
            repositoryVersion: retained.repositoryVersion,
          }
          : {
            digest: member!.modelDigest,
            repositoryVersion: birth!.manifest.intent.candidate.source.version,
          };
        return [
          operatorId,
          await this.exact(
            opening,
            pin,
            undefined,
            operatorId,
          ),
        ] as const;
      })),
    );
  };
  /** Only admitted operators supply current team models. Inspection of the
   * complete source proves the BO but never enrolls another source operator;
   * each admitted member is proved at its own immutable or adopted pin. */
  readonly currentModels = async (
    opening: OpeningRecord,
    binding: RequestExecutionBinding,
  ): Promise<readonly ExecutableModel[]> => {
    const owner = await this.current(opening, binding);
    const base = opening.base!;
    if (owner.identity.builderId !== base.requestOwner.operatorId) {
      unavailable();
    }
    const pin = binding.pin;
    let models: ExecutableModel[];
    if (pin.source.version === base.manifest.source!.sourceVersion) {
      models = [...await this.options.source.readModelsForInspection(base)];
      if (
        !models.some((model) => canonical(model) === canonical(owner))
      ) unavailable();
    } else {
      models = await this.#compiled(opening, pin.source.version, async () => {
        const reader = await this.options.reader();
        if (
          reader.repositoryId !== base.manifest.source!.repositoryId ||
          reader.projectId !== `git:${reader.repositoryId}`
        ) unavailable();
        const revision = await reader.at(pin.source.version);
        return { revision, projectId: reader.projectId };
      });
      if (
        models.filter((model) => canonical(model) === canonical(owner))
          .length !==
          1
      ) unavailable();
    }
    const memberIds = binding.admission.permissions.operatorIds.filter((id) =>
      id !== base.requestOwner.operatorId
    );
    if (!memberIds.length) return [structuredClone(owner)];
    const chain = await this.options.storage.client.$transaction(
      (tx) => this.options.journal.readAdmittedSource(tx, opening),
      { isolationLevel: "RepeatableRead" },
    );
    const selected = new Map([[owner.identity.builderId, owner]]);
    for (const operatorId of memberIds) {
      const memberPin = requestExecutionPinFor(
        chain.execution,
        operatorId,
        opening.base!,
      );
      const model = await this.exact(
        opening,
        {
          digest: memberPin.modelDigest,
          repositoryVersion: memberPin.source.version,
        },
        undefined,
        operatorId,
      );
      if (
        binding.admission.permissions
          .modelDigests[
            binding.admission.permissions.operatorIds.indexOf(operatorId)
          ] !== model.version.digest
      ) unavailable();
      selected.set(operatorId, model);
    }
    return structuredClone([...selected.values()]);
  };
  readonly #pinModels = new Map<string, Promise<ExecutableModel[]>>();
  readonly historical = async (
    scope: PostgresRuntimeScope,
    version: BehaviorModelVersion,
  ): Promise<ExecutableModel | null> => {
    if (
      scope.projectId !== this.options.storage.scope.projectId ||
      scope.systemId !== this.options.storage.scope.systemId ||
      scope.executionSpaceId === "main"
    ) unavailable();
    const row = await this.options.storage.client.spaceOpening.findUnique({
      where: {
        projectId_systemId_executionSpaceId: {
          projectId: scope.projectId,
          systemId: scope.systemId,
          executionSpaceId: scope.executionSpaceId,
        },
      },
    });
    if (!row) unavailable();
    const opening = await this.options.openings.get(row.id);
    if (
      !opening?.base
    ) unavailable();
    const binding = await this.options.storage.client.$transaction(
      (tx) =>
        this.options.binding.readOperatorInTransaction(
          tx,
          opening,
          scope.operatorId,
        ),
      { isolationLevel: "RepeatableRead" },
    );
    if (!binding.admission.permissions.operatorIds.includes(scope.operatorId)) {
      unavailable();
    }
    return await this.exact(opening, version, undefined, scope.operatorId);
  };
}
