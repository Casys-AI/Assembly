-- CreateTable
CREATE TABLE "EvolutionDossier" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,

    CONSTRAINT "EvolutionDossier_pkey" PRIMARY KEY ("projectId","systemId","id")
);

-- CreateTable
CREATE TABLE "EvolutionTargetBarrier" (
    "projectId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "dossierId" TEXT NOT NULL,

    CONSTRAINT "EvolutionTargetBarrier_pkey" PRIMARY KEY ("projectId","systemId","repositoryId","operatorId")
);

-- CreateIndex
CREATE INDEX "EvolutionDossier_pending_idx" ON "EvolutionDossier"("projectId", "systemId", "repositoryId", "status");

-- CreateIndex
CREATE INDEX "EvolutionDossier_recent_idx" ON "EvolutionDossier"("projectId", "systemId", "repositoryId", "updatedAt" DESC, "id");

-- CreateIndex
CREATE UNIQUE INDEX "EvolutionDossier_repository_id_key" ON "EvolutionDossier"("projectId", "systemId", "repositoryId", "id");

-- CreateIndex
CREATE INDEX "EvolutionTargetBarrier_dossier_idx" ON "EvolutionTargetBarrier"("projectId", "systemId", "repositoryId", "dossierId");

-- AddForeignKey
ALTER TABLE "EvolutionDossier" ADD CONSTRAINT "EvolutionDossier_repository_fk" FOREIGN KEY ("projectId", "systemId", "repositoryId") REFERENCES "SourceRepository"("projectId", "systemId", "repositoryId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvolutionTargetBarrier" ADD CONSTRAINT "EvolutionTargetBarrier_repository_fk" FOREIGN KEY ("projectId", "systemId", "repositoryId") REFERENCES "SourceRepository"("projectId", "systemId", "repositoryId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvolutionTargetBarrier" ADD CONSTRAINT "EvolutionTargetBarrier_dossier_fk" FOREIGN KEY ("projectId", "systemId", "repositoryId", "dossierId") REFERENCES "EvolutionDossier"("projectId", "systemId", "repositoryId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EvolutionDossier" ADD CONSTRAINT "EvolutionDossier_revision_check"
  CHECK ("revision" BETWEEN 0 AND 9007199254740991);
ALTER TABLE "EvolutionDossier" ADD CONSTRAINT "EvolutionDossier_status_check"
  CHECK ("status" IN ('prepared', 'accepted', 'armed', 'publishing',
    'published-awaiting-adoption', 'adopted', 'cancelled', 'superseded',
    'refused', 'needs-decision'));

CREATE FUNCTION assembly_preserve_evolution_dossier_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."projectId", NEW."systemId", NEW."repositoryId", NEW."id")
    IS DISTINCT FROM ROW(OLD."projectId", OLD."systemId", OLD."repositoryId", OLD."id") THEN
    RAISE EXCEPTION 'Assembly evolution dossier scope is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "EvolutionDossier_preserve_scope" BEFORE UPDATE ON "EvolutionDossier"
  FOR EACH ROW EXECUTE FUNCTION assembly_preserve_evolution_dossier_scope();

CREATE FUNCTION assembly_preserve_evolution_barrier_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Assembly evolution barrier identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "EvolutionTargetBarrier_preserve_identity" BEFORE UPDATE ON "EvolutionTargetBarrier"
  FOR EACH ROW EXECUTE FUNCTION assembly_preserve_evolution_barrier_identity();

-- Barrier claims/releases and dossier status update happen in one application
-- transaction. No immediate cross-row status trigger may reject the intermediate
-- claim-before-status or release-before-terminal ordering.
