/** Real Toolkit/Git fixture shared by deterministic and opt-in paid qualification. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { openPostgresRuntimeFixture } from "../support/postgres-runtime-fixture.ts";
import { createModelProject } from "../../src/adapters/out/filesystem/model-project.ts";
import { toolkitPackageDir } from "../../src/composition/model-backend.ts";
import {
  loadInitialSources,
} from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
import type { ModelRevision } from "../../src/domain/model/records/revision.ts";
import type { ModelEdit } from "../../src/domain/model/editing/tooling.ts";

const operations = ["set-value", "rename", "insert-member", "remove"];
function literal(value: unknown): string {
  return JSON.stringify(JSON.stringify(value));
}
export function editPolicy(root: string, extra = false): string {
  return `
part modelEditPolicy : AssemblyModelEditing::ModelEditPolicy {
 attribute :>> id = "edit-${root.replaceAll("::", "-")}";
 attribute :>> revision = 1;
 attribute :>> operations = ${
    literal(extra ? [...operations, "replace-source"] : operations)
  };
 attribute :>> grants = ${
    literal([{
      file: root.startsWith("AssemblyLiveBuilder")
        ? "configuration.sysml"
        : "mission.sysml",
      qualifiedRoots: [root],
    }])
  };
}
bind modelEditPolicy.holder = builder;
bind modelEditPolicy.mandate = builderMandate;
bind modelEditPolicy.issuer = owner.ownerMandate.rootAuthority;
`;
}
export async function mandateSources(
  options: {
    raw?: boolean;
    noPolicy?: boolean;
    externalReferences?: boolean;
    ownSystem?: boolean;
  } = {},
): Promise<Sources> {
  const sources = await loadInitialSources(undefined, { information: false });
  const source = sources["configuration.sysml"]!;
  const marker = "part liveBuilder : ConversationSystem {";
  const start = source.indexOf(marker);
  assert(start >= 0);
  const code = source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"/g,
    (text) => text.replace(/[^\n]/g, " "),
  );
  let end = code.indexOf("{", start) + 1, depth = 1;
  while (depth && end < code.length) {
    if (code[end] === "{") depth++;
    if (code[end] === "}") depth--;
    end++;
  }
  assert.equal(depth, 0);
  const peer = source.slice(start, end).replace(
    marker,
    `part mandatePeer : ConversationSystem {${
      editPolicy("Work::beta", options.raw)
    }
 attribute operatorName : String = "Scoped peer";
 attribute operatorInstruction : String = "Edit only the delegated beta root.";
 attribute primaryContact : Boolean = false;
 attribute humanInputEnabled : Boolean = false;`,
  ).replace(
    'configurationId : String = "live-builder-native"',
    'configurationId : String = "mandate-peer-native"',
  ) // B11: cloned unit keeps its own endpoint; drop the copied designer fields.
    .replace(
      /\n *attribute operatorName : String = "(?:Designer|Main Operator)";/,
      "",
    )
    .replace(
      /\n *attribute operatorInstruction : String = "Design and evolve this system with the person, and create operators to handle Requests\.";/,
      "",
    )
    .replace(/\n *attribute primaryContact : Boolean = true;/, "")
    .replace(/\n *attribute humanInputEnabled : Boolean = true;/, "");
  const close = source.lastIndexOf("\n}");
  sources["configuration.sysml"] =
    (source.slice(0, close) + "\n" + peer + source.slice(close)).replace(
      marker,
      marker +
        (options.noPolicy ? "" : editPolicy(
          options.ownSystem
            ? "AssemblyLiveBuilder::liveBuilder"
            : "Work::alpha",
          options.raw,
        )),
    );
  sources["mission.sysml"] = `package Work {
 private import ScalarValues::*;
 package alpha {
  attribute value : Integer = 1;
  attribute removable : Integer = 7;
  attribute localReference : Integer = value;
 }
 // Preserve this separator and UTF-8 台灣 exactly.
 part def SeparatorA;
 part def SeparatorB;
 part def SeparatorC;
 package beta {
  attribute value : Integer = 2;
  ${
    options.externalReferences
      ? "attribute outsideReference : Integer = Work::alpha::value;"
      : ""
  }
 }
}\n`;
  if (options.externalReferences) {
    sources["external.sysml"] =
      `package External { private import ScalarValues::*; attribute outsideReference : Integer = Work::alpha::value; }\n`;
  }
  return sources;
}
export function nativeId(
  revision: ModelRevision,
  qualifiedName: string,
): string {
  const matches = revision.elements.filter((element) =>
    element.qualifiedName === qualifiedName
  );
  assert.equal(matches.length, 1, qualifiedName);
  return String(matches[0]!["@id"]);
}
export function editRequest(revision: ModelRevision, edits: ModelEdit[]) {
  return {
    baseVersion: revision.version,
    sourceDigest: revision.sourceDigest,
    reason: "Mandate-scoped qualification",
    edits,
  };
}
export async function openMandateFixture(
  packageDir: string,
  options: Parameters<typeof mandateSources>[0] = {},
) {
  const directory = await Deno.makeTempDir({
    prefix: "ase-model-edit-mandate-",
  });
  assert.equal(
    await Deno.realPath(packageDir),
    await Deno.realPath(toolkitPackageDir()),
  );
  const dataDir = join(directory, "instance");
  await createModelProject({
    root: dataDir,
    name: "model-project",
    sources: await mandateSources(options),
  });
  const postgres = await openPostgresRuntimeFixture({ dataDir });
  const { tooling, model: primary, projectId } = postgres.backend;
  const repository = postgres.repository;
  let ready = false;
  try {
    const primaryIdentity = await primary.initialize();
    const peer = postgres.backend.createSourceModel({
      systemQualifiedName: "AssemblyLiveBuilder::mandatePeer",
    });
    const peerIdentity = await peer.initialize();
    await primary.readExecutableModel(primaryIdentity);
    await peer.readExecutableModel(peerIdentity);
    ready = true;
    return {
      directory,
      dataDir,
      projectDir: postgres.backend.project.projectDir,
      postgres,
      repository,
      tooling,
      primary,
      primaryIdentity,
      peer,
      peerIdentity,
      projectId,
      async close() {
        await postgres.close();
        await Deno.remove(directory, { recursive: true });
      },
    };
  } finally {
    if (!ready) await postgres.close();
  }
}
