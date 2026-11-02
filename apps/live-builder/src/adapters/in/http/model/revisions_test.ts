import { deepStrictEqual, equal, match } from "node:assert/strict";
import {
  createModelRevisionHandler,
  type ModelRevisionHandlerOptions,
} from "./revisions.ts";
import type { ExecutableModel } from "../../../../domain/model/execution/executable-model.ts";
import {
  exerciseOwnerAuthority,
  legacyOwnerAuthority,
} from "../../../../domain/governance/authority.ts";
import type {
  ModelRevision,
  ProposalRecord,
} from "../../../../domain/model/records/revision.ts";
import type { GraphDiff } from "../../../../domain/model/records/graph-diff.ts";
import type { OperatorAuthorityPolicy } from "../../../../domain/governance/policies/operator-authority-policy.ts";

const DIGEST = "a".repeat(64),
  NEW_DIGEST = "b".repeat(64),
  SOURCE = "c".repeat(64);
const identity = {
  projectId: "model",
  editingContextId: "model",
  rootId: "root",
  systemId: "system",
  catalogId: "catalog",
  builderId: "builder",
};
function fixture(
  overrides: Partial<
    Pick<ModelRevisionHandlerOptions, "resolveRuntime" | "onAdopt">
  > = {},
) {
  let current: ModelRevision = {
    version: "branch:base",
    sourceDigest: SOURCE,
    sources: { "system.sysml": "package Example;" },
    elements: [],
    documents: [],
    semanticDigest: DIGEST,
    provenanceDigest: DIGEST,
    sourceHashes: { "system.sysml": SOURCE },
    engineVersion: "test-compiler",
  };
  const proposal: ProposalRecord = {
    id: "proposal-1",
    branch: "proposal_1",
    author: "agent:builder",
    reason: "Déplacer une définition",
    baseVersion: "branch:base",
    createdAt: "2026-10-21T00:00:00Z",
    status: "proposed",
    validation: "validated",
    sourceDigest: SOURCE,
    proposalVersion: "branch:proposal",
    diff: [{
      path: "system.sysml",
      kind: "changed",
      before: "package Example;",
      after: "package Moved;",
    }],
  };
  let native = {
    identity,
    version: {
      digest: DIGEST,
      rootId: "root",
      configurationId: "configuration",
      configurationRevision: 1,
      sourceIds: ["source"],
      repositoryVersion: "branch:base",
    },
    policy: { mayProposeSysmlRevision: true },
  } as ExecutableModel;
  const state = {
    busy: false,
    model: identity,
    executionModel: structuredClone(native),
  };
  const calls = {
    propose: [] as unknown[],
    accept: [] as unknown[],
    reject: [] as unknown[],
    adopt: [] as unknown[],
    at: [] as string[],
    header: [] as string[],
    graphDiff: [] as Array<[string | null, string]>,
    changed: 0,
  };
  const options: ModelRevisionHandlerOptions = {
    repository: {
      propose: (input) => {
        calls.propose.push(input);
        return Promise.resolve(structuredClone(proposal));
      },
      current: () => Promise.resolve(current),
      at: (version) => {
        calls.at.push(version);
        return Promise.resolve({ ...current, version });
      },
      header: (version) => {
        calls.header.push(version);
        return Promise.resolve({
          version,
          sources: current.sources,
          sourceDigest: current.sourceDigest,
        });
      },
      listProposals: () => Promise.resolve([structuredClone(proposal)]),
      readProposalJournal: () => Promise.resolve([structuredClone(proposal)]),
      graphDiff: (from, to) => {
        calls.graphDiff.push([from, to]);
        if (from === "commit:missing") {
          return Promise.reject(
            Object.assign(new Error("Version introuvable"), {
              code: "NOT_FOUND",
            }),
          );
        }
        return Promise.resolve(
          {
            engine: "Git",
            fromVersion: from,
            toVersion: to,
            changes: [],
            counts: { added: 0, removed: 0, changed: 0 },
            truncated: false,
          } satisfies GraphDiff,
        );
      },
      lastChangeByPath: () => Promise.resolve([]),
      history: () =>
        Promise.resolve({
          headVersion: current.version,
          commits: [{
            version: current.version,
            parents: [],
            author: "test",
            parsedAuthor: { kind: "unknown", ref: "test" },
            files: [],
            additions: 0,
            deletions: 0,
            message: "Initial model",
            createdAt: proposal.createdAt,
            sourceDigest: current.sourceDigest,
          }],
          truncated: false,
        }),
      proposal: () => Promise.resolve(structuredClone(proposal)),
      accept: (input) => {
        calls.accept.push(input);
        proposal.status = "accepted";
        current = { ...current, version: "branch:accepted" };
        native = {
          ...native,
          version: {
            ...native.version,
            digest: NEW_DIGEST,
            repositoryVersion: current.version,
          },
        };
        return Promise.resolve(current);
      },
      reject: (input) => {
        calls.reject.push(input);
        proposal.status = "rejected";
        return Promise.resolve(proposal);
      },
    },
    model: {
      proposeRevision: (...input) => {
        calls.propose.push(input);
        return Promise.resolve({
          id: proposal.id,
          baseVersion: proposal.baseVersion,
          status: "pending",
        });
      },
    },
    runtime: {
      get snapshot() {
        return state;
      },
      inspectModelVersion: () => Promise.resolve(native),
      adoptModelVersion: (input) => {
        if (input.expectedDigest !== native.version.digest) {
          return Promise.reject(new Error("La version a changé."));
        }
        calls.adopt.push(input);
        state.executionModel = structuredClone(native);
        return Promise.resolve();
      },
    },
    onChange: () => {
      calls.changed++;
    },
    ...overrides,
  };
  const handle = createModelRevisionHandler(options);
  return {
    options,
    handle,
    state,
    calls,
    proposal,
    native,
    current,
    runtime: options.runtime,
    setNative: (value: ExecutableModel) => {
      native = value;
    },
  };
}
function post(
  path: string,
  input: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`http://127.0.0.1:4311${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(input),
  });
}
const requestProposal = {
  baseVersion: "branch:base",
  sources: { "system.sysml": "package Moved;" },
  reason: "Déplacer une définition",
};
const decision = {
  verdict: "approve",
  expectedVersion: "branch:base",
  sourceDigest: SOURCE,
};

function workerFixture() {
  const worker = fixture();
  const workerIdentity = {
    ...identity,
    builderId: "worker",
    systemId: "worker-system",
  };
  const active: ExecutableModel = {
    ...worker.native,
    identity: workerIdentity,
    version: {
      ...worker.native.version,
      digest: "d".repeat(64),
      configurationId: "worker-configuration",
      repositoryVersion: "branch:worker-active",
    },
  };
  const available: ExecutableModel = {
    ...active,
    version: {
      ...active.version,
      digest: "e".repeat(64),
      repositoryVersion: "branch:worker-next",
    },
  };
  worker.state.model = workerIdentity;
  worker.state.executionModel = structuredClone(active);
  worker.setNative(available);
  return { ...worker, active, available };
}

function inspectRequest(query = "") {
  return new Request(`http://127.0.0.1:4311/api/model-revisions${query}`);
}

function previewRequest(query = "?agentId=builder") {
  return new Request(
    `http://127.0.0.1:4311/api/model-revisions/proposal-1/preview${query}`,
  );
}

function assertNoSourceMutation(f: ReturnType<typeof fixture>) {
  deepStrictEqual(f.calls.accept, []);
  deepStrictEqual(f.calls.reject, []);
  deepStrictEqual(f.calls.propose, []);
}

Deno.test("proposal preview belongs to its exact native author, excluding local-owner and other chats", async () => {
  const f = fixture();
  equal((await f.handle(previewRequest()))!.status, 404);
  f.proposal.authorization = {
    kind: "operator",
    systemQualifiedName: "System",
    operatorQualifiedName: "Builder",
    operatorNativeId: "builder",
    mandateId: "mandate",
    mandateRevision: 1,
    policyId: "policy",
    policyRevision: 1,
    policyDigest: DIGEST,
    operations: [],
  };
  f.proposal.author = "agent:builder";
  equal((await f.handle(previewRequest("?agentId=worker")))!.status, 404);
  equal(
    (await f.handle(previewRequest("?agentId=builder&agentId=worker")))!.status,
    400,
  );
  equal((await f.handle(previewRequest("")))!.status, 400);
  const response = await f.handle(previewRequest());
  equal(response!.status, 200);
  const preview = await response!.json();
  equal(preview.agentId, "builder");
  equal(preview.proposalId, "proposal-1");
  equal(preview.baseVersion, "branch:base");
  equal(preview.proposalVersion, "branch:proposal");
  equal(preview.expectedVersion, "branch:base");
  equal(preview.sourceDigest, SOURCE);
  equal(preview.completeness, false);
  deepStrictEqual(preview.rows, []);
  deepStrictEqual(preview.sourceChanges, []);
  deepStrictEqual(f.calls.at, ["branch:base", "branch:proposal"]);
  assertNoSourceMutation(f);
});

Deno.test("proposal preview refuses mismatched author and proposal digest", async () => {
  const f = fixture();
  f.proposal.authorization = {
    kind: "operator",
    systemQualifiedName: "System",
    operatorQualifiedName: "Builder",
    operatorNativeId: "builder",
    mandateId: "mandate",
    mandateRevision: 1,
    policyId: "policy",
    policyRevision: 1,
    policyDigest: DIGEST,
    operations: [],
  };
  f.proposal.author = "local-owner";
  equal((await f.handle(previewRequest()))!.status, 404);
  f.proposal.author = "agent:builder";
  f.proposal.sourceDigest = NEW_DIGEST;
  equal((await f.handle(previewRequest()))!.status, 409);
  assertNoSourceMutation(f);
});

Deno.test("revision inspection selects the worker contract while retaining global source revisions", async () => {
  const worker = workerFixture();
  const f = fixture({
    resolveRuntime: (id) => id === "worker" ? worker.runtime : undefined,
  });
  const workerBefore = structuredClone(worker.state);
  const primaryBefore = structuredClone(f.state);
  const selected = await (await f.handle(inspectRequest("?agentId=worker")))!
    .json();
  equal(selected.agentId, "worker");
  equal(selected.version, "branch:base");
  equal(selected.sourceDigest, SOURCE);
  equal(selected.runtime.active.digest, worker.active.version.digest);
  equal(selected.runtime.available.digest, worker.available.version.digest);
  equal(selected.runtime.available.repositoryVersion, "branch:worker-next");
  for (const query of ["", "?agentId=builder"]) {
    const primary = await (await f.handle(inspectRequest(query)))!.json();
    equal(primary.agentId, "builder");
    equal(primary.runtime.active.digest, DIGEST);
    equal(primary.runtime.available.digest, DIGEST);
  }
  deepStrictEqual(worker.state, workerBefore);
  deepStrictEqual(f.state, primaryBefore);
  deepStrictEqual(worker.calls.adopt, []);
  deepStrictEqual(f.calls.adopt, []);
  equal(f.calls.changed, 0);
  assertNoSourceMutation(f);
});

Deno.test("worker adoption updates only the selected runtime and pins its available source version", async () => {
  const worker = workerFixture();
  const f = fixture({
    resolveRuntime: (id) => id === "worker" ? worker.runtime : undefined,
  });
  const primaryBefore = structuredClone(f.state);
  const response = await f.handle(post("/api/model-version/adopt", {
    agentId: "worker",
    expectedDigest: worker.available.version.digest,
  }));
  equal(response!.status, 200);
  const result = await response!.json();
  equal(result.adopted, true);
  equal(result.agentId, "worker");
  equal(result.runtime.active.digest, worker.available.version.digest);
  equal(result.runtime.available.repositoryVersion, "branch:worker-next");
  deepStrictEqual(worker.calls.adopt, [{
    expectedDigest: worker.available.version.digest,
    expectedVersion: "branch:worker-next",
  }]);
  deepStrictEqual(f.calls.adopt, []);
  deepStrictEqual(f.state, primaryBefore);
  equal(f.calls.changed, 1);
  assertNoSourceMutation(f);
});

Deno.test("operator selection rejects unknown or mismatched identities before adoption", async () => {
  const worker = workerFixture();
  const f = fixture({
    resolveRuntime: (id) => id === "mismatched" ? worker.runtime : undefined,
  });
  const primaryBefore = structuredClone(f.state);
  const workerBefore = structuredClone(worker.state);
  for (
    const [agentId, status] of [["missing", 404], ["mismatched", 409]] as const
  ) {
    equal(
      (await f.handle(inspectRequest(`?agentId=${agentId}`)))!.status,
      status,
    );
    equal(
      (await f.handle(post("/api/model-version/adopt", {
        agentId,
        expectedDigest: worker.available.version.digest,
      })))!.status,
      status,
    );
  }
  deepStrictEqual(f.state, primaryBefore);
  deepStrictEqual(worker.state, workerBefore);
  deepStrictEqual(f.calls.adopt, []);
  deepStrictEqual(worker.calls.adopt, []);
  equal(f.calls.changed, 0);
  assertNoSourceMutation(f);
});

Deno.test("invalid inspection selectors and adoption bodies or queries cannot select a runtime", async () => {
  const worker = workerFixture();
  let resolutions = 0;
  const f = fixture({
    resolveRuntime: () => {
      resolutions++;
      return worker.runtime;
    },
  });
  for (
    const query of [
      "?agentId=",
      "?agentId=%20%20",
      "?agentId=worker&agentId=builder",
      "?agentId=worker&scope=all",
      `?agentId=${"x".repeat(201)}`,
    ]
  ) {
    equal((await f.handle(inspectRequest(query)))!.status, 400, query);
  }
  const valid = {
    expectedDigest: worker.available.version.digest,
    agentId: "worker",
  };
  for (
    const input of [
      { ...valid, agentId: "" },
      { ...valid, agentId: "  " },
      { ...valid, agentId: null },
      { ...valid, agentId: 42 },
      { ...valid, agentId: "x".repeat(201) },
      { ...valid, expectedDigest: "not-a-digest" },
      { ...valid, expectedVersion: "main" },
      { ...valid, expectedVersion: null },
      { ...valid, author: "administrator" },
    ]
  ) {
    equal(
      (await f.handle(post("/api/model-version/adopt", input)))!.status,
      400,
      JSON.stringify(input),
    );
  }
  for (
    const query of [
      "?agentId=worker",
      "?agentId=builder&agentId=worker",
      "?scope=all",
    ]
  ) {
    equal(
      (await f.handle(
        post(`/api/model-version/adopt${query}`, { expectedDigest: DIGEST }),
      ))!.status,
      400,
      query,
    );
  }
  equal(resolutions, 0);
  deepStrictEqual(f.calls.adopt, []);
  deepStrictEqual(worker.calls.adopt, []);
  equal(f.calls.changed, 0);
  assertNoSourceMutation(f);
});

Deno.test("stale worker digest or source pin and busy worker fail before preflight without mutation", async () => {
  const worker = workerFixture();
  let preflights = 0;
  const f = fixture({
    resolveRuntime: (id) => id === "worker" ? worker.runtime : undefined,
    onAdopt: async (_input, _runtime, adopt) => {
      preflights++;
      await adopt();
    },
  });
  const workerBefore = structuredClone(worker.state.executionModel);
  const primaryBefore = structuredClone(f.state);
  for (
    const input of [
      { agentId: "worker", expectedDigest: worker.active.version.digest },
      {
        agentId: "worker",
        expectedDigest: worker.available.version.digest,
        expectedVersion: "branch:worker-active",
      },
      {
        agentId: "worker",
        expectedDigest: DIGEST,
        expectedVersion: "branch:base",
      },
    ]
  ) {
    equal(
      (await f.handle(post("/api/model-version/adopt", input)))!.status,
      409,
    );
  }
  worker.state.busy = true;
  equal(
    (await f.handle(post("/api/model-version/adopt", {
      agentId: "worker",
      expectedDigest: worker.available.version.digest,
      expectedVersion: "branch:worker-next",
    })))!.status,
    409,
  );
  equal(preflights, 0);
  deepStrictEqual(worker.state.executionModel, workerBefore);
  deepStrictEqual(f.state, primaryBefore);
  deepStrictEqual(worker.calls.adopt, []);
  deepStrictEqual(f.calls.adopt, []);
  equal(f.calls.changed, 0);
  assertNoSourceMutation(f);
});

Deno.test("a busy primary does not block preflight and adoption of an idle worker", async () => {
  const worker = workerFixture();
  const phases: string[] = [];
  const f = fixture({
    resolveRuntime: (id) => id === "worker" ? worker.runtime : undefined,
    onAdopt: async (input, selected, adopt) => {
      phases.push("preflight");
      equal(selected, worker.runtime);
      deepStrictEqual(input, {
        agentId: "worker",
        expectedDigest: worker.available.version.digest,
        expectedVersion: "branch:worker-next",
      });
      equal(f.state.busy, true);
      equal(worker.calls.adopt.length, 0);
      equal(f.calls.changed, 0);
      await adopt();
      phases.push("adopted");
      equal(
        worker.state.executionModel.version.digest,
        worker.available.version.digest,
      );
      equal(f.calls.changed, 0);
    },
  });
  f.state.busy = true;
  const primaryBefore = structuredClone(f.state);
  equal(
    (await f.handle(post("/api/model-version/adopt", {
      agentId: "worker",
      expectedDigest: worker.available.version.digest,
      expectedVersion: "branch:worker-next",
    })))!.status,
    200,
  );
  deepStrictEqual(phases, ["preflight", "adopted"]);
  deepStrictEqual(f.state, primaryBefore);
  equal(worker.calls.adopt.length, 1);
  equal(f.calls.changed, 1);
  deepStrictEqual(f.calls.adopt, []);
  assertNoSourceMutation(f);
});

Deno.test("a rejecting adoption preflight leaves both runtimes unchanged and emits no change", async () => {
  const worker = workerFixture();
  let preflights = 0;
  const f = fixture({
    resolveRuntime: (id) => id === "worker" ? worker.runtime : undefined,
    onAdopt: (_input, selected) => {
      preflights++;
      equal(selected, worker.runtime);
      deepStrictEqual(worker.calls.adopt, []);
      return Promise.reject(
        Object.assign(new Error("Workspace reservation refused"), {
          code: "STALE_REVISION",
        }),
      );
    },
  });
  const workerBefore = structuredClone(worker.state);
  const primaryBefore = structuredClone(f.state);
  const response = await f.handle(post("/api/model-version/adopt", {
    agentId: "worker",
    expectedDigest: worker.available.version.digest,
    expectedVersion: "branch:worker-next",
  }));
  equal(response!.status, 409);
  match((await response!.json()).error, /reservation refused/);
  equal(preflights, 1);
  deepStrictEqual(worker.state, workerBefore);
  deepStrictEqual(f.state, primaryBefore);
  deepStrictEqual(worker.calls.adopt, []);
  deepStrictEqual(f.calls.adopt, []);
  equal(f.calls.changed, 0);
  assertNoSourceMutation(f);
});

Deno.test("default and explicit primary adoption normalize the source pin without adopting a worker", async () => {
  for (const agentId of [undefined, "builder"]) {
    const worker = workerFixture();
    const f = fixture({
      resolveRuntime: (id) => id === "worker" ? worker.runtime : undefined,
    });
    f.setNative({
      ...f.native,
      version: {
        ...f.native.version,
        digest: NEW_DIGEST,
        repositoryVersion: "branch:primary-next",
      },
    });
    const workerBefore = structuredClone(worker.state);
    const response = await f.handle(post("/api/model-version/adopt", {
      ...(agentId ? { agentId } : {}),
      expectedDigest: NEW_DIGEST,
    }));
    equal(response!.status, 200);
    equal((await response!.json()).agentId, "builder");
    deepStrictEqual(f.calls.adopt, [{
      expectedDigest: NEW_DIGEST,
      expectedVersion: "branch:primary-next",
    }]);
    deepStrictEqual(worker.calls.adopt, []);
    deepStrictEqual(worker.state, workerBefore);
    assertNoSourceMutation(f);
  }
});

Deno.test("worker inspection does not reroute global source proposals and decisions", async () => {
  const worker = workerFixture();
  const f = fixture({
    resolveRuntime: (id) => id === "worker" ? worker.runtime : undefined,
  });
  const workerBefore = structuredClone(worker.state);
  equal((await f.handle(inspectRequest("?agentId=worker")))!.status, 200);
  equal(
    (await f.handle(
      post("/api/model-revisions", { ...requestProposal, agentId: "worker" }),
    ))!.status,
    400,
  );
  equal(
    (await f.handle(
      post("/api/model-revisions/proposal-1/decision", {
        ...decision,
        agentId: "worker",
      }),
    ))!.status,
    400,
  );
  equal(
    (await f.handle(post("/api/model-revisions", requestProposal)))!.status,
    201,
  );
  deepStrictEqual(f.calls.propose, [{
    ...requestProposal,
    author: "local-owner",
    authorization: {
      kind: "local-owner",
      authorityExercise: exerciseOwnerAuthority(f.native, "model-revision"),
    },
  }]);
  const accepted = await f.handle(
    post("/api/model-revisions/proposal-1/decision", decision),
  );
  equal(accepted!.status, 200);
  equal((await accepted!.json()).executionAdopted, false);
  equal(f.calls.accept.length, 1);
  deepStrictEqual(f.calls.adopt, []);
  deepStrictEqual(worker.calls.adopt, []);
  deepStrictEqual(worker.state, workerBefore);
  equal(f.state.executionModel.version.digest, DIGEST);
});

Deno.test("revision endpoints reject foreign mutations and unsupported inputs before proposing", async () => {
  const f = fixture();
  equal(
    await f.handle(new Request("http://127.0.0.1:4311/api/unrelated")),
    null,
  );
  equal(
    (await f.handle(
      post("/api/model-revisions", requestProposal, {
        origin: "https://outside.example",
      }),
    ))!.status,
    403,
  );
  equal(
    (await f.handle(
      post("/api/model-revisions", requestProposal, {
        "sec-fetch-site": "cross-site",
      }),
    ))!.status,
    403,
  );
  equal(
    (await f.handle(
      post("/api/model-revisions", requestProposal, {
        "content-type": "text/plain",
      }),
    ))!.status,
    415,
  );
  equal(
    (await f.handle(
      post("/api/model-revisions", {
        ...requestProposal,
        author: "administrator",
        authorization: {
          kind: "local-owner",
          authorityExercise: exerciseOwnerAuthority(f.native, "model-revision"),
        },
      }),
    ))!.status,
    400,
  );
  equal(f.calls.propose.length, 0);
});

Deno.test("local owner proposals are independent from operator permission but require the admitted runtime version", async () => {
  const f = fixture();
  f.setNative({
    ...f.native,
    policy: { ...f.native.policy, mayProposeSysmlRevision: false },
  });
  equal(
    (await f.handle(post("/api/model-revisions", requestProposal)))!.status,
    201,
  );
  f.calls.propose.length = 0;
  f.setNative({
    ...f.native,
    version: { ...f.native.version, digest: NEW_DIGEST },
  });
  equal(
    (await f.handle(post("/api/model-revisions", requestProposal)))!.status,
    409,
  );
  equal(f.calls.propose.length, 0);
  f.setNative(f.native);
  equal(
    (await f.handle(post("/api/model-revisions", requestProposal)))!.status,
    201,
  );
  deepStrictEqual(f.calls.propose, [{
    ...requestProposal,
    author: "local-owner",
    authorization: {
      kind: "local-owner",
      authorityExercise: exerciseOwnerAuthority(f.native, "model-revision"),
    },
  }]);
  equal(f.calls.accept.length, 0);
});

Deno.test("commit history and version comparisons read exact immutable sources without mutating admission", async () => {
  const f = fixture();
  const history = await (await f.handle(
    new Request(
      "http://127.0.0.1:4312/api/model-history",
    ),
  ))!.json();
  equal(history.headVersion, "branch:base");
  equal(history.commits[0].version, "branch:base");
  const compared = await (await f.handle(
    new Request(
      "http://127.0.0.1:4312/api/model-diff?from=commit:older&to=branch:base",
    ),
  ))!.json();
  equal(compared.fromVersion, "commit:older");
  equal(compared.toVersion, "branch:base");
  equal(compared.patch, "");
  deepStrictEqual(f.calls.header, ["commit:older", "branch:base"]);
  deepStrictEqual(f.calls.at, []);
  deepStrictEqual(compared.files, []);
  const initial = await (await f.handle(
    new Request(
      "http://127.0.0.1:4312/api/model-diff?from=empty&to=branch:base",
    ),
  ))!.json();
  equal(initial.fromVersion, null);
  equal(initial.files[0].kind, "added");
  match(initial.patch, /new file mode/);
  match(initial.patch, /\+package Example;/);
  for (
    const query of [
      "from=main&to=branch:base",
      "from=commit:older&to=main",
      "to=branch:base",
      "from=empty&to=branch:base&author=admin",
    ]
  ) {
    equal(
      (await f.handle(
        new Request(
          "http://127.0.0.1:4312/api/model-diff?" + query,
        ),
      ))!.status,
      400,
    );
  }
  for (const path of ["/api/model-history", "/api/model-diff"]) {
    equal((await f.handle(post(path, {})))!.status, 405);
  }
  equal(f.calls.accept.length, 0);
  equal(f.calls.propose.length, 0);
  equal(f.calls.adopt.length, 0);
});

Deno.test("structured graph comparison reads pinned versions without admission or adoption", async () => {
  const f = fixture();
  const get = (query: string) =>
    f.handle(
      new Request(`http://127.0.0.1:4311/api/model-graph-diff?${query}`),
    );
  const response = await get("from=commit:older&to=branch:base");
  equal(response!.status, 200);
  equal(response!.headers.get("cache-control"), "no-store");
  const result = await response!.json();
  equal(result.engine, "Git");
  equal(result.fromVersion, "commit:older");
  equal(result.toVersion, "branch:base");
  await get("from=empty&to=branch:base");
  deepStrictEqual(f.calls.graphDiff, [["commit:older", "branch:base"], [
    null,
    "branch:base",
  ]]);
  for (
    const query of [
      "from=main&to=branch:base",
      "from=empty&to=main",
      "from=empty",
      "from=empty&from=commit:older&to=branch:base",
      "from=empty&to=branch:base&to=commit:older",
      "from=empty&to=branch:base&limit=100000",
    ]
  ) {
    equal((await get(query))!.status, 400, query);
  }
  equal(f.calls.graphDiff.length, 2);
  equal((await f.handle(post("/api/model-graph-diff", {})))!.status, 405);
  equal((await get("from=commit:missing&to=branch:base"))!.status, 404);
  equal(
    f.calls.accept.length + f.calls.propose.length + f.calls.adopt.length +
      f.calls.reject.length + f.calls.changed,
    0,
  );
});

Deno.test("revision decisions refuse stale model versions and mismatched reviewed source digests", async () => {
  const f = fixture();
  const path = "/api/model-revisions/proposal-1/decision";
  equal(
    (await f.handle(post(path, { ...decision, sourceDigest: NEW_DIGEST })))!
      .status,
    409,
  );
  equal(
    (await f.handle(
      post(path, { ...decision, expectedVersion: "branch:older" }),
    ))!.status,
    409,
  );
  f.state.busy = true;
  equal((await f.handle(post(path, decision)))!.status, 409);
  equal(f.calls.accept.length, 0);
  equal(f.calls.reject.length, 0);
});

Deno.test("accepting the reviewed design never adopts it for runtime execution", async () => {
  const f = fixture();
  const response = (await f.handle(
    post("/api/model-revisions/proposal-1/decision", decision),
  ))!;
  equal(response.status, 200);
  const result = await response.json();
  equal(result.accepted, true);
  equal(result.executionAdopted, false);
  equal(result.runtime.active.digest, DIGEST);
  equal(result.runtime.available.digest, NEW_DIGEST);
  deepStrictEqual(f.calls.accept, [{
    id: "proposal-1",
    expectedVersion: "branch:base",
    author: "local-control",
    decisionAuthorityExercise: exerciseOwnerAuthority(
      f.native,
      "model-revision",
    ),
  }]);
  equal(f.calls.adopt.length, 0);
  equal(f.state.executionModel.version.digest, DIGEST);
  equal(
    (await f.handle(
      post("/api/model-version/adopt", { expectedDigest: DIGEST }),
    ))!.status,
    409,
  );
  equal(f.calls.adopt.length, 0);
  equal(
    (await f.handle(
      post("/api/model-version/adopt", { expectedDigest: NEW_DIGEST }),
    ))!.status,
    200,
  );
  equal(f.state.executionModel.version.digest, NEW_DIGEST);
  deepStrictEqual(f.calls.adopt, [{
    expectedDigest: NEW_DIGEST,
    expectedVersion: "branch:accepted",
  }]);
});

Deno.test("refusal records an explicit local control without publishing or adopting sources", async () => {
  const f = fixture();
  equal(
    (await f.handle(
      post("/api/model-revisions/proposal-1/decision", {
        ...decision,
        verdict: "refuse",
        reason: "Binding à revoir",
      }),
    ))!.status,
    200,
  );
  deepStrictEqual(f.calls.reject, [{
    id: "proposal-1",
    author: "local-control",
    decisionAuthorityExercise: exerciseOwnerAuthority(
      f.native,
      "model-revision",
    ),
    reason: "Binding à revoir",
  }]);
  equal(f.calls.accept.length, 0);
  equal(f.calls.adopt.length, 0);
  equal(
    (await f.handle(
      post("/api/model-revisions/proposal-1/decision", decision),
    ))!.status,
    409,
  );
});

Deno.test("revision reads pin immutable versions and leave UI rendering to Fresh", async () => {
  const f = fixture();
  const response = (await f.handle(
    new Request(
      "http://127.0.0.1:4311/api/model-sources?version=commit:historical",
    ),
  ))!;
  equal(response.status, 200);
  equal((await response.json()).version, "commit:historical");
  deepStrictEqual(f.calls.header, ["commit:historical"]);
  deepStrictEqual(f.calls.at, []);
  equal(
    (await f.handle(
      new Request("http://127.0.0.1:4311/api/model-sources?version=main"),
    ))!.status,
    400,
  );
  // UI rendering belongs to Fresh; this adapter only serves model APIs.
  equal(await f.handle(new Request("http://127.0.0.1:4311/revisions")), null);
});

Deno.test("current source and revision summaries read headers without compiled artifacts", async () => {
  const f = fixture();
  f.options.repository.current = f.options.repository.at = () => {
    throw new Error("Source summaries must not hydrate compiled artifacts");
  };
  for (const path of ["/api/model-sources", "/api/model-revisions"]) {
    const response = (await f.handle(new Request(`http://localhost${path}`)))!;
    equal(response.status, 200);
    const result = await response.json();
    equal(result.version, "branch:base");
    equal(result.sourceDigest, SOURCE);
  }
  deepStrictEqual(f.calls.header, ["branch:base", "branch:base"]);
  equal(f.calls.at.length, 0);
});

Deno.test("owner authoring merges the exact base and never trusts caller principal fields", async () => {
  const f = fixture();
  const input = {
    ...requestProposal,
    sources: { "new.sysml": "package New;" },
  };
  for (
    const extra of [{ authorization: { kind: "local-owner" } }, {
      author: "other",
    }, { principal: "local-owner" }]
  ) {
    equal(
      (await f.handle(post("/api/model-revisions", { ...input, ...extra })))!
        .status,
      400,
    );
  }
  equal(f.calls.propose.length, 0);
  equal((await f.handle(post("/api/model-revisions", input)))!.status, 201);
  deepStrictEqual(f.calls.propose, [{
    ...input,
    sources: { ...f.current.sources, ...input.sources },
    author: "local-owner",
    authorization: {
      kind: "local-owner",
      authorityExercise: exerciseOwnerAuthority(f.native, "model-revision"),
    },
  }]);
});

Deno.test("runtime inspection reads source rights separately from an older adopted contract", async () => {
  const f = fixture();
  const administration = {
    kind: "delegation" as const,
    id: "a-to-b",
    revision: 1,
    digest: DIGEST,
    systemQualifiedName: "Demo::B",
    holderNativeId: "builder",
    mandateId: "mandate",
    mandateRevision: 1,
    operations: ["set-value" as const],
    grants: [{ file: "mission.sysml", qualifiedRoots: ["Demo::work"] }],
    recipients: ["Demo::C"],
    maxRedelegationDepth: 0,
  };
  f.setNative({ ...f.native, modelAdministration: administration });
  const request = () =>
    f.handle(new Request("http://127.0.0.1:4311/api/model-revisions"));
  let data = await (await request())!.json();
  deepStrictEqual(data.runtime.sourceRights, {
    modelEditPolicy: null,
    modelAdministration: administration,
    operatorAuthorityPolicies: [],
    toolAdmissionPolicies: [],
  });
  f.state.executionModel.modelAdministration = administration;
  f.setNative({ ...f.native });
  data = await (await request())!.json();
  deepStrictEqual(data.runtime.sourceRights, {
    modelEditPolicy: null,
    modelAdministration: null,
    operatorAuthorityPolicies: [],
    toolAdmissionPolicies: [],
  });
  equal(f.state.executionModel.modelAdministration?.id, "a-to-b");
});

Deno.test("runtime inspection reads current operator policies for the exact native owner independently from the adopted pin", async () => {
  const policy = (
    holderNativeId: string,
    revision: number,
    enabled: boolean,
  ): OperatorAuthorityPolicy => ({
    id: "same-policy-id",
    revision,
    enabled,
    recipients: ["research-builder"],
    acts: ["addNetworkHosts"],
    networkHosts: ["example.org"],
    toolIds: [],
    maxDelegationDepth: 0,
    holderNativeId,
    mandateNativeId: `${holderNativeId}-mandate`,
    systemId: `${holderNativeId}-system`,
    elementId: `${holderNativeId}-policy-${revision}`,
    sourceIds: [`${holderNativeId}-source`],
  });
  const worker = workerFixture();
  const f = fixture({
    resolveRuntime: (id) => id === "worker" ? worker.runtime : undefined,
  });
  const primaryPin = policy("builder", 1, true);
  const workerPin = policy("worker", 1, true);
  const primaryCurrent = policy("builder", 2, false);
  const workerCurrent = policy("worker", 3, false);
  const toolPolicy = (network: OperatorAuthorityPolicy) => {
    const { acts: _acts, networkHosts: _hosts, toolIds: _tools, ...base } =
      network;
    return { ...base, toolKinds: ["read_web_page" as const] };
  };
  f.state.executionModel.operatorAuthorityPolicies = [primaryPin];
  worker.state.executionModel.operatorAuthorityPolicies = [workerPin];
  f.setNative({
    ...f.native,
    version: { ...f.native.version, digest: NEW_DIGEST },
    operatorAuthorityPolicies: [workerCurrent, primaryCurrent],
    toolAdmissionPolicies: [
      toolPolicy(workerCurrent),
      toolPolicy(primaryCurrent),
    ],
  });
  worker.setNative({
    ...worker.available,
    operatorAuthorityPolicies: [primaryCurrent, workerCurrent],
    toolAdmissionPolicies: [
      toolPolicy(primaryCurrent),
      toolPolicy(workerCurrent),
    ],
  });
  const primaryBefore = structuredClone(f.state);
  const workerBefore = structuredClone(worker.state);

  for (const query of ["", "?agentId=builder"]) {
    const response = await f.handle(inspectRequest(query));
    equal(response?.status, 200);
    const data = await response!.json();
    equal(data.agentId, "builder");
    equal(data.runtime.active.digest, DIGEST);
    equal(data.runtime.available.digest, NEW_DIGEST);
    deepStrictEqual(data.runtime.sourceRights.operatorAuthorityPolicies, [
      primaryCurrent,
    ]);
    deepStrictEqual(data.runtime.sourceRights.toolAdmissionPolicies, [
      toolPolicy(primaryCurrent),
    ]);
  }
  const selected = await f.handle(inspectRequest("?agentId=worker"));
  equal(selected?.status, 200);
  const data = await selected!.json();
  equal(data.agentId, "worker");
  deepStrictEqual(data.runtime.sourceRights.operatorAuthorityPolicies, [
    workerCurrent,
  ]);
  deepStrictEqual(data.runtime.sourceRights.toolAdmissionPolicies, [
    toolPolicy(workerCurrent),
  ]);
  deepStrictEqual(f.state, primaryBefore);
  deepStrictEqual(worker.state, workerBefore);
  assertNoSourceMutation(f);
  assertNoSourceMutation(worker);
  deepStrictEqual(f.calls.adopt, []);
  deepStrictEqual(worker.calls.adopt, []);
  equal(f.calls.changed, 0);
});

Deno.test("revision proposal listing preserves diagnostic correction addresses", async () => {
  const f = fixture();
  f.proposal.addresses = [{
    code: "LOOP_WITHOUT_BUDGET",
    elementId: "native-loop",
  }];
  const response = await f.handle(
    new Request("http://127.0.0.1:4311/api/model-revisions"),
  );
  equal(response?.status, 200);
  const payload = await response!.json();
  deepStrictEqual(payload.proposals[0].addresses, f.proposal.addresses);
});

Deno.test("local decisions record the modeled owner from the state preceding each source effect", async () => {
  const f = fixture();
  const owner = {
    ...legacyOwnerAuthority(identity.systemId),
    ownerSource: "modeled" as const,
    operatorId: "owner-alice",
    operatorNativeId: "alice-native",
    mandateId: "owner-mandate",
    mandateNativeId: "owner-mandate-native",
    rootAuthorityId: "root-authority",
    rootGrantId: "owner-root-grant",
  };
  f.native.ownerAuthority = owner;
  f.state.executionModel.ownerAuthority = owner;
  const proposed = await f.handle(
    post("/api/model-revisions", requestProposal),
  );
  const receipt = (await proposed!.json()).authorityExercise;
  equal(receipt.ownerSource, "modeled");
  equal(receipt.operatorId, "owner-alice");
  equal(receipt.mandateId, "owner-mandate");
  equal(receipt.rootGrantId, "owner-root-grant");
  equal(receipt.baseModelDigest, DIGEST);
  equal(receipt.outOfMandate, false);

  // Source HEAD may advance independently from the adopted runtime. Acceptance
  // must use its prior source authority, never the candidate's new owner.
  f.setNative({
    ...f.native,
    version: { ...f.native.version, digest: NEW_DIGEST },
    ownerAuthority: { ...owner, operatorId: "owner-bob" },
  });
  const accepted = await f.handle(
    post("/api/model-revisions/proposal-1/decision", decision),
  );
  equal(accepted!.status, 200);
  const acceptance =
    (f.calls.accept[0] as { decisionAuthorityExercise: typeof receipt })
      .decisionAuthorityExercise;
  equal(acceptance.operatorId, "owner-bob");
  equal(acceptance.baseModelDigest, NEW_DIGEST);
  equal(f.state.executionModel.ownerAuthority.operatorId, "owner-alice");
});

Deno.test("local recovery of unusable source is explicit and records its prior mandate as out of mandate", async () => {
  const f = fixture();
  f.runtime.inspectModelVersion = () =>
    Promise.reject(new Error("Unusable source"));
  equal(
    (await f.handle(post("/api/model-revisions", requestProposal)))!.status,
    400,
  );
  equal(f.calls.propose.length, 0);
  for (const recoveryReason of ["", " ", 42]) {
    equal(
      (await f.handle(
        post("/api/model-revisions", { ...requestProposal, recoveryReason }),
      ))!.status,
      400,
    );
  }
  const recoveryReason = "Restaurer le mandat racine cassé";
  const proposed = await f.handle(
    post("/api/model-revisions", { ...requestProposal, recoveryReason }),
  );
  equal(proposed!.status, 201);
  const receipt = (await proposed!.json()).authorityExercise;
  equal(receipt.outOfMandate, true);
  equal(receipt.reason, recoveryReason);
  equal(receipt.ownerSource, "implicit-legacy");
  equal(receipt.baseModelDigest, DIGEST);
  const accepted = await f.handle(
    post("/api/model-revisions/proposal-1/decision", {
      ...decision,
      recoveryReason,
    }),
  );
  equal(accepted!.status, 200);
  const persisted =
    (f.calls.accept[0] as { decisionAuthorityExercise: typeof receipt })
      .decisionAuthorityExercise;
  equal(persisted.outOfMandate, true);
  equal(persisted.reason, recoveryReason);
  equal(persisted.baseModelDigest, DIGEST);
});

Deno.test("local owner source proposals cannot borrow authority from a different base revision", async () => {
  const f = fixture();
  const response = await f.handle(post("/api/model-revisions", {
    ...requestProposal,
    baseVersion: "commit:older",
  }));
  equal(response!.status, 409);
  equal(f.calls.propose.length, 0);
});

Deno.test("local authority invariant errors retain their machine readable fields", async () => {
  const f = fixture();
  f.native.ownerAuthority = legacyOwnerAuthority("other-system");
  const response = await f.handle(
    post("/api/model-revisions", requestProposal),
  );
  equal(response!.status, 400);
  const failure = await response!.json();
  equal(failure.code, "AUTHORITY_INVARIANT");
  equal(failure.invariant, 1);
  equal(failure.reason, "owner-system-mismatch");
  equal(f.calls.propose.length, 0);
});

Deno.test("history preserves legacy fields and errors while validating its bounded query", async () => {
  const f = fixture();
  const response = (await f.handle(
    new Request("http://localhost/api/model-history?limit=1"),
  ))!;
  equal(response.status, 200);
  equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  const commit = result.commits[0];
  deepStrictEqual({
    headVersion: result.headVersion,
    truncated: result.truncated,
    commit: {
      version: commit.version,
      parents: commit.parents,
      author: commit.author,
      message: commit.message,
      createdAt: commit.createdAt,
      sourceDigest: commit.sourceDigest,
    },
  }, {
    headVersion: "branch:base",
    truncated: false,
    commit: {
      version: "branch:base",
      parents: [],
      author: "test",
      message: "Initial model",
      createdAt: "2026-10-21T00:00:00Z",
      sourceDigest: SOURCE,
    },
  });
  for (
    const query of [
      "limit=0",
      "limit=201",
      "limit=1.5",
      "limit=-1",
      "limit=NaN",
      "limit=",
      "limit=1&limit=2",
      "unknown=1",
    ]
  ) {
    const rejected = (await f.handle(
      new Request(`http://localhost/api/model-history?${query}`),
    ))!;
    equal(rejected.status, 400, query);
    const failure = await rejected.json();
    equal(typeof failure.error, "string");
    if (query === "unknown=1") match(failure.error, /inconnu/);
  }
});

Deno.test("file metadata shares versioned HTTP semantics and refuses ambiguous queries", async () => {
  const f = fixture();
  const version = `commit:${"d".repeat(40)}`;
  const files = [{
    path: "a.sysml",
    lastChange: { version, createdAt: "now", message: "Add" },
  }];
  f.options.repository.lastChangeByPath = (head) => {
    equal(head, version);
    return Promise.resolve(files);
  };
  const get = (query = "", headers?: HeadersInit) =>
    f.handle(
      new Request(`http://localhost/api/model-files${query}`, { headers }),
    );
  const response = (await get(`?version=${version}`))!;
  deepStrictEqual(await response.json(), { version, files });
  equal(
    response.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  equal(response.headers.get("x-content-type-options"), "nosniff");
  equal(
    (await get(`?version=${version}`, {
      "if-none-match": response.headers.get("etag")!,
    }))!.status,
    304,
  );
  f.options.repository.lastChangeByPath = () => Promise.resolve(files);
  equal((await get())!.headers.get("cache-control"), "no-store");
  for (
    const query of [
      "?version=branch:main",
      "?version=",
      `?version=${version}&version=${version}`,
      "?other=x",
    ]
  ) {
    const rejected = (await get(query))!;
    equal(rejected.status, 400);
    const failure = await rejected.json();
    equal(typeof failure.code, "string");
    equal(typeof failure.context, "object");
    equal(typeof failure.recovery, "string");
  }
  equal(
    (await f.handle(
      new Request("http://localhost/api/model-files", { method: "POST" }),
    ))!.status,
    405,
  );
  equal(f.calls.at.length, 0);
});

Deno.test("generic source decisions refuse evolution dossiers before authority, enqueue or rejection", async () => {
  for (const verdict of ["approve", "refuse"] as const) {
    for (
      const recoveryReason of [undefined, "Explicit owner recovery request"]
    ) {
      const f = fixture();
      // The discriminator alone must prevent entry into owner-control or the
      // generic writer, even when the remaining source receipt is unreadable.
      f.proposal.authorization = { kind: "operator-evolution" } as NonNullable<
        ProposalRecord["authorization"]
      >;
      f.options.runtime.inspectModelVersion = () => {
        throw new Error("Must not inspect/compile decision authority");
      };
      const response = await f.handle(
        post("/api/model-revisions/proposal-1/decision", {
          ...decision,
          verdict,
          ...(recoveryReason ? { recoveryReason } : {}),
        }),
      );
      equal(response!.status, 409);
      equal((await response!.json()).code, "EVOLUTION_DOSSIER_REQUIRED");
      equal(f.calls.accept.length, 0);
      equal(f.calls.reject.length, 0);
      equal(f.calls.propose.length, 0);
      equal(f.calls.changed, 0);
      equal(f.proposal.status, "proposed");
    }
  }
});
