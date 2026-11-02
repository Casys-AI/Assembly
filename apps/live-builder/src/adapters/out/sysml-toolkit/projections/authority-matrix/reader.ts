import type { AuthorityMatrixReader } from "../../../../../application/governance/authority-matrix.ts";
import type { ModelRepositoryPort } from "../../../../../application/model/repository.ts";
import type { AuthorityMatrix } from "../../../../../domain/governance/records/authority-matrix.ts";
import {
  type AuthorityMatrixProjection,
  loadAuthorityMatrixInput,
  type MatrixProcessObserver,
  scheduleAuthorityMatrix,
} from "./worker-client.ts";
import { ToolkitVersionedReader } from "../versioned-reader.ts";

/** Admit a lightweight version before reading either Git sources or artifact.
 * B4 coalesces versions; the executor admits only one active and three waiting. */
export class CompiledAuthorityMatrixReader
  extends ToolkitVersionedReader<AuthorityMatrix>
  implements AuthorityMatrixReader {
  constructor(
    repository: Pick<ModelRepositoryPort, "at" | "header">,
    projectId: string,
    project?: AuthorityMatrixProjection,
    now?: () => number,
    observer?: MatrixProcessObserver,
  ) {
    super(
      async (version) => {
        const load = (signal?: AbortSignal) =>
          loadAuthorityMatrixInput(repository, version, projectId, signal);
        if (project) {
          const input = await load();
          return project(
            input.revision as Awaited<ReturnType<ModelRepositoryPort["at"]>>,
            projectId,
            input.pin,
          );
        }
        return scheduleAuthorityMatrix(version, load, undefined, observer);
      },
      "authority matrix",
      "AUTHORITY_MATRIX_FAILED",
      now,
      false,
    );
  }
}
