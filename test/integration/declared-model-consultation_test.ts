/** Application primitive with the real context adapter; no Toolkit, DB or provider. */
import assert from "node:assert/strict";
import {
  consultDeclaredModelSource,
  type DeclaredModelConsultationHost,
} from "../../src/application/work/conversation/declared-model-consultation.ts";
import { ModelContextInformation } from "../../src/application/model/consultation/context-information.ts";
import type { ModelConsultationReader } from "../../src/application/work/context/information-ports.ts";
import type { ModelContextOverview } from "../../src/domain/model/consultation/context.ts";
import type { MessageObservation } from "../../src/domain/work/policies/context-separation.ts";
import type { SystemRuntimeState } from "../../src/domain/work/dialogue.ts";
import { artifactModel } from "../support/tool-artifact-fixture.ts";
import { SystemRuntime } from "../support/system-runtime.ts";
import { enableCommandFixtureProfile } from "../support/execution-fixture.ts";
import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import { ModelContextReader } from "../../src/application/model/consultation/source-reader.ts";
import { materialize } from "../../src/domain/model/value-objects/artifact.ts";
import type { ChatContext } from "../../src/domain/work/dialogue.ts";

function fixture() {
  const model = artifactModel("reader");
  model.policy.mayProposeSysmlRevision = true;
  const admitted = structuredClone(model);
  const content = "package DeclaredSource {}\n";
  const path = "conversation.sysml";
  const sha256 = "deterministic-source-hash";
  const sourceDigest = "deterministic-revision-digest";
  const events: string[] = [];
  const observations: MessageObservation[] = [];
  let publishedVersion = model.version.repositoryVersion!;
  let duringOverview = () => {};
  const snapshot: SystemRuntimeState = {
    id: "conversation-1",
    revision: 1,
    catalogRevision: 0,
    model: model.identity,
    executionModel: admitted,
    candidates: [],
    events: [],
    busy: true,
    phase: "active",
    provider: "test",
    caseInvocation: { kind: "local", caseId: "case-1" },
    cases: [{
      id: "case-1",
      number: 1,
      type: "request",
      objective: "Read the declared source",
      owner: model.identity.builderId,
      openedBy: model.identity.builderId,
      openedFrom: { conversationId: "conversation-1" },
      modelPin: {
        digest: model.version.digest,
        repositoryVersion: model.version.repositoryVersion,
      },
      status: "open",
      createdAt: "2026-10-28T00:00:00Z",
    }],
    messages: [{
      id: "input-1",
      role: "user",
      text: "Read the declared source",
      at: "2026-10-28T00:00:00Z",
      caseId: "case-1",
    }],
  };
  const reader: ModelConsultationReader = {
    overview(requested) {
      events.push("overview");
      const overview: ModelContextOverview = {
        version: requested ?? publishedVersion,
        sourceDigest,
        files: [{
          path,
          sha256,
          characters: content.length,
          byteLength: content.length,
        }],
        roots: { items: [], total: 0, truncated: false },
        limits: {
          maxPageSize: 40,
          maxSourceBytes: 120000,
          maxInspectSourceBytes: 24000,
        },
        coverage: "bounded-discovery-not-exhaustive-impact",
      };
      duringOverview();
      return Promise.resolve(overview);
    },
    query(request) {
      events.push("query");
      assert.equal(request.operation, "read_source");
      assert.equal(request.version, model.version.repositoryVersion);
      assert.equal("path" in request && request.path, path);
      return Promise.resolve({
        operation: "read_source",
        version: request.version,
        sourceDigest,
        path,
        sha256,
        characters: content.length,
        byteLength: content.length,
        content,
      });
    },
  };
  const information: ModelContextInformation = new ModelContextInformation({
    projectId: model.identity.projectId,
    resolveCallerModel: () => Promise.resolve(structuredClone(admitted)),
    snapshotForCaller: () => snapshot,
    readSourceRevision: () =>
      Promise.resolve({ version: publishedVersion, sources: {} }),
    reader,
    toolingQuery: () => Promise.reject(new Error("Unexpected tooling query")),
  });
  const host: DeclaredModelConsultationHost = {
    snapshot,
    ports: { information },
    currentModel: () => Promise.resolve(structuredClone(admitted)),
    feedback(_text, observation) {
      if (observation) observations.push(observation);
      return Promise.resolve();
    },
  };
  const request = {
    operation: "read_source",
    path,
    version: model.version.repositoryVersion!,
  };
  const run = (input: Record<string, unknown> = request) =>
    consultDeclaredModelSource.call(host, model, {
      nativeId: "mandatory-read",
      consultationRequest: JSON.stringify(input),
    });
  return {
    model,
    admitted,
    content,
    path,
    sourceDigest,
    reader,
    events,
    observations,
    snapshot,
    information,
    request,
    run,
    duringOverview: (hook: () => void) => {
      duringOverview = hook;
    },
    publishedVersion: (version: string) => {
      publishedVersion = version;
    },
  };
}

Deno.test("declared source reads its exact cold pin and retains the actual bytes outside the design working set", async () => {
  const f = fixture();
  await assert.rejects(
    () => f.information.consultModel(f.model, f.request, f.snapshot.messages),
    { code: "MODEL_CONTEXT_NOT_PINNED" },
  );
  assert.deepEqual(f.events, []);
  const output = await f.run();
  assert.equal(
    (output.outputs!.consultation as { succeeded: boolean }).succeeded,
    true,
  );
  assert.deepEqual(f.events, ["overview", "query"]);
  const loaded = await f.information.read(f.model, f.snapshot.messages);
  assert.equal(loaded.modelSources!.version, f.model.version.repositoryVersion);
  assert.deepEqual(loaded.modelSources!.sources, {});
  assert.equal(f.observations.length, 1);
  const evidence = f.observations[0].value as {
    result: { content: string; sourceDigest: string; version: string };
  };
  assert.equal(evidence.result.content, f.content);
  assert.equal(evidence.result.sourceDigest, f.sourceDigest);
  assert.equal(evidence.result.version, f.model.version.repositoryVersion);
  assert.equal("loaded" in evidence.result, false);
  assert.deepEqual(
    (f.observations[0].value as { modelVersion: unknown }).modelVersion,
    {
      digest: f.model.version.digest,
      repositoryVersion: f.model.version.repositoryVersion,
    },
  );
});

Deno.test("declared source refuses authority or admission pin changes during overview initialization", async () => {
  for (const changed of ["authority", "pin"]) {
    const f = fixture();
    f.duringOverview(() => {
      if (changed === "authority") {
        // The caller's own live admission is the declared read's authority.
        f.admitted.identity.systemId = "retired-system";
      } else {
        f.admitted.version.repositoryVersion = "commit:new-admission";
      }
    });
    const output = await f.run();
    assert.equal(
      (output.outputs!.consultation as { succeeded: boolean }).succeeded,
      false,
    );
    assert.equal(
      (output.outputs!.consultation as { code: string }).code,
      "MODEL_CONTEXT_AUTHORITY",
    );
    assert.deepEqual(f.events, ["overview"]);
    assert.deepEqual(f.observations, []);
  }
});

Deno.test("declared source reads admitted A while the production design working set remains on HEAD B", async () => {
  const f = fixture();
  f.publishedVersion("commit:new-publication");
  const design = await f.information.read(f.model, f.snapshot.messages);
  assert.equal(design.modelSources!.version, "commit:new-publication");
  f.events.length = 0;
  const output = await f.run();
  assert.equal(
    (output.outputs!.consultation as { succeeded: boolean }).succeeded,
    true,
  );
  assert.deepEqual(f.events, ["overview", "query"]);
  assert.equal(f.observations.length, 1);
  const evidence = f.observations[0].value as {
    result: { content: string; version: string; sourceDigest: string };
  };
  assert.equal(evidence.result.content, f.content);
  assert.equal(evidence.result.version, f.model.version.repositoryVersion);
  assert.equal(evidence.result.sourceDigest, f.sourceDigest);
  assert.deepEqual(
    await f.information.read(f.model, f.snapshot.messages),
    design,
  );
  assert.equal(f.request.version, f.model.version.repositoryVersion);
});

Deno.test("declared inspect initializes a cold production context and returns exact semantic evidence", async () => {
  const f = fixture();
  const input = {
    operation: "inspect",
    elementId: "declared-element",
    version: f.model.version.repositoryVersion!,
  };
  f.reader.query = (request) => {
    f.events.push("inspect");
    assert.equal(request.operation, "inspect");
    assert.equal(request.version, input.version);
    assert.equal(request.elementId, input.elementId);
    return Promise.resolve({
      operation: "inspect",
      version: request.version,
      sourceDigest: f.sourceDigest,
      offset: 0,
      limit: 20,
      total: 1,
      truncated: false,
      selected: { id: input.elementId, metaclass: "Package" },
      items: [],
      coverage: "selected-owner-owned-and-direct-relations",
      semantic: {
        state: "ready",
        advisory: true,
        version: request.version,
        build: {
          repositoryId: f.model.identity.projectId,
          sourceDigest: f.sourceDigest,
          recipeDigest: "recipe",
          buildKey: "build",
          artifactDigest: "artifact",
        },
        projection: {
          kind: "rdf",
          projectorVersion: "test",
          artifactDigest: "artifact",
          projectionDigest: "projection",
        },
        iri: `urn:test:${input.elementId}`,
        scope: "user",
        metaclass: "Package",
        readerVersion: "test",
        neighbors: [],
        neighborPage: { limit: 20, complete: true },
        coverage: "bounded-direct-neighbors",
      },
    });
  };
  await assert.rejects(
    () => f.information.consultModel(f.model, input, f.snapshot.messages),
    { code: "MODEL_CONTEXT_NOT_PINNED" },
  );
  assert.deepEqual(f.events, []);
  const output = await f.run(input);
  assert.equal(
    (output.outputs!.consultation as { succeeded: boolean }).succeeded,
    true,
  );
  assert.deepEqual(f.events, ["overview", "inspect"]);
  assert.equal(f.observations.length, 1);
  const evidence = f.observations[0].value as {
    result: { selected: { id: string }; semantic: { version: string } };
  };
  assert.equal(evidence.result.selected.id, input.elementId);
  assert.equal(evidence.result.semantic.version, input.version);
  assert.deepEqual(
    (await f.information.read(f.model, f.snapshot.messages)).modelSources!
      .sources,
    {},
  );
});

Deno.test("declared source refuses a mismatched source digest without recording an observation", async () => {
  const f = fixture();
  const query = f.reader.query;
  f.reader.query = async (request) => ({
    ...await query(request),
    sourceDigest: "another-source-digest",
  });
  const output = await f.run();
  assert.equal(
    (output.outputs!.consultation as { succeeded: boolean }).succeeded,
    false,
  );
  assert.equal(
    (output.outputs!.consultation as { code: string }).code,
    "MODEL_CONTEXT_SOURCE",
  );
  assert.deepEqual(f.events, ["overview", "query"]);
  assert.deepEqual(f.observations, []);
  assert.deepEqual(
    (await f.information.read(f.model, f.snapshot.messages)).modelSources!
      .sources,
    {},
  );
});

Deno.test("admitted source port refuses foreign pins and nonclosed requests before source I/O", async () => {
  for (
    const input of [
      {
        operation: "read_source",
        path: "conversation.sysml",
        version: "commit:head",
      },
      {
        operation: "query",
        version: "commit:shared-source",
        expression: "arbitrary",
      },
      {
        operation: "read_source",
        path: "conversation.sysml",
        version: "commit:shared-source",
        extra: true,
      },
      {
        operation: "inspect",
        elementId: "root",
        version: "commit:shared-source",
        includeReferenceSites: true,
      },
    ]
  ) {
    const f = fixture();
    await assert.rejects(() =>
      f.information.consultAdmittedModelSource(
        f.model,
        input,
        f.snapshot.messages,
      )
    );
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.observations, []);
  }
});

Deno.test("admitted source absence never falls back to design HEAD", async () => {
  const f = fixture();
  f.publishedVersion("commit:new-publication");
  f.reader.overview = (version) => {
    f.events.push(`missing:${version}`);
    return Promise.reject(Object.assign(new Error("Exact source absent"), {
      code: "NOT_FOUND",
    }));
  };
  const output = await f.run();
  assert.deepEqual(output.outputs!.consultation, {
    succeeded: false,
    code: "NOT_FOUND",
    details: "Exact source absent",
  });
  assert.deepEqual(f.events, [`missing:${f.model.version.repositoryVersion}`]);
  assert.deepEqual(f.observations, []);
});

Deno.test("admitted source revalidates permission pin and original input after the actual read", async () => {
  for (const changed of ["authority", "pin", "input"]) {
    const f = fixture();
    const query = f.reader.query;
    f.reader.query = async (request) => {
      const result = await query(request);
      if (changed === "authority") {
        f.admitted.identity.systemId = "retired-system";
      } else if (changed === "pin") {
        f.admitted.version.repositoryVersion = "commit:new-admission";
      } else {
        f.snapshot.messages.push({
          ...f.snapshot.messages[0],
          id: "new-input",
        });
      }
      return result;
    };
    const output = await f.run();
    assert.equal(
      (output.outputs!.consultation as { succeeded: boolean }).succeeded,
      false,
    );
    assert.equal(
      (output.outputs!.consultation as { code: string }).code,
      changed === "input"
        ? "MODEL_CONTEXT_STALE_REQUEST"
        : "MODEL_CONTEXT_AUTHORITY",
    );
    assert.deepEqual(f.events, ["overview", "query"]);
    assert.deepEqual(f.observations, []);
  }
});

Deno.test("admitted source mismatched file metadata and oversized actual responses leave HEAD unchanged", async () => {
  for (const changed of ["file", "budget"]) {
    const f = fixture();
    f.publishedVersion("commit:new-publication");
    const design = await f.information.read(f.model, f.snapshot.messages);
    if (changed === "file") {
      const query = f.reader.query;
      f.reader.query = async (request) => ({
        ...await query(request),
        sha256: "other-file",
      });
    }
    await assert.rejects(
      () =>
        f.information.consultAdmittedModelSource(
          f.model,
          f.request,
          f.snapshot.messages,
          changed === "budget" ? { maxResponseCharacters: 16 } : undefined,
        ),
      {
        code: changed === "budget"
          ? "MODEL_CONTEXT_RESPONSE_LIMIT"
          : "MODEL_CONTEXT_SOURCE",
      },
    );
    assert.deepEqual(
      await f.information.read(f.model, f.snapshot.messages),
      design,
    );
  }
});

Deno.test("native mandatory read reaches the next provider with admitted A bytes while design HEAD is B", async () => {
  const model = artifactModel("reader");
  model.policy.mayProposeSysmlRevision = true;
  enableCommandFixtureProfile(model, { legacyDeclaredConsultation: true });
  const admittedVersion = model.version.repositoryVersion!;
  const headVersion = "commit:child-grant-publication";
  const content = "package Admitted { // exact old bytes: café 😀\n}\n";
  const admitted = {
    ...await materialize([], { "conversation.sysml": content }, "test-source"),
    version: admittedVersion,
  };
  const head = {
    ...await materialize([], {
      "conversation.sysml": "package NewerDesign {}\n",
    }, "test-source"),
    version: headVersion,
  };
  let published = admitted;
  const reads: string[] = [];
  const reader = new ModelContextReader({
    current: () => Promise.resolve(published),
    at(version) {
      reads.push(version);
      if (version === admittedVersion) return Promise.resolve(admitted);
      if (version === headVersion) return Promise.resolve(head);
      throw new Error("Unexpected source version");
    },
  });
  let saved: SystemRuntimeState | null = null;
  const contexts: ChatContext[] = [];
  const information: ModelContextInformation = new ModelContextInformation({
    projectId: model.identity.projectId,
    reader,
    resolveCallerModel: (owner, version) =>
      Promise.resolve(
        owner === model.identity.builderId &&
          version.digest === model.version.digest &&
          version.repositoryVersion === admittedVersion
          ? structuredClone(model)
          : null,
      ),
    snapshotForCaller: (): SystemRuntimeState => runtime.snapshot,
    readSourceRevision: () =>
      Promise.resolve({
        version: published.version,
        sources: published.sources,
      }),
    toolingQuery: () => Promise.reject(new Error("Unexpected tooling query")),
  });
  const forbidden = () => {
    throw new Error("Unexpected effect");
  };
  const runtime: SystemRuntime = new SystemRuntime({
    model: {
      ...unexpectedModelAuthoring,
      initialize: () => Promise.resolve(model.identity),
      readExecutableModel: (_identity, version) =>
        Promise.resolve({
          ...structuredClone(model),
          version: {
            ...model.version,
            repositoryVersion: version ?? published.version,
          },
        }),
      applyApprovedChange: forbidden,
      activateCandidate: forbidden,
      findCandidate: () => Promise.resolve(null),
      graph: () => Promise.resolve({}),
    },
    store: {
      load: () => Promise.resolve(structuredClone(saved)),
      save(state, previous) {
        assert.equal(saved?.revision ?? null, previous);
        saved = structuredClone(state);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    },
    information,
    agents: {
      label: "bounded-source-consultation-witness",
      decide(context) {
        contexts.push(structuredClone(context));
        return Promise.resolve({
          kind: "reply",
          text: "Exact admitted source observed.",
        });
      },
      review: forbidden,
    },
    runner: { test: forbidden, run: forbidden },
  });
  await runtime.initialize();
  published = head;
  try {
    await runtime.submit(
      "Continue after the child's independent source publication.",
    );
    await runtime.idle();
    assert.equal(runtime.snapshot.error, undefined);
    assert.equal(contexts.length, 1);
    const context = contexts[0];
    assert.equal(context.modelSources!.version, headVersion);
    assert.deepEqual(context.modelSources!.sources, {});
    const observation = context.messages.find((message) =>
      message.observation?.kind === "model-context"
    )!.observation!;
    const evidence = observation.value as {
      modelVersion: { repositoryVersion: string };
      result: {
        version: string;
        sourceDigest: string;
        content: string;
        sha256: string;
      };
    };
    assert.equal(evidence.modelVersion.repositoryVersion, admittedVersion);
    assert.equal(evidence.result.version, admittedVersion);
    assert.equal(evidence.result.sourceDigest, admitted.sourceDigest);
    assert.equal(evidence.result.content, content);
    assert.equal(
      evidence.result.sha256,
      admitted.sourceHashes["conversation.sysml"],
    );
    assert.equal(JSON.stringify(context.modelSources).includes(content), false);
    assert.equal(
      runtime.snapshot.executionModel!.version.repositoryVersion,
      admittedVersion,
    );
    assert.deepEqual(new Set(reads), new Set([admittedVersion, headVersion]));
    assert.equal(
      runtime.snapshot.messages.filter((message) =>
        message.text === "Exact admitted source observed."
      ).length,
      1,
    );
  } finally {
    await runtime.idle();
  }
});
