import assert from "node:assert/strict";
import {
  initialize,
  type RuntimeInitializationHost,
} from "./initialization.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import { requestControlModel } from "../../../../test/support/request-space-fixture.ts";

/** Crash after the real initialization helper's first durable CAS. No ordinary
 * recovery, scheduler, provider or model-authoring operation can precede it. */
for (const supplied of [false, true]) {
  Deno.test(`ordinary initialization first commit retains the admitted model before interruption (supplied=${supplied})`, async () => {
    const initial = requestControlModel();
    const head = structuredClone(initial);
    head.version.digest = "e".repeat(64);
    head.version.repositoryVersion = `commit:${"e".repeat(40)}`;
    let stored: SystemRuntimeState | null = null;
    const history: SystemRuntimeState[] = [];
    let initializations = 0, interrupt = true;
    const crash = new Error("Interrupted after first durable state commit");
    const forbidden = () => {
      throw new Error("Unexpected active initialization port");
    };
    const source = {
      initialize: () => {
        initializations++;
        return Promise.resolve(head.identity);
      },
      readExecutableModel: () => Promise.resolve(head),
      activateCandidate: forbidden,
      findCandidate: forbidden,
    };
    const host = (
      model: RuntimeInitializationHost["ports"]["model"],
    ): RuntimeInitializationHost => ({
      state: undefined!,
      runtimeRecorded: false,
      stage: forbidden,
      ports: {
        model,
        agents: { label: "controlled" },
        clock: { now: () => "2026-10-29T00:00:00Z" },
        caseNumbers: { allocate: forbidden },
        store: {
          load: () => Promise.resolve(structuredClone(stored)),
          save(next, expected) {
            assert.equal(expected, stored?.revision ?? null);
            stored = structuredClone(next);
            history.push(structuredClone(next));
            if (interrupt) throw crash;
            return Promise.resolve();
          },
        },
      },
      async update(change) {
        const next = structuredClone(this.state);
        change(next);
        next.revision++;
        await this.ports.store.save(next, this.state.revision);
        this.state = next;
      },
    });
    await assert.rejects(
      () => initialize.call(host(source), supplied ? initial : undefined),
      (error) => error === crash,
    );
    const baseline = history[0];
    assert.equal(history.length, 1);
    assert.equal(baseline.revision, 0);
    assert.deepEqual(baseline.model, (supplied ? initial : head).identity);
    assert.deepEqual(baseline.executionModel, supplied ? initial : head);
    assert.equal(initializations, supplied ? 0 : 1);
    assert.deepEqual(baseline.messages, []);
    assert.deepEqual(baseline.events, []);
    assert.equal(baseline.cases, undefined);
    interrupt = false;
    const reopened = host({
      ...source,
      initialize: forbidden,
      readExecutableModel: forbidden,
    });
    await initialize.call(reopened);
    assert.equal(history.length, 2);
    assert.deepEqual(history[0], baseline);
    assert.deepEqual(reopened.state.executionModel, baseline.executionModel);
    assert.deepEqual(reopened.state.model, baseline.model);
    assert.equal(reopened.state.id, baseline.id);
    assert.equal(reopened.state.revision, 1);
    assert.equal(reopened.runtimeRecorded, true);
  });
}
