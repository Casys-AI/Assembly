import { mutableTestSnapshot } from "../../../../test/support/mutable-test-snapshot.ts";
import assert from "node:assert/strict";
import {
  normalOwnerEnvelope as ownerEnvelope,
  normalOwnerInput as ownerInput,
  normalSourceOwnerMetadata as normal,
} from "../../../../test/support/request-source-owner.ts";
import { OWNER_AUTHORITY_IDENTITY_FIELDS } from "../../../domain/governance/authority.ts";
import {
  captureRequestSourceOwnerPhase,
  parseRequestSourceOwnerAuthority,
  parseRequestSourceOwnerPhaseBinding,
  requestSourceOwnerAuthorityDigest,
  RequestSourceOwnerError,
} from "./request-source-owner.ts";

const input = () => mutableTestSnapshot(ownerInput());
const envelope = () => mutableTestSnapshot(ownerEnvelope());

Deno.test("actual normal-source modeled RootGrant joins exact prior A0 and keeps independent original sessions", () => {
  const captured = envelope(),
    parsed = parseRequestSourceOwnerAuthority(captured);
  assert.deepEqual(parsed, captured);
  assert.notEqual(
    parsed.proposal.principal.controller.sessionId,
    parsed.acceptance.principal.controller.sessionId,
  );
  assert.equal(parsed.proposal.exercise.action, "model-revision");
  assert.equal(parsed.acceptance.exercise.outOfMandate, false);
  assert.deepEqual(
    parsed.proposal.principal.priorOwner,
    normal.priorModel.ownerAuthority,
  );
  assert.notEqual(
    parsed.proposal.destination.host.systemId,
    parsed.proposal.principal.priorOwner.systemId,
    "Actual host and native system namespaces remain distinct",
  );
  const separated = input();
  separated.controller.ownerId = "host-channel-owner";
  separated.context.openingOwnerId = "host-channel-owner";
  captureRequestSourceOwnerPhase({ ...separated, phase: "proposal" });
  const provenance = input();
  provenance.controller.authority.owner.sourceIds = [
    "other-valid-control-source-provenance",
  ];
  captureRequestSourceOwnerPhase({ ...provenance, phase: "proposal" });
});
Deno.test("prior owner join rejects every changed owner root or mandate identity without legacy fallback", () => {
  for (const key of OWNER_AUTHORITY_IDENTITY_FIELDS) {
    const value = input();
    Object.assign(value.controller.authority.owner, {
      [key]: key === "mandateRevision"
        ? value.controller.authority.owner.mandateRevision + 1
        : key === "ownerSource"
        ? "implicit-legacy"
        : `${value.controller.authority.owner[key]}-changed`,
    });
    assert.throws(
      () => captureRequestSourceOwnerPhase({ ...value, phase: "proposal" }),
      RequestSourceOwnerError,
      key,
    );
  }
  const missing = input();
  delete missing.context.priorModel.ownerAuthority;
  assert.throws(() =>
    captureRequestSourceOwnerPhase({ ...missing, phase: "proposal" })
  );
  const legacy = input();
  legacy.context.priorModel.ownerAuthority!.ownerSource = "implicit-legacy";
  assert.throws(() =>
    captureRequestSourceOwnerPhase({ ...legacy, phase: "proposal" })
  );
  const root = input();
  root.context.priorModel.ownerAuthority!.rootGrantNativeId = "";
  assert.throws(() =>
    captureRequestSourceOwnerPhase({ ...root, phase: "proposal" })
  );
});
Deno.test("prior owner join refuses wrong host opening owner operator source version and unsafe credential revisions", () => {
  for (
    const mutate of [
      (v: ReturnType<typeof input>) => {
        v.context.openingOwnerId = "other-host-owner";
      },
      (v: ReturnType<typeof input>) => {
        v.context.destination.host.systemId = "other-host";
      },
      (v: ReturnType<typeof input>) => {
        v.binding.sourceSystemNativeId = "other-native-system";
      },
      (v: ReturnType<typeof input>) => {
        v.context.targetOperatorId = "other-operator";
      },
      (v: ReturnType<typeof input>) => {
        v.context.priorModel.version.repositoryVersion = `commit:${
          "f".repeat(40)
        }`;
      },
      (v: ReturnType<typeof input>) => {
        v.context.priorModel.version.authoritySchema = undefined;
      },
      (v: ReturnType<typeof input>) => {
        v.sessionRevision = 0.5;
      },
      (v: ReturnType<typeof input>) => {
        v.controller.capabilityRevision = Number.MAX_SAFE_INTEGER + 1;
      },
    ]
  ) {
    const value = input();
    mutate(value);
    assert.throws(() =>
      captureRequestSourceOwnerPhase({ ...value, phase: "proposal" })
    );
  }
});
Deno.test("closed authority snapshots reject software casts recovery extras missing decisions changed A1 and changed roots", () => {
  for (
    const mutate of [
      (v: ReturnType<typeof envelope>) => {
        Object.assign(v.acceptance.principal, { kind: "runtime-operator" });
      },
      (v: ReturnType<typeof envelope>) => {
        Object.assign(v.acceptance.principal.controller, {
          actorId: "software",
        });
      },
      (v: ReturnType<typeof envelope>) => {
        Object.assign(v.acceptance.exercise, { reason: "local recovery" });
      },
      (v: ReturnType<typeof envelope>) => {
        v.acceptance.exercise.outOfMandate = true;
      },
      (v: ReturnType<typeof envelope>) => {
        v.acceptance.phase = "proposal" as "acceptance";
      },
      (v: ReturnType<typeof envelope>) => {
        v.acceptance.destination.caseId = "another-request";
      },
      (v: ReturnType<typeof envelope>) => {
        v.acceptance.priorModel.version.digest = "a".repeat(64);
        v.acceptance.exercise.baseModelDigest = "a".repeat(64);
      },
      (v: ReturnType<typeof envelope>) => {
        v.acceptance.capturedAt = "not-a-clock";
      },
    ]
  ) {
    const value = envelope();
    mutate(value);
    assert.throws(() => parseRequestSourceOwnerAuthority(value));
  }
  assert.throws(() =>
    parseRequestSourceOwnerAuthority({ ...envelope(), proposal: undefined })
  );
  assert.throws(() =>
    parseRequestSourceOwnerPhaseBinding(envelope().proposal, "acceptance")
  );
  const changedRoot = envelope();
  changedRoot.acceptance.principal.priorOwner.rootGrantId = "new-root";
  changedRoot.acceptance.principal.controller.authority.owner.rootGrantId =
    "new-root";
  changedRoot.acceptance.exercise.rootGrantId = "new-root";
  assert.throws(() => parseRequestSourceOwnerAuthority(changedRoot));
});
Deno.test("authority digest snapshots before await and does not overwrite original proposal capture", async () => {
  const value = envelope(),
    original = structuredClone(value),
    pending = requestSourceOwnerAuthorityDigest(value);
  value.acceptance.principal.controller.sessionId = "later-session";
  assert.equal(
    await pending,
    await requestSourceOwnerAuthorityDigest(original),
  );
  assert.notEqual(
    await pending,
    await requestSourceOwnerAuthorityDigest(value),
  );
  assert.deepEqual(
    parseRequestSourceOwnerAuthority(original).proposal,
    original.proposal,
  );
});
