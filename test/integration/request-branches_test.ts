import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { GitRequestBranches } from "../../src/adapters/out/git/request-branches.ts";
import { repositoryWriterLock } from "../../src/adapters/out/git/writer-lock.ts";
import { materialize } from "../../src/adapters/model/builds/materialization/artifact.ts";
import {
  type OpeningRecord,
  requestSpaceDigest,
} from "../../src/domain/work/request-spaces.ts";
import {
  requestOpeningBase,
  requestSpaceScope,
  spaceUuid,
} from "../support/request-space-fixture.ts";
Deno.test("Request ref keeps its exact initial base after main advances and rejects foreign history without checkout", async () => {
  const directory = await Deno.makeTempDir({ prefix: "request-branch-" });
  try {
    const repository = await GitModelRepository.open({
      projectDir: directory,
      repositoryId: spaceUuid(999),
      compiler: {
        compile: (sources) => materialize([], sources, "fixture"),
        recipe() {
          throw new Error("Fixture has no recipe");
        },
      },
    });
    const first = await repository.initialize({
      "main.sysml": "package First;\n",
    });
    const base = await requestOpeningBase();
    base.manifest.source!.sourceVersion = first.version;
    base.manifest.source!.sourceDigest = first.sourceDigest;
    base.manifest.operators[0].repositoryVersion = first.version;
    base.manifestDigest = await requestSpaceDigest(base.manifest);
    const record: OpeningRecord = {
      id: spaceUuid(1),
      caseId: spaceUuid(2),
      caseNumber: 1,
      executionSpaceId: spaceUuid(3),
      branchId: spaceUuid(4),
      initialContributionId: spaceUuid(5),
      scope: requestSpaceScope,
      ownerId: "owner",
      command: {
        openingKey: "key",
        text: "Request",
        source: { kind: "current-main" },
      },
      commandDigest: "command",
      base,
      baseDigest: await requestSpaceDigest(base),
      phase: "source-selected",
      revision: 1,
      admissionId: null,
      issues: [],
      createdAt: "now",
    };
    const main = await repository.publishSystemSources(
      { "main.sysml": "package MainAdvanced;\n" },
      first.version,
      "local-control",
    );
    const branches = new GitRequestBranches({
      projectDir: directory,
      writerLock: await repositoryWriterLock(repository.stateDir),
      reader: () =>
        GitModelRepository.openReadOnly({
          projectDir: directory,
          repositoryId: spaceUuid(999),
        }),
    });
    await Promise.all([branches.ensure(record), branches.ensure(record)]);
    equal(await branches.sourceVersion(record), first.version);
    equal((await repository.current()).version, main.version);
    await branches.assertVersion(record, first.version);
    await rejects(
      () => branches.assertVersion(record, main.version),
      /does not belong to this Request branch/,
    );
    await rejects(
      () => branches.ensure({ ...record, branchId: "../admitted" }),
      /branch identity is unavailable/,
    );
    const reopened = new GitRequestBranches({
      projectDir: directory,
      writerLock: await repositoryWriterLock(repository.stateDir),
      reader: () =>
        GitModelRepository.openReadOnly({
          projectDir: directory,
          repositoryId: spaceUuid(999),
        }),
    });
    equal(await reopened.sourceVersion(record), first.version);
    equal((await repository.current()).version, main.version);

    // A physical descendant alone is not admission. This Git fixture models
    // the ref; a mutable callback stands in for the separately verified D2 head.
    const update = await new Deno.Command("git", {
      args: [
        "--git-dir",
        `${directory}/.git`,
        "update-ref",
        branches.refForInspection(record),
        main.version.slice(7),
        first.version.slice(7),
      ],
    }).output();
    equal(update.success, true);
    await rejects(
      () => reopened.sourceVersion(record),
      /differs from its admitted source/,
    );
    let admitted = first.version;
    const reads: string[] = [];
    const evolved = new GitRequestBranches({
      projectDir: directory,
      writerLock: await repositoryWriterLock(repository.stateDir),
      admittedVersion: () => Promise.resolve(admitted),
      reader: async () => {
        const delegate = await GitModelRepository.openReadOnly({
          projectDir: directory,
          repositoryId: spaceUuid(999),
        });
        return {
          repositoryId: delegate.repositoryId,
          projectId: delegate.projectId,
          at: (version, signal) => {
            reads.push(version);
            return delegate.at(version, signal);
          },
          descriptorAt: (version, signal) =>
            delegate.descriptorAt(version, signal),
          readFirstParentInterval: (from, to, max, signal) =>
            delegate.readFirstParentInterval(from, to, max, signal),
        };
      },
    });
    await rejects(
      () => evolved.sourceVersion(record),
      /differs from its admitted source/,
    );
    admitted = main.version;
    await evolved.assertVersion(record, first.version);
    deepStrictEqual(reads, [first.version], "retained B0 does not build A1");
    equal(await evolved.sourceVersion(record), main.version);
    await evolved.assertVersion(record, main.version);
    await rejects(
      () => evolved.ensure(record),
      /already names another exact base/,
    );
    const restart = new GitRequestBranches({
      projectDir: directory,
      writerLock: await repositoryWriterLock(repository.stateDir),
      admittedVersion: () => Promise.resolve(admitted),
      reader: () =>
        GitModelRepository.openReadOnly({
          projectDir: directory,
          repositoryId: spaceUuid(999),
        }),
    });
    equal(await restart.sourceVersion(record), main.version);
    const back = await new Deno.Command("git", {
      args: [
        "--git-dir",
        `${directory}/.git`,
        "update-ref",
        branches.refForInspection(record),
        first.version.slice(7),
        main.version.slice(7),
      ],
    }).output();
    equal(back.success, true);
    await rejects(
      () => restart.assertVersion(record, first.version),
      /differs from its admitted source/,
    );
    const tree = await new Deno.Command("git", {
      args: [
        "--git-dir",
        `${directory}/.git`,
        "rev-parse",
        `${first.version.slice(7)}^{tree}`,
      ],
    }).output();
    equal(tree.success, true);
    const detached = await new Deno.Command("git", {
      args: [
        "--git-dir",
        `${directory}/.git`,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit-tree",
        new TextDecoder().decode(tree.stdout).trim(),
        "-m",
        "Unrelated root",
      ],
    }).output();
    equal(detached.success, true);
    const foreign = new TextDecoder().decode(detached.stdout).trim();
    const swap = await new Deno.Command("git", {
      args: [
        "--git-dir",
        `${directory}/.git`,
        "update-ref",
        branches.refForInspection(record),
        foreign,
        first.version.slice(7),
      ],
    }).output();
    equal(swap.success, true);
    admitted = `commit:${foreign}`;
    await rejects(
      () => restart.sourceVersion(record),
      /does not retain its exact opening base/,
    );
    equal((await repository.current()).version, main.version);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("retained execution proves ordered admitted lineage while physical Request ref leads admission", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "request-retained-branch-",
  });
  try {
    const repositoryId = spaceUuid(999);
    const repository = await GitModelRepository.open({
      projectDir: directory,
      repositoryId,
      compiler: {
        compile: (sources) => materialize([], sources, "fixture"),
        recipe() {
          throw new Error("No recipe");
        },
      },
    });
    const b0 = await repository.initialize({ "main.sysml": "package B0;\n" });
    const base = await requestOpeningBase();
    base.manifest.source!.repositoryId = repositoryId;
    base.manifest.source!.sourceVersion = b0.version;
    base.manifest.source!.sourceDigest = b0.sourceDigest;
    base.manifest.operators[0].repositoryVersion = b0.version;
    base.manifestDigest = await requestSpaceDigest(base.manifest);
    const record: OpeningRecord = {
      id: spaceUuid(31),
      caseId: spaceUuid(32),
      caseNumber: 1,
      executionSpaceId: spaceUuid(33),
      branchId: spaceUuid(34),
      initialContributionId: spaceUuid(35),
      scope: requestSpaceScope,
      ownerId: "owner",
      command: {
        openingKey: "retained",
        text: "Request",
        source: { kind: "current-main" },
      },
      commandDigest: "command",
      base,
      baseDigest: await requestSpaceDigest(base),
      phase: "source-selected",
      revision: 1,
      admissionId: null,
      issues: [],
      createdAt: "now",
    };
    let admitted = b0.version;
    const lock = await repositoryWriterLock(repository.stateDir);
    const reader = () =>
      GitModelRepository.openReadOnly({ projectDir: directory, repositoryId });
    const branches = new GitRequestBranches({
      projectDir: directory,
      writerLock: lock,
      reader,
      admittedVersion: () => Promise.resolve(admitted),
    });
    await branches.ensure(record);
    const a1 = await repository.publishSystemSources(
      { "main.sysml": "package A1;\n" },
      b0.version,
      "local-control",
    );
    const a2 = await repository.publishSystemSources(
      { "main.sysml": "package A2;\n" },
      a1.version,
      "local-control",
    );
    const ref = branches.refForInspection(record);
    const move = async (to: string, from: string) => {
      const result = await new Deno.Command("git", {
        args: [
          "--git-dir",
          `${directory}/.git`,
          "update-ref",
          ref,
          to.slice(7),
          from.slice(7),
        ],
      }).output();
      equal(result.success, true);
    };
    await move(a2.version, b0.version);
    admitted = a1.version;
    await branches.assertRetainedExecutionVersion(record, b0.version);
    await branches.assertRetainedExecutionVersion(record, a1.version);
    await rejects(() =>
      branches.assertRetainedExecutionVersion(record, a2.version)
    );
    // An exact revision is read once per instance; refs, ancestry, admission
    // and the recorded repository are still checked on every call.
    let opened = 0;
    const counted = new GitRequestBranches({
      projectDir: directory,
      writerLock: lock,
      admittedVersion: () => Promise.resolve(admitted),
      reader: () => {
        opened++;
        return reader();
      },
    });
    await counted.assertRetainedExecutionVersion(record, b0.version);
    await counted.assertRetainedExecutionVersion(record, b0.version);
    await counted.assertRetainedExecutionVersion(record, a1.version);
    await counted.assertRetainedExecutionVersion(record, a1.version);
    equal(opened, 2);
    const foreignOrigin = structuredClone(record);
    foreignOrigin.base!.manifest.source!.repositoryId = spaceUuid(997);
    await rejects(
      () => counted.assertRetainedExecutionVersion(foreignOrigin, b0.version),
      /execution source differs/,
    );
    admitted = `commit:${"0".repeat(40)}`;
    await rejects(
      () => counted.assertRetainedExecutionVersion(record, b0.version),
      /admitted execution ancestry/,
    );
    admitted = a1.version;
    equal(opened, 2);
    await rejects(
      () => branches.sourceVersion(record),
      /differs from its admitted source/,
    );
    await rejects(
      () => branches.assertVersion(record, b0.version),
      /differs from its admitted source/,
    );
    const wrongRepository = new GitRequestBranches({
      projectDir: directory,
      writerLock: lock,
      admittedVersion: () => Promise.resolve(admitted),
      reader: () =>
        GitModelRepository.openReadOnly({
          projectDir: directory,
          repositoryId: spaceUuid(998),
        }),
    });
    await rejects(() =>
      wrongRepository.assertRetainedExecutionVersion(record, b0.version)
    );
    const wrongVersion = new GitRequestBranches({
      projectDir: directory,
      writerLock: lock,
      admittedVersion: () => Promise.resolve(admitted),
      reader: async () => {
        const delegate = await reader();
        return {
          repositoryId: delegate.repositoryId,
          projectId: delegate.projectId,
          at: async (version, signal) => ({
            ...await delegate.at(version, signal),
            version: a2.version,
          }),
          descriptorAt: delegate.descriptorAt.bind(delegate),
          readFirstParentInterval: delegate.readFirstParentInterval.bind(
            delegate,
          ),
        };
      },
    });
    await rejects(() =>
      wrongVersion.assertRetainedExecutionVersion(record, b0.version)
    );
    let reads = 0;
    const drift = new GitRequestBranches({
      projectDir: directory,
      writerLock: lock,
      admittedVersion: () =>
        Promise.resolve(++reads === 1 ? a1.version : b0.version),
      reader,
    });
    await rejects(() =>
      drift.assertRetainedExecutionVersion(record, b0.version)
    );
    // A retained ref that moves during exact source I/O must not pass.
    const moving = new GitRequestBranches({
      projectDir: directory,
      writerLock: lock,
      admittedVersion: () => Promise.resolve(admitted),
      reader: async () => {
        const delegate = await reader();
        return {
          repositoryId: delegate.repositoryId,
          projectId: delegate.projectId,
          at: async (version, signal) => {
            const value = await delegate.at(version, signal);
            await move(a1.version, a2.version);
            return value;
          },
          descriptorAt: delegate.descriptorAt.bind(delegate),
          readFirstParentInterval: delegate.readFirstParentInterval.bind(
            delegate,
          ),
        };
      },
    });
    await rejects(() =>
      moving.assertRetainedExecutionVersion(record, b0.version)
    );
    // A claimed B0 after admitted A1 cannot satisfy first-parent ordering.
    const wrongBase = structuredClone(record);
    wrongBase.base!.manifest.source!.sourceVersion = a2.version;
    await rejects(() =>
      branches.assertRetainedExecutionVersion(wrongBase, b0.version)
    );
    // HEAD preceding the admitted version and missing Request refs both refuse.
    admitted = a2.version;
    await rejects(() =>
      branches.assertRetainedExecutionVersion(record, b0.version)
    );
    const tree = await new Deno.Command("git", {
      args: [
        "--git-dir",
        `${directory}/.git`,
        "rev-parse",
        `${b0.version.slice(7)}^{tree}`,
      ],
    }).output();
    equal(tree.success, true);
    const detached = await new Deno.Command("git", {
      args: [
        "--git-dir",
        `${directory}/.git`,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit-tree",
        new TextDecoder().decode(tree.stdout).trim(),
        "-m",
        "Unrelated root",
      ],
    }).output();
    equal(detached.success, true);
    const foreign = `commit:${
      new TextDecoder().decode(detached.stdout).trim()
    }`;
    await move(foreign, a1.version);
    admitted = foreign;
    await rejects(() =>
      branches.assertRetainedExecutionVersion(record, b0.version)
    );
    const deletion = await new Deno.Command("git", {
      args: [
        "--git-dir",
        `${directory}/.git`,
        "update-ref",
        "-d",
        ref,
        foreign.slice(7),
      ],
    }).output();
    equal(deletion.success, true);
    await rejects(() =>
      branches.assertRetainedExecutionVersion(record, b0.version)
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
