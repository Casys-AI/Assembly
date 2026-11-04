import { SYSML_TOOLKIT_VERSION } from "../../src/adapters/out/sysml-toolkit/runtime/loader.ts";
import assert from "node:assert/strict";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { resolveModelEdits } from "../../src/domain/model/editing/source-index.ts";
import {
  sourceCompilation,
  sourceEvolutionCompilation,
  validateSourceExecutable,
} from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { createOperatorEditAuthorization } from "../../src/application/governance/model-access/operator-edit-authorization.ts";
import { NativeModelSourceAuthorization } from "../../src/application/governance/model-access/source-authorization.ts";
import {
  AuthorityInvariantError,
  exerciseOwnerAuthority,
} from "../../src/domain/governance/authority.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { operatorAuthorityRequests } from "../../src/composition/source-model-services.ts";
import { requestOperatorSystemName } from "../../src/application/governance/operator-authority-values.ts";
import { applyEdits } from "../../src/application/model/editing/host-writer.ts";
import {
  assertCreationWithinPolicy,
  mainCreationScope,
} from "../../src/domain/governance/policies/operator-creation-policy.ts";
import type { TeamOperatorSpec } from "../../src/domain/governance/operator-authority.ts";
import {
  editPolicy,
  mandateSources,
  nativeId,
} from "../fixtures/model-edit-mandate.ts";

Deno.test({
  name:
    "native authority invariants: renaming a modeled root requires explicit recovery",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const projectId = "git:2e2a53c6-5e51-562c-8570-63d4461ceb22";
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const current = {
      ...await compiler.compile(await mandateSources()),
      version: "current",
    };
    const system = "AssemblyLiveBuilder::liveBuilder";
    const model = await validateSourceExecutable(current, projectId, system);
    const edited = await tooling.edit(
      current.sources,
      resolveModelEdits(current, [{
        kind: "rename",
        elementId: nativeId(current, system),
        name: "renamedBuilder",
      }]),
    );
    const after = await compiler.compile(edited.sources);
    const renamed = await validateSourceExecutable(
      { ...after, version: "renamed" },
      projectId,
      "AssemblyLiveBuilder::renamedBuilder",
    );
    assert.notEqual(renamed.identity.systemId, model.identity.systemId);
    assert.equal(renamed.ownerAuthority?.ownerSource, "modeled");
    const authorizer = new NativeModelSourceAuthorization(
      projectId,
      sourceCompilation,
      sourceEvolutionCompilation,
    );
    const owner = exerciseOwnerAuthority(model, "model-revision");
    const recovery = exerciseOwnerAuthority(model, "model-revision", {
      outOfMandate: true,
      reason: "Recreate the modeled root after renaming the system",
    });
    for (const phase of ["proposal", "acceptance", "recovery"] as const) {
      const base = {
        authority: current,
        before: current,
        after,
        author: "local-owner",
        phase,
      };
      await assert.rejects(
        () =>
          authorizer.validate({
            ...base,
            authorization: { kind: "local-owner", authorityExercise: owner },
            ...(phase !== "proposal"
              ? { decisionAuthorityExercise: owner }
              : {}),
          }),
        (error: unknown) =>
          error instanceof AuthorityInvariantError && error.invariant === 3 &&
          error.reason === "modeled-root-recreation-requires-recovery",
      );
      await authorizer.validate({
        ...base,
        authorization: { kind: "local-owner", authorityExercise: recovery },
        ...(phase !== "proposal"
          ? { decisionAuthorityExercise: recovery }
          : {}),
      });
    }
  },
});

Deno.test({
  name:
    "native authority invariants: ordinary peer contract edits affect the protected digest but remain allowed",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const projectId = "git:2e2a53c6-5e51-562c-8570-63d4461ceb22";
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const current = {
      ...await compiler.compile(await mandateSources()),
      version: "current",
    };
    const peerName = "AssemblyLiveBuilder::mandatePeer";
    const [primary, peer] = await Promise.all([
      validateSourceExecutable(
        current,
        projectId,
        "AssemblyLiveBuilder::liveBuilder",
      ),
      validateSourceExecutable(current, projectId, peerName),
    ]);
    const edited = await tooling.edit(
      current.sources,
      resolveModelEdits(current, [{
        kind: "set-value",
        elementId: nativeId(
          current,
          `${peerName}::catalog::readWebPageContract::acceptanceCriteria`,
        ),
        expression: '"Extract the complete readable page title and body."',
      }]),
    );
    const after = await compiler.compile(edited.sources);
    const updated = await validateSourceExecutable(
      { ...after, version: "updated-peer-contract" },
      projectId,
      peerName,
    );
    assert.deepEqual(updated.ownerAuthority, peer.ownerAuthority);
    assert.deepEqual(updated.modelEditPolicy, peer.modelEditPolicy);
    // protectedAuthority compares this execution digest, which also includes
    // ordinary contracts and flows. It is not an authority-only signature.
    assert.notEqual(updated.version.digest, peer.version.digest);
    assert.notDeepEqual(updated.contracts, peer.contracts);
    const owner = exerciseOwnerAuthority(primary, "model-revision");
    assert.notEqual(owner.systemId, peer.identity.systemId);
    assert.equal(owner.outOfMandate, false);
    const authorizer = new NativeModelSourceAuthorization(
      projectId,
      sourceCompilation,
      sourceEvolutionCompilation,
    );
    for (const phase of ["proposal", "acceptance"] as const) {
      await authorizer.validate({
        authority: current,
        before: current,
        after,
        authorization: { kind: "local-owner", authorityExercise: owner },
        author: "local-owner",
        phase,
        ...(phase === "acceptance" ? { decisionAuthorityExercise: owner } : {}),
      });
    }
  },
});

Deno.test({
  name:
    "native authority invariants: proposals and decisions use prior authority, including recovery",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const projectId = "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf";
    const system = "AssemblyLiveBuilder::liveBuilder";
    const compiler = new ToolkitCompiler({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    });
    const sources = await mandateSources();
    const current = { ...await compiler.compile(sources), version: "current" };
    const before = {
      ...await compiler.compile({
        ...sources,
        "configuration.sysml": sources["configuration.sysml"]!.replace(
          editPolicy("Work::alpha"),
          "",
        ),
      }),
      version: "before-grant",
    };
    const candidate = await compiler.compile({
      ...sources,
      "mission.sysml": sources["mission.sysml"]!.replace(
        "value : Integer = 1",
        "value : Integer = 3",
      ),
    });
    const currentModel = await validateSourceExecutable(
      current,
      projectId,
      system,
    );
    const beforeModel = await validateSourceExecutable(
      before,
      projectId,
      system,
    );
    const authorization = await createOperatorEditAuthorization(
      currentModel,
      current,
      ["set-value"],
    );
    const authorizer = new NativeModelSourceAuthorization(
      projectId,
      sourceCompilation,
      sourceEvolutionCompilation,
    );
    const author = `agent:${currentModel.identity.builderId}`;
    const isPriorError = (error: unknown) =>
      error instanceof AuthorityInvariantError && error.invariant === 3;
    await assert.rejects(() =>
      authorizer.validate({
        authority: current,
        before,
        after: candidate,
        authorization,
        author,
        phase: "proposal",
      }), isPriorError);
    for (const phase of ["proposal", "acceptance", "recovery"] as const) {
      await assert.rejects(() =>
        authorizer.validate({
          authority: before,
          before,
          after: candidate,
          authorization,
          author,
          phase,
          ...(phase !== "proposal"
            ? {
              decisionAuthorityExercise: exerciseOwnerAuthority(
                beforeModel,
                "model-revision",
              ),
            }
            : {}),
        }), isPriorError);
    }
    await authorizer.validate({
      authority: current,
      before: current,
      after: candidate,
      authorization,
      author,
      phase: "acceptance",
      decisionAuthorityExercise: exerciseOwnerAuthority(
        currentModel,
        "model-revision",
      ),
    });
    await assert.rejects(() =>
      authorizer.validate({
        authority: current,
        before: current,
        after: candidate,
        authorization,
        author,
        phase: "acceptance",
      }), isPriorError);
    const local = {
      kind: "local-owner" as const,
      authorityExercise: exerciseOwnerAuthority(currentModel, "model-revision"),
    };
    const wrongDecision = {
      ...exerciseOwnerAuthority(currentModel, "model-revision"),
      baseModelDigest: "candidate-state",
    };
    await assert.rejects(() =>
      authorizer.validate({
        authority: current,
        before: current,
        after: candidate,
        authorization: local,
        author: "local-owner",
        phase: "acceptance",
        decisionAuthorityExercise: wrongDecision,
      }), isPriorError);
    const recovery = exerciseOwnerAuthority(currentModel, "model-revision", {
      outOfMandate: true,
      reason: "Restore an unusable owner mandate",
    });
    await authorizer.validate({
      authority: current,
      before: current,
      after: candidate,
      authorization: { kind: "local-owner", authorityExercise: recovery },
      author: "local-owner",
      phase: "proposal",
    });
    await assert.rejects(() =>
      authorizer.validate({
        authority: current,
        before: current,
        after: candidate,
        authorization: { kind: "local-owner", authorityExercise: recovery },
        author: "local-owner",
        phase: "acceptance",
        decisionAuthorityExercise: exerciseOwnerAuthority(
          currentModel,
          "model-revision",
        ),
      }), isPriorError);
    await authorizer.validate({
      authority: current,
      before: current,
      after: candidate,
      authorization: { kind: "local-owner", authorityExercise: recovery },
      author: "local-owner",
      phase: "acceptance",
      decisionAuthorityExercise: recovery,
    });
  },
});

Deno.test({
  name:
    "native authority invariants: foreign owner cannot propose or admit another system root change",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const projectId = "git:2e2a53c6-5e51-562c-8570-63d4461ceb22";
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const sources = await mandateSources();
    sources["configuration.sysml"] = sources["configuration.sysml"]!
      .replace("part mandatePeer :", "part collector :")
      .replace(editPolicy("Work::beta"), "");
    const current = { ...await compiler.compile(sources), version: "current" };
    const [liveBuilder, collector] = await Promise.all([
      validateSourceExecutable(
        current,
        projectId,
        "AssemblyLiveBuilder::liveBuilder",
      ),
      validateSourceExecutable(
        current,
        projectId,
        "AssemblyLiveBuilder::collector",
      ),
    ]);
    const foreign = exerciseOwnerAuthority(liveBuilder, "model-revision");
    const owner = exerciseOwnerAuthority(collector, "model-revision");
    assert.notEqual(foreign.systemId, owner.systemId);
    assert.equal(foreign.outOfMandate, false);
    const edited = await tooling.edit(
      current.sources,
      resolveModelEdits(current, [{
        kind: "set-value",
        elementId: nativeId(
          current,
          "AssemblyLiveBuilder::collector::owner::ownerMandate::rootAuthority::id",
        ),
        expression: '"collector-replacement-root"',
      }]),
    );
    assert.equal(edited.provider.version, SYSML_TOOLKIT_VERSION);
    const candidate = await compiler.compile(edited.sources);
    const authorizer = new NativeModelSourceAuthorization(
      projectId,
      sourceCompilation,
      sourceEvolutionCompilation,
    );
    const base = {
      authority: current,
      before: current,
      after: candidate,
      author: "local-owner",
    };
    const isScopeError = (error: unknown) =>
      error instanceof AuthorityInvariantError && error.invariant === 3 &&
      error.reason === "local-owner-root-outside-authority";
    for (const phase of ["proposal", "acceptance", "recovery"] as const) {
      await assert.rejects(() =>
        authorizer.validate({
          ...base,
          authorization: { kind: "local-owner", authorityExercise: foreign },
          phase,
          ...(phase !== "proposal"
            ? { decisionAuthorityExercise: foreign }
            : {}),
        }), isScopeError);
      await authorizer.validate({
        ...base,
        authorization: { kind: "local-owner", authorityExercise: owner },
        phase,
        ...(phase !== "proposal" ? { decisionAuthorityExercise: owner } : {}),
      });
      if (phase !== "proposal") {
        await assert.rejects(() =>
          authorizer.validate({
            ...base,
            authorization: { kind: "local-owner", authorityExercise: owner },
            phase,
            decisionAuthorityExercise: foreign,
          }), isScopeError);
        await assert.rejects(() =>
          authorizer.validate({
            ...base,
            authorization: { kind: "local-owner", authorityExercise: foreign },
            phase,
            decisionAuthorityExercise: owner,
          }), isScopeError);
      }
    }
    const recovery = exerciseOwnerAuthority(liveBuilder, "model-revision", {
      outOfMandate: true,
      reason: "Explicit local recovery of the collector root",
    });
    await authorizer.validate({
      ...base,
      authorization: { kind: "local-owner", authorityExercise: recovery },
      phase: "acceptance",
      decisionAuthorityExercise: recovery,
    });

    for (const kind of ["remove", "rename"] as const) {
      const elementId = nativeId(current, "AssemblyLiveBuilder::collector");
      const changed = await tooling.edit(
        current.sources,
        resolveModelEdits(current, [
          kind === "rename"
            ? { kind, elementId, name: "renamedCollector" }
            : { kind, elementId },
        ]),
      );
      const after = await compiler.compile(changed.sources);
      for (const phase of ["proposal", "acceptance"] as const) {
        await assert.rejects(() =>
          authorizer.validate({
            ...base,
            after,
            authorization: { kind: "local-owner", authorityExercise: foreign },
            phase,
            ...(phase === "acceptance"
              ? { decisionAuthorityExercise: foreign }
              : {}),
          }), isScopeError);
      }
    }

    // A legacy peer also owns its root installation; another system's modeled
    // owner cannot use the absence of that root as project-wide authority.
    const configuration = sources["configuration.sysml"]!;
    const collectorStart = configuration.indexOf("part collector :");
    assert(collectorStart > 0);
    const legacySources = {
      ...sources,
      "configuration.sysml": configuration.slice(0, collectorStart) +
        configuration.slice(collectorStart)
          .replace("attribute authoritySchema : Integer = 2;", "")
          .replace(
            /part owner : AssemblyCore::HumanOperator \{[\s\S]*?bind owner\.ownerMandate\.holder = owner;/,
            "",
          ),
    };
    const legacy = {
      ...await compiler.compile(legacySources),
      version: "legacy-collector",
    };
    const legacyCollector = await validateSourceExecutable(
      legacy,
      projectId,
      "AssemblyLiveBuilder::collector",
    );
    assert.equal(
      legacyCollector.ownerAuthority?.ownerSource,
      "implicit-legacy",
    );
    const legacyForeign = exerciseOwnerAuthority(
      await validateSourceExecutable(
        legacy,
        projectId,
        "AssemblyLiveBuilder::liveBuilder",
      ),
      "model-revision",
    );
    const legacyOwner = exerciseOwnerAuthority(
      legacyCollector,
      "model-revision",
    );
    for (const phase of ["proposal", "acceptance"] as const) {
      await assert.rejects(() =>
        authorizer.validate({
          ...base,
          authority: legacy,
          before: legacy,
          after: current,
          authorization: {
            kind: "local-owner",
            authorityExercise: legacyForeign,
          },
          phase,
          ...(phase === "acceptance"
            ? { decisionAuthorityExercise: legacyForeign }
            : {}),
        }), isScopeError);
      await authorizer.validate({
        ...base,
        authority: legacy,
        before: legacy,
        after: current,
        authorization: { kind: "local-owner", authorityExercise: legacyOwner },
        phase,
        ...(phase === "acceptance"
          ? { decisionAuthorityExercise: legacyOwner }
          : {}),
      });
    }
  },
});

Deno.test({
  name:
    "native authority invariants: a person's Request decision covers only the named teammate of the exercised operator",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const projectId = "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf";
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const compiler = new ToolkitCompiler({ packageDir });
    const tooling = new SysmlToolkitAdapter({ packageDir });
    const compile = async (
      sources: Record<string, string>,
      version: string,
    ) => ({
      ...await compiler.compile(sources),
      version,
    });
    const mainScope = "AssemblyLiveBuilder::liveBuilder";
    let revision = await compile(
      await loadInitialSources(undefined, { information: false }),
      "main",
    );
    const owner = await operatorAuthorityRequests(revision, {
      op: "createRequestOperator",
      systemName: mainScope,
      changeId: "team-root-request-owner",
      name: "Request owner",
      operator: {
        instruction: "Own one Request.",
        networkHosts: [],
        requestType: { name: "Research", maxInvocations: 4 },
        firstRequest: { objective: "Prepare one contribution." },
        creationGrant: {
          networkHosts: [],
          maxChildren: 1,
          maxDelegationDepth: 1,
        },
      },
    });
    revision = await compile(
      (await applyEdits(tooling, revision, owner.requests, {
        compile: (sources) => compile(sources, "owner"),
      })).sources,
      "owner",
    );
    const ownerScope = owner.systemQualifiedName;
    const parent = await validateSourceExecutable(
      revision,
      projectId,
      ownerScope,
    );
    const spec: TeamOperatorSpec = {
      kind: "request-team-member",
      instruction: "Contribute one result.",
      provision: {
        budget: { maxAgentDecisions: 1, maxToolProposals: 0, maxFlowSteps: 1 },
        networkHosts: [],
        mayPropose: [],
        mayInvokeActiveCatalog: false,
      },
    };
    const grant = assertCreationWithinPolicy(
      parent,
      spec,
      undefined,
      mainCreationScope(parent.identity),
    );
    const member = await operatorAuthorityRequests(revision, {
      op: "createRequestOperator",
      systemName: ownerScope,
      changeId: "team-root-member",
      name: "team-root-member",
      operator: spec,
      creatorMayAddNetworkHosts: parent.policy.mayAddNetworkHosts,
      teamOrigin: { operatorId: parent.identity.builderId, requestId: "case" },
      parentOperatorId: parent.identity.builderId,
      creationPolicy: {
        id: grant.id,
        revision: grant.revision,
        elementId: grant.elementId,
      },
    });
    assert.equal(
      member.systemQualifiedName,
      await requestOperatorSystemName(ownerScope, "team-root-member"),
    );
    const after = await compile(
      (await applyEdits(tooling, revision, member.requests, {
        compile: (sources) => compile(sources, "member"),
      })).sources,
      "member",
    );
    const child = await validateSourceExecutable(
      after,
      projectId,
      member.systemQualifiedName,
    );
    assert.equal(child.ownerAuthority?.ownerSource, "modeled");
    assert.equal(
      child.operatorTeam?.parentOperatorId,
      parent.identity.builderId,
    );
    const authorizer = new NativeModelSourceAuthorization(
      projectId,
      sourceCompilation,
      sourceEvolutionCompilation,
    );
    const exercise = exerciseOwnerAuthority(parent, "model-revision");
    const foreign = exerciseOwnerAuthority(
      await validateSourceExecutable(revision, projectId, mainScope),
      "model-revision",
    );
    const isRootRefusal = (error: unknown) =>
      error instanceof AuthorityInvariantError && error.invariant === 3 &&
      error.reason === "modeled-root-recreation-requires-recovery";
    for (const phase of ["acceptance", "recovery"] as const) {
      const validate = (
        receipt: typeof exercise,
        teamCreationRoot?: string,
      ) =>
        authorizer.validate({
          authority: revision,
          before: revision,
          after,
          author: "local-owner",
          phase,
          authorization: { kind: "local-owner", authorityExercise: receipt },
          decisionAuthorityExercise: receipt,
          ...(teamCreationRoot ? { teamCreationRoot } : {}),
        });
      // Unnamed, or named otherwise, the new root still needs recovery.
      await assert.rejects(() => validate(exercise), isRootRefusal);
      await assert.rejects(
        () => validate(exercise, `${ownerScope}Other`),
        isRootRefusal,
      );
      // Authority over another operator never covers this parent's teammate.
      await assert.rejects(
        () => validate(foreign, member.systemQualifiedName),
        isRootRefusal,
      );
      await validate(exercise, member.systemQualifiedName);
    }
  },
});
