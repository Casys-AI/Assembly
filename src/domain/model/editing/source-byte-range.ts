import type { SourceRevision } from "../records/source-revision.ts";
import { ownerId as ownerOf } from "./source-index.ts";
type Element = SourceRevision["elements"][number];

export function elementByteRange(
  revision: SourceRevision,
  element: Element,
  byId: ReadonlyMap<string, Element>,
): { path: string; start: number; end: number } | undefined {
  let path: string | undefined;
  let current: Element | undefined = element;
  const seen = new Set<string>();
  while (current && !seen.has(String(current["@id"]))) {
    seen.add(String(current["@id"]));
    if (typeof current["sysx:sourceDocument"] === "string") {
      path = current["sysx:sourceDocument"];
      break;
    }
    const ownerId = ownerOf(current) ?? "";
    current = byId.get(ownerId);
  }
  if (!path || !Object.hasOwn(revision.sources, path)) return undefined;
  const coords = [
    element["sysx:sourceLine"],
    element["sysx:sourceColumn"],
    element["sysx:sourceEndLine"],
    element["sysx:sourceEndColumn"],
  ];
  if (!coords.every((v) => Number.isSafeInteger(v) && Number(v) > 0)) {
    return undefined;
  }
  const bytes = new TextEncoder().encode(revision.sources[path]!);
  const starts = [0];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10) starts.push(i + 1);
  }
  const at = (line: number, column: number) => {
    const start = starts[line - 1];
    return start === undefined ? undefined : start + column - 1;
  };
  const start = at(Number(coords[0]), Number(coords[1]));
  const end = at(Number(coords[2]), Number(coords[3]));
  if (start === undefined || end === undefined || end < start) return undefined;
  return { path, start, end };
}
