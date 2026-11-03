-- Independent physical provider-call evidence; no work-ledger transaction or FK.
CREATE TABLE "ProviderCallObservation" (
  "projectId" TEXT NOT NULL,
  "systemId" TEXT NOT NULL,
  "observationId" TEXT NOT NULL,
  "executionSpaceId" TEXT,
  "payload" TEXT NOT NULL,
  CONSTRAINT "ProviderCallObservation_pkey" PRIMARY KEY ("projectId", "systemId", "observationId")
);
CREATE INDEX "ProviderCallObservation_scope_idx"
  ON "ProviderCallObservation" ("projectId", "systemId", "executionSpaceId", "observationId");
