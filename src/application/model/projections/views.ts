import { parseModelRevisionId } from "../../../domain/shared-kernel/revision-id.ts";
import type {
  ModelViewDiagramDocument,
  ModelViewList,
  ModelViewPlantumlDocument,
} from "../../../domain/model/records/diagram-views.ts";
import { ModelRepositoryError } from "../repository.ts";
import type { ModelViewsReader } from "./ports/out/model-views-reader.port.ts";
import { VersionedReadService } from "./versioned-read.ts";

/** Versioned native diagram views. The list is cached by commit; each diagram
 * is cached by commit plus view, reprojected on demand from its cached summary. */

/** List cache keyed by commit. Concurrent reads share one computation, a
 * failure evicts its entry so the next read retries, and the table holds at
 * most 16 commits, evicting the least recently read. Lists are immutable. */
export class ModelViewListService extends VersionedReadService<ModelViewList> {
  constructor(reader: Pick<ModelViewsReader, "list">) {
    super({ read: (version) => reader.list(version) }, 16);
  }
}

function validateDiagramKey(key: string): void {
  const separator = key.indexOf("\n");
  const version = separator < 0 ? key : key.slice(0, separator);
  const viewId = separator < 0 ? "" : key.slice(separator + 1);
  try {
    parseModelRevisionId(version);
  } catch {
    throw new ModelRepositoryError(
      "INVALID_REQUEST",
      "Invalid immutable model version",
    );
  }
  if (!viewId) {
    throw new ModelRepositoryError(
      "INVALID_REQUEST",
      "Invalid model view id",
    );
  }
}

/** Diagram cache keyed by commit plus view. Distinct views compute distinctly;
 * a failure evicts its entry so the next read retries. Documents are immutable. */
class ModelViewDocumentService<T> extends VersionedReadService<T> {
  constructor(read: (version: string, viewId: string) => Promise<T>) {
    super(
      {
        read: (key) => {
          const separator = key.indexOf("\n");
          return read(key.slice(0, separator), key.slice(separator + 1));
        },
      },
      32,
      validateDiagramKey,
    );
  }

  override read(version: string, viewId?: string): Promise<T> {
    if (viewId === undefined) return super.read(version);
    return super.read(`${version}\n${viewId}`);
  }
}

export class ModelViewDiagramService
  extends ModelViewDocumentService<ModelViewDiagramDocument> {
  constructor(reader: Pick<ModelViewsReader, "diagram">) {
    super((version, viewId) => reader.diagram(version, viewId));
  }
}

/** Text is computed only when requested and retained independently of diagrams. */
export class ModelViewPlantumlService
  extends ModelViewDocumentService<ModelViewPlantumlDocument> {
  constructor(reader: Pick<ModelViewsReader, "plantuml">) {
    super((version, viewId) => reader.plantuml(version, viewId));
  }
}
