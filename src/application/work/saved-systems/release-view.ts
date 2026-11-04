import type {
  SavedOperatorManifest,
  SavedOperatorSelection,
  SavedSystemPrerequisite,
  SavedSystemRecord,
  SavedSystemScope,
  SavedSystemSourceEvidence,
} from "../../../domain/work/records/saved-systems.ts";
import {
  type ReleasePublicationView,
  releasePublicationView,
} from "../../../domain/work/records/release-publication.ts";

/** Public response deliberately excludes the selected tool bodies. */
export type SavedSystemView =
  & Omit<
    SavedSystemRecord,
    "capture" | "commandDigest" | "creationAuthorization" | "publication"
  >
  & {
    publication?: ReleasePublicationView;
    assetAvailability: "unchecked" | "verified" | "unavailable";
    tagAvailability?: "unchecked" | "verified" | "unavailable";
    /** Selected read-only host compatibility, never an execution grant. */
    openingAvailability?: "unchecked" | "ready" | "unavailable";
    openingIssues?: readonly string[];
    origin: SavedSystemScope;
    /** Absent only on historical runtime-vector records. */
    source?: SavedSystemSourceEvidence;
    prerequisites: SavedSystemPrerequisite[];
    selectedOperators: Array<
      Omit<SavedOperatorSelection, "tools"> & {
        tools: SavedOperatorManifest["tools"];
      }
    >;
  };

export function savedSystemView(record: SavedSystemRecord): SavedSystemView {
  const {
    capture: _capture,
    commandDigest: _command,
    creationAuthorization: _authorization,
    publication: _publication,
    ...view
  } = record;
  const admission = record.capture.admission;
  const selected = new Set(admission?.operatorIds ?? []);
  const result: SavedSystemView = {
    ...view,
    ...(record.publication
      ? { publication: releasePublicationView(record.publication) }
      : {}),
    assetAvailability: "unchecked",
    openingAvailability: "unchecked",
    openingIssues: [],
    ...(record.tag ? { tagAvailability: "unchecked" as const } : {}),
    origin: record.capture.origin,
    ...(record.capture.source ? { source: record.capture.source } : {}),
    prerequisites: admission
      ? [
        ...record.capture.prerequisites.filter((entry) =>
          !entry.operatorId || selected.has(entry.operatorId)
        ),
        ...admission.prerequisites,
      ]
      : record.capture.prerequisites,
    selectedOperators: record.capture.operators.filter((operator) =>
      selected.has(operator.operatorId)
    ).map((operator) => ({
      ...operator,
      tools: operator.tools.map(({ draft: _draft, ...tool }) => tool),
    })),
  };
  return structuredClone(result);
}
