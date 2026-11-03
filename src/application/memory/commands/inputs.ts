import type { MemoryContent } from "../../../domain/memory/entities/memory-record.ts";
import type { MemoryExpectedVersion } from "../../../domain/memory/governed-memory-promotion.ts";

export interface MemoryCapture {
  id: string;
  content: MemoryContent;
}

export interface MemoryRevision extends MemoryCapture {
  expected: MemoryExpectedVersion;
}

export interface MemoryReview {
  id: string;
  expected: MemoryExpectedVersion;
  decision: "admit" | "request-revision" | "reject";
  reason: string;
}

export interface MemoryWithdrawal {
  id: string;
  expected: MemoryExpectedVersion;
  reason: string;
}
