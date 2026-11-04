/** Complete before/after source confinement, independent of provider edit reports. */
import { parseSysmlQualifiedName } from "../value-objects/sysml-qualified-name.ts";
import { utf8SourceSpan } from "../value-objects/source-span.ts";

type Element = Record<string, unknown>;
interface Snapshot {
  sources: Record<string, string>;
  elements: Element[];
}
interface Grant {
  file: string;
  qualifiedRoots: string[];
}
interface Root {
  start: number;
  end: number;
  key: string;
  signature: string;
}
const encoder = new TextEncoder();
function requireFact(value: unknown): asserts value {
  if (!value) {
    throw new Error("Model edit is outside its exact admitted source scope");
  }
}
function index(snapshot: Snapshot) {
  const byId = new Map<string, Element>();
  for (const element of snapshot.elements) {
    const id = element["@id"];
    requireFact(typeof id === "string" && id && !byId.has(id));
    byId.set(id, element);
  }
  const chain = (element: Element, seen = new Set<string>()): Element[] => {
    const id = String(element["@id"]);
    requireFact(!seen.has(id));
    const owner = element.owner;
    if (owner === undefined || owner === null) return [element];
    const ownerId = typeof owner === "string"
      ? owner
      : typeof owner === "object" && !Array.isArray(owner)
      ? (owner as Element)["@id"]
      : undefined;
    requireFact(typeof ownerId === "string" && byId.has(ownerId));
    return [...chain(byId.get(ownerId)!, new Set([...seen, id])), element];
  };
  const names = (ancestry: Element[]) => {
    const segments: string[] = [];
    for (const element of ancestry) {
      const raw = element.qualifiedName;
      const declared = element.declaredName;
      // An unnamed global namespace is a legitimate native owner.
      if (
        !raw && !declared && segments.length === 0 &&
        element["@type"] === "Namespace"
      ) continue;
      requireFact(typeof declared === "string" && declared.length > 0);
      segments.push(declared);
      requireFact(typeof raw === "string");
      const parsed = parseSysmlQualifiedName(raw);
      requireFact(
        raw === segments.join("::") ||
          JSON.stringify(parsed) === JSON.stringify(segments),
      );
    }
    return segments;
  };
  return { chain, names };
}
function roots(
  snapshot: Snapshot,
  grants: readonly Grant[],
): Map<string, Root[]> {
  const facts = index(snapshot);
  const result = new Map<string, Root[]>();
  for (const grant of grants) {
    requireFact(
      Object.hasOwn(snapshot.sources, grant.file) &&
        grant.qualifiedRoots.length > 0,
    );
    for (const spelling of grant.qualifiedRoots) {
      const segments = parseSysmlQualifiedName(spelling);
      requireFact(segments);
      const key = JSON.stringify(segments);
      const matches: Array<{ element: Element; ancestry: Element[] }> = [];
      for (const element of snapshot.elements) {
        // Only plausible qualified declarations need a fully named ancestry.
        const raw = element.qualifiedName;
        if (typeof raw !== "string") continue;
        if (
          raw !== segments.join("::") &&
          JSON.stringify(parseSysmlQualifiedName(raw)) !== key
        ) continue;
        const ancestry = facts.chain(element);
        if (JSON.stringify(facts.names(ancestry)) === key) {
          matches.push({ element, ancestry });
        }
      }
      requireFact(matches.length === 1);
      const { element, ancestry } = matches[0]!;
      requireFact(
        ancestry.every((entry) => entry["toolkit:catalogOnly"] !== true),
      );
      requireFact(typeof element["@type"] === "string" && element["@type"]);
      const path = [...ancestry].reverse().find((entry) =>
        entry["sysx:sourceDocument"] !== undefined
      )?.["sysx:sourceDocument"];
      requireFact(path === grant.file);
      const range = {
        startLine: element["sysx:sourceLine"] as number,
        startColumn: element["sysx:sourceColumn"] as number,
        endLine: element["sysx:sourceEndLine"] as number,
        endColumn: element["sysx:sourceEndColumn"] as number,
        coordinateSystem: "utf8-bytes" as const,
      };
      const source = snapshot.sources[grant.file]!;
      const text = utf8SourceSpan(source, range);
      if (element["sysx:sourceText"] !== undefined) {
        requireFact(element["sysx:sourceText"] === text);
      }
      const lines = source.split("\n");
      const start =
        encoder.encode(lines.slice(0, range.startLine - 1).join("\n")).length +
        (range.startLine > 1 ? 1 : 0) + range.startColumn - 1;
      const root = {
        start,
        end: start + encoder.encode(text).length,
        key,
        signature: JSON.stringify(
          ancestry.map((entry) => [entry.declaredName ?? null, entry["@type"]]),
        ),
      };
      result.set(grant.file, [...(result.get(grant.file) ?? []), root]);
    }
  }
  for (const entries of result.values()) {
    entries.sort((a, b) => a.start - b.start);
    for (let i = 1; i < entries.length; i++) {
      requireFact(entries[i]!.start > entries[i - 1]!.end);
    }
  }
  return result;
}
function masked(snapshot: Snapshot, allowed: Map<string, Root[]>) {
  return Object.keys(snapshot.sources).sort().map((file) => {
    const bytes = encoder.encode(snapshot.sources[file]!);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const pieces: unknown[] = [];
    let cursor = 0;
    for (const root of allowed.get(file) ?? []) {
      pieces.push(decoder.decode(bytes.subarray(cursor, root.start)), {
        root: root.key,
        signature: root.signature,
      });
      cursor = root.end;
    }
    pieces.push(decoder.decode(bytes.subarray(cursor)));
    return [file, pieces];
  });
}
export function assertModelEditScope(
  before: Snapshot,
  after: Snapshot,
  grants: readonly Grant[],
): void {
  requireFact(Array.isArray(grants) && grants.length > 0);
  requireFact(
    JSON.stringify(masked(before, roots(before, grants))) ===
      JSON.stringify(masked(after, roots(after, grants))),
  );
}
