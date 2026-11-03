import type { ModelBuildStore } from "../../../builds/ports/out/build-store.port.ts";

/** The only W2 storage surface this use-case needs (kind, version, A). */
export type SemanticProjectionCache = Pick<
  ModelBuildStore,
  | "hasProjection"
  | "getProjection"
  | "putProjection"
  | "acquireLease"
  | "releaseLease"
>;
