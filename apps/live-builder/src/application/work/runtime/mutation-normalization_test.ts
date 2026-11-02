import { deepStrictEqual, equal } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import { modelContextTools } from "../../../domain/model/consultation/context.ts";
import { normalizeRuntimeMutation } from "./mutation-normalization.ts";

for (
  const [read, revision, allowed] of [
    [true, true, true],
    [true, false, true],
    [false, false, false],
    [undefined, true, true],
    [undefined, false, false],
  ] as const
) {
  Deno.test(`mutation model tools read=${read}, revision=${revision} follow read authority`, () => {
    const model = executableFixture({
      projectId: "p",
      editingContextId: "e",
      rootId: "r",
      systemId: "s",
      catalogId: "c",
      builderId: "operator",
    });
    model.policy.mayProposeSysmlRevision = revision;
    if (read !== undefined) model.policy.mayConsultModel = read;
    else delete model.policy.mayConsultModel;
    const previous: SystemRuntimeState = {
      id: "session",
      revision: 1,
      catalogRevision: 0,
      messages: [],
      candidates: [],
      events: [],
      busy: false,
      phase: "ready",
      provider: "test",
      executionModel: model,
    };
    for (const catalog of [undefined, modelContextTools().slice(0, 2)]) {
      const next = structuredClone(previous);
      normalizeRuntimeMutation(previous, next, {
        hasConsultModel: true,
        modelTools: catalog,
      });
      deepStrictEqual(
        next.modelTools,
        allowed ? catalog ?? modelContextTools() : [],
      );
      equal(next.revision, 2);
      normalizeRuntimeMutation(previous, next, { hasConsultModel: false });
      equal(next.modelTools, undefined);
    }
  });
}
