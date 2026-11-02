import {
  canonical,
  compareCodeUnits,
} from "../../primitives/canonical-json.ts";
import type { ModelRevisionId } from "../../shared-kernel/revision-id.ts";

/** Machine list behind To decide, the title-bar badge and the Dock count.
 *
 * One item per point that asks for a person's attention, each leading to the
 * page where it is acted on. Prose is the interface's job: an item carries a
 * closed code, a severity, the source that produced it, machine context and a
 * recovery, never a sentence to display. The same facts always sort in the
 * same order, so counts and digests are stable across reads. */
export const ATTENTION_SCHEMA = "ase.model-attention/1" as const;

type AttentionSeverity = "error" | "warning" | "info";

/** The existing services an item was composed from; nothing is recomputed. */
type AttentionSource = "authority-matrix" | "board" | "doctor";

/** The System page an item leads to, by the page's own name. */
type AttentionPage = "rights" | "requirements" | "team";

interface AttentionTarget {
  page: AttentionPage;
  elementId?: string;
}

export interface AttentionItem {
  code: string;
  severity: AttentionSeverity;
  source: AttentionSource;
  context: Record<string, unknown>;
  recovery: string;
  target: AttentionTarget;
}

export interface ModelAttention {
  schema: typeof ATTENTION_SCHEMA;
  version: ModelRevisionId;
  /** Always `items.length`; carried so a badge never recounts a stale list. */
  count: number;
  items: readonly AttentionItem[];
  /** sha256 over the canonical `{version, items}`; the HTTP ETag source. */
  digest: string;
}

/** Built when a whole source could not be read: the other sources still
 * produce their items, and the failure is an item, never a silent gap. */
export function attentionSourceUnavailable(
  source: AttentionSource,
  failure: { code: string; message?: string },
): AttentionItem {
  const target: Record<AttentionSource, AttentionTarget> = {
    "authority-matrix": { page: "rights" },
    board: { page: "requirements" },
    doctor: { page: "team" },
  };
  const recovery: Record<AttentionSource, string> = {
    "authority-matrix":
      "Restore the authority matrix read for this version, then read the attention list again.",
    board:
      "Restore the board read for this version, then read the attention list again.",
    doctor:
      "Restore the model diagnostics read for this version, then read the attention list again.",
  };
  return {
    code: "ATTENTION_SOURCE_UNAVAILABLE",
    severity: "warning",
    source,
    context: {
      source,
      failureCode: failure.code,
      ...(failure.message ? { message: failure.message } : {}),
    },
    recovery: recovery[source],
    target: target[source],
  };
}

const severityOrder: Record<AttentionSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};
/** Deterministic total order: severity, source, code, page, element, then the
 * canonical context, so two items never compare equal on distinct facts. */
function compareAttentionItems(
  left: AttentionItem,
  right: AttentionItem,
): number {
  return severityOrder[left.severity] - severityOrder[right.severity] ||
    compareCodeUnits(left.source, right.source) ||
    compareCodeUnits(left.code, right.code) ||
    compareCodeUnits(left.target.page, right.target.page) ||
    compareCodeUnits(
      left.target.elementId ?? "",
      right.target.elementId ?? "",
    ) ||
    compareCodeUnits(canonical(left.context), canonical(right.context)) ||
    compareCodeUnits(left.recovery, right.recovery);
}

export function sortAttentionItems(
  items: readonly AttentionItem[],
): AttentionItem[] {
  return [...items].sort(compareAttentionItems);
}
