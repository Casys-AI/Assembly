/** Controlled immutable model/publication ports; actual mandate command, native
 * graph, business CAS/history and evolution service/store. The PostgreSQL case
 * also uses pg-boss, the official saver and SQL retirement. No Toolkit compiler,
 * autonomous provider, Git writer or process-crash qualification is claimed. */
import assert from "node:assert/strict";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { EvolutionService } from "../../src/application/model/evolution/service.ts";
import {
  type EvolutionDossier,
  EvolutionError,
  type EvolutionProposal,
  type EvolutionPublication,
  type EvolutionStorePort,
  hasEvolutionBarrier,
} from "../../src/application/model/evolution/ports.ts";
import {
  assertEvolutionDossier,
  assertEvolutionTransition,
} from "../../src/application/model/evolution/invariants.ts";
import { PostgresEvolutionStore } from "../../src/adapters/out/postgres/evolution-store.ts";
import {
  createEvolutionAuthorityExercise,
  revalidateEvolutionAuthorityExercise,
} from "../../src/domain/model/evolution/authorization.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import { legacyOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { SystemGovernance } from "../../src/domain/governance/policies/governance.ts";
import type { ExecutableModel } from "../../src/domain/model/execution/executable-model.ts";
import type {
  ModelPort,
  StorePort,
} from "../../src/application/work/runtime/ports.ts";
import type {
  ChatDecision,
  SystemRuntimeState,
} from "../../src/domain/work/dialogue.ts";
import type { ApprovedChangePublication } from "../../src/domain/model/publication/change.ts";
import type { OperatorExecutionDelivery } from "../../src/application/work/operators/execution.ts";
import {
  parseAcceptedCommand,
  recordedCommandOutcome,
} from "../../src/application/work/operators/command-delivery.ts";
import {
  captureEvolutionOrigin,
  emptyNativeEvolutionAwait,
  evolutionCheckpoint,
} from "../../src/application/work/runtime/evolution.ts";
import { runtimeRevisionReference } from "../../src/application/work/runtime/execution.ts";
import { AjvSchemaValidator } from "../../src/infrastructure/ajv-schema-validation.ts";
import { executableFixture } from "../support/execution-fixture.ts";
import {
  emptyChangePreview,
  unexpectedModelAuthoring,
} from "../support/model-authoring.ts";
import { createTestNativeExecution } from "../support/native-execution.ts";
import { openPostgresDurableRecoveryHost } from "../support/postgres-runtime-fixture.ts";
import { postgresTestEnabled } from "../support/postgres.ts";

const now = "2026-10-29T00:00:00.000Z";
const scope = {
  projectId: "git:historical-evolution",
  systemId: "historical-evolution-host",
};

/** Test-only dossier CAS/barrier port; no durability or restart claim. */
function memoryEvolutionStore(): EvolutionStorePort {
  const records = new Map<string, EvolutionDossier>();
  const assertTargetsAvailable = (next: EvolutionDossier) => {
    if (!hasEvolutionBarrier(next.status)) return;
    for (const previous of records.values()) {
      if (
        previous.id !== next.id &&
        previous.repositoryId === next.repositoryId &&
        hasEvolutionBarrier(previous.status) &&
        previous.proposal.targets.some((target) =>
          next.proposal.targets.some((candidate) =>
            candidate.operatorId === target.operatorId
          )
        )
      ) {
        throw new EvolutionError(
          "EVOLUTION_CONFLICT",
          "Evolution target already reserved",
        );
      }
    }
  };
  return {
    create(dossier) {
      if (records.has(dossier.id)) {
        throw new EvolutionError(
          "EVOLUTION_CONFLICT",
          "Evolution dossier already exists",
        );
      }
      assertEvolutionDossier(dossier);
      assertTargetsAvailable(dossier);
      records.set(dossier.id, structuredClone(dossier));
      return Promise.resolve(structuredClone(dossier));
    },
    get(id) {
      return Promise.resolve(structuredClone(records.get(id) ?? null));
    },
    listPending(repositoryId) {
      return Promise.resolve(
        [...records.values()].filter((dossier) =>
          dossier.repositoryId === repositoryId &&
          !["cancelled", "superseded", "adopted"].includes(dossier.status)
        ).map((dossier) => structuredClone(dossier)),
      );
    },
    compareAndSwap(id, revision, next) {
      const previous = records.get(id);
      if (!previous || previous.revision !== revision) {
        throw new EvolutionError(
          "EVOLUTION_CONFLICT",
          "Evolution dossier changed",
        );
      }
      assertEvolutionTransition(previous, next);
      assertTargetsAvailable(next);
      records.set(id, structuredClone(next));
      return Promise.resolve(structuredClone(next));
    },
    targetOwner(repositoryId, operatorId) {
      return Promise.resolve(
        [...records.values()].find((dossier) =>
          dossier.repositoryId === repositoryId &&
          hasEvolutionBarrier(dossier.status) &&
          dossier.proposal.targets.some((target) =>
            target.operatorId === operatorId
          )
        )?.id ?? null,
      );
    },
  };
}

async function until<T>(
  read: () => Promise<T | undefined>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = await read();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) throw new Error(`Timed out observing ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function modelFixture() {
  const identity = {
    projectId: scope.projectId,
    editingContextId: "context",
    rootId: "root",
    systemId: "native-owner",
    catalogId: "catalog-owner",
    builderId: "owner",
  };
  const original = executableFixture(
    identity,
    SystemGovernance.fresh("historical-evolution").snapshot,
  );
  original.version.repositoryVersion = "source:0";
  original.operator = {
    name: "Owner",
    instruction: "Initial instruction",
    primary: true,
    humanInput: true,
  };
  const policyFor = (
    model: ExecutableModel,
  ): NonNullable<ExecutableModel["evolutionPolicy"]> => ({
    id: "bounded-evolution",
    revision: 1,
    elementId: "evolution-policy",
    sourceIds: ["evolution-policy"],
    rootAuthority: {
      ...legacyOwnerAuthority(identity.systemId),
      ownerSource: "modeled",
    },
    holderNativeId: identity.builderId,
    mandateNativeId: `mandate-v${model.configuration.builder.mandateRevision}`,
    mandateId: model.mandate.id,
    mandateRevision: model.configuration.builder.mandateRevision,
    grants: (["prepare", "accept", "adopt"] as const).map((act) => ({
      act,
      targetNativeId: identity.builderId,
      category: "instructions",
      bounds: { maxCharacters: 2000 },
    })),
  });
  original.evolutionPolicy = policyFor(original);
  const models = new Map<string, ExecutableModel>([[
    "source:0",
    structuredClone(original),
  ]]);
  let head = structuredClone(original),
    publication: ApprovedChangePublication | null = null;
  let publications = 0, unavailable: string | undefined;
  const model: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize: () => Promise.resolve(identity),
    readExecutableModel: (_identity, version) => {
      const pin = version ?? head.version.repositoryVersion!;
      const source = models.get(pin);
      if (!source || pin === unavailable) {
        return Promise.reject(
          new Error(`Immutable source unavailable: ${pin}`),
        );
      }
      return Promise.resolve(structuredClone(source));
    },
    async previewApprovedChange(identity, change, expectedDigest) {
      assert.equal(expectedDigest, head.version.digest);
      const sourceDigest = await executionDigest(head);
      return {
        ...await emptyChangePreview(identity, change, expectedDigest),
        base: {
          repositoryVersion: head.version.repositoryVersion!,
          modelDigest: expectedDigest,
          sourceDigest,
        },
        sourceDigest,
      };
    },
    applyApprovedChange(_identity, change, digest, receipt) {
      assert.equal(digest, head.version.digest);
      assert.equal(change.kind, "mandate-change");
      assert.equal(change.status, "approved");
      assert.equal(change.authority, "human");
      assert.equal(
        change.diff!.base.repositoryVersion,
        head.version.repositoryVersion,
      );
      const configuration = structuredClone(head.configuration);
      configuration.changes.push(structuredClone(change));
      configuration.revision++;
      configuration.builder.mandateRevision++;
      configuration.builder.admissionAuthority = "builder";
      head = executableFixture(identity, configuration);
      head.version.repositoryVersion = "source:1";
      head.operator = structuredClone(original.operator);
      head.evolutionPolicy = policyFor(head);
      models.set("source:1", structuredClone(head));
      publication = {
        model: structuredClone(head),
        receipt: structuredClone(receipt),
      };
      publications++;
      return Promise.resolve(structuredClone(head));
    },
    findApprovedChange: () => Promise.resolve(structuredClone(publication)),
    activateCandidate: () => {
      throw new Error("No candidate publication expected");
    },
    graph: () => Promise.resolve({}),
  };
  return {
    model,
    models,
    original,
    get head() {
      return structuredClone(head);
    },
    publish(next: ExecutableModel) {
      head = structuredClone(next);
      models.set(next.version.repositoryVersion!, structuredClone(next));
    },
    unavailable(version?: string) {
      unavailable = version;
    },
    get publications() {
      return publications;
    },
  };
}

async function witness(postgres: boolean) {
  const recovery = postgres
    ? await openPostgresDurableRecoveryHost({ scope })
    : undefined;
  let closeStore: (() => void | Promise<void>) | undefined;
  try {
    let saved: SystemRuntimeState | null = null;
    const raw: StorePort = {
      load: () => Promise.resolve(structuredClone(saved)),
      save(state, expected) {
        assert.equal(saved?.revision ?? null, expected);
        saved = structuredClone(state);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };
    const memory = !postgres ? createTestNativeExecution(raw) : undefined;
    const session = await recovery?.openSession();
    const ports = session ? await session.runtimePortsFor("owner") : {
      store: memory!.store,
      stateHistory: memory!.stateHistory,
      execution: memory!.execution,
      dispatch: memory!.dispatch,
      schemaValidator: new AjvSchemaValidator(),
      clock: { now: () => now },
      caseNumbers: { allocate: () => Promise.resolve(1) },
    };
    const source = modelFixture();
    const steps: ChatDecision[] = [
      { kind: "reply", text: "First input completed under source zero" },
      {
        kind: "propose_mandate_change",
        text: "Request bounded mandate",
        reason: "Admit my tested candidates",
        requestedRights: { mayAdmitOwnCandidates: true },
      },
      { kind: "reply", text: "Mandate decision completed under source one" },
    ];
    let providerCalls = 0, evolutionPublications = 0;
    const deliveries: OperatorExecutionDelivery[] = [],
      failures: unknown[] = [];
    const runtime = new SystemRuntime({
      ...ports,
      model: source.model,
      agents: {
        label: "controlled decisions",
        decide() {
          providerCalls++;
          const step = steps.shift();
          assert.ok(step, "No unplanned provider call");
          return Promise.resolve(step);
        },
        review: () => {
          throw new Error("No review expected");
        },
      },
      runner: {
        run: () => {
          throw new Error("No tool execution expected");
        },
        test: () => {
          throw new Error("No tool test expected");
        },
      },
      dispatch: {
        enqueue(delivery) {
          deliveries.push(structuredClone(delivery));
          return ports.dispatch.enqueue(delivery);
        },
        inspect: (identity, id) => ports.dispatch.inspect(identity, id),
        inspectAccepted: (operatorId, id) =>
          ports.dispatch.inspectAccepted!(operatorId, id),
        inspectTerminalAccepted: (operatorId, id) =>
          ports.dispatch.inspectTerminalAccepted!(operatorId, id),
      },
    });
    await runtime.initialize(undefined, {
      resumeContinuations: false,
      resumeCandidateContinuations: false,
    });
    if (memory) memory.bind(runtime);
    if (session) {
      await session.start(async (delivery) => {
        try {
          await runtime.processAcceptedContribution(delivery);
        } catch (error) {
          failures.push(error);
          throw error;
        }
      });
    }
    const complete = async (operation: () => Promise<unknown>) => {
      const start = deliveries.length;
      await operation();
      const [delivery] = deliveries.slice(start);
      assert.equal(
        deliveries.length,
        start + 1,
        "One actual accepted DTO for this operation",
      );
      if (memory) await memory.idle();
      const accepted = await until(async () => {
        const accepted = await ports.dispatch.inspectAccepted!(
          "owner",
          delivery.id,
        );
        if (accepted?.receipt.status === "failed") {
          throw new Error(
            `Exact delivery ${delivery.id} failed: ${
              canonical(accepted.receipt)
            }; ${failures.map(String)}`,
          );
        }
        return accepted?.receipt.status === "completed" ? accepted : undefined;
      }, `completion of ${delivery.id}`);
      assert.deepEqual(accepted.delivery, delivery);
      const command = parseAcceptedCommand(delivery);
      if (command) assert.ok(recordedCommandOutcome(runtime.snapshot, command));
      return delivery;
    };
    const input = await complete(() => runtime.submit("First input"));
    const [old] = await ports.execution.inspect("owner");
    assert.ok(old);
    assert.equal(input.kind, "contribution");
    assert.equal(old.identity.subjectId, input.id);
    assert.equal(old.contributionId, input.id);
    const canonicalInput = runtime.snapshot.messages.find((message) =>
      message.id === input.id
    );
    assert.ok(canonicalInput);
    assert.equal(canonicalInput.role, "user");
    assert.equal(canonicalInput.text, input.payload!.text);
    assert.equal(old.modelDigest, source.original.version.digest);
    assert.deepEqual(old.localState!.reply, {
      kind: "reply",
      text: "First input completed under source zero",
    });
    assert.equal(emptyNativeEvolutionAwait(runtime.snapshot, old), true);
    await complete(() => runtime.submit("Propose the bounded mandate"));
    const change = runtime.snapshot.configuration!.changes.find((change) =>
      change.status === "pending"
    )!;
    assert.ok(change);
    await complete(() =>
      runtime.decideChange({
        changeId: change.id,
        expectedRevision: runtime.snapshot.configuration!.revision,
        verdict: "approve",
      })
    );
    const current = runtime.snapshot.executionModel!;
    assert.equal(current.version.repositoryVersion, "source:1");
    assert.equal(current.configuration.builder.admissionAuthority, "builder");
    assert.equal(source.publications, 1);
    assert.deepEqual(
      await source.model.readExecutableModel(current.identity, "source:0"),
      source.original,
    );
    assert.equal(
      emptyNativeEvolutionAwait(runtime.snapshot, old),
      false,
      "Current model cannot prove an old pin",
    );
    assert.equal(
      emptyNativeEvolutionAwait(runtime.snapshot, old, source.original),
      true,
    );
    assert.equal(
      evolutionCheckpoint(
        runtime.snapshot,
        await ports.execution.inspect("owner"),
      ).safe,
      false,
      "Without an immutable source the old owner must block",
    );
    assert.equal(providerCalls, 3);
    const candidate = structuredClone(current);
    candidate.operator!.instruction =
      "Governed instruction after the exact mandate";
    candidate.version = {
      ...candidate.version,
      digest: "source-two",
      repositoryVersion: "source:2",
    };
    const proposal: EvolutionProposal = {
      id: "bounded-proposal",
      version: "candidate:2",
      baseVersion: "source:1",
      sourceDigest: await executionDigest(candidate),
      recipeDigest: "controlled-instruction-recipe",
      digest: "exact-instruction-proposal",
      targets: [{
        operatorId: "owner",
        previousDigest: current.version.digest,
        candidateDigest: candidate.version.digest,
      }],
      categories: ["instructions"],
    };
    const postgresStore = session
      ? new PostgresEvolutionStore(session.storage.client, scope)
      : undefined;
    const evolutionStore = postgresStore ?? memoryEvolutionStore();
    if (session) {
      await session.storage.client.sourceRepository.create({
        data: {
          ...scope,
          repositoryId: "source-repository",
          sourceScopeId: "controlled-source",
        },
      });
    }
    closeStore = postgresStore ? () => postgresStore.close() : undefined;
    runtime.bindEvolutionBarrier("source-repository", evolutionStore);
    let publication: EvolutionPublication | null = null;
    const service = new EvolutionService({
      store: evolutionStore,
      now: () => now,
      authority: {
        authorize: (act, actor, subject) => {
          assert.equal(actor, "owner");
          assert.equal(subject.digest, proposal.digest);
          return createEvolutionAuthorityExercise(source.head, {
            act,
            systemQualifiedName: "System::Owner",
            targets: ["owner"],
            categories: ["instructions"],
            proposalDigest: subject.digest,
          });
        },
        revalidate: (receipt) =>
          revalidateEvolutionAuthorityExercise(source.head, receipt),
      },
      repository: {
        prepare: (input) => {
          assert.equal(input.expectedVersion, "source:1");
          return Promise.resolve(structuredClone(proposal));
        },
        revalidate: () => {
          assert.equal(source.head.version.repositoryVersion, "source:1");
          return Promise.resolve();
        },
        publish: (dossier) => {
          assert.equal(dossier.status, "publishing");
          evolutionPublications++;
          source.publish(candidate);
          publication = {
            commandId: proposal.id,
            commandDigest: "controlled-exact-command",
            version: "source:2",
            sourceDigest: proposal.sourceDigest,
            proposalDigest: proposal.digest,
          };
          return Promise.resolve(publication);
        },
        findPublication: () => Promise.resolve(publication),
      },
      targets: {
        captureOrigin: (input, proposal) =>
          Promise.resolve(
            captureEvolutionOrigin(input, proposal, [runtime.snapshot]),
          ),
        withArmingTargets: (_dossier, operation) =>
          runtime.withEvolutionArming(operation),
        withReservedTargets: (dossier, operation) =>
          runtime.withEvolutionReservation(
            dossier.id,
            async () =>
              operation(
                await runtime.evolutionBoundary(dossier.id),
                () => runtime.evolutionBoundary(dossier.id),
              ),
          ),
        inspectAdoption: (dossier, target, publication) =>
          Promise.resolve(
            runtime.inspectEvolutionAdoption(dossier, target, publication),
          ),
        async adoptExact(dossier, target, publication) {
          await runtime.adoptEvolution(dossier, target, publication, candidate);
          const receipt = runtime.inspectEvolutionAdoption(
            dossier,
            target,
            publication,
          );
          assert.ok(receipt);
          return receipt;
        },
      },
    });
    const prepared = await service.prepare({
      id: "source-one-to-two",
      repositoryId: "source-repository",
      actorId: "owner",
      finalizerActorId: "owner",
      origin: {
        operatorId: "owner",
        designerScopeId: runtime.snapshot.designer!.scopeId,
      },
      expectedVersion: "source:1",
      reason: "Qualify historical terminal retirement",
      sources: { "controlled.sysml": "instruction revision" },
    });
    await service.accept(prepared.id, "owner");
    const armed = await service.authorizeAdoption(prepared.id, "owner");
    assert.equal(
      armed.adoptionAuthorization!.mandateRevision,
      2,
      "The current mandate authorizes evolution",
    );
    const oldAuthority = await createEvolutionAuthorityExercise(
      source.original,
      {
        act: "adopt",
        systemQualifiedName: "System::Owner",
        targets: ["owner"],
        categories: ["instructions"],
        proposalDigest: proposal.digest,
      },
    );
    assert.equal(oldAuthority.mandateRevision, 1);
    assert.notEqual(
      armed.adoptionAuthorization!.authorityDigest,
      oldAuthority.authorityDigest,
    );
    await assert.rejects(
      () => revalidateEvolutionAuthorityExercise(current, oldAuthority),
      /Evolution authority changed/,
    );
    source.unavailable("source:0");
    const blocked = await service.finalize(prepared.id);
    assert.equal(blocked.status, "armed");
    assert.ok(
      blocked.blockers.some((blocker) =>
        blocker.code === "EVOLUTION_NATIVE_EXECUTION_UNSETTLED"
      ),
    );
    assert.equal(evolutionPublications, 0);
    assert.deepEqual(runtime.snapshot.executionModel, current);
    source.unavailable();
    if (session) {
      const forged = { ...old, checkpointId: "changed-after-inspection" };
      await assert.rejects(
        () =>
          ports.execution.retireAndAdvance(forged, {
            kind: "owner-adoption",
            businessRevision: runtimeRevisionReference(runtime.snapshot),
            authorizationEventId: "not-an-authorization",
          }, candidate),
        /Stale execution retirement snapshot/,
      );
      assert.equal(
        (await session.storage.client.operatorExecution.findFirstOrThrow({
          where: {
            ...scope,
            executionSpaceId: session.storage.executionSpaceId,
            operatorId: "owner",
            threadId: old.threadId,
          },
        })).retiredAt,
        null,
      );
    }
    const adopted = await service.finalize(prepared.id);
    assert.equal(adopted.status, "adopted", canonical(adopted.blockers));
    assert.equal(adopted.adoptions.length, 1);
    assert.equal(adopted.accounting.agentInvocations, 0);
    assert.equal(providerCalls, 3);
    assert.equal(evolutionPublications, 1);
    assert.equal(source.publications, 1);
    assert.deepEqual(
      runtime.snapshot.executionModel!.version,
      candidate.version,
    );
    assert.deepEqual(
      await source.model.readExecutableModel(current.identity, "source:0"),
      source.original,
    );
    const retirement = runtime.snapshot.events.filter((event) =>
      event.kind === "evolution-empty-await-retired"
    ).map((event) => JSON.parse(event.label)).find((receipt) =>
      receipt.threadId === old.threadId
    );
    assert.ok(retirement);
    assert.equal(retirement.dossierId, prepared.id);
    assert.equal(retirement.modelDigest, source.original.version.digest);
    assert.equal(retirement.repositoryVersion, "source:0");
    assert.equal(retirement.checkpointId, old.checkpointId);
    assert.equal(retirement.inputMessageId, old.identity.subjectId);
    assert.equal(retirement.contributionId, old.contributionId);
    if (session) {
      const where = {
        ...scope,
        executionSpaceId: session.storage.executionSpaceId,
        operatorId: "owner",
      };
      const retired = await session.storage.client.operatorExecution
        .findFirstOrThrow({ where: { ...where, threadId: old.threadId } });
      assert.ok(retired.retiredAt);
      const successor = await session.storage.client.operatorExecution
        .findFirstOrThrow({
          where: { ...where, predecessorThreadId: old.threadId },
        });
      assert.equal(
        successor.authorizedPinJson,
        canonical({
          modelDigest: candidate.version.digest,
          repositoryVersion: candidate.version.repositoryVersion,
        }),
      );
      const receipt = JSON.parse(successor.advanceAuthorizationJson!);
      assert.equal(receipt.authorization.kind, "evolution-adoption");
      assert.equal(receipt.authorization.dossierId, adopted.id);
      assert.deepEqual(
        receipt.authorization.adoptionAuthorization,
        armed.adoptionAuthorization,
      );
      assert.deepEqual(receipt.source, old);
    }
    assert.deepEqual(failures, []);
  } finally {
    await closeStore?.();
    await recovery?.close();
  }
}

Deno.test("historical terminal source zero survives a real mandate then retires through governed evolution", () =>
  witness(false));
Deno.test({
  name:
    "PG historical terminal source zero retires under current governed evolution authority",
  ignore: !postgresTestEnabled,
  fn: () => witness(true),
});
