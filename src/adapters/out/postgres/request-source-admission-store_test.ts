import {
  deepStrictEqual,
  equal,
  notStrictEqual,
  throws,
} from "node:assert/strict";
import {
  type AdmittedSourceChain,
  requestReleaseSourceEvidence,
} from "./request-source-admission-store.ts";
import { requestSourceAdmissionDigest } from "../../../application/model/source-admission/request-source-admission.ts";
import { parseModelRevisionRef } from "../../../domain/model/value-objects/element-ref.ts";
import { admissionFixture } from "../../../../test/support/request-source-admission-fixture.ts";
import { requestReleaseFixture } from "../../../../test/support/request-release-fixture.ts";
import { spaceUuid } from "../../../../test/support/request-space-fixture.ts";

Deno.test("Release source projection uses original sparse source ordinals, never the mixed journal cursor", async () => {
  const fixture = await requestReleaseFixture();
  const opening = fixture.record;
  const baseline = {
    revision: 1,
    manifestDigest: opening.base!.manifestDigest,
    source: parseModelRevisionRef({
      repositoryId: fixture.source.repositoryId,
      version: fixture.source.sourceVersion,
    }),
    sourceDigest: fixture.source.sourceDigest,
  };
  const first = await admissionFixture(
    opening,
    baseline,
    spaceUuid(801),
    "d",
    fixture.manifest.operators[0].modelDigest,
  );
  const firstDigest = await requestSourceAdmissionDigest(first);
  const firstHead = {
    revision: 2,
    manifestDigest: firstDigest,
    source: first.result.source,
    sourceDigest: first.result.sourceDigest,
  };
  const second = await admissionFixture(
    opening,
    firstHead,
    spaceUuid(802),
    "f",
    first.result.model.digest,
  );
  const secondDigest = await requestSourceAdmissionDigest(second);
  // Projection-only synthetic input: source receipts are 2 and 4; ordinal 3
  // represents a runtime adoption and is deliberately absent from receipts.
  // The helper assumes an already verified fold; this unit does not prove one.
  const chain: AdmittedSourceChain = {
    baseline,
    head: {
      revision: 4,
      manifestDigest: secondDigest,
      source: second.result.source,
      sourceDigest: second.result.sourceDigest,
    },
    cursor: { revision: 4, digest: secondDigest },
    receipts: [
      {
        revision: 2,
        manifestDigest: firstDigest,
        payload: first,
        recordedAt: opening.createdAt,
      },
      {
        revision: 4,
        manifestDigest: secondDigest,
        payload: second,
        recordedAt: opening.createdAt,
      },
    ],
    softwareReceipts: [],
    execution: {
      pin: {
        source: first.result.source,
        modelDigest: first.result.model.digest,
        sourceAdmission: { revision: 2, manifestDigest: firstDigest },
        adoption: null,
      },
      adoptions: [],
      softwareAdoptions: [],
    },
  };
  const reference = (revision: number, manifestDigest: string) => ({
    format: "request-release-admission/v1" as const,
    openingId: opening.id,
    openingBaseDigest: opening.baseDigest!,
    revision,
    manifestDigest,
  });
  for (
    const [revision, digest, payload] of [[2, firstDigest, first], [
      4,
      secondDigest,
      second,
    ]] as const
  ) {
    const result = requestReleaseSourceEvidence(
      opening,
      chain,
      reference(revision, digest),
    );
    deepStrictEqual(result, {
      requestAdmission: reference(revision, digest),
      source: payload.result.source,
      sourceDigest: payload.result.sourceDigest,
      build: payload.result.build,
      model: payload.result.model,
    });
    notStrictEqual(result.model, payload.result.model);
  }
  equal(chain.head.revision, 4);
  equal(chain.cursor.revision, 4);
  for (
    const bad of [
      reference(3, "3".repeat(64)),
      reference(2, secondDigest),
      { ...reference(4, secondDigest), openingId: "foreign-opening" },
      { ...reference(4, secondDigest), openingBaseDigest: "0".repeat(64) },
      { ...reference(4, secondDigest), extra: true },
    ]
  ) throws(() => requestReleaseSourceEvidence(opening, chain, bad));
  throws(() =>
    requestReleaseSourceEvidence(
      { ...opening, id: "foreign-opening" },
      chain,
      reference(4, secondDigest),
    )
  );
});
