import type { ModelDiagnostic } from "../../../src/domain/model/policies/diagnostics.ts";
import type { ModelAttention } from "../../../src/domain/model/records/attention.ts";
import type { ModelDiagnosticsResult } from "../../../src/application/model/diagnostics/service.ts";
import type { ModelShapesDiagnosticsResult } from "../../../src/application/model/diagnostics/shapes.ts";
import {
  requestFailure,
  RevisionRequestError,
} from "../model/revisions/api.ts";

export type DiagnosticsRead<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | {
    status: "unavailable" | "unsupported" | "error";
    message: string;
    code?: string;
  };

export type ShapesDiagnosticsResult = ModelShapesDiagnosticsResult;

export interface SystemDiagnosticsRead {
  doctor: DiagnosticsRead<ModelDiagnosticsResult>;
  shapes: DiagnosticsRead<ShapesDiagnosticsResult>;
  attention: DiagnosticsRead<ModelAttention>;
}

export const loadingDiagnostics = (): SystemDiagnosticsRead => ({
  doctor: { status: "loading" },
  shapes: { status: "loading" },
  attention: { status: "loading" },
});

/** Equal commit labels cannot reconcile reports produced from different bytes.
 * Doctor remains readable; the contradictory shape result cannot claim
 * conformance. Apply after every independent completion, in either order. */
export function reconcileDiagnostics(
  read: SystemDiagnosticsRead,
): SystemDiagnosticsRead {
  if (
    read.doctor.status === "ready" && read.shapes.status === "ready" &&
    read.doctor.value.sourceDigest !==
      read.shapes.value.report.build.sourceDigest
  ) {
    return {
      ...read,
      shapes: {
        status: "error",
        code: "DIAGNOSTICS_SOURCE_MISMATCH",
        message:
          "The SHACL report describes different source bytes from Doctor for this model version.",
      },
    };
  }
  return read;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const severity = (value: unknown) =>
  value === "error" || value === "warning" || value === "info";

function diagnostic(value: unknown): value is ModelDiagnostic {
  if (!record(value)) return false;
  return text(value.code) && severity(value.severity) && text(value.message) &&
    ["absent", "present", "indeterminate"].includes(String(value.finding)) &&
    ["elementId", "qualifiedName", "pattern"].every((key) =>
      value[key] === undefined || text(value[key])
    ) &&
    (value.source === undefined ||
      record(value.source) && text(value.source.file) &&
        count(value.source.line) && count(value.source.column)) &&
    (value.remedy === undefined || record(value.remedy) &&
        value.remedy.kind === "revision-template" &&
        text(value.remedy.template));
}

function doctor(value: unknown): value is ModelDiagnosticsResult {
  return record(value) && text(value.version) && digest(value.sourceDigest) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every((item) =>
      diagnostic(item) && record(item) && typeof item.masked === "boolean" &&
      !(item.severity === "error" && item.masked)
    );
}

function shapes(value: unknown): value is ShapesDiagnosticsResult {
  if (!record(value) || !text(value.version) || !record(value.report)) {
    return false;
  }
  const report = value.report;
  if (!record(report.build) || !record(report.identity)) return false;
  return text(report.build.repositoryId) &&
    ["sourceDigest", "recipeDigest", "buildKey", "artifactDigest"].every((
      key,
    ) => digest((report.build as Record<string, unknown>)[key])) &&
    ["artifactDigest", "shapesDigest", "optionsDigest"].every((key) =>
      digest((report.identity as Record<string, unknown>)[key])
    ) &&
    ["factsProjectorVersion", "engineId", "engineVersion"].every((key) =>
      text((report.identity as Record<string, unknown>)[key])
    ) && report.build.artifactDigest === report.identity.artifactDigest &&
    typeof report.conforms === "boolean" && count(report.unmappedResults) &&
    Array.isArray(report.diagnostics) && report.diagnostics.every(diagnostic);
}

function attention(value: unknown): value is ModelAttention {
  return record(value) && value.schema === "ase.model-attention/1" &&
    text(value.version) && digest(value.digest) && count(value.count) &&
    Array.isArray(value.items) && value.count === value.items.length &&
    value.items.every((item) =>
      record(item) && text(item.code) && severity(item.severity) &&
      ["authority-matrix", "board", "doctor"].includes(String(item.source)) &&
      record(item.context) && text(item.recovery) && record(item.target) &&
      ["rights", "requirements", "team"].includes(String(item.target.page)) &&
      (item.target.elementId === undefined || text(item.target.elementId))
    );
}

/** One exact consultation, with independently available reports. The caller
 * supplies the authorized Request fetch when inspecting a Request model. */
export function createDiagnosticsApi(options: { fetch?: typeof fetch } = {}) {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  async function source<T extends { version: string }>(
    path: string,
    version: string,
    parse: (value: unknown) => value is T,
    signal?: AbortSignal,
  ): Promise<DiagnosticsRead<T>> {
    try {
      if (!/^commit:[a-f0-9]{40}$/.test(version)) {
        return {
          status: "error",
          message: "An exact model version is required to read these findings.",
          code: "DIAGNOSTICS_VERSION_REQUIRED",
        };
      }
      const response = await request(
        `${path}?${new URLSearchParams({ version })}`,
        { signal, cache: "no-store" },
      );
      const value: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw requestFailure(response, value);
      const headerVersion = response.headers.get("x-model-version");
      if (
        !parse(value) || value.version !== version ||
        headerVersion !== null && headerVersion !== version
      ) {
        return {
          status: "error",
          message: "The report could not be matched to this model version.",
          code: "DIAGNOSTICS_INVALID_RESPONSE",
        };
      }
      return { status: "ready", value };
    } catch (failure) {
      if (signal?.aborted) throw failure;
      if (failure instanceof RevisionRequestError) {
        const unsupported = failure.status === 501 ||
          failure.code === "SHACL_ENGINE_UNAVAILABLE";
        return {
          status: unsupported ? "unsupported" : "unavailable",
          message: unsupported
            ? "This check is not available on this host."
            : failure.status === 401 || failure.status === 403
            ? "This scope requires an authorized local session."
            : failure.status === 404
            ? "No report is available for this model version."
            : "This report could not be read. Other checks remain separate.",
          ...(failure.code ? { code: failure.code } : {}),
        };
      }
      return {
        status: "unavailable",
        message: "This report could not be read. The host may be unavailable.",
      };
    }
  }
  return {
    async read(
      version: string,
      signal?: AbortSignal,
      onUpdate?: (read: SystemDiagnosticsRead) => void,
    ): Promise<SystemDiagnosticsRead> {
      let current = loadingDiagnostics();
      async function update<K extends keyof SystemDiagnosticsRead>(
        key: K,
        pending: Promise<SystemDiagnosticsRead[K]>,
      ): Promise<SystemDiagnosticsRead[K]> {
        const result = await pending;
        if (!signal?.aborted) {
          current = { ...current, [key]: result };
          onUpdate?.(reconcileDiagnostics(current));
        }
        return result;
      }
      const [doctorRead, shapesRead, attentionRead] = await Promise.all([
        update(
          "doctor",
          source("/api/model/diagnostics", version, doctor, signal),
        ),
        update(
          "shapes",
          source("/api/model/diagnostics/shapes", version, shapes, signal),
        ),
        update(
          "attention",
          source("/api/model/attention", version, attention, signal),
        ),
      ]);
      return reconcileDiagnostics({
        doctor: doctorRead,
        shapes: shapesRead,
        attention: attentionRead,
      });
    },
  };
}
