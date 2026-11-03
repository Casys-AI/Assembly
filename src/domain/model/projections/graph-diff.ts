import type { GraphChange, GraphDiff } from "../records/graph-diff.ts";
import { canonical } from "../../primitives/canonical-json.ts";

type Document = Record<string, unknown>;
const categories = {
  ElementV0: "element",
  RelationshipV0: "relationship",
  EndpointV0: "endpoint",
} as const;

function object(value: unknown): value is Document {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Invalid model graph diff: ${message}`);
}

function documentMap(documents: Document[]): Map<string, Document> {
  return new Map(documents.map((doc) => [String(doc["@id"]), doc]));
}

function endpointOwners(documents: Document[]): Map<string, Document> {
  const owners = new Map<string, Document>();
  for (const doc of documents) {
    if (doc["@type"] !== "RelationshipV0" || !Array.isArray(doc.endpoints)) {
      continue;
    }
    for (const id of doc.endpoints) {
      check(
        typeof id === "string" && !owners.has(id),
        "ambiguous endpoint owner",
      );
      owners.set(id, doc);
    }
  }
  return owners;
}

function comparable(doc: Document, field: string): unknown {
  const value = doc[field];
  // IR endpoints is a Set. Its order does not encode endpoint.position.
  return field === "endpoints" && Array.isArray(value)
    ? value.toSorted()
    : value;
}

/** Project native changed-document identities and fields onto the admitted IR.
 * Snapshots supply readable values for all native patch operations (including
 * list edits); they never discover additional changes or compare source text.
 */
export function compareModelGraphDocuments(input: {
  patches: unknown;
  before: Document[];
  after: Document[];
  fromVersion: string | null;
  toVersion: string;
  sourceDigests?: GraphDiff["sourceDigests"];
  limit: number;
}): GraphDiff {
  check(Array.isArray(input.patches), "expected a patch array");
  check(
    Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 100,
    "display limit must be between 1 and 100",
  );
  const before = documentMap(input.before);
  const after = documentMap(input.after);
  const beforeOwners = endpointOwners(input.before);
  const afterOwners = endpointOwners(input.after);
  const changes: GraphChange[] = [];
  const seen = new Set<string>();
  for (const patch of input.patches) {
    check(object(patch), "expected a document patch");
    const operation = patch["@op"];
    const payload = operation === "Insert"
      ? patch["@insert"]
      : operation === "Delete"
      ? patch["@delete"]
      : patch;
    check(
      object(payload) && typeof payload["@id"] === "string",
      "missing document identity",
    );
    const id = payload["@id"];
    const oldDoc = before.get(id);
    const newDoc = after.get(id);
    const doc = operation === "Delete" ? oldDoc : newDoc;
    const type = String(doc?.["@type"] ?? payload["@type"]);
    if (!(type in categories)) continue;
    check(doc, `patch document ${id} is absent from its immutable snapshot`);
    check(
      operation === undefined || operation === "Insert" ||
        operation === "Delete",
      "unknown document operation",
    );
    check(!seen.has(id), `duplicate patch for ${id}`);
    seen.add(id);
    const kind = operation === "Insert"
      ? "added"
      : operation === "Delete"
      ? "removed"
      : "changed";
    check(
      kind === "added"
        ? !oldDoc && newDoc
        : kind === "removed"
        ? oldDoc && !newDoc
        : oldDoc && newDoc,
      `operation does not match snapshots for ${id}`,
    );
    const keys = kind === "changed" ? Object.keys(patch) : Object.keys(doc);
    const fields = keys.filter((key) =>
      !key.startsWith("@") && key !== "native_id"
    )
      .sort().flatMap((field) => {
        const hasBefore = oldDoc !== undefined && Object.hasOwn(oldDoc, field);
        const hasAfter = newDoc !== undefined && Object.hasOwn(newDoc, field);
        if (
          hasBefore === hasAfter &&
          canonical(comparable(oldDoc ?? {}, field)) ===
            canonical(comparable(newDoc ?? {}, field))
        ) {
          return [];
        }
        return [{
          field,
          ...(hasBefore ? { before: comparable(oldDoc!, field) } : {}),
          ...(hasAfter ? { after: comparable(newDoc!, field) } : {}),
        }];
      });
    if (kind === "changed" && fields.length === 0) continue;
    const owner = type === "EndpointV0"
      ? (kind === "removed" ? beforeOwners : afterOwners).get(id)
      : doc;
    check(
      owner && typeof owner.native_id === "string" &&
        typeof owner.metaclass === "string",
      `missing native identity or endpoint owner for ${id}`,
    );
    const snapshots = kind === "removed" ? before : after;
    const parent = typeof owner.owner === "string"
      ? snapshots.get(owner.owner)
      : undefined;
    const qualifiedName = owner.qualified_name ?? parent?.qualified_name;
    const ownerLabel = owner.name ?? parent?.name ?? owner.native_id;
    changes.push({
      id,
      nativeId: owner.native_id,
      kind,
      category: categories[type as keyof typeof categories],
      metaclass: type === "EndpointV0" ? "EndpointV0" : owner.metaclass,
      label: type === "EndpointV0"
        ? `${owner.metaclass} ${ownerLabel} · ${doc.role} [${doc.position}]`
        : type === "RelationshipV0"
        ? `${owner.metaclass} ${ownerLabel}`
        : String(ownerLabel),
      ...(typeof qualifiedName === "string" ? { qualifiedName } : {}),
      fields,
    });
  }
  changes.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const counts = { added: 0, removed: 0, changed: 0 };
  for (const change of changes) counts[change.kind]++;
  return {
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    ...(input.sourceDigests ? { sourceDigests: input.sourceDigests } : {}),
    engine: "Git",
    changes: changes.slice(0, input.limit),
    counts,
    truncated: changes.length > input.limit,
  };
}
