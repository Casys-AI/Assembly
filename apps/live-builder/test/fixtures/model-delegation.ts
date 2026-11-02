/** Native three-operator fixture for administration without direct editing rights. */
import assert from "node:assert/strict";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { NativeModelSourceAuthorization } from "../../src/adapters/governance/model-access/source-authorization.ts";
import { SourceModel } from "../../src/adapters/model/sources/source-model.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import type { ModelDelegationChange } from "../../src/domain/governance/records/model-delegation-request.ts";
import type { ModelIdentity } from "../../src/domain/work/dialogue.ts";
import { editPolicy, mandateSources } from "./model-edit-mandate.ts";

export const delegationSystems = {
  root: "AssemblyLiveBuilder::liveBuilder",
  peer: "AssemblyLiveBuilder::mandatePeer",
  leaf: "AssemblyLiveBuilder::mandateLeaf",
} as const;

function jsonLiteral(value: unknown): string {
  return JSON.stringify(JSON.stringify(value));
}

function occurrence(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert(start >= 0, marker);
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
  return source.slice(start, end);
}

export async function delegationSources() {
  const sources = await mandateSources({ noPolicy: true });
  const original = sources["configuration.sysml"]!;
  assert(original.includes(editPolicy("Work::beta")));
  const source = original.replace(editPolicy("Work::beta"), "");
  const peer = occurrence(source, "part mandatePeer : ConversationSystem {");
  const leaf = peer.replace(
    "part mandatePeer : ConversationSystem {",
    "part mandateLeaf : ConversationSystem {",
  ).replaceAll("mandate-peer-native", "mandate-leaf-native")
    .replace("Scoped peer", "Scoped leaf");
  const close = source.lastIndexOf("\n}");
  assert(close >= 0);
  sources["configuration.sysml"] =
    (source.slice(0, close) + "\n" + leaf + source.slice(close)).replace(
      "part liveBuilder : ConversationSystem {",
      `part liveBuilder : ConversationSystem {
part modelAdministrationPolicy : AssemblyModelAdministration::ModelAdministrationPolicy {
 attribute :>> id = "root-administration";
 attribute :>> revision = 1;
 attribute :>> operations = ${jsonLiteral(["set-value", "rename"])};
 attribute :>> grants = ${
        jsonLiteral([{
          file: "mission.sysml",
          qualifiedRoots: ["Work::alpha"],
        }])
      };
 attribute :>> recipients = ${
        jsonLiteral([delegationSystems.peer, delegationSystems.leaf])
      };
 attribute :>> maxRedelegationDepth = 1;
}
bind modelAdministrationPolicy.holder = builder;
bind modelAdministrationPolicy.mandate = builderMandate;
bind modelAdministrationPolicy.issuer = owner.ownerMandate.rootAuthority;
`,
    );
  return sources;
}

export async function openDelegationFixture(packageDir: string) {
  const directory = await Deno.makeTempDir({
    prefix: "ase-model-delegation-",
  });
  const projectId = `git:${crypto.randomUUID()}`;
  const repository = await GitModelRepository.open({
    projectDir: directory,
    compiler: new ToolkitCompiler({ packageDir }),
    sourceAuthorization: new NativeModelSourceAuthorization(projectId),
  });
  const tooling = new SysmlToolkitAdapter({ packageDir });
  const primary = new SourceModel({
    repository,
    projectId,
    tooling,
    initialSources: await delegationSources(),
  });
  const primaryIdentity = await primary.initialize();
  const peer = new SourceModel({
    repository,
    projectId,
    tooling,
    systemQualifiedName: delegationSystems.peer,
  });
  const leaf = new SourceModel({
    repository,
    projectId,
    tooling,
    systemQualifiedName: delegationSystems.leaf,
  });
  const peerIdentity = await peer.initialize();
  const leafIdentity = await leaf.initialize();
  return {
    directory,
    projectId,
    repository,
    primary,
    primaryIdentity,
    peer,
    peerIdentity,
    leaf,
    leafIdentity,
    async propose(
      model: SourceModel,
      identity: ModelIdentity,
      change: ModelDelegationChange,
    ) {
      const head = await repository.current();
      const current = await model.readExecutableModel(identity);
      return await model.proposeDelegation(identity, {
        baseVersion: head.version,
        sourceDigest: head.sourceDigest,
        reason: "Native delegated administration qualification",
        change,
      }, current.version.digest);
    },
    async accept(id: string) {
      return await repository.accept({
        id,
        expectedVersion: (await repository.current()).version,
        author: "local-owner",
        decisionAuthorityExercise: exerciseOwnerAuthority(
          await primary.readExecutableModel(primaryIdentity),
          "model-revision",
        ),
      });
    },
    async close() {
      await Deno.remove(directory, { recursive: true });
    },
  };
}
