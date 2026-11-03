import { Ajv } from "ajv";
import {
  type BehaviorInvocationPort,
  matchesNativeInputSchema,
} from "./invocation.ts";
import {
  type PublishedToolArtifact,
  publishedToolDraft,
  requireToolReuseAdmission,
  type ToolReuseImport,
  type ToolReuseReceipt,
} from "../artifacts/catalog.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  BehaviorInvocationRequest,
  BehaviorInvocationResult,
} from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  NativeBehaviorContract,
} from "../../../domain/model/execution/native-contracts.ts";
import type { BehaviorModelVersion } from "../../../domain/shared-kernel/behavior-model-version.ts";

interface ToolReuseBehaviorOptions {
  /** Native occurrences qualified by the composition from admitted sources. */
  reuseTargetIds: ReadonlySet<string>;
  /** Physical native owner of each import occurrence; imports are local proposals. */
  reuseTargetOwners: ReadonlyMap<string, string>;
  resolveCallerModel(
    callerId: string,
    version: BehaviorModelVersion,
  ): Promise<ExecutableModel | null>;
  findArtifact(
    sourceAgentId: string,
    candidateId: string,
    digest: string,
  ): Promise<PublishedToolArtifact | null>;
  importForCaller(
    callerId: string,
    input: ToolReuseImport,
  ): Promise<ToolReuseReceipt>;
}

const fields = ["candidateId", "digest", "sourceAgentId"];

function supportedInput(schema: Record<string, unknown>): boolean {
  return matchesNativeInputSchema(
    schema,
    Object.fromEntries(fields.map((field) => [field, "string"])),
  );
}

interface PublishedToolDescription {
  sourceAgentId: string;
  candidateId: string;
  digest: string;
  name: string;
  description: string;
  kind: PublishedToolArtifact["candidate"]["kind"];
}

interface PublishedToolsBehaviorOptions {
  listTargetIds: ReadonlySet<string>;
  resolveCallerModel: ToolReuseBehaviorOptions["resolveCallerModel"];
  /** Only source-admitted active occurrences, with their native readback. */
  listArtifacts(): Promise<PublishedToolArtifact[]>;
}

/** Published metadata is discoverable only through its own source exposure. */
export class PublishedToolsBehavior implements BehaviorInvocationPort {
  constructor(private readonly options: PublishedToolsBehaviorOptions) {}

  async supports(
    behavior: NativeBehaviorContract,
    modelVersion: BehaviorModelVersion,
  ): Promise<boolean> {
    const schema = behavior.inputSchema;
    if (
      !this.options.listTargetIds.has(behavior.targetNativeId) ||
      schema.type !== "object" || schema.additionalProperties !== false ||
      !schema.properties || typeof schema.properties !== "object" ||
      Object.keys(schema.properties).length !== 0 ||
      (schema.required !== undefined &&
        (!Array.isArray(schema.required) || schema.required.length !== 0))
    ) return false;
    // Infrastructure failures propagate with their code, not as `false`.
    const model = await this.options.resolveCallerModel(
      behavior.callerNativeId,
      modelVersion,
    );
    if (!model) return false;
    try {
      requireToolReuseAdmission({
        behavior,
        modelVersion,
        callerId: behavior.callerNativeId,
        invocationId: "support-probe",
      }, model);
      return true;
    } catch {
      return false;
    }
  }

  async invoke(
    request: BehaviorInvocationRequest,
  ): Promise<BehaviorInvocationResult> {
    const copied = structuredClone(request);
    if (!await this.supports(copied.behavior, copied.modelVersion)) {
      throw new Error(
        "Le catalogue publié n’est pas exposé à cet opérateur natif.",
      );
    }
    const model = await this.options.resolveCallerModel(
      copied.callerId,
      copied.modelVersion,
    );
    if (!model) {
      throw new Error("Le modèle admis de l’appelant est indisponible.");
    }
    requireToolReuseAdmission(copied, model);
    if (Object.keys(copied.input).length !== 0) {
      throw new Error(
        "La consultation du catalogue n’accepte aucun paramètre.",
      );
    }
    const published = structuredClone(await this.options.listArtifacts());
    if (published.length > 128) {
      throw new Error("Le catalogue publié dépasse la limite de restitution.");
    }
    const seen = new Set<string>();
    const artifacts: PublishedToolDescription[] = [];
    for (const artifact of published) {
      await publishedToolDraft(artifact);
      const key = JSON.stringify([artifact.agentId, artifact.candidate.id]);
      if (seen.has(key)) {
        throw new Error("Le catalogue publié contient une identité ambiguë.");
      }
      seen.add(key);
      const { id, digest, name, description, kind } = artifact.candidate;
      artifacts.push({
        sourceAgentId: artifact.agentId,
        candidateId: id,
        digest,
        name,
        description,
        kind,
      });
    }
    const result: BehaviorInvocationResult = {
      behaviorId: copied.behavior.id,
      invocationId: copied.invocationId,
      targetNativeId: copied.behavior.targetNativeId,
      modelVersion: copied.modelVersion,
      result: { artifacts },
    };
    if (new TextEncoder().encode(JSON.stringify(result)).length > 262_144) {
      throw new Error("Le catalogue publié dépasse la limite de restitution.");
    }
    return result;
  }
}

/** An import creates a local proposal; only the local native promotion may admit it. */
export class ToolReuseBehavior implements BehaviorInvocationPort {
  constructor(private readonly options: ToolReuseBehaviorOptions) {}

  async supports(
    behavior: NativeBehaviorContract,
    modelVersion: BehaviorModelVersion,
  ): Promise<boolean> {
    if (
      !this.options.reuseTargetIds.has(behavior.targetNativeId) ||
      this.options.reuseTargetOwners.get(behavior.targetNativeId) !==
        behavior.callerNativeId ||
      !supportedInput(behavior.inputSchema)
    ) return false;
    // Infrastructure failures propagate with their code, not as `false`.
    const model = await this.options.resolveCallerModel(
      behavior.callerNativeId,
      modelVersion,
    );
    if (!model) return false;
    try {
      requireToolReuseAdmission({
        behavior,
        modelVersion,
        callerId: behavior.callerNativeId,
        invocationId: "support-probe",
      }, model);
      return true;
    } catch {
      return false;
    }
  }

  async invoke(
    request: BehaviorInvocationRequest,
  ): Promise<BehaviorInvocationResult> {
    const copied = structuredClone(request);
    if (!await this.supports(copied.behavior, copied.modelVersion)) {
      throw new Error("Aucun importeur n’est exposé à cet opérateur natif.");
    }
    const model = await this.options.resolveCallerModel(
      copied.callerId,
      copied.modelVersion,
    );
    if (!model) {
      throw new Error("Le modèle admis de l’importateur est indisponible.");
    }
    requireToolReuseAdmission(copied, model);
    const ajv = new Ajv({
      strict: true,
      allErrors: true,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
    });
    if (!ajv.compile(copied.behavior.inputSchema)(copied.input)) {
      throw new Error(
        "La référence d’artefact ne respecte pas le contrat natif.",
      );
    }
    const { sourceAgentId, candidateId, digest } = copied.input;
    if (
      ![sourceAgentId, candidateId, digest].every((value) =>
        typeof value === "string" && value.trim() && value.length <= 512
      )
    ) throw new Error("Une référence d’artefact exacte et bornée est requise.");
    const found = await this.options.findArtifact(
      sourceAgentId as string,
      candidateId as string,
      digest as string,
    );
    if (!found) throw new Error("L’artefact source admis est introuvable.");
    const artifact = structuredClone(found);
    if (
      artifact.agentId !== sourceAgentId ||
      artifact.candidate.id !== candidateId ||
      artifact.candidate.digest !== digest
    ) throw new Error("Le catalogue source a retourné un autre artefact.");
    await publishedToolDraft(artifact);
    const result = await this.options.importForCaller(copied.callerId, {
      proof: {
        behavior: copied.behavior,
        modelVersion: copied.modelVersion,
        callerId: copied.callerId,
        invocationId: copied.invocationId,
      },
      artifact,
    });
    if (
      typeof result.candidateId !== "string" || !result.candidateId.trim() ||
      result.candidateId === candidateId ||
      ![
        "proposed",
        "testing",
        "reviewing",
        "awaiting-admission",
        "refused",
        "activating",
        "active",
        "failed",
      ].includes(result.stage) ||
      ![null, true, false].includes(result.testsPassed) ||
      typeof result.replayed !== "boolean" ||
      result.source.agentId !== sourceAgentId ||
      result.source.candidateId !== candidateId ||
      result.source.digest !== digest ||
      result.candidateDigest !== digest ||
      result.correlationId !== copied.invocationId ||
      result.active !== (result.stage === "active") ||
      result.active && result.testsPassed !== true
    ) throw new Error("Le reçu local ne correspond pas à l’import demandé.");
    return {
      behaviorId: copied.behavior.id,
      invocationId: copied.invocationId,
      targetNativeId: copied.behavior.targetNativeId,
      modelVersion: copied.modelVersion,
      result,
    };
  }
}
