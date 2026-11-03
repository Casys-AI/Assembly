import type { CompiledModel } from "../../../../../domain/model/records/compiled-model.ts";
import type { ModelRevision } from "../../../../../domain/model/records/revision.ts";
import type { RequestModelWriteDestination } from "../../../../../domain/model/editing/request-write-destination.ts";
import type { ScopedSoftwareEvolutionDossierV2 } from "../../../evolution/scoped-software-dossier.ts";
import type { ScopedSoftwareSourceAdmissionV2 } from "../../../source-admission/scoped-software-source-admission.ts";
import type { ScopedSoftwareWriteDossierV2 } from "../../scoped-software-write.ts";
import type { WriteLease } from "./model-write-queue.port.ts";

/** Closed software evidence; never a human source-owner envelope. */
export interface ScopedSoftwareSourcePublicationContext {
  readonly dossier: ScopedSoftwareWriteDossierV2;
  readonly admission: ScopedSoftwareSourceAdmissionV2;
  readonly evolution: ScopedSoftwareEvolutionDossierV2;
}
export interface ScopedSoftwareSourceWriteFacade {
  readonly destination: RequestModelWriteDestination;
  /** Exact software Git anchors and D2 settlement; no old grant revalidation.
   * Without a lease this is a read/verify operation only. */
  recover(lease?: WriteLease): Promise<ModelRevision | null>;
  /** Current durable publishing state, grants and barriers must be checked
   * under the queue guard before the real Git effect. */
  accept(lease: WriteLease): Promise<ModelRevision>;
}
export interface ScopedSoftwareSourceWriteResolver {
  resolve(
    dossier: ScopedSoftwareWriteDossierV2,
  ): Promise<ScopedSoftwareSourceWriteFacade>;
}

/** Host joins current runtime/source rights and durable queue/D2 boundaries.
 * Historical settlement verifies past evidence without reviving old grants. */
export interface ScopedSoftwareSourcePublicationProtocol {
  assertNewEffect(
    evolution: ScopedSoftwareEvolutionDossierV2,
    dossier: ScopedSoftwareWriteDossierV2,
    before: ModelRevision,
    after: CompiledModel,
  ): Promise<void>;
  guardNewPublication(
    lease: WriteLease,
    context: ScopedSoftwareSourcePublicationContext,
    gitEffect: () => Promise<ModelRevision>,
  ): Promise<ModelRevision>;
  settleHistorical(
    context: ScopedSoftwareSourcePublicationContext,
    lease?: WriteLease,
  ): Promise<void>;
}
export interface ScopedSoftwareSourceWriteOptions {
  readonly evolution: ScopedSoftwareEvolutionDossierV2;
  readonly dossier: ScopedSoftwareWriteDossierV2;
  readonly protocol: ScopedSoftwareSourcePublicationProtocol;
}
