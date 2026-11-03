import type {
  EditTarget,
  HostTarget,
} from "../../../../domain/model/editing/host-edit.ts";
import type { ModelToolingPort } from "../../../../application/model/tooling.ts";
import {
  isModelEditTypeName,
  isNativeReferenceId,
  isReferenceSiteFingerprint,
  type ModelEdit,
  type ModelToolingTarget,
  type ResolvedModelEdit,
} from "../../../../domain/model/editing/tooling.ts";
import type { SourceRevision } from "../source-model.ts";
import { characterCount } from "../../../../domain/primitives/character-count.ts";
import { utf8SourceSpan } from "../../../../application/model/consultation/source-reader.ts";
import {
  parseSysmlQualifiedName,
  spellSysmlQualifiedName,
} from "../../../../domain/model/value-objects/sysml-qualified-name.ts";

function requireValue(
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
  requireValue(
    matches.length > 0,
    `Missing source declaration: ${name ?? id}`,
    "TARGET_MISSING",
  );
  requireValue(
    matches.length === 1,
    `Ambiguous source declaration: ${name ?? id}`,
    "TARGET_AMBIGUOUS",
  );
  const expectedClass = metaclass ??
    ("metaclass" in target ? target.metaclass : undefined);
  requireValue(
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
  requireValue(
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
      requireValue(
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
  requireValue(
    (allowAnonymous || typeof name === "string" && name.length > 0) &&
      typeof element["@type"] === "string" && typeof path === "string" &&
      Object.hasOwn(revision.sources, path),
    "Model edits require a named declaration in this source bundle",
  );
  const anonymousName = `@${elementId}`;
  const segments = qualifiedSegments(element, byId) ??
    (allowAnonymous && !name ? [anonymousName] : undefined);
  requireValue(
    segments,
    "Model edit target has an ambiguous qualified name",
    "TARGET_AMBIGUOUS",
  );
  const key = JSON.stringify(segments);
  requireValue(
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
  requireValue(
    Array.isArray(edits) && edits.length > 0 && edits.length <= 32,
    "Expected 1–32 targeted model edits",
  );
  return edits.map((edit) => {
    requireValue(
      edit && typeof edit === "object",
      "Invalid targeted model edit",
    );
    if (edit.kind === "retarget-reference") {
      requireValue(
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
        requireValue(
          Object.keys(edit).sort().join(",") === "elementId,kind,typeName" &&
            isModelEditTypeName(edit.typeName),
          "Expected a closed set-type edit with a bounded native type name",
        );
        const segments = parseSysmlQualifiedName(edit.typeName)!;
        const type = (edit.typeName.startsWith("::") ? "::" : "") +
          spellSysmlQualifiedName(segments);
        // The existing native bridge bounds the complete spelling in UTF-8
        // bytes. Quoting can grow a valid public name; refuse before native I/O.
        requireValue(
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

/** Queries expose stored IDs where names have an unambiguous correspondence.
 * Toolkit IDs remain labelled as provider identities, never silently substituted. */
export async function queryModelRevision(
  tooling: ModelToolingPort,
  revision: SourceRevision,
  expression: string,
): Promise<unknown> {
  requireValue(
    typeof expression === "string" && expression.trim().length > 0 &&
      characterCount(expression) <= 4096,
    "Expected a bounded model query expression",
  );
  const result = await tooling.query(
    structuredClone(revision.sources),
    expression,
  );
  const encoded = JSON.stringify(result);
  requireValue(
    typeof encoded === "string" &&
      new TextEncoder().encode(encoded).length <= 65536,
    "Model query exceeds the result size limit; narrow the selection",
  );
  const index = createModelSourceIndex(revision);
  const bind = (value: unknown, depth = 0): unknown => {
    requireValue(depth <= 64, "Model query result is nested too deeply");
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
  requireValue(
    new TextEncoder().encode(JSON.stringify(bound)).length <= 65536,
    "Model query exceeds the result size limit after identity binding; narrow the selection",
  );
  return bound;
}
