import {
  type ObservationInvocationPort,
  readOnlyObservation,
} from "./observation.ts";
import type { ModelPort, StorePort } from "../runtime/ports.ts";
import {
  type OperatorWorkCompletion,
  operatorWorkFingerprint,
  workReceipt,
} from "../operators/journal.ts";
import { toolDraftDigest } from "../artifacts/catalog.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  executionDigest,
  isSha256Hex,
} from "../../../domain/primitives/execution-digest.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  BehaviorInvocationRequest,
  BehaviorInvocationResult,
} from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  NativeBehaviorContract,
} from "../../../domain/model/execution/native-contracts.ts";
import type { BehaviorModelVersion } from "../../../domain/shared-kernel/behavior-model-version.ts";
import type { WorkResultObservation } from "../../../domain/work/policies/verified-effect-closure.ts";

/** A scoped durable read; copied receipts never establish publication. */
export class WorkArtifactObservationBehavior
  implements ObservationInvocationPort {
  readonly [readOnlyObservation] = true;
  constructor(
    readonly options: {
      targets: ReadonlyMap<string, string>;
      workTargets: ReadonlyMap<string, string>;
      resolveCallerModel(
        callerId: string,
        version: BehaviorModelVersion,
      ): Promise<ExecutableModel | null>;
      target(
        operatorId: string,
      ): { store: Pick<StorePort, "load">; model: ModelPort } | undefined;
    },
  ) {}

  async supports(
    behavior: NativeBehaviorContract,
    version: BehaviorModelVersion,
  ): Promise<boolean> {
    const owner = this.options.targets.get(behavior.targetNativeId);
    if (!owner || !this.options.target(owner)) return false;
    const schema = behavior.inputSchema;
    const keys = [
      "workInvocationId",
      "workBehaviorId",
      "workInputDigest",
      "artifactName",
    ];
    const properties = schema.properties as
      | Record<string, { type?: unknown }>
      | undefined;
    if (
      schema.type !== "object" || schema.additionalProperties !== false ||
      !properties ||
      canonical(Object.keys(properties).sort()) !==
        canonical([...keys].sort()) ||
      !keys.every((key) => properties[key]?.type === "string") ||
      !Array.isArray(schema.required) ||
      canonical([...schema.required].sort()) !== canonical([...keys].sort())
    ) return false;
    const model = await this.options.resolveCallerModel(
      behavior.callerNativeId,
      version,
    );
    return !!model && model.identity.builderId === behavior.callerNativeId &&
      model.version.digest === version.digest &&
      (model.behaviors ?? []).some((entry) =>
        canonical(entry) === canonical(behavior)
      );
  }

  async invoke(
    request: BehaviorInvocationRequest,
  ): Promise<BehaviorInvocationResult> {
    const call = structuredClone(request);
    if (
      call.callerId !== call.behavior.callerNativeId || !call.invocationId ||
      !await this.supports(call.behavior, call.modelVersion)
    ) throw new Error("Work artifact observation is not admitted");
    const keys = [
      "workInvocationId",
      "workBehaviorId",
      "workInputDigest",
      "artifactName",
    ];
    if (
      Object.keys(call.input).length !== 4 ||
      !keys.every((key) =>
        typeof call.input[key] === "string" &&
        (call.input[key] as string).trim() &&
        (call.input[key] as string).length <= 2048
      )
    ) throw new Error("Invalid work artifact query");
    const workInvocationId = call.input.workInvocationId as string;
    const workBehaviorId = call.input.workBehaviorId as string;
    const workInputDigest = call.input.workInputDigest as string;
    const result: WorkResultObservation = {
      callerId: call.callerId,
      workInvocationId,
      workBehaviorId,
      workInputDigest,
      modelVersion: call.modelVersion,
      available: false,
      values: {},
    };
    const envelope = () => ({
      behaviorId: call.behavior.id,
      invocationId: call.invocationId,
      targetNativeId: call.behavior.targetNativeId,
      modelVersion: call.modelVersion,
      result,
    });
    try {
      const caller = await this.options.resolveCallerModel(
        call.callerId,
        call.modelVersion,
      );
      const work = caller?.behaviors?.find((entry) =>
        entry.id === workBehaviorId && entry.callerNativeId === call.callerId
      );
      const owner = this.options.targets.get(call.behavior.targetNativeId)!;
      if (
        !work || this.options.workTargets.get(work.targetNativeId) !== owner
      ) throw new Error("Work target is not correlated with this catalog");
      const target = this.options.target(owner)!;
      const state = await target.store.load();
      if (!state?.model || state.executionModel?.identity.builderId !== owner) {
        throw new Error("Durable target state unavailable");
      }
      const matches = state.messages.filter((message) => {
        const receipt = workReceipt(message);
        return receipt?.callerId === call.callerId &&
          receipt.invocationId === workInvocationId &&
          receipt.correlationId === workInvocationId;
      });
      if (matches.length !== 1) {
        throw new Error("Exact durable work contribution unavailable");
      }
      const message = matches[0]!;
      const receipt = workReceipt(message)!;
      const proof = {
        callerId: call.callerId,
        invocationId: workInvocationId,
        behavior: work,
        modelVersion: call.modelVersion,
      };
      // New journals retain the exact admitted input before inbox trimming.
      // Legacy journals can prove only the text which remains persisted.
      const persistedInputDigest = receipt.inputDigest;
      if (
        persistedInputDigest !== undefined &&
        !isSha256Hex(persistedInputDigest)
      ) {
        throw new Error("Durable work input digest is malformed");
      }
      const inputDigest = persistedInputDigest ??
        await executionDigest({ text: message.text });
      if (
        receipt.behaviorId !== workBehaviorId ||
        receipt.targetNativeId !== work.targetNativeId ||
        canonical(receipt.modelVersion) !== canonical(call.modelVersion) ||
        receipt.fingerprint !==
          operatorWorkFingerprint(
            owner,
            message.text,
            workInvocationId,
            proof,
          ) ||
        inputDigest !== workInputDigest
      ) throw new Error("Durable work proof does not match query");
      const completion = state.events.findLast((event) => {
        const record = (event as Partial<OperatorWorkCompletion>).work;
        return record?.callerId === call.callerId &&
          record.correlationId === workInvocationId &&
          record.fingerprint === receipt.fingerprint;
      }) as OperatorWorkCompletion | undefined;
      if (!completion || !Array.isArray(completion.work.candidateIds)) {
        throw new Error("Durable completion unavailable");
      }
      const native = await target.model.readExecutableModel(state.model);
      if (
        native.identity.builderId !== owner ||
        native.version.digest !== state.executionModel.version.digest ||
        !native.version.repositoryVersion
      ) throw new Error("Fresh native model is not durably admitted");
      const candidates = state.candidates.filter((candidate) =>
        completion.work.candidateIds.includes(candidate.id) &&
        candidate.name === call.input.artifactName
      );
      const values: Record<string, unknown> = {
        count: candidates.length,
        name: "",
        kind: "",
        localStatus: "",
        nativeStatus: "",
        storedDigest: "",
        actualDigest: "",
        nativeDigest: "",
        admittedDigest: "",
        admittedCandidateId: "",
        candidateId: "",
        testsPassed: false,
        nativeCount: 0,
        nativeName: "",
        nativeKind: "",
        nativeContractCount: 0,
        nativeContractKind: "",
        nativeId: "",
        bindingId: "",
      };
      if (candidates.length === 1) {
        const candidate = candidates[0]!;
        const entries = native.catalog.filter((entry) =>
          entry.candidateId === candidate.id
        );
        const entry = entries.length === 1 ? entries[0] : undefined;
        const contracts = entry
          ? native.contracts.filter((contract) =>
            contract.nativeId === entry.contractId
          )
          : [];
        Object.assign(values, {
          name: candidate.name,
          kind: candidate.kind,
          localStatus: candidate.stage,
          nativeStatus: entry?.status ?? "",
          storedDigest: candidate.digest,
          actualDigest: await toolDraftDigest(candidate),
          nativeDigest: entry?.digest ?? "",
          admittedDigest: candidate.admission?.candidateDigest ?? "",
          admittedCandidateId: candidate.admission?.candidateId ?? "",
          candidateId: candidate.id,
          testsPassed: candidate.tests?.passed === true,
          nativeCount: entries.length,
          nativeName: entry?.name ?? "",
          nativeKind: entry?.kind ?? "",
          nativeContractCount: contracts.length,
          nativeContractKind: contracts.length === 1 ? contracts[0]!.kind : "",
          nativeId: entry?.nativeId ?? "",
          bindingId: candidate.binding?.elementId ?? "",
        });
      }
      result.values = values;
      result.available = true;
      result.source = {
        id: state.model.catalogId,
        revision: canonical({
          stateRevision: state.revision,
          nativeDigest: native.version.digest,
          repositoryVersion: native.version.repositoryVersion,
        }),
      };
    } catch (error) {
      result.available = false;
      result.values = {};
      delete result.source;
      result.reason = error instanceof Error
        ? error.message
        : "Observation unavailable";
    }
    return envelope();
  }
}
