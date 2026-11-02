import { deepStrictEqual, equal, throws } from "node:assert/strict";
import {
  assertOpeningBase,
  branchTeam,
  type BranchTeamPinnedModel,
  conversationPermissions,
  exactSourceVersion,
  openingCommand,
  type OpeningRecord,
  openingView,
  recordedOpeningCommand,
  requestSpaceDigest,
  RequestSpaceError,
} from "./request-spaces.ts";
import {
  requestOpeningBase,
  requestSpaceScope,
} from "../../../test/support/request-space-fixture.ts";
Deno.test("Request opening DTO accepts only source choice/text/key and never actor, scope or Git refs", () => {
  const valid = {
    openingKey: "key",
    text: " Request ",
    source: { kind: "current-main" },
  };
  deepStrictEqual(openingCommand(valid), { ...valid, text: "Request" });
  for (
    const command of [
      { ...valid, actorId: "owner" },
      { ...valid, executionSpaceId: "main" },
      {
        ...valid,
        source: { kind: "current-main", ref: "refs/heads/admitted" },
      },
      { ...valid, source: { kind: "current-main", expectedVersion: "HEAD" } },
      {
        ...valid,
        source: { kind: "release", releaseId: "release", digest: "wrong" },
      },
      { ...valid, text: "x".repeat(100001) },
      { ...valid, text: "secret\0" },
    ]
  ) throws(() => openingCommand(command));
});
Deno.test("conversation base rejects tools, unbound skill metadata and missing provenance and grants no resource scope", async () => {
  const base = await requestOpeningBase();
  assertOpeningBase(base);
  equal(exactSourceVersion([`commit:${"a".repeat(40)}`]), false);
  deepStrictEqual(conversationPermissions(base), {
    operatorIds: ["operator"],
    acts: ["conversation"],
    sourceVersion: base.manifest.source!.sourceVersion,
    modelDigests: ["a".repeat(64)],
    resourceIds: [],
  });
  throws(() =>
    assertOpeningBase({
      ...base,
      manifest: { ...base.manifest, source: undefined },
    })
  );
  throws(() =>
    assertOpeningBase({
      ...base,
      manifest: {
        ...base.manifest,
        prerequisites: [{ kind: "skill", code: "SKILL_DEPENDENCY" }],
      },
    })
  );
  throws(() =>
    assertOpeningBase({
      ...base,
      manifest: {
        ...base.manifest,
        operators: base.manifest.operators.map((operator) => ({
          ...operator,
          tools: [{ candidateId: "tool", digest: "d" }],
        })),
      },
    })
  );
  const view = openingView(
    {
      id: "open",
      caseId: "case",
      caseNumber: 1,
      executionSpaceId: "space",
      branchId: "branch",
      initialContributionId: "input",
      scope: requestSpaceScope,
      ownerId: "owner",
      command: {
        openingKey: "key",
        text: "Private request input",
        source: { kind: "current-main" },
      },
      commandDigest: "digest",
      base,
      baseDigest: "base",
      phase: "allocated",
      admissionId: null,
      revision: 0,
      issues: [],
      createdAt: "now",
    } satisfies OpeningRecord,
  );
  equal(JSON.stringify(view).includes("Private request input"), false);
  equal("commandDigest" in view, false);
});

Deno.test("Request base permits only known skill metadata for one exact source member and grants no resource rights", async () => {
  const base = await requestOpeningBase();
  const prerequisite = {
    kind: "skill" as const,
    code: "SKILL_DEPENDENCY",
    operatorId: base.requestOwner.operatorId,
  };
  const manifest = {
    ...base.manifest,
    prerequisites: [...base.manifest.prerequisites, prerequisite],
  };
  const withSkill = {
    ...base,
    manifest,
    manifestDigest: await requestSpaceDigest(manifest),
  };
  const before = structuredClone(withSkill);
  assertOpeningBase(withSkill);
  deepStrictEqual(
    conversationPermissions(withSkill),
    conversationPermissions(base),
  );
  deepStrictEqual(conversationPermissions(withSkill).resourceIds, []);
  deepStrictEqual(withSkill, before);
  for (
    const invalid of [
      { kind: "skill" as const, code: "SKILL_DEPENDENCY" },
      { ...prerequisite, operatorId: "" },
      { ...prerequisite, operatorId: ` ${prerequisite.operatorId}` },
      { ...prerequisite, operatorId: "foreign-member" },
      { ...prerequisite, code: "UNKNOWN_SKILL" },
      { ...prerequisite, kind: "private-resource" as const },
      { ...prerequisite, kind: "unsupported-dependency" as const },
      { ...prerequisite, source: "bundle:untrusted-extra-field" },
    ]
  ) {
    throws(() =>
      assertOpeningBase({
        ...withSkill,
        manifest: { ...manifest, prerequisites: [invalid] },
      })
    );
  }
  throws(() =>
    assertOpeningBase({
      ...withSkill,
      manifest: {
        ...manifest,
        operators: [
          ...manifest.operators,
          structuredClone(manifest.operators[0]!),
        ],
      },
    })
  );
  // This is structural admission of declared metadata only. The actual bundle,
  // model exposures and current authority remain the host/runtime inspector's job.
});

function pinned(
  operatorId: string,
  team?: BranchTeamPinnedModel["operatorTeam"],
): BranchTeamPinnedModel {
  return {
    identity: { builderId: operatorId, systemId: `${operatorId}-system` },
    version: { digest: `digest-${operatorId}` },
    ...(team ? { operatorTeam: team } : {}),
  };
}

Deno.test("branchTeam admits only verified members of this Case, transitively, at most three", async () => {
  const base = await requestOpeningBase();
  const owner = base.requestOwner.operatorId;
  const member = (id: string, parent: string, requestId = "case-1") =>
    pinned(id, {
      parentOperatorId: parent,
      requestOwnerId: owner,
      requestId,
    });
  const verified = new Set([
    "member-a",
    "member-b",
    "member-c",
    "member-d",
    "sub-a",
  ]);
  const receiptVerifies = (child: BranchTeamPinnedModel) =>
    verified.has(child.identity.builderId);
  const models = [
    pinned(owner),
    member("member-b", owner),
    member("member-a", owner),
    member("sub-a", "member-a"),
    member("member-c", owner),
    member("member-d", owner),
    member("inherited", owner, "main-request"),
    member("forged", owner),
    member("orphan", "forged"),
    pinned("foreign", {
      parentOperatorId: owner,
      requestOwnerId: "another-owner",
      requestId: "case-1",
    }),
  ];
  verified.add("orphan");
  verified.add("foreign");
  verified.add("inherited");
  const team = branchTeam(base, models, "case-1", receiptVerifies);
  // Inherited (other Request), forged receipt, the forged member's child and
  // a foreign Request owner are excluded; the team is capped at three.
  deepStrictEqual(
    team.map((entry) => entry.operatorId),
    ["member-a", "member-b", "member-c"],
  );
  deepStrictEqual(team[0], {
    operatorId: "member-a",
    modelDigest: "digest-member-a",
    parentOperatorId: owner,
  });
  // With room, a verified sub-operator of a member joins through its parent.
  const smaller = branchTeam(
    base,
    [pinned(owner), member("member-a", owner), member("sub-a", "member-a")],
    "case-1",
    receiptVerifies,
  );
  deepStrictEqual(
    smaller.map((entry) => [entry.operatorId, entry.parentOperatorId]),
    [["member-a", owner], ["sub-a", "member-a"]],
  );
  deepStrictEqual(branchTeam(base, models, "case-2", receiptVerifies), []);
});

Deno.test("conversation permissions admit the BO first, then the branch team with per-operator digests", async () => {
  const base = await requestOpeningBase();
  const permissions = conversationPermissions(base, [{
    operatorId: "member-a",
    modelDigest: "digest-member-a",
    parentOperatorId: "operator",
  }]);
  deepStrictEqual(permissions.operatorIds, ["operator", "member-a"]);
  deepStrictEqual(permissions.modelDigests, [
    "a".repeat(64),
    "digest-member-a",
  ]);
  equal(permissions.sourceVersion, base.manifest.source!.sourceVersion);
});

Deno.test("branchTeam truncation keeps parents before children", async () => {
  const base = await requestOpeningBase();
  const owner = base.requestOwner.operatorId;
  const member = (id: string, parent: string) =>
    pinned(id, {
      parentOperatorId: parent,
      requestOwnerId: owner,
      requestId: "case-1",
    });
  // Alphabetical truncation would keep "a-sub" and drop its parent
  // "z-parent"; admission order must keep the parent instead.
  const team = branchTeam(
    base,
    [
      pinned(owner),
      member("z-parent", owner),
      member("b-member", owner),
      member("c-member", owner),
      member("a-sub", "z-parent"),
    ],
    "case-1",
    () => true,
  );
  deepStrictEqual(
    team.map((entry) => entry.operatorId),
    ["b-member", "c-member", "z-parent"],
  );
});

Deno.test("4.8d D3: a recorded command keeps the host-captured opener of a Main Operator opening, and only that", () => {
  const command = {
    openingKey: "main-key",
    text: "Read the page",
    source: { kind: "current-main" },
  };
  const opener = {
    operator: {
      projectId: "project",
      systemId: "system",
      executionSpaceId: "main",
      operatorId: "operator",
    },
    origin: {
      conversationId: "main-runtime",
      designerScopeId: "main:designer",
      openingId: "mo-opening",
    },
  };
  deepStrictEqual(recordedOpeningCommand(command), command);
  deepStrictEqual(recordedOpeningCommand({ ...command, opener }), {
    ...command,
    opener,
  });
  for (
    const forged of [
      { ...opener, actor: "x" },
      { ...opener, operator: { ...opener.operator, operatorId: "" } },
      { ...opener, origin: { ...opener.origin, openingId: 7 } },
      { ...opener, origin: { ...opener.origin, extra: "x" } },
    ]
  ) {
    throws(
      () => recordedOpeningCommand({ ...command, opener: forged }),
      (error: unknown) =>
        error instanceof RequestSpaceError && error.code === "INVALID_COMMAND",
    );
  }
  // The public DTO never accepts an opener.
  throws(() => openingCommand({ ...command, opener }));
});

Deno.test("branchTeam overflow never displaces an admitted member by alphabetical truncation", async () => {
  const base = await requestOpeningBase();
  const owner = base.requestOwner.operatorId;
  const models = ["z-old", "y-old", "x-old", "a-new"].map((id) =>
    pinned(id, {
      parentOperatorId: owner,
      requestOwnerId: owner,
      requestId: "case-1",
    })
  );
  deepStrictEqual(
    branchTeam(base, models, "case-1", () => true, ["z-old", "y-old", "x-old"])
      .map((m) => m.operatorId),
    ["x-old", "y-old", "z-old"],
  );
  throws(
    () => branchTeam(base, models.slice(1), "case-1", () => true, ["z-old"]),
    /admitted branch member/,
  );
  const orphanedAdmission = models.map((model) => structuredClone(model));
  orphanedAdmission[0].operatorTeam!.parentOperatorId = "a-new";
  throws(
    () =>
      branchTeam(base, orphanedAdmission, "case-1", () => true, [
        "z-old",
        "y-old",
        "x-old",
      ]),
    /admitted branch member/,
  );
});
