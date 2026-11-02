import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { ReleaseCreationAuthority } from "./creation-authorization.ts";
import { SpaceControls } from "../request-spaces/control.ts";
import type {
  SpaceControlCredential,
  SpaceCredentialStorePort,
} from "../request-spaces/control-ports.ts";
import {
  requestControlAdoptedState,
  spaceControlAuthority,
} from "../../../../test/support/request-space-fixture.ts";
import { type ReleaseRetentionIntent } from "../../../domain/work/release-retention.ts";
import { effectiveSpaceControlAuthority } from "../../../domain/work/request-space-authority.ts";
import { spaceControlActs } from "../../../domain/governance/policies/space-execution-policy.ts";

function fixture() {
  const current = spaceControlAuthority();
  const rows = new Map<string, SpaceControlCredential>();
  let next = 0, revision = 0;
  const store: SpaceCredentialStorePort = {
    insert(row) {
      rows.set(row.id, structuredClone(row));
      return Promise.resolve();
    },
    get: (id) => Promise.resolve(structuredClone(rows.get(id) ?? null)),
    findHash: (hash) =>
      Promise.resolve(
        structuredClone(
          [...rows.values()].find((row) => row.secretHash === hash) ?? null,
        ),
      ),
    revokeCapability(id) {
      const row = rows.get(id)!;
      row.status = "revoked";
      row.revision++;
      return Promise.resolve(structuredClone(row));
    },
  };
  const control = new SpaceControls(store, {
    current: () => Promise.resolve(structuredClone(current)),
    capture: () =>
      Promise.resolve({
        authority: structuredClone(current),
        adoptedState: requestControlAdoptedState(revision),
      }),
  }, { randomSecret: () => (++next).toString(16).padStart(64, "0") });
  return {
    current,
    rows,
    control,
    retention: new ReleaseCreationAuthority(control),
    grantRetention() {
      current.acts.push("retain-release");
      current.policyRevision++;
      revision++;
    },
    async controller() {
      const capability = await control.issueCapability("owner");
      const session = await control.exchange(capability.secret);
      return await control.authenticateSession(session.secret);
    },
  };
}
function intent(): ReleaseRetentionIntent {
  return {
    scope: {
      projectId: "space-project",
      systemId: "space-system",
      executionSpaceId: "main",
    },
    saveKey: "exact-intent",
    commandDigest: "a".repeat(64),
    source: {
      branch: { kind: "main" },
      sourceVersion: `commit:${"b".repeat(40)}`,
      repositoryId: "repository",
      branchRef: "refs/heads/admitted",
      admittedHeadVersion: `commit:${"b".repeat(40)}`,
      sourceDigest: "b".repeat(64),
    },
  };
}
Deno.test("fourth retention vocabulary does not widen or break existing three-act issuance/session", async () => {
  const f = fixture();
  deepStrictEqual(spaceControlActs(["retain-release"]), ["retain-release"]);
  const controller = await f.controller();
  deepStrictEqual(controller.authority.acts, [
    "open-request",
    "execute-conversation",
    "revoke-execution",
  ]);
  equal(Boolean(effectiveSpaceControlAuthority(controller.authority)), true);
  await f.control.revalidate(controller);
  await rejects(
    () => f.retention.authorize(intent(), controller),
    /retain-release/,
  );
  deepStrictEqual(f.current.acts, [
    "open-request",
    "execute-conversation",
    "revoke-execution",
  ]);
  equal(
    [...f.rows.values()].filter((row) => row.kind === "capability").length,
    1,
  );
});
Deno.test("explicit new retention grant needs a new credential, and exact intent is cloned not inferred", async () => {
  const f = fixture();
  const old = await f.controller();
  f.grantRetention();
  await rejects(() => f.control.revalidate(old));
  const current = await f.controller();
  const selected = intent();
  const authorized = await f.retention.authorize(selected, current);
  selected.saveKey = "different";
  equal(authorized.intent.saveKey, "exact-intent");
  equal(authorized.controller.authority.acts.includes("retain-release"), true);
  await f.retention.revalidate(authorized);
  await f.control.revokeCapability(current);
  await rejects(() => f.retention.revalidate(authorized));
});
Deno.test("retention preflight never reclassifies a technical control failure as a grant/refusal", async () => {
  const f = fixture();
  f.grantRetention();
  const controller = await f.controller();
  const failure = new Error("Control storage unavailable");
  const retention = new ReleaseCreationAuthority({
    revalidate: () => Promise.reject(failure),
  });
  await rejects(
    () => retention.authorize(intent(), controller),
    (error) => error === failure,
  );
});
