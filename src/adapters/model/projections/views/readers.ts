import { sha256Bytes as sha256 } from "../../../../domain/primitives/sha256-bytes.ts";
import type { ModelRepositoryPort } from "../../../../application/model/repository.ts";
import type { ModelViewListService } from "../../../../application/model/projections/views.ts";
import type { ModelViewsReader } from "../../../../application/model/projections/ports/out/model-views-reader.port.ts";
import type {
  ModelView,
  ModelViewDiagramDocument,
  ModelViewList,
  ModelViewPlantumlDocument,
  ModelViewSummary,
} from "../../../../domain/model/records/diagram-views.ts";
import { canonical } from "../../../../domain/primitives/canonical-json.ts";

import type { SysmlToolkitAdapter } from "../../../out/sysml-toolkit/adapter.ts";
import { ToolkitVersionedReader } from "../../../out/sysml-toolkit/projections/versioned-reader.ts";

/** A view list describes the exact source snapshot of an immutable commit. */
export class ToolkitModelViewListReader
  extends ToolkitVersionedReader<ModelViewList>
  implements Pick<ModelViewsReader, "list"> {
  constructor(
    repository: Pick<ModelRepositoryPort, "at">,
    tooling: Pick<SysmlToolkitAdapter, "views">,
    now?: () => number,
  ) {
    super(
      async (version) =>
        await tooling.views((await repository.at(version)).sources),
      "model views",
      "MODEL_VIEWS_TOOLKIT_FAILED",
      now,
    );
  }

  async list(version: string): Promise<ModelViewList> {
    const value = await this.read(version);
    // Digest computed once here, per projection; the service memoises the
    // enriched list, so HTTP requests never re-canonicalise or re-hash it.
    return {
      ...value,
      digest: await sha256(canonical({
        toolkit: value.toolkit,
        views: value.views,
        diagnostics: value.diagnostics,
      })),
    };
  }
}

const VIEW_NOT_FOUND_RECOVERY =
  "Re-read GET /api/model/views?version=<commit> and choose an existing view id.";

/** Restore the requested commit in an error translated from a composite
 * diagram key. Only the translator's own key is rewritten, never another shape. */
function repairDiagramVersion(
  error: unknown,
  version: string,
  key: string,
): void {
  if (error && typeof error === "object") {
    const context = (error as { context?: unknown }).context;
    if (context && typeof context === "object" && !Array.isArray(context)) {
      const record = context as Record<string, unknown>;
      if (record.version === key) record.version = version;
    }
  }
}

/** A diagram reprojection reads its cached list first: an unknown view id
 * fails before any session opens and is never retained as a timeout. */
class ToolkitSelectedViewReader<T> {
  #projections: ToolkitVersionedReader<T>;
  #summaries = new Map<string, ModelViewSummary>();

  constructor(
    repository: Pick<ModelRepositoryPort, "at">,
    project: (
      sources: Record<string, string>,
      view: ModelViewSummary,
    ) => Promise<T>,
    private readonly lists: Pick<ModelViewListService, "read">,
    now?: () => number,
  ) {
    this.#projections = new ToolkitVersionedReader<T>(
      async (key) => {
        const separator = key.indexOf("\n");
        const summary = this.#summaries.get(key);
        if (!summary) throw new Error("Missing selected view summary");
        return await project(
          (await repository.at(key.slice(0, separator))).sources,
          summary,
        );
      },
      "model views",
      "MODEL_VIEWS_TOOLKIT_FAILED",
      now,
    );
  }

  async read(
    version: string,
    viewId: string,
  ): Promise<{ toolkit: string; value: T }> {
    const list = await this.lists.read(version);
    const summary = list.views.find((view) => view.id === viewId);
    if (!summary) {
      throw {
        code: "VIEW_NOT_FOUND",
        context: { version, view: viewId },
        recovery: VIEW_NOT_FOUND_RECOVERY,
      };
    }
    const key = `${version}\n${viewId}`;
    this.#summaries.set(key, summary);
    try {
      return {
        toolkit: list.toolkit,
        value: await this.#projections.read(key),
      };
    } catch (error) {
      repairDiagramVersion(error, version, key);
      throw error;
    } finally {
      if (this.#summaries.get(key) === summary) this.#summaries.delete(key);
    }
  }
}

export class ToolkitModelViewDiagramReader
  implements Pick<ModelViewsReader, "diagram"> {
  #selected: ToolkitSelectedViewReader<ModelView>;
  constructor(
    repository: Pick<ModelRepositoryPort, "at">,
    tooling: Pick<SysmlToolkitAdapter, "diagram">,
    lists: Pick<ModelViewListService, "read">,
    now?: () => number,
  ) {
    this.#selected = new ToolkitSelectedViewReader(
      repository,
      (sources, view) => tooling.diagram(sources, view),
      lists,
      now,
    );
  }

  async diagram(
    version: string,
    viewId: string,
  ): Promise<ModelViewDiagramDocument> {
    const { toolkit, value: view } = await this.#selected.read(version, viewId);
    return {
      toolkit,
      view,
      digest: await sha256(canonical({ toolkit, view })),
    };
  }
}

export class ToolkitModelViewPlantumlReader
  implements Pick<ModelViewsReader, "plantuml"> {
  #selected: ToolkitSelectedViewReader<string>;
  constructor(
    repository: Pick<ModelRepositoryPort, "at">,
    tooling: Pick<SysmlToolkitAdapter, "plantuml">,
    lists: Pick<ModelViewListService, "read">,
    now?: () => number,
  ) {
    this.#selected = new ToolkitSelectedViewReader(
      repository,
      (sources, view) => tooling.plantuml(sources, view),
      lists,
      now,
    );
  }

  async plantuml(
    version: string,
    viewId: string,
  ): Promise<ModelViewPlantumlDocument> {
    const { value: text } = await this.#selected.read(version, viewId);
    return { text, digest: await sha256(text) };
  }
}
