/** Real Git staging isolation with synthetic source/runtime authorization.
 * Native grant qualification and D2 atomicity are separate witnesses. */
import assert from "node:assert/strict";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { materialize } from "../../src/adapters/model/builds/materialization/artifact.ts";
import { requestAdoptionFixture } from "../support/request-adoption-fixture.ts";
import { parseScopedSoftwareContext } from "../../src/application/model/evolution/scoped-software-context.ts";
import type { EvolutionProposalAuthorization } from "../../src/domain/model/evolution/policy.ts";

Deno.test("software Request staging uses its exact branch and dedicated proposal journal after Main advances", async () => {
  const dir = await Deno.makeTempDir({ prefix: "software-request-source-" });
  try {
    const fixture = await requestAdoptionFixture();
    const repositoryId = "12345678-1234-4234-8234-123456789abc";
    fixture.previous.identity.projectId = `git:${repositoryId}`;
    // The synthetic source has no executable grants; this separately retained
    // execution model stands for the admitted R actor rather than source S.
    fixture.previous.modelEditPolicy = {
      id: "r-policy",
      revision: 7,
      elementId: "r-policy",
      sourceIds: [],
      holderNativeId: fixture.target.operatorId,
      mandateNativeId: "r-mandate",
      mandateId: "r-mandate",
      mandateRevision: 1,
      operations: ["replace-source"],
      grants: [],
    };
    let sourceChecks = 0,
      currentChecks = 0,
      guardEntries = 0,
      allowed = true,
      guardAllowed = true;
    const repository = await GitModelRepository.open({
      projectDir: dir,
      repositoryId,
      compiler: {
        compile: (sources) =>
          materialize([], sources, "software-source-fixture"),
        recipe: () =>
          Promise.reject(
            new Error("No native/build qualification in this fixture"),
          ),
      },
      scopedSoftwareActor: () => Promise.resolve(fixture.previous),
      sourceAuthorization: {
        validate(input) {
          if (input.author.startsWith("agent:")) {
            throw new Error(
              "Legacy source actor must not authorize scoped software",
            );
          }
          return Promise.resolve();
        },
        validateScopedSoftware(input, actor) {
          sourceChecks++;
          assert.equal(input.authorization?.kind, "operator-evolution");
          assert.equal(actor.version.digest, fixture.previous.version.digest);
          assert.equal(actor.modelEditPolicy?.id, "r-policy");
          assert.equal(input.before.sources["core.sysml"], "before");
          return Promise.resolve();
        },
      },
    });
    const base = await repository.initialize({ "core.sysml": "before" });
    const { operatorId, ...locator } = fixture.target;
    const scope = parseScopedSoftwareContext({
      format: "software-evolution-scope/v2",
      destination: {
        ...locator,
        repositoryId,
        expectedAdmittedSource: {
          revision: 1,
          source: {
            repositoryId: repository.repositoryId,
            version: base.version,
          },
          sourceDigest: base.sourceDigest,
        },
      },
      openingBaseDigest: fixture.intent.openingBaseDigest,
      predecessorManifestDigest:
        fixture.intent.previous.pin.sourceAdmission.manifestDigest,
      actor: {
        ...fixture.target.host,
        executionSpaceId: fixture.target.executionSpaceId,
        operatorId,
      },
      targets: [{
        target: {
          ...fixture.target.host,
          executionSpaceId: fixture.target.executionSpaceId,
          operatorId,
        },
        previousPin: {
          ...fixture.intent.previous.pin,
          source: { ...fixture.intent.previous.pin.source, repositoryId },
        },
      }],
    });
    const git = async (args: string[]) => {
      const output = await new Deno.Command("git", {
        cwd: dir,
        args,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(output.success, new TextDecoder().decode(output.stderr));
      return new TextDecoder().decode(output.stdout).trim();
    };
    await git(["update-ref", scope.destination.ref, base.version.slice(7)]);
    const mainProposal = await repository.propose({
      baseVersion: base.version,
      sources: { "core.sysml": "Main advanced" },
      author: "local-owner",
      reason: "Separate Main",
    });
    const main = await repository.accept({
      id: mainProposal.id,
      expectedVersion: base.version,
      author: "local-owner",
    });
    const bound = repository.scopedSoftwarePreparationRepository({
      scope,
      assertCurrent() {
        currentChecks++;
        return allowed
          ? Promise.resolve()
          : Promise.reject(new Error("actual runtime authority revoked"));
      },
      async guardNewEffect(effect) {
        guardEntries++;
        if (!guardAllowed) throw new Error("transactional guard refused");
        return await effect();
      },
    });
    assert.equal((await bound.current()).version, base.version);
    const authorization: EvolutionProposalAuthorization = {
      kind: "operator-evolution",
      systemQualifiedName: "System",
      operatorNativeId: operatorId,
      recipeDigest: "a".repeat(64),
      editAuthorization: {
        kind: "operator",
        systemQualifiedName: "System",
        operatorQualifiedName: "System::Actor",
        operatorNativeId: operatorId,
        mandateId: "edit",
        mandateRevision: 1,
        policyId: "edit",
        policyRevision: 1,
        policyDigest: "b".repeat(64),
        operations: ["replace-source"],
      },
      exercise: {
        act: "prepare",
        operatorNativeId: operatorId,
        systemQualifiedName: "System",
        authorityDigest: "c".repeat(64),
        policyId: "evolve",
        policyRevision: 1,
        mandateNativeId: "evolve",
        mandateId: "evolve",
        mandateRevision: 1,
        targets: [operatorId],
        categories: ["instructions"],
        proposalDigest: "d".repeat(64),
      },
    };
    const unguarded = repository.scopedSoftwarePreparationRepository({
      scope,
      assertCurrent: () => Promise.resolve(),
    });
    const refsBeforeRefusal = await git([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ]);
    await assert.rejects(
      () =>
        unguarded.propose({
          baseVersion: base.version,
          sources: { "core.sysml": "Request candidate" },
          author: `agent:${operatorId}`,
          reason: "Missing guard",
          authorization,
        }),
      /transactional authority guard/,
    );
    assert.equal(
      await git(["for-each-ref", "--format=%(refname) %(objectname)"]),
      refsBeforeRefusal,
    );
    const staged = await bound.propose({
      baseVersion: base.version,
      sources: { "core.sysml": "Request candidate" },
      author: `agent:${operatorId}`,
      reason: "Scoped candidate",
      authorization,
    });
    assert.equal(staged.baseVersion, base.version);
    assert.equal(
      (await bound.proposal(staged.id)).authorization?.kind,
      "operator-evolution",
    );
    assert.equal((await repository.current()).version, main.version);
    assert.equal((await bound.current()).version, base.version);
    assert.equal(
      await git(["rev-parse", `refs/heads/software-proposals/${staged.id}`]),
      staged.proposalVersion!.slice(7),
    );
    await assert.rejects(() => repository.proposal(staged.id));
    assert.throws(
      () =>
        bound.accept({
          id: staged.id,
          expectedVersion: base.version,
          author: `agent:${operatorId}`,
        }),
      /dedicated queued command/,
    );
    const records = await repository.listProposals();
    assert.equal(records.some((entry) => entry.id === staged.id), false);
    const readOnly = await GitModelRepository.openReadOnly({
      projectDir: dir,
      repositoryId: repository.repositoryId,
    });
    assert.equal(
      typeof readOnly.verifyScopedSoftwareSourceAdmission,
      "function",
    );
    assert.equal(
      "scopedSoftwareSourceWrite" in readOnly,
      false,
      "historical proof reader exposes no software writer",
    );
    const retainedRefs = await git([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ]);
    await assert.rejects(() =>
      readOnly.verifyScopedSoftwareSourceAdmission(
        JSON.parse('{"format":"request-source-admission/v1"}'),
      ), /scoped software source admission/i);
    assert.equal(
      await git(["for-each-ref", "--format=%(refname) %(objectname)"]),
      retainedRefs,
      "wrong-family immutable proof inspection cannot write or recover refs",
    );
    assert(sourceChecks >= 3 && currentChecks >= 3 && guardEntries === 1);
    guardAllowed = false;
    const refsBeforeGuardRefusal = await git([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ]);
    await assert.rejects(
      () =>
        bound.propose({
          baseVersion: base.version,
          sources: { "core.sysml": "Guard denied" },
          author: `agent:${operatorId}`,
          reason: "Guard refusal",
          authorization,
        }),
      /transactional guard refused/,
    );
    assert.equal(
      await git(["for-each-ref", "--format=%(refname) %(objectname)"]),
      refsBeforeGuardRefusal,
    );
    guardAllowed = true;
    allowed = false;
    const refs = await git([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ]);
    await assert.rejects(
      () =>
        bound.propose({
          baseVersion: base.version,
          sources: { "core.sysml": "Denied" },
          author: `agent:${operatorId}`,
          reason: "Denied candidate",
          authorization,
        }),
      /runtime authority revoked/,
    );
    assert.equal(
      await git(["for-each-ref", "--format=%(refname) %(objectname)"]),
      refs,
    );
    await git(["symbolic-ref", scope.destination.ref, "refs/heads/admitted"]);
    await assert.rejects(() => bound.current(), /symbolic or moved/);
    assert.equal((await repository.current()).version, main.version);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
