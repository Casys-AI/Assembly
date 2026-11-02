-- Additive only. No existing source/runtime/admission rows are migrated.
CREATE TABLE "SpaceOpening" (
  "id" TEXT PRIMARY KEY, "projectId" TEXT NOT NULL, "systemId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL, "openingKey" TEXT NOT NULL, "commandDigest" TEXT NOT NULL,
  "commandJson" TEXT NOT NULL, "caseId" TEXT NOT NULL, "caseNumber" BIGINT NOT NULL,
  "executionSpaceId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
  "initialContributionId" TEXT NOT NULL, "baseJson" TEXT, "baseDigest" TEXT,
  "phase" TEXT NOT NULL DEFAULT 'allocated', "admissionId" TEXT,
  "issuesJson" TEXT NOT NULL DEFAULT '[]', "revision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpaceOpening_phase" CHECK ("phase" IN ('allocated','source-selected','branch-ready','runtime-ready','admitted','dispatched')),
  CONSTRAINT "SpaceOpening_base_pair" CHECK (("baseJson" IS NULL) = ("baseDigest" IS NULL)),
  CONSTRAINT "SpaceOpening_selected" CHECK ("phase" = 'allocated' OR "baseJson" IS NOT NULL),
  CONSTRAINT "SpaceOpening_admitted" CHECK ("phase" NOT IN ('admitted','dispatched') OR "admissionId" IS NOT NULL),
  CONSTRAINT "SpaceOpening_revision" CHECK ("revision" >= 0 AND "caseNumber" > 0),
  CONSTRAINT "SpaceOpening_system_fkey" FOREIGN KEY ("projectId","systemId") REFERENCES "AssemblySystem"("projectId","systemId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SpaceOpening_case_fkey" FOREIGN KEY ("projectId","systemId","caseId") REFERENCES "CaseIdentity"("projectId","systemId","caseId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SpaceOpening_space_fkey" FOREIGN KEY ("projectId","systemId","executionSpaceId") REFERENCES "ExecutionSpace"("projectId","systemId","executionSpaceId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SpaceOpening_projectId_systemId_ownerId_openingKey_key" ON "SpaceOpening"("projectId","systemId","ownerId","openingKey");
CREATE UNIQUE INDEX "SpaceOpening_projectId_systemId_executionSpaceId_key" ON "SpaceOpening"("projectId","systemId","executionSpaceId");
CREATE UNIQUE INDEX "SpaceOpening_projectId_systemId_caseId_key" ON "SpaceOpening"("projectId","systemId","caseId");
CREATE UNIQUE INDEX "SpaceOpening_scoped_owner_key" ON "SpaceOpening"("projectId","systemId","id","executionSpaceId","ownerId");

CREATE TABLE "SpaceControlCredential" (
  "id" TEXT PRIMARY KEY, "projectId" TEXT NOT NULL, "systemId" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "ownerId" TEXT NOT NULL, "parentCapabilityId" TEXT,
  "parentKind" TEXT, "authorityJson" TEXT NOT NULL, "secretHash" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0, "status" TEXT NOT NULL DEFAULT 'active',
  "expiresAt" TIMESTAMPTZ(3) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpaceCredential_kind" CHECK (
    ("kind"='capability' AND "parentCapabilityId" IS NULL AND "parentKind" IS NULL) OR
    ("kind"='session' AND "parentCapabilityId" IS NOT NULL AND "parentKind"='capability')),
  CONSTRAINT "SpaceCredential_status" CHECK ("status" IN ('active','revoked') AND "revision">=0),
  CONSTRAINT "SpaceCredential_hash" CHECK ("secretHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "SpaceControlCredential_system_fkey" FOREIGN KEY ("projectId","systemId") REFERENCES "AssemblySystem"("projectId","systemId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SpaceControlCredential_secretHash_key" ON "SpaceControlCredential"("secretHash");
CREATE UNIQUE INDEX "SpaceControlCredential_scoped_owner_kind_key" ON "SpaceControlCredential"("projectId","systemId","id","ownerId","kind");
CREATE INDEX "SpaceControlCredential_parent_idx" ON "SpaceControlCredential"("projectId","systemId","parentCapabilityId");
ALTER TABLE "SpaceControlCredential" ADD CONSTRAINT "SpaceCredential_parent_fkey"
  FOREIGN KEY ("projectId","systemId","parentCapabilityId","ownerId","parentKind")
  REFERENCES "SpaceControlCredential"("projectId","systemId","id","ownerId","kind") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SpaceExecutionAdmission" (
  "id" TEXT PRIMARY KEY, "projectId" TEXT NOT NULL, "systemId" TEXT NOT NULL,
  "executionSpaceId" TEXT NOT NULL, "openingId" TEXT NOT NULL, "ownerId" TEXT NOT NULL,
  "capabilityId" TEXT NOT NULL, "capabilityKind" TEXT NOT NULL DEFAULT 'capability',
  "capabilityRevision" INTEGER NOT NULL, "baseDigest" TEXT NOT NULL,
  "authorityJson" TEXT NOT NULL, "permissionsJson" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0, "status" TEXT NOT NULL DEFAULT 'active',
  "expiresAt" TIMESTAMPTZ(3) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpaceAdmission_status" CHECK ("status" IN ('active','revoked') AND "revision">=0 AND "capabilityRevision">=0),
  CONSTRAINT "SpaceAdmission_capability_kind" CHECK ("capabilityKind"='capability'),
  CONSTRAINT "SpaceExecutionAdmission_opening_fkey" FOREIGN KEY ("projectId","systemId","openingId","executionSpaceId","ownerId") REFERENCES "SpaceOpening"("projectId","systemId","id","executionSpaceId","ownerId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SpaceExecutionAdmission_space_fkey" FOREIGN KEY ("projectId","systemId","executionSpaceId") REFERENCES "ExecutionSpace"("projectId","systemId","executionSpaceId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SpaceExecutionAdmission_capability_fkey" FOREIGN KEY ("projectId","systemId","capabilityId","ownerId","capabilityKind") REFERENCES "SpaceControlCredential"("projectId","systemId","id","ownerId","kind") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SpaceExecutionAdmission_openingId_key" ON "SpaceExecutionAdmission"("openingId");
CREATE UNIQUE INDEX "SpaceExecutionAdmission_projectId_systemId_executionSpaceId_key" ON "SpaceExecutionAdmission"("projectId","systemId","executionSpaceId");
CREATE INDEX "SpaceExecutionAdmission_capability_idx" ON "SpaceExecutionAdmission"("projectId","systemId","capabilityId");

CREATE FUNCTION "assembly_request_opening_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id",NEW."projectId",NEW."systemId",NEW."ownerId",NEW."openingKey",NEW."commandDigest",NEW."commandJson",NEW."caseId",NEW."caseNumber",NEW."executionSpaceId",NEW."branchId",NEW."initialContributionId",NEW."createdAt") IS DISTINCT FROM ROW(OLD."id",OLD."projectId",OLD."systemId",OLD."ownerId",OLD."openingKey",OLD."commandDigest",OLD."commandJson",OLD."caseId",OLD."caseNumber",OLD."executionSpaceId",OLD."branchId",OLD."initialContributionId",OLD."createdAt") OR
     (OLD."baseJson" IS NOT NULL AND ROW(NEW."baseJson",NEW."baseDigest") IS DISTINCT FROM ROW(OLD."baseJson",OLD."baseDigest")) OR
     (OLD."admissionId" IS NOT NULL AND NEW."admissionId" IS DISTINCT FROM OLD."admissionId") OR
     NEW."revision" <> OLD."revision"+1 OR
     array_position(ARRAY['allocated','source-selected','branch-ready','runtime-ready','admitted','dispatched'],NEW."phase") < array_position(ARRAY['allocated','source-selected','branch-ready','runtime-ready','admitted','dispatched'],OLD."phase") THEN
    RAISE EXCEPTION 'Immutable Request opening selection';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "SpaceOpening_immutable" BEFORE UPDATE ON "SpaceOpening" FOR EACH ROW EXECUTE FUNCTION "assembly_request_opening_immutable"();
CREATE FUNCTION "assembly_space_control_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['revision','status']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','status']) OR
     NEW."revision" <> OLD."revision"+1 OR OLD."status"='revoked' OR NEW."status"<>'revoked' THEN
    RAISE EXCEPTION 'Immutable space control identity or revoked permission';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "SpaceControlCredential_immutable" BEFORE UPDATE ON "SpaceControlCredential" FOR EACH ROW EXECUTE FUNCTION "assembly_space_control_immutable"();
CREATE TRIGGER "SpaceExecutionAdmission_immutable" BEFORE UPDATE ON "SpaceExecutionAdmission" FOR EACH ROW EXECUTE FUNCTION "assembly_space_control_immutable"();
