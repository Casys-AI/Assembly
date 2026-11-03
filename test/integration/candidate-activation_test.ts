import assert from "node:assert/strict";
import { openPostgresRuntimeFixture } from "../support/postgres-runtime-fixture.ts";
import type { ModelWriteSubmissionPort } from "../../src/application/model/publication/submission.ts";
import {
  applyEdits,
  verifyEdits,
} from "../../src/adapters/model/sources/editing/host-writer.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { SourceModel } from "../../src/adapters/model/sources/source-model.ts";
import type { SourceRevision } from "../../src/adapters/model/sources/source-model.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { CandidateActivationError } from "../../src/domain/work/policies/candidate-activation.ts";
import { ChangePublicationError } from "../../src/domain/model/publication/change.ts";
import {
  type HostEdit,
  isSpellable,
} from "../../src/domain/model/editing/host-edit.ts";
import type { Candidate } from "../../src/domain/work/candidates.ts";
import type { SystemRuntimeState } from "../../src/domain/work/dialogue.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

Deno.test({
  name:
    "candidate stages stay in PostgreSQL; one activation receipt survives restart and native removal revokes it",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({ prefix: "ase-activation-" });
    let fixture = await openPostgresRuntimeFixture({ dataDir: directory });
    let store = fixture.primary.state;
    const tooling = fixture.backend.tooling;
    try {
      const repository = fixture.repository;
      const model = fixture.backend.model;
      const identity = await model.initialize();
      const executable = await model.readExecutableModel(identity);
      const initial = await repository.current();
      const candidate: Candidate = {
        id: "candidate-durable-activation",
        name: "Durable page reader",
        description: "Native activation receipt qualification",
        kind: "read_web_page",
        code: "export default () => ({title:'Title',text:'Text'})",
        digest: "a".repeat(64),
        stage: "proposed",
        createdAt: "2026-10-21T00:00:00Z",
        baseCatalogRevision: 0,
      };
      const proposed: SystemRuntimeState = {
        id: "durable-activation",
        revision: 0,
        catalogRevision: 0,
        busy: false,
        phase: "ready",
        provider: "fixture",
        messages: [],
        candidates: [candidate],
        events: [],
        model: identity,
      };
      await store.save(proposed, null);
      const testing = structuredClone(proposed);
      testing.revision = 1;
      testing.candidates[0]!.stage = "testing";
      await store.save(testing, 0);
      const reviewing = structuredClone(testing);
      reviewing.revision = 2;
      reviewing.candidates[0]!.stage = "reviewing";
      reviewing.candidates[0]!.tests = { passed: true, checks: [] };
      await store.save(reviewing, 1);
      assert.equal((await repository.current()).version, initial.version);
      assert.equal(
        (await model.readExecutableModel(identity)).catalog.length,
        0,
      );
      assert.equal(await model.findCandidate(identity, candidate), null);

      const admission = {
        candidateId: candidate.id,
        candidateDigest: candidate.digest,
        mandateRevision: executable.configuration.builder.mandateRevision,
        configurationRevision: executable.configuration.revision,
        authority: executable.configuration.builder.admissionAuthority,
        actorId: identity.rootId,
        authorityExercise: exerciseOwnerAuthority(
          executable,
          "candidate-admission",
        ),
        reason: "Exact native admission fixture",
        at: "2026-10-21T00:01:00Z",
      } as const;
      const admitted = { ...reviewing.candidates[0]!, admission };
      await assert.rejects(
        () =>
          model.activateCandidate(identity, {
            ...admitted,
            admission: { ...admission, reason: "x".repeat(70_000) },
          }, executable.version.digest),
        /receipt|size|large/i,
      );
      assert.equal((await repository.current()).version, initial.version);
      const binding = await model.activateCandidate(
        identity,
        admitted,
        executable.version.digest,
      );
      const activated = await repository.current();
      assert.notEqual(activated.version, initial.version);
      assert.equal(
        (await model.readExecutableModel(identity)).catalog[0]!.status,
        "active",
      );
      const git = new Deno.Command("git", {
        args: [
          "--git-dir",
          `${fixture.backend.project.projectDir}/.git`,
          "show",
          "-s",
          "--format=%B",
          activated.version.slice(7),
        ],
        stdout: "piped",
        stderr: "piped",
      });
      const output = await git.output();
      assert.equal(output.code, 0, new TextDecoder().decode(output.stderr));
      const body = new TextDecoder().decode(output.stdout);
      const trailer = /^ASE-Approval: (.+)$/m.exec(body);
      assert(trailer, "Activation commit has no receipt trailer");
      const receipt = JSON.parse(trailer[1]!);
      assert.equal(receipt.type, "candidate-activation");
      assert.equal(receipt.candidateId, candidate.id);
      assert.equal(receipt.candidateDigest, candidate.digest);
      assert.equal(receipt.systemId, identity.systemId);
      assert.equal(receipt.builderId, identity.builderId);
      assert.deepEqual(receipt.admission, admission);
      assert.equal(receipt.adoptedPin.repositoryVersion, initial.version);
      assert.equal(receipt.edits.length, 1);
      assert.equal(receipt.edits[0].op, "insertMember");
      assert.equal(
        (await repository.findPublication(receipt.changeId))?.revision.version,
        activated.version,
      );
      const deleteIndex = await new Deno.Command("git", {
        args: [
          "--git-dir",
          `${fixture.backend.project.projectDir}/.git`,
          "update-ref",
          "-d",
          `refs/ase/approved-changes/${receipt.changeId}`,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(
        deleteIndex.code,
        0,
        new TextDecoder().decode(deleteIndex.stderr),
      );
      assert.equal(
        (await repository.findPublication(receipt.changeId))?.revision.version,
        activated.version,
        "The receipt must be discoverable from the commit after index loss",
      );
      assert.deepEqual(
        await model.activateCandidate(
          identity,
          admitted,
          executable.version.digest,
        ),
        binding,
      );
      assert.equal((await repository.current()).version, activated.version);
      assert.equal(
        (await repository.history()).commits.filter((commit) =>
          commit.author === `ase:activate-candidate:${identity.builderId}`
        ).length,
        1,
      );

      const active = structuredClone(reviewing);
      active.revision = 3;
      active.catalogRevision = 1;
      active.candidates[0] = { ...admitted, stage: "active", binding };
      await store.save(active, 2);
      const database = fixture.database;
      await fixture.close({ retainDatabase: true });
      fixture = await openPostgresRuntimeFixture({
        dataDir: directory,
        database,
      });
      store = fixture.primary.state;
      const reopenedRepository = fixture.repository;
      const reopenedModel = fixture.backend.model;
      assert.deepEqual(await store.loadRevision(0), proposed);
      assert.deepEqual(await store.loadRevision(2), reviewing);
      assert.deepEqual(await store.load(), active);
      assert.deepEqual(
        await reopenedModel.findCandidate(identity, admitted),
        binding,
      );
      assert.equal(
        (await reopenedRepository.findPublication(receipt.changeId))?.revision
          .version,
        activated.version,
      );

      const native = activated.elements.find((element) =>
        element["@id"] === binding.elementId
      );
      assert(native);
      let edits: HostEdit[] = [];
      const base: SourceRevision | undefined = await reopenedRepository
        .current();
      const removal = await applyEdits(tooling, base, [{
        op: "remove",
        target: { qualifiedName: String(native.qualifiedName) },
      }]);
      edits = removal.edits;
      const removed = await reopenedRepository.publishSystemSources(
        removal.sources,
        base.version,
        "operator:revoke-candidate",
      );
      await verifyEdits(removed, edits, { base });
      assert.equal(
        (await reopenedModel.readExecutableModel(identity)).catalog.length,
        0,
      );
      assert.equal(await reopenedModel.findCandidate(identity, admitted), null);
      const afterRemoval = await reopenedRepository.current();
      await assert.rejects(
        () =>
          reopenedModel.activateCandidate(
            identity,
            admitted,
            executable.version.digest,
          ),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error && error.code === "PUBLICATION_RECEIPT_MISMATCH",
      );
      assert.equal(
        (await reopenedRepository.current()).version,
        afterRemoval.version,
      );
      assert.equal(
        (await reopenedModel.readExecutableModel(identity, activated.version))
          .catalog[0]!.status,
        "active",
      );
    } finally {
      await fixture.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "concurrent exact activation reuses one native binding across different source pins",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "ase-activation-race-",
    });
    const fixture = await openPostgresRuntimeFixture({ dataDir: directory });
    try {
      const { projectId, tooling } = fixture.backend;
      const repository = fixture.repository;
      const model = fixture.backend.model;
      const identity = await model.initialize();
      const executable = await model.readExecutableModel(identity);
      const makeCandidate = (id: string, digest: string): Candidate => ({
        id,
        name: id,
        description: "Concurrent activation fixture",
        kind: "read_web_page",
        code: "export default () => ({title:'Title',text:'Text'})",
        digest,
        stage: "reviewing",
        createdAt: "2026-10-21T00:00:00Z",
        baseCatalogRevision: 0,
        tests: { passed: true, checks: [] },
        admission: {
          candidateId: id,
          candidateDigest: digest,
          mandateRevision: executable.configuration.builder.mandateRevision,
          configurationRevision: executable.configuration.revision,
          authority: "human",
          actorId: identity.rootId,
          authorityExercise: exerciseOwnerAuthority(
            executable,
            "candidate-admission",
          ),
          reason: "Exact concurrent admission",
          at: "2026-10-21T00:01:00Z",
        },
      });
      const exact = makeCandidate("same-candidate", "d".repeat(64));
      const sibling = makeCandidate("interleaved-candidate", "e".repeat(64));
      const enteredA = Promise.withResolvers<void>();
      const releaseA = Promise.withResolvers<void>();
      const enteredB = Promise.withResolvers<void>();
      const releaseB = Promise.withResolvers<void>();
      const gated = (
        entered: ReturnType<typeof Promise.withResolvers<void>>,
        release: ReturnType<typeof Promise.withResolvers<void>>,
      ): ModelWriteSubmissionPort => ({
        repositoryId: fixture.backend.writer.repositoryId,
        recipeDigest: () => fixture.backend.writer.recipeDigest(),
        resume: (...args) => fixture.backend.writer.resume(...args),
        async publish(dossier) {
          entered.resolve();
          await release.promise;
          return await fixture.backend.writer.publish(dossier);
        },
      });
      const modelA = new SourceModel({
        repository,
        tooling,
        projectId,
        writer: gated(enteredA, releaseA),
      });
      const modelB = new SourceModel({
        repository,
        tooling,
        projectId,
        writer: gated(enteredB, releaseB),
      });
      const initial = await repository.current();
      let activationA:
        | Promise<Awaited<ReturnType<SourceModel["activateCandidate"]>>>
        | undefined;
      let activationB:
        | Promise<Awaited<ReturnType<SourceModel["activateCandidate"]>>>
        | undefined;
      try {
        activationA = modelA.activateCandidate(
          identity,
          exact,
          executable.version.digest,
        );
        await enteredA.promise;
        assert.equal((await repository.current()).version, initial.version);
        await model.activateCandidate(
          identity,
          sibling,
          executable.version.digest,
        );
        const afterSibling = await repository.current();
        assert.notEqual(afterSibling.version, initial.version);
        activationB = modelB.activateCandidate(
          identity,
          exact,
          executable.version.digest,
        );
        await enteredB.promise;
        assert.equal(
          (await repository.current()).version,
          afterSibling.version,
        );
        releaseA.resolve();
        const bindingA = await activationA;
        const afterA = await repository.current();
        releaseB.resolve();
        const bindingB = await activationB;
        assert.deepEqual(bindingB, bindingA);
        assert.equal((await repository.current()).version, afterA.version);
        assert.equal(
          (await model.readExecutableModel(identity)).catalog.length,
          2,
        );
        assert.equal(
          (await repository.history()).commits.filter((commit) =>
            commit.author === `ase:activate-candidate:${identity.builderId}`
          ).length,
          2,
          "Only the sibling and the first exact activation may commit",
        );
      } finally {
        releaseA.resolve();
        releaseB.resolve();
        await Promise.allSettled([activationA, activationB].filter(Boolean));
      }
    } finally {
      await fixture.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

/** Real Toolkit, Git CAS and queued PostgreSQL writer for adapter refusals. */
async function nativeModel() {
  const directory = await Deno.makeTempDir({
    prefix: "ase-native-activation-",
  });
  const fixture = await openPostgresRuntimeFixture({
    dataDir: directory,
    sources: await loadInitialSources(undefined, { information: false }),
  });
  const repository = fixture.repository;
  const model = fixture.backend.model;
  const identity = await model.initialize();
  const executable = await model.readExecutableModel(identity);
  const candidate = (
    id: string,
    authority: "human" | "builder" | "reviewer",
    name = id,
  ): Candidate => {
    const digest = [...id].reduce((hash, char) => hash + char.charCodeAt(0), 0)
      .toString(16).padStart(64, "0");
    return {
      id,
      name,
      description: "Admitted activation fixture",
      kind: "read_web_page",
      code: "export default () => ({title:'Title',text:'Text'})",
      digest,
      stage: "reviewing",
      createdAt: "2026-10-21T00:00:00Z",
      baseCatalogRevision: 0,
      tests: { passed: true, checks: [] },
      admission: {
        candidateId: id,
        candidateDigest: digest,
        mandateRevision: executable.configuration.builder.mandateRevision,
        configurationRevision: executable.configuration.revision,
        authority,
        actorId: authority === "human" ? identity.rootId : `${authority}-actor`,
        reason: "Exact admission fixture",
        at: "2026-10-21T00:01:00Z",
        ...(authority === "human"
          ? {
            authorityExercise: exerciseOwnerAuthority(
              executable,
              "candidate-admission",
            ),
          }
          : {}),
      },
    };
  };
  /** A foreign contract edit, as a concurrent operator would publish it. */
  const editContract = async () => {
    const revision = await repository.current();
    await repository.publishSystemSources(
      {
        ...revision.sources,
        "configuration.sysml": revision.sources["configuration.sysml"]!.replace(
          'urlSelectionMode = "user-provided"',
          'urlSelectionMode = "authorized-host"',
        ),
      },
      revision.version,
      "operator:edit",
    );
  };
  return {
    repository,
    model,
    identity,
    executable,
    candidate,
    editContract,
    fixture,
    async publicationCount() {
      const publications = await fixture.storage.client.modelWriteCommand
        .findMany({
          where: {
            ...fixture.storage.scope,
            repositoryId: fixture.backend.project.id,
            state: "published",
          },
          select: { commandJson: true },
        });
      return publications.filter((entry) =>
        JSON.parse(entry.commandJson).kind === "activate-candidate"
      ).length;
    },
    async [Symbol.asyncDispose]() {
      await fixture.close();
      await Deno.remove(directory, { recursive: true });
    },
  };
}

const refusesWith = (code: string) => (error: unknown) =>
  error instanceof CandidateActivationError && error.code === code &&
  error.recovery === "refuse" && typeof error.context.candidateId === "string";

Deno.test({
  name:
    "activation is pinned to the admitted model digest for every authority, before the lock",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    await using f = await nativeModel();
    await f.editContract();
    const head = await f.model.readExecutableModel(f.identity);
    assert.notEqual(head.version.digest, f.executable.version.digest);
    const before = await f.repository.current();
    let lockedWrites = 0;
    const update = f.fixture.backend.writer.publish.bind(
      f.fixture.backend.writer,
    );
    f.fixture.backend.writer.publish = (...args) => {
      lockedWrites++;
      return update(...args);
    };
    for (const authority of ["reviewer", "builder", "human"] as const) {
      await assert.rejects(
        () =>
          f.model.activateCandidate(
            f.identity,
            f.candidate(`pinned-${authority}`, authority),
            f.executable.version.digest,
          ),
        refusesWith("ADMITTED_MODEL_CHANGED"),
        authority,
      );
    }
    assert.equal((await f.repository.current()).version, before.version);
    assert.equal(
      (await f.model.readExecutableModel(f.identity)).catalog.length,
      0,
    );
    assert.equal(await f.publicationCount(), 0);
    assert.equal(lockedWrites, 0, "the refusal precedes the repository lock");
    // The digest of the model actually read is accepted.
    const accepted = await f.model.activateCandidate(
      f.identity,
      {
        ...f.candidate("pinned-accepted", "human"),
        admission: {
          ...f.candidate("pinned-accepted", "human").admission!,
          authorityExercise: exerciseOwnerAuthority(
            head,
            "candidate-admission",
          ),
        },
      },
      head.version.digest,
    );
    assert.equal(
      (await f.model.readExecutableModel(f.identity)).catalog[0]!.nativeId,
      accepted.elementId,
    );
  },
});

Deno.test({
  name:
    "a contract edit landing under the repository lock is refused by the pinned digest",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    await using f = await nativeModel();
    let edit: (() => Promise<void>) | undefined;
    // The model reads HEAD, then a foreign edit lands just before the lock.
    const writer = f.fixture.backend.writer;
    const raced = new SourceModel({
      tooling: f.fixture.backend.tooling,
      repository: f.repository,
      projectId: f.fixture.backend.projectId,
      writer: {
        repositoryId: writer.repositoryId,
        recipeDigest: () => writer.recipeDigest(),
        resume: (...args) => writer.resume(...args),
        async publish(dossier) {
          await edit?.();
          return await writer.publish(dossier);
        },
      },
    });
    edit = async () => {
      edit = undefined;
      await f.editContract();
    };
    await assert.rejects(
      () =>
        raced.activateCandidate(
          f.identity,
          f.candidate("raced-reviewer", "reviewer"),
          f.executable.version.digest,
        ),
      refusesWith("ADMITTED_MODEL_CHANGED"),
    );
    assert.equal(
      (await f.model.readExecutableModel(f.identity)).catalog.length,
      0,
    );
    assert.equal(await f.publicationCount(), 0);
  },
});

Deno.test({
  name:
    "an exact active entry stays an idempotent success under a later model digest",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    await using f = await nativeModel();
    const admitted = f.candidate("idempotent-reviewer", "human");
    const binding = await f.model.activateCandidate(
      f.identity,
      admitted,
      f.executable.version.digest,
    );
    await f.editContract();
    const after = await f.repository.current();
    assert.deepEqual(
      await f.model.activateCandidate(
        f.identity,
        admitted,
        f.executable.version.digest,
      ),
      binding,
    );
    assert.equal((await f.repository.current()).version, after.version);
  },
});

Deno.test({
  name: "every activation refusal is coded, with its context, before any write",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    await using f = await nativeModel();
    const digest = f.executable.version.digest;
    const exercise = f.candidate("coded-exercise", "human").admission!
      .authorityExercise!;
    const cases: Array<[string, Candidate, string]> = [
      ["no admission", {
        ...f.candidate("coded-missing", "builder"),
        admission: undefined,
      }, "ADMISSION_MISSING"],
      ["no successful tests", {
        ...f.candidate("coded-tests", "builder"),
        tests: { passed: false, checks: [] },
      }, "TESTS_NOT_PASSED"],
      [
        "another candidate id",
        (() => {
          const c = f.candidate("coded-id", "builder");
          return { ...c, admission: { ...c.admission!, candidateId: "other" } };
        })(),
        "ADMISSION_CANDIDATE_MISMATCH",
      ],
      [
        "another candidate digest",
        (() => {
          const c = f.candidate("coded-digest", "builder");
          return {
            ...c,
            admission: { ...c.admission!, candidateDigest: "f".repeat(64) },
          };
        })(),
        "ADMISSION_CANDIDATE_MISMATCH",
      ],
      [
        "another configuration revision",
        (() => {
          const c = f.candidate("coded-configuration", "builder");
          return {
            ...c,
            admission: {
              ...c.admission!,
              configurationRevision: c.admission!.configurationRevision + 1,
            },
          };
        })(),
        "ADMISSION_CONFIGURATION_CHANGED",
      ],
      [
        "an unknown authority",
        (() => {
          const c = f.candidate("coded-authority", "builder");
          return {
            ...c,
            admission: { ...c.admission!, authority: "robot" as "human" },
          };
        })(),
        "ADMISSION_AUTHORITY_INVALID",
      ],
      [
        "no actor",
        (() => {
          const c = f.candidate("coded-actor", "builder");
          return { ...c, admission: { ...c.admission!, actorId: "" } };
        })(),
        "ADMISSION_RECORD_INCOMPLETE",
      ],
      [
        "no reason",
        (() => {
          const c = f.candidate("coded-reason", "builder");
          return { ...c, admission: { ...c.admission!, reason: "  " } };
        })(),
        "ADMISSION_RECORD_INCOMPLETE",
      ],
      [
        "another authority action",
        (() => {
          const c = f.candidate("coded-action", "human");
          return {
            ...c,
            admission: {
              ...c.admission!,
              authorityExercise: { ...exercise, action: "model-adoption" },
            },
          };
        })(),
        "ADMISSION_EXERCISE_MISMATCH",
      ],
      [
        "another system",
        (() => {
          const c = f.candidate("coded-system", "human");
          return {
            ...c,
            admission: {
              ...c.admission!,
              authorityExercise: { ...exercise, systemId: "elsewhere" },
            },
          };
        })(),
        "ADMISSION_EXERCISE_MISMATCH",
      ],
      [
        "an exercise under another model digest",
        (() => {
          const c = f.candidate("coded-exercise-digest", "human");
          return {
            ...c,
            admission: {
              ...c.admission!,
              authorityExercise: {
                ...exercise,
                baseModelDigest: "other-digest",
              },
            },
          };
        })(),
        "ADMITTED_MODEL_CHANGED",
      ],
    ];
    const before = await f.repository.current();
    for (const [label, candidate, code] of cases) {
      await assert.rejects(
        () => f.model.activateCandidate(f.identity, candidate, digest),
        refusesWith(code),
        label,
      );
    }
    assert.equal((await f.repository.current()).version, before.version);
    assert.equal(await f.publicationCount(), 0);
    // The context names what was refused, for an agent to act on.
    await assert.rejects(
      () =>
        f.model.activateCandidate(
          f.identity,
          f.candidate("coded-context", "builder"),
          "stale-digest",
        ),
      (error: unknown) =>
        error instanceof CandidateActivationError &&
        error.code === "ADMITTED_MODEL_CHANGED" &&
        error.context.admittedDigest === "stale-digest" &&
        error.context.currentDigest === digest &&
        error.context.systemId === f.identity.systemId,
    );
  },
});

Deno.test({
  name:
    "the literal writer accepts exactly the names isSpellable allows, as the SysML lexer does",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    await using f = await nativeModel();
    let index = 0;
    for (
      const [label, character, spellable] of [
        ["backspace", "\b", true],
        ["form feed", "\f", true],
        ["delete", "\u007f", true],
        ["emoji pair", "\u{1F642}", true],
        ["start of heading", "\u0001", false],
        ["line separator", "\u2028", false],
        ["lone surrogate", "\ud800", false],
      ] as const
    ) {
      const name = `a${character}b`;
      assert.equal(isSpellable(name), spellable, label);
      const candidate = f.candidate(`spelling-${++index}`, "human", name);
      const activation = f.model.activateCandidate(
        f.identity,
        candidate,
        f.executable.version.digest,
      );
      if (spellable) {
        await activation;
        const entry = (await f.model.readExecutableModel(f.identity)).catalog
          .find((entry) => entry.candidateId === candidate.id);
        assert.equal(entry?.name, name, `${label} round-trips`);
      } else {
        await assert.rejects(
          () => activation,
          (error: unknown) =>
            error instanceof ChangePublicationError &&
            error.code === "PUBLICATION_NOT_APPLICABLE",
          label,
        );
      }
    }
  },
});

Deno.test({
  name:
    "a new activation does not scan past activations: lookup by receipt change ID stays constant",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({ prefix: "ase-lookup-" });
    const previousPath = Deno.env.get("PATH") ?? "/usr/bin:/bin";
    const realGit = (await new Deno.Command("/usr/bin/env", {
      args: ["which", "git"],
      stdout: "piped",
    }).output()).stdout;
    const git = new TextDecoder().decode(realGit).trim();
    const log = `${directory}/git-calls.log`;
    const shim = `${directory}/shim`;
    await Deno.mkdir(shim);
    await Deno.mkdir(`${directory}/repository`);
    await Deno.writeTextFile(
      `${shim}/git`,
      `#!/bin/sh\necho "$*" >> '${log}'\nexec '${git}' "$@"\n`,
    );
    await Deno.chmod(`${shim}/git`, 0o755);
    const fixture = await openPostgresRuntimeFixture({ dataDir: directory });
    try {
      const model = fixture.backend.model;
      const identity = await model.initialize();
      const executable = await model.readExecutableModel(identity);
      Deno.env.set("PATH", `${shim}:${previousPath}`);
      const showsDuring = async (candidate: Candidate) => {
        await Deno.writeTextFile(log, "");
        await model.activateCandidate(
          identity,
          candidate,
          executable.version.digest,
        );
        return (await Deno.readTextFile(log)).split("\n").filter((line) =>
          line.includes("show -s --format=%B")
        ).length;
      };
      const admit = (n: number): Candidate => {
        const id = `lookup-candidate-${n}`;
        const digest = n.toString(16).padStart(64, "0");
        return {
          id,
          name: id,
          description: "Receipt lookup fixture",
          kind: "read_web_page",
          code: "export default () => ({title:'Title',text:'Text'})",
          digest,
          stage: "reviewing",
          createdAt: "2026-10-21T00:00:00Z",
          baseCatalogRevision: 0,
          tests: { passed: true, checks: [] },
          admission: {
            candidateId: id,
            candidateDigest: digest,
            mandateRevision: executable.configuration.builder.mandateRevision,
            configurationRevision: executable.configuration.revision,
            authority: "human",
            actorId: identity.rootId,
            authorityExercise: exerciseOwnerAuthority(
              executable,
              "candidate-admission",
            ),
            reason: "Exact lookup admission",
            at: "2026-10-21T00:01:00Z",
          },
        };
      };
      const counts: number[] = [];
      for (let n = 1; n <= 4; n++) counts.push(await showsDuring(admit(n)));
      assert.deepEqual(
        counts,
        [0, 0, 0, 0],
        "the lookup matches the change's own receipt, not every activation",
      );
    } finally {
      Deno.env.set("PATH", previousPath);
      await fixture.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});
