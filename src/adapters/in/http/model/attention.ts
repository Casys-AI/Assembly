import type { ModelAttentionService } from "../../../../application/model/projections/attention.ts";
import { createVersionedModelHandler } from "../versioning/handler.ts";

/** GET /api/model/attention[?version=commit:<40 hex>].
 * This body depends on diagnostic masks and can contain a transient
 * unavailable item, so it is never immutable: explicit versions carry
 * `no-cache` with the digest ETag (and 304); the moving head is no-store. */
export function createModelAttentionHandler(
  service: Pick<ModelAttentionService, "read">,
  head?: () => Promise<string>,
) {
  return createVersionedModelHandler({
    path: "/api/model/attention",
    name: "attention",
    failureCode: "MODEL_ATTENTION_FAILED",
    read: (version) => service.read(version),
    digest: (attention) => attention.digest,
    head,
    immutable: false,
  });
}
