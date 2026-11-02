import type {
  ModelView,
  ModelViewList,
  ModelViewSummary,
} from "../../../../src/domain/model/records/diagram-views.ts";
import { isRecord } from "../../transport/is-record.ts";
import {
  requestFailure,
  versionMessages,
  type VersionProblemCode,
} from "../revisions/api.ts";
import { UnreadableAnswer } from "../../transport/unreadable-answer.ts";
import {
  canRetry,
  type ReadCodes,
  type ReadProblem,
  readProblemOf,
  readVersioned,
} from "../versioned-read.ts";

export const VIEW_GROUPS = {
  structure: "Interconnection",
  behavior: "Action flow",
  state: "State machine",
  declared: "Declared views",
  definitions: "General (packages)",
} as const;
export type ViewsProblemCode =
  | VersionProblemCode
  | "views-timeout"
  | "views-unavailable"
  | "views-invalid"
  | "views-failed";
const CODES: ReadCodes<ViewsProblemCode> = {
  timeout: "views-timeout",
  unavailable: "views-unavailable",
  invalid: "views-invalid",
  failed: "views-failed",
};
export type ViewsProblem = ReadProblem<ViewsProblemCode>;
export const viewsCanRetry = (problem: ViewsProblem) =>
  canRetry(problem, CODES);
export const viewsProblem = (error: unknown, pinned = false): ViewsProblem =>
  readProblemOf(error, pinned, {
    ...CODES,
    messages: {
      ...versionMessages,
      "views-timeout": "The model took too long to draw.",
      "views-unavailable": "The model views could not be reached.",
      "views-invalid": "The model views were received in an unreadable form.",
      "views-failed": "The model views could not be read.",
    },
  });

const text = (v: unknown): v is string => typeof v === "string";
const optionalText = (v: unknown) => v === undefined || text(v);
const coordinate = (v: unknown) =>
  v === undefined || Number.isSafeInteger(v) && Number(v) >= 0;
function summary(v: unknown): v is ModelViewSummary {
  return isRecord(v) && text(v.id) && Boolean(v.id) && text(v.title) &&
    ["interconnection", "action", "state", "tree"].includes(String(v.kind)) &&
    Object.hasOwn(VIEW_GROUPS, String(v.group)) && text(v.element) &&
    Number.isSafeInteger(v.nodes) && Number(v.nodes) >= 0 &&
    Number.isSafeInteger(v.edges) && Number(v.edges) >= 0;
}
function invalid(): never {
  throw new UnreadableAnswer("Invalid native model view document.");
}
export function parseViewList(value: unknown): ModelViewList {
  if (
    !isRecord(value) || !text(value.toolkit) || !Array.isArray(value.views) ||
    !value.views.every(summary) ||
    !Array.isArray(value.diagnostics) ||
    !value.diagnostics.every((d) =>
      isRecord(d) && text(d.code) && text(d.recovery) &&
      (d.severity === "warning" || d.severity === "error") &&
      isRecord(d.context) && text(d.context.message)
    ) || !text(value.digest)
  ) invalid();
  if (new Set(value.views.map((v) => v.id)).size !== value.views.length) {
    invalid();
  }
  return value as unknown as ModelViewList;
}
export function parseView(value: unknown, id: string): ModelView {
  if (!isRecord(value) || !summary(value.view) || value.view.id !== id) {
    invalid();
  }
  const view = value.view as unknown as Record<string, unknown>,
    graph = view.diagram;
  if (
    !isRecord(graph) || !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  ) invalid();
  for (const n of graph.nodes) {
    if (
      !isRecord(n) || !text(n.id) || !n.id || !text(n.kind) || !text(n.name) ||
      ![
        n.typeName,
        n.metaclass,
        n.qname,
        n.stereo,
        n.nodeKind,
        n.parent,
        n.file,
      ].every(optionalText) ||
      ![n.line, n.col].every(coordinate) ||
      (n.conjugated !== undefined && typeof n.conjugated !== "boolean") ||
      !Array.isArray(n.rows) || !n.rows.every((r) =>
        isRecord(r) && text(r.label) && text(r.section) &&
        [r.id, r.qname, r.file].every(optionalText) &&
        [r.line, r.col].every(coordinate)
      )
    ) {
      invalid();
    }
  }
  if (new Set(graph.nodes.map((n) => n.id)).size !== graph.nodes.length) {
    invalid();
  }
  for (const e of graph.edges) {
    if (
      !isRecord(e) || !text(e.kind) || !text(e.source) || !text(e.target) ||
      ![
        e.id,
        e.label,
        e.guard,
        e.metaclass,
        e.qname,
        e.sourcePath,
        e.targetPath,
      ].every(optionalText) ||
      (e.directed !== undefined && typeof e.directed !== "boolean")
    ) invalid();
  }
  return value.view as ModelView;
}

export function createViewsApi(options: { fetch?: typeof fetch } = {}) {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  async function read(
    path: string,
    version: string,
    view: string,
    signal?: AbortSignal,
  ) {
    const response = await request(
      `${path}?${new URLSearchParams({ version, view })}`,
      { signal, cache: "no-cache" },
    );
    if (!response.ok) {
      throw requestFailure(
        response,
        await response.json().catch(() => undefined),
      );
    }
    // Explicit-version routes encode their immutable identity in the request;
    // the head route additionally announces it in a header.
    const announced = response.headers.get("x-model-version");
    if (announced && announced !== version) invalid();
    return response;
  }
  return {
    async list(version?: string, signal?: AbortSignal) {
      const result = await readVersioned(
        request,
        "/api/model/views",
        version,
        signal,
      );
      return { version: result.version, list: parseViewList(result.body) };
    },
    async diagram(version: string, view: string, signal?: AbortSignal) {
      const response = await read(
        "/api/model/views/diagram",
        version,
        view,
        signal,
      );
      return parseView(await response.json(), view);
    },
    async plantuml(version: string, view: string, signal?: AbortSignal) {
      const response = await read(
        "/api/model/views/plantuml",
        version,
        view,
        signal,
      );
      const source = await response.text();
      if (
        !source.trimStart().startsWith("@startuml") ||
        !source.includes("@enduml")
      ) invalid();
      return source;
    },
  };
}
export type ViewsApi = ReturnType<typeof createViewsApi>;
