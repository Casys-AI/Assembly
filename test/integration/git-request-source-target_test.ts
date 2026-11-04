/** Real Git target/anchor isolation with synthetic owner metadata and compiler.
 * No success-path native authority or D2 atomic publication is claimed. */
import type { RequestSourceOwnerAuthorityEnvelope } from "../../src/application/model/source-admission/request-source-owner.ts";
import assert from "node:assert/strict";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { materialize } from "../../src/domain/model/value-objects/artifact.ts";
import { requestPublicationFixture } from "../support/request-source-publication-fixture.ts";
import { buildModelWriteDossierV2 } from "../../src/application/model/publication/write-command-v2.ts";
import type { ModelSourceAuthorizationPort } from "../../src/application/governance/ports/out/model-source-authorization.port.ts";
import { ModelBuildServiceError } from "../../src/application/model/builds/service.ts";
import { RequestSourcePublicationPending } from "../../src/application/model/publication/ports/out/request-source-publication.port.ts";
import { modelWriteCommandDigestV2 } from "../../src/application/model/publication/write-command-v2.ts";
import {
  requestSourceAdmissionRef,
  requestSourceCommandRef,
} from "../../src/domain/model/editing/request-source-publication.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { sha256 } from "../../src/domain/primitives/execution-digest.ts";
import { parseModelRevisionRef } from "../../src/domain/model/value-objects/element-ref.ts";

Deno.test("Request Git facade binds every read, excludes Main proposals, and refuses legacy foreign anchors", async () => {
  const dir = await Deno.makeTempDir({ prefix: "request-source-git-target-" });
  try {
    const fixture = await requestPublicationFixture();
    const repository = await GitModelRepository.open({
      projectDir: dir,
      repositoryId: fixture.dossier.command.repositoryId,
      compiler: {
        compile: (sources) =>
          materialize([], sources, "request-target-fixture"),
        recipe: () =>
          Promise.reject(
            new Error("No executable preparation in this witness"),
          ),
      },
    });
    const base = await repository.initialize({ "core.sysml": "before" });
    const destination = {
      ...fixture.dossier.command.destination,
      expectedAdmittedSource: {
        ...fixture.dossier.command.destination.expectedAdmittedSource,
        source: parseModelRevisionRef({
          repositoryId: repository.repositoryId,
          version: base.version,
        }),
        sourceDigest: base.sourceDigest,
      },
    };
    const git = async (args: string[]) => {
      const output = await new Deno.Command("git", {
        cwd: dir,
        args,
        stdout: "piped",
        stderr: "piped",
        env: {
          GIT_AUTHOR_NAME: "Request fixture",
          GIT_AUTHOR_EMAIL: "request-fixture@example.invalid",
          GIT_COMMITTER_NAME: "Request fixture",
          GIT_COMMITTER_EMAIL: "request-fixture@example.invalid",
        },
      }).output();
      assert(output.success, new TextDecoder().decode(output.stderr));
      return new TextDecoder().decode(output.stdout).trim();
    };
    await git(["update-ref", destination.ref, base.version.slice(7)]);
    const mainProposal = await repository.propose({
      baseVersion: base.version,
      sources: { "core.sysml": "Main-only advance" },
      author: "local-owner",
      reason: "Independent Main witness",
    });
    const main = await repository.accept({
      id: mainProposal.id,
      author: "local-owner",
      expectedVersion: base.version,
    });
    let authorityChecks = 0, settlements = 0;
    const noNewAuthority = () => {
      authorityChecks++;
      return Promise.reject(new Error("No current creation authority"));
    };
    const options = {
      destination,
      openingBaseDigest: "2".repeat(64),
      predecessorManifestDigest: "3".repeat(64),
      protocol: {
        assertProposal: noNewAuthority,
        assertNewEffect: noNewAuthority,
        guardNewPublication: () =>
          Promise.reject(new Error("No new effect allowed")),
        settleHistorical: () => {
          settlements++;
          return Promise.reject(new Error("Foreign evidence must not settle"));
        },
      },
    };
    const target = repository.requestSourceTarget(options);
    assert.equal(
      (await target.current()).version,
      base.version,
      "explicit Request stays on its own ref after Main advances",
    );
    const missing = {
      ...destination,
      branchId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ref: "refs/heads/requests/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    await assert.rejects(
      () =>
        repository.requestSourceTarget({ ...options, destination: missing })
          .current(),
      /missing/,
    );
    const authority = structuredClone(
      fixture.dossier.authority,
    ) as RequestSourceOwnerAuthorityEnvelope;
    const bind = <P extends "proposal" | "acceptance">(phase: P) => ({
      ...authority[phase],
      destination,
      priorModel: {
        ...authority[phase].priorModel,
        version: {
          ...authority[phase].priorModel.version,
          repositoryVersion: base.version,
        },
      },
    });
    const envelope = {
      ...authority,
      proposal: bind("proposal"),
      acceptance: bind("acceptance"),
    };
    const dossier = await buildModelWriteDossierV2({
      ...fixture.dossier.command,
      destination,
      authority: envelope,
      operations: {
        kind: "whole-files",
        files: {
          v: 1,
          base: destination.expectedAdmittedSource.source,
          baseSourceDigest: base.sourceDigest,
          files: [{
            path: "core.sysml",
            baseDigest: await sha256("before"),
            text: "Main-only advance",
          }],
        },
      },
      decision: {
        kind: "accept-proposal",
        proposalId: fixture.dossier.command.commandId,
        baseVersion: base.version,
        proposalVersion: mainProposal.proposalVersion!,
        proposalSourceDigest: main.sourceDigest,
        expectedVersion: base.version,
        author: "local-owner",
        decisionAuthorityExercise: envelope.acceptance.exercise,
      },
    });
    const facade = await target.bind(dossier);
    assert.equal(await facade.recover(), null);
    await git([
      "update-ref",
      requestSourceCommandRef(dossier.command.commandId),
      main.version.slice(7),
    ]);
    await assert.rejects(
      () => facade.recover(),
      /destination-bound publication receipt/,
    );
    assert.equal(
      authorityChecks,
      0,
      "historical structural binding never exercises a current credential",
    );
    assert.equal(
      settlements,
      0,
      "a Main/global anchor is not Request admission evidence",
    );
    const record = {
      id: dossier.command.commandId,
      branch: `proposal_${dossier.command.commandId}`,
      author: "local-owner",
      reason: "Scoped journal fixture",
      baseVersion: base.version,
      createdAt: "2026-10-30T01:00:00.000Z",
      status: "proposed",
      validation: "validated",
      sourceDigest: main.sourceDigest,
      proposalVersion: mainProposal.proposalVersion,
      diff: mainProposal.diff,
      requestSource: {
        format: "request-source-proposal/v1",
        destination,
        authority: envelope.proposal,
      },
    };
    await Deno.writeTextFile(
      `${repository.stateDir}/proposals/${record.id}.json`,
      JSON.stringify({
        value: record,
        digest: await sha256(canonical(record)),
      }),
    );
    assert.equal((await target.proposal(record.id)).id, record.id);
    const { expectedAdmittedSource: _expected, ...locator } = destination;
    const stored = await repository.readRequestSourceProposal(
      locator,
      record.id,
    );
    assert.deepEqual(stored?.destination, destination);
    assert.deepEqual(stored?.authority, envelope.proposal);
    assert.equal(
      await repository.readRequestSourceProposal(locator, mainProposal.id),
      null,
    );
    assert.equal(
      await repository.readRequestSourceProposal({
        ...locator,
        caseId: "another-case",
      }, record.id),
      null,
    );
    await assert.rejects(() =>
      repository.readRequestSourceProposal({
        ...locator,
        ref: "refs/heads/main",
      }, record.id)
    );
    await assert.rejects(() =>
      repository.readRequestSourceProposal({
        ...locator,
        host: { ...locator.host, projectId: "another-host" },
      }, record.id)
    );
    await assert.rejects(() =>
      repository.readRequestSourceProposal(locator, "../not-a-proposal")
    );
    await assert.rejects(() => repository.proposal(record.id), /not found/);
    assert(
      !(await repository.listProposals()).some((proposal) =>
        proposal.id === record.id
      ),
    );
    assert.equal((await repository.current()).version, main.version);
    assert.equal((await target.current()).version, base.version);

    // Exact old A0 must authorize both native phases; the candidate/Main A1
    // may not authorize itself. No full native grant exists in this fixture.
    await git([
      "update-ref",
      "-d",
      requestSourceCommandRef(dossier.command.commandId),
    ]);
    const calls: Parameters<ModelSourceAuthorizationPort["validate"]>[0][] = [];
    let nativeUnavailable = false;
    const denyingRepository = await GitModelRepository.open({
      ...repository.options,
      sourceAuthorization: {
        validate: (input) => {
          calls.push(structuredClone(input));
          return Promise.reject(
            nativeUnavailable
              ? new ModelBuildServiceError("BUILD_UNAVAILABLE", {
                reason: "fixture unavailable retained inspection",
              }, "Native proof is temporarily unavailable")
              : new Error("rejecting native source port"),
          );
        },
      },
    });
    const nativeTarget = denyingRepository.requestSourceTarget({
      ...options,
      protocol: {
        ...options.protocol,
        assertProposal: () => Promise.resolve(),
        assertNewEffect: () => Promise.resolve(),
      },
    });
    const beforeRefs = await git([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ]);
    await assert.rejects(
      () =>
        nativeTarget.propose({
          sources: { "core.sysml": "Attempt Request instructions" },
          reason: "Native proposal refusal",
          authority: envelope.proposal,
        }),
      /rejecting native source port/,
    );
    const nativeFacade = await nativeTarget.bind(dossier);
    const lease = {
      repositoryId: dossier.command.repositoryId,
      commandId: dossier.command.commandId,
      owner: "fixture-worker",
      fence: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    await assert.rejects(
      () => nativeFacade.accept(lease),
      /rejecting native source port/,
    );
    assert.deepEqual(calls.map((input) => input.phase), [
      "proposal",
      "acceptance",
    ]);
    for (const input of calls) {
      assert.equal(input.authority.version, base.version);
      assert.equal(input.before.version, base.version);
      assert.deepEqual(input.authorization, {
        kind: "local-owner",
        authorityExercise: envelope.proposal.exercise,
      });
    }
    assert.deepEqual(
      calls[1].decisionAuthorityExercise,
      envelope.acceptance.exercise,
    );
    assert.equal(
      await git(["for-each-ref", "--format=%(refname) %(objectname)"]),
      beforeRefs,
      "rejecting native authorizer permits no proposal pin or admitted CAS",
    );

    // Any-parent reachability is insufficient: a foreign first-parent line
    // cannot become Request history by merging the Request as second parent.
    const tree = await git(["rev-parse", `${base.version.slice(7)}^{tree}`]);
    const foreign = await git([
      "commit-tree",
      tree,
      "-m",
      "Independent foreign root",
    ]);
    const cross = await git([
      "commit-tree",
      tree,
      "-p",
      foreign,
      "-p",
      base.version.slice(7),
      "-m",
      "Request only as second parent",
    ]);
    await git(["update-ref", destination.ref, cross]);
    await assert.rejects(
      () => facade.at(base.version),
      /outside the Request source history/,
    );

    // Synthetic command attestation is enough to reach proof reconstruction,
    // but never enough to settle D2. Both lineage and native validation remain.
    const commandDigest = await modelWriteCommandDigestV2(dossier.command);
    const body =
      `Synthetic Request proof\n\nASE-Write-Command: ${dossier.command.commandId} ${commandDigest}\nASE-Request-Source: ${
        canonical({ commandDigest })
      }\n`;
    const resultTree = await git([
      "rev-parse",
      `${main.version.slice(7)}^{tree}`,
    ]);
    const published = await git([
      "commit-tree",
      resultTree,
      "-p",
      base.version.slice(7),
      "-p",
      mainProposal.proposalVersion!.slice(7),
      "-m",
      body,
    ]);
    const publishedVersion = `commit:${published}`;
    await git([
      "update-ref",
      requestSourceCommandRef(dossier.command.commandId),
      published,
    ]);
    await git([
      "update-ref",
      requestSourceAdmissionRef(dossier.command.commandId, publishedVersion),
      published,
    ]);
    await assert.rejects(
      () => repository.findPublicationByCommand(dossier.command.commandId),
      /explicit Request destination/,
    );
    const unrelatedMerge = await git([
      "commit-tree",
      resultTree,
      "-p",
      foreign,
      "-p",
      published,
      "-m",
      "Publication only as second parent",
    ]);
    await git(["update-ref", destination.ref, unrelatedMerge]);
    await assert.rejects(() => nativeFacade.recover(lease), /lineage differ/);
    assert.equal(
      calls.length,
      2,
      "second-parent proof refuses before any native reinspection",
    );
    await git(["update-ref", destination.ref, published]);
    nativeUnavailable = true;
    await assert.rejects(
      () => nativeFacade.recover(lease),
      (error) => error instanceof RequestSourcePublicationPending,
    );
    assert.equal(calls[2].phase, "recovery");
    assert.equal(calls[2].authority.version, base.version);
    assert.deepEqual(
      calls[2].decisionAuthorityExercise,
      envelope.acceptance.exercise,
    );
    const originalSearchPath = Deno.env.get("PATH");
    try {
      Deno.env.set("PATH", `${dir}/unavailable-git-executable`);
      await assert.rejects(
        () => nativeFacade.recover(lease),
        (error) => error instanceof RequestSourcePublicationPending,
      );
    } finally {
      if (originalSearchPath === undefined) Deno.env.delete("PATH");
      else Deno.env.set("PATH", originalSearchPath);
    }
    nativeUnavailable = false;
    await assert.rejects(
      () => nativeFacade.recover(lease),
      /rejecting native source port/,
    );
    assert.equal(
      settlements,
      0,
      "unavailable or denied native proof never admits synthetic Git data",
    );
    assert.equal(
      (await repository.current()).version,
      main.version,
      "Request proof attempts do not move Main",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
