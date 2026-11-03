import type { MemoryContent } from "../../../domain/memory/entities/memory-record.ts";

export interface MemoryProvenancePort {
  /** Resolve decision, source and outcome references in this exact local scope.
   * Formatting or an agent's textual assertion is not proof of provenance. */
  verify(ownerId: string, content: MemoryContent): Promise<boolean>;
}
