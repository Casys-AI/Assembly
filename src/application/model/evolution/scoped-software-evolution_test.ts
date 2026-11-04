// deno-lint-ignore-file require-await -- Deterministic port doubles.
import type { ScopedSoftwareRuntimeTarget } from "./ports.ts";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { bindHostBackgroundTask } from "../../../infrastructure/host-background-task.ts";
import {
  currentPostgresExecutionTransaction,
  withPostgresExecutionTransaction,
} from "../../../adapters/out/postgres/execution-transaction.ts";
import type { PrismaClient } from "../../../adapters/out/postgres/client.ts";
import { requestAdoptionFixture } from "../../../../test/support/request-adoption-fixture.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { OpeningRecord } from "../../../domain/work/request-spaces.ts";
import type { EvolutionAuthorityExercise } from "../../../domain/model/evolution/policy.ts";
import type {
  EvolutionAdoptionReceipt,
  EvolutionPreparationInput,
  EvolutionStorePort,
} from "./ports.ts";
import { hasEvolutionBarrier } from "./ports.ts";
import { parseScopedSoftwareContext } from "./scoped-software-context.ts";
import {
  parseScopedSoftwareProposal,
  scopedSoftwareProposalDigest,
} from "./scoped-software-proposal.ts";
import {
  parseScopedSoftwareDossier,
  type ScopedSoftwareEvolutionDossierV2,
} from "./scoped-software-dossier.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import type { SystemRuntime } from "../../work/runtime/system.ts";
import { createScopedSoftwareEvolution } from "./scoped-software-evolution.ts";

async function fixture(
  runInHostContext: Parameters<
    typeof createScopedSoftwareEvolution
  >[0]["runInHostContext"] = bindHostBackgroundTask((
    operation: () => void | Promise<void>,
  ) => operation()),
  observeFinalization?: () => void,
) {
  const f = await requestAdoptionFixture();
  const ref = {
    ...f.target.host,
    executionSpaceId: f.target.executionSpaceId,
    operatorId: f.target.operatorId,
  };
  const { operatorId: _id, ...locator } = f.target;
  const scope = parseScopedSoftwareContext({
    format: "software-evolution-scope/v2",
    destination: {
      ...locator,
      expectedAdmittedSource: {
        revision: 2,
        source: f.intent.candidate.source,
        sourceDigest: f.intent.candidate.sourceDigest,
      },
    },
    openingBaseDigest: f.intent.openingBaseDigest,
    predecessorManifestDigest: "f".repeat(64),
    actor: ref,
    targets: [{ target: ref, previousPin: f.intent.previous.pin }],
  });
  const candidate = structuredClone(f.model);
  candidate.version.repositoryVersion = `commit:${"3".repeat(40)}`;
  const scoped = parseScopedSoftwareProposal({
    format: "software-evolution-scoped/v2",
    context: scope,
    sourceAssessmentDigest: "d".repeat(64),
    targets: [{ target: ref, candidateDigest: candidate.version.digest }],
    categories: ["instructions"],
  });
  const proposal = {
    id: "proposal",
    version: candidate.version.repositoryVersion,
    baseVersion: scope.destination.expectedAdmittedSource.source.version,
    sourceDigest: "e".repeat(64),
    recipeDigest: "9".repeat(64),
    digest: await scopedSoftwareProposalDigest(scoped),
    categories: ["instructions" as const],
    targets: [{
      operatorId: ref.operatorId,
      previousDigest: f.previous.version.digest,
      candidateDigest: candidate.version.digest,
    }],
    scoped,
  };
  let state: SystemRuntimeState = {
    id: `request:${ref.executionSpaceId}:${ref.operatorId}`,
    revision: 4,
    catalogRevision: 0,
    provider: "test",
    phase: "ready",
    busy: false,
    executionModel: f.previous,
    messages: [],
    events: [],
    candidates: [],
    caseInvocation: { kind: "local", caseId: f.target.caseId },
    cases: [{
      id: f.target.caseId,
      number: 1,
      owner: ref.operatorId,
      openedBy: "owner",
      type: "request",
      objective: "Work",
      modelPin: { digest: f.previous.version.digest },
      status: "open",
      createdAt: "2026-10-31T00:00:00Z",
      openedFrom: { conversationId: "main", openingId: f.target.openingId },
    }],
  };
  let safe = false, reserved = false, publications = 0;
  const boundaries:
    import("./scoped-software-adoption.ts").ScopedSoftwareFinalBoundaryV2[] =
      [];
  const runtime = {
    get snapshot() {
      return structuredClone(state);
    },
    configureOperatorEvolution() {},
    bindEvolutionBarrier() {},
    onState() {
      return () => {};
    },
    async readPersistedState() {
      return structuredClone(state);
    },
    async withEvolutionArming<T>(op: () => Promise<T>) {
      return await op();
    },
    async withEvolutionReservation<T>(_id: string, op: () => Promise<T>) {
      assert(!reserved);
      reserved = true;
      try {
        return await op();
      } finally {
        reserved = false;
      }
    },
    async evolutionBoundary() {
      assert(reserved);
      return {
        safe,
        blockers: safe ? [] : [{
          code: "PARKED_CONTINUATION",
          detail: "Engaged work is not settled",
        }],
      };
    },
  } as unknown as SystemRuntime;
  const opening = {
    id: f.target.openingId,
    caseId: f.target.caseId,
    baseDigest: scope.openingBaseDigest,
  } as OpeningRecord;
  const target: ScopedSoftwareRuntimeTarget = {
    ref,
    opening,
    runtime,
    stores: undefined!,
    readBinding: async () => ({
      state: structuredClone(state),
      pin: f.intent.previous.pin,
      admission: f.intent.previous.admission,
    }),
    inspectNative: async () => [],
  };
  const terminal = Promise.withResolvers<void>();
  const records = new Map<string, ScopedSoftwareEvolutionDossierV2>();
  const store: EvolutionStorePort<ScopedSoftwareEvolutionDossierV2> = {
    async create(d) {
      await parseScopedSoftwareDossier(d);
      records.set(d.id, structuredClone(d));
      return structuredClone(d);
    },
    async get(id) {
      return structuredClone(records.get(id) ?? null);
    },
    async listPending() {
      return [...records.values()].filter((d) =>
        !["adopted", "cancelled"].includes(d.status)
      ).map((d) => structuredClone(d));
    },
    async compareAndSwap(id, revision, d) {
      assert.equal(records.get(id)!.revision, revision);
      await parseScopedSoftwareDossier(d);
      records.set(id, structuredClone(d));
      if (d.status === "adopted") terminal.resolve();
      return structuredClone(d);
    },
    async targetOwner(_repo, id) {
      return [...records.values()].find((d) =>
        hasEvolutionBarrier(d.status) &&
        d.proposal.targets.some((t) => t.operatorId === id)
      )?.id ?? null;
    },
  };
  let foreign = false;
  const controller = createScopedSoftwareEvolution({
    runInHostContext,
    scope,
    actor: target,
    store,
    resolve: async () =>
      foreign
        ? { ...target, ref: { ...ref, executionSpaceId: "other-space" } }
        : target,
    now: () => "2026-10-31T00:00:00Z",
    failed: (e) => {
      throw e;
    },
    candidate: async () => candidate,
    authority: {
      async authorize(act, actorId): Promise<EvolutionAuthorityExercise> {
        return {
          act,
          operatorNativeId: actorId,
          systemQualifiedName: "System",
          authorityDigest: "1".repeat(64),
          policyId: "policy",
          policyRevision: 1,
          mandateId: "mandate",
          mandateNativeId: "mandate-native",
          mandateRevision: 1,
          targets: [ref.operatorId],
          categories: ["instructions"],
          proposalDigest: proposal.digest,
        };
      },
      async revalidate() {},
    },
    repository: {
      async prepare() {
        return proposal;
      },
      async revalidate() {},
      async findPublication() {
        observeFinalization?.();
        return null;
      },
      async publish() {
        publications++;
        return {
          commandId: proposal.id,
          commandDigest: "2".repeat(64),
          version: proposal.version,
          sourceDigest: proposal.sourceDigest,
          proposalDigest: proposal.digest,
          sourceAdmission: { revision: 3, manifestDigest: "4".repeat(64) },
        };
      },
    },
    adoption: {
      async inspect() {
        return null;
      },
      async adopt(input): Promise<EvolutionAdoptionReceipt> {
        assert(reserved);
        boundaries.push(structuredClone(input.boundary));
        const receipt:
          import("./scoped-software-adoption.ts").ScopedSoftwareAdoptionReceiptV2 =
            {
              ...input.target,
              version: input.publication.version,
              proposalDigest: input.dossier.proposal.digest,
              effectiveAt: "2026-10-31T00:00:01Z",
              target: input.boundary.target,
              manifestDigest: "8".repeat(64),
              journalRevision: 4,
              authorizationRuntimeRevision:
                input.boundary.previousRuntimeRevision + 1,
              committedRuntimeRevision: input.boundary.previousRuntimeRevision +
                2,
            };
        return receipt;
      },
    },
  });
  const callerCommandId = "native-effect", callerCommandDigest = "6".repeat(64);
  const id = `software-evolution-scoped:${await sha256(
    canonical({
      format: "software-evolution-id/v2",
      host: scope.destination.host,
      repositoryId: scope.destination.repositoryId,
      preparer: scope.actor,
      callerCommandId,
    }),
  )}`;
  const input: EvolutionPreparationInput = {
    id,
    callerCommandId,
    callerCommandDigest,
    repositoryId: scope.destination.repositoryId,
    actorId: ref.operatorId,
    finalizerActorId: ref.operatorId,
    origin: { operatorId: ref.operatorId, requestId: f.target.caseId },
    expectedVersion: proposal.baseVersion,
    reason: "Update admitted instructions",
    sources: { "model.sysml": "candidate" },
  };
  return {
    controller,
    terminal: terminal.promise,
    input,
    store,
    boundaries,
    setSafe(v: boolean) {
      safe = v;
    },
    setRevision(v: number) {
      state = { ...state, revision: v };
    },
    foreign() {
      foreign = true;
    },
    publications: () => publications,
  };
}

Deno.test("scoped finalization captures fresh post-settlement rFinal and never treats busy=false as proof", async () => {
  const f = await fixture();
  try {
    await f.controller.service.prepare(f.input);
    await f.controller.service.accept(f.input.id, f.input.actorId);
    await f.controller.service.authorizeAdoption(f.input.id, f.input.actorId);
    f.setRevision(9);
    const blocked = await f.controller.service.finalize(f.input.id);
    assert.equal(blocked.status, "armed");
    assert.equal(f.publications(), 0);
    assert.equal(f.boundaries.length, 0);
    f.setRevision(17);
    f.setSafe(true);
    const adopted = await f.controller.service.finalize(f.input.id);
    assert.equal(adopted.status, "adopted", JSON.stringify(adopted.blockers));
    assert.equal(f.publications(), 1);
    assert.equal(f.boundaries[0].previousRuntimeRevision, 17);
    assert.equal(
      f.boundaries[0].previousBusinessRevision.__assemblyRuntimeRevision
        .revision,
      17,
    );
  } finally {
    f.controller.dispose();
  }
});

Deno.test("scoped prepare refuses a resolver returning another same-native-ID instance", async () => {
  const f = await fixture();
  try {
    f.foreign();
    await assert.rejects(f.controller.service.prepare(f.input), {
      code: "EVOLUTION_SCOPE_CHANGED",
    });
    assert.equal(await f.store.get(f.input.id), null);
  } finally {
    f.controller.dispose();
  }
});

Deno.test("scoped scheduled finalization and direct recovery use bootstrap context after the native origin aborts", async () => {
  for (const mode of ["schedule", "recover"] as const) {
    const context = new AsyncLocalStorage<"host" | "delivery">();
    const runInHostContext = context.run("host", () =>
      bindHostBackgroundTask(
        (operation: () => void | Promise<void>) => operation(),
      ));
    const origin = new AbortController();
    const client = {} as PrismaClient;
    const execution = {
      client,
      session: { threadId: "origin-thread", runId: "origin-run" },
      fence: () => {
        origin.signal.throwIfAborted();
        return Promise.resolve();
      },
    };
    const observed: Array<
      {
        context: string | undefined;
        execution: ReturnType<typeof currentPostgresExecutionTransaction>;
      }
    > = [];
    // Request controllers are deliberately constructed inside delivery context;
    // only the injected runner was captured at bootstrap, as in production.
    const f = await context.run(
      "delivery",
      () =>
        withPostgresExecutionTransaction(
          execution,
          () =>
            fixture(runInHostContext, () => {
              observed.push({
                context: context.getStore(),
                execution: currentPostgresExecutionTransaction(),
              });
            }),
        ),
    );
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await f.controller.service.prepare(f.input);
      await f.controller.service.accept(f.input.id, f.input.actorId);
      await f.controller.service.authorizeAdoption(f.input.id, f.input.actorId);
      f.setSafe(true);
      origin.abort(); // pg-boss also aborts a normally completed job's signal.
      await context.run(
        "delivery",
        () =>
          withPostgresExecutionTransaction(execution, async () => {
            if (mode === "schedule") {
              f.controller.requestFinalization();
              f.controller.requestFinalization();
            } else await f.controller.recover();
            assert.equal(context.getStore(), "delivery");
            assert.equal(
              currentPostgresExecutionTransaction(),
              execution,
              "ordinary delivery context remains fenced",
            );
          }),
      );
      await Promise.race([
        f.terminal,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() =>
            reject(
              new Error(`Scoped ${mode} did not reach its terminal receipt`),
            ), 2_000);
        }),
      ]);
      await f.controller.recover();
      assert.equal((await f.store.get(f.input.id))!.status, "adopted");
      assert.equal(f.publications(), 1);
      assert(observed.length > 0);
      assert(
        observed.every((entry) =>
          entry.context === "host" && entry.execution === undefined
        ),
        `${mode} inherited a native claim/fence`,
      );
    } finally {
      clearTimeout(deadline);
      f.controller.dispose();
    }
  }
});
