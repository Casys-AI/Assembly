import { sourceValues as projectSourceValues } from "../../../../../domain/model/projections/source-values.ts";
import { toolkitSourceValueCompatibility } from "./compatibility.ts";

export function sourceValues(elements: Record<string, unknown>[]) {
  return projectSourceValues(elements, toolkitSourceValueCompatibility);
}
