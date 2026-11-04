import type { ArtifactSourceBindingReference } from "../artifacts/source-reference.ts";
import type { ToolDraft } from "./candidates.ts";

/** Exact retained bytes, with no admission, activation or loading command. */
export interface InspectedArtifactSource {
  binding: ArtifactSourceBindingReference;
  content: ToolDraft | string;
}
export interface ArtifactSourceInspection {
  sources: InspectedArtifactSource[];
  /** Present only when both exact sources were resolved and compared completely. */
  patch?: string;
}
