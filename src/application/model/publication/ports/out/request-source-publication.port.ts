import type { RequestSourceOwnerPhaseBinding } from "../../../source-admission/request-source-owner.ts";
import type { ModelSources as Sources } from "../../../../../domain/model/value-objects/sources.ts";
import type { RequestSourceAdmission } from "../../../source-admission/request-source-admission.ts";
import type {
  ModelRevision,
  ProposalRecord,
} from "../../../../../domain/model/records/revision.ts";
import type { ModelWriteDossierV2 } from "../../write-command-v2.ts";
import type { RequestModelWriteDestination } from "../../../../../domain/model/editing/request-write-destination.ts";
import type { WriteLease } from "./model-write-queue.port.ts";

/** Prepared immutable evidence only. No native handle, mutable compiler or
 * authority callback enters the SQL publication participant. */
export interface RequestSourcePublicationContext {
  readonly dossier: ModelWriteDossierV2;
  readonly admission: RequestSourceAdmission;
}

/** Server-bound facade. Resolve immutable host/opening/dossier before ANY
 * repository lookup, but do not demand fresh authority/open lifecycle until
 * after recovery has ruled out an already attested historical effect. */
export interface RequestSourceWriteFacade {
  readonly destination: RequestModelWriteDestination;
  at(version: string): Promise<ModelRevision>;
  current(): Promise<ModelRevision>;
  proposal(id: string): Promise<ProposalRecord>;
  /** Must verify exact Git proof and settle/verify D2 before returning success.
   * Missing lease means read/verify only, never historical backfill. */
  recover(lease?: WriteLease): Promise<ModelRevision | null>;
  /** New effect requires current D1 + open target + admitted A0, then the
   * mandatory same-transaction publication participant through W3. */
  accept(lease: WriteLease): Promise<ModelRevision>;
}
export interface RequestSourceWriteResolver {
  resolve(dossier: ModelWriteDossierV2): Promise<RequestSourceWriteFacade>;
}

/** Host composition joins current D1 preflight with existing queue fencing/D2.
 * This application port exposes no Prisma or arbitrary SQL callback. */
export interface RequestSourcePublicationProtocol {
  assertProposal(
    binding: RequestSourceOwnerPhaseBinding<"proposal">,
  ): Promise<void>;
  assertNewEffect(dossier: ModelWriteDossierV2): Promise<void>;
  guardNewPublication(
    lease: WriteLease,
    context: RequestSourcePublicationContext,
    gitEffect: () => Promise<ModelRevision>,
  ): Promise<ModelRevision>;
  /** Historical verified evidence only; this must not require old grant active.
   * With no lease, verify the already recorded exact D2 receipt without writes. */
  settleHistorical(
    context: RequestSourcePublicationContext,
    lease?: WriteLease,
  ): Promise<void>;
}

/** Constructed only after the server joins immutable Opening/Case/host identity.
 * These locators/hashes are evidence to verify, never a grant. */
export interface RequestSourceTargetOptions {
  readonly destination: RequestModelWriteDestination;
  readonly openingBaseDigest: string;
  readonly predecessorManifestDigest: string;
  readonly protocol: RequestSourcePublicationProtocol;
}
export interface RequestSourceTarget {
  readonly destination: RequestModelWriteDestination;
  current(): Promise<ModelRevision>;
  proposal(id: string): Promise<ProposalRecord>;
  propose(
    input: {
      sources: Sources;
      reason: string;
      authority: RequestSourceOwnerPhaseBinding<"proposal">;
    },
  ): Promise<ProposalRecord>;
  bind(dossier: ModelWriteDossierV2): Promise<RequestSourceWriteFacade>;
}

/** Git may already be committed: keep FIFO ownership recoverable until its
 * attested D2 settlement, independently of ordinary preparation retry budget. */
export class RequestSourcePublicationPending extends Error {
  readonly code = "REQUEST_SOURCE_PUBLICATION_PENDING_ADMISSION";
  constructor(override readonly cause: unknown) {
    super(
      "Request source publication remains pending exact admission settlement",
    );
    this.name = "RequestSourcePublicationPending";
  }
}
