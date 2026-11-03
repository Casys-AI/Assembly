import type { MemoryRecord } from "../../../domain/memory/entities/memory-record.ts";
import type { MemoryExpectedVersion } from "../../../domain/memory/governed-memory-promotion.ts";

export interface MemoryStorePort {
  load(ownerId: string, id: string): Promise<MemoryRecord | null>;
  list(ownerId: string): Promise<MemoryRecord[]>;
  /** Atomic compare-and-swap of both fields; null means create only. The same
   * owner/caller/invocation must never commit a different note or requestDigest. */
  save(
    record: MemoryRecord,
    expected: MemoryExpectedVersion | null,
  ): Promise<void>;
}
