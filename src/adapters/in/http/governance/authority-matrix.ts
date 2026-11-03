import type { AuthorityMatrixService } from "../../../../application/governance/authority-matrix.ts";
import { createVersionedModelHandler } from "../versioning/handler.ts";

/** GET /api/model/authority-matrix[?version=commit:<40 hex>].
 * Composition supplies the cached projector and the current adopted commit. */
export function createAuthorityMatrixHandler(
  service: Pick<AuthorityMatrixService, "read">,
  head: () => Promise<string>,
) {
  return createVersionedModelHandler({
    path: "/api/model/authority-matrix",
    name: "authority matrix",
    failureCode: "AUTHORITY_MATRIX_FAILED",
    read: (version) => service.read(version),
    digest: (matrix) => matrix.digest,
    head,
  });
}
