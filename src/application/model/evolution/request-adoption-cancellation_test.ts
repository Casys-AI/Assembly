import assert from "node:assert/strict";
import { assertRequestCancellationNativePins } from "./request-adoption-cancellation.ts";
import { requestAdoptionFixture } from "../../../../test/support/request-adoption-fixture.ts";
Deno.test("no-effect cancellation checks both physical pins and preserves only proved retired lineage", async () => {
  const { previous, model } = await requestAdoptionFixture();
  const old = {
    digest: previous.version.digest,
    repositoryVersion: previous.version.repositoryVersion!,
  };
  const candidate = {
    digest: model.version.digest,
    repositoryVersion: model.version.repositoryVersion!,
  };
  const historic = {
    digest: "0".repeat(64),
    repositoryVersion: `commit:${"0".repeat(40)}`,
  };
  const authorized = (pin: typeof old) => ({
    modelDigest: pin.digest,
    repositoryVersion: pin.repositoryVersion,
  });
  const run = (pin: typeof old) => ({
    identity: previous.identity,
    version: { ...previous.version, ...pin },
    flowRootId: "flow",
    flowOccurrenceId: "occurrence",
    maxSteps: 128,
    profile: null,
  });
  const expected = {
    identity: previous.identity,
    previous: old,
    candidate,
    executed: [historic, old],
  };
  assert.doesNotThrow(() =>
    assertRequestCancellationNativePins([{
      retired: false,
      authorizedPin: authorized(old),
      runPin: run(old),
    }, {
      retired: true,
      authorizedPin: authorized(historic),
      runPin: run(historic),
    }], expected)
  );
  for (
    const observation of [
      {
        retired: false,
        authorizedPin: authorized(candidate),
        runPin: run(old),
      },
      {
        retired: true,
        authorizedPin: authorized(candidate),
        runPin: run(candidate),
      },
      { retired: true, authorizedPin: authorized(candidate), runPin: null },
      {
        retired: false,
        authorizedPin: authorized(historic),
        runPin: run(historic),
      },
      {
        retired: true,
        authorizedPin: {
          modelDigest: "1".repeat(64),
          repositoryVersion: old.repositoryVersion,
        },
        runPin: null,
      },
      { retired: true, authorizedPin: {}, runPin: run(old) },
      { retired: true, authorizedPin: null, runPin: null },
      {
        retired: true,
        authorizedPin: authorized(old),
        runPin: {
          ...run(old),
          identity: { ...previous.identity, builderId: "foreign" },
        },
      },
    ]
  ) {
    assert.throws(() =>
      assertRequestCancellationNativePins([observation], expected)
    );
  }
});
