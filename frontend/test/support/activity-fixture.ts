import type { ActivityInput } from "../../lib/decide/activity.ts";
import { grant } from "./operator-fixture.ts";
import { legacyOwnerAuthority } from "../../../src/domain/governance/authority.ts";

export const activityInput = (
  patch: Partial<ActivityInput> = {},
): ActivityInput => ({
  cases: [],
  requests: [],
  conversations: [],
  requestSnapshots: new Map(),
  mainMessages: [],
  history: null,
  releases: [],
  ...patch,
});
export const recorded = grant({
  status: "approved",
  authority: "human",
  decidedAt: "2026-11-03T10:02:00Z",
  baseModelDigest: "base",
  authorityExercise: {
    ...legacyOwnerAuthority("system"),
    authoritySchema: 2,
    action: "mandate-change",
    baseModelDigest: "base",
    outOfMandate: false,
  },
});
