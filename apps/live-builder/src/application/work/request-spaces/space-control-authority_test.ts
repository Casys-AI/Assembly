import { equal, rejects } from "node:assert/strict";
import {
  type CurrentSpaceControlSourcePort,
  ModeledSpaceControlAuthority,
} from "./space-control-authority.ts";
import {
  requestControlAdoptedState,
  requestControlBinding,
  spaceControlAuthority,
} from "../../../../test/support/request-space-fixture.ts";
Deno.test("space control requires an explicit current modeled policy with exact owner/mandate/issuer", async () => {
  const authority = spaceControlAuthority();
  let current: Awaited<ReturnType<CurrentSpaceControlSourcePort["read"]>> =
    null;
  const reader = new ModeledSpaceControlAuthority({
    read: () => Promise.resolve(current),
    capture: () =>
      Promise.resolve({
        source: structuredClone(current),
        adoptedState: requestControlAdoptedState(),
      }),
  }, requestControlBinding);
  await rejects(() => reader.current("owner"), /modeled space-control act/);
  current = {
    binding: structuredClone(requestControlBinding),
    sourceVersion: authority.sourceVersion,
    modelDigest: authority.modelDigest,
    owner: authority.owner,
    policy: {
      id: "policy",
      revision: 1,
      enabled: true,
      holderNativeId: authority.owner.operatorNativeId,
      mandateNativeId: authority.owner.mandateNativeId,
      issuerRootNativeId: authority.owner.rootAuthorityNativeId,
      operatorIds: ["operator"],
      acts: authority.acts,
    },
  };
  equal((await reader.current("owner")).policyId, "policy");
  current.policy.enabled = false;
  await rejects(() => reader.current("owner"), /modeled space-control act/);
  current.policy.enabled = true;
  current.policy.issuerRootNativeId = "foreign-root";
  await rejects(() => reader.current("owner"), /modeled space-control act/);
  current.policy.issuerRootNativeId = authority.owner.rootAuthorityNativeId;
  current.policy.acts = ["revoke-execution"];
  await rejects(() => reader.current("owner"), /modeled space-control act/);
});

Deno.test("space control binds the host instance to the independently admitted native system", async () => {
  const authority = spaceControlAuthority();
  const valid: NonNullable<
    Awaited<ReturnType<CurrentSpaceControlSourcePort["read"]>>
  > = {
    binding: structuredClone(requestControlBinding),
    sourceVersion: authority.sourceVersion,
    modelDigest: authority.modelDigest,
    owner: authority.owner,
    policy: {
      id: authority.policyId,
      revision: authority.policyRevision,
      enabled: true,
      holderNativeId: authority.owner.operatorNativeId,
      mandateNativeId: authority.owner.mandateNativeId,
      issuerRootNativeId: authority.owner.rootAuthorityNativeId,
      operatorIds: authority.operatorIds,
      acts: authority.acts,
    },
  };
  let current = structuredClone(valid);
  const expected = structuredClone(requestControlBinding);
  const reader = new ModeledSpaceControlAuthority({
    read: () => Promise.resolve(current),
    capture: () =>
      Promise.resolve({
        source: structuredClone(current),
        adoptedState: requestControlAdoptedState(),
      }),
  }, expected);
  // The constructor snapshots the host binding; callers cannot retarget it.
  expected.scope.systemId = "mutated-host";
  expected.sourceSystemNativeId = "mutated-native";
  const resolved = await reader.current("owner");
  equal(resolved.scope.systemId, requestControlBinding.scope.systemId);
  equal(resolved.owner.systemId, requestControlBinding.sourceSystemNativeId);
  equal(
    resolved.sourceSystemNativeId,
    requestControlBinding.sourceSystemNativeId,
  );
  equal(resolved.owner.systemId === resolved.scope.systemId, false);
  for (
    const change of [
      (value: typeof valid) => {
        value.binding.scope.systemId = "foreign-host";
      },
      (value: typeof valid) => {
        value.binding.scope.projectId = "foreign-project";
      },
      (value: typeof valid) => {
        value.owner.systemId = "foreign-native";
      },
      (value: typeof valid) => {
        value.binding.sourceSystemNativeId = "foreign-native";
      },
      (value: typeof valid) => {
        value.binding.sourceSystemNativeId = "foreign-native";
        value.owner.systemId = "foreign-native";
      },
    ]
  ) {
    current = structuredClone(valid);
    change(current);
    await rejects(() => reader.current("owner"), /modeled space-control act/);
  }
});

Deno.test("local issuance captures authority and adopted-state precondition atomically without a second read", async () => {
  const authority = spaceControlAuthority();
  const source = {
    binding: structuredClone(requestControlBinding),
    sourceVersion: authority.sourceVersion,
    modelDigest: authority.modelDigest,
    owner: authority.owner,
    policy: {
      id: authority.policyId,
      revision: authority.policyRevision,
      enabled: true,
      holderNativeId: authority.owner.operatorNativeId,
      mandateNativeId: authority.owner.mandateNativeId,
      issuerRootNativeId: authority.owner.rootAuthorityNativeId,
      operatorIds: authority.operatorIds,
      acts: authority.acts,
    },
  };
  const reader = new ModeledSpaceControlAuthority({
    read() {
      throw new Error("Issuance must not separately read or recapture");
    },
    capture: () =>
      Promise.resolve({ source, adoptedState: requestControlAdoptedState(7) }),
  }, requestControlBinding);
  const captured = await reader.capture("owner");
  equal(captured.authority.sourceVersion, source.sourceVersion);
  equal(captured.adoptedState.revision, 7);
  equal(captured.adoptedState.systemId, requestControlBinding.scope.systemId);
});
