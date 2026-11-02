// deno-lint-ignore-file require-await -- Deterministic in-memory ports implement async contracts.
import assert from "node:assert/strict";
import { EvolutionConversationProjection } from "../operators/evolution-projection.ts";
import type { ProposalRecord } from "../../../domain/model/records/revision.ts";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import type { OwnerAuthority } from "../../../domain/governance/authority.ts";
import type {
  EvolutionAct,
  EvolutionAuthorityExercise,
} from "../../../domain/model/evolution/policy.ts";
import type {
  ChatContext,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import { EvolutionService } from "../../model/evolution/service.ts";
import {
  type EvolutionDossier,
  type EvolutionPreparationInput,
  type EvolutionStorePort,
  hasEvolutionBarrier,
} from "../../model/evolution/ports.ts";
import {
  evolutionCommandCapabilities,
  evolutionDossierSummary,
  EvolutionFinalizationJob,
  operatorEvolutionCommands,
  parseEvolutionEdits,
} from "./evolution-commands.ts";

function fixture() {
  const model = artifactModel("operator");
  const rootAuthority: OwnerAuthority = {
    ownerSource: "modeled",
    systemId: model.identity.systemId,
    operatorId: "owner",
    operatorNativeId: "owner-native",
    mandateId: "owner-mandate",
    mandateNativeId: "owner-mandate-native",
    mandateRevision: 1,
    rootAuthorityId: "root",
    rootAuthorityNativeId: "root-native",
    rootGrantId: "grant",
    rootGrantNativeId: "grant-native",
    sourceIds: ["grant-source"],
  };
  const policyBase = {
    holderNativeId: "operator",
    mandateNativeId: "mandate-native",
    mandateId: model.mandate.id,
    mandateRevision: model.configuration.builder.mandateRevision,
    revision: 1,
    sourceIds: ["policy-source"],
    rootAuthority,
  };
  model.evolutionPolicy = {
    ...policyBase,
    id: "evolution",
    elementId: "evolution-native",
    grants: (["prepare", "accept", "adopt"] as EvolutionAct[]).map((act) => ({
      act,
      targetNativeId: "operator",
      category: "instructions",
      bounds: { maxCharacters: 2000 },
    })),
  };
  model.modelEditPolicy = {
    ...policyBase,
    id: "edits",
    elementId: "edits-native",
    operations: ["set-value"],
    grants: [{ file: "operator.sysml", qualifiedRoots: ["System::operator"] }],
  };
  const state: SystemRuntimeState = {
    id: "runtime",
    revision: 0,
    catalogRevision: 0,
    provider: "fixture",
    phase: "active",
    busy: true,
    executionModel: model,
    messages: [],
    events: [],
    candidates: [],
    designer: { scopeId: "designer-scope" },
    caseInvocation: { kind: "designer", scopeId: "designer-scope" },
  };
  const records = new Map<string, EvolutionDossier>();
  const store: EvolutionStorePort = {
    async create(d) {
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
    async listRecent(_repo, limit) {
      return [...records.values()].slice(0, limit).map((d) =>
        structuredClone(d)
      );
    },
    async compareAndSwap(id, revision, next) {
      assert.equal(records.get(id)?.revision, revision);
      records.set(id, structuredClone(next));
      return structuredClone(next);
    },
    async targetOwner() {
      return [...records.values()].find((d) => hasEvolutionBarrier(d.status))
        ?.id ?? null;
    },
  };
  let prepared: EvolutionPreparationInput | undefined;
  let publications = 0, adoptions = 0, arms = 0;
  const service = new EvolutionService({
    store,
    now: () => "2026-10-27T00:00:00Z",
    authority: {
      async authorize(
        act,
        actorId,
        proposal,
      ): Promise<EvolutionAuthorityExercise> {
        return {
          act,
          operatorNativeId: actorId,
          systemQualifiedName: "System",
          authorityDigest: "prior-authority",
          policyId: "evolution",
          policyRevision: 1,
          mandateNativeId: "mandate-native",
          mandateId: model.mandate.id,
          mandateRevision: 1,
          targets: proposal.targets.map((t) => t.operatorId),
          categories: proposal.categories,
          proposalDigest: proposal.digest,
        };
      },
      async revalidate() {},
    },
    repository: {
      async prepare(input) {
        prepared = structuredClone(input);
        return {
          id: "proposal",
          version: "commit:candidate",
          baseVersion: input.expectedVersion,
          sourceDigest: "candidate-sources",
          recipeDigest: "recipe",
          digest: "exact-proposal",
          categories: ["instructions"],
          targets: [{
            operatorId: "operator",
            previousDigest: model.version.digest,
            candidateDigest: "next-digest",
          }],
        };
      },
      async revalidate() {},
      async findPublication() {
        return null;
      },
      async publish(d) {
        publications++;
        return {
          commandId: d.proposal.id,
          commandDigest: "command",
          version: "commit:published",
          sourceDigest: d.proposal.sourceDigest,
          proposalDigest: d.proposal.digest,
        };
      },
    },
    targets: {
      async captureOrigin(input) {
        assert.equal(input.origin.designerScopeId, "designer-scope");
        return input.origin;
      },
      async withArmingTargets(_d, save) {
        return await save();
      },
      async withReservedTargets(_d, operation) {
        return await operation({
          safe: !state.busy,
          blockers: state.busy
            ? [{ code: "BUSY", detail: "Contribution is still running" }]
            : [],
        });
      },
      async inspectAdoption() {
        return null;
      },
      async adoptExact(d, target, publication) {
        adoptions++;
        return {
          ...target,
          version: publication.version,
          proposalDigest: d.proposal.digest,
          effectiveAt: "2026-10-27T00:00:01Z",
        };
      },
    },
  });
  const commands = operatorEvolutionCommands({
    repositoryId: "repository",
    store,
    service,
    snapshot: () => structuredClone(state),
    armed: () => {
      arms++;
    },
  });
  const source: Pick<ChatContext, "modelContext" | "modelSources"> = {
    modelContext: {
      version: "commit:base",
      sourceDigest: "base-sources",
      files: [],
    } as unknown as ChatContext["modelContext"],
    modelSources: { version: "commit:base", sources: {} },
  };
  return {
    model,
    state,
    records,
    store,
    commands,
    service,
    source,
    prepared: () => prepared,
    counts: () => ({ publications, adoptions, arms }),
  };
}
const prepare = {
  kind: "prepare_operator_evolution",
  text: "Prepare",
  reason: "Clarify instructions",
  editJson: JSON.stringify({
    edits: [{
      kind: "set-value",
      elementId: "instruction",
      expression: '"Revised"',
    }],
  }),
} as const;

Deno.test("operator evolution parser refuses authority, raw sources and unknown targeted operations", () => {
  assert.equal(parseEvolutionEdits(prepare.editJson)[0].kind, "set-value");
  for (
    const bad of [
      "{}",
      "null",
      "[]",
      JSON.stringify({ edits: [], actorId: "owner" }),
      JSON.stringify({ sources: { "x.sysml": "raw" } }),
      JSON.stringify({
        edits: [{ kind: "replace-source", elementId: "x", text: "raw" }],
      }),
      JSON.stringify({
        edits: [{ kind: "remove", elementId: "x", origin: "forged" }],
      }),
      JSON.stringify({ edits: [{ kind: "constructor", elementId: "x" }] }),
    ]
  ) {
    assert.throws(() => parseEvolutionEdits(bad), {
      code: "EVOLUTION_EDIT_INVALID",
    });
  }
});

Deno.test("operator type edits round-trip only the closed bounded native-name contract", () => {
  for (
    const typeName of [
      "Flows::Private",
      "::Flows::'révision-台灣'",
      "T".repeat(4096),
      "'" + "😀".repeat(4094) + "'",
    ]
  ) {
    const edits = [{ kind: "set-type", elementId: "conversation", typeName }];
    assert.deepEqual(parseEvolutionEdits(JSON.stringify({ edits })), edits);
  }
  for (
    const edit of [
      ...[
        "",
        " ",
        "T".repeat(4097),
        "A::",
        "A::'bad\\q'",
        "T\n",
        "T; attribute injected = 1;",
        "T { attribute injected = 1; }",
      ].map(
        (typeName) => ({
          kind: "set-type",
          elementId: "conversation",
          typeName,
        }),
      ),
      {
        kind: "set-type",
        elementId: "x".repeat(513),
        typeName: "Flows::Private",
      },
      { kind: "set-type", elementId: "conversation", type: "Flows::Private" },
      {
        kind: "set-type",
        elementId: "conversation",
        typeName: "Flows::Private",
        text: "raw",
      },
      { kind: "replace-member", elementId: "conversation", text: "raw" },
    ]
  ) {
    assert.throws(
      () => parseEvolutionEdits(JSON.stringify({ edits: [edit] })),
      {
        code: "EVOLUTION_EDIT_INVALID",
      },
    );
  }
});

Deno.test("type preparation requires its explicit current operation grant", async () => {
  const f = fixture();
  const edits = [{
    kind: "set-type",
    elementId: "conversation",
    typeName: "Flows::Private",
  }];
  const command = { ...prepare, editJson: JSON.stringify({ edits }) };
  f.model.modelEditPolicy!.operations = ["remove", "insert-member"];
  await assert.rejects(() => f.commands.execute(command, f.model, f.source), {
    code: "EVOLUTION_EDIT_DENIED",
  });
  assert.equal(f.prepared(), undefined);
  f.model.modelEditPolicy!.operations = ["set-type"];
  const dossier = await f.commands.execute(command, f.model, f.source);
  assert.equal(dossier.status, "prepared");
  assert.deepEqual(f.prepared()!.edit!.edits, edits);
  assert.equal(f.counts().publications, 0);
  assert.equal(f.counts().adoptions, 0);
});

Deno.test("operator commands preserve separate preparation, acceptance and asynchronous adoption receipts", async () => {
  const f = fixture();
  const prepared = await f.commands.execute(prepare, f.model, f.source);
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.acceptance, undefined);
  assert.equal(f.prepared()!.actorId, "operator");
  assert.equal(f.prepared()!.finalizerActorId, "operator");
  assert.deepEqual(f.prepared()!.origin, {
    operatorId: "operator",
    designerScopeId: "designer-scope",
  });
  assert.equal(f.prepared()!.edit!.baseVersion, "commit:base");
  assert.equal(f.prepared()!.edit!.sourceDigest, "base-sources");
  const accepted = await f.commands.execute(
    {
      kind: "decide_operator_evolution",
      text: "Accept",
      dossierId: prepared.id,
      decision: "accept",
    },
    f.model,
    {},
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.publishedVersion, undefined);
  const armed = await f.commands.execute(
    { kind: "adopt_operator_evolution", text: "Adopt", dossierId: prepared.id },
    f.model,
    {},
  );
  assert.equal(armed.status, "armed");
  assert.deepEqual(f.counts(), { publications: 0, adoptions: 0, arms: 1 });
  assert.equal(
    (await f.service.finalize(prepared.id)).blockers[0].code,
    "BUSY",
  );
  f.state.busy = false;
  const job = new EvolutionFinalizationJob(async () => {
    await f.service.finalize(prepared.id);
  }, (error) => {
    throw error;
  });
  job.schedule();
  job.schedule();
  await job.idle();
  assert.equal((await f.store.get(prepared.id))!.status, "adopted");
  assert.deepEqual(f.counts(), { publications: 1, adoptions: 1, arms: 1 });
  const context = await f.commands.context(f.model);
  assert.equal(context!.dossiers[0].status, "adopted");
  assert.equal(context!.dossiers[0].publishedVersion, "commit:published");
  assert.deepEqual(context!.dossiers[0].adoptedOperatorIds, ["operator"]);
});

Deno.test("prior admitted grants and separate edit operations control command availability and execution", async () => {
  const f = fixture();
  const baseline = structuredClone(f.model);
  delete baseline.evolutionPolicy;
  assert.deepEqual(evolutionCommandCapabilities(baseline), {
    prepare: false,
    accept: false,
    adopt: false,
  });
  assert.equal(await f.commands.context(baseline), undefined);
  f.state.executionModel = baseline;
  await assert.rejects(() => f.commands.execute(prepare, baseline, f.source), {
    code: "EVOLUTION_AUTHORITY_DENIED",
  });
  f.state.executionModel = f.model;
  f.model.modelEditPolicy!.operations = ["rename"];
  await assert.rejects(() => f.commands.execute(prepare, f.model, f.source), {
    code: "EVOLUTION_EDIT_DENIED",
  });
  assert.equal(f.prepared(), undefined);
  f.model.modelEditPolicy!.operations = ["set-value"];
  await assert.rejects(() => f.commands.execute(prepare, f.model, {}), {
    code: "EVOLUTION_SOURCE_REQUIRED",
  });
  const unadopted = structuredClone(f.model);
  unadopted.version.digest = "future";
  await assert.rejects(() => f.commands.execute(prepare, unadopted, f.source), {
    code: "EVOLUTION_ADMISSION_CHANGED",
  });
});

Deno.test("dossier context omits uncovered peers and source payloads and bounds visible metadata", async () => {
  const f = fixture();
  const prepared = await f.commands.execute(prepare, f.model, f.source);
  const own = f.records.get(prepared.id)!;
  const foreign = structuredClone(own);
  foreign.id = "private-foreign";
  foreign.origin.operatorId = "foreign";
  foreign.proposal.targets[0].operatorId = "uncovered";
  f.records.set(foreign.id, foreign);
  for (let i = 0; i < 20; i++) {
    f.records.set(`own-${i}`, { ...structuredClone(own), id: `own-${i}` });
  }
  own.blockers = [{ code: "BLOCKED", detail: "x".repeat(1000) }];
  const view = await f.commands.context(f.model);
  assert.equal(view!.dossiers.length, 16);
  assert.equal(view!.truncated, true);
  assert.equal(view!.dossiers.some((d) => d.id === foreign.id), false);
  assert.equal(evolutionDossierSummary(own).blockers[0].detail.length, 500);
  assert.equal("origin" in view!.dossiers[0], false);
  assert.equal("sources" in view!.dossiers[0], false);
});

Deno.test("operator cancellation never rolls back a published revision", async () => {
  const f = fixture();
  const prepared = await f.commands.execute(prepare, f.model, f.source);
  await f.commands.execute(
    {
      kind: "decide_operator_evolution",
      text: "Accept",
      dossierId: prepared.id,
      decision: "accept",
    },
    f.model,
    {},
  );
  await f.commands.execute(
    { kind: "adopt_operator_evolution", text: "Adopt", dossierId: prepared.id },
    f.model,
    {},
  );
  f.state.busy = false;
  await f.service.finalize(prepared.id);
  await assert.rejects(
    () =>
      f.commands.execute(
        {
          kind: "decide_operator_evolution",
          text: "Cancel",
          dossierId: prepared.id,
          decision: "cancel",
        },
        f.model,
        {},
      ),
    { code: "EVOLUTION_STATE" },
  );
  assert.deepEqual(f.counts(), { publications: 1, adoptions: 1, arms: 1 });
});

Deno.test("event-driven finalizer coalesces triggers, runs a newly requested pass and drains on close", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  const job = new EvolutionFinalizationJob(async () => {
    attempts++;
    if (attempts === 1) await blocked;
  }, (error) => {
    throw error;
  });
  job.schedule();
  job.schedule();
  await Promise.resolve();
  assert.equal(attempts, 1);
  job.schedule();
  release();
  await job.idle();
  assert.equal(attempts, 2);
});

Deno.test("native conversation routes an adoption through submit_proposal and finishes its own contribution", async () => {
  const { SystemRuntime } = await import(
    "../../../../test/support/system-runtime.ts"
  );
  const { unexpectedModelAuthoring } = await import(
    "../../../../test/support/model-authoring.ts"
  );
  const f = fixture();
  const prepared = await f.commands.execute(prepare, f.model, f.source);
  await f.commands.execute(
    {
      kind: "decide_operator_evolution",
      text: "Accept",
      dossierId: prepared.id,
      decision: "accept",
    },
    f.model,
    {},
  );
  const projection = new EvolutionConversationProjection({
    repositoryId: "repository",
    store: f.store,
    repository: {
      proposal: async () => {
        const d = (await f.store.get(prepared.id))!;
        return {
          id: d.proposal.id,
          branch: "proposal",
          author: "agent:operator",
          reason: "Clarify instructions",
          baseVersion: d.proposal.baseVersion,
          proposalVersion: d.proposal.version,
          createdAt: d.createdAt,
          status: "proposed",
          validation: "validated",
          sourceDigest: d.proposal.sourceDigest,
          diff: [],
          authorization: {
            kind: "operator-evolution",
            operatorNativeId: "operator",
            exercise: d.preparation,
            systemQualifiedName: "System",
            recipeDigest: d.proposal.recipeDigest,
            editAuthorization: {
              kind: "operator",
              systemQualifiedName: "System",
              operatorQualifiedName: "System::operator",
              operatorNativeId: "operator",
              mandateId: f.model.mandate.id,
              mandateRevision: f.model.configuration.builder.mandateRevision,
              policyId: "edits",
              policyRevision: 1,
              policyDigest: "prior-edits",
              operations: ["set-value"],
            },
          },
        } as ProposalRecord;
      },
      header: async (version) => ({
        version,
        sources: {},
        sourceDigest: version === "commit:base"
          ? "base-sources"
          : "candidate-sources",
      }),
    },
  });
  let saved: SystemRuntimeState | null = null;
  let calls = 0, armed = 0;
  const runtime = new SystemRuntime({
    model: {
      ...unexpectedModelAuthoring,
      initialize: async () => f.model.identity,
      readExecutableModel: async () => structuredClone(f.model),
      activateCandidate: async () => {
        throw new Error("Unexpected activation");
      },
      applyApprovedChange: async () => {
        throw new Error("Unexpected source change");
      },
      graph: async () => ({}),
    },
    store: {
      load: async () => structuredClone(saved),
      save: async (state, expected) => {
        assert.equal(saved?.revision ?? null, expected);
        saved = structuredClone(state);
      },
      close: async () => {},
    },
    agents: {
      label: "test",
      decide: async (context) => {
        calls++;
        assert.ok(context.operatorEvolution);
        return calls === 1
          ? {
            kind: "adopt_operator_evolution",
            text: "Arm the accepted revision",
            dossierId: prepared.id,
          }
          : {
            kind: "reply",
            text: "The exact revision is armed; this contribution is complete.",
          };
      },
      review: async () => {
        throw new Error("Unexpected review");
      },
    },
    runner: {
      test: async () => {
        throw new Error("Unexpected test");
      },
      run: async () => {
        throw new Error("Unexpected tool");
      },
    },
  });
  await runtime.initialize(f.model);
  runtime.configureOperatorEvolution(
    operatorEvolutionCommands({
      repositoryId: "repository",
      store: f.store,
      service: f.service,
      snapshot: () => runtime.snapshot,
      armed: () => {
        armed++;
      },
      receipt: (d) => projection.record(d, new Map([["operator", "Operator"]])),
    }),
  );
  await runtime.submit("Adopt the accepted instruction revision.");
  await runtime.idle();
  assert.equal(runtime.snapshot.error, undefined);
  assert.equal(calls, 2);
  assert.equal(armed, 1);
  assert.equal((await f.store.get(prepared.id))!.status, "armed");
  assert.equal(f.counts().publications, 0);
  const frozen = runtime.snapshot.messages.find((m) =>
    m.observation?.kind === "operator-evolution"
  )!;
  assert.ok(frozen);
  const receipt = frozen.observation!
    .value as import("../../../domain/work/records/operator-evolution.ts").EvolutionConversationRecord;
  assert.equal(receipt.status, "armed");
  assert.equal(receipt.proposalId, "proposal");
  assert.equal(receipt.origin.designerScopeId, "designer-scope");
  assert.equal(frozen.designerScopeId, runtime.snapshot.designer!.scopeId);
  // A separate decision conversation never changes the dossier's captured origin.
  assert.deepEqual(receipt.base, {
    version: "commit:base",
    sourceDigest: "base-sources",
  });
  f.records.get(prepared.id)!.status = "adopted";
  assert.equal(
    (runtime.snapshot.messages.find((m) => m.id === frozen.id)!.observation!
      .value as typeof receipt).status,
    "armed",
  );
  assert.ok(
    runtime.snapshot.messages.some((m) =>
      m.role === "tool" && m.text.includes('"status":"armed"')
    ),
  );
});

Deno.test("event-driven finalizer retains triggers across asynchronous drain cleanup", async () => {
  for (let microtasks = 0; microtasks < 7; microtasks++) {
    let attempts = 0;
    const job = new EvolutionFinalizationJob(async () => {
      attempts++;
    }, (error) => {
      throw error;
    });
    job.schedule();
    while (!attempts) await Promise.resolve();
    // Probe each boundary between callback resolution, drain completion and
    // cleanup; a real state event at any boundary must produce a new pass.
    for (let i = 0; i < microtasks; i++) await Promise.resolve();
    job.schedule();
    await job.idle();
    assert.equal(attempts, 2, `late trigger at microtask ${microtasks}`);
  }
});

Deno.test("an unavailable optional UI receipt cannot turn a committed command into a second act", async () => {
  const f = fixture();
  const commands = operatorEvolutionCommands({
    repositoryId: "repository",
    store: f.store,
    service: f.service,
    snapshot: () => structuredClone(f.state),
    armed: () => {},
    receipt: () =>
      Promise.reject(new Error("Staged source metadata unavailable")),
  });
  const result = await commands.execute(prepare, f.model, f.source);
  assert.equal(result.status, "prepared");
  assert.equal(result.conversationReceiptUnavailable, true);
  assert.equal(result.conversationRecord, undefined);
  assert.equal(f.records.size, 1);
  assert.equal((await f.store.get(result.id))!.status, "prepared");
});

Deno.test("reference retargeting accepts only bounded exact fingerprints", () => {
  const site = {
    unit: "model.sysml",
    line: 1,
    col: 2,
    endLine: 1,
    endCol: 5,
    kind: "reference",
    ownerId: "owner",
    chainRootId: null,
    preimage: "abc",
  };
  const edit = { kind: "retarget-reference", fromId: "old", toId: "new", site };
  assert.deepEqual(parseEvolutionEdits(JSON.stringify({ edits: [edit] })), [
    edit,
  ]);
  for (
    const bad of [
      { ...edit, extra: true },
      { ...edit, fromId: "x".repeat(129) },
      { ...edit, site: { ...site, extra: true } },
      { ...edit, site: { ...site, endCol: 2 } },
      { ...edit, site: { ...site, preimage: "😀".repeat(16385) } },
    ]
  ) {
    assert.throws(() => parseEvolutionEdits(JSON.stringify({ edits: [bad] })), {
      code: "EVOLUTION_EDIT_INVALID",
    });
  }
});

Deno.test("reference preparation requires its own operation grant", async () => {
  const f = fixture();
  const edits = [{
    kind: "retarget-reference",
    fromId: "old",
    toId: "new",
    site: {
      unit: "model.sysml",
      line: 1,
      col: 1,
      endLine: 1,
      endCol: 4,
      kind: "reference",
      ownerId: "owner",
      chainRootId: null,
      preimage: "old",
    },
  }];
  const command = { ...prepare, editJson: JSON.stringify({ edits }) };
  f.model.modelEditPolicy!.operations = ["set-type", "remove", "insert-member"];
  await assert.rejects(() => f.commands.execute(command, f.model, f.source), {
    code: "EVOLUTION_EDIT_DENIED",
  });
  assert.equal(f.prepared(), undefined);
  f.model.modelEditPolicy!.operations = ["retarget-reference"];
  const dossier = await f.commands.execute(command, f.model, f.source);
  assert.equal(dossier.status, "prepared");
  assert.deepEqual(f.prepared()!.edit!.edits, edits);
  assert.equal(f.counts().publications, 0);
  assert.equal(f.counts().adoptions, 0);
});
