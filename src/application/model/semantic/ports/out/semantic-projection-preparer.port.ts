import type {
  BuildRef,
  ProjectionRef,
} from "../../../../../domain/model/value-objects/element-ref.ts";

/** Prepare immutable projection bytes outside the calling process. The
 * application receives only an authenticated reference, never an artifact or RDF. */
export interface SemanticProjectionPreparer {
  prepare(build: BuildRef): Promise<{ readonly projection: ProjectionRef }>;
}
