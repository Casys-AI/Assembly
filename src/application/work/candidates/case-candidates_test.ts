import { equal } from "node:assert/strict";
import type { Candidate } from "../../../domain/work/records/candidates.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import {
  abandonCaseCandidates,
  type CaseCandidatesHost,
} from "./case-candidates.ts";

const candidate = (
  id: string,
  caseId: string,
  stage: Candidate["stage"],
): Candidate => ({ id, caseId, stage } as unknown as Candidate);

Deno.test("abandoning a Case fails its pending candidates only", async () => {
  const state = {
    candidates: [
      candidate("pending", "case-1", "proposed"),
      candidate("active", "case-1", "active"),
      candidate("other", "case-2", "proposed"),
    ],
    events: [],
  } as unknown as SystemRuntimeState;
  const host: CaseCandidatesHost = {
    state,
    update: (change) => {
      change(state);
      return Promise.resolve();
    },
    stage: (id, stage) => {
      state.candidates.find((c) => c.id === id)!.stage = stage;
      return Promise.resolve();
    },
  };
  await abandonCaseCandidates.call(host, "case-1");
  const [pending, active, other] = state.candidates;
  equal(pending.stage, "failed");
  equal(pending.errorCode, "CASE_ABANDONED");
  equal(active.stage, "active");
  equal(other.stage, "proposed");
});
