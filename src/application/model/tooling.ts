import type {
  ModelToolingDescription,
  ModelToolingDiagnostic,
  ModelToolingEditResult,
  ModelToolingTarget,
  ReferenceSiteFingerprint,
  ResolvedModelEdit,
} from "../../domain/model/editing/tooling.ts";

/** A source tooling provider. Publication and execution admission stay outside it. */
export interface ModelToolingPort {
  /** Optional exact native reference sites; absence must be reported explicitly. */
  referenceSites?(
    sources: Record<string, string>,
    fromId: string,
  ): Promise<ReferenceSiteFingerprint[]>;
  /** Host-only intermediate compilation; never publishes a repository revision. */
  snapshot(sources: Record<string, string>): Promise<{
    version: string;
    sources: Record<string, string>;
    elements: Record<string, unknown>[];
  }>;
  /** Compile prepared source candidates without publication. */
  compile(
    sources: Record<string, string>,
  ): Promise<
    import("../../domain/model/records/compiled-model.ts").CompiledModel
  >;
  query(sources: Record<string, string>, expression: string): Promise<unknown>;
  describe(
    sources: Record<string, string>,
    target: ModelToolingTarget,
  ): Promise<ModelToolingDescription>;
  edit(
    sources: Record<string, string>,
    edits: readonly ResolvedModelEdit[],
  ): Promise<ModelToolingEditResult>;
  check(sources: Record<string, string>): Promise<ModelToolingDiagnostic[]>;
}
