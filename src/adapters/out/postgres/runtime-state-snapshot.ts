import { decodeRuntimeSnapshotPayload } from "./runtime-snapshot-codec.ts";
import { postgresSafeInteger } from "./numbers.ts";
import { assertCasesState } from "../../../domain/work/entities/cases.ts";
import type { SystemRuntimeState } from "../../../application/work/runtime/state.ts";

/** Domain envelope validation, independent of any database driver. */
export function assertRuntimeState(
  value: unknown,
): asserts value is SystemRuntimeState {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid system runtime state");
  }
  const state = value as SystemRuntimeState;
  assertCasesState(state);
  if (
    typeof state.id !== "string" || !state.id.trim() ||
    !Number.isSafeInteger(state.revision) || state.revision < 0 ||
    !Number.isSafeInteger(state.catalogRevision) || state.catalogRevision < 0 ||
    !Array.isArray(state.messages) || !Array.isArray(state.candidates) ||
    !Array.isArray(state.events) || typeof state.busy !== "boolean" ||
    typeof state.phase !== "string" || typeof state.provider !== "string"
  ) throw new Error("Invalid system runtime state");
}

export function runtimeStateSummary(state: SystemRuntimeState) {
  return {
    label: state.events.at(-1)?.label ?? `Révision ${state.revision}`,
    agentCount: 1 + Number(Boolean(state.configuration?.reviewer)),
    activeToolCount:
      state.candidates.filter((candidate) => candidate.stage === "active")
        .length,
  };
}

/** Shared current/history/transactional-control decoder; checks envelope and SQL revision. */
export function decodePostgresRuntimeState(
  row: { revision: bigint; payload: string },
): SystemRuntimeState {
  const state: unknown = JSON.parse(decodeRuntimeSnapshotPayload(row.payload));
  assertRuntimeState(state);
  if (state.revision !== postgresSafeInteger(row.revision)) {
    throw new Error("Corrupt system runtime state revision");
  }
  return state;
}
