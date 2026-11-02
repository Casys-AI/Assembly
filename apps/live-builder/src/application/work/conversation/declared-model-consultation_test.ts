import assert from "node:assert/strict";
import {
  consultDeclaredModelSource,
  type DeclaredModelConsultationHost,
} from "./declared-model-consultation.ts";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import type { MessageObservation } from "../../../domain/work/policies/context-separation.ts";
import type {
  Message,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";

function fixture() {
  const model = artifactModel("reader");
  model.policy.mayProposeSysmlRevision = true;
  const observations: MessageObservation[] = [];
  const calls: Record<string, unknown>[] = [];
  const initialization: Array<{
    model: ExecutableModel;
    messages?: readonly Message[];
  }> = [];
  const order: string[] = [];
  let checks = 0;
  const host: DeclaredModelConsultationHost = {
    snapshot: { messages: [] } as unknown as SystemRuntimeState,
    currentModel: () => {
      checks++;
      return Promise.resolve(structuredClone(model));
    },
    feedback(_text, observation) {
      if (observation) observations.push(observation);
      return Promise.resolve();
    },
    ports: {
      information: {
        // Explicit admitted-port double; preserve the isolated request and
        // initialization-failure witnesses independently of design HEAD.
        async consultAdmittedModelSource(current, request, messages, budget) {
          await this.read(current, messages);
          return await this.consultModel!(current, request, messages, budget);
        },
        read(current, messages) {
          initialization.push({ model: structuredClone(current), messages });
          order.push("read");
          return Promise.resolve({ memoryGuidance: [] });
        },
        consultModel(_current, request) {
          order.push("consult");
          calls.push(structuredClone(request));
          return Promise.resolve({
            modelVersion: {
              digest: model.version.digest,
              repositoryVersion: model.version.repositoryVersion,
            },
            result: {
              operation: "inspect",
              version: model.version.repositoryVersion,
              elementId: "declared-source",
            },
          });
        },
      },
    },
  };
  const node = {
    nativeId: "mandatory-read",
    consultationRequest: JSON.stringify({
      operation: "inspect",
      elementId: "declared-source",
    }),
  };
  const run = () => consultDeclaredModelSource.call(host, model, node);
  return {
    model,
    host,
    node,
    run,
    observations,
    calls,
    initialization,
    order,
    checks: () => checks,
  };
}

Deno.test("declared consultation reads an exact pin and retains versioned evidence", async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(
    (result.outputs!.consultation as { succeeded: boolean }).succeeded,
    true,
  );
  assert.equal(f.calls[0].version, f.model.version.repositoryVersion);
  assert.deepEqual(f.order, ["read", "consult"]);
  assert.deepEqual(f.initialization[0].model, f.model);
  assert.equal(f.checks(), 2);
  assert.equal(f.observations[0].kind, "model-context");
  assert.deepEqual(
    (f.observations[0].value as { modelVersion: unknown }).modelVersion,
    {
      digest: f.model.version.digest,
      repositoryVersion: f.model.version.repositoryVersion,
    },
  );
});

Deno.test("a declared consultation needs no revision right and grants none", async () => {
  // A created Request or team operator: its flow declares the read, its
  // mandate does not let it propose source revisions.
  const f = fixture();
  f.model.policy.mayProposeSysmlRevision = false;
  const result = await f.run();
  assert.equal(
    (result.outputs!.consultation as { succeeded: boolean }).succeeded,
    true,
  );
  assert.deepEqual(f.calls, [{
    operation: "inspect",
    elementId: "declared-source",
    version: f.model.version.repositoryVersion,
  }]);
  assert.equal(f.observations[0].kind, "model-context");
  assert.equal(f.model.policy.mayProposeSysmlRevision, false);
});

Deno.test("without the revision right, a stale, undeclared or unbounded read is still refused", async () => {
  const cases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["stale admission", (f) => {
      f.host.currentModel = () =>
        Promise.resolve({
          ...structuredClone(f.model),
          version: { ...f.model.version, digest: "b".repeat(64) },
        });
    }],
    ["no admitted repository version", (f) => {
      delete f.model.version.repositoryVersion;
    }],
    ["undeclared request", (f) => {
      delete (f.node as { consultationRequest?: string }).consultationRequest;
    }],
    ["unbounded request", (f) => {
      f.node.consultationRequest = JSON.stringify({
        operation: "inspect",
        elementId: "x".repeat(4097),
      });
    }],
    ["absent admitted-source port", (f) => {
      delete f.host.ports.information!.consultAdmittedModelSource;
    }],
  ];
  for (const [name, arrange] of cases) {
    const f = fixture();
    f.model.policy.mayProposeSysmlRevision = false;
    arrange(f);
    const result = await f.run();
    assert.equal(
      (result.outputs!.consultation as { succeeded: boolean }).succeeded,
      false,
      name,
    );
    assert.equal(f.calls.length, 0, name);
    assert.equal(f.observations.length, 0, name);
  }
});

Deno.test("declared consultation requires its explicit admitted-source port without an ordinary-read fallback", async () => {
  const f = fixture();
  delete f.host.ports.information!.consultAdmittedModelSource;
  const result = await f.run();
  assert.equal(
    (result.outputs!.consultation as { succeeded: boolean }).succeeded,
    false,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.initialization.length, 0);
  assert.equal(f.observations.length, 0);
});

Deno.test("declared consultation rejects other pins and undeclared operations before read", async () => {
  for (
    const request of [
      {
        operation: "inspect",
        elementId: "declared-source",
        version: "commit:other",
      },
      { operation: "query", expression: "arbitrary" },
      {
        operation: "inspect",
        elementId: "declared-source",
        extraAuthority: true,
      },
    ]
  ) {
    const f = fixture();
    f.node.consultationRequest = JSON.stringify(request);
    const result = await f.run();
    assert.equal(
      (result.outputs!.consultation as { succeeded: boolean }).succeeded,
      false,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.initialization.length, 0);
  }
});

Deno.test("declared consultation initializes and consults with the same isolated Case messages", async () => {
  const f = fixture();
  f.host.snapshot.caseInvocation = { kind: "local", caseId: "case-1" };
  f.host.snapshot.cases = [{
    id: "case-1",
    number: 1,
    type: "request",
    objective: "Read the declared source",
    owner: f.model.identity.builderId,
    openedBy: f.model.identity.builderId,
    openedFrom: { conversationId: "conversation-1" },
    modelPin: { digest: f.model.version.digest },
    status: "open",
    createdAt: "2026-10-28T00:00:00Z",
  }];
  const message = {
    id: "input-1",
    role: "user" as const,
    text: "Read the declared source",
    at: "2026-10-28T00:00:00Z",
    caseId: "case-1",
  };
  f.host.snapshot.messages = [
    message,
    { ...message, id: "foreign", caseId: "case-2" },
  ];
  const originalConsult = f.host.ports.information!.consultModel!;
  f.host.ports.information!.consultModel = (
    model,
    request,
    messages,
    budget,
  ) => {
    assert.strictEqual(messages, f.initialization[0].messages);
    assert.deepEqual(messages, [message]);
    assert.notStrictEqual(messages![0], f.host.snapshot.messages[0]);
    return originalConsult(model, request, messages, budget);
  };
  const result = await f.run();
  assert.equal(
    (result.outputs!.consultation as { succeeded: boolean }).succeeded,
    true,
  );
});

Deno.test("declared consultation returns a modeled refusal when overview initialization fails", async () => {
  const f = fixture();
  f.host.ports.information!.read = () =>
    Promise.reject(
      Object.assign(new Error("Overview unavailable"), {
        code: "OVERVIEW_UNAVAILABLE",
      }),
    );
  const result = await f.run();
  assert.deepEqual(result.outputs!.consultation, {
    succeeded: false,
    code: "OVERVIEW_UNAVAILABLE",
    details: "Overview unavailable",
  });
  assert.equal(f.calls.length, 0);
  assert.equal(f.observations.length, 0);
});

Deno.test("revocation or an oversized reader result follows explicit failure without evidence", async () => {
  for (const failure of ["revoked", "oversized", "wrong-pin"]) {
    const f = fixture();
    f.host.ports.information!.consultModel = () =>
      Promise.resolve({
        modelVersion: {
          digest: failure === "wrong-pin" ? "other" : f.model.version.digest,
          repositoryVersion: f.model.version.repositoryVersion,
        },
        result: { text: failure === "oversized" ? "x".repeat(70000) : "read" },
      });
    if (failure === "revoked") {
      let reads = 0;
      f.host.currentModel = () => {
        if (++reads > 1) throw new Error("revoked");
        return Promise.resolve(f.model);
      };
    }
    const result = await f.run();
    assert.equal(
      (result.outputs!.consultation as { succeeded: boolean }).succeeded,
      false,
    );
    assert.equal(f.observations.length, 0);
  }
});
