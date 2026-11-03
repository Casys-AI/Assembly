import type {
  BuildRef,
  ProjectionRef,
} from "../../../../../domain/model/value-objects/element-ref.ts";
import type {
  SemanticQueryLimits,
  SemanticQueryResult,
} from "../../queries/inputs.ts";

/** Native side of the index (Oxigraph via N-API). Implemented by the
 * adapter; heavy calls run in a killable native process behind it. */
export interface NativeSemanticIndexPort {
  /** Production path: the native process reads the pinned bytes itself.
   * Optional only for callers explicitly using the byte-based seam below. */
  loadReference?(input: {
    readonly build: BuildRef;
    readonly projection: ProjectionRef;
  }): Promise<{ readonly quadCount: number }>;
  load(input: {
    readonly build: BuildRef;
    readonly projection: ProjectionRef;
    readonly quads: Uint8Array;
  }): Promise<{ readonly quadCount: number }>;
  query(input: {
    readonly build: BuildRef;
    readonly sparql: string;
    readonly limits: SemanticQueryLimits;
  }): Promise<SemanticQueryResult>;
  release(build: BuildRef): Promise<void>;
  isLoaded(build: BuildRef): Promise<boolean>;
}
