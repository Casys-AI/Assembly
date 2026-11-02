import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import {
  artifactModel,
  publishedArtifact,
  reuseBehavior,
} from "../../../../test/support/tool-artifact-fixture.ts";
import type { ToolReuseImport } from "./catalog.ts";
import {
  importAdmittedArtifact,
  importArtifact,
  type ToolArtifactImportHost,
  verifiedToolReuseReceipt,
} from "./import.ts";
import { draftDigest } from "../runtime/values.ts";
import type { Candidate } from "../../../domain/work/candidates.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";

const AT = "2026-10-28T00:00:00.000Z";

async function setup() {
  const artifact = await publishedArtifact();
  const manifestDigest = "ab".repeat(32);
  const prefix = `artifacts/${manifestDigest}/`;
  artifact.candidate.sourceBinding = {
    version: 1,
    bindingId: "binding-source",
    versionId: "version-source",
    revision: 1,
    ownerId: artifact.agentId,
    localArtifactId: artifact.candidate.id,
    invocationId: "publication-source",
    reference: {
      version: 2,
      scopeId: "scope",
      repositoryId: "repo",
      artifactId: artifact.candidate.id,
      kind: "tool-draft",
      commitOid: "12".repeat(20),
      entryPath: `${prefix}source.json`,
      manifestPath: `${prefix}manifest.json`,
      contentEncoding: "tool-draft-json-v1",
      contentDigest: artifact.candidate.digest,
      manifestFormat: "assembly-artifact-package-v2",
      manifestDigestVersion: "sha256-canonical-json-v1",
      manifestDigest,
    },
  };
  const native = artifactModel("destination");
  const behavior = reuseBehavior();
  native.behaviors = [behavior];
  const template = native.flows.conversation.nodes[0]!;
  native.flows.conversation.nodes.push({
    ...structuredClone(template),
    id: "test-invoke",
    nativeId: "test-invoke",
    mechanism: "invoke_tool",
  });
  const proof = {
    behavior: structuredClone(behavior),
    callerId: "destination",
    invocationId: "import-one",
    modelVersion: {
      digest: native.version.digest,
      repositoryVersion: native.version.repositoryVersion!,
    },
  };
  const input: ToolReuseImport = {
    proof: structuredClone(proof),
    artifact: structuredClone(artifact),
  };
  const state = {
    id: "import-test",
    revision: 1,
    catalogRevision: 0,
    executionModel: structuredClone(native),
    model: structuredClone(native.identity),
    messages: [],
    candidates: [],
    events: [],
    busy: true,
    phase: "importing",
    provider: "fixture",
  } as unknown as SystemRuntimeState;
  let nativeActive = true;
  const host = {
    state,
    pending: Promise.resolve(),
    execution: { digest: native.version.digest, actionId: "test-invoke" },
    behaviorInvocation: {
      behavior: structuredClone(behavior),
      input: {
        sourceAgentId: artifact.agentId,
        candidateId: artifact.candidate.id,
        digest: artifact.candidate.digest,
      },
      callerId: "destination",
      invocationId: "import-one",
      modelVersion: structuredClone(proof.modelVersion),
    },
    artifactImports: new Map(),
    currentModel: () => Promise.resolve(structuredClone(native)),
    candidate: (id: string) => state.candidates.find((c) => c.id === id)!,
    update: (change: (s: SystemRuntimeState) => void) => {
      change(state);
      return Promise.resolve();
    },
    build: (async (
      ...args: Parameters<ToolArtifactImportHost["build"]>
    ) => {
      const [draft, _resumeId, origin] = args;
      const created: Candidate = {
        ...structuredClone(draft!),
        id: "destination-candidate",
        digest: await draftDigest(draft!),
        stage: "proposed",
        createdAt: AT,
        baseCatalogRevision: 0,
        reusedFrom: structuredClone(origin!),
      };
      state.candidates.push(created);
    }) as ToolArtifactImportHost["build"],
    nativeCandidate: () => nativeActive,
    importArtifact: ((
      ...args: Parameters<ToolArtifactImportHost["importArtifact"]>
    ) => importArtifact.call(host, ...args)) as ToolArtifactImportHost[
      "importArtifact"
    ],
    verifiedToolReuseReceipt: ((
      ...args: Parameters<ToolArtifactImportHost["verifiedToolReuseReceipt"]>
    ) =>
      verifiedToolReuseReceipt.call(
        host,
        ...args,
      )) as ToolArtifactImportHost["verifiedToolReuseReceipt"],
    setNativeActive: (value: boolean) => {
      nativeActive = value;
    },
  } as unknown as ToolArtifactImportHost & {
    setNativeActive(value: boolean): void;
  };
  return { artifact, native, input, state, host };
}

Deno.test("admitted import requires its exact native invocation in progress", async () => {
  const { input, host } = await setup();
  const idle = {
    ...host,
    state: { ...host.state, busy: false },
  } as unknown as ToolArtifactImportHost;
  await rejects(
    () => importAdmittedArtifact.call(idle, structuredClone(input)),
    /invocation native en cours exacte/,
  );
  const foreign = {
    ...host,
    behaviorInvocation: {
      ...(host.behaviorInvocation!),
      invocationId: "another-invocation",
    },
  } as unknown as ToolArtifactImportHost;
  await rejects(
    () => importAdmittedArtifact.call(foreign, structuredClone(input)),
    /invocation native en cours exacte/,
  );
});

Deno.test("first import builds one local candidate and returns a fresh receipt", async () => {
  const { artifact, input, state, host } = await setup();
  const receipt = await importAdmittedArtifact.call(
    host,
    structuredClone(input),
  );
  equal(receipt.candidateId, "destination-candidate");
  equal(receipt.replayed, false);
  equal(receipt.stage, "proposed");
  equal(receipt.active, false);
  equal(receipt.correlationId, "import-one");
  deepStrictEqual(receipt.source, {
    agentId: artifact.agentId,
    candidateId: artifact.candidate.id,
    digest: artifact.candidate.digest,
  });
  equal(state.candidates.length, 1);
  equal(state.candidates[0]!.reusedFrom?.correlationId, "import-one");
  ok(state.events.some((event) => event.kind === "tool-artifact-imported"));
});

Deno.test("replay returns the same candidate with a replayed receipt", async () => {
  const { input, state, host } = await setup();
  const first = await importAdmittedArtifact.call(
    host,
    structuredClone(input),
  );
  const second = await importAdmittedArtifact.call(
    host,
    structuredClone(input),
  );
  equal(second.candidateId, first.candidateId);
  equal(second.replayed, true);
  equal(state.candidates.length, 1);
});

Deno.test("a concurrent correlation pointing at other bytes is refused", async () => {
  const { input, host } = await setup();
  host.artifactImports.set("import-one", {
    signature: "another-signature",
    pending: Promise.resolve({} as never),
  });
  await rejects(
    () => importAdmittedArtifact.call(host, structuredClone(input)),
    /autre artefact/,
  );
});

Deno.test("verified receipt requires native confirmation for active candidates", async () => {
  const { input, state, host } = await setup();
  const receipt = await importAdmittedArtifact.call(
    host,
    structuredClone(input),
  );
  const candidate = state.candidates[0]!;
  candidate.stage = "active";
  candidate.tests = { passed: true, checks: [] };
  candidate.admission = {
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    mandateRevision: 1,
    configurationRevision: 0,
    authority: "builder",
    actorId: "destination",
    reason: "characterisation",
    at: AT,
  };
  host.setNativeActive(false);
  await rejects(
    () => verifiedToolReuseReceipt.call(host, receipt.candidateId, false),
    /ne confirme plus/,
  );
  host.setNativeActive(true);
  const verified = await verifiedToolReuseReceipt.call(
    host,
    receipt.candidateId,
    false,
  );
  equal(verified.active, true);
  equal(verified.testsPassed, true);
});

Deno.test("import refuses when the recorded correlation no longer matches source bytes", async () => {
  const { input, state, host } = await setup();
  await importAdmittedArtifact.call(host, structuredClone(input));
  state.candidates[0]!.code += "\n// mutated";
  await rejects(
    () =>
      importArtifact.call(host, structuredClone(input), {
        name: "html-reader",
        description: "Transforme le HTML fourni.",
        kind: "read_web_page",
        code: "export default ({html}) => ({title:'Page',text:html})",
      }),
    /ne correspond plus/,
  );
});
