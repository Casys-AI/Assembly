CREATE TABLE "SavedSystem" (
  "id" TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "systemId" TEXT NOT NULL,
  "executionSpaceId" TEXT NOT NULL,
  "saveKey" TEXT NOT NULL,
  "commandDigest" TEXT NOT NULL,
  "metadata" TEXT NOT NULL,
  "capture" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL,
  "manifest" TEXT,
  "digest" TEXT,
  "issues" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY ("projectId", "systemId", "executionSpaceId") REFERENCES "ExecutionSpace" ("projectId", "systemId", "executionSpaceId") ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE ("projectId", "systemId", "executionSpaceId", "saveKey")
);
CREATE INDEX "SavedSystem_scope_createdAt_idx" ON "SavedSystem" ("projectId", "systemId", "executionSpaceId", "createdAt");
