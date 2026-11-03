/** Read-only client for the native model views served by `/api/model-views`. */
import type {
  ModelView,
  ModelViewGroup,
  ModelViewSummary,
} from "../../src/domain/model-views.ts";
import type { Fetcher } from "./api.ts";

export interface ModelViewList {
  version: string;
  toolkit: string;
  views: ModelViewSummary[];
  problems: string[];
}

export interface ModelViewDocument {
  version: string;
  toolkit: string;
  view: ModelView;
}

export class ModelViewsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recovery?: string,
  ) {
    super(message);
  }
}

export const GROUP_TITLES: Record<ModelViewGroup, string> = {
  structure: "Structure",
  behavior: "Behavior",
  state: "States",
  declared: "Declared views",
  definitions: "Definitions",
};

async function read<T>(fetcher: Fetcher, path: string): Promise<T> {
  const response = await fetcher(path);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ModelViewsError(
      typeof body?.code === "string" ? body.code : `HTTP_${response.status}`,
      typeof body?.error === "string"
        ? body.error
        : `Model views unavailable (${response.status}).`,
      typeof body?.recovery === "string" ? body.recovery : undefined,
    );
  }
  return body as T;
}

const query = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams(
    Object.entries(params).filter((p): p is [string, string] =>
      p[1] !== undefined
    ),
  );
  return search.size ? `?${search}` : "";
};

export function fetchModelViews(
  modelVersion?: string,
  fetcher: Fetcher = (path, init) => fetch(path, init),
): Promise<ModelViewList> {
  return read(fetcher, `/api/model-views${query({ modelVersion })}`);
}

export function fetchModelView(
  view: string,
  modelVersion?: string,
  fetcher: Fetcher = (path, init) => fetch(path, init),
): Promise<ModelViewDocument> {
  return read(
    fetcher,
    `/api/model-views/diagram${query({ view, modelVersion })}`,
  );
}

/** Views in display order, grouped; groups without views are left out. */
export function groupViews(views: readonly ModelViewSummary[]) {
  const order = Object.keys(GROUP_TITLES) as ModelViewGroup[];
  return order.map((group) => ({
    group,
    title: GROUP_TITLES[group],
    views: views.filter((v) => v.group === group),
  })).filter((g) => g.views.length > 0);
}
