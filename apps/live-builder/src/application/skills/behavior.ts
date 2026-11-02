import { Ajv } from "ajv";
import {
  type BehaviorInvocationPort,
  matchesNativeInputSchema,
} from "../work/behaviors/invocation.ts";
import type { ContextSkillsService } from "./context-skills.ts";
import type { DecisionInformation } from "../work/context/information-ports.ts";
import { requireToolReuseAdmission } from "../work/artifacts/catalog.ts";
import {
  requireSkill,
  requireSkillAuthority,
  type SkillAuthority,
  SkillError,
  type SkillPermission,
  type SkillPolicy,
} from "../../domain/skills/context-skills.ts";
import { canonical } from "../../domain/primitives/canonical-json.ts";
import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";
import type {
  BehaviorInvocationRequest,
  BehaviorInvocationResult,
} from "../../domain/work/execution/modeled-behavior.ts";
import type {
  NativeBehaviorContract,
  NativeInitialSkill,
} from "../../domain/model/execution/native-contracts.ts";
import type { BehaviorModelVersion } from "../../domain/shared-kernel/behavior-model-version.ts";
import type { OperatorEntry } from "../../domain/model/records/operator-entry.ts";

type SkillKind = Extract<
  OperatorEntry["kind"],
  "skill-install" | "skill-list" | "skill-load" | "skill-unload"
>;
type Proof = Omit<BehaviorInvocationRequest, "input">;

/** Keep seed retention and its scoped verifier on the existing replay identity. */
export function initialSkillInvocationId(
  seed: Pick<NativeInitialSkill, "nativeId" | "digest">,
  modelVersion: Pick<
    ExecutableModel["version"],
    "digest" | "repositoryVersion"
  >,
): string {
  return `initial-skill:${seed.nativeId}:${seed.digest}:${modelVersion.digest}:${modelVersion.repositoryVersion}`;
}

export interface SkillsBehaviorOptions {
  entries: ReadonlyMap<
    string,
    { ownerId: string; kind: OperatorEntry["kind"] }
  >;
  resolveCallerModel(
    callerId: string,
    version: BehaviorModelVersion,
  ): Promise<ExecutableModel | null>;
  skills(): Promise<ContextSkillsService>;
  /** Resolve an admitted bundle reference to bounded local instruction bytes.
   * Required only when a not-yet-installed initial seed is present. */
  readBundledSkill?(source: string, maximumBytes: number): Promise<string>;
}

const contracts: Record<SkillKind, { fields: string[]; optional: string[] }> = {
  "skill-install": {
    fields: ["id", "url", "expectedDigest"],
    optional: ["expectedDigest"],
  },
  "skill-list": { fields: [], optional: [] },
  "skill-load": { fields: ["id", "expectedDigest"], optional: [] },
  "skill-unload": { fields: ["id", "expectedDigest"], optional: [] },
};

function skillKind(value: OperatorEntry["kind"]): value is SkillKind {
  return Object.hasOwn(contracts, value);
}

function supportedInput(
  kind: SkillKind,
  schema: Record<string, unknown>,
): boolean {
  const specification = contracts[kind];
  return matchesNativeInputSchema(
    schema,
    Object.fromEntries(specification.fields.map((name) => [name, "string"])),
    specification.optional,
  );
}

/** The same local exposure gate used by execution and read-only analysis. */
export function matchesLocalSkillExposure(
  model: ExecutableModel,
  behavior: NativeBehaviorContract,
  kind: SkillKind,
  entries: SkillsBehaviorOptions["entries"],
): boolean {
  const ownerId = model.identity.builderId;
  const entry = entries.get(behavior.targetNativeId);
  return entry?.kind === kind && entry.ownerId === ownerId &&
    behavior.callerNativeId === ownerId &&
    supportedInput(kind, behavior.inputSchema) &&
    (model.operatorEntries ?? []).filter((native) =>
        native.id === behavior.targetNativeId && native.kind === kind &&
        native.typeId === behavior.targetTypeId
      ).length === 1;
}

function version(model: ExecutableModel): BehaviorModelVersion {
  if (!model.version.repositoryVersion?.trim()) {
    throw new Error(
      "Le modèle de skills doit identifier sa source native exacte.",
    );
  }
  return {
    digest: model.version.digest,
    repositoryVersion: model.version.repositoryVersion,
  };
}

function policy(model: ExecutableModel): SkillPolicy {
  const source = model.skillPolicy;
  if (!source || source.ownerId !== model.identity.builderId) {
    throw new Error("Aucune politique de skills locale n’est admise.");
  }
  return {
    id: source.id,
    ownerId: source.ownerId,
    allowedHosts: [...source.allowedHosts],
    maxSkillBytes: source.maxSkillBytes,
    maxInstalledSkills: source.maxInstalledSkills,
    maxLoadedSkills: source.maxLoadedSkills,
    maxLoadedCharacters: source.maxLoadedCharacters,
  };
}

function bounded<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 262_144) {
    throw new Error("Le résultat de skills dépasse la limite de restitution.");
  }
  return value;
}

/** Native local instruction capabilities. Registration and instruction text
 * never grant access: each use resolves its exact admitted source exposure. */
export class SkillsBehavior implements BehaviorInvocationPort {
  constructor(readonly options: SkillsBehaviorOptions) {}

  /** Revalidate a captured skill operation through the existing admitted native
   * exposure. A source reference and its serialized proof grant no authority. */
  async assertCurrentAuthority(
    authority: SkillAuthority,
    permission: SkillPermission,
  ): Promise<void> {
    const captured = structuredClone(authority);
    requireSkillAuthority(captured, permission);
    const model = await this.options.resolveCallerModel(
      captured.callerId,
      captured.modelVersion,
    );
    requireSkill(
      model,
      "forbidden",
      "the current admitted skill model is unavailable",
    );
    const matches = (model.behaviors ?? []).filter((behavior) =>
      behavior.id === captured.behaviorId
    );
    requireSkill(
      matches.length === 1,
      "forbidden",
      "the current native skill exposure differs",
    );
    const proof: Proof = {
      behavior: structuredClone(matches[0]!),
      modelVersion: captured.modelVersion,
      callerId: captured.callerId,
      invocationId: captured.invocationId,
    };
    let current: SkillAuthority;
    try {
      const kind = this.#exposedKind(proof);
      this.#admitted(proof, model, kind);
      current = this.#authority(model, proof);
    } catch {
      throw new SkillError(
        "forbidden",
        "the current admitted skill exposure differs",
      );
    }
    requireSkillAuthority(current, permission);
    requireSkill(
      canonical(current) === canonical(captured),
      "forbidden",
      "the current skill policy, permissions or model changed",
    );
  }

  async supports(
    behavior: NativeBehaviorContract,
    modelVersion: BehaviorModelVersion,
  ): Promise<boolean> {
    const proof = {
      behavior: structuredClone(behavior),
      modelVersion: structuredClone(modelVersion),
      callerId: behavior.callerNativeId,
      invocationId: "skills-support-probe",
    };
    let kind: SkillKind;
    try {
      kind = this.#exposedKind(proof);
    } catch {
      return false;
    }
    // Infrastructure failures propagate with their code, not as `false`.
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
    const validate = new Ajv({
      strict: true,
      allErrors: true,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
    }).compile(copied.behavior.inputSchema);
    if (!validate(copied.input)) {
      throw new Error("La demande ne respecte pas le contrat natif du skill.");
    }
    bounded(copied.input);
    const auth = this.#authority(model, copied);
    const input = copied.input;
    try {
      const service = await this.options.skills();
      const result = kind === "skill-list"
        ? { skills: await service.list(auth) }
        : kind === "skill-install"
        ? await service.install(auth, {
          id: input.id as string,
          url: input.url as string,
          ...(input.expectedDigest === undefined
            ? {}
            : { expectedDigest: input.expectedDigest as string }),
        })
        : await service[kind === "skill-load" ? "load" : "unload"](auth, {
          id: input.id as string,
          expectedDigest: input.expectedDigest as string,
        });
      return bounded({
        behaviorId: copied.behavior.id,
        invocationId: copied.invocationId,
        targetNativeId: copied.behavior.targetNativeId,
        modelVersion: copied.modelVersion,
        result,
      });
    } catch (error) {
      this.#error(error);
    }
  }

  /** Apply only initial instructions declared by the resolved admitted source.
   * Existing immutable installations preserve their current loaded selection. */
  async initialize(model: ExecutableModel): Promise<void> {
    if (!model.skillPolicy || !model.initialSkills?.length) return;
    const install = this.#exposure(model, "skill-install");
    if (!install) return;
    const proof = this.#proof(model, install, "initial-skills-resolution");
    const resolved = await this.#resolve(proof);
    const auth = this.#authority(resolved.model, proof);
    try {
      const service = await this.options.skills();
      const installed = auth.permissions.includes("list")
        ? await service.list(auth)
        : [];
      for (const seed of resolved.model.initialSkills ?? []) {
        const existing = installed.find((entry) => entry.id === seed.id);
        if (existing) {
          if (
            existing.digest !== seed.digest ||
            existing.source.kind !== "bundled" ||
            existing.source.location !== seed.source
          ) {
            throw new Error(
              "Le skill initial existe déjà sous une autre version ou provenance.",
            );
          }
          continue;
        }
        if (!this.options.readBundledSkill) {
          throw new Error("Le résolveur de skills initiaux est indisponible.");
        }
        const content = await this.options.readBundledSkill(
          seed.source,
          auth.policy.maxSkillBytes,
        );
        await service.installBundled({
          ...auth,
          invocationId: initialSkillInvocationId(seed, auth.modelVersion),
        }, {
          id: seed.id,
          source: seed.source,
          content,
          expectedDigest: seed.digest,
          loaded: seed.loaded,
        });
      }
    } catch (error) {
      this.#error(error);
    }
  }

  async read(
    model: ExecutableModel,
  ): Promise<Pick<DecisionInformation, "skills">> {
    if (!model.skillPolicy) return {};
    const list = this.#exposure(model, "skill-list");
    if (!list) {
      return { skills: { policy: policy(model), catalog: [], loaded: [] } };
    }
    const proof = this.#proof(model, list, "decision-skills-context");
    const resolved = await this.#resolve(proof);
    const auth = this.#authority(resolved.model, proof);
    try {
      const service = await this.options.skills();
      const catalog = await service.list(auth);
      const loaded = auth.permissions.includes("load")
        ? await service.guidance(auth)
        : [];
      // This is internal decision information, not a native RPC response. The
      // skill policy bounds loaded instructions; the context preparer enforces
      // its complete serialized budget without truncating their exact text.
      return { skills: { policy: auth.policy, catalog, loaded } };
    } catch (error) {
      this.#error(error);
    }
  }

  #proof(
    model: ExecutableModel,
    behavior: NativeBehaviorContract,
    invocationId: string,
  ): Proof {
    return {
      behavior: structuredClone(behavior),
      modelVersion: version(model),
      callerId: model.identity.builderId,
      invocationId,
    };
  }

  #exposure(
    model: ExecutableModel,
    kind: SkillKind,
  ): NativeBehaviorContract | undefined {
    return (model.behaviors ?? []).find((behavior) =>
      this.#matches(model, behavior, kind)
    );
  }

  #matches(
    model: ExecutableModel,
    behavior: NativeBehaviorContract,
    kind: SkillKind,
  ): boolean {
    return matchesLocalSkillExposure(
      model,
      behavior,
      kind,
      this.options.entries,
    );
  }

  #exposedKind(proof: Proof): SkillKind {
    const entry = this.options.entries.get(proof.behavior.targetNativeId);
    if (
      !entry || !skillKind(entry.kind) || entry.ownerId !== proof.callerId ||
      proof.behavior.callerNativeId !== proof.callerId ||
      !supportedInput(entry.kind, proof.behavior.inputSchema)
    ) {
      throw new Error("Ce skill n’est pas exposé à l’opérateur local.");
    }
    return entry.kind;
  }

  #admitted(proof: Proof, model: ExecutableModel, kind: SkillKind): void {
    requireToolReuseAdmission(proof, model);
    const admitted = version(model);
    if (
      admitted.digest !== proof.modelVersion.digest ||
      admitted.repositoryVersion !== proof.modelVersion.repositoryVersion ||
      model.skillPolicy?.ownerId !== proof.callerId ||
      !this.#matches(model, proof.behavior, kind)
    ) {
      throw new Error(
        "La demande de skill ne correspond pas à la source native admise.",
      );
    }
  }

  async #resolve(
    proof: Proof,
  ): Promise<{ model: ExecutableModel; kind: SkillKind }> {
    const kind = this.#exposedKind(proof);
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

  #authority(model: ExecutableModel, proof: Proof): SkillAuthority {
    const permissions: SkillPermission[] = [];
    for (const kind of Object.keys(contracts) as SkillKind[]) {
      if (this.#exposure(model, kind)) {
        permissions.push(kind.slice("skill-".length) as SkillPermission);
      }
    }
    return {
      callerId: proof.callerId,
      policy: policy(model),
      modelVersion: structuredClone(proof.modelVersion),
      behaviorId: proof.behavior.id,
      invocationId: proof.invocationId,
      permissions,
    };
  }

  #error(error: unknown): never {
    if (error instanceof SkillError) throw error;
    throw new Error("L’opération de skills locaux n’a pas abouti.");
  }
}
