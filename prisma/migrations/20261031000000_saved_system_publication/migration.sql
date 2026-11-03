-- Additive publication state; historical saves retain NULL.
ALTER TABLE "SavedSystem" ADD COLUMN "publication" TEXT;
