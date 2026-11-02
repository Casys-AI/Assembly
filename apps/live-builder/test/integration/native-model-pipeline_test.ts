import { readAssemblyEnv } from "../../src/infrastructure/environment.ts";
import assert from "node:assert/strict";
import { openModelBackend } from "../../src/composition/model-backend.ts";
import {
  discoverConversationUnits,
  type SourceModel,
} from "../../src/adapters/model/sources/source-model.ts";
import { DenoToolRunner } from "../../src/adapters/out/sandbox/runner.ts";
import { toolDraftDigest } from "../../src/application/work/artifacts/catalog.ts";
import { SystemGovernance } from "../../src/domain/governance/policies/governance.ts";
import {
  buildAcceptProposalCommand,
  buildActivationCommand,
} from "../../src/application/model/publication/write-queue.ts";
import { ModelPublicationError } from "../../src/application/model/publication/service.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { changePublication } from "../../src/domain/model/publication/change.ts";
import { sha256 } from "../../src/adapters/model/builds/materialization/artifact.ts";
import type { ExecutableModel } from "../../src/domain/model/execution/executable-model.ts";
import {
  modelWriteCommandDigest,
  type ModelWriteDossier,
} from "../../src/domain/model/editing/write-command.ts";
import {
  assertCandidateDelegationReceipt,
  delegatedCandidateAuthorityExercise,
  toolAdmissionPreparation,
} from "../../src/domain/governance/policies/tool-admission-policy.ts";
import { mainExecutionSpace } from "../../src/domain/governance/operator-authority.ts";
import type { Candidate } from "../../src/domain/work/candidates.ts";
import type { ChatDecision } from "../../src/domain/work/dialogue.ts";
import type {
  PendingChange,
} from "../../src/domain/governance/records/pending-change.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { openPostgresFixtureHost } from "../support/postgres-runtime-fixture.ts";

type Backend = Awaited<ReturnType<typeof openModelBackend>>;
type StorageHost = Awaited<ReturnType<typeof openPostgresFixtureHost>>;

/** The production backend persists its write queue in PostgreSQL; each native
 * journey owns an isolated storage host for its data directory. */
async function openBackend(
  directory: string,
  host: StorageHost,
): Promise<Backend> {
  return await openModelBackend(directory, {
    storage: host.storage,
    systemId: "native-qualification",
  });
}

async function approveHost(
  source: SourceModel,
  model: ExecutableModel,
  host: string,
): Promise<PendingChange> {
  const pending = SystemGovernance.fromExecutable(model).propose(
    {
      kind: "propose_mandate_change",
      text: `Request exact access to ${host}`,
      reason: `Explicit reception approval for ${host}`,
      requestedRights: { addNetworkHosts: [host] },
    },
    crypto.randomUUID(),
    "2026-10-25T00:00:00Z",
    {
      requestedBy: model.identity.builderId,
      designerScopeId: "native-backend-reception",
    },
  );
  pending.diff = await source.previewApprovedChange(
    model.identity,
    pending,
    model.version.digest,
  );
  assert.equal(pending.status, "pending");
  assert.equal(
    pending.diff.base.repositoryVersion,
    model.version.repositoryVersion,
  );
  assert(
    pending.diff.files.length > 0,
    "approval follows an actual displayed source change",
  );
  return SystemGovernance.fromExecutable(model, [pending]).decideChange(
    pending.id,
    pending.baseRevision,
    true,
    "2026-10-25T00:01:00Z",
  );
}

async function publication(backend: Backend, commandId: string) {
  const entry = await backend.queue.get(backend.project.id, commandId);
  assert(entry);
  assert.equal(entry.state, "published");
  const dossier = await backend.queue.getDossier(backend.project.id, commandId);
  assert(dossier);
  assert(
    dossier.v === 1,
    "This witness checks the existing Main publication route",
  );
  assert.equal(
    entry.commandDigest,
    await modelWriteCommandDigest(dossier.command),
  );
  const anchored = await backend.repository.findPublicationByCommand!(
    commandId,
  );
  assert(anchored, "the queue acknowledgement must have a Git command anchor");
  assert.equal(anchored.revision.version, entry.publishedVersion);
  assert.equal(anchored.commandDigest, entry.commandDigest);
  const descriptor = await backend.repository.descriptorAt!(
    anchored.revision.version,
  );
  assert(descriptor, "new publications must carry a W2 build descriptor");
  assert.equal(descriptor.repositoryId, backend.project.id);
  assert.equal(descriptor.sourceDigest, anchored.revision.sourceDigest);
  const cached = await backend.store.get(descriptor.artifactDigest);
  const vaulted = await backend.vault.getVerified(descriptor.artifactDigest);
  assert(vaulted, "the publication artifact must survive outside the cache");
  assert.deepEqual(cached, vaulted);
  assert.equal(await sha256(cached), descriptor.artifactDigest);
  return { entry, dossier, anchored, descriptor };
}

async function proposeComment(backend: Backend, model: ExecutableModel) {
  const current = await backend.repository.current();
  const sources = { ...current.sources };
  assert(sources["configuration.sysml"]);
  sources["configuration.sysml"] +=
    "\n// Explicit native backend reception proposal.\n";
  const owner = exerciseOwnerAuthority(model, "model-revision");
  const proposal = await backend.repository.propose({
    baseVersion: current.version,
    sources,
    author: "local-owner",
    reason: "Explicit owner proposal through the assembled backend",
    authorization: { kind: "local-owner", authorityExercise: owner },
  });
  return { proposal, current, owner };
}

Deno.test({
  name:
    "native backend publishes three real producers through one durable queue and reopens exact anchors/builds",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    assert.equal(
      readAssemblyEnv("ASSEMBLY_MODEL_PROJECT_DIR"),
      undefined,
      "Run in an isolated shell without a selected user project",
    );
    const directory = await Deno.makeTempDir({ prefix: "ase-native-backend-" });
    let backend: Backend | undefined;
    let host: StorageHost | undefined;
    try {
      host = await openPostgresFixtureHost();
      backend = await openBackend(directory, host);
      const identity = await backend.model.initialize();
      const original = await backend.model.readExecutableModel(identity);
      const factoryModel = backend.createSourceModel({
        systemQualifiedName: "AssemblyLiveBuilder::liveBuilder",
      });
      assert.deepEqual(await factoryModel.initialize(identity), identity);
      const baseline = (await backend.repository.history()).commits.length;
      assert.equal((await backend.queue.list(backend.project.id)).length, 0);
      const change = await approveHost(
        factoryModel,
        original,
        "native-reception.example",
      );
      const approval = changePublication(change, original.version);
      const originalApproval = structuredClone(approval);
      const changed = await factoryModel.applyApprovedChange(
        identity,
        change,
        original.version.digest,
        approval,
      );
      assert(
        changed.configuration.network!.allowedHosts.includes(
          "native-reception.example",
        ),
      );
      assert.deepEqual(approval, originalApproval);
      const first = await publication(backend, change.id);
      assert.equal(first.dossier.decision.kind, "approved-change");
      assert.equal(
        (await backend.repository.current()).version,
        first.entry.publishedVersion,
      );

      const draft = {
        name: "Native backend reader",
        description: "Exact admitted candidate reception fixture",
        kind: "read_web_page" as const,
        code: "export default () => ({title:'Title',text:'Text'})",
      };
      const candidate: Candidate = {
        ...draft,
        id: "native-backend-reader",
        digest: await toolDraftDigest(draft),
        stage: "awaiting-admission",
        createdAt: "2026-10-25T00:02:00Z",
        baseCatalogRevision: 0,
        tests: { passed: true, checks: [] },
      };
      candidate.admission = SystemGovernance.fromExecutable(changed).admission(
        candidate,
        changed.configuration.builder.admissionAuthority,
        "Explicit admission of the exact tested fixture",
        "2026-10-25T00:03:00Z",
      );
      candidate.activationModelDigest = changed.version.digest;
      candidate.stage = "activating";
      const binding = await backend.model.activateCandidate(
        identity,
        candidate,
        changed.version.digest,
      );
      const afterActivation = await backend.model.readExecutableModel(identity);
      assert(
        afterActivation.catalog.some((entry) =>
          entry.nativeId === binding.elementId && entry.status === "active"
        ),
      );
      const activationEntry = (await backend.queue.list(backend.project.id))
        .find((entry) => entry.command.kind === "activate-candidate");
      assert(activationEntry);
      const second = await publication(
        backend,
        activationEntry.command.commandId,
      );
      assert.equal(second.dossier.decision.kind, "activate-candidate");
      assert.equal(
        (await backend.repository.current()).version,
        second.entry.publishedVersion,
      );

      const { proposal, current, owner } = await proposeComment(
        backend,
        afterActivation,
      );
      const acceptInput = {
        id: proposal.id,
        expectedVersion: current.version,
        author: "local-owner",
        decisionAuthorityExercise: owner,
      };
      const accepted = await backend.repository.accept(acceptInput);
      const third = await publication(backend, proposal.id);
      assert.equal(third.dossier.decision.kind, "accept-proposal");
      assert.equal(accepted.version, third.entry.publishedVersion);
      assert.equal(
        (await backend.repository.proposal(proposal.id)).status,
        "accepted",
      );
      const commands = [first, second, third];
      assert.equal(
        new Set(commands.map((result) => result.entry.publishedVersion)).size,
        3,
      );
      assert.equal((await backend.queue.list(backend.project.id)).length, 3);
      assert.equal(
        (await backend.repository.history()).commits.length,
        baseline + 3,
      );
      const projectId = backend.projectId;
      const durableEntries = await backend.queue.list(backend.project.id);
      await backend.close();
      backend = await openBackend(directory, host);
      assert.equal(backend.projectId, projectId);
      await backend.model.initialize(identity);
      for (const result of commands) {
        const reopened = await publication(
          backend,
          result.entry.command.commandId,
        );
        assert.deepEqual(reopened.dossier, result.dossier);
        assert.deepEqual(reopened.descriptor, result.descriptor);
      }
      await backend.createSourceModel({
        systemQualifiedName: "AssemblyLiveBuilder::liveBuilder",
      })
        .applyApprovedChange(
          identity,
          change,
          original.version.digest,
          approval,
        );
      assert.deepEqual(
        await backend.model.activateCandidate(
          identity,
          candidate,
          changed.version.digest,
        ),
        binding,
      );
      assert.equal(
        (await backend.repository.accept(acceptInput)).version,
        accepted.version,
      );
      assert.equal(
        (await backend.repository.current()).version,
        accepted.version,
      );
      assert.equal(
        (await backend.repository.history()).commits.length,
        baseline + 3,
      );
      assert.deepEqual(
        await backend.queue.list(backend.project.id),
        durableEntries,
      );
      assert.deepEqual(approval, originalApproval);
    } finally {
      await backend?.close();
      await host?.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "native backend publishes an exact delegated admission, refuses a forged queue receipt and reopens without another effect",
  // This publication journey also executes generated code in sandbox-exec.
  ignore: !toolkitIntegrationEnabled || Deno.build.os !== "darwin",
  async fn() {
    assert.equal(readAssemblyEnv("ASSEMBLY_MODEL_PROJECT_DIR"), undefined);
    const directory = await Deno.makeTempDir({
      prefix: "ase-native-delegate-",
    });
    let backend: Backend | undefined;
    let host: StorageHost | undefined;
    try {
      host = await openPostgresFixtureHost();
      backend = await openBackend(directory, host);
      const mainSource = backend.createSourceModel({
        systemQualifiedName: "AssemblyLiveBuilder::liveBuilder",
      });
      const mainIdentity = await mainSource.initialize();
      const approve = async (
        decision: Extract<ChatDecision, {
          kind: "propose_mandate_change" | "propose_agent_creation";
        }>,
      ) => {
        const model = await mainSource.readExecutableModel(mainIdentity);
        const pending = SystemGovernance.fromExecutable(model).propose(
          decision,
          crypto.randomUUID(),
          "2026-10-26T00:00:00Z",
          {
            requestedBy: mainIdentity.builderId,
            designerScopeId: "native-delegated-publication",
          },
        );
        pending.diff = await mainSource.previewApprovedChange(
          mainIdentity,
          pending,
          model.version.digest,
        );
        assert(pending.diff.files.length > 0);
        const approved = SystemGovernance.fromExecutable(model, [pending])
          .decideChange(
            pending.id,
            pending.baseRevision,
            true,
            "2026-10-26T00:01:00Z",
          );
        return await mainSource.applyApprovedChange(
          mainIdentity,
          approved,
          model.version.digest,
          changePublication(approved, model.version),
        );
      };
      await approve({
        kind: "propose_agent_creation",
        role: "operator",
        name: "Native publication recipient",
        text: "Create a bounded recipient through native publication",
        reason:
          "Qualify exact delegated tool admission through the real backend",
        operator: {
          instruction: "Prepare exact tested tools and wait for admission.",
          networkHosts: [],
          requestType: { name: "Publication request", maxInvocations: 4 },
          firstRequest: { objective: "Prepare the delegated reader." },
        },
      });
      const units = discoverConversationUnits(
        await backend.repository.current(),
        backend.projectId,
      ).filter((unit) => unit.identity.builderId !== mainIdentity.builderId);
      assert.equal(units.length, 1);
      const recipientScope = units[0]!.systemQualifiedName;
      const recipientSource = backend.createSourceModel({
        systemQualifiedName: recipientScope,
      });
      const recipientIdentity = await recipientSource.initialize();
      await approve({
        kind: "propose_mandate_change",
        text: "Grant exact delegated tool admission",
        reason: "Only the modeled recipient and the read_web_page contract",
        requestedRights: {
          toolAdmission: {
            policyId: "native-publication-tools",
            expectedPolicyRevision: 0,
            enabled: true,
            recipients: [recipientIdentity.builderId],
            toolKinds: ["read_web_page"],
            maxDelegationDepth: 0,
          },
        },
      });
      const recipient = await recipientSource.readExecutableModel(
        recipientIdentity,
      );
      assert.equal(recipient.configuration.builder.admissionAuthority, "human");
      const draft = {
        name: "Native delegated reader",
        description: "Extract the exact tested HTML title and body",
        kind: "read_web_page" as const,
        code: String.raw`export default ({html}: {url:string;html:string}) => {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const text = body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi," ")
    .replace(/<!--[\s\S]*?-->/g," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
  return {title,text};
}`,
      };
      const tests = await new DenoToolRunner({ denoPath: Deno.execPath() })
        .test(
          draft,
        );
      assert.equal(tests.passed, true);
      assert.equal(tests.checks.length, 3);
      assert(tests.checks.every((check) => check.passed));
      const contracts = recipient.contracts.filter((contract) =>
        contract.kind === draft.kind
      );
      assert.equal(contracts.length, 1);
      const candidate: Candidate = {
        ...draft,
        id: "native-delegated-reader",
        digest: await toolDraftDigest(draft),
        stage: "awaiting-admission",
        createdAt: "2026-10-26T00:02:00Z",
        baseCatalogRevision: 0,
        caseId: "native-delegated-publication-request",
        requiredAuthority: "human",
        proposedConfigurationRevision: recipient.configuration.revision,
        promotionModelDigest: recipient.version.digest,
        toolAdmissionPolicyPins: toolAdmissionPreparation(
          recipient,
          draft.kind,
          mainExecutionSpace(recipient.identity),
        ),
        toolAdmissionContract: structuredClone(contracts[0]!),
        tests,
      };
      const reason = "The exact extractor passes all three contract fixtures.";
      candidate.admissionDecision = {
        candidateDigest: candidate.digest,
        verdict: "approve",
        reason,
        authorityExercise: delegatedCandidateAuthorityExercise(
          recipient,
          candidate,
          {
            actorId: mainIdentity.builderId,
            policyId: "native-publication-tools",
            policyRevision: 1,
          },
          mainExecutionSpace(recipient.identity),
        ),
      };
      candidate.admission = SystemGovernance.fromExecutable(recipient)
        .admission(
          candidate,
          "delegate",
          reason,
          "2026-10-26T00:03:00Z",
        );
      candidate.activationModelDigest = recipient.version.digest;
      candidate.stage = "activating";
      assertCandidateDelegationReceipt(
        recipient,
        candidate,
        mainExecutionSpace(recipient.identity),
      );
      const originalCandidate = structuredClone(candidate);
      const before = await backend.repository.current();
      const baseline = (await backend.repository.history()).commits.length;
      let produced: ModelWriteDossier | undefined;
      const interruption = new Error(
        "Interrupted after durable candidate enqueue",
      );
      const originalEnqueue = backend.queue.enqueue;
      // Observe the application's real dossier before its first enqueue. Each
      // forged copy keeps the native base/journal and synchronized receipts, so
      // the unchanged worker/revalidator must reject the exact authority proof.
      backend.queue.enqueue = async (dossier) => {
        backend!.queue.enqueue = originalEnqueue;
        assert(dossier.v === 1, "This producer fixture records a Main dossier");
        produced = structuredClone(dossier);
        assert.equal(dossier.decision.kind, "activate-candidate");
        assert(dossier.decision.kind === "activate-candidate");
        assert(dossier.decision.candidate);
        assert.equal(dossier.operations.kind, "host-edits");
        assert(dossier.operations.kind === "host-edits");
        for (const forgery of ["foreign-actor", "human-relabel"] as const) {
          const forgedCandidate = structuredClone(dossier.decision.candidate);
          const forgedApproval = structuredClone(dossier.decision.approval);
          if (forgery === "foreign-actor") {
            forgedCandidate.admission!.actorId = "foreign-delegate";
          } else {
            forgedCandidate.admission!.authority = "human";
          }
          forgedApproval.changeId = crypto.randomUUID();
          forgedApproval.admission = structuredClone(
            forgedCandidate.admission!,
          );
          const forged = await buildActivationCommand({
            repositoryId: backend!.project.id,
            approval: forgedApproval,
            candidate: forgedCandidate,
            journal: structuredClone(dossier.operations.journal),
            recipeDigest: dossier.command.recipeDigest,
          });
          await assert.rejects(
            () => backend!.writer.publish(forged),
            (error) =>
              error instanceof ModelPublicationError &&
              error.code === "REFUSED" &&
              error.context.reason === "ACTIVATION_ADMISSION_MISMATCH",
          );
          const refused = await backend!.queue.get(
            backend!.project.id,
            forged.command.commandId,
          );
          assert.equal(refused?.state, "refused");
          assert.equal(
            refused?.lastError?.code,
            "ACTIVATION_ADMISSION_MISMATCH",
          );
          assert.deepEqual(
            await backend!.queue.getDossier(
              backend!.project.id,
              forged.command.commandId,
            ),
            forged,
          );
          assert.equal(
            await backend!.repository.findPublicationByCommand!(
              forged.command.commandId,
            ),
            null,
          );
          assert.deepEqual(await backend!.repository.current(), before);
          assert.equal(
            (await backend!.repository.history()).commits.length,
            baseline,
          );
          assert.equal(
            (await recipientSource.readExecutableModel(recipientIdentity))
              .catalog
              .some((entry) => entry.candidateId === candidate.id),
            false,
          );
        }
        // Stop the actual pump before persisting the valid producer output.
        // Interruption precedes publish's resume(), leaving an unexecuted row
        // for a newly assembled backend rather than an already-published effect.
        await backend!.writer.close();
        const enqueued = await originalEnqueue.call(backend!.queue, dossier);
        assert.equal(enqueued.status, "queued");
        throw interruption;
      };
      try {
        await assert.rejects(
          () =>
            recipientSource.activateCandidate(
              recipientIdentity,
              candidate,
              recipient.version.digest,
            ),
          (error) => error === interruption,
        );
      } finally {
        backend.queue.enqueue = originalEnqueue;
      }
      assert(produced);
      const queued = await backend.queue.get(
        backend.project.id,
        produced.command.commandId,
      );
      assert.equal(queued?.state, "queued");
      assert.equal(queued?.attempts, 0);
      assert.equal(queued?.fence, 0);
      assert.deepEqual(
        await backend.queue.getDossier(
          backend.project.id,
          produced.command.commandId,
        ),
        produced,
      );
      assert.equal(
        await backend.repository.findPublicationByCommand!(
          produced.command.commandId,
        ),
        null,
      );
      assert.deepEqual(await backend.repository.current(), before);
      assert.equal(
        (await backend.repository.history()).commits.length,
        baseline,
      );
      assert.equal(
        (await recipientSource.readExecutableModel(recipientIdentity)).catalog
          .some((entry) => entry.candidateId === candidate.id),
        false,
      );
      const projectId = backend.projectId;
      await backend.close();
      backend = await openBackend(directory, host);
      assert.equal(backend.projectId, projectId);
      const resumed = await backend.writer.resume(produced.command.commandId);
      assert(resumed);
      const published = await publication(backend, produced.command.commandId);
      assert.equal(resumed.version, published.entry.publishedVersion);
      assert.equal(published.entry.attempts, 0);
      assert.equal(published.entry.fence, 1);
      assert.deepEqual(published.dossier, produced);
      assert(published.dossier.decision.kind === "activate-candidate");
      assert.deepEqual(published.dossier.decision.candidate, originalCandidate);
      assert.deepEqual(
        published.dossier.decision.approval.admission,
        originalCandidate.admission,
      );
      const receipt = await backend.repository.findPublication(
        produced.command.commandId,
      );
      assert(receipt?.receipt?.type === "candidate-activation");
      assert.deepEqual(receipt.receipt.admission, originalCandidate.admission);
      const publishedSource = backend.createSourceModel({
        systemQualifiedName: recipientScope,
      });
      await publishedSource.initialize(recipientIdentity);
      const binding = await publishedSource.activateCandidate(
        recipientIdentity,
        candidate,
        recipient.version.digest,
      );
      const active = await publishedSource.readExecutableModel(
        recipientIdentity,
      );
      assert.equal(
        active.catalog.filter((entry) =>
          entry.candidateId === candidate.id &&
          entry.digest === candidate.digest &&
          entry.nativeId === binding.elementId &&
          entry.status === "active"
        ).length,
        1,
      );
      assert.deepEqual(candidate, originalCandidate);
      assert.equal(
        (await backend.repository.history()).commits.length,
        baseline + 1,
      );
      const head = (await backend.repository.current()).version;
      const durableEntries = await backend.queue.list(backend.project.id);
      await backend.close();
      backend = await openBackend(directory, host);
      assert.equal(backend.projectId, projectId);
      const reopenedSource = backend.createSourceModel({
        systemQualifiedName: recipientScope,
      });
      await reopenedSource.initialize(recipientIdentity);
      assert.deepEqual(
        await reopenedSource.activateCandidate(
          recipientIdentity,
          candidate,
          recipient.version.digest,
        ),
        binding,
      );
      assert.equal(
        (await backend.writer.publish(produced)).version,
        published.entry.publishedVersion,
      );
      const reopened = await publication(backend, produced.command.commandId);
      assert.deepEqual(reopened.dossier, produced);
      assert.deepEqual(reopened.descriptor, published.descriptor);
      assert.deepEqual(
        (await backend.repository.findPublication(produced.command.commandId))
          ?.receipt,
        receipt.receipt,
      );
      assert.equal((await backend.repository.current()).version, head);
      assert.equal(
        (await backend.repository.history()).commits.length,
        baseline + 1,
      );
      assert.deepEqual(
        await backend.queue.list(backend.project.id),
        durableEntries,
      );
      assert.deepEqual(candidate, originalCandidate);
    } finally {
      await backend?.close();
      await host?.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "native backend preserves an actual stale acceptance decision as needs-decision without implicit reapproval",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    assert.equal(readAssemblyEnv("ASSEMBLY_MODEL_PROJECT_DIR"), undefined);
    const directory = await Deno.makeTempDir({ prefix: "ase-native-stale-" });
    let backend: Backend | undefined;
    let host: StorageHost | undefined;
    try {
      host = await openPostgresFixtureHost();
      backend = await openBackend(directory, host);
      const identity = await backend.model.initialize();
      const original = await backend.model.readExecutableModel(identity);
      const { proposal, current, owner } = await proposeComment(
        backend,
        original,
      );
      const dossier = await buildAcceptProposalCommand({
        repositoryId: backend.project.id,
        proposal,
        expectedVersion: current.version,
        author: "local-owner",
        baseSourceDigest: current.sourceDigest,
        decisionAuthorityExercise: owner,
        recipeDigest: await backend.writer.recipeDigest(),
      });
      const change = await approveHost(
        backend.model,
        original,
        "stale-reception.example",
      );
      await backend.model.applyApprovedChange(
        identity,
        change,
        original.version.digest,
        changePublication(change, original.version),
      );
      const head = await backend.repository.current();
      await assert.rejects(() => backend!.writer.publish(dossier));
      const entry = await backend.queue.get(backend.project.id, proposal.id);
      assert.equal(entry?.state, "needs-decision");
      assert.deepEqual(
        await backend.queue.getDossier(backend.project.id, proposal.id),
        dossier,
      );
      assert.equal(
        await backend.repository.findPublicationByCommand!(proposal.id),
        null,
      );
      assert.equal(
        (await backend.repository.proposal(proposal.id)).status,
        "proposed",
      );
      assert.equal((await backend.repository.current()).version, head.version);
      await backend.close();
      backend = await openBackend(directory, host);
      await backend.writer.pump();
      assert.deepEqual(
        await backend.queue.get(backend.project.id, proposal.id),
        entry,
      );
      assert.deepEqual(
        await backend.queue.getDossier(backend.project.id, proposal.id),
        dossier,
      );
      assert.equal((await backend.repository.current()).version, head.version);
      assert.equal(
        await backend.repository.findPublicationByCommand!(proposal.id),
        null,
      );
    } finally {
      await backend?.close();
      await host?.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});
