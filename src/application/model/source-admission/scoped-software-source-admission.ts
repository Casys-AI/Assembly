import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  canonicalDigest,
  isSha256Hex,
} from "../../../domain/primitives/execution-digest.ts";
import {
  type ModelRevisionRef,
  parseModelRevisionRef,
} from "../../../domain/model/value-objects/element-ref.ts";
import {
  type BuildDescriptor,
  buildKey,
  parseBuildDescriptorStrict,
  recipeDigest,
} from "../../../domain/model/value-objects/build.ts";
import {
  scopedSoftwareSourceAdmissionRef,
  scopedSoftwareSourceCommandRef,
} from "../../../domain/model/editing/request-source-publication.ts";
import type { ModelIdentity } from "../../../domain/shared-kernel/model-identity.ts";
import { RequestSpaceError } from "../../../domain/work/request-spaces.ts";
import {
  assertScopedSoftwareWriteMatchesEvolution,
  parseScopedSoftwareWriteCommand,
  scopedSoftwareWriteCommandDigest,
  type ScopedSoftwareWriteCommandV2,
  scopedSoftwareWriteDossierDigest,
} from "../publication/scoped-software-write.ts";
import type { RequestSourceAdmission } from "./request-source-admission.ts";

/** Immutable software receipt, separate from human source-owner admission. */
export interface ScopedSoftwareSourceAdmissionV2 {
  readonly format: "request-software-source-admission/v2";
  readonly destination: ScopedSoftwareWriteCommandV2["destination"];
  readonly openingBaseDigest: string;
  readonly predecessor: RequestSourceAdmission["predecessor"];
  readonly result: {
    readonly source: ModelRevisionRef;
    readonly sourceDigest: string;
    readonly build: BuildDescriptor;
    readonly buildDigest: string;
    readonly targets: readonly {
      readonly operatorId: string;
      readonly identity: ModelIdentity;
      readonly digest: string;
    }[];
  };
  readonly command: ScopedSoftwareWriteCommandV2;
  readonly commandDigest: string;
  readonly writeDossierDigest: string;
  readonly evolutionDossierId: string;
  readonly evolutionIntentDigest: string;
  readonly proposalDigest: string;
  readonly decisionDigest: string;
  readonly publication: RequestSourceAdmission["publication"];
}
const invalid = (): never => {
  throw new RequestSpaceError(
    "UNAVAILABLE",
    "Invalid scoped software source admission",
  );
};
function obj(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid();
  }
  const v = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  ) return invalid();
  return v;
}
const hash = (v: unknown): v is string => isSha256Hex(v);
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 512 && v.trim() === v;
/** Shape and digest consistency only: Git, queue and current authority are
 * verified by their own participants, not inferred from this receipt. */
export async function parseScopedSoftwareSourceAdmission(
  input: unknown,
): Promise<ScopedSoftwareSourceAdmissionV2> {
  const snapshot = structuredClone(input);
  const v = obj(snapshot, [
    "format",
    "destination",
    "openingBaseDigest",
    "predecessor",
    "result",
    "command",
    "commandDigest",
    "writeDossierDigest",
    "evolutionDossierId",
    "evolutionIntentDigest",
    "proposalDigest",
    "decisionDigest",
    "publication",
  ]);
  if (v.format !== "request-software-source-admission/v2") return invalid();
  const command = parseScopedSoftwareWriteCommand(v.command);
  const predecessor = obj(v.predecessor, [
    "revision",
    "manifestDigest",
    "source",
    "sourceDigest",
  ]);
  const result = obj(v.result, [
    "source",
    "sourceDigest",
    "build",
    "buildDigest",
    "targets",
  ]);
  const publication = obj(v.publication, [
    "repositoryId",
    "commandId",
    "commandRef",
    "publicationRef",
    "commit",
    "receiptDigest",
  ]);
  const before = parseModelRevisionRef(predecessor.source),
    after = parseModelRevisionRef(result.source),
    build = parseBuildDescriptorStrict(result.build);
  if (
    !Number.isSafeInteger(predecessor.revision) ||
    Number(predecessor.revision) < 1 ||
    ![
      predecessor.manifestDigest,
      predecessor.sourceDigest,
      result.sourceDigest,
      result.buildDigest,
      v.openingBaseDigest,
      v.commandDigest,
      v.writeDossierDigest,
      v.evolutionIntentDigest,
      v.proposalDigest,
      v.decisionDigest,
      publication.receiptDigest,
    ].every(hash) || !text(v.evolutionDossierId) ||
    canonical(v.destination) !== canonical(command.destination) ||
    predecessor.revision !==
      command.destination.expectedAdmittedSource.revision ||
    canonical(before) !== canonical(command.approvedBase) ||
    predecessor.sourceDigest !==
      command.destination.expectedAdmittedSource.sourceDigest ||
    after.repositoryId !== command.repositoryId ||
    after.version === before.version ||
    result.sourceDigest === predecessor.sourceDigest ||
    build.repositoryId !== command.repositoryId ||
    build.sourceDigest !== result.sourceDigest ||
    build.recipe.digest !== command.recipeDigest ||
    await canonicalDigest(build) !== result.buildDigest ||
    await recipeDigest(build.recipe) !== build.recipe.digest ||
    await buildKey(build.sourceDigest, build.recipe.digest) !==
      build.buildKey ||
    await scopedSoftwareWriteCommandDigest(command) !== v.commandDigest ||
    command.decisionRef.digest !== v.decisionDigest ||
    publication.repositoryId !== command.repositoryId ||
    publication.commandId !== command.commandId ||
    publication.commandRef !==
      scopedSoftwareSourceCommandRef(command.commandId) ||
    publication.publicationRef !==
      scopedSoftwareSourceAdmissionRef(command.commandId, after.version) ||
    publication.commit !== after.version || !Array.isArray(result.targets) ||
    !result.targets.length
  ) return invalid();
  const seen = new Set<string>();
  for (const entry of result.targets) {
    const t = obj(entry, ["operatorId", "identity", "digest"]);
    if (
      !text(t.operatorId) || seen.has(t.operatorId) || !hash(t.digest) ||
      !t.identity || typeof t.identity !== "object" || Array.isArray(t.identity)
    ) return invalid();
    const identity = t.identity as Record<string, unknown>;
    const required = [
      "projectId",
      "editingContextId",
      "rootId",
      "systemId",
      "catalogId",
      "builderId",
    ];
    const allowed = [
      ...required,
      "systemQualifiedName",
      "backend",
      "reviewerId",
    ];
    if (
      Reflect.ownKeys(identity).some((key) =>
        typeof key !== "string" || !allowed.includes(key)
      ) ||
      required.some((key) => !text(identity[key])) ||
      identity.builderId !== t.operatorId ||
      (identity.backend !== undefined && identity.backend !== "native") ||
      (identity.systemQualifiedName !== undefined &&
        !text(identity.systemQualifiedName)) ||
      (identity.reviewerId !== undefined && !text(identity.reviewerId))
    ) return invalid();
    seen.add(t.operatorId);
  }
  return snapshot as ScopedSoftwareSourceAdmissionV2;
}
export async function scopedSoftwareSourceAdmissionDigest(
  input: unknown,
): Promise<string> {
  return await canonicalDigest(await parseScopedSoftwareSourceAdmission(input));
}

/** Join all three immutable records before checking Git or appending D2. */
export async function assertScopedSoftwareAdmissionEvidence(
  admissionInput: unknown,
  writeInput: unknown,
  evolutionInput: unknown,
): Promise<ScopedSoftwareSourceAdmissionV2> {
  const admission = await parseScopedSoftwareSourceAdmission(admissionInput);
  const { write, evolution } = await assertScopedSoftwareWriteMatchesEvolution(
    writeInput,
    evolutionInput,
  );
  if (
    canonical(admission.command) !== canonical(write.command) ||
    admission.writeDossierDigest !==
      await scopedSoftwareWriteDossierDigest(write) ||
    admission.openingBaseDigest !== evolution.scope.openingBaseDigest ||
    admission.predecessor.manifestDigest !==
      evolution.scope.predecessorManifestDigest ||
    admission.evolutionDossierId !== evolution.id ||
    admission.evolutionIntentDigest !== evolution.intentDigest ||
    admission.proposalDigest !== evolution.proposal.digest ||
    admission.result.sourceDigest !== evolution.proposal.sourceDigest ||
    canonical(admission.result.build) !== canonical(evolution.proposal.build) ||
    admission.result.targets.length !== evolution.proposal.targets.length ||
    admission.result.targets.some((target) =>
      !evolution.proposal.targets.some((expected) =>
        expected.operatorId === target.operatorId &&
        expected.candidateDigest === target.digest
      )
    )
  ) return invalid();
  return admission;
}
