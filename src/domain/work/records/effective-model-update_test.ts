import assert from "node:assert/strict";
import {
  effectiveModelUpdate,
  effectiveModelUpdates,
} from "./effective-model-update.ts";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";

const activation = {
  journalId: "session",
  journalPosition: 5,
  activatedAt: "2026-10-27T10:00:00Z",
};

Deno.test("effective updates ignore bootstrap and same-digest source or catalog refreshes", () => {
  const before = artifactModel("builder");
  const after = structuredClone(before);
  after.version.repositoryVersion = "documentation-publication";
  after.version.sourceIds.push("documentation-source");
  after.catalog = [];
  assert.equal(effectiveModelUpdate(undefined, after, activation), undefined);
  assert.equal(effectiveModelUpdate(before, after, activation), undefined);
});

Deno.test("budgets and source evidence are model updates, not action-flow updates", () => {
  const before = artifactModel("builder");
  const after = structuredClone(before);
  after.version.digest = "budget-digest";
  after.version.repositoryVersion = "budget-source";
  after.policy.maxFlowSteps++;
  after.flows.conversation.maxSteps++;
  after.flows.conversation.source.line = 500;
  after.flows.conversation.nodes[0].source.line = 501;
  after.version.sourceIds.push("another-evidence-source");
  const update = effectiveModelUpdate(before, after, activation)!;
  assert.equal(update.kind, "model");
  assert.deepEqual(update.from, {
    digest: before.version.digest,
    repositoryVersion: before.version.repositoryVersion,
  });
  assert.deepEqual(update.to, {
    digest: "budget-digest",
    repositoryVersion: "budget-source",
  });
});

Deno.test("actual private native identities, types, edges and scheduled flows classify as action-flow updates", () => {
  const before = artifactModel("builder");
  for (
    const change of [
      (model: typeof before) => {
        model.flows.conversation.nodes[0].nativeId = "private-replacement";
      },
      (model: typeof before) => {
        model.flows.conversation.nodes[0].typeNativeId = "private-new-type";
      },
      (model: typeof before) => {
        model.flows.conversation.edges[0].guard = "input.approved";
      },
      (model: typeof before) => {
        model.caseFlows = {
          privateJob: structuredClone(model.flows.promotion),
        };
      },
    ]
  ) {
    const after = structuredClone(before);
    after.version.digest = "new-private-digest";
    change(after);
    assert.equal(
      effectiveModelUpdate(before, after, activation)?.kind,
      "action-flow",
    );
  }
});

Deno.test("flow ordering is irrelevant; repeated activation identities remain distinct and replay deduplicates", () => {
  const before = artifactModel("builder");
  const after = structuredClone(before);
  after.version.digest = "new-digest";
  after.flows.conversation.nodes.reverse();
  after.flows.conversation.edges.reverse();
  const first = effectiveModelUpdate(before, after, activation)!;
  assert.equal(first.kind, "model");
  assert.deepEqual(effectiveModelUpdate(before, after, activation), first);
  const later = effectiveModelUpdate(before, after, {
    ...activation,
    journalPosition: 9,
  })!;
  assert.notEqual(later.id, first.id);
  const events = [first, first, later].map((effectiveModelUpdate) => ({
    effectiveModelUpdate,
  }));
  assert.deepEqual(effectiveModelUpdates(events, "builder"), [first, later]);
  assert.deepEqual(effectiveModelUpdates(events, "unrelated-operator"), []);
});
