-- PG-3 reference SQL adopted as migration 20261027000002_model_write_queue.
-- Keep physical fields/constraints synchronized with the canonical schema and
-- src/adapters/model/repository/writing/postgres-write-queue.ts.
-- Qualification context: PostgreSQL 18.4, Prisma 7.10.1, Deno 2.9.7.
-- Unqualified identifiers on purpose: the migration runner / test fixture
-- sets search_path to the target schema (same convention as the PG-1
-- foundation migration loaded by test/support/postgres.ts). The adapter
-- never rely on search_path: it uses postgresQualifiedTable identifiers.
-- PG-1 table-name convention ("SourceRepository") is assumed for the FK
-- targets; verify against the generated PG-1 migration before applying.

CREATE TABLE "ModelWriteRepositoryHead" (
    project_id    TEXT   NOT NULL,
    system_id     TEXT   NOT NULL,
    repository_id TEXT   NOT NULL,
    next_seq      BIGINT NOT NULL DEFAULT 1,
    CONSTRAINT "ModelWriteRepositoryHead_pkey"
        PRIMARY KEY (project_id, system_id, repository_id),
    CONSTRAINT "ModelWriteRepositoryHead_next_seq_positive"
        CHECK (next_seq BETWEEN 1 AND 9007199254740991),
    CONSTRAINT "ModelWriteRepositoryHead_repository_fk"
        FOREIGN KEY (project_id, system_id, repository_id)
        REFERENCES "SourceRepository" ("projectId", "systemId", "repositoryId")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ModelWriteCommand" (
    project_id        TEXT NOT NULL,
    system_id         TEXT NOT NULL,
    repository_id     TEXT NOT NULL,
    command_id        TEXT NOT NULL,
    seq               BIGINT NOT NULL,
    command_digest    TEXT NOT NULL,
    dossier_digest    TEXT NOT NULL,
    command_json      TEXT NOT NULL,
    dossier_json      TEXT NOT NULL,
    state             TEXT NOT NULL,
    enqueued_at       TIMESTAMPTZ(3) NOT NULL,
    updated_at        TIMESTAMPTZ(3) NOT NULL,
    attempts          BIGINT NOT NULL DEFAULT 0,
    owner             TEXT,
    fence             BIGINT NOT NULL DEFAULT 0,
    lease_expires_at  TIMESTAMPTZ(3),
    published_version TEXT,
    last_error_json   TEXT,
    CONSTRAINT "ModelWriteCommand_pkey"
        PRIMARY KEY (project_id, system_id, repository_id, command_id),
    CONSTRAINT "ModelWriteCommand_seq_key"
        UNIQUE (project_id, system_id, repository_id, seq),
    CONSTRAINT "ModelWriteCommand_repository_fk"
        FOREIGN KEY (project_id, system_id, repository_id)
        REFERENCES "SourceRepository" ("projectId", "systemId", "repositoryId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ModelWriteCommand_state_known"
        CHECK (state IN ('queued', 'preparing', 'prepared', 'publishing',
                         'published', 'retryable', 'needs-decision',
                         'refused')),
    CONSTRAINT "ModelWriteCommand_nonnegative"
        CHECK (seq BETWEEN 1 AND 9007199254740991 AND
               attempts BETWEEN 0 AND 9007199254740991 AND
               fence BETWEEN 0 AND 9007199254740991),
    CONSTRAINT "ModelWriteCommand_active_owner"
        CHECK (state NOT IN ('preparing', 'prepared', 'publishing')
               OR (owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX "ModelWriteCommand_fifo_idx"
    ON "ModelWriteCommand" (project_id, system_id, repository_id, state, seq);
CREATE INDEX "ModelWriteCommand_lease_idx"
    ON "ModelWriteCommand" (project_id, system_id, state, lease_expires_at);

-- Immutable publication intent, independent from mutable claim/settlement fields.
CREATE FUNCTION assembly_preserve_model_write_intent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.project_id, NEW.system_id, NEW.repository_id, NEW.command_id,
         NEW.seq, NEW.command_digest, NEW.dossier_digest, NEW.command_json,
         NEW.dossier_json, NEW.enqueued_at)
    IS DISTINCT FROM
     ROW(OLD.project_id, OLD.system_id, OLD.repository_id, OLD.command_id,
         OLD.seq, OLD.command_digest, OLD.dossier_digest, OLD.command_json,
         OLD.dossier_json, OLD.enqueued_at) THEN
    RAISE EXCEPTION 'Assembly model-write intent is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ModelWriteCommand_preserve_intent" BEFORE UPDATE ON "ModelWriteCommand"
  FOR EACH ROW EXECUTE FUNCTION assembly_preserve_model_write_intent();
