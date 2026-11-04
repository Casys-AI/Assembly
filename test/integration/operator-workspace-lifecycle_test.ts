import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { openOperatorWorkspace } from "../../src/composition/operator-workspace.ts";
import type { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { sourceModelIdentity } from "../../src/domain/model/records/source-identity.ts";
import type { ModelRevision } from "../../src/domain/model/records/revision.ts";
import { executableFixture } from "../support/execution-fixture.ts";
import { requestControlState } from "../support/request-space-fixture.ts";

const projectId = "git:eaa8ee83-b912-5b8d-b114-db28a72570bd";

// A single discoverable operator needs no compiler, database or native worker.
const revision: ModelRevision = {
  version: "admitted",
  sources: {},
  documents: [],
  sourceDigest: "admitted",
  semanticDigest: "admitted",
  provenanceDigest: "admitted",
  sourceHashes: {},
  engineVersion: "fixture",
  elements: [
    {
      "@id": "package",
      "@type": "Package",
      declaredName: "Team",
      qualifiedName: "Team",
    },
    {
      "@id": "definition",
      "@type": "PartDefinition",
      declaredName: "ConversationSystem",
      qualifiedName: "Team::ConversationSystem",
      owner: { "@id": "package" },
    },
    {
      "@id": "system",
      "@type": "PartUsage",
      declaredName: "main",
      qualifiedName: "Team::main",
      owner: { "@id": "package" },
      type: [{ "@id": "definition" }],
    },
    ...["catalog", "builder"].map((part) => ({
      "@id": part,
      "@type": "PartUsage",
      declaredName: part,
      qualifiedName: `Team::main::${part}`,
      owner: { "@id": "system" },
    })),
  ],
};

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}

Deno.test("workspace prepares authority before activation and drains before disposal", async () => {
  const model = executableFixture(
    sourceModelIdentity(revision, projectId, "Team::main"),
  );
  model.version.repositoryVersion = revision.version;
  model.operator = {
    name: "Main",
    instruction: "Main",
    humanInput: true,
    primary: true,
  };
  const snapshot = requestControlState();
  snapshot.executionModel = model;
  snapshot.model = model.identity;
  const events: string[] = [];
  const idleEntered = gate();
  const releaseIdle = gate();
  const primary = {
    snapshot,
    cases: { cases: [] },
    configureTaskSourceInputs() {},
    bindWatchNotifications() {},
    bindOperatorCommandAuthority() {
      events.push("command-authority");
    },
    bindArtifactSourceAuthority() {
      events.push("artifact-authority");
    },
    bindOperatorAuthorityLifecycle() {
      events.push("operator-authority");
    },
    bindOperatorRegistry() {},
    onState() {
      return () => events.push("unsubscribe");
    },
    prepareInitialTools() {
      events.push("tools-ready");
      return Promise.resolve();
    },
    async idle() {
      events.push("idle-entered");
      idleEntered.resolve();
      await releaseIdle.promise;
      events.push("idle-finished");
    },
  } as unknown as SystemRuntime;
  const unused = () => {
    throw new Error("Unexpected workspace port");
  };
  const options = {
    primary,
    repository: { at: () => Promise.resolve(revision) },
    bindArtifactSourceAuthority() {
      return () => events.push("artifact-unbound");
    },
    storage: { operator: unused },
    execution: {},
    dispatch: {},
    assertCommandOrigin: unused,
    artifactSources: unused,
    assertArtifactSourceOrigin: unused,
    caseNumbers: {},
    schemaValidator: {},
    primaryModel: {},
    tooling: {},
    sourceExecutablesCompilation: {},
    createSourceModel: unused,
    agents: {},
    directory: ".",
    executors: [],
  } as unknown as Parameters<typeof openOperatorWorkspace>[0];
  const workspace = await openOperatorWorkspace(options);
  let closing: Promise<void> | undefined;
  try {
    deepStrictEqual(events, [
      "command-authority",
      "artifact-authority",
      "operator-authority",
      "tools-ready",
    ]);
    await workspace.activateRuntimeDeliveries();
    closing = workspace.close();
    await idleEntered.promise;
    await rejects(workspace.activateRuntimeDeliveries(), /closing/);
    equal(events.includes("artifact-unbound"), false);
    equal(events.includes("unsubscribe"), false);
    releaseIdle.resolve();
    await closing;
    equal(events.includes("artifact-unbound"), true);
    equal(events.includes("unsubscribe"), true);
    equal(
      events.indexOf("idle-finished") < events.indexOf("artifact-unbound"),
      true,
    );
    equal(
      events.indexOf("artifact-unbound") < events.indexOf("unsubscribe"),
      true,
    );
    await rejects(
      workspace.conversations.reconcileUnits({
        repositoryVersion: revision.version,
        units: [],
      }),
      { code: "RUNTIME_DISPOSED" },
    );
  } finally {
    releaseIdle.resolve();
    await (closing ?? workspace.close());
  }
});
