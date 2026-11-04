import type { EditTarget, HostTarget } from "./host-edit.ts";
import {
  isModelEditTypeName,
  isNativeReferenceId,
  isReferenceSiteFingerprint,
  type ModelEdit,
  type ModelToolingTarget,
  type ResolvedModelEdit,
} from "./tooling.ts";
import type { SourceRevision } from "../records/source-revision.ts";
import { characterCount } from "../../primitives/character-count.ts";
import { utf8SourceSpan } from "../value-objects/source-span.ts";
import {
  parseSysmlQualifiedName,
  spellSysmlQualifiedName,
} from "../value-objects/sysml-qualified-name.ts";

export function requireSourceEditingValue(
  value: unknown,
  message: string,
  code?: string,
): asserts value {
  if (!value) throw Object.assign(new Error(message), { code });
}

type Element = SourceRevision["elements"][number];

export function ownerId(element: Element): string | undefined {
  const owner = element.owner;
  return typeof owner === "string"
    ? owner
    : owner && typeof owner === "object" && "@id" in owner
    ? String(owner["@id"])
    : undefined;
}

/** Resolve the explicit-id selector, including the historical anonymous spelling. */
export function modelTargetId(
  target: HostTarget | EditTarget,
): string | undefined {
  return "elementId" in target
    ? target.elementId
    : target.qualifiedName.startsWith("@")
    ? target.qualifiedName.slice(1)
    : undefined;
}

/** Ownership and declaredName retain boundaries lost by a provider display name.
 * Without those facts, a multi-segment suffix is ambiguous and remains unbound. */
export function qualifiedSegments(
  element: Element,
  byId: ReadonlyMap<string, Element>,
  seen = new Set<string>(),
): string[] | undefined {
  const raw = element.qualifiedName;
  const id = element["@id"];
  if (
    typeof raw !== "string" || !raw || typeof id !== "string" || seen.has(id)
  ) {
    return undefined;
  }
  const parsed = parseSysmlQualifiedName(raw);
  const declared =
    typeof element.declaredName === "string" && element.declaredName
      ? element.declaredName
      : undefined;
  const owner = byId.get(ownerId(element) ?? "");
  let segments: string[] | undefined;
  if (owner && typeof owner.qualifiedName === "string" && owner.qualifiedName) {
    const parent = qualifiedSegments(owner, byId, new Set([...seen, id]));
    if (!parent) return undefined;
    segments = declared ? [...parent, declared] : parsed;
    if (
      !declared && (!parsed || parsed.length !== parent.length + 1 ||
        !parent.every((name, index) => name === parsed[index]))
    ) return undefined;
  } else {segments = declared
      ? [declared]
      : parsed?.length === 1
      ? parsed
      : undefined;}
  if (!segments) return undefined;
  // Both escaped spellings and normalized unquoted display spellings
  // must agree with the ownership-derived declaration; never infer from UUIDs.
  if (
    raw !== segments.join("::") &&
    (!parsed || parsed.length !== segments.length ||
      !parsed.every((name, index) => name === segments[index]))
  ) return undefined;
  try {
    spellSysmlQualifiedName(segments);
    return segments;
  } catch {
    return undefined;
  }
}

/** Source identity has one owner, shared by builders and the host writer. */
export interface ModelSourceIndex {
  byId: Map<string, Element>;
  byIdentity: Map<string, Element[]>;
  byName: Map<string, Element[]>;
}
export function createModelSourceIndex(
  revision: SourceRevision,
): ModelSourceIndex {
  const byId = new Map(revision.elements.map((e) => [String(e["@id"]), e]));
  const byIdentity = new Map<string, Element[]>();
  const byName = new Map<string, Element[]>();
  for (const element of revision.elements) {
    const id = String(element["@id"]);
    byIdentity.set(id, [...(byIdentity.get(id) ?? []), element]);
    const segments = qualifiedSegments(element, byId);
    if (!segments) continue;
    const key = JSON.stringify(segments);
    byName.set(key, [...(byName.get(key) ?? []), element]);
  }
  return { byId, byIdentity, byName };
}
export function modelSourceElement(
  source: SourceRevision | ModelSourceIndex,
  input: string | HostTarget | EditTarget,
  metaclass?: string,
): Element {
  const index = "elements" in source ? createModelSourceIndex(source) : source;
  const target = typeof input === "string" ? { qualifiedName: input } : input;
  const name = "qualifiedName" in target ? target.qualifiedName : undefined;
  const id = modelTargetId(target);
  const segments = name && id === undefined
    ? parseSysmlQualifiedName(name)
    : undefined;
  const matches = id !== undefined
    ? index.byIdentity.get(id) ?? []
    : segments
    ? index.byName.get(JSON.stringify(segments)) ?? []
    : [];
  requireSourceEditingValue(
    matches.length > 0,
    `Missing source declaration: ${name ?? id}`,
    "TARGET_MISSING",
  );
  requireSourceEditingValue(
    matches.length === 1,
    `Ambiguous source declaration: ${name ?? id}`,
    "TARGET_AMBIGUOUS",
  );
  const expectedClass = metaclass ??
    ("metaclass" in target ? target.metaclass : undefined);
  requireSourceEditingValue(
    !expectedClass || matches[0]!["@type"] === expectedClass,
    `Source metaclass differs: ${name ?? id}`,
    "READ_BACK_MISMATCH",
  );
  return matches[0]!;
}

/** Resolve the stored provider identity, never an unchecked caller name or span. */
export function modelToolingTarget(
  revision: SourceRevision,
  elementId: string,
  { allowAnonymous = false }: { allowAnonymous?: boolean } = {},
): ModelToolingTarget {
  requireSourceEditingValue(
    typeof elementId === "string" && characterCount(elementId) <= 512,
    "An exact model element identity is required",
  );
  const index = createModelSourceIndex(revision);
  let element: Element;
  try {
    element = modelSourceElement(index, { elementId });
  } catch (error) {
    if (
      error && typeof error === "object" && "code" in error &&
      error.code === "TARGET_MISSING"
    ) {
      requireSourceEditingValue(
        false,
        "Model edit target is absent from its source version",
        "TARGET_MISSING",
      );
    }
    throw error;
  }
  const name = element.qualifiedName;
  const { byId } = index;
  const seen = new Set<string>();
  let current = element;
  let path: unknown;
  while (
    current && typeof current["@id"] === "string" && !seen.has(current["@id"])
  ) {
    seen.add(current["@id"]);
    if (current["sysx:sourceDocument"] !== undefined) {
      path = current["sysx:sourceDocument"];
      break;
    }
    const owner = ownerId(current);
    if (!owner || !byId.has(owner)) break;
    current = byId.get(owner)!;
  }
  requireSourceEditingValue(
    (allowAnonymous || typeof name === "string" && name.length > 0) &&
      typeof element["@type"] === "string" && typeof path === "string" &&
      Object.hasOwn(revision.sources, path),
    "Model edits require a named declaration in this source bundle",
  );
  const anonymousName = `@${elementId}`;
  const segments = qualifiedSegments(element, byId) ??
    (allowAnonymous && !name ? [anonymousName] : undefined);
  requireSourceEditingValue(
    segments,
    "Model edit target has an ambiguous qualified name",
    "TARGET_AMBIGUOUS",
  );
  const key = JSON.stringify(segments);
  requireSourceEditingValue(
    allowAnonymous && !name ||
      index.byName.get(key)?.length === 1,
    "Model edit target has an ambiguous qualified name",
    "TARGET_AMBIGUOUS",
  );
  const text = utf8SourceSpan(revision.sources[path]!, {
    startLine: Number(element["sysx:sourceLine"]),
    startColumn: Number(element["sysx:sourceColumn"]),
    endLine: Number(element["sysx:sourceEndLine"]),
    endColumn: Number(element["sysx:sourceEndColumn"]),
    coordinateSystem: "utf8-bytes",
  });
  return {
    qualifiedName: allowAnonymous && !name
      ? anonymousName
      : JSON.stringify(parseSysmlQualifiedName(String(name))) === key
      ? String(name)
      : spellSysmlQualifiedName(segments),
    metaclass: element["@type"],
    source: { path, text },
  };
}

export function resolveModelEdits(
  revision: SourceRevision,
  edits: readonly ModelEdit[],
): ResolvedModelEdit[] {
  requireSourceEditingValue(
    Array.isArray(edits) && edits.length > 0 && edits.length <= 32,
    "Expected 1–32 targeted model edits",
  );
  return edits.map((edit) => {
    requireSourceEditingValue(
      edit && typeof edit === "object",
      "Invalid targeted model edit",
    );
    if (edit.kind === "retarget-reference") {
      requireSourceEditingValue(
        Object.keys(edit).sort().join(",") === "fromId,kind,site,toId" &&
          isNativeReferenceId(edit.fromId) && isNativeReferenceId(edit.toId) &&
          isReferenceSiteFingerprint(edit.site) &&
          Object.hasOwn(revision.sources, edit.site.unit),
        "Expected a closed reference-site edit within the immutable source bundle",
      );
      modelSourceElement(revision, { elementId: edit.fromId });
      modelSourceElement(revision, { elementId: edit.toId });
      return structuredClone(edit);
    }
    const target = modelToolingTarget(revision, edit.elementId);
    switch (edit.kind) {
      case "set-value":
        return { kind: edit.kind, target, expression: edit.expression };
      case "set-type": {
        requireSourceEditingValue(
          Object.keys(edit).sort().join(",") === "elementId,kind,typeName" &&
            isModelEditTypeName(edit.typeName),
          "Expected a closed set-type edit with a bounded native type name",
        );
        const segments = parseSysmlQualifiedName(edit.typeName)!;
        const type = (edit.typeName.startsWith("::") ? "::" : "") +
          spellSysmlQualifiedName(segments);
        // The existing native bridge bounds the complete spelling in UTF-8
        // bytes. Quoting can grow a valid public name; refuse before native I/O.
        requireSourceEditingValue(
          new TextEncoder().encode(type).length <= 4096,
          "Native type spelling exceeds the 4096-byte limit",
        );
        return { kind: edit.kind, target, type };
      }
      case "rename":
        return { kind: edit.kind, target, name: edit.name };
      case "insert-member":
        return { kind: edit.kind, target, text: edit.text };
      case "remove":
        return { kind: edit.kind, target };
      default:
        throw new Error("Unsupported targeted model edit");
    }
  });
}
