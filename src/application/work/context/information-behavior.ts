import { isSha256Hex } from "../../../domain/primitives/execution-digest.ts";
import { Ajv } from "ajv";
import {
  type BehaviorInvocationPort,
  matchesNativeInputSchema,
} from "../behaviors/invocation.ts";
import { readDecisionContextEvidence } from "./separation.ts";
import { caseMessages } from "../cases/runtime.ts";
import type { GovernedMemoryPromotionService } from "../../memory/governed-memory-promotion.ts";
import type { DecisionInformationPort } from "./information-ports.ts";
import { requireToolReuseAdmission } from "../artifacts/catalog.ts";
import type { ContextEvidenceReference } from "../../../domain/work/policies/context-separation.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { MemoryContent } from "../../../domain/memory/entities/memory-record.ts";
import {
  type MemoryAuthority,
  MemoryError,
  type MemoryGuidance,
  memoryGuidance,
  type MemoryPermission,
  type MemoryPolicy,
  type MemoryReceipt,
  validateMemoryContent,
} from "../../../domain/memory/governed-memory-promotion.ts";
import type {
  BehaviorInvocationRequest,
  BehaviorInvocationResult,
} from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  NativeBehaviorContract,
} from "../../../domain/model/execution/native-contracts.ts";
import type { BehaviorModelVersion } from "../../../domain/shared-kernel/behavior-model-version.ts";
import type { OperatorEntry } from "../../../domain/model/records/operator-entry.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";

type InformationKind = Extract<
  OperatorEntry["kind"],
  | "context-evidence"
  | "memory-capture"
  | "memory-recall"
  | "memory-revise"
  | "memory-review"
  | "memory-withdraw"
>;

interface InformationBehaviorOptions {
  entries: ReadonlyMap<
    string,
    { ownerId: string; kind: OperatorEntry["kind"] }
  >;
  resolveCallerModel(
    callerId: string,
    version: BehaviorModelVersion,
  ): Promise<ExecutableModel | null>;
  snapshotForCaller(callerId: string): SystemRuntimeState | undefined;
  memory(): Promise<GovernedMemoryPromotionService>;
}

const contracts: Record<
  InformationKind,
  { fields: Record<string, "string" | "integer">; optional?: string[] }
> = {
  "context-evidence": {
    fields: { messageId: "string", messageDigest: "string" },
  },
  "memory-capture": { fields: { id: "string", contentJson: "string" } },
  "memory-recall": { fields: { id: "string" }, optional: ["id"] },
  "memory-revise": {
    fields: {
      id: "string",
      expectedRevision: "integer",
      expectedDigest: "string",
      contentJson: "string",
    },
  },
  "memory-review": {
    fields: {
      id: "string",
      expectedRevision: "integer",
      expectedDigest: "string",
      decision: "string",
      reason: "string",
    },
  },
  "memory-withdraw": {
    fields: {
      id: "string",
      expectedRevision: "integer",
      expectedDigest: "string",
      reason: "string",
    },
  },
};

function informationKind(kind: OperatorEntry["kind"]): kind is InformationKind {
  return Object.hasOwn(contracts, kind);
}

function supportedInput(
  kind: InformationKind,
  schema: Record<string, unknown>,
): boolean {
  if (
    kind === "context-evidence" && matchesNativeInputSchema(schema, {
      messageId: "string",
      messageDigest: "string",
      offset: "integer",
      limit: "integer",
    }, ["offset", "limit"])
  ) return true;
  const specification = contracts[kind];
  return matchesNativeInputSchema(
    schema,
    specification.fields,
    specification.optional,
  );
}

function validator() {
  return new Ajv({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
}

const contentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text", "origin", "scope", "validUntil", "outcome"],
  properties: {
    text: { type: "string" },
    origin: {
      type: "object",
      additionalProperties: false,
      required: ["decisionId", "sourceRefs"],
      properties: {
        decisionId: { type: "string" },
        sourceRefs: { type: "array", items: { type: "string" } },
      },
    },
    scope: { type: "array", items: { type: "string" } },
    validUntil: { type: "string" },
    outcome: {
      oneOf: [{
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: { status: { const: "pending" } },
      }, {
        type: "object",
        additionalProperties: false,
        required: ["status", "summary", "evidenceRefs"],
        properties: {
          status: { const: "known" },
          summary: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" } },
        },
      }],
    },
  },
};

function content(value: unknown): MemoryContent {
  if (typeof value !== "string" || value.length > 262_144) {
    throw new Error("Le contenu mémoire doit être un document JSON borné.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Le contenu mémoire doit être un document JSON valide.");
  }
  if (!validator().compile<MemoryContent>(contentSchema)(parsed)) {
    throw new Error("Le contenu mémoire ne respecte pas son contrat.");
  }
  validateMemoryContent(parsed);
  return parsed;
}

function version(model: ExecutableModel): BehaviorModelVersion {
  if (!model.version.repositoryVersion?.trim()) {
    throw new Error("Le modèle admis ne possède pas de version native exacte.");
  }
  return {
    digest: model.version.digest,
    repositoryVersion: model.version.repositoryVersion,
  };
}

function bounded<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 262_144) {
    throw new Error(
      "Le résultat d’information dépasse la limite de restitution.",
    );
  }
  return value;
}

function receipt(value: MemoryReceipt) {
  const { content: _content, ...memory } = memoryGuidance(value.memory);
  const { content: _operationContent, ...operation } = value.operation;
  return { memory, operation, replayed: value.replayed };
}

/** Scoped host primitives. Only native local exposures confer permissions. */
export class InformationBehavior
  implements BehaviorInvocationPort, DecisionInformationPort {
  constructor(readonly options: InformationBehaviorOptions) {}

  async supports(
    behavior: NativeBehaviorContract,
    modelVersion: BehaviorModelVersion,
  ): Promise<boolean> {
    const proof = {
      behavior: structuredClone(behavior),
      modelVersion: structuredClone(modelVersion),
      callerId: behavior.callerNativeId,
      invocationId: "information-support-probe",
    };
    let kind: InformationKind;
    try {
      kind = this.#exposure(proof);
    } catch {
      return false;
    }
    // Infrastructure failures (Toolkit, Git, timeout) propagate with their
    // code: they are not a "not supported" answer.
    const model = await this.options.resolveCallerModel(
      proof.callerId,
      proof.modelVersion,
    );
    if (!model) return false;
    try {
      this.#admitted(proof, model, kind);
      return true;
    } catch {
      return false;
    }
  }

  async invoke(
    request: BehaviorInvocationRequest,
  ): Promise<BehaviorInvocationResult> {
    const copied = structuredClone(request);
    const { model, kind } = await this.#resolve(copied);
    if (!validator().compile(copied.behavior.inputSchema)(copied.input)) {
      throw new Error(
        "La demande ne respecte pas le contrat d’information natif.",
      );
    }
    bounded(copied.input);
    const result = kind === "context-evidence"
      ? await this.#evidence(copied)
      : await this.#memory(model, kind, copied);
    return bounded({
      behaviorId: copied.behavior.id,
      invocationId: copied.invocationId,
      targetNativeId: copied.behavior.targetNativeId,
      modelVersion: copied.modelVersion,
      result,
    });
  }

  async read(
    model: ExecutableModel,
  ): Promise<{ memoryGuidance: MemoryGuidance[] }> {
    const copied = structuredClone(model);
    if (!copied.memoryPolicy) return { memoryGuidance: [] };
    const modelVersion = version(copied);
    for (const behavior of copied.behaviors ?? []) {
      const entry = this.options.entries.get(behavior.targetNativeId);
      if (
        entry?.kind !== "memory-recall" ||
        entry.ownerId !== copied.identity.builderId ||
        behavior.callerNativeId !== copied.identity.builderId
      ) continue;
      const resolved = await this.#resolve({
        behavior,
        modelVersion,
        callerId: copied.identity.builderId,
        invocationId: "decision-memory-guidance",
      });
      const authority = this.#authority(resolved.model, {
        behavior,
        modelVersion,
        callerId: copied.identity.builderId,
        invocationId: "decision-memory-guidance",
      });
      try {
        const memories = await (await this.options.memory()).recall(authority);
        return bounded({
          memoryGuidance: memories.filter((memory) => memory.usableAsGuidance)
            .map(memoryGuidance),
        });
      } catch (error) {
        this.#memoryError(error);
      }
    }
    return { memoryGuidance: [] };
  }

  #exposure(
    proof: Omit<BehaviorInvocationRequest, "input">,
  ): InformationKind {
    const entry = this.options.entries.get(proof.behavior.targetNativeId);
    if (
      !entry || !informationKind(entry.kind) ||
      entry.ownerId !== proof.callerId ||
      proof.behavior.callerNativeId !== proof.callerId ||
      !supportedInput(entry.kind, proof.behavior.inputSchema)
    ) {
      throw new Error(
        "Cette information n’est pas exposée à l’opérateur local.",
      );
    }
    return entry.kind;
  }

  #admitted(
    proof: Omit<BehaviorInvocationRequest, "input">,
    model: ExecutableModel,
    kind: InformationKind,
  ): void {
    requireToolReuseAdmission(proof, model);
    const admitted = version(model);
    if (
      admitted.digest !== proof.modelVersion.digest ||
      admitted.repositoryVersion !== proof.modelVersion.repositoryVersion ||
      (model.operatorEntries ?? []).filter((native) =>
          native.id === proof.behavior.targetNativeId &&
          native.kind === kind &&
          native.typeId === proof.behavior.targetTypeId
        ).length !== 1 ||
      kind === "context-evidence" && !model.contextPolicy ||
      kind !== "context-evidence" &&
        model.memoryPolicy?.ownerId !== proof.callerId
    ) {
      throw new Error(
        "La demande ne correspond pas à la politique native admise.",
      );
    }
  }

  async #resolve(
    proof: Omit<BehaviorInvocationRequest, "input">,
  ): Promise<{ model: ExecutableModel; kind: InformationKind }> {
    const kind = this.#exposure(proof);
    const model = await this.options.resolveCallerModel(
      proof.callerId,
      proof.modelVersion,
    );
    if (!model) {
      throw new Error("Le modèle admis de l’appelant est indisponible.");
    }
    this.#admitted(proof, model, kind);
    return { model: structuredClone(model), kind };
  }

  async #evidence(request: BehaviorInvocationRequest): Promise<unknown> {
    const { messageId, messageDigest } = request.input;
    if (
      typeof messageId !== "string" || !messageId.trim() ||
      messageId.length > 512 || !isSha256Hex(messageDigest)
    ) throw new Error("Une référence exacte au journal local est requise.");
    const snapshot = this.options.snapshotForCaller(request.callerId);
    if (snapshot?.model?.builderId !== request.callerId) {
      throw new Error("Le journal demandé n’appartient pas à cet opérateur.");
    }
    const messages = snapshot ? caseMessages(snapshot) : [];
    const matches = messages.filter((message) => message.id === messageId);
    if (matches.length !== 1) {
      throw new Error("La preuve demandée est absente du journal local.");
    }
    const message = matches[0]!;
    const reference: ContextEvidenceReference = {
      kind: "journal-message",
      messageId,
      messageDigest,
      role: message.role,
      at: message.at,
      reasons: [],
    };
    if (message.execution) {
      const { sourceIds: _sourceIds, ...execution } = message.execution;
      reference.execution = execution;
    }
    const paged = Object.hasOwn(
      request.behavior.inputSchema.properties as object,
      "offset",
    );
    const offset = request.input.offset ?? 0;
    const limit = request.input.limit ?? 2048;
    if (
      paged && (!Number.isSafeInteger(offset) || Number(offset) < 0 ||
        !Number.isSafeInteger(limit) || Number(limit) < 1 ||
        Number(limit) > 2048)
    ) {
      throw new Error(
        "Evidence pages require a nonnegative offset and a limit from 1 to 2048.",
      );
    }
    const exact = await readDecisionContextEvidence(messages, reference);
    if (!paged) return { reference, message: exact };
    const serialized = JSON.stringify(exact);
    if (Number(offset) > serialized.length) {
      throw new Error("Evidence page offset exceeds the exact message.");
    }
    const end = Math.min(serialized.length, Number(offset) + Number(limit));
    return {
      reference,
      format: "json-message",
      offset,
      characters: serialized.length,
      content: serialized.slice(Number(offset), end),
      ...(end < serialized.length
        ? { next: { messageId, messageDigest, offset: end, limit } }
        : {}),
    };
  }

  #authority(
    model: ExecutableModel,
    request: Omit<BehaviorInvocationRequest, "input">,
  ): MemoryAuthority {
    const native = model.memoryPolicy;
    if (!native || native.ownerId !== request.callerId) {
      throw new Error("Aucune politique mémoire locale n’est admise.");
    }
    const permissions: MemoryPolicy["permissions"] = {};
    for (const behavior of model.behaviors ?? []) {
      const entry = this.options.entries.get(behavior.targetNativeId);
      if (
        entry?.ownerId !== request.callerId ||
        behavior.callerNativeId !== request.callerId ||
        !informationKind(entry.kind) ||
        !supportedInput(entry.kind, behavior.inputSchema) ||
        (model.operatorEntries ?? []).filter((native) =>
            native.id === behavior.targetNativeId &&
            native.kind === entry.kind &&
            native.typeId === behavior.targetTypeId
          ).length !== 1
      ) continue;
      const grants: MemoryPermission[] = entry.kind === "memory-review"
        ? ["admit", "reject"]
        : entry.kind === "context-evidence"
        ? []
        : [
          entry.kind.slice("memory-".length) as MemoryPermission,
        ];
      for (const permission of grants) {
        permissions[permission] = [request.callerId];
      }
    }
    return {
      callerId: request.callerId,
      behaviorId: request.behavior.id,
      invocationId: request.invocationId,
      modelVersion: structuredClone(request.modelVersion),
      policy: {
        id: native.id,
        ownerId: native.ownerId,
        modelVersion: structuredClone(request.modelVersion),
        allowedScopes: structuredClone(native.allowedScopes),
        permissions,
        requireSourceRefs: native.requireSourceRefs,
        requireKnownOutcome: native.requireKnownOutcome,
        maxValidityMs: native.maxValidityMs,
        allowSelfAdmission: native.allowSelfAdmission,
      },
    };
  }

  async #memory(
    model: ExecutableModel,
    kind: Exclude<InformationKind, "context-evidence">,
    request: BehaviorInvocationRequest,
  ): Promise<unknown> {
    const authority = this.#authority(model, request);
    const input = request.input;
    const expected = {
      revision: input.expectedRevision as number,
      digest: input.expectedDigest as string,
    };
    try {
      const service = await this.options.memory();
      switch (kind) {
        case "memory-capture":
          return receipt(
            await service.capture(authority, {
              id: input.id as string,
              content: content(input.contentJson),
            }),
          );
        case "memory-recall":
          return {
            memories: (await service.recall(
              authority,
              input.id === undefined ? {} : { id: input.id as string },
            )).map(memoryGuidance),
          };
        case "memory-revise":
          return receipt(
            await service.revise(authority, {
              id: input.id as string,
              expected,
              content: content(input.contentJson),
            }),
          );
        case "memory-review":
          return receipt(
            await service.review(authority, {
              id: input.id as string,
              expected,
              decision: input.decision as
                | "admit"
                | "request-revision"
                | "reject",
              reason: input.reason as string,
            }),
          );
        case "memory-withdraw":
          return receipt(
            await service.withdraw(authority, {
              id: input.id as string,
              expected,
              reason: input.reason as string,
            }),
          );
      }
    } catch (error) {
      this.#memoryError(error);
    }
  }

  #memoryError(error: unknown): never {
    if (error instanceof MemoryError) throw error;
    throw new Error("L’opération de mémoire locale n’a pas abouti.");
  }
}
