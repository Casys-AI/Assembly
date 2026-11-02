import assert from "node:assert/strict";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import type { ToolDraft } from "../../src/domain/work/candidates.ts";
import { withInitialTools } from "../../src/adapters/work/tools/initial-catalog.ts";

export const retainedToolDraft = {
  name: "retained-reader",
  description: "Exact public source retained independently of runtime lifetime",
  kind: "read_web_page" as const,
  code: "export default ({html}) => ({title:'Page',text:html})",
};

/** Existing retention fixture's lexical extraction; never changes model bytes. */
export function sourceBlock(
  text: string,
  header: string,
): { from: number; to: number } {
  const syntax = text.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"/g,
    (value) => value.replace(/[^\n]/g, " "),
  );
  const from = syntax.indexOf(header);
  assert(from >= 0, `Missing fixture block: ${header}`);
  const open = syntax.indexOf("{", from);
  let to = open + 1, depth = 1;
  while (depth && to < syntax.length) {
    if (syntax[to] === "{") depth++;
    if (syntax[to] === "}") depth--;
    to++;
  }
  assert.equal(depth, 0);
  return { from, to };
}

/** Two actual source units, with one tool seed on PRIMARY. The candidate still
 * needs the ordinary preparation/tests/explicit admission/publication path. */
export async function savedSystemRetentionSources(
  options: {
    information?: boolean;
    distinctSecondaryInstruction?: boolean;
    tools?: Array<ToolDraft & { id: string }>;
    networkHost?: string;
    /** A native creation grant held by PRIMARY (4.8e): mirrored onto the
     * Branch Operator of every Request opened from this source. */
    creationPolicy?: {
      maxChildren: number;
      maxDelegationDepth?: number;
      mode?: "autonomous" | "per-creation";
    };
  } = {},
) {
  const base = await loadInitialSources(undefined, {
    information: options.information ?? false,
  });
  const raw = base["configuration.sysml"]!;
  const range = sourceBlock(raw, "part liveBuilder : ConversationSystem {");
  let collector = raw.slice(range.from, range.to)
    .replace(
      "part liveBuilder : ConversationSystem {",
      "part collector : ConversationSystem {",
    )
    .replace(
      'configurationId : String = "live-builder-native"',
      'configurationId : String = "collector-native"',
    )
    .replace(
      'operatorName : String = "Main Operator"',
      'operatorName : String = "Retained collector"',
    )
    .replace(
      "primaryContact : Boolean = true",
      "primaryContact : Boolean = false",
    )
    .replace(
      "humanInputEnabled : Boolean = true",
      "humanInputEnabled : Boolean = false",
    );
  if (options.distinctSecondaryInstruction) {
    collector = collector.replace(
      /attribute operatorInstruction : String = "(?:\\.|[^"\\])*";/,
      'attribute operatorInstruction : String = "Keep the secondary source and its independent settings unchanged.";',
    );
  }
  const seeded = withInitialTools(
    base,
    {
      format: 1,
      tools: options.tools ?? [{ id: "saved-reader-v1", ...retainedToolDraft }],
    },
    await Deno.readTextFile(
      new URL("../../models/initial-tools.sysml", import.meta.url),
    ),
  );
  const hosted = options.networkHost
    ? seeded["configuration.sysml"]!.replace(
      'attribute networkHosts : String = "[]";',
      `attribute networkHosts : String = "[\\"${options.networkHost}\\"]";`,
    )
    : seeded["configuration.sysml"]!;
  const grant = options.creationPolicy;
  const text = grant
    ? hosted.replace(
      "part liveBuilder : ConversationSystem {",
      `part liveBuilder : ConversationSystem {
        part creationPolicy : AssemblyAuthority::OperatorCreationPolicy {
          attribute :>> id = "primary-team-creation";
          attribute :>> revision = 1;
          attribute :>> enabled = true;
          attribute :>> networkHosts = "[]";
          attribute :>> maxChildren = ${grant.maxChildren};
          attribute :>> maxDelegationDepth = ${grant.maxDelegationDepth ?? 0};${
        grant.mode ? `\n          attribute :>> mode = "${grant.mode}";` : ""
      }
        }
        bind creationPolicy.holder = builder;
        bind creationPolicy.mandate = builderMandate;
        bind creationPolicy.issuer = owner.ownerMandate.rootAuthority;`,
    )
    : hosted;
  const end = text.lastIndexOf("\n}");
  assert(end > range.to);
  return {
    ...seeded,
    "configuration.sysml": text.slice(0, end) + "\n" + collector + "\n" +
      text.slice(end),
  };
}
