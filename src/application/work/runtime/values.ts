import type { ClockPort } from "./ports.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import type {
  Candidate,
  ToolDraft,
} from "../../../domain/work/records/candidates.ts";
import type { Event } from "./state.ts";
import { toolDraftDigest } from "../artifacts/catalog.ts";
export async function valueDigest(value: unknown): Promise<string> {
  return await sha256(JSON.stringify(value));
}
export async function draftDigest(draft: ToolDraft): Promise<string> {
  return await toolDraftDigest(draft);
}
export const makeEvent = (
  clock: ClockPort,
  kind: string,
  label: string,
  candidate?: Candidate,
): Event => ({
  id: crypto.randomUUID(),
  at: clock.now(),
  kind,
  label,
  ...(candidate
    ? {
      candidateId: candidate.id,
      elementId: candidate.binding?.elementId,
      ...(candidate.caseId ? { caseId: candidate.caseId } : {}),
    }
    : {}),
});
export const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message.slice(0, 450)
    : "Opération interrompue";
