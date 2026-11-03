import { canonicalDigest } from "../../primitives/execution-digest.ts";

/** Public deployment identity, independent of the executable model contract. */
export interface RuntimeProvenance {
  schemaVersion: 1;
  /** Absent on historical records, whose canonical representation is preserved. */
  complete?: boolean;
  incompleteReasons?: RuntimeProvenanceIncompleteReason[];
  ase: { commit: string; dirty: boolean | "unknown" };
  deno: string;
  toolkit: { version: string; digest: string };
  agents: {
    provider: string;
    /** Exact configured identifier, or unknown when delegated to a CLI default. */
    model: string;
    effort?: string;
    decisionMaxTokens?: number;
  };
}

export type RuntimeProvenanceIncompleteReason =
  | "agent-model-unresolved"
  | "ase-commit-unresolved"
  | "ase-dirty-unresolved";

export interface RuntimeProvenanceRecord {
  digest: string;
  provenance: RuntimeProvenance;
}

/** Explicit absence for hosts which cannot supply deployment metadata. */
export function unknownRuntimeProvenance(): RuntimeProvenance {
  return {
    schemaVersion: 1,
    ase: { commit: "unknown", dirty: "unknown" },
    deno: "unknown",
    toolkit: { version: "unknown", digest: "unknown" },
    agents: { provider: "unknown", model: "unknown" },
  };
}

export async function runtimeProvenanceRecord(
  value: RuntimeProvenance,
): Promise<RuntimeProvenanceRecord> {
  // Explicit projection keeps accidental extra fields (such as credentials)
  // outside both the durable record and its identity.
  const provenance: RuntimeProvenance = {
    schemaVersion: value.schemaVersion,
    ...(value.complete === undefined ? {} : { complete: value.complete }),
    ...(value.incompleteReasons === undefined
      ? {}
      : { incompleteReasons: [...value.incompleteReasons] }),
    ase: { commit: value.ase.commit, dirty: value.ase.dirty },
    deno: value.deno,
    toolkit: {
      version: value.toolkit.version,
      digest: value.toolkit.digest,
    },
    agents: {
      provider: value.agents.provider,
      model: value.agents.model,
      ...(value.agents.effort !== undefined
        ? { effort: value.agents.effort }
        : {}),
      ...(value.agents.decisionMaxTokens !== undefined
        ? { decisionMaxTokens: value.agents.decisionMaxTokens }
        : {}),
    },
  };
  return { digest: await canonicalDigest(provenance), provenance };
}
