import assert from "node:assert/strict";
import {
  type AcceptedOperatorCommand,
  commandBusinessDecision,
  commandRefusal,
  enqueueOperatorCommand,
  executeAcceptedCommand,
  type OperatorCommandWorkerHost,
  parseAcceptedCommand,
  recordedCommandOutcome,
  sameAcceptedCommandIntent,
  throwCommandRefusal,
} from "./command-delivery.ts";
import { OperatorAuthorityError } from "../../../domain/governance/operator-authority-error.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import type { Event, SystemRuntimeState } from "../runtime/state.ts";
import type { OperatorExecutionDelivery } from "./execution.ts";

function accepted(): AcceptedOperatorCommand {
  return {
    id: "command:effect-1",
    identity: {
      operatorId: "worker",
      invocationKey: "local:request-1",
      scope: {
        kind: "request",
        scopeId: "request-1",
        rootRequestId: "request-1",
      },
      purpose: "conversation",
      subjectId: "input-1",
    },
    modelPin: {
      modelDigest: "model-worker",
      repositoryVersion: "source-worker",
    },
    command: {
      kind: "decide-candidate",
      input: {
        candidateId: "candidate-1",
        candidateDigest: "candidate-digest",
        caseId: "request-1",
        verdict: "approve",
        reason: "Tests and exact source inspected",
      },
      delegated: { actorId: "main", policyId: "admission", policyRevision: 2 },
    },
    origin: {
      businessRevision: {
        __assemblyRuntimeRevision: {
          systemId: "system-main",
          operatorId: "main",
          invocationKey: "local:request-1",
          revision: 10,
          modelDigest: "model-main",
        },
      },
      effectKey: "effect-1",
      inputMessageId: "source-input-1",
      inspectionMessageId: "inspection-1",
    },
  };
}

async function delivery(
  input = accepted(),
): Promise<OperatorExecutionDelivery> {
  let saved!: OperatorExecutionDelivery;
  await enqueueOperatorCommand({
    enqueue(value) {
      saved = value;
      return Promise.resolve({
        id: value.id,
        threadId: "target-thread",
        jobId: "job-1",
        status: "queued",
      });
    },
    inspect() {
      return Promise.resolve(null);
    },
  }, input);
  return saved;
}

Deno.test("control receipt retains target scope and exact source evidence without queuing user input", async () => {
  const input = accepted(), saved = await delivery(input);
  assert.equal(saved.kind, "command");
  assert.deepEqual(parseAcceptedCommand(saved), input);
  input.command = {
    kind: "prepare-initial-tools",
    preparation: { key: "initial-tools:selection-1", revision: 11 },
  };
  assert.equal(parseAcceptedCommand(saved)!.command.kind, "decide-candidate");
});

Deno.test("candidate continuation receipt binds all four fields and rejects extra data", async () => {
  const input = accepted();
  input.command = {
    kind: "resume-candidate-continuation",
    candidateId: "candidate-1",
    invocationKey: "local:request-1",
    inputMessageId: "input-1",
    continuationDigest: "digest-1",
  };
  delete input.origin;
  const saved = await delivery(input);
  assert.deepEqual(parseAcceptedCommand(saved)!.command, input.command);
  for (
    const field of [
      "candidateId",
      "invocationKey",
      "inputMessageId",
      "continuationDigest",
    ]
  ) {
    const altered = structuredClone(saved);
    delete (altered.payload!.command as Record<string, unknown>)[field];
    assert.throws(() => parseAcceptedCommand(altered));
  }
  const altered = structuredClone(saved);
  (altered.payload!.command as Record<string, unknown>).extra = true;
  assert.throws(() => parseAcceptedCommand(altered));
});

Deno.test("initial preparation receipt requires the exact reference shape", async () => {
  const input = accepted();
  input.command = {
    kind: "prepare-initial-tools",
    preparation: { key: "initial-tools:selection-1", revision: 11 },
  };
  delete input.origin;
  const saved = await delivery(input);
  assert.deepEqual(parseAcceptedCommand(saved)!.command, input.command);

  const missing = structuredClone(saved);
  delete (missing.payload!.command as Record<string, unknown>).preparation;
  assert.throws(() => parseAcceptedCommand(missing), /Unexpected/);

  const extraCommandField = structuredClone(saved);
  (extraCommandField.payload!.command as Record<string, unknown>).caseId =
    "request-1";
  assert.throws(() => parseAcceptedCommand(extraCommandField), /Unexpected/);

  const extraReferenceField = structuredClone(saved);
  ((extraReferenceField.payload!.command as Record<string, unknown>)
    .preparation as Record<string, unknown>).caseId = "request-1";
  assert.throws(() => parseAcceptedCommand(extraReferenceField), /Unexpected/);

  for (const invalidKey of ["", "  ", "key\nwith-control"]) {
    const invalid = structuredClone(saved);
    ((invalid.payload!.command as Record<string, unknown>)
      .preparation as Record<string, unknown>).key = invalidKey;
    assert.throws(() => parseAcceptedCommand(invalid), /Invalid/);
  }
  for (const invalidRevision of [-1, 1.5, "11", Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = structuredClone(saved);
    ((invalid.payload!.command as Record<string, unknown>)
      .preparation as Record<string, unknown>).revision = invalidRevision;
    assert.throws(() => parseAcceptedCommand(invalid), /revision/);
  }
});

Deno.test("delegated candidate command rejects missing inspection and copied executable authority", async () => {
  const saved = await delivery();
  const missing = structuredClone(saved);
  delete (missing.payload!.origin as Record<string, unknown>)
    .inspectionMessageId;
  assert.throws(() => parseAcceptedCommand(missing), /inspection receipt/);
  const forged = structuredClone(saved);
  (forged.payload!.command as Record<string, unknown>).execute = "approve";
  assert.throws(() => parseAcceptedCommand(forged), /Unexpected/);
  const unbound = structuredClone(saved);
  delete unbound.payload!.origin;
  assert.throws(() => parseAcceptedCommand(unbound), /durable source evidence/);
  const mismatched = structuredClone(saved);
  ((mismatched.payload!.command as Record<string, unknown>).delegated as Record<
    string,
    unknown
  >).actorId = "another-actor";
  assert.throws(() => parseAcceptedCommand(mismatched), /durable source scope/);
});

Deno.test("schedule lane requires a declared scheduled command and exact due occurrence", async () => {
  const input = accepted();
  input.command = {
    kind: "run-scheduled-case",
    caseId: "watch-1",
    trigger: { kind: "due", scheduledAt: "2026-10-27T10:00:00.000Z" },
  };
  delete input.origin;
  const saved = await delivery(input);
  assert.equal(saved.kind, "schedule");
  assert.deepEqual(parseAcceptedCommand(saved)!.command, input.command);
  saved.kind = "command";
  assert.throws(() => parseAcceptedCommand(saved), /lane mismatch/);
});

function worker(log: string[]): OperatorCommandWorkerHost {
  const unused = () => {
    throw new Error("Wrong domain primitive");
  };
  return {
    assertCurrentScope() {
      log.push("scope");
      return Promise.resolve();
    },
    assertDelegatedAuthority() {
      log.push("authority");
      return Promise.resolve();
    },
    prepareInitialTools: unused,
    resumeDecidedChanges: unused,
    runScheduledCase: unused,
    decideCandidate(input, actor) {
      assert.equal(input.candidateId, "candidate-1");
      assert.equal(actor!.actorId, "main");
      log.push("domain");
      return Promise.resolve();
    },
    decideChange: unused,
    receiveWatchNotification: unused,
  };
}

Deno.test("worker rechecks current target and originating delegated authority before the real decision", async () => {
  const log: string[] = [];
  await executeAcceptedCommand(accepted(), worker(log));
  assert.deepEqual(log, ["scope", "authority", "domain"]);
});

Deno.test("initial preparation worker receives the exact accepted reference after scope validation", async () => {
  const input = accepted();
  input.command = {
    kind: "prepare-initial-tools",
    preparation: { key: "initial-tools:selection-1", revision: 11 },
  };
  delete input.origin;
  const parsed = parseAcceptedCommand(await delivery(input))!;
  const log: string[] = [], host = worker(log);
  host.prepareInitialTools = (reference) => {
    assert.deepEqual(reference, {
      key: "initial-tools:selection-1",
      revision: 11,
    });
    log.push("prepare");
    return Promise.resolve();
  };
  await executeAcceptedCommand(parsed, host);
  assert.deepEqual(log, ["scope", "prepare"]);
});

Deno.test("revoked source authority prevents the target domain effect", async () => {
  const log: string[] = [], host = worker(log);
  host.assertDelegatedAuthority = () =>
    Promise.reject(new Error("revoked grant"));
  await assert.rejects(
    executeAcceptedCommand(accepted(), host),
    /revoked grant/,
  );
  assert.deepEqual(log, ["scope"]);
});

async function canonicalOutcome(input = accepted(), refused = true) {
  const error = new OperatorAuthorityError(
    "AUTHORITY_REQUEST_STALE",
    "Policy revoked",
    {
      changeId: "change-1",
      resources: ["example.org"],
    },
  );
  const event: Event = {
    id: `operator-command-completed:${input.id}`,
    at: "2026-10-29T00:00:00.000Z",
    kind: refused ? "operator-command-refused" : "operator-command-completed",
    label: input.command.kind,
    operatorCommandOutcome: {
      format: "operator-command-outcome/v1",
      acceptedDigest: await executionDigest(input),
      revision: 3,
      result: refused ? commandRefusal(error) : { status: "succeeded" },
    },
  };
  return { events: [event], revision: 3 };
}

Deno.test("canonical command refusal roundtrips exact authority error and immutable receipt revision", async () => {
  const input = accepted(), state = await canonicalOutcome(input);
  const result = await recordedCommandOutcome({ ...state, revision: 9 }, input);
  assert.equal(result!.outcome!.revision, 3);
  assert.throws(() => throwCommandRefusal(result!.outcome), (error) => {
    assert.ok(error instanceof OperatorAuthorityError);
    assert.equal(error.code, "AUTHORITY_REQUEST_STALE");
    assert.equal(error.message, "Policy revoked");
    assert.deepEqual(error.context, {
      changeId: "change-1",
      resources: ["example.org"],
    });
    assert.deepEqual(error.recovery, { action: "refuse-and-repropose" });
    return true;
  });
  assert.equal(state.events[0].operatorCommandOutcome!.revision, 3);
});

Deno.test("canonical command result binds target identity pin command and exact originating effect", async () => {
  const input = accepted(), state = await canonicalOutcome(input);
  for (
    const change of [
      (value: AcceptedOperatorCommand) => {
        value.identity.operatorId = "foreign";
      },
      (value: AcceptedOperatorCommand) => {
        value.identity.invocationKey = "foreign";
      },
      (value: AcceptedOperatorCommand) => {
        value.modelPin.repositoryVersion = "foreign";
      },
      (value: AcceptedOperatorCommand) => {
        value.modelPin.modelDigest = "foreign";
      },
      (value: AcceptedOperatorCommand) => {
        if (value.command.kind === "decide-candidate") {
          value.command.input
            .verdict = "refuse";
        }
      },
      (value: AcceptedOperatorCommand) => {
        value.origin!.effectKey = "foreign";
      },
      (value: AcceptedOperatorCommand) => {
        value.origin!.inputMessageId = "foreign";
      },
      (value: AcceptedOperatorCommand) => {
        value.origin!.businessRevision.__assemblyRuntimeRevision.revision++;
      },
    ]
  ) {
    const foreign = structuredClone(input);
    change(foreign);
    await assert.rejects(
      recordedCommandOutcome(state, foreign),
      /does not match/,
    );
  }
});

Deno.test("canonical result refuses malformed duplicate future and untyped refusal receipts", async () => {
  const input = accepted(), state = await canonicalOutcome(input);
  const duplicate = structuredClone(state);
  duplicate.events.push(structuredClone(duplicate.events[0]));
  await assert.rejects(recordedCommandOutcome(duplicate, input), /Ambiguous/);
  await assert.rejects(
    recordedCommandOutcome({ ...state, revision: 2 }, input),
    /does not match/,
  );
  const untyped = structuredClone(state);
  delete untyped.events[0].operatorCommandOutcome;
  await assert.rejects(
    recordedCommandOutcome(untyped, input),
    /no typed refusal/,
  );
  const wrongKind = structuredClone(state);
  wrongKind.events[0].kind = "operator-command-completed";
  await assert.rejects(
    recordedCommandOutcome(wrongKind, input),
    /Invalid typed/,
  );
  const unexpected = structuredClone(state);
  Object.assign(unexpected.events[0].operatorCommandOutcome!.result, {
    execute: "approve",
  });
  await assert.rejects(recordedCommandOutcome(unexpected, input), /Unexpected/);
});

Deno.test("canonical success and historical completed events stay distinct from missing or refused outcomes", async () => {
  const input = accepted(), state = await canonicalOutcome(input, false);
  const result = await recordedCommandOutcome(state, input);
  assert.deepEqual(result!.outcome!.result, { status: "succeeded" });
  assert.doesNotThrow(() => throwCommandRefusal(result!.outcome));
  delete state.events[0].operatorCommandOutcome;
  assert.equal(
    (await recordedCommandOutcome(state, input))!.outcome,
    undefined,
  );
  assert.equal(
    await recordedCommandOutcome({ revision: 3, events: [] }, input),
    undefined,
  );
});

Deno.test("business decision baseline distinguishes a new candidate verdict from an unchanged historical verdict", () => {
  const input = accepted();
  const candidate: SystemRuntimeState["candidates"][number] = {
    id: "candidate-1",
    name: "reader",
    description: "Read supplied HTML",
    kind: "read_web_page",
    code: "export default () => ({title:'',text:''})",
    digest: "candidate-digest",
    stage: "awaiting-admission",
    createdAt: "2026-10-29T00:00:00.000Z",
    baseCatalogRevision: 0,
  };
  const state = { candidates: [candidate], events: [] as Event[] };
  const before = commandBusinessDecision(state, input.command);
  candidate.admissionDecision = {
    candidateDigest: candidate.digest,
    verdict: "refuse",
    reason: "Explicit decision",
  };
  assert.notEqual(commandBusinessDecision(state, input.command), before);
  const retained = commandBusinessDecision(state, input.command);
  candidate.error = "Later continuation failed";
  assert.equal(commandBusinessDecision(state, input.command), retained);
  if (input.command.kind === "decide-candidate") {
    input.command.input.reason = "A different command";
  }
  assert.equal(commandBusinessDecision(state, input.command), retained);
  state.events.push({
    id: "new-real-decision",
    kind: "delegated-admission-decided",
    candidateId: candidate.id,
    at: "2026-10-29T00:00:00.000Z",
    label: "Same verdict recorded",
  });
  assert.notEqual(commandBusinessDecision(state, input.command), retained);
});

Deno.test("host decision baseline is closed delegated-only and part of the exact accepted digest", async () => {
  const input = accepted();
  input.decisionBaseline = {
    format: "operator-command-decision-baseline/v1",
    digest: "a".repeat(64),
  };
  const saved = await delivery(input);
  assert.deepEqual(parseAcceptedCommand(saved), input);
  const state = await canonicalOutcome(input);
  const legacy = structuredClone(input);
  delete legacy.decisionBaseline;
  await assert.rejects(recordedCommandOutcome(state, legacy), /does not match/);
  for (
    const baseline of [
      { format: "invented", digest: "a".repeat(64) },
      {
        format: "operator-command-decision-baseline/v1",
        digest: "not-a-digest",
      },
      {
        format: "operator-command-decision-baseline/v1",
        digest: "a".repeat(64),
        execute: true,
      },
    ]
  ) {
    const forged = structuredClone(saved);
    forged.payload!.decisionBaseline = baseline;
    assert.throws(() => parseAcceptedCommand(forged), /baseline|Unexpected/);
  }
  input.command = {
    kind: "prepare-initial-tools",
    preparation: { key: "seed-key", revision: 1 },
  };
  delete input.origin;
  await assert.rejects(delivery(input), /baseline/);
});

Deno.test("first acceptance race reuses only identical command origin identity and pin", () => {
  const original = accepted(), winner = structuredClone(original);
  winner.decisionBaseline = {
    format: "operator-command-decision-baseline/v1",
    digest: "a".repeat(64),
  };
  original.decisionBaseline = {
    format: "operator-command-decision-baseline/v1",
    digest: "b".repeat(64),
  };
  assert.equal(sameAcceptedCommandIntent(winner, original), true);
  for (
    const mutate of [
      (value: AcceptedOperatorCommand) => {
        value.identity.scope.scopeId = "foreign";
      },
      (value: AcceptedOperatorCommand) => {
        value.identity.subjectId = "foreign";
      },
      (value: AcceptedOperatorCommand) => {
        value.modelPin.modelDigest = "foreign";
      },
      (value: AcceptedOperatorCommand) => {
        value.modelPin.repositoryVersion = "foreign";
      },
      (value: AcceptedOperatorCommand) => {
        value.origin!.inputMessageId = "foreign";
      },
      (value: AcceptedOperatorCommand) => {
        if (value.command.kind === "decide-candidate") {
          value.command.input
            .verdict = "refuse";
        }
      },
    ]
  ) {
    const foreign = structuredClone(winner);
    mutate(foreign);
    assert.equal(sameAcceptedCommandIntent(foreign, original), false);
  }
});
