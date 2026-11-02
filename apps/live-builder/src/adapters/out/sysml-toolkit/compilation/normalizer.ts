/** Toolkit-native full interchange -> the versioned ASE reader shape.
 * Native IDs and semantic flags are retained. Source joins use SDK byte extents;
 * implicit decision branches use the SDK's declaration-ordered ownedMember.
 */
import type { JsonObject } from "../../../../domain/model/records/compiled-model.ts";

export interface ToolkitUnit {
  unit: number;
  name: string;
  text: string;
}
/** Bumped whenever normalizeToolkit changes its output; part of recipe R. */
export const NORMALIZER_VERSION = 2;
export interface ToolkitRow {
  memberExtent?: { unit: number; start: number; end: number } | null;
  name?: string | null;
  qualifiedName?: string | null;
  metaclass?: string;
  isLibraryElement?: boolean;
  owner?: string | null;
}
export function toolkitRefs(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).flatMap((v) =>
    v && typeof v === "object" && typeof (v as JsonObject)["@id"] === "string"
      ? [(v as JsonObject)["@id"] as string]
      : []
  );
}
/** Comments and quoted strings cannot create control keywords or body braces. */
export function toolkitTokens(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) {
      index += whitespace[0].length;
      continue;
    }
    if (rest.startsWith("//")) {
      const end = source.indexOf("\n", index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Unterminated Toolkit member comment");
      index = end + 2;
      continue;
    }
    if (rest[0] === '"' || rest[0] === "'") {
      const quote = rest[0];
      let end = index + 1;
      for (; end < source.length; end++) {
        if (source[end] === "\\") {
          end++;
          continue;
        }
        if (source[end] === quote) break;
      }
      if (end === source.length) {
        throw new Error("Unterminated Toolkit member token");
      }
      tokens.push(source.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(rest);
    if (word) {
      tokens.push(word[0]);
      index += word[0].length;
    } else {
      tokens.push(rest[0]);
      index++;
    }
  }
  return tokens;
}
export function normalizeToolkit(
  raw: JsonObject[],
  rows: Map<string, ToolkitRow>,
  units: ToolkitUnit[],
): JsonObject[] {
  const elements = structuredClone(raw);
  const byId = new Map(elements.map((e) => [String(e["@id"]), e]));
  if (byId.size !== elements.length) {
    throw new Error("Duplicate Toolkit identity");
  }
  const unitById = new Map(units.map((u) => [u.unit, u]));
  const encoder = new TextEncoder(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  for (const e of elements) {
    const extent = rows.get(String(e["@id"]))?.memberExtent;
    if (!extent) continue;
    const unit = unitById.get(extent.unit);
    if (!unit) throw new Error(`Unknown Toolkit source unit ${extent.unit}`);
    const bytes = encoder.encode(unit.text);
    if (
      !Number.isSafeInteger(extent.start) ||
      !Number.isSafeInteger(extent.end) || extent.start < 0 ||
      extent.end < extent.start || extent.end > bytes.length
    ) throw new Error("Invalid Toolkit source extent");
    const text = decoder.decode(bytes.slice(extent.start, extent.end));
    const prefix = decoder.decode(bytes.slice(0, extent.start));
    const through = decoder.decode(bytes.slice(0, extent.end));
    const startLines = prefix.split("\n"), endLines = through.split("\n");
    const tokens = toolkitTokens(text);
    if (e["@type"] === "PartUsage") {
      const part = tokens.indexOf("part");
      // The extent must contain a direct part declaration, not an alias
      // or an inherited/implied feature. Keywords inside strings are tokens.
      const prefixes = new Set([
        "public",
        "private",
        "protected",
        "abstract",
        "variation",
        "readonly",
        "derived",
        "end",
        "individual",
        "snapshot",
        "timeslice",
        "ref",
      ]);
      if (part >= 0 && tokens.slice(0, part).every((t) => prefixes.has(t))) {
        e["sysx:declaredReference"] = tokens.slice(0, part).includes("ref");
      }
    }
    Object.assign(e, {
      "sysx:sourceDocument": unit.name,
      "sysx:sourceText": text,
      "sysx:sourceLine": startLines.length,
      "sysx:sourceColumn": encoder.encode(startLines.at(-1)!).length + 1,
      "sysx:sourceEndLine": endLines.length,
      "sysx:sourceEndColumn": encoder.encode(endLines.at(-1)!).length + 1,
      "sysx:hasBody": tokens.includes("{"),
    });
  }
  for (const owner of elements) {
    const members = toolkitRefs(owner.ownedMember);
    members.forEach((id, index) => {
      const member = byId.get(id);
      if (member) member["sysx:memberIndex"] = index;
    });
    let decision: JsonObject | undefined;
    let branchStarted = false, elseSeen = false;
    for (const id of members) {
      const e = byId.get(id);
      if (!e) throw new Error(`Toolkit owned member missing: ${id}`);
      if (e["@type"] === "DecisionNode") {
        decision = e;
        branchStarted = false;
        elseSeen = false;
        continue;
      }
      if (e["@type"] !== "TransitionUsage") {
        decision = undefined;
        continue;
      }
      const selfSource = toolkitRefs(e.source).includes(id);
      if (!selfSource) {
        // The corrected Toolkit establishes the native source itself. `else`
        // is still a spelling marker (there is no guardExpression for it),
        // independent of whether endpoint repair was needed by an older SDK.
        const text = e["sysx:sourceText"];
        if (typeof text === "string" && toolkitTokens(text)[0] === "else") {
          if (toolkitRefs(e.guardExpression).length) {
            throw new Error(`Toolkit else branch also declares a guard: ${id}`);
          }
          e["sysx:isElse"] = true;
        }
        decision = undefined;
        continue;
      }
      const source = e["sysx:sourceText"];
      if (typeof source !== "string") {
        throw new Error(`Toolkit branch lacks native source extent: ${id}`);
      }
      const tokens = toolkitTokens(source);
      const isElse = tokens[0] === "else";
      if (
        !decision || (!isElse && tokens[0] !== "if") || elseSeen ||
        (isElse && (!branchStarted || toolkitRefs(e.guardExpression).length))
      ) throw new Error(`Unsupported Toolkit implicit transition: ${id}`);
      if (!isElse && toolkitRefs(e.guardExpression).length !== 1) {
        throw new Error(
          `Toolkit conditional branch requires one native guard: ${id}`,
        );
      }
      const successionIds = toolkitRefs(e.succession);
      const succession = successionIds.length === 1
        ? byId.get(successionIds[0])
        : undefined;
      if (!succession || succession["@type"] !== "SuccessionAsUsage") {
        throw new Error(`Toolkit branch lacks native succession: ${id}`);
      }
      const predecessor = { "@id": decision["@id"] };
      e.source = predecessor;
      e["sysx:isElse"] = isElse;
      succession["sysx:sourceMember"] = predecessor;
      branchStarted = true;
      elseSeen = isElse;
    }
  }
  for (const e of elements) {
    if (
      e["@type"] === "TransitionUsage" &&
      toolkitRefs(e.source).includes(String(e["@id"]))
    ) {
      throw new Error(
        `Unnormalized Toolkit self-source transition: ${e["@id"]}`,
      );
    }
  }
  return elements;
}
