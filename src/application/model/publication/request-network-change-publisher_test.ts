import { createSourceModel } from "../../../composition/source-model-services.ts";
import { equal, rejects } from "node:assert/strict";
import { RequestNetworkChangePublisher } from "./request-network-change-publisher.ts";
import { branchAuthorityFixture } from "../../../../test/support/branch-authority-fixture.ts";
import { parseModelRevisionRef } from "../../../domain/model/value-objects/element-ref.ts";
import { exerciseOwnerAuthority } from "../../../domain/governance/authority.ts";
import { RequestSpaceError } from "../../../domain/work/request-spaces/scope.ts";

Deno.test("member publication binds its native requester and branch before reading source; human publication stays BO-only", async () => {
  const f = await branchAuthorityFixture();
  const { opening, request } = f.snapshot;
  const model = request.executionModel!;
  model.identity.builderId = "member";
  model.identity.systemId = "member-system";
  const change = request.configuration!.changes[0];
  change.requestedBy = "member";
  change.requestedAt = "2026-11-02T00:00:00Z";
  change.status = "approved";
  change.diff = {
    title: "Member host",
    author: "member",
    base: {
      repositoryVersion: model.version.repositoryVersion!,
      modelDigest: model.version.digest,
      sourceDigest: "d".repeat(64),
    },
    sourceDigest: "e".repeat(64),
    files: [],
    patch: "",
    additions: 0,
    deletions: 0,
  };
  const requester = {
    projectId: model.identity.projectId,
    systemId: model.identity.systemId,
    executionSpaceId: opening.executionSpaceId,
    operatorId: "member",
  };
  // This unit stops at the source-read boundary. Envelope decoding, the
  // compiled dossier and actual publication have their own contracts.
  const authority = {
    kind: "request-delegated-authority",
    destination: f.destination,
    requester,
  } as const;
  const sourceRead = new Error("exact member source read");
  let reads = 0;
  const publisher = new RequestNetworkChangePublisher({
    createSourceModel,
    repositoryId: f.destination.repositoryId,
    projectId: model.identity.projectId,
    tooling: {} as never,
    reader: () => {
      reads++;
      return Promise.reject(sourceRead);
    },
    writer: { repositoryId: f.destination.repositoryId } as never,
  });
  const input = { opening, model, change, authority: authority as never };
  await rejects(
    () => publisher.publish(input),
    (error) => error === sourceRead,
  );
  equal(reads, 1);
  const advanced = parseModelRevisionRef({
    repositoryId: f.destination.repositoryId,
    version: `commit:${"f".repeat(40)}`,
  });
  const advancedAuthority = {
    ...authority,
    destination: {
      ...f.destination,
      expectedAdmittedSource: {
        ...f.destination.expectedAdmittedSource,
        revision: 2,
        source: advanced,
      },
    },
  };
  const advancedChange = {
    ...change,
    diff: {
      ...change.diff!,
      base: { ...change.diff!.base, repositoryVersion: advanced.version },
    },
  };
  await rejects(
    () =>
      publisher.publish({
        ...input,
        change: advancedChange,
        authority: advancedAuthority as never,
      }),
    (error) => error === sourceRead,
  );
  equal(reads, 2);
  equal(
    model.version.repositoryVersion,
    f.destination.expectedAdmittedSource.source.version,
  );
  await rejects(
    () =>
      publisher.publish({ ...input, authority: advancedAuthority as never }),
    /exact Case target/,
  );
  for (
    const wrong of [
      { ...requester, operatorId: "operator" },
      { ...requester, systemId: "foreign" },
      { ...requester, executionSpaceId: "other-branch" },
    ]
  ) {
    await rejects(
      () =>
        publisher.publish({
          ...input,
          authority: { ...authority, requester: wrong } as never,
        }),
      /exact Case target/,
    );
  }
  await rejects(
    () =>
      publisher.publish({
        ...input,
        authority: {
          kind: "request-source-owner-authority",
          acceptance: { destination: f.destination },
        } as never,
      }),
    /exact Case target/,
  );
  equal(reads, 2);
  await rejects(
    () =>
      publisher.publish({
        ...input,
        change: {
          ...change,
          requestedRights: {
            operatorCreation: {
              networkHosts: [],
              maxChildren: 1,
              mode: "per-creation",
            },
          },
        },
      }),
    (error) =>
      error instanceof RequestSpaceError && error.code === "FORBIDDEN" &&
      error.context?.check === "creation.scope",
  );
  equal(reads, 2);
});

Deno.test("member publication reads the displayed admitted source through SourceModel while retaining its execution pin", async () => {
  const f = await branchAuthorityFixture();
  const { opening, request } = f.snapshot;
  const model = request.executionModel!;
  model.identity = {
    ...model.identity,
    projectId: `git:${f.destination.repositoryId}`,
    builderId: "member",
    systemId: "member-system",
  };
  model.ownerAuthority!.systemId = model.identity.systemId;
  model.version.authoritySchema = 2;
  const executionVersion = model.version.repositoryVersion!;
  const current = parseModelRevisionRef({
    repositoryId: f.destination.repositoryId,
    version: `commit:${"f".repeat(40)}`,
  });
  const change = request.configuration!.changes[0];
  Object.assign(change, {
    status: "approved",
    requestedBy: "member",
    requestedAt: "2026-11-02T00:00:00Z",
    decidedAt: "2026-11-02T00:01:00Z",
    authorityExercise: exerciseOwnerAuthority(model, "mandate-change"),
    diff: {
      title: "Member host",
      author: "member",
      base: {
        repositoryVersion: current.version,
        modelDigest: model.version.digest,
        sourceDigest: "d".repeat(64),
      },
      sourceDigest: "e".repeat(64),
      files: [],
      patch: "",
      additions: 0,
      deletions: 0,
    },
  });
  const destination = {
    ...f.destination,
    expectedAdmittedSource: {
      ...f.destination.expectedAdmittedSource,
      source: current,
    },
  };
  const reads: string[] = [];
  const publisher = new RequestNetworkChangePublisher({
    createSourceModel,
    repositoryId: f.destination.repositoryId,
    projectId: model.identity.projectId,
    tooling: {} as never,
    reader: () =>
      Promise.resolve({
        repositoryId: f.destination.repositoryId,
        at: (version) => {
          reads.push(version);
          return Promise.reject(new Error("source-read-stop"));
        },
      }),
    writer: {
      repositoryId: f.destination.repositoryId,
      resume: () => Promise.resolve(null),
    } as never,
  });
  // Stop before compilation: this verifies the production publication's
  // selection of A from the displayed diff, not native authority or writing.
  await rejects(
    () =>
      publisher.publish({
        opening,
        model,
        change,
        authority: {
          kind: "request-delegated-authority",
          destination,
          requester: {
            projectId: model.identity.projectId,
            systemId: model.identity.systemId,
            operatorId: "member",
            executionSpaceId: opening.executionSpaceId,
          },
        } as never,
      }),
    /source-read-stop/,
  );
  equal(reads.join(","), current.version);
  equal(model.version.repositoryVersion, executionVersion);
});
