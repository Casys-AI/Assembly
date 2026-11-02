import type { JsonObject } from "../../../../../domain/model/records/compiled-model.ts";
import type {
  BuildRef,
  ProjectionRef,
} from "../../../../../domain/model/value-objects/element-ref.ts";

/** Pure deterministic projector port; implemented in adapters. */
export interface ModelRdfProjector {
  readonly kind: string;
  /** Base algorithm version (1–63 characters). Returned refs use
   * contextualProjectorVersion with the verified projection inputs. */
  readonly projectorVersion: string;
  project(input: {
    readonly build: BuildRef;
    readonly elements: readonly JsonObject[];
    readonly libraryNativeIds: readonly string[];
  }): Promise<{
    readonly quads: Uint8Array;
    readonly projection: ProjectionRef;
    readonly quadCount: number;
  }>;
}
