// deno-lint-ignore-file require-await -- Read-only port doubles.
import type { OperatorStorage } from "../adapters/out/postgres/host-storage.ts";
import assert from "node:assert/strict";
import { requestAdoptionFixture } from "../../test/support/request-adoption-fixture.ts";
import type { OpeningRecord } from "../domain/work/request-spaces.ts";
import type { ScopedSoftwareRuntimeTarget } from "../application/model/evolution/ports.ts";
import { captureScopedSoftwarePreparationScope } from "./scoped-software-evolution.ts";

Deno.test("each scoped preparation captures current admitted S without replacing the unchanged runtime R", async () => {
  const f = await requestAdoptionFixture();
  const ref = {
    ...f.target.host,
    executionSpaceId: f.target.executionSpaceId,
    operatorId: f.target.operatorId,
  };
  const opening = {
    id: f.target.openingId,
    scope: f.target.host,
    executionSpaceId: f.target.executionSpaceId,
    caseId: f.target.caseId,
    branchId: f.target.branchId,
    baseDigest: f.intent.openingBaseDigest,
    base: { manifest: { source: { repositoryId: f.target.repositoryId } } },
  } as OpeningRecord;
  let admissionRevision = 2;
  const actor: ScopedSoftwareRuntimeTarget<OperatorStorage> = {
    ref,
    opening,
    runtime: undefined!,
    stores: undefined!,
    readBinding: async () => ({
      state: undefined!,
      pin: f.intent.previous.pin,
      admission: f.intent.previous.admission,
    }),
    inspectNative: async () => [],
  };
  const readAdmittedSource = async () => ({
    head: {
      revision: admissionRevision,
      source: {
        repositoryId: f.target.repositoryId,
        version: `commit:${String(admissionRevision).repeat(40)}`,
      },
      sourceDigest: String(admissionRevision).repeat(64),
      manifestDigest: String(admissionRevision + 1).repeat(64),
    },
  });
  const first = await captureScopedSoftwarePreparationScope({
    actor,
    readAdmittedSource,
  });
  admissionRevision = 3;
  const next = await captureScopedSoftwarePreparationScope({
    actor,
    readAdmittedSource,
  });
  assert.equal(first.destination.expectedAdmittedSource.revision, 2);
  assert.equal(next.destination.expectedAdmittedSource.revision, 3);
  assert.notEqual(
    first.destination.expectedAdmittedSource.source.version,
    next.destination.expectedAdmittedSource.source.version,
  );
  assert.deepEqual(first.targets[0].previousPin, next.targets[0].previousPin);
  assert.deepEqual(first.actor, next.actor);
  assert(Object.isFrozen(first));
  assert(Object.isFrozen(next));
  assert.equal(first.destination.expectedAdmittedSource.revision, 2);
});
