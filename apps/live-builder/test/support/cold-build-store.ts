import {
  BuildStoreError,
  type ModelBuildStore,
} from "../../src/application/model/builds/ports/out/build-store.port.ts";

/** A permanently empty cache for cold witnesses. It implements the whole port
 * and refuses every mutation, including optional vault cache refills and leases.
 * Historical bytes must therefore come from the real verified vault. */
export function createColdBuildStore(): ModelBuildStore {
  const refuseWrite = () =>
    Promise.reject(
      new BuildStoreError(
        "BUILD_STORE_UNAVAILABLE",
        { operation: "cold-cache-mutation" },
        "The cold witness forbids cache writes",
      ),
    );
  return {
    has: () => Promise.resolve(false),
    get(digest) {
      return Promise.reject(
        new BuildStoreError(
          "BUILD_BLOB_MISSING",
          { digest },
          "Cold cache is empty",
        ),
      );
    },
    put: refuseWrite,
    hasProjection: () => Promise.resolve(false),
    getProjection() {
      return Promise.reject(
        new BuildStoreError(
          "BUILD_BLOB_MISSING",
          {},
          "Cold projection cache is empty",
        ),
      );
    },
    putProjection: refuseWrite,
    acquireLease: refuseWrite,
    releaseLease: refuseWrite,
    sweep: refuseWrite,
    stats: () =>
      Promise.resolve({
        blobCount: 0,
        projectionCount: 0,
        leaseCount: 0,
        uncompressedBytes: 0,
        quotaBytes: 0,
        overQuota: false,
      }),
    close: () => Promise.resolve(),
  };
}
