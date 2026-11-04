import { deepStrictEqual, equal, throws } from "node:assert/strict";
import {
  projectSpaceControlAuthority,
  spaceControlChanged,
  spaceControlSourceFromModel,
} from "./space-control-source.ts";
import {
  requestControlBinding,
  requestControlModel,
  spaceControlAuthority,
} from "../../../../test/support/request-space-fixture.ts";

Deno.test("space control projection keeps current audit proof separate from unchanged effective authority", () => {
  const model = requestControlModel();
  const before = spaceControlSourceFromModel(model, requestControlBinding)!;
  const next = structuredClone(model);
  next.version.repositoryVersion = `commit:${"f".repeat(40)}`;
  next.version.digest = "f".repeat(64);
  next.ownerAuthority!.sourceIds = ["new-owner-proof"];
  next.spaceControlPolicy!.sourceIds = ["new-policy-proof"];
  next.spaceControlPolicy!.acts.reverse();
  const after = spaceControlSourceFromModel(next, requestControlBinding)!;
  equal(spaceControlChanged(before, after, requestControlBinding), false);
  equal(
    projectSpaceControlAuthority(after, requestControlBinding, "owner")
      .sourceVersion,
    next.version.repositoryVersion,
  );
  deepStrictEqual(
    projectSpaceControlAuthority(after, requestControlBinding, "owner").owner
      .sourceIds,
    ["new-owner-proof"],
  );
});
Deno.test("space control detects disappearance, disable and revision changes and refuses same identity content without bump", () => {
  const model = requestControlModel();
  const before = spaceControlSourceFromModel(model, requestControlBinding)!;
  equal(spaceControlChanged(before, null, requestControlBinding), true);
  const absent = structuredClone(model);
  delete absent.spaceControlPolicy;
  equal(spaceControlSourceFromModel(absent, requestControlBinding), null);
  for (
    const change of [
      (m: typeof model) => {
        m.spaceControlPolicy!.enabled = false;
      },
      (m: typeof model) => {
        m.spaceControlPolicy!.acts = ["revoke-execution"];
      },
      (m: typeof model) => {
        m.spaceControlPolicy!.operatorIds = ["another-operator"];
      },
      (m: typeof model) => {
        m.ownerAuthority!.rootGrantNativeId = "other-grant";
        m.spaceControlPolicy!.rootAuthority.rootGrantNativeId = "other-grant";
      },
    ]
  ) {
    const next = structuredClone(model);
    change(next);
    const after = spaceControlSourceFromModel(next, requestControlBinding)!;
    throws(
      () => spaceControlChanged(before, after, requestControlBinding),
      /strictly increased/,
    );
    after.policy.revision++;
    equal(spaceControlChanged(before, after, requestControlBinding), true);
  }
  const disabled = structuredClone(before);
  disabled.policy.enabled = false;
  disabled.policy.revision++;
  throws(
    () =>
      projectSpaceControlAuthority(disabled, requestControlBinding, "owner"),
    /unavailable/,
  );
});
Deno.test("adopted source never infers an owner/policy from runtime identity and refuses foreign binding", () => {
  const model = requestControlModel();
  const source = spaceControlSourceFromModel(model, requestControlBinding)!;
  throws(
    () =>
      projectSpaceControlAuthority(source, requestControlBinding, "foreign"),
    /unavailable/,
  );
  for (
    const binding of [
      {
        ...requestControlBinding,
        scope: { ...requestControlBinding.scope, systemId: "foreign-host" },
      },
      {
        ...requestControlBinding,
        sourceSystemNativeId: requestControlBinding.scope.systemId,
      },
    ]
  ) {
    throws(
      () => projectSpaceControlAuthority(source, binding, "owner"),
      /unavailable/,
    );
  }
  const implicit = requestControlModel(spaceControlAuthority());
  implicit.ownerAuthority!.ownerSource = "implicit-legacy";
  throws(
    () => spaceControlSourceFromModel(implicit, requestControlBinding),
    /unavailable/,
  );
});
