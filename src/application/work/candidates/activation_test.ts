import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import type {
  ExecutableCatalogEntry,
  ExecutableModel,
} from "../../../domain/model/execution/executable-model.ts";
import type {
  Candidate,
  ModelBinding,
} from "../../../domain/work/candidates.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import {
  type CandidateActivationHost,
  settleActivation,
} from "./activation.ts";
import { draftDigest } from "../runtime/values.ts";
import { CandidateActivationError } from "../../../domain/work/policies/candidate-activation.ts";

const MODEL_DIGEST = "model-digest";

async function admitted(id: string): Promise<Candidate> {
  const draft = {
    name: `tool-${id}`,
    description: "Reader",
    kind: "read_web_page" as const,
    code: "export default ({html}) => ({title:'Page',text:html})",
  };
  const digest = await draftDigest(draft);
  return {
    ...draft,
    id,
    digest,
    stage: "activating",
    createdAt: "2026-01-01T00:00:00.000Z",
    baseCatalogRevision: 0,
    activationModelDigest: MODEL_DIGEST,
    tests: { passed: true, checks: [] },
    admission: {
      candidateId: id,
      candidateDigest: digest,
      mandateRevision: 1,
      authority: "reviewer",
      actorId: "reviewer",
      configurationRevision: 1,
      reason: "reviewed",
      at: "2026-01-01T00:00:00.000Z",
    },
  };
}

/** A host on a bare state: the port publishes into `catalog`, `update` applies
 * a change only when its guard holds, like the runtime does. */
async function fixture(ids: string[]) {
  const state = {
    id: "system",
    model: { systemId: "system" },
    catalogRevision: 0,
    candidates: await Promise.all(ids.map(admitted)),
    events: [],
    messages: [],
    executionModel: { version: { digest: MODEL_DIGEST } },
  } as unknown as SystemRuntimeState;
  const catalog: ExecutableCatalogEntry[] = [];
  const calls: string[] = [];
  const hooks: { publishing?: (candidate: Candidate) => Promise<void> } = {};
  const native = (): ExecutableModel =>
    ({
      version: { digest: MODEL_DIGEST },
      contracts: [{ nativeId: "contract", kind: "read_web_page" }],
      catalog: structuredClone(catalog),
    }) as unknown as ExecutableModel;
  const host: CandidateActivationHost = {
    get state() {
      return state;
    },
    ports: {
      clock: { now: () => "2026-11-03T00:00:00.000Z" },
      model: {
        readExecutableModel: () => Promise.resolve(native()),
        findCandidate: undefined,
        activateCandidate: async (_identity, candidate) => {
          calls.push(candidate.id);
          await hooks.publishing?.(candidate);
          const binding: ModelBinding = {
            elementId: `native-${candidate.id}`,
            graphPath: "fixture",
          };
          if (!catalog.some((e) => e.nativeId === binding.elementId)) {
            catalog.push({
              nativeId: binding.elementId,
              candidateId: candidate.id,
              contractId: "contract",
              name: candidate.name,
              kind: candidate.kind,
              digest: candidate.digest,
              status: "active",
            } as ExecutableCatalogEntry);
          }
          return binding;
        },
      },
    },
    update: (change, when) => {
      if (when && !when(state)) return Promise.resolve();
      change(state);
      return Promise.resolve();
    },
  };
  return { state, host, catalog, calls, hooks };
}

Deno.test("drivers of one candidate run one at a time; the waiter reports the settled state", async () => {
  const f = await fixture(["a"]);
  let release!: () => void;
  const released = new Promise<void>((resolve) => release = resolve);
  let inside!: () => void;
  const entered = new Promise<void>((resolve) => inside = resolve);
  f.hooks.publishing = async () => {
    inside();
    await released;
  };
  const retry = settleActivation.call(f.host, "a", "retry");
  await entered;
  let abandoned = false;
  const abandon = settleActivation.call(f.host, "a", "abandon").then(
    (outcome) => {
      abandoned = true;
      return outcome;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  equal(abandoned, false, "the abandon waits for the publication in flight");
  release();
  deepStrictEqual(await retry, { status: "active" });
  deepStrictEqual(await abandon, { status: "active" });
  equal(f.state.candidates[0]!.stage, "active");
  equal(f.state.candidates[0]!.errorCode, undefined);
  equal(f.state.catalogRevision, 1);
  deepStrictEqual(f.calls, ["a"], "the abandon never publishes");
});

Deno.test("drivers of different candidates do not wait for each other", async () => {
  const f = await fixture(["a", "b"]);
  let release!: () => void;
  const released = new Promise<void>((resolve) => release = resolve);
  let inside!: () => void;
  const entered = new Promise<void>((resolve) => inside = resolve);
  f.hooks.publishing = async (candidate) => {
    if (candidate.id !== "a") return;
    inside();
    await released;
  };
  const slow = settleActivation.call(f.host, "a", "retry");
  await entered;
  deepStrictEqual(await settleActivation.call(f.host, "b", "retry"), {
    status: "active",
  });
  equal(f.state.candidates[1]!.stage, "active");
  equal(f.state.candidates[0]!.stage, "activating");
  release();
  await slow;
});

Deno.test("a driver that rejects does not block the next one on its candidate", async () => {
  const f = await fixture(["a"]);
  const update = f.host.update;
  let storing = true;
  f.host.update = (change, when) =>
    storing ? Promise.reject(new Error("store down")) : update(change, when);
  await rejects(
    () => settleActivation.call(f.host, "a", "retry"),
    /store down/,
  );
  storing = false;
  deepStrictEqual(await settleActivation.call(f.host, "a", "retry"), {
    status: "active",
  });
  // Nothing is left to drive once the candidate is active.
  deepStrictEqual(await settleActivation.call(f.host, "a", "retry"), {
    status: "active",
  });
  deepStrictEqual(f.calls, ["a"]);
});

Deno.test("an unknown candidate or one without an admitted activation is refused", async () => {
  const f = await fixture(["a"]);
  await rejects(
    () => settleActivation.call(f.host, "missing", "retry"),
    /Aucune activation admise/,
  );
  delete f.state.candidates[0]!.activationModelDigest;
  f.state.candidates[0]!.stage = "proposed";
  await rejects(
    () => settleActivation.call(f.host, "a", "retry"),
    /Aucune activation admise/,
  );
  deepStrictEqual(f.calls, []);
});

Deno.test("a publication whose intent vanished is never reported as active", async () => {
  const f = await fixture(["a"]);
  // Another writer ends the admission while the port publishes.
  f.hooks.publishing = () => {
    const c = f.state.candidates[0]!;
    c.stage = "failed";
    c.errorCode = "CASE_ABANDONED";
    c.error = "Le Case a été abandonné avant la fin de l’activation.";
    delete c.activationModelDigest;
    return Promise.resolve();
  };
  const outcome = await settleActivation.call(f.host, "a", "retry");
  equal(outcome.status, "failed");
  equal(outcome.status === "failed" && outcome.code, "CASE_ABANDONED");
  equal(f.state.candidates[0]!.stage, "failed", "the record is not rewritten");
  equal(f.state.catalogRevision, 0);
  equal(f.state.events.length, 0);
});

Deno.test("a publication whose candidate left the admitted flow is interrupted, not active", async () => {
  const f = await fixture(["a"]);
  f.hooks.publishing = () => {
    const c = f.state.candidates[0]!;
    c.stage = "proposed";
    delete c.activationModelDigest;
    return Promise.resolve();
  };
  const outcome = await settleActivation.call(f.host, "a", "retry");
  equal(outcome.status, "interrupted");
  ok(
    outcome.status === "interrupted" &&
      outcome.error instanceof Error &&
      outcome.error.message.includes("n’est plus en cours"),
  );
  equal(f.state.catalogRevision, 0);
  equal(f.state.candidates[0]!.binding, undefined);
});

Deno.test("only publications actually requested count against the budget", async () => {
  const f = await fixture(["a"]);
  let readable = false;
  const read = f.host.ports.model.readExecutableModel;
  f.host.ports.model.readExecutableModel = (identity) =>
    readable ? read(identity) : Promise.reject(new Error("Toolkit down"));
  for (let trigger = 0; trigger < 12; trigger++) {
    equal(
      (await settleActivation.call(f.host, "a", "restart")).status,
      "interrupted",
    );
  }
  equal(f.state.candidates[0]!.activationAttempts, undefined);
  equal(f.state.candidates[0]!.stage, "activating");
  deepStrictEqual(f.calls, []);
  readable = true;
  deepStrictEqual(await settleActivation.call(f.host, "a", "restart"), {
    status: "active",
  });
  deepStrictEqual(f.calls, ["a"]);
});

Deno.test("new delegated publication enters the host Case guard before counting or writing", async () => {
  const f = await fixture(["a"]);
  f.state.candidates[0].admission!.authority = "delegate";
  let guarded = 0;
  f.host.withCandidatePublication = (candidate, _publish) => {
    guarded++;
    equal(candidate.id, "a");
    equal(candidate.activationAttempts, undefined);
    throw new CandidateActivationError(
      "CASE_ABANDONED",
      { candidateId: "a" },
      "The central Request was abandoned",
    );
  };
  const outcome = await settleActivation.call(f.host, "a", "retry");
  equal(outcome.status, "failed");
  equal(outcome.status === "failed" && outcome.code, "CASE_ABANDONED");
  equal(guarded, 1);
  equal(f.state.candidates[0].activationAttempts, undefined);
  deepStrictEqual(f.calls, []);
  equal(f.catalog.length, 0);
});

Deno.test("a new delegated publication without a host Case guard refuses before counting or writing", async () => {
  const f = await fixture(["a"]);
  f.state.candidates[0].admission!.authority = "delegate";
  const outcome = await settleActivation.call(f.host, "a", "retry");
  equal(outcome.status, "failed");
  equal(
    outcome.status === "failed" && outcome.code,
    "ADMISSION_AUTHORITY_INVALID",
  );
  equal(f.state.candidates[0].activationAttempts, undefined);
  deepStrictEqual(f.calls, []);
  equal(f.catalog.length, 0);
});

Deno.test("a busy delegated Case keeps its intent without counting an unattempted publication", async () => {
  const f = await fixture(["a"]);
  f.state.candidates[0].admission!.authority = "delegate";
  f.host.withCandidatePublication = () =>
    Promise.reject(new Error("The Case is reserved"));
  equal(
    (await settleActivation.call(f.host, "a", "retry")).status,
    "interrupted",
  );
  equal(f.state.candidates[0].stage, "activating");
  equal(f.state.candidates[0].activationAttempts, undefined);
  deepStrictEqual(f.calls, []);
});

Deno.test("an exact published delegate effect and local admissions keep their existing paths", async () => {
  for (const published of [false, true]) {
    const f = await fixture(["a"]);
    const candidate = f.state.candidates[0];
    if (published) {
      candidate.admission!.authority = "delegate";
      f.catalog.push({
        nativeId: "native-a",
        candidateId: candidate.id,
        contractId: "contract",
        name: candidate.name,
        kind: candidate.kind,
        digest: candidate.digest,
        status: "active",
      });
    }
    f.host.withCandidatePublication = () => {
      throw new Error(
        "An existing effect or local admission must not exercise a delegated Case guard",
      );
    };
    deepStrictEqual(await settleActivation.call(f.host, "a", "restart"), {
      status: "active",
    });
    equal(f.catalog.length, 1);
    equal(candidate.stage, "active");
    equal(candidate.binding?.elementId, "native-a");
    // Reconcile the exact existing effect without requesting another write;
    // the separately admitted local candidate still publishes once.
    deepStrictEqual(f.calls, published ? [] : ["a"]);
  }
});
