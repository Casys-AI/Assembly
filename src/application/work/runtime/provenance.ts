import type { RuntimeProvenanceRecord } from "../../../domain/work/value-objects/runtime-provenance.ts";

/** One immutable deployment record shared by all sessions in this host startup. */
export interface RuntimeProvenancePort {
  collect(): Promise<RuntimeProvenanceRecord>;
}
