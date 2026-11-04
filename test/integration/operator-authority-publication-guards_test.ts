import { createSourceModel } from "../../src/composition/source-model-services.ts";
import assert from "node:assert/strict";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { MemorySourceRepository } from "../support/memory-source-repository.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { sourceModelIdentity } from "../../src/domain/model/records/source-identity.ts";
import { compareModelSources } from "../../src/application/model/revisions/source-diff.ts";
import { modelSourceDigest } from "../../src/domain/model/value-objects/sources.ts";
import {
  assertApprovable,
  assertChangeAuthorityReceipt,
} from "../../src/domain/governance/policies/change-approvability.ts";
import { mainCreationScope } from "../../src/domain/governance/policies/operator-creation-policy.ts";
import { OperatorAuthorityError } from "../../src/domain/governance/operator-authority-error.ts";
import {
  changePublication,
  ChangePublicationError,
} from "../../src/domain/model/publication/change.ts";
import { SystemGovernance } from "../../src/domain/governance/policies/governance.ts";
import type { PendingChange } from "../../src/domain/governance/records/pending-change.ts";

Deno.test({
  name:
    "SourceModel refuses operator authority publication by a non-primary operator with source proposal rights",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const sources = await loadInitialSources(undefined, { information: false });
    const configuration = sources["configuration.sysml"]!;
    const primaryFlag = "attribute primaryContact : Boolean = true;";
    const original = configuration.match(
      / {4}part liveBuilder : ConversationSystem \{[\s\S]*?\n {4}\}/,
    )?.[0];
    assert(original);
    assert.equal(configuration.split(primaryFlag).length, 2);
    const otherPrimary = original.replace(
      "part liveBuilder : ConversationSystem",
      "part mainContact : ConversationSystem",
    ).replace(
      'configurationId : String = "live-builder-native"',
      'configurationId : String = "other-main-contact"',
    );
    const demoted = configuration.replace(
      primaryFlag,
      "attribute primaryContact : Boolean = false;",
    );
    const packageEnd = demoted.lastIndexOf("}");
    sources["configuration.sysml"] = `${
      demoted.slice(0, packageEnd)
    }\n${otherPrimary}\n${demoted.slice(packageEnd)}`;

    const projectId = `git:${crypto.randomUUID()}`;
    const repository = new MemorySourceRepository(
      new ToolkitCompiler({ packageDir }),
    );
    const before = await repository.initialize(sources);
    const identity = sourceModelIdentity(before, projectId);
    const recipient = sourceModelIdentity(
      before,
      projectId,
      "AssemblyLiveBuilder::mainContact",
    );
    const model = createSourceModel({
      repository,
      projectId,
      tooling: new SysmlToolkitAdapter({ packageDir }),
    });
    const current = await model.readExecutableModel(identity);
    assert.equal(current.operator?.primary, false);
    assert.equal(current.policy.mayProposeSysmlRevision, true);
    assert.equal(current.ownerAuthority?.ownerSource, "modeled");
    assert.notEqual(recipient.builderId, identity.builderId);
    const sourceDigest = await modelSourceDigest(before.sources);
    const change: PendingChange = {
      id: crypto.randomUUID(),
      kind: "mandate-change",
      status: "pending",
      requestedBy: identity.builderId,
      designerScopeId: "non-primary-source-policy-request",
      baseRevision: current.configuration.revision,
      baseModelDigest: current.version.digest,
      requestedAt: "2026-10-26T00:00:00Z",
      reason: "Only the primary may request operator authority",
      requestedRights: {
        operatorAuthority: {
          policyId: "non-primary-network",
          expectedPolicyRevision: 0,
          enabled: true,
          recipients: [recipient.builderId],
          acts: ["addNetworkHosts"],
          networkHosts: ["example.org"],
          toolIds: [],
          maxDelegationDepth: 0,
        },
      },
      // Supply the persisted preview envelope required by publication. The
      // primary-role guard must reject before any transformation or diff check.
      diff: {
        title: "Forbidden operator authority proposal",
        author: identity.builderId,
        base: {
          repositoryVersion: before.version,
          modelDigest: current.version.digest,
          sourceDigest,
        },
        sourceDigest,
        ...compareModelSources(before.sources, before.sources),
      },
    };
    assertApprovable(current, change, mainCreationScope(current.identity));
    await assert.rejects(
      () =>
        model.previewApprovedChange(identity, change, current.version.digest),
      (error) =>
        error instanceof OperatorAuthorityError &&
        error.code === "AUTHORITY_POLICY_FORBIDDEN",
    );
    assert.deepEqual((await repository.current()).sources, before.sources);
    assert.equal((await repository.current()).version, before.version);

    const approved = SystemGovernance.fromExecutable(current, [change])
      .decideChange(
        change.id,
        change.baseRevision,
        true,
        "2026-10-26T00:01:00Z",
      );
    assertChangeAuthorityReceipt(
      current,
      approved,
      mainCreationScope(current.identity),
    );
    await assert.rejects(
      () =>
        model.applyApprovedChange(
          identity,
          approved,
          current.version.digest,
          changePublication(approved, current.version),
        ),
      (error) =>
        error instanceof ChangePublicationError &&
        error.code === "PUBLICATION_NOT_APPLICABLE" &&
        error.message === "Only the Main Operator can request a policy",
    );
    const after = await repository.current();
    assert.equal(after.version, before.version);
    assert.deepEqual(after.sources, before.sources);
    assert.equal(repository.versions.size, 1);
    assert.equal(repository.publications.size, 0);
  },
});
