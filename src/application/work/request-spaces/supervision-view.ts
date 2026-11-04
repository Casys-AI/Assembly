import type { ScopedOperatorRef } from "../../../domain/governance/authority.ts";
import type { RequestSpaceScope } from "../../../domain/work/request-spaces/scope.ts";

/** Each row describes an independent persisted observation collected during the
 * snapshot's interval, never one atomic global state or the inspected graph. */
export interface SupervisionSource {
  readonly sourceVersion: string;
  readonly modelDigest: string;
  readonly branchId: string | null;
  readonly runtimeRevision: number;
}

/** Only conversation is evaluated by the current authenticated admission guard.
 * An allowed observation is dated; actual execution checks admission again. */
export interface SupervisionAction {
  readonly action: "conversation" | "effects" | "supervision-decision";
  readonly actor:
    | { readonly kind: "controller"; readonly ownerId: string }
    | { readonly kind: "operator"; readonly ref: ScopedOperatorRef };
  readonly target: ScopedOperatorRef;
  readonly source: SupervisionSource | null;
  readonly result: "allowed" | "refused" | "unevaluated";
  readonly evaluatedAt: string | null;
  readonly reason: string;
}

export interface SupervisionInstance {
  readonly actor: ScopedOperatorRef;
  readonly role: "MO" | "BO" | "team";
  /** A team instance's creating operator instance, in the same space. */
  readonly parent?: ScopedOperatorRef;
  readonly name: string;
  readonly case: {
    readonly id: string;
    readonly number: number;
    readonly title: string | null;
  } | null;
  /** Null is unavailable, never a fallback to Main or the opening's birth pin. */
  readonly source: SupervisionSource | null;
  readonly availability: "available" | "unavailable";
  readonly unavailableReason: string | null;
  readonly supervision:
    | { readonly status: "global-main" }
    | {
      readonly status: "unresolved";
      readonly reason: string;
      /** Registered host reference only; no actor-to-actor supervision proof. */
      readonly hostMain?: ScopedOperatorRef;
      /** Actual opening facts do not establish Main participation or authority. */
      readonly openingProvenance?: {
        readonly openingId: string;
        readonly admissionId: string | null;
        readonly parentExecutionSpaceId: string | null;
        readonly openedBy: string;
        readonly originConversationId: string;
      };
    };
  readonly evaluatedActions: readonly SupervisionAction[];
}

export interface RequestSupervisionSnapshot {
  readonly schema: "assembly-system-supervision/v1";
  readonly scope: RequestSpaceScope;
  /** Collection begins after reader authentication and bounded discovery. Rows
   * are observed independently; no common database snapshot is implied. */
  readonly observedAt: string;
  /** Collection ends after final reader revalidation. A source or admission can
   * change after its individual observation/evaluation within this interval. */
  readonly completedAt: string;
  readonly main: SupervisionInstance;
  readonly instances: readonly SupervisionInstance[];
  readonly coverage: {
    readonly selection: "owned-host-openings" | "selected-case";
    readonly caseId: string | null;
    readonly limit: number;
    readonly returned: number;
    readonly unavailable: number;
    readonly completeness: "complete" | "has-more";
    /** Other owners and non-Request runtime actors are outside this inventory. */
    readonly boundary: "owned-request-openings";
  };
  readonly nextCursor: string | null;
}

export interface RequestSupervisionQuery {
  readonly caseId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface RequestSupervisionReadPort {
  read(
    secret: string,
    query?: RequestSupervisionQuery,
  ): Promise<RequestSupervisionSnapshot>;
}
