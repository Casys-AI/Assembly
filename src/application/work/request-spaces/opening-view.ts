import type {
  OpeningIdentity,
  OpeningPhase,
  OpeningRecord,
} from "../../../domain/work/request-spaces/opening.ts";

export interface OpeningView extends OpeningIdentity {
  phase: OpeningPhase;
  revision: number;
  sourceVersion: string | null;
  release: { id: string; digest: string } | null;
  admissionId: string | null;
  issues: string[];
}

export function openingView(record: OpeningRecord): OpeningView {
  return {
    id: record.id,
    caseId: record.caseId,
    caseNumber: record.caseNumber,
    executionSpaceId: record.executionSpaceId,
    branchId: record.branchId,
    initialContributionId: record.initialContributionId,
    phase: record.phase,
    revision: record.revision,
    sourceVersion: record.base?.manifest.source?.sourceVersion ?? null,
    release: record.base?.release ?? null,
    admissionId: record.admissionId,
    issues: [...record.issues],
  };
}
