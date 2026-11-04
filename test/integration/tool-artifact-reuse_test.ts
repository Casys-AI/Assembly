import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
// The native conversation and promotion interpreters run; external ports are doubles.
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { SystemRuntime } from "../support/system-runtime.ts";
import { ToolReuseBehavior } from "../../src/application/work/behaviors/tool-reuse.ts";
import type {
  ToolReuseImport,
  ToolReuseReceipt,
} from "../../src/application/work/artifacts/catalog.ts";
import type { Stage } from "../../src/domain/work/records/candidates.ts";
import type { SystemRuntimeState } from "../../src/application/work/runtime/state.ts";
import type {
  ModelPort,
  StorePort,
} from "../../src/application/work/runtime/ports.ts";
import {
  artifactModel,
  publishedArtifact,
  reuseBehavior,
} from "../support/tool-artifact-fixture.ts";

interface Options {
  mayPropose?: boolean;
  authority?: "human" | "builder";
  testsPass?: boolean;
  admission?: "approve" | "refuse";
  replay?: "sequential" | "concurrent";
  revokeBeforeReplay?: boolean;
  failNativeInsertion?: boolean;
  alterImport?: (input: ToolReuseImport) => void;
}

async function setup(options: Options = {}) {
  const artifact = await publishedArtifact();
  const native = artifactModel("destination");
  native.configuration.builder.admissionAuthority = options.authority ??
    "builder";
  native.mandate.mayAdmitOwnCandidates =
    native.configuration.builder.admissionAuthority === "builder";
  if (options.mayPropose === false) native.mandate.mayPropose = [];
  const behavior = reuseBehavior();
  native.behaviors = [behavior];
  const invocationEdge = native.flows.conversation.edges.find((edge) =>
    edge.guard?.includes('"invoke_tool"')
  );
  ok(invocationEdge);
  invocationEdge.guard =
    '(chooseNextMove.choice.kind == "invoke_tool") or (chooseNextMove.choice.kind == "invoke_behavior")';
  let saved: SystemRuntimeState | null = null;
  const persisted: SystemRuntimeState[] = [];
  const store: StorePort = {
    load: () => Promise.resolve(structuredClone(saved)),
    save(state, expected) {
      equal(saved?.revision ?? null, expected);
      saved = structuredClone(state);
      persisted.push(structuredClone(state));
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
  let tests = 0, admissions = 0, insertions = 0;
  const model: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize: () => Promise.resolve(structuredClone(native.identity)),
    readExecutableModel: () => Promise.resolve(structuredClone(native)),
    applyApprovedChange: () =>
      Promise.reject(new Error("No mandate change belongs to reuse")),
    activateCandidate(_identity, candidate) {
      insertions++;
      if (options.failNativeInsertion) {
        return Promise.reject(new Error("Native insertion interrupted"));
      }
      const binding = {
        elementId: `destination-native-${candidate.id}`,
        graphPath: `destination::catalog::${candidate.id}`,
      };
      native.catalog.push({
        nativeId: binding.elementId,
        candidateId: candidate.id,
        contractId: native.contracts.find((contract) =>
          contract.kind === candidate.kind
        )!.nativeId,
        name: candidate.name,
        kind: candidate.kind,
        digest: candidate.digest,
        status: "active",
      });
      return Promise.resolve(binding);
    },
    graph: () => Promise.resolve({}),
  };
  const provider: ToolReuseBehavior = new ToolReuseBehavior({
    reuseTargetIds: new Set([behavior.targetNativeId]),
    reuseTargetOwners: new Map([[
      behavior.targetNativeId,
      native.identity.builderId,
    ]]),
    resolveCallerModel: () => Promise.resolve(structuredClone(native)),
    findArtifact: () => Promise.resolve(structuredClone(artifact)),
    importForCaller: async (_caller, input): Promise<ToolReuseReceipt> => {
      options.alterImport?.(input);
      if (options.replay === "concurrent") {
        const [first, second] = await Promise.all([
          service.importAdmittedArtifact(input),
          service.importAdmittedArtifact(input),
        ]);
        equal(first.candidateId, second.candidateId);
        return second;
      }
      const first = await service.importAdmittedArtifact(input);
      if (options.replay === "sequential") {
        if (options.revokeBeforeReplay) {
          native.catalog.find((entry) =>
            entry.candidateId === first.candidateId
          )!
            .status = "refused";
        }
        const second = await service.importAdmittedArtifact(input);
        equal(first.candidateId, second.candidateId);
        equal(second.replayed, true);
        return second;
      }
      return first;
    },
  });
  let decisions = 0;
  const service: SystemRuntime = new SystemRuntime({
    model,
    store,
    behaviors: provider,
    agents: {
      label: "Artifact reuse fixture",
      decide() {
        decisions++;
        return Promise.resolve(
          decisions === 1
            ? {
              kind: "invoke_behavior" as const,
              text: "Je propose localement l’artefact publié.",
              behaviorId: behavior.id,
              inputJson: JSON.stringify({
                sourceAgentId: artifact.agentId,
                candidateId: artifact.candidate.id,
                digest: artifact.candidate.digest,
              }),
            }
            : { kind: "reply" as const, text: "État local enregistré." },
        );
      },
      review: () =>
        Promise.reject(
          new Error("No reviewer is configured in this local model"),
        ),
      admit(candidate) {
        admissions++;
        return Promise.resolve({
          candidateDigest: candidate.digest,
          verdict: options.admission ?? "approve",
          reason: "Separate local admission",
        });
      },
    },
    runner: {
      test() {
        tests++;
        return Promise.resolve({
          passed: options.testsPass ?? true,
          checks: [{
            name: "local-fixture",
            passed: options.testsPass ?? true,
            detail: "Local port evidence",
          }],
        });
      },
      run: () => Promise.reject(new Error("Import must not invoke a URL")),
    },
  });
  await service.initialize();
  return {
    service,
    native,
    artifact,
    behavior,
    persisted,
    get tests() {
      return tests;
    },
    get admissions() {
      return admissions;
    },
    get insertions() {
      return insertions;
    },
  };
}

async function turn(fixture: Awaited<ReturnType<typeof setup>>) {
  await fixture.service.submit(
    "Réutilise cet artefact sous ton propre mandat.",
  );
  await fixture.service.idle();
  equal(fixture.service.snapshot.busy, false);
}

Deno.test("artifact import uses the same native promotion, new local identity and exact source digest", async () => {
  const fixture = await setup();
  await turn(fixture);
  const candidate = fixture.service.snapshot.candidates[0]!;
  equal(candidate.stage, "active");
  equal(candidate.digest, fixture.artifact.candidate.digest);
  equal(candidate.code, fixture.artifact.candidate.code);
  equal(candidate.name, fixture.artifact.candidate.name);
  equal(candidate.id === fixture.artifact.candidate.id, false);
  equal(
    candidate.binding!.elementId ===
      fixture.artifact.candidate.binding!.elementId,
    false,
  );
  equal(fixture.tests, 1);
  equal(fixture.admissions, 1);
  equal(candidate.admission!.actorId, fixture.native.configuration.builder.id);
  equal(
    candidate.admission!.actorId ===
      fixture.artifact.candidate.admission!.actorId,
    false,
  );
  equal(candidate.reusedFrom!.agentId, fixture.artifact.agentId);
  const firstRecord = fixture.persisted.find((state) =>
    state.candidates.length > 0
  )!;
  ok(
    firstRecord.candidates[0]!.reusedFrom?.correlationId,
    "Correlation must be durable before the first insertion effect",
  );
});

for (
  const [name, options, stage, admissionCalls] of [
    ["human admission", { authority: "human" }, "awaiting-admission", 0],
    ["failed local tests", { testsPass: false }, "refused", 0],
    ["local admission refusal", { admission: "refuse" }, "refused", 1],
  ] as const
) {
  Deno.test(`artifact source authority does not bypass ${name}`, async () => {
    const fixture = await setup(options);
    await turn(fixture);
    const candidate = fixture.service.snapshot.candidates[0]!;
    equal(candidate.stage, stage as Stage);
    equal(fixture.tests, 1);
    equal(fixture.admissions, admissionCalls);
    equal(candidate.admission, undefined);
    ok(
      fixture.service.snapshot.messages.some((message) =>
        message.role === "tool" && message.text.includes(stage)
      ),
    );
  });
}

for (const replay of ["sequential", "concurrent"] as const) {
  Deno.test(`${replay} replay of the same native import cannot duplicate tests or candidates`, async () => {
    const fixture = await setup({ replay });
    await turn(fixture);
    equal(fixture.service.snapshot.candidates.length, 1);
    equal(fixture.tests, 1);
    equal(fixture.insertions, 1);
    equal(fixture.admissions, 1);
  });
}

Deno.test("interrupted native activation keeps the correlation and replay never restarts its uncertain effect", async () => {
  const fixture = await setup({
    failNativeInsertion: true,
    replay: "sequential",
  });
  await turn(fixture);
  equal(fixture.service.snapshot.candidates.length, 1);
  const candidate = fixture.service.snapshot.candidates[0]!;
  equal(candidate.stage, "activating");
  equal(candidate.binding, undefined);
  equal(candidate.activationModelDigest, fixture.native.version.digest);
  equal(fixture.native.catalog.length, 0);
  equal(fixture.insertions, 1);
  equal(fixture.tests, 1);
  equal(fixture.admissions, 1);
});

Deno.test("replaying a previously active import rechecks the local native catalog before reporting success", async () => {
  const fixture = await setup({
    replay: "sequential",
    revokeBeforeReplay: true,
  });
  await turn(fixture);
  equal(fixture.service.snapshot.candidates.length, 1);
  equal(fixture.tests, 1);
  equal(fixture.insertions, 1);
  equal(fixture.admissions, 1);
  equal(fixture.native.catalog[0]!.status, "refused");
  ok(
    fixture.service.snapshot.messages.some((message) =>
      message.role === "tool" &&
      message.text.includes("BEHAVIOR_RESULT_UNCONFIRMED") &&
      message.text.includes("ne confirme plus")
    ),
  );
});

Deno.test("direct host calls without an active matching invocation cannot import an artifact", async () => {
  const fixture = await setup();
  await rejects(() =>
    fixture.service.importAdmittedArtifact({
      artifact: fixture.artifact,
      proof: {
        behavior: fixture.behavior,
        callerId: fixture.native.identity.builderId,
        invocationId: "forged-direct-call",
        modelVersion: {
          digest: fixture.native.version.digest,
          repositoryVersion: fixture.native.version.repositoryVersion!,
        },
      },
    }), /invocation native en cours/);
  equal(fixture.tests, 0);
  equal(fixture.insertions, 0);
  deepStrictEqual(fixture.service.snapshot.candidates, []);
});

Deno.test("a provider cannot substitute another caller proof during an otherwise admitted import", async () => {
  const fixture = await setup({
    alterImport: (input) => input.proof.callerId = "source",
  });
  await turn(fixture);
  equal(fixture.tests, 0);
  equal(fixture.insertions, 0);
  deepStrictEqual(fixture.service.snapshot.candidates, []);
});

Deno.test("an exposed import cannot bypass the target mandate's candidate-kind permission", async () => {
  const fixture = await setup({ mayPropose: false });
  await turn(fixture);
  equal(fixture.tests, 0);
  equal(fixture.insertions, 0);
  deepStrictEqual(fixture.service.snapshot.candidates, []);
});

Deno.test("runtime artifact-source publication accepts the exact admission and refuses forged, stale or out-of-mandate proofs", async (t) => {
  const { ModelRepositoryError } = await import(
    "../../src/application/model/repository.ts"
  );
  const version = `commit:${"a".repeat(40)}`;
  const digest = "a".repeat(64);
  function modelWith(
    mutate?: (model: ReturnType<typeof artifactModel>) => void,
  ) {
    const native = artifactModel("owner");
    native.version.digest = digest;
    native.version.repositoryVersion = version;
    mutate?.(native);
    return native;
  }
  async function open(native: ReturnType<typeof artifactModel>) {
    let saved: SystemRuntimeState | null = null;
    const service = new SystemRuntime({
      model: {
        ...unexpectedModelAuthoring,
        initialize: () => Promise.resolve(structuredClone(native.identity)),
        readExecutableModel: () => Promise.resolve(structuredClone(native)),
        applyApprovedChange: () =>
          Promise.reject(new Error("No mandate change belongs to reuse")),
        activateCandidate: () =>
          Promise.reject(new Error("No activation belongs to reuse")),
        graph: () => Promise.resolve({}),
      },
      store: {
        load: () => Promise.resolve(structuredClone(saved)),
        save: (state, expected) => {
          equal(saved?.revision ?? null, expected);
          saved = structuredClone(state);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      },
      agents: {
        label: "Artifact publication fixture",
        decide: () => Promise.resolve({ kind: "reply", text: "Idle." }),
        review: () => Promise.reject(new Error("No reviewer is configured")),
      },
      runner: {
        test: () => Promise.resolve({ passed: true, checks: [] }),
        run: () => Promise.reject(new Error("Publication must not invoke")),
      },
    });
    await service.initialize();
    return service;
  }
  function publicationFor(
    proof: Record<string, unknown>,
    baseVersion = version,
  ) {
    return {
      publicationId: "pub-1",
      source: {
        artifactId: "artifact-1",
        kind: "tool-draft" as const,
        content: {
          name: "reader",
          description: "Reads a page.",
          kind: "read_web_page" as const,
          code: "export default () => ({})",
        },
      },
      baseVersion,
      baseSourceDigest: "b".repeat(64),
      target: {
        projectId: "project",
        systemId: "system",
        executionSpaceId: "space",
        operatorId: "owner",
        ownerId: "owner",
        localArtifactId: "local-1",
        invocationId: "invoke-1",
      },
      proof,
    };
  }
  function exactProof(native: ReturnType<typeof artifactModel>) {
    const propose = native.flows.promotion.nodes.find((node) =>
      node.mechanism === "propose_candidate"
    )!;
    ok(propose);
    return {
      kind: "native-action" as const,
      ownerId: "owner",
      modelVersion: { digest, repositoryVersion: version },
      flowRootNativeId: native.flows.promotion.rootNativeId,
      nativeActionId: propose.nativeId,
      mechanism: "propose_candidate" as const,
      invocationId: "invoke-1",
    };
  }
  const denied = (error: unknown) =>
    error instanceof ModelRepositoryError &&
    error.code === "EDIT_SCOPE_DENIED";

  await t.step("exact publication is accepted", async () => {
    const native = modelWith();
    const service = await open(native);
    service.bindArtifactSourceAuthority(() => Promise.resolve());
    await service.assertArtifactSourcePublication(
      publicationFor(exactProof(native)) as never,
    );
  });

  await t.step("forged pin is refused without mutation", async () => {
    const native = modelWith();
    const service = await open(native);
    service.bindArtifactSourceAuthority(() => Promise.resolve());
    const proof = {
      ...exactProof(native),
      modelVersion: { digest: "f".repeat(64), repositoryVersion: version },
    };
    const before = service.snapshot;
    await rejects(
      () =>
        service.assertArtifactSourcePublication(
          publicationFor(proof) as never,
        ),
      denied,
    );
    deepStrictEqual(service.snapshot, before);
  });

  await t.step("stale pin is refused without mutation", async () => {
    const native = modelWith();
    const service = await open(native);
    service.bindArtifactSourceAuthority(() => Promise.resolve());
    const stale = `commit:${"b".repeat(40)}`;
    const proof = {
      ...exactProof(native),
      modelVersion: { digest, repositoryVersion: stale },
    };
    const before = service.snapshot;
    await rejects(
      () =>
        service.assertArtifactSourcePublication(
          publicationFor(proof, version) as never,
        ),
      denied,
    );
    deepStrictEqual(service.snapshot, before);
  });

  await t.step("out-of-mandate proof is refused without mutation", async () => {
    const native = modelWith((model) => {
      model.mandate.mayPropose = [];
    });
    const service = await open(native);
    service.bindArtifactSourceAuthority(() => Promise.resolve());
    const before = service.snapshot;
    await rejects(
      () =>
        service.assertArtifactSourcePublication(
          publicationFor(exactProof(native)) as never,
        ),
      denied,
    );
    deepStrictEqual(service.snapshot, before);
  });
});
