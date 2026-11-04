import { SYSML_TOOLKIT_VERSION } from "../../src/adapters/out/sysml-toolkit/runtime/loader.ts";
import assert from "node:assert/strict";
import {
  createModelRevisionHandler,
  type ModelRevisionHandlerOptions,
} from "../../src/adapters/in/http/model/revisions.ts";
import { NativeModelSourceAuthorization } from "../../src/application/governance/model-access/source-authorization.ts";
import { resolveModelEdits } from "../../src/domain/model/editing/source-index.ts";
import {
  sourceCompilation,
  sourceEvolutionCompilation,
  validateSourceExecutable,
} from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import type {
  ModelRevision,
  ProposalRecord,
} from "../../src/domain/model/records/revision.ts";
import { mandateSources, nativeId } from "../fixtures/model-edit-mandate.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

function post(path: string, input: unknown) {
  return new Request(`http://127.0.0.1:4311${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** Real HTTP handler, Toolkit and authority validator; only revision storage is
 * a fixture. Its file journal lets HTTP receipts be reloaded without Git writes. */
async function fixture(directory: string) {
  const projectId = "git:8e4f72c5-1193-57ed-842a-7e574690f2f3";
  const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
  const compiler = new ToolkitCompiler({ packageDir });
  const tooling = new SysmlToolkitAdapter({ packageDir });
  const authorization = new NativeModelSourceAuthorization(
    projectId,
    sourceCompilation,
    sourceEvolutionCompilation,
  );
  const initial = {
    ...await compiler.compile(await mandateSources()),
    version: "branch:initial",
  };
  let current: ModelRevision = initial;
  const revisions = new Map([[initial.version, initial]]);
  const native = await validateSourceExecutable(
    current,
    projectId,
    "AssemblyLiveBuilder::liveBuilder",
  );
  const peer = await validateSourceExecutable(
    current,
    projectId,
    "AssemblyLiveBuilder::mandatePeer",
  );
  const recordPath = `${directory}/proposal.json`;
  const readRecord = async (): Promise<ProposalRecord> =>
    JSON.parse(await Deno.readTextFile(recordPath));
  const saveRecord = async (record: ProposalRecord) => {
    await Deno.writeTextFile(recordPath, JSON.stringify(record));
  };
  const unused = () => {
    throw new Error("Unexpected repository operation in HTTP recovery test");
  };
  const repository: ModelRevisionHandlerOptions["repository"] = {
    lastChangeByPath: () => Promise.resolve([]),
    current: () => Promise.resolve(current),
    at: (version) => {
      const revision = revisions.get(version);
      assert(revision, version);
      return Promise.resolve(revision);
    },
    header: (version) => {
      const revision = revisions.get(version);
      assert(revision, version);
      return Promise.resolve({
        version,
        sources: revision.sources,
        sourceDigest: revision.sourceDigest,
      });
    },
    async propose(input) {
      const before = await repository.at(input.baseVersion);
      const compiled = await compiler.compile(input.sources);
      await authorization.validate({
        authority: current,
        before,
        after: compiled,
        authorization: input.authorization,
        author: input.author,
        phase: "proposal",
      });
      const proposed = { ...compiled, version: "branch:proposed" };
      revisions.set(proposed.version, proposed);
      const record: ProposalRecord = {
        id: "8f6bcabc-a5a5-4ad3-af2c-41c6510ce635",
        branch: "proposal_recovery",
        author: input.author,
        authorization: input.authorization,
        reason: input.reason,
        baseVersion: before.version,
        createdAt: new Date().toISOString(),
        status: "proposed",
        validation: "validated",
        sourceDigest: proposed.sourceDigest,
        proposalVersion: proposed.version,
        diff: [],
      };
      await saveRecord(record);
      return record;
    },
    proposal: readRecord,
    listProposals: async () => [await readRecord()],
    readProposalJournal: async () => [await readRecord()],
    async accept(input) {
      const record = await readRecord();
      assert.equal(input.expectedVersion, current.version);
      assert.equal(input.id, record.id);
      const proposed = await repository.at(record.proposalVersion!);
      await authorization.validate({
        authority: current,
        before: current,
        after: proposed,
        authorization: record.authorization,
        decisionAuthorityExercise: input.decisionAuthorityExercise,
        author: record.author,
        phase: "acceptance",
      });
      current = { ...proposed, version: "branch:accepted" };
      revisions.set(current.version, current);
      await saveRecord({
        ...record,
        status: "accepted",
        acceptedVersion: current.version,
        decidedBy: input.author,
        decisionAuthorityExercise: input.decisionAuthorityExercise,
      });
      return current;
    },
    reject: unused,
    history: unused,
    graphDiff: unused,
  };
  const handle = createModelRevisionHandler({
    repository,
    runtime: {
      snapshot: {
        model: native.identity,
        busy: false,
        executionModel: native,
      },
      inspectModelVersion: () =>
        validateSourceExecutable(
          current,
          projectId,
          "AssemblyLiveBuilder::liveBuilder",
        ),
      adoptModelVersion: unused,
    },
    resolveRuntime: unused,
  });
  return { handle, initial, native, peer, tooling, repository };
}

for (const scenario of ["peer-root", "own-root-rename"] as const) {
  Deno.test({
    name:
      `HTTP authority recovery: ${scenario} uses the primary owner's explicit recovery receipt`,
    ignore: !toolkitIntegrationEnabled,
    async fn() {
      const directory = await Deno.makeTempDir({
        prefix: "ase-http-recovery-",
      });
      try {
        const { handle, initial, native, peer, tooling, repository } =
          await fixture(directory);
        assert.notEqual(native.identity.systemId, peer.identity.systemId);
        const changes = scenario === "peer-root"
          ? [{
            kind: "set-value" as const,
            elementId: nativeId(
              initial,
              "AssemblyLiveBuilder::mandatePeer::owner::ownerMandate::rootAuthority::id",
            ),
            expression: '"recovered-peer-root"',
          }]
          : [{
            kind: "rename" as const,
            elementId: nativeId(initial, "AssemblyLiveBuilder::liveBuilder"),
            name: "renamedBuilder",
          }];
        const edited = await tooling.edit(
          initial.sources,
          resolveModelEdits(initial, changes),
        );
        assert.equal(edited.provider.version, SYSML_TOOLKIT_VERSION);
        const proposalInput = {
          baseVersion: initial.version,
          sources: edited.sources,
          reason: "Recover modeled root authority",
        };
        const postProposal = (extra = {}) =>
          handle(post("/api/model-revisions", { ...proposalInput, ...extra }));
        const foreignAgent = await postProposal({
          agentId: peer.identity.builderId,
        });
        assert(foreignAgent);
        assert.equal(foreignAgent.status, 400);
        assert.equal(
          (await foreignAgent.json()).error,
          "Proposition SysML invalide.",
        );
        const denied = await postProposal();
        assert(denied);
        assert.equal(denied.status, 400);
        const failure = await denied.json();
        assert.equal(failure.code, "AUTHORITY_INVARIANT");
        assert.equal(failure.invariant, 3);
        assert.equal(
          failure.reason,
          scenario === "peer-root"
            ? "local-owner-root-outside-authority"
            : "modeled-root-recreation-requires-recovery",
        );
        assert.equal((await repository.current()).version, initial.version);

        const recoveryReason = scenario === "peer-root"
          ? "Restore the peer root through the local primary runtime"
          : "Recreate the modeled root identity after a system rename";
        const offered = await postProposal({ recoveryReason });
        assert(offered);
        assert.equal(offered.status, 201);
        const offer = await offered.json();
        assert.equal(
          offer.authorityExercise.systemId,
          native.identity.systemId,
        );
        assert.equal(offer.authorityExercise.ownerSource, "modeled");
        assert.equal(offer.authorityExercise.outOfMandate, true);
        assert.equal(offer.authorityExercise.reason, recoveryReason);
        const proposal = await repository.proposal(offer.id);
        const decisionPath = `/api/model-revisions/${offer.id}/decision`;
        const decision = {
          verdict: "approve",
          expectedVersion: initial.version,
          sourceDigest: proposal.sourceDigest,
        };
        const agentDecision = await handle(post(decisionPath, {
          ...decision,
          recoveryReason,
          agentId: peer.identity.builderId,
        }));
        assert(agentDecision);
        assert.equal(agentDecision.status, 400);
        assert.equal(
          (await agentDecision.json()).error,
          "Décision de révision invalide.",
        );
        const deniedDecision = await handle(post(decisionPath, decision));
        assert(deniedDecision);
        assert.equal(deniedDecision.status, 400);
        assert.equal((await deniedDecision.json()).code, "AUTHORITY_INVARIANT");
        assert.equal((await repository.proposal(offer.id)).status, "proposed");
        assert.equal((await repository.current()).version, initial.version);

        const accepted = await handle(post(decisionPath, {
          ...decision,
          recoveryReason,
        }));
        assert(accepted);
        assert.equal(accepted.status, 200);
        const acceptance = await accepted.json();
        assert.equal(acceptance.accepted, true);
        assert.equal(acceptance.executionAdopted, false);
        assert.equal(
          acceptance.authorityExercise.systemId,
          native.identity.systemId,
        );
        assert.equal(acceptance.authorityExercise.reason, recoveryReason);
        const reloaded = await handle(
          new Request(
            `http://127.0.0.1:4311/api/model-revisions/${offer.id}`,
          ),
        );
        assert(reloaded);
        assert.equal(reloaded.status, 200);
        const stored = await reloaded.json();
        assert.equal(stored.status, "accepted");
        assert.deepEqual(
          stored.authorization.authorityExercise,
          offer.authorityExercise,
        );
        assert.deepEqual(
          stored.decisionAuthorityExercise,
          acceptance.authorityExercise,
        );
        assert.equal(stored.decisionAuthorityExercise.outOfMandate, true);
        assert.equal(
          (await repository.current()).sourceDigest,
          proposal.sourceDigest,
        );
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    },
  });
}
