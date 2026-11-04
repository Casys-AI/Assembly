import type { PendingChange } from "../../../src/domain/governance/records/pending-change.ts";
import { changeOutcome } from "../model/revisions/change.ts";
import type { CaseChangeStatus } from "../workbench/api.ts";

/** What the host recorded of applying a change decided in a Request. */
export type ApplicationStatus = CaseChangeStatus["status"];

/**
 * What a person reads of a decision: to decide, then applying, then applied
 * or declined. A proposal a newer model overtook before anyone decided it is
 * superseded. The host's own statuses never reach the page: they are read
 * here, and nowhere else.
 */
export type DecisionPhase =
  | "to-decide"
  | "applying"
  | "applied"
  | "declined"
  | "superseded";

export const decisionLabel: Readonly<Record<DecisionPhase, string>> = {
  "to-decide": "To decide",
  applying: "Applying",
  applied: "Applied",
  declined: "Declined",
  superseded: "Superseded",
};

/** Applying, in order: the decision recorded, the sources saved, in service. */
export const APPLYING_STEPS = ["Decided", "Saved", "In service"] as const;

export interface DecisionState {
  phase: DecisionPhase;
  /** How many of `APPLYING_STEPS` are behind: 0 undecided, 3 applied. */
  reached: 0 | 1 | 2 | 3;
  /** The host recorded applying as blocked where it stands. */
  blocked: boolean;
  /**
   * The host still has a step to take, applying or continuing after a
   * refusal: only then may a retry be offered, and its reason shown.
   */
  unfinished: boolean;
  /** The application record contradicts the change; it is set aside. */
  inconsistent: boolean;
  /** A Request's application record is not read yet: no step is claimed. */
  checking: boolean;
}

const UNFINISHED: readonly ApplicationStatus[] = [
  "decision-recorded",
  "publication-pending",
  "published-awaiting-adoption",
  "blocked",
  "refused-awaiting-continuation",
];

/** Whether the host still has a step to take after this status. */
export function applicationUnfinished(status: ApplicationStatus): boolean {
  return UNFINISHED.includes(status);
}

/** The application statuses a recorded verdict may lead to. */
const FOLLOWS: Readonly<Record<"approved" | "refused", ApplicationStatus[]>> = {
  approved: [
    "decision-recorded",
    "publication-pending",
    "published-awaiting-adoption",
    "adopted",
    "blocked",
  ],
  refused: ["refused-awaiting-continuation", "refused"],
};

const SETTLED = {
  reached: 0,
  blocked: false,
  unfinished: false,
  inconsistent: false,
  checking: false,
} as const;

/**
 * Where a decision stands. `application` is what the host recorded of applying
 * a change decided in a Request, `"unread"` until it is read; it is absent for
 * a change of main, which is in service once its commit is published.
 */
export function decisionState(
  change: PendingChange,
  application?: ApplicationStatus | "unread",
): DecisionState {
  if (change.status === "pending") return { ...SETTLED, phase: "to-decide" };
  if (change.status === "superseded") {
    return { ...SETTLED, phase: "superseded" };
  }
  const recorded = application === "unread" ? undefined : application;
  const inconsistent = recorded !== undefined &&
    !FOLLOWS[change.status].includes(recorded);
  const status = inconsistent ? undefined : recorded;
  const unfinished = status !== undefined && applicationUnfinished(status);
  if (change.status === "refused") {
    return {
      ...SETTLED,
      phase: "declined",
      unfinished,
      inconsistent,
      checking: application === "unread",
    };
  }
  const saved = change.publishedCommit ? 2 : 1;
  const applied = { ...SETTLED, phase: "applied", reached: 3 } as const;
  if (status === "adopted") return applied;
  if (status) {
    return {
      phase: "applying",
      reached: status === "published-awaiting-adoption"
        ? 2
        : status === "blocked"
        ? saved
        : 1,
      blocked: status === "blocked",
      unfinished,
      inconsistent,
      checking: false,
    };
  }
  // Main: in service once the change itself records that it applied.
  if (application === undefined && changeOutcome(change) === "applied") {
    return applied;
  }
  return {
    ...SETTLED,
    phase: "applying",
    reached: application === "unread" ? 0 : saved,
    inconsistent,
    checking: application === "unread",
  };
}

/** "Decided ✓ · Saved · In service": the steps of applying, those behind marked. */
export function applyingSteps(decision: DecisionState): string {
  return [
    ...APPLYING_STEPS.map((step, index) =>
      index < decision.reached ? `${step} ✓` : step
    ),
    ...(decision.blocked ? ["blocked"] : []),
  ].join(" · ");
}
