import type { AuthorityMatrix } from "../../../domain/governance/records/authority-matrix.ts";
import { UNUSABLE } from "../../../domain/governance/records/authority-matrix.ts";
import { canonicalDigest } from "../../../domain/primitives/execution-digest.ts";
import type { ModelBoard } from "../../../domain/model/records/board.ts";
import {
  ATTENTION_SCHEMA,
  type AttentionItem,
  attentionSourceUnavailable,
  type ModelAttention,
  sortAttentionItems,
} from "../../../domain/model/records/attention.ts";
import { parseModelRevisionId } from "../../../domain/shared-kernel/revision-id.ts";
import { ModelRepositoryError } from "../repository.ts";
import type { ModelDiagnosticsResult } from "../diagnostics/service.ts";
import type { ModelAttentionSources } from "./ports/out/model-attention-sources.port.ts";

function failureOf(error: unknown): { code: string; message?: string } {
  const record = (error && typeof error === "object" ? error : {}) as {
    code?: unknown;
    message?: unknown;
  };
  return {
    code: typeof record.code === "string" && record.code
      ? record.code
      : "SOURCE_READ_FAILED",
    ...(typeof record.message === "string" && record.message
      ? { message: record.message }
      : {}),
  };
}

function codeOf(error: unknown): string | undefined {
  const record = (error && typeof error === "object" ? error : {}) as {
    code?: unknown;
  };
  return typeof record.code === "string" && record.code
    ? record.code
    : undefined;
}

/** The single error conversion for this composition. Only infrastructure
 * failures become an unavailable item: `TOOLKIT_TIMEOUT`, `*_UNAVAILABLE`,
 * `*_UPSTREAM_FAILURE`, `*_TOOLKIT_FAILED`, or an error without a code.
 * Every other coded error (`NOT_FOUND`, `INVALID_*`,
 * `MODEL_VERSION_MISMATCH`, unknown codes) is rethrown as-is so the HTTP
 * boundary keeps its strict status. */
function unavailableOrThrow(
  source: "authority-matrix" | "board" | "doctor",
  error: unknown,
): AttentionItem {
  const code = codeOf(error);
  const infrastructure = code === undefined ||
    code === "TOOLKIT_TIMEOUT" ||
    code.endsWith("UNAVAILABLE") ||
    code.endsWith("UPSTREAM_FAILURE") ||
    code.endsWith("TOOLKIT_FAILED");
  if (!infrastructure) throw error;
  return attentionSourceUnavailable(source, failureOf(error));
}

/** Matrix diagnostics that ask for a decision, at warning or above. */
function matrixItems(matrix: AuthorityMatrix): AttentionItem[] {
  return matrix.diagnostics
    .filter((diagnostic) => diagnostic.severity !== "info")
    .map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      source: "authority-matrix" as const,
      context: { ...diagnostic.context },
      recovery: diagnostic.recovery,
      target: { page: "rights" as const },
    }));
}

/** A software operator that builds tools and admits them itself, while no
 * operator in the model can review candidates: the matrix cells say both. */
function selfApprovalItems(matrix: AuthorityMatrix): AttentionItem[] {
  const cells = new Map(
    matrix.cells.map((cell) => [`${cell.row}|${cell.column}`, cell]),
  );
  const at = (row: string, column: string) => cells.get(`${row}|${column}`);
  const usable = (cell: ReturnType<typeof at>) =>
    !!cell &&
    (cell.state === "allowed" || cell.state === "inherited") &&
    !cell.codes.some((code) => (UNUSABLE as readonly string[]).includes(code));
  const hasReviewer = matrix.rows.some((row) =>
    usable(at(row.id, "candidate.review"))
  );
  if (hasReviewer) return [];
  const toolColumns = matrix.columns.filter((column) =>
    column.group === "tools"
  );
  return matrix.rows
    .filter((row) => row.kind !== "human")
    .filter((row) =>
      toolColumns.some((column) =>
        at(row.id, column.id)?.codes.includes("ADMISSION_BY_BUILDER")
      ) && usable(at(row.id, "candidate.admit"))
    )
    .map((row) => ({
      code: "TOOL_SELF_APPROVAL",
      severity: "warning" as const,
      source: "authority-matrix" as const,
      context: { row: row.id, unit: row.unit, label: row.label },
      recovery:
        "Declare an operator able to review candidates, or stop this operator admitting its own tool candidates.",
      target: {
        page: "rights" as const,
        ...(row.element ? { elementId: row.element.elementId } : {}),
      },
    }));
}

/** Board health: a requirement nobody satisfies, a constraint nothing performs. */
function boardItems(board: ModelBoard): AttentionItem[] {
  const guarantees = board.columns
    .filter((column) => column.id === "guarantees")
    .flatMap((column) => column.items);
  const items: AttentionItem[] = [];
  for (const entry of guarantees) {
    if (entry.kind === "requirement" && !(entry.satisfiedBy?.length)) {
      items.push({
        code: "REQUIREMENT_WITHOUT_OWNER",
        severity: "warning",
        source: "board",
        context: {
          elementId: entry.element,
          title: entry.title,
          ...(entry.qname ? { qname: entry.qname } : {}),
          owners: 0,
        },
        recovery:
          "Declare in the model what satisfies this requirement, so an owner answers for it.",
        target: { page: "requirements", elementId: entry.element },
      });
    }
    if (entry.kind === "constraint" && entry.inForce !== true) {
      items.push({
        code: "CONSTRAINT_INACTIVE",
        severity: "info",
        source: "board",
        context: {
          elementId: entry.element,
          title: entry.title,
          ...(entry.qname ? { qname: entry.qname } : {}),
          inForce: false,
        },
        recovery:
          "Have a performed step carry this constraint, or remove the constraint from the model.",
        target: { page: "requirements", elementId: entry.element },
      });
    }
  }
  return items;
}

/** Doctor findings the person has not masked, at warning or above. Masks are
 * instance preferences: they are re-read on every composition, never cached
 * with the version, so masking a code removes its item at the next read. */
function doctorItems(result: ModelDiagnosticsResult): AttentionItem[] {
  return result.diagnostics
    .filter((diagnostic) =>
      !diagnostic.masked && diagnostic.severity !== "info"
    )
    .map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      source: "doctor" as const,
      context: {
        ...(diagnostic.elementId ? { elementId: diagnostic.elementId } : {}),
        ...(diagnostic.qualifiedName
          ? { qualifiedName: diagnostic.qualifiedName }
          : {}),
        ...(diagnostic.pattern ? { pattern: diagnostic.pattern } : {}),
        finding: diagnostic.finding,
        message: diagnostic.message,
      },
      recovery: diagnostic.remedy
        ? `Use the ${diagnostic.remedy.template} revision template to address this finding.`
        : "Inspect this finding in the model and correct the declaration it points at.",
      target: {
        page: "team" as const,
        ...(diagnostic.elementId ? { elementId: diagnostic.elementId } : {}),
      },
    }));
}

/** Composes the attention list for one immutable version.
 *
 * Nothing is cached here: the matrix and board services already cache their
 * own projections (and evict their failures), and this composition is cheap.
 * An unavailable item is therefore rebuilt on every read and never memorized
 * — a source that recovers is healthy again at the next read. Doctor items
 * are likewise composed on every read from the diagnostics service, whose
 * mask store is re-read each time. A healthy model yields an empty list. */
export class ModelAttentionService {
  #ready = new Map<string, { count: number | undefined; seq: number }>();
  #readSeq = 0;

  constructor(private readonly sources: ModelAttentionSources) {}

  async read(version: string): Promise<ModelAttention> {
    let parsed;
    try {
      parsed = parseModelRevisionId(version);
    } catch {
      throw new ModelRepositoryError(
        "INVALID_REQUEST",
        "Invalid immutable model version",
      );
    }
    const seq = ++this.#readSeq;
    const [matrixPart, boardPart, doctorPart] = await Promise.all([
      this.sources.matrix.read(version).then(
        (value) => [...matrixItems(value), ...selfApprovalItems(value)],
        (error: unknown) => [unavailableOrThrow("authority-matrix", error)],
      ),
      this.sources.board.read(version).then(
        (value) => boardItems(value),
        (error: unknown) => [unavailableOrThrow("board", error)],
      ),
      this.sources.diagnostics.list(version).then(
        (value) => doctorItems(value),
        (error: unknown) => [unavailableOrThrow("doctor", error)],
      ),
    ]);
    const items = Object.freeze(
      sortAttentionItems([...matrixPart, ...boardPart, ...doctorPart]),
    );
    const digest = await canonicalDigest({ version: parsed, items });
    const attention: ModelAttention = {
      schema: ATTENTION_SCHEMA,
      version: parsed,
      count: items.length,
      items,
      digest,
    };
    // A count containing an unavailable item is never retained for the
    // event, and an older read never overwrites a newer count.
    const hasUnavailable = items.some((item) =>
      item.code === "ATTENTION_SOURCE_UNAVAILABLE"
    );
    const previous = this.#ready.get(version);
    if (!previous || previous.seq <= seq) {
      this.#ready.set(version, {
        count: hasUnavailable ? undefined : attention.count,
        seq,
      });
      if (this.#ready.size > 32) {
        this.#ready.delete(this.#ready.keys().next().value!);
      }
    }
    return attention;
  }

  /** The count for a version whose list was already computed, else undefined.
   * Synchronous and computation-free: an absent count never means zero. */
  peekCount(version: string): number | undefined {
    return this.#ready.get(version)?.count;
  }

  /** Starts the computation for a version without awaiting it. The returned
   * promise resolves once `peekCount` can answer for that version. */
  warm(version: string): Promise<void> {
    return this.read(version).then(() => {});
  }
}
