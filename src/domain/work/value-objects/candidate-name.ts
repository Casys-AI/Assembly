import { sha256Bytes } from "../../primitives/sha256-bytes.ts";
import { assert } from "../../primitives/assert.ts";
import type { Candidate } from "../candidates.ts";

export async function candidateName(candidate: Candidate): Promise<string> {
  assert(
    candidate.id && /^[a-f0-9]{64}$/i.test(candidate.digest),
    "Candidate identity/digest missing",
  );
  return "tool_" + (await sha256Bytes(candidate.id)).slice(0, 24);
}
