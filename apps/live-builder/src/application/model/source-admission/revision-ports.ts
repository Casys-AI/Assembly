import type { SpaceController } from "../../../domain/work/request-spaces.ts";
import type { RequestModelWriteDestination } from "../../../domain/model/editing/request-write-destination.ts";
import type { RequestSourceOwnerPhaseBinding } from "./request-source-owner.ts";
import type { ProposalRecord } from "../../../domain/model/records/revision.ts";
import type { RequestSourceTarget } from "../publication/ports/out/request-source-publication.port.ts";
import type { ModelWriteQueuePort } from "../publication/ports/out/model-write-queue.port.ts";
import type { ModelWriteSubmissionPort } from "../publication/submission.ts";
import type { RequestSourceOwnerAuthorization } from "./owner-authorization.ts";

/** Server-owned immutable locator, checked before reading scoped proposal data.
 * Historical admitted source A0 is recovered from its stored phase, not A1. */
export type RequestSourceProposalLocator = Omit<
  RequestModelWriteDestination,
  "expectedAdmittedSource"
>;
export interface RequestSourceStoredProposal {
  readonly record: ProposalRecord;
  readonly authority: RequestSourceOwnerPhaseBinding<"proposal">;
  readonly destination: RequestModelWriteDestination;
}
export interface RequestSourceRevisionAccessPort {
  /** Current control session + immutable owned Case join; allow closed history. */
  authorizeRead(secret: string, caseId: string): Promise<SpaceController>;
  assertOwnedDestination(
    controller: SpaceController,
    caseId: string,
    destination: RequestModelWriteDestination,
  ): Promise<void>;
  revalidateRead(controller: SpaceController, caseId: string): Promise<void>;
}
export interface RequestSourceRevisionsOptions {
  readonly repositoryId: string;
  readonly access: RequestSourceRevisionAccessPort;
  readonly authorization: Pick<
    RequestSourceOwnerAuthorization,
    | "captureProposal"
    | "captureAcceptance"
    | "revalidateProposal"
    | "revalidateAcceptance"
  >;
  readonly targetForProposal: (
    binding: RequestSourceOwnerPhaseBinding<"proposal">,
  ) => Promise<RequestSourceTarget>;
  /** Owned static locator first, then original stored A0 + D2 predecessor join.
   * No Main proposal lookup and no fresh current-head substitution. */
  readonly readProposal: (
    controller: SpaceController,
    caseId: string,
    proposalId: string,
  ) => Promise<RequestSourceStoredProposal | null>;
  readonly queue: Required<
    Pick<ModelWriteQueuePort, "get" | "getDossier" | "enqueue">
  >;
  readonly writer: Pick<
    ModelWriteSubmissionPort,
    "repositoryId" | "recipeDigest" | "resume"
  >;
}
