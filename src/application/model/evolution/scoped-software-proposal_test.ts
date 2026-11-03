import assert from "node:assert/strict";
import { requestAdoptionFixture } from "../../../../test/support/request-adoption-fixture.ts";
import { evolutionProposalDigest } from "../../../domain/model/evolution/proposal-digest.ts";
import { parseModelRevisionId } from "../../../domain/shared-kernel/revision-id.ts";
import {
  parseScopedSoftwareProposal,
  scopedSoftwareProposalDigest,
} from "./scoped-software-proposal.ts";

Deno.test("scoped proposal parsers and digest reject sparse context targets, candidates and categories", async () => {
  for (const field of ["context-targets", "targets", "categories"] as const) {
    const input = await fixture();
    if (field === "context-targets") {
      input.context.targets = new Array<typeof input.context.targets[number]>(
        input.context.targets.length,
      );
    } else if (field === "targets") {
      input.targets = new Array<typeof input.targets[number]>(
        input.context.targets.length,
      );
    } else input.categories = new Array<string>(1);
    assert.throws(() => parseScopedSoftwareProposal(input));
    await assert.rejects(() => scopedSoftwareProposalDigest(input));
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
  const targets = [actor, { ...actor, operatorId: "peer" }];
  return {
    format: "software-evolution-scoped/v2",
    context: {
      format: "software-evolution-scope/v2",
      destination: {
        ...locator,
        expectedAdmittedSource: {
          revision: 2,
          source: { ...intent.candidate.source },
          sourceDigest: intent.candidate.sourceDigest,
        },
      },
      openingBaseDigest: intent.openingBaseDigest,
      predecessorManifestDigest:
        intent.candidate.sourceAdmission.manifestDigest,
      actor,
      targets: targets.map((ref) => ({
        target: { ...ref },
        previousPin: { ...structuredClone(intent.previous.pin) },
      })),
    },
    sourceAssessmentDigest: "b".repeat(64),
    targets: targets.map((ref) => ({
      target: { ...ref },
      candidateDigest: "c".repeat(64),
    })),
    categories: ["flow", "instructions"],
  };
}

Deno.test("same native operators in two Cases cannot share a scoped proposal digest", async () => {
  const a = await fixture(), b = structuredClone(a);
  const branchId = "abcdefab-1234-1234-1234-123456789abc";
  Object.assign(b.context.destination, {
    caseId: "case_B",
    openingId: "opening_B",
    executionSpaceId: "space_B",
    branchId,
    ref: `refs/heads/requests/${branchId}`,
  });
  b.context.actor.executionSpaceId = "space_B";
  for (const entry of [...b.context.targets, ...b.targets]) {
    entry.target.executionSpaceId = "space_B";
  }
  assert.notEqual(
    await scopedSoftwareProposalDigest(a),
    await scopedSoftwareProposalDigest(b),
  );
});

Deno.test("branch, source, actor, previous pin, candidate, category and assessment movement change the signed preimage", async () => {
  const original = await fixture(),
    baseline = await scopedSoftwareProposalDigest(original);
  for (
    const mutate of [
      (v: typeof original) => {
        v.context.destination.branchId = "abcdefab-1234-1234-1234-123456789abc";
        v.context.destination.ref =
          `refs/heads/requests/${v.context.destination.branchId}`;
      },
      (v: typeof original) => {
        v.context.destination.expectedAdmittedSource.source.version =
          parseModelRevisionId(`commit:${"9".repeat(40)}`);
      },
      (v: typeof original) => {
        v.context.actor.operatorId = "different-preparer";
      },
      (v: typeof original) => {
        v.context.targets[0].target.operatorId = "different-target";
        v.targets[0].target.operatorId = "different-target";
      },
      (v: typeof original) => {
        v.context.targets[0].previousPin.modelDigest = "d".repeat(64);
      },
      (v: typeof original) => {
        v.targets[0].candidateDigest = "d".repeat(64);
      },
      (v: typeof original) => {
        v.categories = ["flow"];
      },
      (v: typeof original) => {
        v.sourceAssessmentDigest = "d".repeat(64);
      },
    ]
  ) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.notEqual(await scopedSoftwareProposalDigest(changed), baseline);
  }
});

Deno.test("scoped proposal ordering is stable and caller mutation cannot move an in-flight digest", async () => {
  const original = await fixture(), changed = structuredClone(original);
  changed.targets.reverse();
  changed.context.targets.reverse();
  changed.categories.reverse();
  const baseline = await scopedSoftwareProposalDigest(original);
  assert.equal(await scopedSoftwareProposalDigest(changed), baseline);
  const parsed = parseScopedSoftwareProposal(changed);
  const pending = scopedSoftwareProposalDigest(changed);
  changed.targets[0].candidateDigest = "f".repeat(64);
  changed.context.targets[0].previousPin.modelDigest = "f".repeat(64);
  assert.equal(await pending, baseline);
  assert.equal(await scopedSoftwareProposalDigest(parsed), baseline);
  assert(Object.isFrozen(parsed.targets[0]));
  assert(Object.isFrozen(parsed.categories));
});

Deno.test("scoped proposal refuses missing, duplicate, cross-context and forged target/category fields", async () => {
  const original = await fixture();
  for (
    const mutate of [
      (v: typeof original) => {
        v.targets.pop();
      },
      (v: typeof original) => {
        v.targets[1] = structuredClone(v.targets[0]);
      },
      (v: typeof original) => {
        v.targets[0].target.systemId = "foreign";
      },
      (v: typeof original) => {
        v.targets[0].target.executionSpaceId = "space_B";
      },
      (v: typeof original) => {
        v.categories = ["flow", "flow"];
      },
      (v: typeof original) => {
        v.categories = ["unsupported"];
      },
      (v: typeof original) => {
        Object.assign(v.targets[0].target, { hidden: undefined });
      },
      (v: typeof original) => {
        Object.assign(v, { humanDecision: {} });
      },
    ]
  ) {
    const input = structuredClone(original);
    mutate(input);
    await assert.rejects(() => scopedSoftwareProposalDigest(input));
  }
});

Deno.test("legacy software proposal digest retains its v1 encoding independently of scoped proposals", async () => {
  const digest = await evolutionProposalDigest({
    before: {
      version: `commit:${"1".repeat(40)}`,
      sourceDigest: "b".repeat(64),
    },
    after: {
      sources: {},
      elements: [],
      documents: [],
      sourceDigest: "c".repeat(64),
      semanticDigest: "d".repeat(64),
      provenanceDigest: "e".repeat(64),
      sourceHashes: {},
      engineVersion: "1",
    },
    recipeDigest: "f".repeat(64),
    targets: [{
      operatorId: "builder",
      previousDigest: "a".repeat(64),
      candidateDigest: "0".repeat(64),
    }],
    categories: ["flow"],
  });
  assert.equal(
    digest,
    "cb1ebd9b8ae98fe9d5fda8fe1a18074c34fd892b8a847f0aa25fa86c72107ff5",
  );
});
