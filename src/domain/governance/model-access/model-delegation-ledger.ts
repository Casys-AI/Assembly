/** APE 4.1: source-owned delegation history, written only by the administration path. */
import { canonical } from "../../primitives/canonical-json.ts";
import type { ModelDelegationRecord } from "./model-delegation.ts";
import { validateModelDelegationRecord } from "./model-delegation.ts";
type Sources = Record<string, string>;

export const MODEL_DELEGATIONS_FILE = "model-delegations.sysml";
const prefix = `package AssemblyModelDelegations {
    private import ScalarValues::*;
    doc /* APE 4.1: admitted delegation records and revocation history.
     * The host resolves each recipient and mandate against this source version. */
    attribute records : String = `;
const legacyPrefix = prefix.replace(
  "AssemblyModelDelegations",
  "ASEModelDelegations",
);
const suffix = ";\n}\n";

/** Existing source keeps its exact package identity when the ledger is appended. */
function sourcePrefix(sources: Sources = {}): string {
  const source = sources[MODEL_DELEGATIONS_FILE];
  return source?.startsWith(legacyPrefix) ? legacyPrefix : prefix;
}

export function renderModelDelegations(
  records: readonly ModelDelegationRecord[],
  sources?: Sources,
): string {
  if (records.length > 256) throw new Error("Delegation history limit reached");
  const ids = new Set<string>();
  for (const record of records) {
    validateModelDelegationRecord(record);
    if (ids.has(record.id)) throw new Error("Duplicate delegation identity");
    ids.add(record.id);
  }
  return sourcePrefix(sources) + JSON.stringify(canonical(records)) + suffix;
}

/** Exact encoding is an intentional contract, not a search for authority in arbitrary text. */
export function readModelDelegations(
  sources: Sources,
): ModelDelegationRecord[] {
  const source = sources[MODEL_DELEGATIONS_FILE];
  if (source === undefined) return [];
  const selectedPrefix = sourcePrefix(sources);
  if (!source.startsWith(selectedPrefix) || !source.endsWith(suffix)) {
    throw new Error("Invalid canonical delegation source");
  }
  const literal: unknown = JSON.parse(
    source.slice(selectedPrefix.length, -suffix.length),
  );
  if (typeof literal !== "string") {
    throw new Error("Invalid delegation literal");
  }
  const records: unknown = JSON.parse(literal);
  if (!Array.isArray(records)) throw new Error("Invalid delegation history");
  for (const record of records) validateModelDelegationRecord(record);
  if (renderModelDelegations(records, sources) !== source) {
    throw new Error("Noncanonical delegation source");
  }
  return records;
}
