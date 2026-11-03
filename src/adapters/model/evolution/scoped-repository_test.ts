import assert from "node:assert/strict";
import { requestAdoptionFixture } from "../../../../test/support/request-adoption-fixture.ts";
import { parseScopedSoftwareContext } from "../../../application/model/evolution/scoped-software-context.ts";
import {
  assertScopedPublicationSettled,
  scopedEvolutionCategoryClosure,
  scopedEvolutionHistoricalSource,
} from "./scoped-repository.ts";
import { EvolutionError } from "../../../application/model/evolution/ports.ts";
import { ModelPublicationError } from "../../../application/model/publication/service.ts";
import type { GitModelRepository } from "../../out/git/repository.ts";

Deno.test("historical software source uses original scope after the current head advances", async () => {
  const { target, intent } = await requestAdoptionFixture();
  const { operatorId, ...destination } = target;
  const actor = {
    ...target.host,
    executionSpaceId: target.executionSpaceId,
    operatorId,
  };
  const scope = parseScopedSoftwareContext({
    format: "software-evolution-scope/v2",
    destination: {
      ...destination,
      expectedAdmittedSource: {
        revision: intent.candidate.sourceAdmission.revision,
        source: intent.candidate.source,
        sourceDigest: intent.candidate.sourceDigest,
      },
    },
    openingBaseDigest: intent.openingBaseDigest,
    predecessorManifestDigest: intent.candidate.sourceAdmission.manifestDigest,
    actor,
    targets: [{ target: actor, previousPin: intent.previous.pin }],
  });
  const advanced = {
    ...scope,
    destination: {
      ...scope.destination,
      expectedAdmittedSource: {
        ...scope.destination.expectedAdmittedSource,
        revision: scope.destination.expectedAdmittedSource.revision + 1,
      },
    },
  };
  let captured: typeof scope | undefined;
  let guard: (() => Promise<void>) | undefined;
  const facade = { proposal: () => Promise.resolve({ id: "old-proposal" }) };
  const repository = {
    scopedSoftwarePreparationRepository(
      input: { scope: typeof scope; assertCurrent(): Promise<void> },
    ) {
      captured = input.scope;
      guard = input.assertCurrent;
      return facade;
    },
  } as unknown as Pick<
    GitModelRepository,
    "scopedSoftwarePreparationRepository"
  >;
  const original = scopedEvolutionHistoricalSource(repository, scope);
  assert.equal(original, facade);
  assert.deepEqual(captured, scope);
  assert.notDeepEqual(captured, advanced);
  assert.equal((await original.proposal("old-proposal")).id, "old-proposal");
  await assert.rejects(() => guard!(), /Historical source is read-only/);
});

Deno.test("scoped categories cover both source and actual execution deltas", () => {
  const effect = (targetNativeId: string, category: "flow" | "memory") => ({
    targetNativeId,
    systemQualifiedName: "System",
    category,
    before: {},
    after: {},
  });
  assert.deepEqual(
    scopedEvolutionCategoryClosure(["instructions"], [
      effect("bo", "flow"),
      effect("bo", "memory"),
    ], ["bo"]),
    ["flow", "instructions", "memory"],
  );
  assert.throws(() =>
    scopedEvolutionCategoryClosure(
      ["instructions"],
      [effect("other", "flow")],
      ["bo"],
    )
  );
  assert.throws(() =>
    scopedEvolutionCategoryClosure(["instructions"], [], ["bo"])
  );
});

Deno.test("scoped publication preserves durable terminal failures while active entries remain pending", () => {
  for (
    const state of [
      "queued",
      "preparing",
      "prepared",
      "publishing",
      "retryable",
    ] as const
  ) {
    assert.throws(
      () => assertScopedPublicationSettled("command", { state }),
      (error: unknown) =>
        error instanceof EvolutionError &&
        error.code === "EVOLUTION_PUBLICATION_PENDING",
    );
  }
  for (
    const [state, code] of [
      ["needs-decision", "NEEDS_DECISION"],
      ["refused", "REFUSED"],
    ] as const
  ) {
    assert.throws(
      () =>
        assertScopedPublicationSettled("command", {
          state,
          lastError: {
            code: "RETRY_BUDGET_EXHAUSTED",
            message: "Original durable failure",
          },
        }),
      (error: unknown) =>
        error instanceof ModelPublicationError && error.code === code &&
        error.context.changeId === "command" &&
        error.context.reason === "RETRY_BUDGET_EXHAUSTED" &&
        error.message === "Original durable failure",
    );
  }
  assert.doesNotThrow(() =>
    assertScopedPublicationSettled("command", {
      state: "published",
      publishedVersion: "version",
    })
  );
});
