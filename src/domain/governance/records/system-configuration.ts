/** Admitted system configuration and its network/envelope records. */
import type { ToolKind } from "../../shared-kernel/tool-kind.ts";
import type {
  PendingChange,
  SupportedMandateChange,
} from "./pending-change.ts";

/** Exact DNS hosts; this scope never implies subdomain or wildcard access. */
export interface NetworkScope {
  allowedHosts: string[];
}

/** The admitted execution mandate an operator acts under. */
export interface ExecutionMandate {
  id: string;
  /** The `open-request` act: open a branch Request without asking the
   * person (decision 10). Absent: not granted. */
  mayOpenRequests?: true;
  mayPropose: readonly ToolKind[];
  mayInvoke: false | "active-catalog-only";
  mayReview: boolean;
  mayActivate: boolean;
  mayAdmitOwnCandidates?: boolean;
  mayChangeOwnMandate?: false;
  network: NetworkScope;
  supportedChanges: readonly SupportedMandateChange[];
}

type ProcessEnvelope =
  | { kind: "deterministic-envelope"; pattern: "1.1"; revision: number }
  | { kind: "event-triggered-reassessment"; pattern: "1.2"; revision: number }
  | {
    kind: "conversational-case-management";
    pattern: "1.3";
    revision: number;
  };

export interface SystemConfiguration {
  envelope: ProcessEnvelope;
  id: string;
  revision: number;
  /** Missing only in legacy snapshots, which restore with the legacy baseline. */
  network?: NetworkScope;
  builder: {
    id: "builder";
    mandateRevision: number;
    admissionAuthority: "human" | "builder" | "reviewer";
  };
  reviewer?: { id: string; name: string; mandateRevision: number };
  changes: PendingChange[];
}
