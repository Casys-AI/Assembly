import type { AuthorityMatrix } from "../../domain/governance/records/authority-matrix.ts";
import { VersionedReadService } from "../model/projections/versioned-read.ts";
import type { VersionedReader } from "../model/projections/ports/out/versioned-reader.port.ts";

export interface AuthorityMatrixReader
  extends VersionedReader<AuthorityMatrix> {
  read(version: string): Promise<AuthorityMatrix>;
}

/** Cache by immutable version, as in B2. The reader in B5 owns projection and
 * sourceDigest; this service never recompiles a matrix to discover its key. */
export class AuthorityMatrixService
  extends VersionedReadService<AuthorityMatrix> {
  constructor(reader: AuthorityMatrixReader) {
    super({
      async read(version) {
        const matrix = await reader.read(version);
        if (matrix.version !== version) {
          throw {
            code: "MODEL_VERSION_MISMATCH",
            context: { version, receivedVersion: matrix.version },
            recovery:
              "Correct the matrix reader to return the requested model version before requesting it again.",
          };
        }
        return matrix;
      },
    }, 32);
  }
}
