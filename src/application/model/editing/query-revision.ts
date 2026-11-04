import type { ModelToolingPort } from "../tooling.ts";
import type { SourceRevision } from "../../../domain/model/records/source-revision.ts";
import { characterCount } from "../../../domain/primitives/character-count.ts";
import {
  createModelSourceIndex,
  modelSourceElement,
  modelToolingTarget,
  requireSourceEditingValue,
} from "../../../domain/model/editing/source-index.ts";

/** Queries expose stored IDs where names have an unambiguous correspondence.
 * Toolkit IDs remain labelled as provider identities, never silently substituted. */
export async function queryModelRevision(
  tooling: ModelToolingPort,
  revision: SourceRevision,
  expression: string,
): Promise<unknown> {
  requireSourceEditingValue(
    typeof expression === "string" && expression.trim().length > 0 &&
      characterCount(expression) <= 4096,
    "Expected a bounded model query expression",
  );
  const result = await tooling.query(
    structuredClone(revision.sources),
    expression,
  );
  const encoded = JSON.stringify(result);
  requireSourceEditingValue(
    typeof encoded === "string" &&
      new TextEncoder().encode(encoded).length <= 65536,
    "Model query exceeds the result size limit; narrow the selection",
  );
  const index = createModelSourceIndex(revision);
  const bind = (value: unknown, depth = 0): unknown => {
    requireSourceEditingValue(
      depth <= 64,
      "Model query result is nested too deeply",
    );
    if (Array.isArray(value)) return value.map((item) => bind(item, depth + 1));
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    if (typeof object["@element"] === "string") {
      // A provider UUID alone is not an admitted source identity.
      let elementId: string | null = null;
      if (typeof object.qualifiedName === "string") {
        try {
          const element = modelSourceElement(index, object.qualifiedName);
          modelToolingTarget(revision, String(element["@id"]));
          elementId = String(element["@id"]);
        } catch {
          // Missing, ambiguous, library and unlocated declarations stay unbound.
        }
      }
      return {
        toolkitElementId: object["@element"],
        qualifiedName: object.qualifiedName ?? null,
        elementId,
      };
    }
    return Object.fromEntries(
      Object.entries(object).map((
        [key, child],
      ) => [key, bind(child, depth + 1)]),
    );
  };
  const bound = bind(result);
  requireSourceEditingValue(
    new TextEncoder().encode(JSON.stringify(bound)).length <= 65536,
    "Model query exceeds the result size limit after identity binding; narrow the selection",
  );
  return bound;
}
