/** Spec 4.8c, contracts C1/C3: composite identity and the effective scope of a
 * delegated policy in the space where it is read. */
import { deepStrictEqual, equal } from "node:assert/strict";
import {
  type ExecutionSpaceRef,
  MAIN_EXECUTION_SPACE_ID,
  sameScopedOperator,
} from "../authority.ts";
import {
  type DelegationSubjects,
  namesHolderInstance,
  policyCovers,
  policyHolder,
  policyRecipients,
  policyScopeRefusal,
} from "./delegation-scope.ts";

const host = { projectId: "unit", systemId: "system" };
const space = (executionSpaceId: string): ExecutionSpaceRef => ({
  ...host,
  executionSpaceId,
});
const ref = (executionSpaceId: string, operatorId: string) => ({
  ...space(executionSpaceId),
  operatorId,
});
/** The BO shares the MO native ID: only the space distinguishes them. */
const MO = ref("main", "operator");
const BO_X = ref("case-x", "operator");
const BO_Y = ref("case-y", "operator");

Deno.test("4.8c C1: composite identity distinguishes the MO from its BO despite one native ID", () => {
  equal(MAIN_EXECUTION_SPACE_ID, "main");
  equal(sameScopedOperator(MO, { ...MO }), true);
  equal(sameScopedOperator(MO, BO_X), false);
  equal(sameScopedOperator(BO_X, BO_Y), false);
  equal(sameScopedOperator(MO, { ...MO, systemId: "other-system" }), false);
});

Deno.test("4.8c C3: a main mandate naming BO@X lets MO@main decide for that BO only", () => {
  const mandate: DelegationSubjects = {
    holderNativeId: "operator",
    recipients: ["operator"],
    recipientExecutionSpaceId: "case-x",
  };
  deepStrictEqual(policyHolder(space("main"), mandate), MO);
  deepStrictEqual(policyRecipients(space("main"), mandate), [BO_X]);
  equal(
    policyCovers({
      space: space("main"),
      policy: mandate,
      actor: MO,
      requester: BO_X,
    }),
    true,
    "MO@main ≠ BO@X: same native ID is not self-approval",
  );
  equal(
    policyCovers({
      space: space("main"),
      policy: mandate,
      actor: MO,
      requester: BO_Y,
    }),
    false,
    "another BO is not covered",
  );
  equal(
    policyScopeRefusal({
      space: space("main"),
      policy: mandate,
      actor: BO_X,
      requester: BO_X,
    }),
    "actor-not-holder",
    "the BO is not the holder of a main policy",
  );
});

Deno.test("4.8c C3: a legacy main policy copied into a branch by a Release is mirrored on that branch's instances", () => {
  // Legacy array form: no explicit space, relative to the reading space.
  const copied: DelegationSubjects = {
    holderNativeId: "operator",
    recipients: ["research"],
  };
  deepStrictEqual(policyHolder(space("case-x"), copied), BO_X);
  deepStrictEqual(policyRecipients(space("case-x"), copied), [
    ref("case-x", "research"),
  ]);
  equal(
    policyCovers({
      space: space("case-x"),
      policy: copied,
      actor: BO_X,
      requester: ref("case-x", "research"),
    }),
    true,
    "the Release makes its delegations effective in the branch at creation",
  );
  // The same content keeps its legacy meaning in main.
  equal(
    policyCovers({
      space: space("main"),
      policy: copied,
      actor: MO,
      requester: ref("main", "research"),
    }),
    true,
  );
});

Deno.test("4.8c C3: a policy read in a branch never designates or covers an instance outside that branch", () => {
  const copied: DelegationSubjects = {
    holderNativeId: "operator",
    recipients: ["research"],
  };
  for (
    const [actor, requester] of [
      [MO, ref("case-x", "research")],
      [MO, ref("main", "research")],
      [BO_X, ref("main", "research")],
      [BO_X, ref("case-y", "research")],
      [BO_Y, ref("case-x", "research")],
    ]
  ) {
    equal(
      policyCovers({
        space: space("case-x"),
        policy: copied,
        actor,
        requester,
      }),
      false,
      `${actor.executionSpaceId}/${actor.operatorId} for ${requester.executionSpaceId}/${requester.operatorId}`,
    );
  }
  // An explicit main policy names main operators: inert in a branch.
  const mainOnly = { ...copied, recipientExecutionSpaceId: "main" };
  deepStrictEqual(policyRecipients(space("case-x"), mainOnly), []);
  equal(
    policyScopeRefusal({
      space: space("case-x"),
      policy: mainOnly,
      actor: BO_X,
      requester: ref("case-x", "research"),
    }),
    "policy-not-effective-in-space",
  );
});

Deno.test("4.8c C3: a main→BO@X delegation copied into branch Y is inert there", () => {
  const delegation: DelegationSubjects = {
    holderNativeId: "operator",
    recipients: ["research"],
    recipientExecutionSpaceId: "case-x",
  };
  deepStrictEqual(policyRecipients(space("case-y"), delegation), []);
  equal(
    policyScopeRefusal({
      space: space("case-y"),
      policy: delegation,
      actor: BO_Y,
      requester: ref("case-y", "research"),
    }),
    "policy-not-effective-in-space",
  );
});

Deno.test("4.8c C3: self-approval is refused on composite identity whatever the policy", () => {
  // A main mandate over BO@X copied into X names BO@X as holder and recipient.
  const copiedMandate: DelegationSubjects = {
    holderNativeId: "operator",
    recipients: ["operator"],
    recipientExecutionSpaceId: "case-x",
  };
  equal(
    policyScopeRefusal({
      space: space("case-x"),
      policy: copiedMandate,
      actor: BO_X,
      requester: BO_X,
    }),
    "self-approval",
    "the BO cannot decide its own change, even under a grant listing it",
  );
  equal(
    policyScopeRefusal({
      space: space("main"),
      policy: { holderNativeId: "operator", recipients: ["operator"] },
      actor: MO,
      requester: MO,
    }),
    "self-approval",
  );
});

Deno.test("4.8c C2: the holder's native ID names another instance only in an explicit branch space", () => {
  equal(namesHolderInstance("operator", { recipients: ["operator"] }), true);
  equal(
    namesHolderInstance("operator", {
      recipients: ["operator"],
      recipientExecutionSpaceId: "main",
    }),
    true,
  );
  equal(
    namesHolderInstance("operator", {
      recipients: ["operator"],
      recipientExecutionSpaceId: "case-x",
    }),
    false,
  );
  equal(namesHolderInstance("operator", { recipients: ["research"] }), false);
});

Deno.test("4.8e native member recipient uses its verified model identity within the named branch", () => {
  const member = { ...ref("case-x", "member"), systemId: "member-system" };
  const input = {
    space: space("main"),
    policy: {
      holderNativeId: "operator",
      recipients: ["member"],
      recipientExecutionSpaceId: "case-x",
    },
    actor: MO,
    requester: member,
    targetSpace: member,
  };
  equal(policyCovers(input), true);
  equal(
    policyCovers({
      ...input,
      requester: { ...member, executionSpaceId: "case-y" },
    }),
    false,
  );
  equal(
    policyCovers({ ...input, requester: { ...member, systemId: "forged" } }),
    false,
  );
});
