import {
  parseRequestWriteAuthority,
  type RequestWriteAuthority,
  requestWriteAuthorityDestination,
  requestWriteAuthorityDigest,
  requestWriteAuthorityHasMemberPin,
  requestWriteAuthorityPrior,
} from "../source-admission/request-delegated-authority.ts";
import {
  parseRequestModelWriteDestination,
  type RequestModelWriteDestination,
} from "../../../domain/model/editing/request-write-destination.ts";
import {
  assertPublicationMatches,
  ChangePublicationError,
  publicationSourceVersion,
} from "../../../domain/model/publication/change.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  canonicalDigest,
  isSha256Hex,
} from "../../../domain/primitives/execution-digest.ts";
import {
  assertModelWriteDossier,
  type ModelWriteCommand,
  type ModelWriteDecision,
  modelWriteDecisionDigest,
  type ModelWriteDossier,
  modelWriteIntentDigest,
  type ModelWriteOperations,
  modelWriteOperationsDigest,
  parseModelWriteCommand,
} from "../../../domain/model/editing/write-command.ts";
import { ModelWriteCommandError } from "../../../domain/model/editing/write-command-error.ts";
import {
  parseScopedSoftwareWriteCommand,
  parseScopedSoftwareWriteDossier,
  type ScopedSoftwareWriteCommandV2,
  type ScopedSoftwareWriteDossierV2,
} from "./scoped-software-write.ts";

/** No Main default or artifact-source route is introduced in v2. Artifact
 * retention already has a separate exact target/proof protocol. */
export interface ModelWriteCommandV2
  extends Omit<ModelWriteCommand, "v" | "kind"> {
  readonly v: 2;
  readonly kind: Exclude<ModelWriteCommand["kind"], "retain-artifact-source">;
  readonly destination: RequestModelWriteDestination;
  readonly authorityRef: {
    readonly kind: RequestWriteAuthority["kind"];
    readonly digest: string;
  };
}
export interface ModelWriteDossierV2 {
  readonly v: 2;
  /** The person's two-phase proof, or the MO's delegated decision (4.8c). */
  readonly authority: RequestWriteAuthority;
  readonly command: ModelWriteCommandV2;
  readonly operations: Exclude<
    ModelWriteOperations,
    { readonly kind: "artifact-source" }
  >;
  readonly decision: Exclude<
    ModelWriteDecision,
    { readonly kind: "retain-artifact-source" }
  >;
}
export type VersionedModelWriteCommand =
  | ModelWriteCommand
  | ModelWriteCommandV2
  | ScopedSoftwareWriteCommandV2;
export type VersionedModelWriteDossier =
  | ModelWriteDossier
  | ModelWriteDossierV2
  | ScopedSoftwareWriteDossierV2;

/** Family narrowing for the closed, parsed union. Unknown envelopes must still
 * pass parseVersionedModelWriteDossier before any publication dispatch. */
export function isScopedSoftwareWriteDossier(
  dossier: VersionedModelWriteDossier,
): dossier is ScopedSoftwareWriteDossierV2 {
  return dossier.v === 2 && "kind" in dossier &&
    dossier.kind === "software-evolution-scoped-publication";
}

function invalid(reason: string, path: string): never {
  throw new ModelWriteCommandError(
    "WRITE_COMMAND_INVALID",
    { reason, path },
    `${reason}: ${path}`,
  );
}
function mismatch(reason: string, path: string): never {
  throw new ModelWriteCommandError(
    "WRITE_DOSSIER_MISMATCH",
    { reason, path },
    `${reason}: ${path}`,
  );
}
function object(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("Expected an object", path);
  }
  const entry = value as Record<string, unknown>;
  if (
    Object.keys(entry).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(entry, key))
  ) invalid("Expected exact fields", path);
  return entry;
}
export function parseModelWriteCommandV2(value: unknown): ModelWriteCommandV2 {
  const entry = object(value, [
    "v",
    "repositoryId",
    "commandId",
    "kind",
    "approvedBase",
    "intentDigest",
    "operationsRef",
    "decisionRef",
    "recipeDigest",
    "destination",
    "authorityRef",
  ], "command");
  if (entry.v !== 2) invalid("Bad command version", "command.v");
  // Reuse the exact existing scalar/ref decoder, not a second envelope grammar.
  const {
    destination: rawDestination,
    authorityRef: rawAuthorityRef,
    ...body
  } = entry;
  const authorityRef = object(
    rawAuthorityRef,
    ["kind", "digest"],
    "command.authorityRef",
  );
  if (
    (authorityRef.kind !== "request-source-owner-authority" &&
      authorityRef.kind !== "request-delegated-authority" &&
      authorityRef.kind !== "request-creation-grant") ||
    !isSha256Hex(authorityRef.digest)
  ) invalid("Exact authority reference required", "command.authorityRef");
  const legacy = parseModelWriteCommand({ ...body, v: 1 });
  if (legacy.kind === "retain-artifact-source") {
    invalid("Artifact-source v2 is unsupported", "command.kind");
  }
  const destination = parseRequestModelWriteDestination(rawDestination);
  if (
    destination.repositoryId !== legacy.repositoryId ||
    canonical(destination.expectedAdmittedSource.source) !==
      canonical(legacy.approvedBase)
  ) {
    invalid(
      "Approved base differs from destination admitted source",
      "command.approvedBase",
    );
  }
  return {
    ...legacy,
    kind: legacy.kind,
    v: 2,
    destination,
    authorityRef: {
      kind: authorityRef.kind,
      digest: authorityRef.digest,
    },
  };
}

/** Explicit opt-in decoder. Existing v1 parser/queue/HTTP never call it. */
export function parseVersionedModelWriteCommand(
  value: unknown,
): VersionedModelWriteCommand {
  if (
    value && typeof value === "object" && !Array.isArray(value) &&
    Reflect.get(value, "v") === 2
  ) {
    return Reflect.get(value, "kind") === "publish-software-evolution"
      ? parseScopedSoftwareWriteCommand(value)
      : parseModelWriteCommandV2(value);
  }
  return parseModelWriteCommand(value);
}
export async function requestModelWriteDestinationDigest(
  value: RequestModelWriteDestination,
): Promise<string> {
  return await canonicalDigest(parseRequestModelWriteDestination(value));
}
export async function modelWriteIntentDigestV2(
  intent: Omit<ModelWriteCommandV2, "v" | "intentDigest">,
): Promise<string> {
  const command = parseModelWriteCommandV2({
    ...intent,
    v: 2,
    intentDigest: "0".repeat(64),
  });
  const { intentDigest: _intent, ...body } = command;
  return await canonicalDigest(body);
}
export async function modelWriteCommandDigestV2(
  command: ModelWriteCommandV2,
): Promise<string> {
  return await canonicalDigest(parseModelWriteCommandV2(command));
}

/** Private validator over a parser-owned snapshot. Never assert validity of a
 * mutable caller object across awaits; public APIs return the validated copy. */
async function validateOwnedDossierV2(
  dossier: ModelWriteDossierV2,
): Promise<void> {
  object(
    dossier,
    ["v", "command", "operations", "decision", "authority"],
    "dossier",
  );
  if (dossier.v !== 2) mismatch("Bad dossier version", "dossier.v");
  const command = parseModelWriteCommandV2(dossier.command);
  if (canonical(command) !== canonical(dossier.command)) {
    mismatch("Command envelope differs", "command");
  }
  if (
    !dossier.operations || typeof dossier.operations !== "object" ||
    !dossier.decision || typeof dossier.decision !== "object" ||
    !["host-edits", "whole-files"].includes(dossier.operations.kind) ||
    !["accept-proposal", "approved-change", "activate-candidate"].includes(
      dossier.decision.kind,
    )
  ) mismatch("Unsupported v2 payload", "operations");
  if (dossier.operations.kind === "host-edits") {
    object(dossier.operations, ["kind", "journal"], "operations");
    object(dossier.operations.journal, [
      "v",
      "base",
      "baseSourceDigest",
      "entries",
      "idMap",
    ], "operations.journal");
  } else {
    object(dossier.operations, ["kind", "files"], "operations");
    object(
      dossier.operations.files,
      ["v", "base", "baseSourceDigest", "files"],
      "operations.files",
    );
  }
  let authority: RequestWriteAuthority;
  try {
    authority = parseRequestWriteAuthority(dossier.authority);
  } catch {
    mismatch("Invalid independent source owner decisions", "authority");
  }
  if (
    canonical(authority) !== canonical(dossier.authority) ||
    command.authorityRef.kind !== authority.kind ||
    canonical(requestWriteAuthorityDestination(authority)) !==
      canonical(command.destination) ||
    await requestWriteAuthorityDigest(authority) !==
      command.authorityRef.digest
  ) {
    mismatch(
      "Authority reference or destination differs",
      "command.authorityRef",
    );
  }
  // A delegated or creation-grant decision approves one change; it never
  // accepts a proposal of new instructions.
  if (
    dossier.decision.kind === "accept-proposal" &&
    (authority.kind !== "request-source-owner-authority" ||
      !dossier.decision.decisionAuthorityExercise ||
      canonical(dossier.decision.decisionAuthorityExercise) !==
        canonical(authority.acceptance.exercise))
  ) {
    mismatch(
      "Acceptance exercise differs from independent owner decision",
      "decision.decisionAuthorityExercise",
    );
  }
  if (
    dossier.decision.kind !== "accept-proposal" &&
    (dossier.decision.approval.adoptedPin?.digest !==
        requestWriteAuthorityPrior(authority).version.digest ||
      dossier.decision.approval.adoptedPin?.repositoryVersion !==
        requestWriteAuthorityPrior(authority).version.repositoryVersion)
  ) {
    mismatch(
      "Source authority prior pin differs from native decision",
      "authority.acceptance.priorModel",
    );
  }
  const { intentDigest: _intent, v: _v, ...intent } = command;
  if (await modelWriteIntentDigestV2(intent) !== command.intentDigest) {
    mismatch("Intent digest differs", "command.intentDigest");
  }
  // Private validation view only. Never returned, enqueued or published: v1's
  // existing payload-coherence gate knows neither a Request nor its authority.
  const { destination: _target, authorityRef: _authorityRef, ...legacyIntent } =
    intent;
  const legacy: ModelWriteDossier = {
    v: 1,
    command: {
      v: 1,
      ...legacyIntent,
      intentDigest: await modelWriteIntentDigest(legacyIntent),
    },
    operations: dossier.operations,
    decision: dossier.decision,
  };
  await assertModelWriteDossier(legacy);
  const sourceDigest = dossier.operations.kind === "host-edits"
    ? dossier.operations.journal.baseSourceDigest
    : dossier.operations.files.baseSourceDigest;
  if (
    sourceDigest !== command.destination.expectedAdmittedSource.sourceDigest
  ) {
    mismatch(
      "Operations source differs from admitted destination",
      "destination.expectedAdmittedSource.sourceDigest",
    );
  }
  if (dossier.decision.kind === "accept-proposal") {
    if (dossier.decision.expectedVersion !== command.approvedBase.version) {
      mismatch(
        "Scoped proposal requires exact approved expectedVersion",
        "decision.expectedVersion",
      );
    }
    return;
  }
  if (dossier.operations.kind !== "host-edits") {
    mismatch(
      "Approval requires its captured host-edit journal",
      "operations.kind",
    );
  }
  const approval = dossier.decision.approval;
  if (
    !approval || !Array.isArray(approval.edits) ||
    approval.edits.length !== 0 ||
    !approval.adoptedPin ||
    approval.adoptedPin.repositoryVersion !==
      (requestWriteAuthorityHasMemberPin(authority)
        ? requestWriteAuthorityPrior(authority).version.repositoryVersion
        : command.approvedBase.version) ||
    !isSha256Hex(approval.adoptedPin.digest) ||
    approval.baseModelDigest !== approval.adoptedPin.digest ||
    !Number.isSafeInteger(approval.baseRevision) || approval.baseRevision < 0
  ) {
    mismatch(
      "Approval must retain the exact original pin and unfilled edits",
      "decision.approval",
    );
  }
  try {
    if (publicationSourceVersion(approval) !== command.approvedBase.version) {
      mismatch("Approved publication source differs", "decision.approval");
    }
  } catch (error) {
    if (error instanceof ChangePublicationError) {
      mismatch("Approval source evidence is inconsistent", "decision.approval");
    }
    throw error;
  }
  if (dossier.decision.kind === "approved-change") {
    const change = dossier.decision.change;
    const recordedApproval = dossier.decision.approval;
    const source = recordedApproval.approvedSourceBase;
    // New scoped commands need captured source evidence; do not manufacture
    // optional historical fields or assume a missing execution/source pin.
    if (
      !source || !change.diff || !change.baseModelDigest ||
      change.baseModelDigest !== approval.adoptedPin.digest ||
      source.repositoryVersion !== command.approvedBase.version ||
      source.sourceDigest !== sourceDigest ||
      source.modelDigest !== approval.adoptedPin.digest
    ) {
      mismatch(
        "Approved change lacks the exact captured source/pin",
        "decision.approval.approvedSourceBase",
      );
    }
    try {
      assertPublicationMatches(change, recordedApproval);
    } catch (error) {
      if (error instanceof ChangePublicationError) {
        mismatch(
          "Approval differs from the captured change",
          "decision.approval",
        );
      }
      throw error;
    }
  }
}

/** Snapshot the unknown durable envelope BEFORE the first await. The returned
 * validated value owns its data; input aliases can neither change the check nor
 * be mistaken for the returned exact dossier. This confers no write authority. */
export async function parseModelWriteDossierV2(
  value: unknown,
): Promise<ModelWriteDossierV2> {
  const snapshot = structuredClone(value);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    invalid("Expected dossier", "dossier");
  }
  await validateOwnedDossierV2(snapshot as ModelWriteDossierV2);
  return snapshot as ModelWriteDossierV2;
}
export async function parseVersionedModelWriteDossier(
  value: unknown,
): Promise<VersionedModelWriteDossier> {
  if (
    value && typeof value === "object" && !Array.isArray(value) &&
    Reflect.get(value, "v") === 2
  ) {
    return Reflect.get(value, "kind") ===
        "software-evolution-scoped-publication"
      ? await parseScopedSoftwareWriteDossier(value)
      : await parseModelWriteDossierV2(value);
  }
  const snapshot = structuredClone(value);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    invalid("Expected dossier", "dossier");
  }
  await assertModelWriteDossier(snapshot as ModelWriteDossier);
  return snapshot as ModelWriteDossier;
}
export async function modelWriteDossierDigestV2(
  dossier: ModelWriteDossierV2,
): Promise<string> {
  return await canonicalDigest(await parseModelWriteDossierV2(dossier));
}

/** Caller supplies a server-resolved expected destination, never a UI default.
 * Legacy commands have no target bytes: they are valid ONLY for Main. */
export function assertModelWriteDestinationMatches(
  value: VersionedModelWriteCommand,
  expected: RequestModelWriteDestination | {
    readonly kind: "main";
    readonly repositoryId: string;
  },
): void {
  const command = parseVersionedModelWriteCommand(value);
  if (command.v === 1) {
    if (
      expected.kind !== "main" || expected.repositoryId !== command.repositoryId
    ) mismatch("Legacy write is Main-only", "destination");
  } else if (
    expected.kind !== "request" ||
    canonical(command.destination) !==
      canonical(parseRequestModelWriteDestination(expected))
  ) mismatch("Resolved destination differs", "destination");
}

/** Existing queue semantics, expressed purely for future adapters: identity is
 * repository + commandId, never repository + destination + commandId. */
export async function assertModelWriteReplayMatches(
  accepted: VersionedModelWriteCommand,
  retry: VersionedModelWriteCommand,
): Promise<void> {
  const left = parseVersionedModelWriteCommand(accepted),
    right = parseVersionedModelWriteCommand(retry);
  if (
    left.repositoryId !== right.repositoryId ||
    left.commandId !== right.commandId ||
    await canonicalDigest(left) !== await canonicalDigest(right)
  ) mismatch("Command identity or exact intent conflicts", "commandId");
}

/** Server-side builder from captured durable inputs, not a public DTO factory.
 * No source visibility/admission/grant is inferred by this pure function. */
export async function buildModelWriteDossierV2(input: {
  readonly repositoryId: string;
  readonly commandId: string;
  readonly kind: ModelWriteCommandV2["kind"];
  readonly destination: RequestModelWriteDestination;
  readonly authority: RequestWriteAuthority;
  readonly operations: ModelWriteDossierV2["operations"];
  readonly decision: ModelWriteDossierV2["decision"];
  readonly recipeDigest: string;
}): Promise<ModelWriteDossierV2> {
  const captured = structuredClone(input);
  const destination = parseRequestModelWriteDestination(captured.destination);
  const authority = parseRequestWriteAuthority(captured.authority);
  const authorityRef = {
    kind: authority.kind,
    digest: await requestWriteAuthorityDigest(authority),
  };
  const intent = {
    repositoryId: captured.repositoryId,
    commandId: captured.commandId,
    kind: captured.kind,
    approvedBase: destination.expectedAdmittedSource.source,
    operationsRef: {
      digest: await modelWriteOperationsDigest(captured.operations),
    },
    decisionRef: {
      id: captured.commandId,
      digest: await modelWriteDecisionDigest(captured.decision),
    },
    recipeDigest: captured.recipeDigest,
    destination,
    authorityRef,
  };
  const dossier: ModelWriteDossierV2 = {
    v: 2,
    authority,
    command: {
      v: 2,
      ...intent,
      intentDigest: await modelWriteIntentDigestV2(intent),
    },
    operations: captured.operations,
    decision: captured.decision,
  };
  return await parseModelWriteDossierV2(dossier);
}
