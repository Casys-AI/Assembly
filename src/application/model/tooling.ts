import type {
  ModelToolingTarget,
  ReferenceSiteFingerprint,
  ResolvedModelEdit,
} from "../../domain/model/editing/tooling.ts";

export interface ModelToolingDiagnostic {
  severity: string;
  message: string;
  stage?: string;
  unit?: string;
  line?: number;
  col?: number;
}

export interface ModelToolingDescription {
  id: string;
  qualifiedName: string;
  metaclass: string;
  owner?: { id: string; qualifiedName?: string; metaclass?: string };
  types: Array<{ id: string; qualifiedName?: string; metaclass?: string }>;
  source: { path: string; startByte: number; endByte: number; text: string };
}

export interface ModelToolingEditResult {
  /** Descriptions in request order, measured in the unedited source snapshot. */
  targets: ModelToolingDescription[];
  sources: Record<string, string>;
  splices: Array<{ unit: string; start: number; end: number; text: string }>;
  idMap: Array<[string, string]>;
  diagnostics: ModelToolingDiagnostic[];
  provider: { name: string; version: string };
}

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
