import {
  emptyChangePreview,
  unexpectedModelAuthoring,
} from "../../../test/support/model-authoring.ts";
import {
  caseExecutionContext,
  selectDesignerInvocation,
  selectHumanRequestCase,
} from "../work/cases/runtime.ts";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { executableFixture } from "../../../test/support/execution-fixture.ts";
import { SystemGovernance } from "../../domain/governance/policies/governance.ts";
import { legacyOwnerAuthority } from "../../domain/governance/authority.ts";
import { mainExecutionSpace } from "../../domain/governance/operator-authority.ts";
import {
  assertChangeAuthorityReceipt,
  ChangeApprovabilityError,
} from "../../domain/governance/policies/change-approvability.ts";
import { mainCreationScope } from "../../domain/governance/policies/operator-creation-policy.ts";
import {
  type ApprovedChangePublication,
  changePublication,
  ChangePublicationError,
} from "../../domain/model/publication/change.ts";
import type { ChatDecision } from "../../domain/work/dialogue.ts";
import {
  decideChange,
  type MandateChangeHost,
  proposeChange,
  reconcileChangePublications,
  resumeChangeDecisions,
} from "./mandate-change-decisions.ts";
import {
  invocationKey,
  type OperatorWorkCompletion,
} from "../work/operators/journal.ts";
import { type OperatorWorkReceipt } from "../../domain/work/execution/case-context.ts";

const request: Extract<ChatDecision, { kind: "propose_mandate_change" }> = {
  kind: "propose_mandate_change",
  text: "Request one host.",
  reason: "Exact network extension",
  requestedRights: { addNetworkHosts: ["recovery.example"] },
};

async function fixture(unrelatedBeforePreview = false) {
  let native = executableFixture({
    projectId: "unit",
    editingContextId: "unit",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "builder",
  });
  native.version.repositoryVersion = "snapshot-1";
  const faults = {
    before: undefined as Error | undefined,
    after: false,
    lookup: false,
    save: false,
    saveReturn: false,
  };
  let publications = 0;
  let writes = 0;
  const published = new Map<string, ApprovedChangePublication>();
  const host: MandateChangeHost = {
    state: {
      id: "session",
      designer: { scopeId: "session:designer" },
      caseInvocation: { kind: "designer", scopeId: "session:designer" },
      revision: 0,
      catalogRevision: 0,
      messages: [],
      candidates: [],
      events: [],
      busy: false,
      phase: "Ready",
      provider: "fixture",
      model: native.identity,
      executionModel: structuredClone(native),
      configuration: structuredClone(native.configuration),
    },
    ports: {
      model: {
        ...unexpectedModelAuthoring,
        previewApprovedChange: emptyChangePreview,
        applyApprovedChange(_identity, change, _digest, receipt) {
          equal(
            host.state.configuration!.changes.find((entry) =>
              entry.id === change.id
            )!.status,
            "pending",
          );
          equal(
            host.state.configuration!.changes.find((entry) =>
              entry.id === change.id
            )!.authorityExercise,
            undefined,
          );
          if (faults.before) {
            return Promise.reject(
              faults.before,
            );
          }
          receipt.edits = [{
            owner: "system",
            name: "networkHosts",
            value: '["recovery.example"]',
          }];
          publications++;
          const configuration = structuredClone(native.configuration);
          configuration.revision++;
          configuration.network = { allowedHosts: ["recovery.example"] };
          native = executableFixture(native.identity, configuration);
          native.version.repositoryVersion = "snapshot-2";
          published.set(change.id, {
            model: structuredClone(native),
            receipt: structuredClone(receipt),
          });
          return faults.after
            ? Promise.reject(new Error("after commit"))
            : Promise.resolve(structuredClone(native));
        },
        readExecutableModel() {
          return Promise.resolve(structuredClone(native));
        },
        findApprovedChange(_identity, id) {
          if (faults.lookup && published.has(id)) {
            return Promise.reject(
              new Error("lookup unavailable"),
            );
          }
          return Promise.resolve(structuredClone(published.get(id) ?? null));
        },
      },
    },
    update(change) {
      const next = structuredClone(host.state);
      change(next);
      if (faults.save) return Promise.reject(new Error("before state save"));
      Object.assign(host.state, next);
      writes++;
      if (faults.saveReturn) {
        return Promise.reject(new Error("after state save"));
      }
      return Promise.resolve();
    },
    feedback() {
      return Promise.resolve();
    },
    control(action) {
      return action();
    },
    currentModel() {
      return Promise.resolve(native);
    },
    adopt(model, changes, event, onAdopt) {
      return host.update((s) => {
        s.executionModel = structuredClone(model);
        s.model = structuredClone(model.identity);
        s.configuration = {
          ...structuredClone(model.configuration),
          changes: structuredClone(changes!),
        };
        if (event) s.events.push(event);
        onAdopt?.(s);
      });
    },
    runTurn() {
      return Promise.resolve();
    },
  };
  if (unrelatedBeforePreview) {
    // The repository advances in another scope, while the actual running pin
    // remains snapshot-1 and this target's contract stays semantically equal.
    native.version.repositoryVersion = "unrelated-before-preview";
    host.ports.model.previewApprovedChange = async (...args) => {
      const preview = await emptyChangePreview(...args);
      return {
        ...preview,
        base: {
          ...preview.base,
          repositoryVersion: native.version.repositoryVersion!,
        },
      };
    };
  }
  await proposeChange.call(host, request);
  const proposed = structuredClone(host.state.configuration!.changes[0]);
  const input = {
    changeId: proposed.id,
    expectedRevision: proposed.baseRevision,
    verdict: "approve" as const,
  };
  return {
    host,
    faults,
    proposed,
    input,
    published,
    publications: () => publications,
    writes: () => writes,
  };
}

Deno.test("recovery uses the actual adopted pin once even when the approved preview source is newer", async () => {
  const f = await fixture(true);
  f.faults.save = true;
  await rejects(() => decideChange.call(f.host, f.input));
  equal(f.publications(), 1);
  const receipt = f.published.get(f.proposed.id)!.receipt!;
  equal(receipt.adoptedPin.repositoryVersion, "snapshot-1");
  equal(
    receipt.approvedSourceBase!.repositoryVersion,
    "unrelated-before-preview",
  );
  equal(f.host.state.executionModel!.version.repositoryVersion, "snapshot-1");
  f.faults.save = false;
  await decideChange.call(f.host, f.input);
  equal(f.host.state.executionModel!.version.repositoryVersion, "snapshot-2");
  const completed = structuredClone(f.host.state);
  await decideChange.call(f.host, f.input);
  equal(f.publications(), 1);
  deepStrictEqual(f.host.state, completed);
});

Deno.test("a proposal records its required preview and a preview refusal leaves state unchanged", async () => {
  const f = await fixture();
  deepStrictEqual(
    f.proposed.diff,
    await emptyChangePreview(
      f.host.state.model!,
      f.proposed,
      f.host.state.executionModel!.version.digest,
    ),
  );
  await decideChange.call(f.host, { ...f.input, verdict: "refuse" });
  const before = structuredClone(f.host.state);
  const writes = f.writes();
  f.host.ports.model.previewApprovedChange = () => {
    throw Object.assign(new Error("Explicit preview refusal"), {
      code: "TEST_PREVIEW_REFUSED",
    });
  };
  await rejects(() => proposeChange.call(f.host, request), {
    code: "TEST_PREVIEW_REFUSED",
  });
  deepStrictEqual(f.host.state, before);
  equal(f.writes(), writes);
});

Deno.test("every pre-publication error leaves a pending proposal refusable and allows a new proposal", async () => {
  const f = await fixture();
  f.faults.before = new ChangePublicationError("PUBLICATION_NOT_APPLICABLE", {
    changeId: f.proposed.id,
  }, "before publication");
  await rejects(() => decideChange.call(f.host, f.input), (error: unknown) => {
    ok(error instanceof ChangePublicationError);
    equal(error.code, "PUBLICATION_NOT_APPLICABLE");
    equal(error.recovery, "refuse");
    equal(error.context.changeId, f.proposed.id);
    return true;
  });
  deepStrictEqual(f.host.state.configuration!.changes, [f.proposed]);
  equal(f.publications(), 0);
  await decideChange.call(f.host, { ...f.input, verdict: "refuse" });
  equal(f.host.state.configuration!.changes[0].status, "refused");
  await proposeChange.call(f.host, request);
  equal(f.host.state.configuration!.changes[1].status, "pending");
});

Deno.test("decideChange on a superseded proposal surfaces the named error for both verdicts", async () => {
  for (const verdict of ["approve", "refuse"] as const) {
    const f = await fixture();
    f.host.state.configuration!.changes[0].status = "superseded";
    await rejects(() => decideChange.call(f.host, { ...f.input, verdict }), (
      error: unknown,
    ) => {
      ok(error instanceof ChangeApprovabilityError);
      equal(error.reason, "SUPERSEDED_PROPOSAL");
      equal(error.context.changeId, f.proposed.id);
      return true;
    });
    equal(f.host.state.configuration!.changes[0].status, "superseded");
    equal(f.publications(), 0);
  }
});

Deno.test("approval journals the work completion receipt atomically with the approved status", async () => {
  const f = await fixture();
  const change = f.host.state.configuration!.changes[0];
  const receipt: OperatorWorkReceipt = {
    callerId: "main",
    correlationId: "corr-1",
    invocationId: "inv-1",
    behaviorId: "worker-inbox",
    targetNativeId: "worker",
    modelVersion: { digest: "main-pin", repositoryVersion: "main-source" },
    fingerprint: "fp-1",
    priorCandidateIds: [],
    designerContext: { scopeId: "session:designer", ownerId: "main" },
  };
  f.host.state.messages.push({
    id: "input-1",
    role: "user",
    text: "Do the work.",
    at: "2026-10-24T00:00:00.000Z",
    designerScopeId: "session:designer",
    work: structuredClone(receipt),
  });
  f.host.state.changeWorkContinuations = {
    [change.id]: {
      inputMessageId: "input-1",
      invocationKey: invocationKey({
        kind: "delegated-designer",
        work: { ...receipt, designerContext: receipt.designerContext! },
      }),
    },
  };
  const prior: OperatorWorkCompletion = {
    id: "prior-waiting",
    at: "2026-10-24T00:00:00.000Z",
    kind: "operator-work-waiting",
    label: "Contribution en attente",
    work: {
      callerId: "main",
      correlationId: "corr-1",
      fingerprint: "fp-1",
      status: "waiting",
      messageCount: 1,
      messageRanges: [{ start: 0, end: 1 }],
      candidateIds: [],
      revision: 0,
      modelVersion: { digest: "main-pin", repositoryVersion: "main-source" },
    },
  };
  f.host.state.events.push(prior);
  f.host.workCompletion = (
    work,
    bounds,
  ): Promise<OperatorWorkCompletion> =>
    Promise.resolve({
      id: "completion-1",
      at: "2026-10-24T00:00:00.000Z",
      kind: "operator-work-completed",
      label: "Résultat du travail enregistré",
      work: {
        callerId: work.callerId,
        correlationId: work.correlationId,
        fingerprint: work.fingerprint,
        status: "completed",
        messageCount: f.host.state.messages.length,
        messageRanges: structuredClone(bounds.messageRanges),
        candidateIds: [...bounds.candidateIds],
        revision: f.host.state.revision + 1,
        modelVersion: {
          digest: f.host.state.executionModel!.version.digest,
          repositoryVersion: f.host.state.executionModel!.version
            .repositoryVersion!,
        },
      },
    });
  // The completed work wakes its caller once, after the receipt is journalled.
  const notified: Array<{ completion: string; recorded: boolean }> = [];
  f.host.notifyWorkCompletion = (work, completion) => {
    equal(work.correlationId, "corr-1");
    notified.push({
      completion: completion.id,
      recorded: f.host.state.events.some((event) => event.id === completion.id),
    });
    return Promise.resolve();
  };
  const seen: Array<{ status: string | undefined; completions: number }> = [];
  const inner = f.host.update;
  f.host.update = async (mutate) => {
    await inner(mutate);
    seen.push({
      status: f.host.state.configuration!.changes[0].status,
      completions: f.host.state.events.filter((event) =>
        event.kind === "operator-work-completed"
      ).length,
    });
  };
  await decideChange.call(f.host, f.input);
  const firstApproved = seen.findIndex((save) => save.status === "approved");
  ok(firstApproved >= 0);
  // No save may record the approval without its completion receipt: the
  // completion-save loss boundary no longer exists.
  for (const save of seen.slice(0, firstApproved)) {
    equal(save.status, "pending");
  }
  equal(seen[firstApproved].completions, 1);
  equal(
    f.host.state.configuration!.changes[0].status,
    "approved",
  );
  equal(
    f.host.state.events.filter((event) =>
      event.kind === "operator-work-completed"
    ).length,
    1,
  );
  equal(f.publications(), 1);
  deepStrictEqual(notified, [{ completion: "completion-1", recorded: true }]);
});

for (const boundary of ["after", "save", "saveReturn", "lookup"] as const) {
  Deno.test(`publication recovery at ${boundary} is idempotent with one commit and idempotent dialogue delivery`, async () => {
    const f = await fixture();
    f.faults[boundary] = true;
    if (boundary === "lookup") f.faults.after = true;
    const before = f.writes();
    if (boundary === "after") await decideChange.call(f.host, f.input);
    else {await rejects(() =>
        decideChange.call(f.host, f.input), /state save|lookup/);}
    equal(f.publications(), 1);
    const receipt = structuredClone(f.published.get(f.proposed.id)!.receipt!);
    if (boundary === "save" || boundary === "lookup") {
      deepStrictEqual(f.host.state.configuration!.changes, [f.proposed]);
    }
    Object.assign(f.faults, {
      before: undefined,
      after: false,
      save: false,
      saveReturn: false,
      lookup: false,
    });
    await decideChange.call(f.host, f.input);
    equal(f.writes() - before, 3);
    equal(f.host.state.configuration!.changes[0].status, "approved");
    equal(f.host.state.configuration!.changes[0].publication, undefined);
    deepStrictEqual(
      f.host.state.configuration!.changes[0].authorityExercise,
      receipt.authorityExercise,
    );
    equal(f.host.state.configuration!.changes[0].decidedAt, receipt.decidedAt);
    equal(f.host.state.executionModel!.version.repositoryVersion, "snapshot-2");
    const completed = structuredClone(f.host.state);
    await decideChange.call(f.host, f.input);
    deepStrictEqual(f.host.state, completed);
    equal(f.publications(), 1);
    await rejects(
      () => decideChange.call(f.host, { ...f.input, verdict: "refuse" }),
      (error: unknown) => {
        ok(error instanceof ChangePublicationError);
        equal(error.code, "PUBLICATION_ALREADY_APPLIED");
        equal(error.context.changeId, f.proposed.id);
        deepStrictEqual(error.recovery, { action: "reload" });
        return true;
      },
    );
  });
}

Deno.test("refusal after a lost return reconciles publication before rejecting the verdict", async () => {
  const f = await fixture();
  f.faults.save = true;
  await rejects(() => decideChange.call(f.host, f.input));
  f.faults.save = false;
  await rejects(
    () => decideChange.call(f.host, { ...f.input, verdict: "refuse" }),
    (e: unknown) =>
      e instanceof ChangePublicationError &&
      e.code === "PUBLICATION_ALREADY_APPLIED",
  );
  equal(f.host.state.configuration!.changes[0].status, "approved");
  equal(f.publications(), 1);
});

Deno.test("a moved pin preserves an adopted revocation even when its digest equals the old base", async () => {
  const f = await fixture();
  f.faults.save = true;
  await rejects(() => decideChange.call(f.host, f.input));
  f.faults.save = false;
  f.host.state.executionModel!.version.repositoryVersion =
    "revocation-after-publication";
  const pinned = structuredClone(f.host.state.executionModel);
  await reconcileChangePublications.call(f.host);
  deepStrictEqual(f.host.state.executionModel, pinned);
  // Atomic receipt: reconcile stages the published approval without recording
  // it; the resumption records it with its completion, without adopting.
  equal(f.host.state.configuration!.changes[0].status, "pending");
  equal(f.host.state.configuration!.changes[0].publishedCommit, "snapshot-2");
  await resumeChangeDecisions.call(f.host);
  equal(f.host.state.configuration!.changes[0].status, "approved");
  equal(f.host.state.events.at(-1)!.kind, "configuration-change-completed");
});

Deno.test("proposal entry reconciles a published pending change before admitting the next proposal", async () => {
  const f = await fixture();
  f.faults.save = true;
  await rejects(() => decideChange.call(f.host, f.input));
  f.faults.save = false;
  await proposeChange.call(f.host, {
    ...request,
    requestedRights: { addNetworkHosts: ["next.example"] },
  });
  // Atomic receipt: the published change is decided and merely completing, so
  // it no longer blocks the next proposal at the adopted pin.
  equal(f.host.state.configuration!.changes[0].status, "pending");
  equal(f.host.state.configuration!.changes[0].publishedCommit, "snapshot-2");
  equal(f.host.state.configuration!.changes[1].baseRevision, 1);
});

for (const found of [false, true]) {
  Deno.test(`legacy incomplete journal migrates ${found ? "to completed from historical commit" : "back to pending without authority"}`, async () => {
    const f = await fixture();
    const governance = SystemGovernance.fromExecutable(
      f.host.state.executionModel!,
      [f.proposed],
    );
    const approved = governance.decideChange(
      f.proposed.id,
      f.proposed.baseRevision,
      true,
      "legacy-decision",
    );
    const receipt = changePublication(
      approved,
      f.host.state.executionModel!.version,
    );
    if (found) {
      const model = await f.host.ports.model.applyApprovedChange(
        f.host.state.model!,
        approved,
        approved.baseModelDigest!,
        receipt,
      );
      f.published.set(approved.id, { model }); // Old commits have no trailer.
    }
    f.host.state.configuration!.changes = [{
      ...approved,
      publication: { baseRepositoryVersion: "snapshot-1" },
    }];
    await reconcileChangePublications.call(f.host);
    const migrated = f.host.state.configuration!.changes[0];
    equal(migrated.publication, undefined);
    equal(migrated.status, found ? "approved" : "pending");
    if (found) {
      deepStrictEqual(migrated.authorityExercise, approved.authorityExercise);
    } else {
      equal(migrated.authorityExercise, undefined);
      equal(migrated.decidedAt, undefined);
      await decideChange.call(f.host, { ...f.input, verdict: "refuse" });
    }
  });
}

Deno.test("recovery compares the existing authority receipt and never substitutes current authority", async () => {
  const f = await fixture();
  f.faults.save = true;
  await rejects(() => decideChange.call(f.host, f.input));
  f.faults.save = false;
  f.published.get(f.proposed.id)!.receipt!.baseModelDigest = "foreign-digest";
  await rejects(
    () => reconcileChangePublications.call(f.host),
    (e: unknown) =>
      e instanceof ChangePublicationError &&
      e.code === "PUBLICATION_RECEIPT_MISMATCH",
  );
  equal(f.host.state.configuration!.changes[0].status, "pending");
});

Deno.test("publication recovery rejects a receipt borrowed from another system", async () => {
  const f = await fixture();
  f.faults.save = true;
  await rejects(() => decideChange.call(f.host, f.input));
  f.faults.save = false;
  f.published.get(f.proposed.id)!.receipt!.authorityExercise.systemId =
    "foreign-system";
  await rejects(
    () => reconcileChangePublications.call(f.host),
    (error: unknown) =>
      error instanceof ChangePublicationError &&
      error.code === "PUBLICATION_RECEIPT_MISMATCH" &&
      error.context.systemId === "system",
  );
  equal(f.host.state.configuration!.changes[0].status, "pending");
});

Deno.test("successful publication closes and adopts once with its immutable edits receipt", async () => {
  const f = await fixture();
  await decideChange.call(f.host, f.input);
  equal(f.publications(), 1);
  equal(f.host.state.configuration!.changes[0].status, "approved");
  equal(f.host.state.configuration!.changes[0].publication, undefined);
  equal(f.host.state.executionModel!.version.repositoryVersion, "snapshot-2");
  deepStrictEqual(f.published.get(f.proposed.id)!.receipt!.edits, [
    { owner: "system", name: "networkHosts", value: '["recovery.example"]' },
  ]);
});

Deno.test("transient publication failures leave the proposal pending and allow retry", async () => {
  const f = await fixture();
  f.faults.before = new Deno.errors.Busy("Writer lock unavailable");
  await rejects(() => decideChange.call(f.host, f.input), (error: unknown) => {
    ok(error instanceof ChangePublicationError);
    equal(error.code, "PUBLICATION_FAILED");
    equal(error.recovery, "retry");
    equal(error.context.changeId, f.proposed.id);
    return true;
  });
  deepStrictEqual(f.host.state.configuration!.changes, [f.proposed]);
  equal(f.publications(), 0);
  f.faults.before = undefined;
  await decideChange.call(f.host, f.input);
  equal(f.host.state.configuration!.changes[0].status, "approved");
  equal(f.publications(), 1);
});

Deno.test("approval guards expose refuse recovery without publishing or adopting", async () => {
  const f = await fixture();
  f.host.state.executionModel!.policy.mayAddNetworkHosts = false;
  const before = structuredClone(f.host.state);
  await rejects(() => decideChange.call(f.host, f.input), (error: unknown) => {
    ok(error instanceof ChangePublicationError);
    equal(error.code, "PUBLICATION_NOT_APPLICABLE");
    equal(error.recovery, "refuse");
    equal(error.context.changeId, f.proposed.id);
    return true;
  });
  equal(f.publications(), 0);
  deepStrictEqual(f.host.state, before);
});

for (const path of ["lost-return", "reconcile"] as const) {
  Deno.test(`divergent receipt on ${path} leaves the proposal pending and the pin unchanged`, async () => {
    const f = await fixture();
    f.faults.after = true;
    const find = f.host.ports.model.findApprovedChange!;
    f.host.ports.model.findApprovedChange = async (...args) => {
      const publication = await find(...args);
      if (!publication) return null;
      throw new ChangePublicationError("PUBLICATION_RECEIPT_MISMATCH", {
        changeId: f.proposed.id,
        systemId: "system",
      }, "Published literal differs from receipt.edits");
    };
    const before = structuredClone(f.host.state);
    const mismatch = (error: unknown) => {
      ok(error instanceof ChangePublicationError);
      equal(error.code, "PUBLICATION_RECEIPT_MISMATCH");
      equal(error.context.changeId, f.proposed.id);
      deepStrictEqual(error.recovery, { action: "reload" });
      return true;
    };
    await rejects(() => decideChange.call(f.host, f.input), mismatch);
    if (path === "reconcile") {
      await rejects(() => reconcileChangePublications.call(f.host), mismatch);
    }
    equal(f.publications(), 1);
    deepStrictEqual(f.host.state, before);
  });
}

for (const verdict of ["approve", "refuse"] as const) {
  Deno.test(`a ${verdict} decision selects its recorded Case before feedback and adoption and restarts without a cursor`, async () => {
    const f = await fixture();
    const clock = { now: () => "2026-10-24T00:00:00.000Z" };
    const caseId = selectHumanRequestCase(
      f.host.state,
      { objective: "Original", messageId: "original" },
      clock,
      1,
    );
    const pending = f.host.state.configuration!.changes[0];
    pending.caseId = caseId;
    delete pending.designerScopeId;
    selectDesignerInvocation(f.host.state);
    equal(f.host.state.conversationCursor, undefined);
    const seen: string[] = [];
    f.host.feedback = () => {
      equal(f.host.state.caseInvocation?.kind, "local");
      equal(
        f.host.state.caseInvocation && "caseId" in f.host.state.caseInvocation
          ? f.host.state.caseInvocation.caseId
          : undefined,
        caseId,
      );
      seen.push("feedback");
      return Promise.resolve();
    };
    const adopt = f.host.adopt;
    f.host.adopt = (model, changes, event) => {
      equal(f.host.state.caseInvocation?.kind, "local");
      seen.push("adopt");
      return adopt(model, changes, event);
    };
    f.host.runTurn = () => {
      equal(f.host.state.caseInvocation?.kind, "local");
      seen.push("turn");
      return Promise.resolve();
    };
    await decideChange.call(f.host, { ...f.input, verdict });
    deepStrictEqual(
      seen,
      verdict === "approve"
        ? ["adopt", "feedback", "turn"]
        : ["feedback", "turn"],
    );
    equal(f.host.state.configuration!.changes[0].caseId, caseId);
  });
}

Deno.test("a legacy pending change cannot receive new authority or resume a different scope", async () => {
  const f = await fixture();
  const pending = f.host.state.configuration!.changes[0];
  delete pending.requestedBy;
  delete pending.designerScopeId;
  let feedback = 0, turns = 0;
  f.host.feedback = () => {
    feedback++;
    return Promise.resolve();
  };
  f.host.runTurn = () => {
    turns++;
    return Promise.resolve();
  };
  await rejects(() => decideChange.call(f.host, f.input), {
    code: "CHANGE_SCOPE_MISSING",
    context: { changeId: pending.id },
    recovery: { action: "restore-recorded-scope" },
  });
  equal(f.publications(), 0);
  equal(f.host.state.configuration!.changes[0].status, "pending");
  await decideChange.call(f.host, { ...f.input, verdict: "refuse" });
  equal(f.host.state.configuration!.changes[0].status, "refused");
  equal(feedback, 0);
  equal(turns, 0);
});

Deno.test("operator creation requires the registered Main Operator before presentation and again before publication", async () => {
  const f = await fixture();
  f.host.state.configuration!.changes = [];
  f.host.state.executionModel!.policy.mayCreateReviewer = true;
  f.host.canOpenOperatorRequests = () => true;
  f.host.isPrimaryOperator = () => false;
  const request: ChatDecision = {
    kind: "propose_agent_creation",
    role: "operator",
    name: "Research",
    text: "Proposal",
    reason: "Process a Request",
    operator: {
      instruction: "Answer concise requests",
      networkHosts: [],
      requestType: { name: "Research request", maxInvocations: 4 },
      firstRequest: { objective: "Ask for network scope" },
    },
  };
  await rejects(
    () => proposeChange.call(f.host, request),
    /registered Main Operator/,
  );
  equal(f.host.state.configuration!.changes.length, 0);
  f.host.isPrimaryOperator = () => true;
  await proposeChange.call(f.host, request);
  const change = f.host.state.configuration!.changes[0]!;
  f.host.isPrimaryOperator = () => false;
  await rejects(
    () =>
      decideChange.call(f.host, {
        changeId: change.id,
        expectedRevision: change.baseRevision,
        verdict: "approve",
      }),
    /registered Main Operator/,
  );
  equal(f.publications(), 0);
  equal(f.host.state.configuration!.changes[0]!.status, "pending");
});

Deno.test("operator authority requires the registered Main Operator, as operator creation does", async () => {
  const f = await fixture();
  f.host.state.configuration!.changes = [];
  f.host.isPrimaryOperator = () => false;
  await rejects(
    () =>
      proposeChange.call(f.host, {
        kind: "propose_mandate_change",
        text: "Proposal",
        reason: "Let the designer decide covered requests",
        requestedRights: {
          operatorAuthority: {
            policyId: "network",
            expectedPolicyRevision: 0,
            enabled: true,
            recipients: ["operator"],
            acts: ["addNetworkHosts"],
            networkHosts: ["example.org"],
            toolIds: [],
            maxDelegationDepth: 0,
          },
        },
      }),
    { reason: "PROPOSAL_NOT_AUTHORIZED" },
  );
  equal(f.host.state.configuration!.changes.length, 0);
});

Deno.test("4.8d D4: a proposal stores only a resolved recipient space; a raw Case is refused", async () => {
  const f = await fixture();
  f.host.state.configuration!.changes = [];
  f.host.isPrimaryOperator = () => true;
  f.host.state.executionModel!.ownerAuthority = {
    ...legacyOwnerAuthority("system"),
    ownerSource: "modeled",
  };
  f.host.state.executionModel!.policy.mayProposeSysmlRevision = true;
  const request = {
    policyId: "bo-x-network",
    expectedPolicyRevision: 0,
    enabled: true,
    // The BO carries the MO's native ID: only its space tells them apart.
    recipients: ["builder"],
    acts: ["addNetworkHosts"] as ["addNetworkHosts"],
    networkHosts: ["example.org"],
    toolIds: [] as [],
    maxDelegationDepth: 0 as const,
  };
  const proposal = (operatorAuthority: Record<string, unknown>) =>
    ({
      kind: "propose_mandate_change" as const,
      text: "Proposal",
      reason: "Decide the network requests of Case X's operator",
      requestedRights: { operatorAuthority },
    }) as Extract<ChatDecision, { kind: "propose_mandate_change" }>;
  // Resolution belongs to the host's entry point, not to proposeChange.
  await rejects(
    () =>
      proposeChange.call(
        f.host,
        proposal({ ...request, recipientCaseId: "case-x" }),
      ),
    { code: "INVALID_AUTHORITY_POLICY" },
  );
  await rejects(() => proposeChange.call(f.host, proposal(request)), {
    code: "AUTHORITY_POLICY_FORBIDDEN",
  });
  equal(f.host.state.configuration!.changes.length, 0);
  await proposeChange.call(
    f.host,
    proposal({ ...request, recipientExecutionSpaceId: "space-x" }),
  );
  deepStrictEqual(f.host.state.configuration!.changes[0].requestedRights, {
    operatorAuthority: { ...request, recipientExecutionSpaceId: "space-x" },
  });
});

Deno.test("publication receipt binds the exact proposal origin and requested rights", async () => {
  const f = await fixture();
  await decideChange.call(f.host, f.input);
  const record = f.host.state.configuration!.changes[0]!;
  const receipt = f.published.get(record.id)!.receipt!;
  const { assertPublicationMatches } = await import(
    "../../domain/model/publication/change.ts"
  );
  for (
    const forged of [
      { ...record, designerScopeId: "other-scope" },
      { ...record, requestedRights: { addNetworkHosts: ["other.example"] } },
    ]
  ) {
    let rejected = false;
    try {
      assertPublicationMatches(forged, receipt);
    } catch {
      rejected = true;
    }
    equal(rejected, true);
  }
});

for (const scope of ["delegated", "delegated-designer"] as const) {
  for (const verdict of ["approve", "refuse"] as const) {
    Deno.test(`${scope} worker change with a recorded requester can ${verdict} and resume`, async () => {
      const f = await fixture();
      const caller = structuredClone(f.host.state);
      caller.executionModel!.identity.builderId = "caller";
      const caseId = selectHumanRequestCase(
        caller,
        {
          objective: "Delegated request",
          messageId: "caller-message",
        },
        { now: () => "2026-10-24T00:00:00.000Z" },
        1,
      );
      const receipt = {
        callerId: "caller",
        correlationId: "work",
        invocationId: "invocation",
        behaviorId: "behavior",
        targetNativeId: "target",
        fingerprint: "fingerprint",
        modelVersion: {
          digest: "caller-model",
          repositoryVersion: "caller-version",
        },
        priorCandidateIds: [],
      };
      const pending = f.host.state.configuration!.changes[0];
      if (scope === "delegated") {
        delete pending.designerScopeId;
        pending.caseId = caseId;
        f.host.state.caseInvocation = {
          kind: scope,
          work: {
            ...receipt,
            caseId,
            caseContext: caseExecutionContext(caller)!,
          },
        };
      } else {
        pending.designerScopeId = "caller-designer";
        f.host.state.caseInvocation = {
          kind: scope,
          work: {
            ...receipt,
            designerContext: { scopeId: "caller-designer", ownerId: "caller" },
          },
        };
      }
      const invocation = structuredClone(f.host.state.caseInvocation);
      let turns = 0;
      f.host.runTurn = () => {
        deepStrictEqual(f.host.state.caseInvocation, invocation);
        turns++;
        return Promise.resolve();
      };
      await decideChange.call(f.host, { ...f.input, verdict });
      equal(turns, 1);
      equal(
        f.host.state.configuration!.changes[0].status,
        verdict === "approve" ? "approved" : "refused",
      );
      // The pending lock is released for the same delegated invocation.
      await proposeChange.call(f.host, {
        ...request,
        requestedRights: { addNetworkHosts: ["next.example"] },
      });
      equal(f.host.state.configuration!.changes.at(-1)!.status, "pending");
    });
  }
}

Deno.test("retry after a transient first Request opening delivers designer feedback and resumes once", async () => {
  const f = await fixture();
  f.host.state.configuration!.changes = [];
  f.host.state.executionModel!.policy.mayCreateReviewer = true;
  f.host.isPrimaryOperator = () => true;
  f.host.canOpenOperatorRequests = () => true;
  await proposeChange.call(f.host, {
    kind: "propose_agent_creation",
    role: "operator",
    name: "Research",
    reason: "Bounded Request",
    text: "Proposal",
    operator: {
      instruction: "Answer the request",
      networkHosts: [],
      requestType: { name: "Research request", maxInvocations: 4 },
      firstRequest: { objective: "Read the scope" },
    },
  });
  const change = f.host.state.configuration!.changes[0];
  let fail = true, openings = 0, feedback = 0, turns = 0;
  f.host.changeApproved = () => {
    openings++;
    return fail
      ? Promise.reject(new Error("Opening unavailable"))
      : Promise.resolve();
  };
  f.host.feedback = () => {
    feedback++;
    return Promise.resolve();
  };
  f.host.runTurn = () => {
    turns++;
    return Promise.resolve();
  };
  const input = {
    ...f.input,
    changeId: change.id,
    expectedRevision: change.baseRevision,
  };
  await rejects(() => decideChange.call(f.host, input), /Opening unavailable/);
  equal(feedback, 0);
  equal(turns, 0);
  fail = false;
  await decideChange.call(f.host, input);
  equal(feedback, 1);
  equal(turns, 1);
  await decideChange.call(f.host, input);
  equal(feedback, 1);
  equal(turns, 1);
  equal(openings, 3);
  equal(f.publications(), 1);
});

Deno.test("decision dialogue journal survives reload without modifying the published change", async () => {
  const f = await fixture();
  let feedback = 0, turns = 0;
  f.host.feedback = () => {
    feedback++;
    return Promise.resolve();
  };
  f.host.runTurn = () => Promise.reject(new Error("Resume unavailable"));
  await rejects(() => decideChange.call(f.host, f.input), /Resume unavailable/);
  equal(
    f.host.state.changeDecisionContinuations?.[f.proposed.id],
    "feedback-sent",
  );
  const completed = structuredClone(f.host.state.configuration!.changes[0]);
  ok(!("decisionContinuation" in completed));
  Object.assign(f.host.state, JSON.parse(JSON.stringify(f.host.state)));
  f.host.runTurn = () => {
    turns++;
    return Promise.resolve();
  };
  await resumeChangeDecisions.call(f.host);
  equal(f.host.state.changeDecisionContinuations?.[f.proposed.id], "resumed");
  deepStrictEqual(f.host.state.configuration!.changes[0], completed);
  Object.assign(f.host.state, JSON.parse(JSON.stringify(f.host.state)));
  await decideChange.call(f.host, f.input);
  equal(feedback, 1);
  equal(turns, 1);
  equal(f.publications(), 1);
  deepStrictEqual(f.host.state.configuration!.changes[0], completed);
});

Deno.test("startup completes pending decision dialogue after a lost adoption-save return", async () => {
  // The completion-save loss boundary (approval recorded without its receipt)
  // was removed by the atomic receipt: the approval is journaled atomically
  // with the resumption receipt, so a lost return can only strand the staged
  // adoption, which the restart resumption completes.
  const f = await fixture();
  let feedback = 0, turns = 0;
  f.host.feedback = () => {
    feedback++;
    return Promise.resolve();
  };
  f.host.runTurn = () => {
    turns++;
    return Promise.resolve();
  };
  f.faults.saveReturn = true;
  await rejects(() => decideChange.call(f.host, f.input), /after state save/);
  equal(f.host.state.changeDecisionContinuations?.[f.proposed.id], "pending");
  f.faults.saveReturn = false;
  Object.assign(f.host.state, JSON.parse(JSON.stringify(f.host.state)));
  await resumeChangeDecisions.call(f.host);
  const completed = structuredClone(f.host.state);
  await decideChange.call(f.host, f.input);
  deepStrictEqual(f.host.state, completed);
  equal(feedback, 1);
  equal(turns, 1);
  equal(f.publications(), 1);
});

async function delegatedDecisionFixture() {
  const f = await fixture();
  const native = await f.host.currentModel();
  const { legacyOwnerAuthority } = await import(
    "../../domain/governance/authority.ts"
  );
  const authority = {
    ...legacyOwnerAuthority("system"),
    ownerSource: "modeled" as const,
  };
  native.ownerAuthority = structuredClone(authority);
  native.operatorAuthorityPolicies = [{
    id: "network-policy",
    revision: 2,
    elementId: "native-policy",
    sourceIds: ["policy-source"],
    rootAuthority: structuredClone(authority),
    enabled: true,
    holderNativeId: "designer",
    mandateNativeId: "designer-mandate",
    systemId: "system",
    recipients: ["builder"],
    acts: ["addNetworkHosts"],
    networkHosts: ["recovery.example"],
    toolIds: [],
    maxDelegationDepth: 0,
  }];
  f.host.state.executionModel = structuredClone(native);
  const caseId = selectHumanRequestCase(
    f.host.state,
    {
      objective: "Delegated bounded host request",
      messageId: "delegated-origin",
    },
    { now: () => "2026-10-24T00:00:00.000Z" },
    1,
  );
  const pending = f.host.state.configuration!.changes[0];
  pending.caseId = caseId;
  delete pending.designerScopeId;
  return {
    ...f,
    native,
    delegated: {
      actorId: "designer",
      policyId: "network-policy",
      policyRevision: 2,
    },
  };
}

Deno.test("delegated approval publishes once with builder authority and exact delegation receipt", async () => {
  const f = await delegatedDecisionFixture();
  await decideChange.call(f.host, f.input, f.delegated);
  const approved = f.host.state.configuration!.changes[0];
  equal(approved.status, "approved");
  equal(approved.authority, "builder");
  equal(f.publications(), 1);
  const receipt = f.published.get(approved.id)!.receipt!;
  deepStrictEqual(approved.authorityExercise, receipt.authorityExercise);
  const space = mainExecutionSpace(f.native.identity);
  deepStrictEqual(approved.authorityExercise!.delegation, {
    actorId: "designer",
    actor: { ...space, operatorId: "designer" },
    requester: { ...space, operatorId: "builder" },
    policyId: "network-policy",
    policyRevision: 2,
    policyElementId: "native-policy",
    policyIssuer: f.native.ownerAuthority,
    requestedBy: "builder",
    changeId: approved.id,
    caseId: approved.caseId,
    requestedRights: request.requestedRights,
  });
});

Deno.test("delegated publication recovery retains builder authority and original receipt after policy revocation", async () => {
  const f = await delegatedDecisionFixture();
  f.faults.save = true;
  await rejects(
    () => decideChange.call(f.host, f.input, f.delegated),
    /state save/,
  );
  equal(f.publications(), 1);
  equal(f.host.state.configuration!.changes[0].status, "pending");
  const receipt = structuredClone(f.published.get(f.input.changeId)!.receipt!);
  f.faults.save = false;
  // Revocation prevents a new exercise; recovery uses the attested original act.
  f.host.state.executionModel!.operatorAuthorityPolicies![0].enabled = false;
  await reconcileChangePublications.call(f.host);
  const recovered = f.host.state.configuration!.changes[0];
  // Atomic receipt: reconcile stages the attested approval; the decision
  // records it without exercising the revoked policy.
  equal(recovered.status, "pending");
  equal(recovered.publishedCommit, "snapshot-2");
  equal(recovered.authority, "builder");
  deepStrictEqual(recovered.authorityExercise, receipt.authorityExercise);
  equal(recovered.decidedAt, receipt.decidedAt);
  await decideChange.call(f.host, f.input, f.delegated);
  equal(f.host.state.configuration!.changes[0].status, "approved");
  equal(f.publications(), 1);
  deepStrictEqual(
    f.host.state.configuration!.changes[0].authorityExercise,
    receipt.authorityExercise,
  );
});

for (const condition of ["stale", "revoked"] as const) {
  for (const verdict of ["approve", "refuse"] as const) {
    Deno.test(`delegated ${verdict} rereads ${condition} policy and leaves proposal pending without publication`, async () => {
      const f = await delegatedDecisionFixture();
      // The adopted projection stays authorized; only the freshly read policy changes.
      if (condition === "stale") {
        f.native.operatorAuthorityPolicies![0].revision++;
      } else f.native.operatorAuthorityPolicies![0].enabled = false;
      await rejects(
        () => decideChange.call(f.host, { ...f.input, verdict }, f.delegated),
        { code: "AUTHORITY_POLICY_STALE" },
      );
      equal(f.publications(), 0);
      const pending = f.host.state.configuration!.changes[0];
      equal(pending.status, "pending");
      equal(pending.authority, undefined);
      equal(pending.authorityExercise, undefined);
    });
  }
}

Deno.test("delegated refusal requires current policy revision and records builder provenance without publication", async () => {
  const f = await delegatedDecisionFixture();
  await decideChange.call(
    f.host,
    { ...f.input, verdict: "refuse" },
    f.delegated,
  );
  const refused = f.host.state.configuration!.changes[0];
  equal(refused.status, "refused");
  equal(refused.authority, "builder");
  equal(refused.authorityExercise!.delegation!.policyRevision, 2);
  equal(refused.authorityExercise!.delegation!.actorId, "designer");
  deepStrictEqual(
    refused.authorityExercise!.delegation!.requestedRights,
    request.requestedRights,
  );
  equal(f.publications(), 0);
});

for (const changed of ["input", "base"] as const) {
  Deno.test(`delegated refusal rejects stale target ${changed} revision without publishing`, async () => {
    const f = await delegatedDecisionFixture();
    const input = { ...f.input, verdict: "refuse" as const };
    if (changed === "input") input.expectedRevision++;
    else f.native.configuration.revision++;
    await rejects(
      () => decideChange.call(f.host, input, f.delegated),
      {
        code: "AUTHORITY_REQUEST_STALE",
        recovery: { action: "refuse-and-repropose" },
      },
    );
    equal(f.publications(), 0);
    const pending = f.host.state.configuration!.changes[0];
    equal(pending.status, "pending");
    equal(pending.authorityExercise, undefined);
  });
}

for (const changed of ["revoked", "revision"] as const) {
  Deno.test(`delegated publication rechecks ${changed} policy after decision selection`, async () => {
    const f = await delegatedDecisionFixture();
    const read = f.host.ports.model.readExecutableModel;
    let reads = 0;
    f.host.ports.model.readExecutableModel = async (...args) => {
      const model = structuredClone(await read(...args));
      reads++;
      if (reads >= 2) {
        if (changed === "revoked") {
          model.operatorAuthorityPolicies![0].enabled = false;
        } else model.operatorAuthorityPolicies![0].revision++;
      }
      return model;
    };
    await rejects(
      () => decideChange.call(f.host, f.input, f.delegated),
      {
        code: "AUTHORITY_POLICY_STALE",
        recovery: { action: "refuse-and-repropose" },
      },
    );
    equal(reads, 2);
    equal(f.publications(), 0);
    const pending = f.host.state.configuration!.changes[0];
    equal(pending.status, "pending");
    equal(pending.authorityExercise, undefined);
  });
}

Deno.test("approved delegated change rejects replay under a different actor and policy", async () => {
  const f = await delegatedDecisionFixture();
  await decideChange.call(f.host, f.input, f.delegated);
  const approved = structuredClone(f.host.state.configuration!.changes[0]);
  await rejects(() =>
    decideChange.call(f.host, f.input, {
      actorId: "other-designer",
      policyId: "other-policy",
      policyRevision: 99,
    })
  );
  equal(f.publications(), 1);
  deepStrictEqual(f.host.state.configuration!.changes[0], approved);
});

Deno.test("the domain judge alone refuses a designer deciding its own request", async () => {
  const f = await delegatedDecisionFixture();
  // Holder and recipient both match: only the self-decision rule can refuse.
  f.native.operatorAuthorityPolicies![0].holderNativeId = "builder";
  await rejects(
    () =>
      decideChange.call(f.host, f.input, {
        ...f.delegated,
        actorId: "builder",
      }),
    { code: "AUTHORITY_OUT_OF_BOUNDS" },
  );
  equal(f.publications(), 0);
  const pending = f.host.state.configuration!.changes[0];
  equal(pending.status, "pending");
  equal(pending.authorityExercise, undefined);
});

async function teamCreationFixture() {
  const f = await fixture();
  const host = f.host;
  let native = structuredClone(host.state.executionModel!);
  const authority = {
    ...legacyOwnerAuthority(native.identity.systemId),
    ownerSource: "modeled" as const,
  };
  native.ownerAuthority = authority;
  native.policy.mayCreateReviewer = false;
  native.operatorCreationPolicies = [{
    id: "team-creation",
    revision: 1,
    elementId: "native-team-grant",
    sourceIds: ["native-team-grant"],
    rootAuthority: authority,
    holderNativeId: native.identity.builderId,
    mandateNativeId: "builder-mandate",
    systemId: native.identity.systemId,
    enabled: true,
    networkHosts: [],
    maxChildren: 2,
    maxDelegationDepth: 1,
    children: [],
  }];
  host.state.executionModel = structuredClone(native);
  host.state.configuration = {
    ...structuredClone(native.configuration),
    changes: [],
  };
  const caseId = selectHumanRequestCase(
    host.state,
    { objective: "Compose a team", messageId: "team-origin" },
    { now: () => "2026-10-27T00:00:00.000Z" },
    1,
  );
  host.state.busy = true;
  host.isPrimaryOperator = () => false;
  host.canOpenOperatorRequests = () => true;
  let publications = 0;
  let openings = 0;
  let resumes = 0;
  let notices = 0;
  host.control = () => {
    throw new Error("A controlled turn must not reserve itself again");
  };
  host.runTurn = () => {
    resumes++;
    return Promise.resolve();
  };
  host.changeProposed = () => {
    notices++;
    return Promise.resolve();
  };
  host.changeApproved = (change) => {
    equal(change.teamOrigin?.requestId, caseId);
    openings++;
    return Promise.resolve();
  };
  host.ports.model.readExecutableModel = () =>
    Promise.resolve(structuredClone(native));
  host.ports.model.applyApprovedChange = (
    _identity,
    change,
    _digest,
    receipt,
  ) => {
    assertChangeAuthorityReceipt(
      native,
      change,
      mainCreationScope(native.identity),
    );
    publications++;
    receipt.edits = [{
      owner: "system",
      name: "team-member",
      value: change.id,
    }];
    native = structuredClone(native);
    native.configuration.revision++;
    native.version.digest = "team-published";
    native.version.repositoryVersion = "team-commit";
    native.operatorCreationPolicies![0].children.push("child-system");
    return Promise.resolve(structuredClone(native));
  };
  const decision: Extract<
    ChatDecision,
    { kind: "propose_agent_creation"; role: "operator" }
  > = {
    kind: "propose_agent_creation",
    role: "operator",
    text: "Prepare a team operator",
    name: "Research",
    reason: "Contribute to this Request",
    operator: {
      kind: "request-team-member",
      instruction: "Read the assigned source",
      provision: {
        budget: { maxAgentDecisions: 1, maxToolProposals: 0, maxFlowSteps: 1 },
        networkHosts: [],
        mayPropose: [],
        mayInvokeActiveCatalog: false,
      },
    },
  };
  return {
    host,
    caseId,
    decision,
    native: () => native,
    counts: () => ({ publications, openings, resumes, notices }),
  };
}

Deno.test("a non-Main Request operator publishes a granted team creation inside its controlled turn", async () => {
  const f = await teamCreationFixture();
  const result = await proposeChange.call(f.host, f.decision);
  equal(result.status, "approved");
  deepStrictEqual(f.counts(), {
    publications: 1,
    openings: 1,
    resumes: 0,
    notices: 0,
  });
  const recorded = f.host.state.configuration!.changes[0];
  equal(recorded.status, "approved");
  equal(recorded.authority, "builder");
  equal(
    recorded.authorityExercise?.creationDelegation?.actorId,
    f.host.state.executionModel!.identity.builderId,
  );
  deepStrictEqual(recorded.teamOrigin, {
    operatorId: f.host.state.executionModel!.identity.builderId,
    requestId: f.caseId,
  });
  equal(f.host.state.cases!.length, 1);
  equal(f.host.state.changeDecisionContinuations?.[recorded.id], "resumed");
});

Deno.test("verified team publication adopts and cancels only linked queued calls atomically", async () => {
  const f = await teamCreationFixture();
  const priorDigest = f.host.state.executionModel!.version.digest;
  f.host.state.conversationBatches = [{
    id: "provider-batch",
    caseId: f.caseId,
    modelDigest: priorDigest,
    createdAt: "2026-10-27T00:00:00.000Z",
    sourceDecision: {},
    calls: [
      {
        id: "creation",
        decision: f.decision,
        status: "started",
        effectStarted: true,
      },
      {
        id: "effect",
        decision: { kind: "reply", text: "stale" },
        status: "queued",
      },
    ],
  }];
  f.host.state.activeBatchCall = {
    batchId: "provider-batch",
    callId: "creation",
  };
  await proposeChange.call(f.host, f.decision);
  const state = f.host.state;
  equal(state.executionModel!.version.digest, "team-published");
  const batch = state.conversationBatches![0];
  equal(batch.modelDigest, priorDigest);
  equal(batch.calls[0].changeId, state.configuration!.changes[0].id);
  equal(batch.calls[0].status, "started");
  equal(batch.calls[1].result?.code, "BATCH_REPLAN_REQUIRED");
  equal(batch.calls[1].status, "cancelled");
  equal(f.counts().publications, 1);
});

Deno.test("team creation rechecks a grant revoked after its preview and preserves the pending proposal", async () => {
  const f = await teamCreationFixture();
  f.host.ports.model.previewApprovedChange = async (...args) => {
    const preview = await emptyChangePreview(...args);
    f.native().operatorCreationPolicies![0].enabled = false;
    return preview;
  };
  await rejects(
    () => proposeChange.call(f.host, f.decision),
    /grant|bounds|authority|policy/i,
  );
  deepStrictEqual(f.counts(), {
    publications: 0,
    openings: 0,
    resumes: 0,
    notices: 1,
  });
  equal(f.host.state.configuration!.changes[0].status, "pending");
});

Deno.test("a designer conversation cannot disguise a team creation as an active Request", async () => {
  const f = await teamCreationFixture();
  selectDesignerInvocation(f.host.state);
  const before = structuredClone(f.host.state);
  await rejects(
    () => proposeChange.call(f.host, f.decision),
    /active originating Request/,
  );
  deepStrictEqual(f.host.state, before);
  equal(f.counts().publications, 0);
});

Deno.test("native promotion dependency refuses mandate approval before publication without changing its pending proposal", async () => {
  const f = await fixture();
  const model = f.host.state.executionModel!;
  const promotion:
    import("../work/runtime/execution.ts").NativeExecutionSnapshot = {
      identity: {
        operatorId: "builder",
        invocationKey: "designer",
        scope: { kind: "designer", scopeId: "designer", ownerId: "builder" },
        purpose: "promotion",
        subjectId: "candidate",
      },
      threadId: "promotion-thread",
      contributionId: "input",
      modelDigest: model.version.digest,
      repositoryVersion: model.version.repositoryVersion,
      flowRootId: model.flows.promotion.rootNativeId,
      checkpointId: "retained-admission",
      status: "waiting",
      waits: [{
        nodeId: "admission",
        kind: "decision",
        mechanism: "decide_admission",
      }],
      unsettledEffects: [],
      pendingContributions: [],
    };
  f.host.ports.execution = {
    inspect: () => Promise.resolve([structuredClone(promotion)]),
  };
  const before = structuredClone(f.host.state),
    native = structuredClone(promotion);
  const writes = f.writes();
  await rejects(() => decideChange.call(f.host, f.input), {
    name: "ChangePublicationError",
    message:
      "Une promotion native suspendue doit être terminée avant cette publication ; la proposition reste en attente.",
    code: "PUBLICATION_NOT_APPLICABLE",
  });
  equal(f.publications(), 0);
  equal(f.writes(), writes);
  deepStrictEqual(f.host.state, before);
  deepStrictEqual(promotion, native);
});

function bareHost() {
  return {
    state: {
      model: { systemId: "unit" },
      configuration: { changes: [] },
    },
    ports: { model: {} },
    update: () => Promise.resolve(),
    adopt: () => Promise.resolve(),
  } as unknown as MandateChangeHost;
}

Deno.test("a team operator proposal is refused without a team creation host", async () => {
  const decision: Extract<
    ChatDecision,
    { kind: "propose_agent_creation"; role: "operator" }
  > = {
    kind: "propose_agent_creation",
    role: "operator",
    text: "Prepare a team operator",
    name: "Research",
    reason: "Contribute to this Request",
    operator: {
      kind: "request-team-member",
      instruction: "Read the assigned source",
      provision: {
        budget: { maxAgentDecisions: 1, maxToolProposals: 0, maxFlowSteps: 1 },
        networkHosts: [],
        mayPropose: [],
        mayInvokeActiveCatalog: false,
      },
    },
  };
  await rejects(
    () => proposeChange.call(bareHost(), decision),
    { message: "The team creation host is unavailable" },
  );
});

Deno.test("proposeChange under a per-creation grant stays pending for a decider", async () => {
  const f = await teamCreationFixture();
  f.host.state.executionModel!.operatorCreationPolicies![0].mode =
    "per-creation";
  f.native().operatorCreationPolicies![0].mode = "per-creation";
  const result = await proposeChange.call(f.host, f.decision);
  equal(result.status, "pending");
  const recorded = f.host.state.configuration!.changes[0]!;
  equal(recorded.status, "pending");
  equal(recorded.authority, undefined);
  equal(recorded.authorityExercise, undefined);
  deepStrictEqual(f.counts(), {
    publications: 0,
    openings: 0,
    resumes: 0,
    notices: 1,
  });
});

Deno.test("an unknown verdict is refused before any change is read", async () => {
  await rejects(
    () =>
      decideChange.call(bareHost(), {
        changeId: "change",
        expectedRevision: 1,
        verdict: "bogus" as "approve",
      }),
    { message: "Décision inconnue." },
  );
});

Deno.test("the proposal receipt and feedback reflect the recorded status after notification", async () => {
  const f = await fixture();
  await decideChange.call(f.host, { ...f.input, verdict: "refuse" });
  const feedback: string[] = [];
  f.host.feedback = (text) => {
    feedback.push(text);
    return Promise.resolve();
  };
  f.host.changeProposed = async (change) => {
    await decideChange.call(f.host, {
      changeId: change.id,
      expectedRevision: change.baseRevision,
      verdict: "refuse",
    });
  };
  const receipt = await proposeChange.call(f.host, request);
  const recorded = f.host.state.configuration!.changes.at(-1)!;
  equal(recorded.status, "refused");
  equal(receipt.status, recorded.status);
  equal(receipt.changeId, recorded.id);
  equal(
    feedback.some((text) => text.includes("Elle attend une approbation")),
    false,
  );
});
