/** Admitted system configuration and its network/envelope records. */
import type { PendingChange } from "./pending-change.ts";

/** Exact DNS hosts; this scope never implies subdomain or wildcard access. */
export interface NetworkScope {
  allowedHosts: string[];
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
