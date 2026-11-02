import assert from "node:assert/strict";
import { requestAdoptionFixture } from "../../../../test/support/request-adoption-fixture.ts";
import { parseScopedSoftwareContext } from "./scoped-software-context.ts";

Deno.test("scoped context refuses wholly and partially sparse target arrays", async () => {
  const original = await fixture();
  const partial = [original.targets[0]];
  partial.length = 2;
  for (
    const targets of [new Array<typeof original.targets[number]>(1), partial]
  ) {
    assert.throws(() => parseScopedSoftwareContext({ ...original, targets }));
  }
});

async function fixture() {
  const { target, intent } = await requestAdoptionFixture();
  const { operatorId, ...locator } = target;
  const actor = {
    ...target.host,
    executionSpaceId: target.executionSpaceId,
    operatorId,
  };
  return {
    format: "software-evolution-scope/v2",
    destination: {
      ...locator,
      expectedAdmittedSource: {
        revision: intent.candidate.sourceAdmission.revision,
        source: { ...intent.candidate.source },
        sourceDigest: intent.candidate.sourceDigest,
      },
    },
    openingBaseDigest: intent.openingBaseDigest,
    predecessorManifestDigest: intent.candidate.sourceAdmission.manifestDigest,
    actor,
    targets: [{
      target: { ...actor },
      previousPin: {
        ...structuredClone(intent.previous.pin),
        source: { ...intent.previous.pin.source },
        sourceAdmission: { ...intent.previous.pin.sourceAdmission },
      },
    }],
  };
}

Deno.test("scoped context detaches and freezes addressing without equating admitted and executed sources", async () => {
  const input = await fixture(), context = parseScopedSoftwareContext(input);
  assert.notEqual(
    context.destination.expectedAdmittedSource.source.version,
    context.targets[0].previousPin.source.version,
  );
  input.actor.operatorId = "another-actor";
  input.targets[0].previousPin.modelDigest = "0".repeat(64);
  input.destination.expectedAdmittedSource.revision++;
  assert.equal(context.actor.operatorId, "builder");
  assert.equal(context.targets[0].previousPin.modelDigest, "a".repeat(64));
  assert.equal(context.destination.expectedAdmittedSource.revision, 2);
  assert.throws(
    () =>
      Object.assign(context.targets[0].previousPin, {
        modelDigest: "0".repeat(64),
      }),
    TypeError,
  );
  assert(Object.isFrozen(context.destination.expectedAdmittedSource.source));
});

Deno.test("scoped context refuses Main, cross-host and cross-space target substitutions and duplicate instances", async () => {
  const original = await fixture();
  for (
    const mutate of [
      (v: typeof original) => {
        v.destination.executionSpaceId = "main";
      },
      (v: typeof original) => {
        v.actor.systemId = "foreign-host";
      },
      (v: typeof original) => {
        v.targets[0].target.projectId = "foreign-host";
      },
      (v: typeof original) => {
        v.targets[0].target.executionSpaceId = "other-space";
      },
      (v: typeof original) => {
        v.targets.push(structuredClone(v.targets[0]));
      },
      (v: typeof original) => {
        v.targets[0].previousPin.sourceAdmission.revision = 0;
      },
      (v: typeof original) => {
        v.targets[0].previousPin.source.repositoryId = "other-repository";
      },
    ]
  ) {
    const input = structuredClone(original);
    mutate(input);
    assert.throws(() => parseScopedSoftwareContext(input));
  }
});

Deno.test("scoped context rejects extra authority, final runtime revision and malformed nested pin fields", async () => {
  const original = await fixture();
  for (
    const input of [
      { ...original, authority: { granted: true } },
      { ...original, finalRuntimeRevision: 7 },
      {
        ...original,
        targets: [{
          ...original.targets[0],
          previousPin: { ...original.targets[0].previousPin, extra: undefined },
        }],
      },
      { ...original, actor: { ...original.actor, canAdopt: true } },
      {
        ...original,
        destination: { ...original.destination, ref: "refs/heads/main" },
      },
    ]
  ) assert.throws(() => parseScopedSoftwareContext(input));
});
