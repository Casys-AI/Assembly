import { isSessionlessRequestAuthority } from "./request-delegated-authority.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  MAX_TOTAL_BYTES,
  modelSourceDigest,
  validateModelSources,
} from "../../../domain/model/value-objects/sources.ts";
import {
  exactSourceVersion,
  RequestSpaceError,
  type SpaceController,
} from "../../../domain/work/request-spaces.ts";
import {
  parseRequestSourceOwnerAuthority,
  parseRequestSourceOwnerPhaseBinding,
} from "./request-source-owner.ts";
import { parseRequestModelWriteDestination } from "../../../domain/model/editing/request-write-destination.ts";
import {
  buildModelWriteDossierV2,
  type ModelWriteDossierV2,
  parseVersionedModelWriteDossier,
} from "../publication/write-command-v2.ts";
import type {
  ModelRevision,
  ProposalRecord,
} from "../../../domain/model/records/revision.ts";
import {
  buildAcceptProposalCommand,
  ModelWriteQueueError,
} from "../publication/write-queue.ts";
import type {
  RequestSourceRevisionsOptions,
  RequestSourceStoredProposal,
} from "./revision-ports.ts";

export interface ProposeRequestSourceRevision {
  readonly caseId: string;
  readonly expectedVersion: string;
  readonly changes: readonly {
    readonly path: string;
    readonly text: string | null;
  }[];
  readonly reason: string;
}
interface RequestSourceCommandHandle {
  readonly caseId: string;
  readonly commandId: string;
}
type RequestSourceProposalView =
  & Pick<
    ProposalRecord,
    | "id"
    | "author"
    | "reason"
    | "baseVersion"
    | "createdAt"
    | "status"
    | "validation"
    | "sourceDigest"
    | "proposalVersion"
    | "diff"
  >
  & { readonly caseId: string };
const invalid = (): never => {
  throw new RequestSpaceError(
    "INVALID_COMMAND",
    "Invalid bounded Request source command.",
  );
};
const conflict = (): never => {
  throw new RequestSpaceError(
    "OPENING_CONFLICT",
    "The Request source command differs from its owned immutable destination.",
  );
};
function object(value: unknown, keys: string): Record<string, unknown> {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys
  ) return invalid();
  return value as Record<string, unknown>;
}
function identity(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value || value.trim() !== value ||
    value.length > 512 || [...value].some((c) => c.charCodeAt(0) < 32)
  ) invalid();
}
function ids(
  value: unknown,
  second: "proposalId" | "commandId",
): { caseId: string; id: string } {
  const input = object(
    structuredClone(value),
    ["caseId", second].sort().join(","),
  );
  identity(input.caseId);
  identity(input[second]);
  return { caseId: input.caseId, id: input[second] as string };
}
function proposeInput(
  value: ProposeRequestSourceRevision,
): ProposeRequestSourceRevision {
  const input = object(
    structuredClone(value),
    "caseId,changes,expectedVersion,reason",
  );
  identity(input.caseId);
  if (
    !exactSourceVersion(input.expectedVersion) ||
    typeof input.reason !== "string" || !input.reason.trim() ||
    input.reason.length > 4000 || input.reason.includes("\0") ||
    !Array.isArray(input.changes) || !input.changes.length ||
    input.changes.length > 64
  ) return invalid();
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const raw of input.changes) {
    const edit = object(raw, "path,text");
    identity(edit.path);
    if (
      edit.text !== null && typeof edit.text !== "string" ||
      seen.has(edit.path.toLowerCase())
    ) return invalid();
    try {
      validateModelSources({
        [edit.path]: edit.text === null ? "" : edit.text as string,
      });
    } catch {
      return invalid();
    }
    if (typeof edit.text === "string") {
      totalBytes += new TextEncoder().encode(edit.text).byteLength;
    }
    if (totalBytes > MAX_TOTAL_BYTES) return invalid();
    seen.add(edit.path.toLowerCase());
  }
  return input as unknown as ProposeRequestSourceRevision;
}
function view(
  caseId: string,
  record: ProposalRecord,
): RequestSourceProposalView {
  // Never serialize scoped principal/authority metadata as a proposal DTO.
  return structuredClone({
    caseId,
    id: record.id,
    author: record.author,
    reason: record.reason,
    baseVersion: record.baseVersion,
    createdAt: record.createdAt,
    status: record.status,
    validation: record.validation,
    sourceDigest: record.sourceDigest,
    ...(record.proposalVersion
      ? { proposalVersion: record.proposalVersion }
      : {}),
    diff: record.diff,
  });
}

/** Human instruction source revision only. The existing durable queue is the
 * sole publication state machine; accept records an intent, resume verifies its
 * eventual exact Git+D2 publication. Neither action adopts A1 into runtime R0. */
export class RequestSourceRevisions {
  constructor(private readonly options: RequestSourceRevisionsOptions) {
    if (
      !options.repositoryId ||
      options.writer.repositoryId !== options.repositoryId ||
      typeof options.queue.getDossier !== "function"
    ) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "The Request source revision writer is unavailable.",
      );
    }
  }
  private async owned(
    controller: SpaceController,
    caseId: string,
    dossier: ModelWriteDossierV2,
  ): Promise<void> {
    const command = dossier.command;
    if (
      command.repositoryId !== this.options.repositoryId ||
      command.destination.caseId !== caseId ||
      command.kind !== "accept-proposal" ||
      dossier.decision.kind !== "accept-proposal" ||
      dossier.decision.author !== "local-owner" ||
      dossier.operations.kind !== "whole-files" ||
      isSessionlessRequestAuthority(dossier.authority) ||
      dossier.authority.proposal.principal.controller.ownerId !==
        controller.ownerId ||
      dossier.authority.acceptance.principal.controller.ownerId !==
        controller.ownerId
    ) return conflict();
    await this.options.access.assertOwnedDestination(
      structuredClone(controller),
      caseId,
      structuredClone(command.destination),
    );
  }
  private async stored(
    controller: SpaceController,
    caseId: string,
    commandId: string,
  ): Promise<ModelWriteDossierV2 | null> {
    const raw = await this.options.queue.getDossier(
      this.options.repositoryId,
      commandId,
    );
    if (!raw) return null;
    const dossier = await parseVersionedModelWriteDossier(raw);
    if (
      dossier.v !== 2 || "kind" in dossier ||
      dossier.command.commandId !== commandId
    ) {
      return conflict();
    }
    await this.owned(controller, caseId, dossier);
    return dossier;
  }
  async propose(
    secret: string,
    value: ProposeRequestSourceRevision,
  ): Promise<RequestSourceProposalView> {
    const input = proposeInput(value);
    const controller = structuredClone(
      await this.options.access.authorizeRead(secret, input.caseId),
    );
    const binding = parseRequestSourceOwnerPhaseBinding(
      await this.options.authorization.captureProposal(secret, input.caseId),
      "proposal",
    );
    if (
      binding.destination.expectedAdmittedSource.source.version !==
        input.expectedVersion ||
      binding.destination.caseId !== input.caseId ||
      binding.destination.repositoryId !== this.options.repositoryId ||
      binding.principal.controller.ownerId !== controller.ownerId
    ) return conflict();
    await this.options.access.assertOwnedDestination(
      structuredClone(controller),
      input.caseId,
      structuredClone(binding.destination),
    );
    const target = await this.options.targetForProposal(
      structuredClone(binding),
    );
    if (canonical(target.destination) !== canonical(binding.destination)) {
      return conflict();
    }
    const prior = structuredClone(await target.current()),
      expected = binding.destination.expectedAdmittedSource;
    if (
      prior.version !== expected.source.version ||
      prior.sourceDigest !== expected.sourceDigest ||
      await modelSourceDigest(prior.sources) !== expected.sourceDigest
    ) return conflict();
    const sources = { ...prior.sources };
    for (const edit of input.changes) {
      if (edit.text === null) delete sources[edit.path];
      else sources[edit.path] = edit.text;
    }
    let checked: ReturnType<typeof validateModelSources>;
    try {
      checked = validateModelSources(sources);
    } catch {
      return invalid();
    }
    await this.options.authorization.revalidateProposal(
      structuredClone(binding),
    );
    await this.options.access.revalidateRead(
      structuredClone(controller),
      input.caseId,
    );
    const proposal = await target.propose({
      sources: checked,
      reason: input.reason,
      authority: binding,
    });
    if (
      proposal.baseVersion !== expected.source.version ||
      proposal.author !== "local-owner" || proposal.status !== "proposed" ||
      !proposal.proposalVersion
    ) return conflict();
    await this.options.access.revalidateRead(
      structuredClone(controller),
      input.caseId,
    );
    return view(input.caseId, proposal);
  }
  async accept(
    secret: string,
    value: { readonly caseId: string; readonly proposalId: string },
  ): Promise<RequestSourceCommandHandle> {
    const { caseId, id } = ids(value, "proposalId");
    const controller = structuredClone(
      await this.options.access.authorizeRead(secret, caseId),
    );
    // Lost ACK/reconnect/revoked original session: read-authorize the immutable
    // owned command FIRST. Never regenerate acceptance or read mutable proposal.
    if (await this.stored(controller, caseId, id)) {
      await this.options.access.revalidateRead(
        structuredClone(controller),
        caseId,
      );
      return { caseId, commandId: id };
    }
    const raw = await this.options.readProposal(
      structuredClone(controller),
      caseId,
      id,
    );
    if (!raw) return conflict();
    const proposal: RequestSourceStoredProposal = structuredClone(raw);
    const destination = parseRequestModelWriteDestination(proposal.destination);
    const phase = parseRequestSourceOwnerPhaseBinding(
      proposal.authority,
      "proposal",
    );
    if (
      destination.caseId !== caseId ||
      destination.repositoryId !== this.options.repositoryId ||
      canonical(phase.destination) !== canonical(destination) ||
      phase.principal.controller.ownerId !== controller.ownerId ||
      proposal.record.id !== id || proposal.record.author !== "local-owner" ||
      proposal.record.baseVersion !==
        destination.expectedAdmittedSource.source.version
    ) return conflict();
    await this.options.access.assertOwnedDestination(
      structuredClone(controller),
      caseId,
      structuredClone(destination),
    );
    const authority = parseRequestSourceOwnerAuthority(
      await this.options.authorization.captureAcceptance(secret, phase),
    );
    if (
      canonical(authority.proposal) !== canonical(phase) ||
      canonical(authority.acceptance.destination) !== canonical(destination)
    ) return conflict();
    const legacy = await buildAcceptProposalCommand({
      repositoryId: this.options.repositoryId,
      proposal: proposal.record,
      expectedVersion: destination.expectedAdmittedSource.source.version,
      baseSourceDigest: destination.expectedAdmittedSource.sourceDigest,
      recipeDigest: await this.options.writer.recipeDigest(),
      author: "local-owner",
      decisionAuthorityExercise: authority.acceptance.exercise,
    });
    if (
      legacy.operations.kind !== "whole-files" ||
      legacy.decision.kind !== "accept-proposal"
    ) return conflict();
    const dossier = await buildModelWriteDossierV2({
      repositoryId: this.options.repositoryId,
      commandId: id,
      kind: "accept-proposal",
      destination,
      authority,
      operations: legacy.operations,
      decision: legacy.decision,
      recipeDigest: legacy.command.recipeDigest,
    });
    await this.owned(controller, caseId, dossier);
    await this.options.authorization.revalidateAcceptance(
      structuredClone(authority),
      "accept-proposal",
    );
    await this.options.access.revalidateRead(
      structuredClone(controller),
      caseId,
    );
    try {
      await this.options.queue.enqueue(dossier);
    } catch (error) {
      // Another independent acceptance may have won while this intent was
      // prepared. Only the exact owned stored command may be returned on retry.
      if (
        !(error instanceof ModelWriteQueueError) ||
        error.code !== "WRITE_QUEUE_CONFLICT" ||
        !await this.stored(controller, caseId, id)
      ) throw error;
    }
    await this.options.access.revalidateRead(
      structuredClone(controller),
      caseId,
    );
    return { caseId, commandId: id };
  }
  async resume(
    secret: string,
    value: RequestSourceCommandHandle,
  ): Promise<ModelRevision | null> {
    const { caseId, id } = ids(value, "commandId");
    const controller = structuredClone(
      await this.options.access.authorizeRead(secret, caseId),
    );
    const dossier = await this.stored(controller, caseId, id);
    if (!dossier) {
      await this.options.access.revalidateRead(
        structuredClone(controller),
        caseId,
      );
      return null;
    }
    await this.options.access.revalidateRead(
      structuredClone(controller),
      caseId,
    );
    const revision = await this.options.writer.resume(
      id,
      undefined,
      structuredClone(dossier.command.destination),
    );
    await this.options.access.revalidateRead(
      structuredClone(controller),
      caseId,
    );
    return revision;
  }
}
