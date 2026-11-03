/** Exact, read-only preview of a proposal against its stored base revision. */
import type {
  ModelRevision,
  ProposalRecord,
  SourceChange,
} from "../../../../domain/model/records/revision.ts";
import { compareModelSources, type ModelSourceDiff } from "./diff.ts";
import { canonical } from "../../../../domain/primitives/canonical-json.ts";
import {
  MODEL_DELEGATIONS_FILE,
  readModelDelegations,
} from "../../../governance/model-access/delegation/ledger.ts";

interface ModelProposalPreview {
  proposalId: string;
  agentId: string;
  baseVersion: string;
  proposalVersion: string;
  expectedVersion: string;
  sourceDigest: string;
  stale: boolean;
  /** True only when the displayed native scalar values account for every source byte changed. */
  completeness: boolean;
  rows: Array<{ id: string; label: string; before: string; after: string }>;
  /** Complete exact source fallback, including additions and deletions. */
  sourceChanges: SourceChange[];
  sourceDiff: ModelSourceDiff;
}

interface Span {
  path: string;
  text: string;
  start: number;
  end: number;
}
interface Scalar {
  prefix: string;
  literal: string;
  suffix: string;
  value: string | number | boolean;
  startInDeclaration: number;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** One JSON scalar after one assignment; all surrounding source bytes must
 * remain identical across the two compiled versions. */
function scalar(text: string): Scalar | undefined {
  const match =
    /^([^=]*=\s*)("(?:\\.|[^"\\])*"|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(\s*;\s*)$/s
      .exec(text);
  if (!match || !/\battribute\b/.test(match[1]!)) return undefined;
  try {
    const value: unknown = JSON.parse(match[2]!);
    if (
      !(typeof value === "string" || typeof value === "boolean" ||
        typeof value === "number" && Number.isFinite(value))
    ) return undefined;
    return {
      prefix: match[1]!,
      literal: match[2]!,
      suffix: match[3]!,
      value,
      startInDeclaration: encoder.encode(match[1]!).length,
    };
  } catch {
    return undefined;
  }
}

function nativeScalar(
  revision: ModelRevision,
  attributeId: string,
): { value: string | number | boolean } | undefined {
  const ref = (value: unknown): string | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? typeof (value as Record<string, unknown>)["@id"] === "string"
        ? (value as Record<string, string>)["@id"]
        : undefined
      : undefined;
  const values = revision.elements.filter((element) =>
    element["@type"] === "FeatureValue" &&
    ref(element.featureWithValue) === attributeId
  );
  if (values.length !== 1) return undefined;
  const id = ref(values[0]!.value);
  const literal = revision.elements.find((element) => element["@id"] === id);
  const kind = literal?.["@type"];
  const value = literal?.value;
  if (
    kind === "LiteralString" && typeof value === "string" ||
    kind === "LiteralBoolean" && typeof value === "boolean" ||
    (kind === "LiteralInteger" || kind === "LiteralReal") &&
      typeof value === "number" && Number.isFinite(value)
  ) return { value: value as string | number | boolean };
  return undefined;
}

function span(
  element: Record<string, unknown> | undefined,
  sources: Record<string, string>,
): Span | undefined {
  if (!element) return undefined;
  const path = element["sysx:sourceDocument"];
  const expected = element["sysx:sourceText"];
  const coordinates = [
    element["sysx:sourceLine"],
    element["sysx:sourceColumn"],
    element["sysx:sourceEndLine"],
    element["sysx:sourceEndColumn"],
  ];
  if (
    typeof path !== "string" || !Object.hasOwn(sources, path) ||
    typeof expected !== "string" ||
    !coordinates.every((value) =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0
    )
  ) return undefined;
  const bytes = encoder.encode(sources[path]);
  const starts = [0];
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 10) starts.push(index + 1);
  }
  const offset = (line: number, column: number): number | undefined => {
    const first = starts[line - 1];
    const last = line < starts.length ? starts[line]! - 1 : bytes.length;
    return first !== undefined && column - 1 <= last - first
      ? first + column - 1
      : undefined;
  };
  const start = offset(coordinates[0] as number, coordinates[1] as number);
  const end = offset(coordinates[2] as number, coordinates[3] as number);
  if (start === undefined || end === undefined || end <= start) {
    return undefined;
  }
  try {
    decoder.decode(bytes.subarray(0, start));
    const text = decoder.decode(bytes.subarray(start, end));
    if (text !== expected) return undefined;
    return { path, text, start, end };
  } catch {
    return undefined;
  }
}

function sourceChanges(
  before: Record<string, string>,
  after: Record<string, string>,
): SourceChange[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort().flatMap((path) => {
      const oldExists = Object.hasOwn(before, path);
      const newExists = Object.hasOwn(after, path);
      if (oldExists && newExists && before[path] === after[path]) return [];
      return [{
        path,
        kind: !oldExists
          ? "added" as const
          : !newExists
          ? "deleted" as const
          : "changed" as const,
        ...(oldExists ? { before: before[path] } : {}),
        ...(newExists ? { after: after[path] } : {}),
      }];
    });
}

function administrationRows(
  proposal: ProposalRecord,
  base: ModelRevision,
  proposed: ModelRevision,
  changes: SourceChange[],
): ModelProposalPreview["rows"] {
  const authorization = proposal.authorization;
  if (
    authorization?.kind !== "operator-administration" ||
    changes.length !== 1 || changes[0]!.path !== MODEL_DELEGATIONS_FILE
  ) return [];
  try {
    const before = readModelDelegations(base.sources);
    const after = readModelDelegations(proposed.sources);
    const id = authorization.change.id;
    const old = before.find((record) => record.id === id);
    const next = after.find((record) => record.id === id);
    if (
      !next || canonical(next) !== canonical(authorization.record) ||
      canonical(before.filter((record) => record.id !== id)) !==
        canonical(after.filter((record) => record.id !== id)) ||
      (authorization.change.kind === "grant"
        ? !!old || after.length !== before.length + 1 || next.revoked
        : !old || before.length !== after.length || old.revoked ||
          canonical(next) !== canonical({
              ...old,
              revision: old.revision + 1,
              revoked: true,
            }))
    ) return [];
    const beforeValue = (value: unknown) => old ? JSON.stringify(value) : "";
    const row = (
      field: string,
      label: string,
      before: string,
      after: string,
    ) => ({
      id: `delegation:${id}:${field}`,
      label,
      before,
      after,
    });
    return [
      row(
        "targetSystem",
        "Bénéficiaire",
        old?.targetSystem ?? "",
        next.targetSystem,
      ),
      row(
        "targetHolderNativeId",
        "Identité native",
        old?.targetHolderNativeId ?? "",
        next.targetHolderNativeId,
      ),
      row(
        "mayEdit",
        "Modification du contenu",
        beforeValue(old?.mayEdit),
        JSON.stringify(next.mayEdit),
      ),
      row(
        "operations",
        "Opérations",
        beforeValue(old?.operations),
        JSON.stringify(next.operations),
      ),
      row(
        "grants",
        "Périmètres",
        beforeValue(old?.grants),
        JSON.stringify(next.grants),
      ),
      row(
        "recipients",
        "Destinataires possibles",
        beforeValue(old?.recipients),
        JSON.stringify(next.recipients),
      ),
      row(
        "maxRedelegationDepth",
        "Profondeur de redélégation",
        beforeValue(old?.maxRedelegationDepth),
        JSON.stringify(next.maxRedelegationDepth),
      ),
      row(
        "revoked",
        "Révocation",
        beforeValue(old?.revoked),
        JSON.stringify(next.revoked),
      ),
    ];
  } catch {
    // A malformed or noncanonical ledger cannot support a semantic card.
    return [];
  }
}

export function modelProposalPreview(input: {
  proposal: ProposalRecord;
  agentId: string;
  base: ModelRevision;
  proposed: ModelRevision;
  current: ModelRevision;
}): ModelProposalPreview {
  const { proposal, agentId, base, proposed, current } = input;
  const changes = sourceChanges(base.sources, proposed.sources);
  const beforeAttributes = new Map(
    base.elements.filter((element) =>
      element["@type"] === "AttributeUsage" &&
      typeof element["@id"] === "string"
    ).map((element) => [element["@id"] as string, element]),
  );
  const afterAttributes = new Map(
    proposed.elements.filter((element) =>
      element["@type"] === "AttributeUsage" &&
      typeof element["@id"] === "string"
    ).map((element) => [element["@id"] as string, element]),
  );
  const rows: ModelProposalPreview["rows"] = [];
  const replacements = new Map<
    string,
    Array<{ start: number; end: number; after: string }>
  >();
  for (
    const id of [
      ...new Set([...beforeAttributes.keys(), ...afterAttributes.keys()]),
    ]
      .sort()
  ) {
    const old = beforeAttributes.get(id), next = afterAttributes.get(id);
    const before = span(old, base.sources),
      after = span(next, proposed.sources);
    if (
      !old || !next || !before || !after || before.path !== after.path ||
      before.path === MODEL_DELEGATIONS_FILE
    ) continue;
    const oldScalar = scalar(before.text), nextScalar = scalar(after.text);
    if (
      !oldScalar || !nextScalar ||
      oldScalar.prefix !== nextScalar.prefix ||
      oldScalar.suffix !== nextScalar.suffix ||
      typeof oldScalar.value !== typeof nextScalar.value ||
      oldScalar.literal === nextScalar.literal
    ) continue;
    const oldNative = nativeScalar(base, id),
      nextNative = nativeScalar(proposed, id);
    if (
      !oldNative || !nextNative ||
      !Object.is(oldNative.value, oldScalar.value) ||
      !Object.is(nextNative.value, nextScalar.value)
    ) continue;
    const label = next?.qualifiedName ?? old?.qualifiedName ??
      next?.declaredName ?? old?.declaredName ?? id;
    rows.push({
      id,
      label: String(label),
      before: oldScalar.literal,
      after: nextScalar.literal,
    });
    const entries = replacements.get(before.path) ?? [];
    const start = before.start + oldScalar.startInDeclaration;
    entries.push({
      start,
      end: start + encoder.encode(oldScalar.literal).length,
      after: nextScalar.literal,
    });
    replacements.set(before.path, entries);
  }
  let completeness = changes.every((change) => {
    if (change.kind !== "changed") return false;
    const entries = replacements.get(change.path) ?? [];
    if (!entries.length) return false;
    const source = encoder.encode(change.before!);
    let last = 0;
    const parts: string[] = [];
    for (const entry of entries.toSorted((a, b) => a.start - b.start)) {
      if (entry.start < last || entry.end > source.length) return false;
      parts.push(
        decoder.decode(source.subarray(last, entry.start)),
        entry.after,
      );
      last = entry.end;
    }
    parts.push(decoder.decode(source.subarray(last)));
    return parts.join("") === change.after;
  });
  // A proposed revision must actually differ from its base; empty source
  // changes cannot certify a useful visual account.
  if (!changes.length) completeness = false;
  rows.push(...administrationRows(proposal, base, proposed, changes));
  return {
    proposalId: proposal.id,
    agentId,
    baseVersion: base.version,
    proposalVersion: proposed.version,
    expectedVersion: current.version,
    sourceDigest: proposed.sourceDigest,
    stale: base.version !== current.version,
    completeness,
    rows,
    sourceChanges: changes,
    sourceDiff: compareModelSources(base.sources, proposed.sources),
  };
}
