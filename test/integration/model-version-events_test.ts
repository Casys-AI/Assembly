import assert from "node:assert/strict";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { materialize } from "../../src/domain/model/value-objects/artifact.ts";
import { observeModelRevisions } from "../../src/application/model/diagnostics/events.ts";
import { ModelVersionEvents } from "../../src/application/model/revisions/version-events.ts";
import type { ModelVersionEvent } from "../../src/application/model/revisions/ports/out/version-events.port.ts";
import { broadcastSse } from "../../src/infrastructure/http/sse.ts";
import { type LogRecord, reset } from "@logtape/logtape";
import { configureTechnicalLogging } from "../../src/infrastructure/logging.ts";

Deno.test("Git propose, Reject and Accept emit model-version with admitted HEAD; observer failures preserve decisions", async () => {
  const projectDir = await Deno.makeTempDir({ prefix: "ase-version-events-" });
  try {
    const stored = await GitModelRepository.open({
      projectDir,
      compiler: {
        compile: (sources) => materialize([], sources, "events"),
        recipe: () => {
          throw new Error("Fixture compiler reports no build recipe");
        },
      },
    });
    const initial = await stored.initialize({ "a.sysml": "package A;\n" });
    const emitted: ModelVersionEvent[] = [];
    const events = new ModelVersionEvents(stored, (name, value) => {
      assert.equal(name, "model-version");
      emitted.push(value);
    });
    await events.initial();
    const repository = observeModelRevisions(stored, () => events.publish());
    const proposal = await repository.propose({
      baseVersion: initial.version,
      sources: { "a.sysml": "package Proposed;\n" },
      author: "local-owner",
      reason: "Propose",
    });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].head, initial.version);
    assert.equal(emitted[0].sourceDigest, initial.sourceDigest);
    assert.equal(emitted[0].proposals.pending, 1);
    await repository.reject({ id: proposal.id, author: "local-control" });
    assert.equal(emitted.length, 2);
    assert.equal(emitted[1].head, initial.version);
    assert.equal(emitted[1].proposals.pending, 0);
    assert.notEqual(emitted[1].proposals.digest, emitted[0].proposals.digest);
    const second = await repository.propose({
      baseVersion: initial.version,
      sources: { "a.sysml": "package Accepted;\n" },
      author: "local-owner",
      reason: "Accept",
    });
    const accepted = await repository.accept({
      id: second.id,
      expectedVersion: initial.version,
      author: "local-control",
    });
    assert.equal(emitted.length, 4);
    assert.equal(emitted[3].head, accepted.version);
    assert.equal(emitted[3].sourceDigest, accepted.sourceDigest);
    assert.equal(emitted[3].proposals.pending, 0);
    await events.publish(); // A comment causes no repository state change.
    assert.equal(emitted.length, 4);
    // A new SSE connection receives the latest head even after prior broadcasts.
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const reader = stream.getReader();
    const clients = new Set([controller]);
    broadcastSse(clients, "model-version", await events.initial());
    const first = await reader.read();
    const frame = new TextDecoder().decode(first.value);
    assert.match(frame, /^event: model-version\ndata: /);
    assert.equal(
      JSON.parse(frame.split("\n")[1].slice(6)).head,
      accepted.version,
    );
    await reader.cancel();
    const failing = observeModelRevisions(
      stored,
      () => Promise.reject(new Error("observer failed")),
    );
    const third = await failing.propose({
      baseVersion: accepted.version,
      sources: { "a.sysml": "package Third;\n" },
      author: "local-owner",
      reason: "Rejected with observer failure",
    });
    assert.equal(
      (await failing.reject({ id: third.id, author: "local-control" })).status,
      "rejected",
    );
    assert.equal((await stored.proposal(third.id)).status, "rejected");
    assert.equal((await stored.current()).version, accepted.version);
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("history and initial model-version read the journal without waiting for a host writer", async () => {
  const { ModelRevisionsService } = await import(
    "../../src/application/model/revisions/service.ts"
  );
  const projectDir = await Deno.makeTempDir({
    prefix: "ase-unlocked-history-",
  });
  let release!: () => void;
  let writer: Promise<unknown> | undefined;
  try {
    const repository = await GitModelRepository.open({
      projectDir,
      compiler: {
        compile: (sources) => materialize([], sources, "unlocked"),
        recipe: () => {
          throw new Error("Fixture compiler reports no build recipe");
        },
      },
    });
    const initial = await repository.initialize({ "a.sysml": "package A;\n" });
    const proposal = await repository.propose({
      baseVersion: initial.version,
      sources: { "a.sysml": "package Proposed;\n" },
      author: "local-owner",
      reason: "Journal fixture",
    });
    await repository.accept({
      id: proposal.id,
      expectedVersion: initial.version,
      author: "local-control",
    });
    let entered!: () => void;
    const enteredWriter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    writer = repository.updateSystemSources(async (current) => {
      entered();
      await gate;
      return { "a.sysml": current.sources["a.sysml"] + "// host update\n" };
    }, "local-control");
    await enteredWriter;
    repository.listProposals = () => {
      throw new Error("Advisory reads must not recover");
    };
    const service = new ModelRevisionsService(repository);
    const events = new ModelVersionEvents(repository, () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [history, event] = await Promise.race([
        Promise.all([service.history(), events.initial()]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Reads waited for the writer lock")),
            1500,
          );
        }),
      ]);
      assert.equal(history.headVersion, event.head);
      assert.equal(history.commits[0].proposalId, proposal.id);
      assert.equal(event.proposals.pending, 0);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    release?.();
    await writer;
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("advisory journal skips temporary and unreadable dossiers with a diagnostic; recovery stays strict", async () => {
  const projectDir = await Deno.makeTempDir({ prefix: "ase-journal-read-" });
  const warnings: LogRecord[] = [];
  try {
    await configureTechnicalLogging({
      level: "warning",
      sink: (record) => {
        warnings.push(record);
      },
    });
    const repository = await GitModelRepository.open({
      projectDir,
      compiler: {
        compile: (sources) => materialize([], sources, "journal"),
        recipe: () => {
          throw new Error("Fixture compiler reports no build recipe");
        },
      },
    });
    const initial = await repository.initialize({ "a.sysml": "package A;\n" });
    const proposal = await repository.propose({
      baseVersion: initial.version,
      sources: { "a.sysml": "package Proposed;\n" },
      author: "local-owner",
      reason: "Journal fixture",
    });
    const directory = `${repository.stateDir}/proposals`;
    await Deno.writeTextFile(
      `${directory}/${proposal.id}.json.partial.tmp`,
      "{",
    );
    assert.equal((await repository.readProposalJournal()).length, 1);
    await Deno.writeTextFile(`${directory}/${proposal.id}.json`, "{");
    assert.deepEqual(await repository.readProposalJournal(), []);
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0].category, ["composition"]);
    assert.equal(warnings[0].level, "warning");
    assert.equal(
      warnings[0].properties.code,
      "PROPOSAL_JOURNAL_RECORD_SKIPPED",
    );
    const context = warnings[0].properties.context as {
      path: string;
      message: string;
    };
    assert.equal(context.path, `proposals/${proposal.id}.json`);
    assert.equal(typeof context.message, "string");
    assert.ok(context.message.length);
    assert.equal(
      warnings[0].properties.recovery,
      "Repair the proposal journal and reload this advisory view.",
    );
    await assert.rejects(() => repository.listProposals(), {
      code: "INVALID_REPOSITORY",
    });
  } finally {
    await reset();
    await Deno.remove(projectDir, { recursive: true });
  }
});
