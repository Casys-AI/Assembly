import { unexpectedModelAuthoring } from "../../../../test/support/model-authoring.ts";
import {
  deepStrictEqual,
  equal,
  notStrictEqual,
  rejects,
} from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import { SystemRuntime } from "../../../../test/support/system-runtime.ts";
import type { ModelPort, StorePort } from "./ports.ts";
import {
  legacyOwnerAuthority,
  type OwnerAuthority,
} from "../../../domain/governance/authority.ts";

async function fixture(ownerAuthority?: OwnerAuthority) {
  const model = executableFixture({
    projectId: "git:cd777064-53b3-5753-802c-efc16d4db427",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "builder",
  });
  model.version.repositoryVersion = "branch:admitted";
  if (ownerAuthority) model.ownerAuthority = ownerAuthority;
  let saved: SystemRuntimeState | null = null;
  let writes = 0, reads = 0;
  let readFailure: Error | undefined;
  let writeFailure: Error | undefined;
  let pausedBusyWrite:
    | { enter: () => void; released: Promise<void> }
    | undefined;
  const persisted: SystemRuntimeState[] = [];
  const store: StorePort = {
    load: () => Promise.resolve(structuredClone(saved)),
    async save(value, expected) {
      if (pausedBusyWrite && value.busy && !saved?.busy) {
        const paused = pausedBusyWrite;
        pausedBusyWrite = undefined;
        paused.enter();
        await paused.released;
      }
      // A real asynchronous CAS exposes competing writes from overlapping reads.
      await Promise.resolve();
      if (writeFailure) {
        const error = writeFailure;
        writeFailure = undefined;
        throw error;
      }
      equal(saved?.revision ?? null, expected, "State revision changed");
      saved = structuredClone(value);
      persisted.push(structuredClone(value));
      writes++;
    },
    close: () => Promise.resolve(),
  };
  const source: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize: () => Promise.resolve(structuredClone(model.identity)),
    readExecutableModel() {
      reads++;
      if (readFailure) {
        const error = readFailure;
        readFailure = undefined;
        return Promise.reject(error);
      }
      return Promise.resolve(structuredClone(model));
    },
    applyApprovedChange() {
      throw new Error("Inspection cannot change native source");
    },
    activateCandidate() {
      throw new Error("Inspection cannot activate tools");
    },
    graph: () => Promise.resolve({}),
  };
  const service = new SystemRuntime({
    model: source,
    store,
    agents: {
      label: "fixture",
      decide() {
        throw new Error("Inspection cannot call an agent");
      },
      review() {
        throw new Error("Inspection cannot call a reviewer");
      },
    },
    runner: {
      run() {
        throw new Error("Inspection cannot execute tools");
      },
      test() {
        throw new Error("Inspection cannot test tools");
      },
    },
  });
  await service.initialize();
  return {
    model,
    service,
    failNextRead: () => readFailure = new Error("Native source unavailable"),
    failNextWrite: () => writeFailure = new Error("Persistence unavailable"),
    pauseNextBusyWrite() {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => enter = resolve);
      const released = new Promise<void>((resolve) => release = resolve);
      pausedBusyWrite = { enter, released };
      return { entered, release };
    },
    get persisted() {
      return structuredClone(persisted);
    },
    get writes() {
      return writes;
    },
    get reads() {
      return reads;
    },
  };
}

Deno.test("model inspection persists a changed contract once without adopting it", async () => {
  const f = await fixture();
  const admitted = f.service.snapshot.executionModel;
  f.model.version.digest = "available-contract";
  f.model.version.repositoryVersion = "branch:available";
  const before = f.service.snapshot.revision;
  const writes = f.writes;
  let notifications = 0;
  f.service.onState(() => notifications++);

  await f.service.inspectModelVersion();
  await f.service.inspectModelVersion();
  await f.service.inspectModelVersion();

  equal(f.service.snapshot.revision, before + 1);
  equal(f.writes, writes + 1);
  equal(notifications, 1);
  deepStrictEqual(f.service.snapshot.executionModel, admitted);
  deepStrictEqual(f.service.snapshot.availableExecutionModel, f.model);
});

Deno.test("concurrent model inspections serialize their cache write and return isolated copies", async () => {
  const f = await fixture();
  f.model.version.digest = "available-contract";
  f.model.version.repositoryVersion = "branch:available";
  const writes = f.writes, reads = f.reads;
  const revision = f.service.snapshot.revision;

  const results = await Promise.all(
    Array.from({ length: 4 }, () => f.service.inspectModelVersion()),
  );

  equal(f.writes, writes + 1);
  equal(
    f.reads,
    reads + 4,
    "Each preflight must still read current native source",
  );
  equal(f.service.snapshot.revision, revision + 1);
  results.forEach((result) => deepStrictEqual(result, f.model));
  notStrictEqual(results[0], results[1]);
  results[0]!.version.repositoryVersion = "branch:caller-mutation";
  equal(results[1]!.version.repositoryVersion, "branch:available");
  equal(
    f.service.snapshot.availableExecutionModel!.version.repositoryVersion,
    "branch:available",
  );
});

Deno.test("model inspection retains an advanced available source pin and fresh contents without adoption", async () => {
  const f = await fixture();
  const admitted = f.service.snapshot.executionModel;
  f.model.version.digest = "available-contract";
  f.model.version.repositoryVersion = "branch:first";
  await f.service.inspectModelVersion();
  const revision = f.service.snapshot.revision;

  f.model.version.repositoryVersion = "branch:second";
  await f.service.inspectModelVersion();
  equal(f.service.snapshot.revision, revision + 1);
  equal(
    f.service.snapshot.availableExecutionModel!.version.repositoryVersion,
    "branch:second",
  );
  f.model.version.sourceIds.push("fresh-source-evidence");
  await f.service.inspectModelVersion();
  equal(f.service.snapshot.revision, revision + 2);
  deepStrictEqual(f.service.snapshot.availableExecutionModel, f.model);
  deepStrictEqual(f.service.snapshot.executionModel, admitted);
});

Deno.test("model inspection clears a reverted available contract once without advancing admission", async () => {
  const f = await fixture();
  const admitted = f.service.snapshot.executionModel!;
  f.model.version.digest = "available-contract";
  await f.service.inspectModelVersion();
  const revision = f.service.snapshot.revision;

  f.model.version.digest = admitted.version.digest;
  f.model.version.repositoryVersion = "branch:reverted";
  const result = await f.service.inspectModelVersion();
  await f.service.inspectModelVersion();

  equal(f.service.snapshot.revision, revision + 1);
  equal(f.service.snapshot.availableExecutionModel, undefined);
  equal(result.version.repositoryVersion, "branch:reverted");
  deepStrictEqual(f.service.snapshot.executionModel, admitted);
});

Deno.test("a failed model inspection does not poison later inspections", async () => {
  const f = await fixture();
  f.failNextRead();
  const revision = f.service.snapshot.revision;
  const failed = f.service.inspectModelVersion();
  const recovered = f.service.inspectModelVersion();

  await rejects(failed, /Native source unavailable/);
  deepStrictEqual(await recovered, f.model);
  equal(f.service.snapshot.revision, revision);
});

Deno.test("a failed state write preserves the committed snapshot and does not poison later writes", async () => {
  const f = await fixture();
  const before = f.service.snapshot;
  f.model.version.digest = "available-contract";
  f.failNextWrite();

  await rejects(f.service.inspectModelVersion(), /Persistence unavailable/);
  deepStrictEqual(f.service.snapshot, before);
  deepStrictEqual(f.persisted.at(-1), before);
  await f.service.inspectModelVersion();
  equal(f.service.snapshot.revision, before.revision + 1);
  deepStrictEqual(f.service.snapshot.availableExecutionModel, f.model);
  deepStrictEqual(f.persisted.at(-1), f.service.snapshot);
});

Deno.test("inspection and explicit adoption share one state write order without losing the control reservation", async () => {
  const f = await fixture();
  const admitted = f.service.snapshot.executionModel!;
  f.model.version.digest = "available-contract";
  f.model.version.repositoryVersion = "branch:available";
  const paused = f.pauseNextBusyWrite();

  const adoption = f.service.adoptModelVersion({
    expectedDigest: f.model.version.digest,
    expectedVersion: f.model.version.repositoryVersion,
  });
  await paused.entered;
  const inspection = f.service.inspectModelVersion();
  try {
    await rejects(
      f.service.adoptModelVersion({ expectedDigest: f.model.version.digest }),
      /réponse est déjà en cours/,
    );
    await rejects(
      f.service.submit("Concurrent request"),
      /réponse est déjà en cours/,
    );
    equal(
      f.service.snapshot.executionModel!.version.digest,
      admitted.version.digest,
    );
  } finally {
    paused.release();
  }
  await Promise.all([adoption, inspection]);

  const state = f.service.snapshot;
  deepStrictEqual(state.executionModel, f.model);
  equal(state.availableExecutionModel, undefined);
  equal(state.busy, false);
  equal(state.error, undefined);
  equal(
    state.events.filter((event) => event.kind === "model-version-admitted")
      .length,
    1,
  );
  deepStrictEqual(f.persisted.at(-1), state);
  deepStrictEqual(
    f.persisted.map((value) => value.revision),
    Array.from({ length: f.persisted.length }, (_, index) => index),
  );
});

Deno.test("model adoption journals the prior modeled owner's root before replacing the admitted contract", async () => {
  const owner = {
    ...legacyOwnerAuthority("system"),
    ownerSource: "modeled" as const,
    operatorId: "original-owner",
    mandateId: "original-owner-mandate",
    rootGrantId: "original-root-grant",
  };
  const f = await fixture(owner);
  const priorDigest = f.service.snapshot.executionModel!.version.digest;
  f.model.ownerAuthority = { ...owner, operatorId: "replacement-owner" };
  f.model.version.digest = "replacement-contract";
  await f.service.adoptModelVersion({ expectedDigest: "replacement-contract" });
  const state = f.service.snapshot;
  const receipt = state.events.find((event) =>
    event.kind === "model-version-admitted"
  )!.authorityExercise!;
  equal(receipt.operatorId, "original-owner");
  equal(receipt.mandateId, "original-owner-mandate");
  equal(receipt.rootGrantId, "original-root-grant");
  equal(receipt.baseModelDigest, priorDigest);
  equal(receipt.outOfMandate, false);
  equal(state.executionModel!.ownerAuthority!.operatorId, "replacement-owner");
  const recorded = f.persisted.find((value) =>
    value.events.some((event) =>
      event.kind === "model-version-admission-authorized"
    )
  )!;
  equal(recorded.executionModel!.version.digest, priorDigest);
  equal(
    recorded.events.at(-1)!.authorityExercise!.operatorId,
    "original-owner",
  );
});

Deno.test("explicit local model recovery records out of mandate without bypassing exact-version adoption", async () => {
  const f = await fixture();
  f.model.version.digest = "repaired-contract";
  const recoveryReason = "Restaurer la racine d’autorité";
  await rejects(
    f.service.adoptModelVersion({
      expectedDigest: "different-contract",
      recoveryReason,
    }),
    /version du modèle a changé/,
  );
  await f.service.adoptModelVersion({
    expectedDigest: "repaired-contract",
    recoveryReason,
  });
  const receipt = f.service.snapshot.events.find((event) =>
    event.kind === "model-version-admitted"
  )!.authorityExercise!;
  equal(receipt.ownerSource, "implicit-legacy");
  equal(receipt.outOfMandate, true);
  equal(receipt.reason, recoveryReason);
});
