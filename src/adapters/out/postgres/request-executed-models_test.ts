import { deepEqual, equal, rejects } from "node:assert/strict";
import { RequestExecutedModels } from "./request-executed-models.ts";

type Options = ConstructorParameters<typeof RequestExecutedModels>[0];

function fixture() {
  const model = {
    identity: { builderId: "owner", systemId: "owner-system" },
    version: { digest: "a".repeat(64), repositoryVersion: "commit:birth" },
  };
  const models = [model];
  const opening = {
    id: "opening",
    baseDigest: "base",
    base: {
      requestOwner: { operatorId: "owner" },
      manifest: {
        registeredOperatorIds: ["owner"],
        operators: [{
          operatorId: model.identity.builderId,
          modelDigest: model.version.digest,
          repositoryVersion: model.version.repositoryVersion,
        }],
        source: { repositoryId: "repo", sourceVersion: "commit:birth" },
      },
    },
  };
  const binding = {
    pin: {
      modelDigest: model.version.digest,
      source: { version: "commit:birth" },
    },
    admission: {
      revision: 1,
      permissions: {
        operatorIds: ["owner"],
        modelDigests: [model.version.digest],
      },
    },
    state: { executionModel: structuredClone(model) },
  };
  let reads = 0;
  const adoptions: unknown[] = [], sourceVersions: string[] = [];
  const sourceBoundary = new Error("controlled source boundary");
  const executed = new RequestExecutedModels({
    storage: {
      client: { $transaction: (read: (tx: unknown) => unknown) => read({}) },
      scope: {},
    },
    openings: {},
    source: {
      readModelsForInspection: () => {
        reads++;
        return Promise.resolve(structuredClone(models));
      },
    },
    binding: { read: () => Promise.resolve(structuredClone(binding)) },
    journal: {
      readAdmittedSource: () => Promise.resolve({ execution: { adoptions } }),
    },
    reader: () =>
      Promise.resolve({
        at: (version: string) => {
          sourceVersions.push(version);
          return Promise.reject(sourceBoundary);
        },
      }),
  } as unknown as Options);
  return {
    executed,
    opening,
    binding,
    model,
    models,
    adoptions,
    sourceVersions,
    sourceBoundary,
    reads: () => reads,
  };
}

Deno.test("an executed pin is proved once: every later read of the same pin reuses its proof", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) {
    const model = await f.executed.current(
      f.opening as never,
      f.binding as never,
    );
    equal(model.identity.builderId, "owner");
  }
  equal(f.reads(), 1);
});

Deno.test("a reused proof still compares the caller's expected model and its live binding", async () => {
  const f = fixture();
  await f.executed.current(f.opening as never, f.binding as never);
  const other = structuredClone(f.binding);
  other.state.executionModel.identity.systemId = "another-system";
  await rejects(
    () => f.executed.current(f.opening as never, other as never),
    /unavailable/,
  );
});

Deno.test("a member creation image requires its verified journal birth", async () => {
  const f = fixture();
  await rejects(
    () => f.executed.creationModels(f.opening as never, ["unverified-member"]),
    /unavailable/,
  );
  equal(f.reads(), 0);
});

Deno.test("membership resolves the first creation source before later member adoptions", async () => {
  const f = fixture();
  const inclusion = (version: string, digest: string) => ({
    manifest: {
      intent: {
        candidate: { source: { version } },
        team: { team: [{ operatorId: "member", modelDigest: digest }] },
      },
    },
  });
  f.adoptions.push(
    inclusion("commit:member-birth", "b".repeat(64)),
    {
      manifest: {
        intent: {
          target: { operatorId: "member" },
          candidate: { source: { version: "commit:member-network" } },
        },
      },
    },
    inclusion("commit:later-team", "c".repeat(64)),
  );
  // Stop at the native source boundary: the retained birth must be selected,
  // while full source/build qualification remains the existing exact() gate.
  await rejects(
    () => f.executed.creationModels(f.opening as never, ["member"]),
    (error) => error === f.sourceBoundary,
  );
  deepEqual(f.sourceVersions, ["commit:member-birth"]);
});

Deno.test("executed model proofs evict older pins while retaining live binding checks", async () => {
  const f = fixture();
  for (let index = 0; index < 17; index++) {
    await f.executed.current(
      { ...f.opening, id: `opening-${index}` } as never,
      f.binding as never,
    );
  }
  equal(f.reads(), 17);
  await f.executed.current(
    { ...f.opening, id: "opening-0" } as never,
    f.binding as never,
  );
  equal(f.reads(), 18, "the oldest proof is verified again after eviction");
  await f.executed.current(
    { ...f.opening, id: "opening-16" } as never,
    f.binding as never,
  );
  equal(f.reads(), 18, "a retained proof is reused");
});

Deno.test("a retained member creation image uses its immutable opening model without a new journal birth", async () => {
  const f = fixture();
  f.model.identity.builderId = "member";
  f.opening.base.manifest.registeredOperatorIds.push("member");
  f.opening.base.manifest.operators.push({
    operatorId: "member",
    modelDigest: f.model.version.digest,
    repositoryVersion: f.model.version.repositoryVersion,
  });
  const models = await f.executed.creationModels(f.opening as never, [
    "member",
  ]);
  deepEqual(models.get("member"), f.model);
  deepEqual(f.sourceVersions, []);
  equal(f.reads(), 1);
});

Deno.test("current team models keep a BO-only admission closed over a retained source team", async () => {
  const f = fixture();
  const version = `commit:${"a".repeat(40)}`;
  f.model.version.repositoryVersion = version;
  f.opening.base.manifest.source.sourceVersion = version;
  f.opening.base.manifest.operators[0].repositoryVersion = version;
  f.binding.pin.source.version = version;
  f.binding.state.executionModel.version.repositoryVersion = version;
  const member = structuredClone(f.model);
  member.identity.builderId = "member";
  member.identity.systemId = "member-system";
  member.version.digest = "b".repeat(64);
  f.models.push(member);
  f.opening.base.manifest.registeredOperatorIds.push("member");
  f.opening.base.manifest.operators.push({
    operatorId: "member",
    modelDigest: member.version.digest,
    repositoryVersion: member.version.repositoryVersion,
  });
  deepEqual(
    await f.executed.currentModels(f.opening as never, f.binding as never),
    [f.model],
  );
  f.binding.admission.permissions.operatorIds.push("member");
  f.binding.admission.permissions.modelDigests.push(member.version.digest);
  deepEqual(
    await f.executed.currentModels(f.opening as never, f.binding as never),
    [f.model, member],
  );
  deepEqual(f.sourceVersions, []);
});
