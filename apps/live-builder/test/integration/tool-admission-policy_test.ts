/** Real source publication and sandbox tests; only the conversational provider is scripted. */
import assert from "node:assert/strict";
import { isScopedSoftwareWriteDossier } from "../../src/application/model/publication/write-command-v2.ts";
import { join } from "node:path";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { openPostgresRuntimeFixture } from "../support/postgres-runtime-fixture.ts";
import type { ModelWriteSubmissionPort } from "../../src/application/model/publication/submission.ts";
import type { SystemRuntime as Runtime } from "../../src/application/work/runtime/system.ts";
import { openOperatorWorkspace } from "../support/operator-workspace.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  SourceModel,
  validateSourceExecutable,
} from "../../src/adapters/model/sources/source-model.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../../src/application/work/behaviors/invocation.ts";
import type { AgentPort } from "../../src/application/work/runtime/ports.ts";
import type { Candidate } from "../../src/domain/work/candidates.ts";
import type {
  ChatContext,
  ChatDecision,
} from "../../src/domain/work/dialogue.ts";
import type {
  PendingChange,
} from "../../src/domain/governance/records/pending-change.ts";
import type { ToolAdmissionPolicyRequest } from "../../src/domain/governance/policies/tool-admission-policy.ts";
import {
  assertCandidateDelegationReceipt,
  delegatedCandidateAuthorityExercise,
} from "../../src/domain/governance/policies/tool-admission-policy.ts";
import { mainExecutionSpace } from "../../src/domain/governance/operator-authority.ts";
import { CandidateActivationError } from "../../src/domain/work/policies/candidate-activation.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import {
  type CandidateActivationPublication,
  changePublication,
  ChangePublicationError,
} from "../../src/domain/model/publication/change.ts";
import { SystemGovernance } from "../../src/domain/governance/policies/governance.ts";
import type { MainCandidateInspection } from "../../src/application/work/operators/conversations.ts";

const extraction = String
  .raw`export default ({html}: {url:string;html:string}) => {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const text = body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi," ")
    .replace(/<!--[\s\S]*?-->/g," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
  return {title,text};
}`;

Deno.test({
  name:
    "tool admission policy: real Main inspection, delegated admission, locked revocation and published recovery",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({ prefix: "ase-tool-policy-" });
    let workspace:
      | Awaited<ReturnType<typeof openOperatorWorkspace>>
      | undefined;
    let postgres:
      | Awaited<ReturnType<typeof openPostgresRuntimeFixture>>
      | undefined;
    try {
      postgres = await openPostgresRuntimeFixture({
        dataDir: directory,
        sources: await loadInitialSources(undefined, { information: false }),
      });
      const projectId = postgres.backend.projectId;
      let realRepository = postgres.repository;
      let repository = realRepository;
      let tooling = postgres.backend.tooling;
      const publicationRefs = async () => {
        const result = await new Deno.Command("git", {
          args: [
            `--git-dir=${join(postgres!.backend.project.projectDir, ".git")}`,
            "for-each-ref",
            "--format=%(refname) %(objectname)",
          ],
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert(result.success, new TextDecoder().decode(result.stderr));
        return new TextDecoder().decode(result.stdout);
      };
      let beforeActivation:
        | ((receipt: CandidateActivationPublication) => Promise<void>)
        | undefined;
      let afterActivation:
        | ((receipt: CandidateActivationPublication) => Promise<void>)
        | undefined;
      const publications: Array<
        { candidateId: string; version: string; changeId: string }
      > = [];
      // Faults surround the real durable submission boundary. The ordinary
      // PostgreSQL queue, locked revalidation and Git publication remain active.
      const writer: ModelWriteSubmissionPort = {
        get repositoryId() {
          return postgres!.backend.project.id;
        },
        recipeDigest: () => postgres!.backend.writer.recipeDigest(),
        resume: (...args) => postgres!.backend.writer.resume(...args),
        async publish(dossier) {
          const publication = !isScopedSoftwareWriteDossier(dossier) &&
              dossier.decision.kind === "activate-candidate"
            ? dossier.decision.approval
            : undefined;
          if (publication) {
            const before = beforeActivation;
            beforeActivation = undefined;
            await before?.(publication);
          }
          const revision = await postgres!.backend.writer.publish(dossier);
          if (publication) {
            publications.push({
              candidateId: publication.candidateId,
              version: revision.version,
              changeId: publication.changeId,
            });
            const after = afterActivation;
            afterActivation = undefined;
            await after?.(publication);
          }
          return revision;
        },
      };
      const createSourceModel = (
        options: Pick<
          ConstructorParameters<typeof SourceModel>[0],
          "systemQualifiedName" | "sourcesDir" | "initialSources"
        > = {},
      ) =>
        new SourceModel({
          repository,
          projectId,
          tooling,
          ...options,
          writer,
        });
      let model = createSourceModel();
      type Decision = ChatDecision | ((context: ChatContext) => ChatDecision);
      const queues = new Map<string, Decision[]>();
      const contexts: ChatContext[] = [];
      const agents: AgentPort = {
        label: "scripted-delegated-tool-admission",
        decide(context) {
          contexts.push(structuredClone(context));
          const decision = queues.get(context.case!.owner)?.shift();
          return Promise.resolve(
            typeof decision === "function"
              ? decision(context)
              : decision ?? { kind: "reply", text: "Waiting in this Request." },
          );
        },
        review() {
          throw new Error("No reviewer is configured");
        },
      };
      let store = postgres.primary.state;
      let executors: BehaviorInvocationPort[] = [];
      let caseNumbers = postgres.workspacePorts.caseNumbers;
      let workBudget = new WorkBudgetService(postgres.primary.budget);
      const createPrimary = () =>
        new SystemRuntime({
          ...postgres!.runtimePorts,
          model,
          store: store!,
          agents,
          caseNumbers,
          workBudget,
          runner: {
            test() {
              throw new Error("Only the peer tests generated code");
            },
            run() {
              throw new Error("No web request is needed");
            },
          },
          behaviors: new BehaviorInvocationRegistry(executors),
        });
      let primary = createPrimary();
      await primary.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      const mainId = primary.snapshot.executionModel!.identity.builderId;
      const openWorkspace = async () => {
        const workspace = await openOperatorWorkspace({
          ...postgres!.workspacePorts,
          createSourceModel,
          primaryHistory: store,
          primary,
          primaryModel: model,
          repository,
          tooling,
          agents,
          directory,
          executors,
          caseNumbers,
          workBudget,
        });
        await postgres!.start(workspace);
        return workspace;
      };
      workspace = await openWorkspace();
      let conversations = workspace.conversations;
      const submitPrimary = async (decisions: Decision[], caseId?: string) => {
        queues.set(mainId, decisions);
        const result = await conversations.submitHuman({
          agentId: mainId,
          expectedRevision: primary.snapshot.revision,
          text: "Process the exact queued task.",
          ...(caseId ? { caseId } : { newConversation: true }),
        });
        await postgres!.idle(primary);
        return result!;
      };
      const approve = async (runtime: Runtime, change: PendingChange) => {
        await runtime.decideChange({
          changeId: change.id,
          expectedRevision: change.baseRevision,
          verdict: "approve",
        });
        await postgres!.idle(runtime);
        assert.equal(runtime.snapshot.error, undefined);
      };
      const parentId = await submitPrimary([{
        kind: "propose_agent_creation",
        role: "operator",
        name: "Research",
        text: "Create a bounded Request operator",
        reason: "Prepare tested read-only tools",
        operator: {
          instruction: "Prepare tools and wait for exact admission.",
          networkHosts: [],
          requestType: { name: "Research request", maxInvocations: 30 },
          firstRequest: {
            objective: "Wait for the delegated tool-admission grant.",
          },
        },
      }]);
      assert.equal(primary.snapshot.error, undefined);
      await approve(primary, primary.snapshot.configuration!.changes.at(-1)!);
      const peerView = conversations.snapshot.conversations.find((entry) =>
        entry.agentId !== mainId
      )!;
      assert(peerView);
      let peerEntry = workspace.runtimeFor(peerView.agentId)!;
      let peer = peerEntry.runtime;
      const peerScope =
        peer.snapshot.executionModel!.identity.systemQualifiedName;
      assert(peerScope);
      const childId = peer.cases.cases[0]!.id;
      const policy: ToolAdmissionPolicyRequest = {
        policyId: "research-tools",
        expectedPolicyRevision: 0,
        enabled: true,
        recipients: [peerView.nativeId],
        toolKinds: ["read_web_page"],
        maxDelegationDepth: 0,
      };
      await submitPrimary([{
        kind: "propose_mandate_change",
        text: "Delegate exact tool admission",
        reason: "Only Research and the HTML extraction contract",
        requestedRights: { toolAdmission: policy },
      }], parentId);
      assert.equal(primary.snapshot.error, undefined);
      const grant = primary.snapshot.configuration!.changes.at(-1)!;
      assert(grant.diff?.patch.includes("ToolAdmissionPolicy"));
      await approve(primary, grant);
      const synchronize = async () => {
        const head = await realRepository.current();
        for (const runtime of [primary, peer]) {
          const available = await validateSourceExecutable(
            head,
            projectId,
            runtime.snapshot.executionModel!.identity.systemQualifiedName,
          );
          const command = {
            agentId: available.identity.builderId,
            expectedDigest: available.version.digest,
            expectedVersion: head.version,
          };
          await workspace!.adopt(
            command,
            () => runtime.adoptModelVersion(command),
          );
        }
      };
      await synchronize();
      assert.equal(
        peer.snapshot.configuration!.builder.admissionAuthority,
        "human",
      );
      assert.equal(
        peer.snapshot.executionModel!.toolAdmissionPolicies?.[0]?.revision,
        1,
      );

      const prepareCandidate = async (name: string) => {
        queues.set(peerView.agentId, [{
          kind: "propose_tool",
          text: "Prepare the exact extractor",
          tool: {
            name,
            description: "Extract HTML title and body",
            kind: "read_web_page",
            code: extraction,
          },
        }]);
        await conversations.submitHuman({
          agentId: peerView.agentId,
          expectedRevision: peer.snapshot.revision,
          caseId: childId,
          text: `Prepare ${name} and wait for admission.`,
        });
        await postgres!.idle(peer);
        assert.equal(peer.snapshot.error, undefined);
        const candidate = peer.snapshot.candidates.at(-1)!;
        assert.equal(candidate.stage, "awaiting-admission");
        assert.equal(candidate.requiredAuthority, "human");
        assert.equal(candidate.caseId, childId);
        assert.equal(candidate.tests?.passed, true);
        assert.equal(candidate.tests?.checks.length, 3);
        assert(candidate.tests.checks.every((check) => check.passed));
        assert.equal(
          candidate.toolAdmissionPolicyPins?.[0]?.policyId,
          policy.policyId,
        );
        const contracts = peer.snapshot.executionModel!.contracts.filter((
          contract,
        ) => contract.kind === candidate.kind);
        assert.equal(contracts.length, 1);
        assert.deepEqual(candidate.toolAdmissionContract, contracts[0]);
        return candidate;
      };
      let lastInspection: MainCandidateInspection | undefined;
      const decideCandidate = async (
        candidate: Candidate,
        unrelatedFailure = false,
      ) => {
        await submitPrimary([
          (context) => {
            const pending = context.operatorToolAdmission?.candidates.find((
              entry,
            ) =>
              entry.operatorId === peerView.nativeId &&
              entry.candidateId === candidate.id
            );
            assert(
              pending,
              "Main discovers the exact covered pending candidate",
            );
            assert.equal(Object.hasOwn(pending, "code"), false);
            return {
              kind: "inspect_operator_candidate",
              text: "Inspect before deciding",
              operatorId: pending.operatorId,
              candidateId: pending.candidateId,
              candidateDigest: pending.candidateDigest,
              expectedRevision: pending.expectedRevision,
              caseId: pending.caseId,
              policyId: pending.policyId,
              policyRevision: pending.policyRevision,
            };
          },
          ...(unrelatedFailure
            ? [(context: ChatContext): ChatDecision => {
              const observed = context.messages.findLast((message) =>
                message.observation?.kind === "candidate-inspection"
              )!;
              const inspection = observed.observation!
                .value as MainCandidateInspection;
              return {
                kind: "inspect_operator_candidate",
                text:
                  "A failed unrelated inspection must preserve the valid sibling proof",
                ...inspection.decisionReference,
                candidateId: "unrelated-missing-candidate",
              };
            }]
            : []),
          (context) => {
            const message = context.messages.findLast((message) =>
              message.observation?.kind === "candidate-inspection" &&
              (message.observation.value as MainCandidateInspection).candidate
                  ?.id === candidate.id
            );
            assert(message?.observation);
            const inspection = message.observation
              .value as MainCandidateInspection;
            assert.equal(inspection.candidate.id, candidate.id);
            assert.equal(inspection.candidate.digest, candidate.digest);
            assert.equal(inspection.candidate.code, extraction);
            assert.equal(
              Object.hasOwn(inspection.candidate, "promotionContext"),
              false,
            );
            assert.equal(
              Object.hasOwn(inspection.candidate, "admissionContinuation"),
              false,
            );
            assert.equal(
              Object.hasOwn(inspection.candidate, "toolAdmissionContract"),
              false,
            );
            assert.deepEqual(inspection.candidate.tests, candidate.tests);
            assert.deepEqual(
              inspection.contract,
              candidate.toolAdmissionContract,
            );
            assert.equal(inspection.contract.kind, "read_web_page");
            assert.equal(
              inspection.authorityExercise.candidateDelegation?.actorId,
              mainId,
            );
            assert.equal(
              inspection.authorityExercise.candidateDelegation?.caseId,
              childId,
            );
            lastInspection = structuredClone(inspection);
            return {
              kind: "decide_operator_candidate",
              text: "Admit the inspected exact extractor",
              ...inspection.decisionReference,
              verdict: "approve",
              reason: "The exact code meets the contract and all tests pass.",
            };
          },
        ], parentId);
      };

      const first = await prepareCandidate("reader_admitted");
      const assertNoFirstAdmission = async (head: string, refs: string) => {
        const current = peer.snapshot.candidates.find((candidate) =>
          candidate.id === first.id
        )!;
        assert.equal(current.stage, "awaiting-admission");
        assert.equal(current.admission, undefined);
        assert.equal(current.admissionDecision, undefined);
        assert.equal((await realRepository.current()).version, head);
        assert.equal(await publicationRefs(), refs);
        assert.equal(publications.length, 0);
        const native = await validateSourceExecutable(
          await realRepository.current(),
          projectId,
          peerScope,
        );
        assert.equal(
          native.catalog.some((entry) => entry.candidateId === first.id),
          false,
        );
      };
      const gateFailure =
        "Inspect this exact candidate and Request before deciding";
      const assertMainGateRefusal = (messageStart: number) => {
        assert.equal(primary.snapshot.error, undefined);
        const refusal = primary.snapshot.messages.slice(messageStart).flatMap(
          (message) => {
            try {
              const value = JSON.parse(message.text);
              return value?.message === gateFailure ? [value] : [];
            } catch {
              return [];
            }
          },
        );
        assert.equal(refusal.length, 1);
        assert.equal(refusal[0].code, "AUTHORITY_OUT_OF_BOUNDS");
        assert.equal(refusal[0].message, gateFailure);
      };
      const pendingReference = () => ({
        operatorId: peerView.nativeId,
        candidateId: first.id,
        candidateDigest: first.digest,
        expectedRevision: peer.snapshot.revision,
        caseId: childId,
        policyId: policy.policyId,
        policyRevision: 1,
      });
      const gateHead = (await realRepository.current()).version;
      const gateRefs = await publicationRefs();
      const recipientModel = await validateSourceExecutable(
        await realRepository.current(),
        projectId,
        peerScope,
      );
      const principal = {
        actorId: mainId,
        policyId: policy.policyId,
        policyRevision: 1,
      };
      // Prove the candidate is otherwise eligible: failures below must come
      // from the Main workspace inspection cache, not a lower stale/bounds gate.
      delegatedCandidateAuthorityExercise(
        recipientModel,
        first,
        principal,
        mainExecutionSpace(recipientModel.identity),
      );
      let messageStart = primary.snapshot.messages.length;
      await submitPrimary([() => ({
        kind: "decide_operator_candidate",
        text: "Try an otherwise valid decision without inspection",
        ...pendingReference(),
        verdict: "approve",
        reason: "Test the inspection precondition.",
      })], parentId);
      assertMainGateRefusal(messageStart);
      await assertNoFirstAdmission(gateHead, gateRefs);

      for (const invalidOwner of ["unregistered-operator", mainId]) {
        let inspectedReference:
          | MainCandidateInspection["decisionReference"]
          | undefined;
        messageStart = primary.snapshot.messages.length;
        await submitPrimary([
          () => ({
            kind: "inspect_operator_candidate",
            text: "Inspect the valid candidate",
            ...pendingReference(),
          }),
          (context) => {
            const observed = context.messages.findLast((message) =>
              message.observation?.kind === "candidate-inspection"
            );
            assert(observed?.observation);
            const inspection = observed.observation
              .value as MainCandidateInspection;
            assert.equal(inspection.candidate.id, first.id);
            inspectedReference = structuredClone(inspection.decisionReference);
            return {
              kind: "inspect_operator_candidate",
              text:
                "Invalidate the prior inspection with a failed target lookup",
              ...inspectedReference,
              operatorId: invalidOwner,
            };
          },
          (context) => {
            const observed = context.messages.findLast((message) =>
              message.observation?.kind === "candidate-inspection"
            );
            assert(observed?.observation);
            const refused = observed.observation.value as {
              status: string;
              code: string;
              message: string;
            };
            assert.equal(refused.status, "refused");
            assert.equal(refused.code, "AUTHORITY_OUT_OF_BOUNDS");
            assert.equal(
              refused.message,
              "The exact recipient operator is unavailable",
            );
            assert(inspectedReference);
            assert.equal(
              peer.snapshot.revision,
              inspectedReference.expectedRevision,
            );
            assert.equal(
              peer.snapshot.candidates.find((candidate) =>
                candidate.id === first.id
              )!.digest,
              inspectedReference.candidateDigest,
            );
            return {
              kind: "decide_operator_candidate",
              text: "Try the now invalidated prior reference",
              ...inspectedReference,
              verdict: "approve",
              reason: "Test invalidation before lookup failure.",
            };
          },
        ], parentId);
        assertMainGateRefusal(messageStart);
        await assertNoFirstAdmission(gateHead, gateRefs);
      }

      // A genuine unpublished admission passes every receipt check before the
      // sole actor mismatch is introduced at the SourceModel trust boundary.
      const admitted = structuredClone(first);
      const reason =
        "The exact contract and tests authorize this delegated admission.";
      admitted.admissionDecision = {
        candidateDigest: admitted.digest,
        verdict: "approve",
        reason,
        authorityExercise: delegatedCandidateAuthorityExercise(
          recipientModel,
          admitted,
          principal,
          mainExecutionSpace(recipientModel.identity),
        ),
      };
      admitted.admission = SystemGovernance.fromExecutable(recipientModel)
        .admission(admitted, "delegate", reason, "2026-10-26T00:02:00Z");
      admitted.activationModelDigest = recipientModel.version.digest;
      admitted.stage = "activating";
      assertCandidateDelegationReceipt(
        recipientModel,
        admitted,
        mainExecutionSpace(recipientModel.identity),
      );
      assert.equal(admitted.admission.actorId, mainId);
      assert.equal(
        admitted.admission.authorityExercise?.candidateDelegation?.actorId,
        mainId,
      );
      admitted.admission.actorId = "foreign-delegate";
      const recipientSource = createSourceModel({
        systemQualifiedName: peerScope,
      });
      await assert.rejects(
        () =>
          recipientSource.activateCandidate(
            recipientModel.identity,
            admitted,
            recipientModel.version.digest,
          ),
        (error) =>
          error instanceof CandidateActivationError &&
          error.code === "ADMISSION_EXERCISE_MISMATCH" &&
          error.message ===
            "The delegated receipt does not match the exact candidate",
      );
      await assertNoFirstAdmission(gateHead, gateRefs);
      const peerChoicesBeforeAdmission = contexts.filter((context) =>
        context.case?.owner === peerView.nativeId
      ).length;
      afterActivation = () =>
        Promise.reject(
          new ChangePublicationError(
            "PUBLICATION_FAILED",
            { changeId: "lost-return" },
            "Simulated lost return after the real activation commit",
          ),
        );
      await decideCandidate(first, true);
      const interrupted = peer.snapshot.candidates.find((candidate) =>
        candidate.id === first.id
      )!;
      assert.equal(interrupted.stage, "activating");
      assert.equal(
        interrupted.error,
        "Simulated lost return after the real activation commit",
      );
      assert(interrupted.activationModelDigest);
      assert(interrupted.admissionContinuation);
      assert.equal(interrupted.admission?.authority, "delegate");
      assert.equal(
        publications.filter((entry) => entry.candidateId === first.id).length,
        1,
      );
      const originalAdmission = structuredClone(interrupted.admission);
      const beforeRestart = (await realRepository.current()).version;
      const mainChoicesBeforeRestart = contexts.filter((context) =>
        context.case?.owner === mainId
      ).length;
      const parentBeforeRestart = structuredClone(
        primary.cases.cases.find((record) => record.id === parentId)!,
      );
      const originalPeer = peer;
      // Rebuild every operational owner on the same exact PostgreSQL schema.
      const database = postgres.database;
      await postgres.close({ retainDatabase: true });
      workspace = undefined;
      postgres = await openPostgresRuntimeFixture({
        dataDir: directory,
        database,
      });
      realRepository = postgres.repository;
      repository = realRepository;
      tooling = postgres.backend.tooling;
      model = createSourceModel();
      store = postgres.primary.state;
      caseNumbers = postgres.workspacePorts.caseNumbers;
      workBudget = new WorkBudgetService(postgres.primary.budget);
      executors = [];
      primary = createPrimary();
      await primary.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      workspace = await openWorkspace();
      conversations = workspace.conversations;
      peerEntry = workspace.runtimeFor(peerView.agentId)!;
      peer = peerEntry.runtime;
      assert.notEqual(peer, originalPeer);
      await primary.resumeDecidedChanges();
      await postgres!.idle(primary);
      await postgres!.idle(peer);
      assert.equal(peer.snapshot.error, undefined);
      assert.equal((await realRepository.current()).version, beforeRestart);
      assert.equal(
        contexts.filter((context) => context.case?.owner === mainId).length,
        mainChoicesBeforeRestart,
      );
      const parentAfterRestart = primary.cases.cases.find((record) =>
        record.id === parentId
      )!;
      assert.equal(parentAfterRestart.status, parentBeforeRestart.status);
      assert.equal(parentAfterRestart.owner, parentBeforeRestart.owner);
      assert.equal(parentAfterRestart.createdAt, parentBeforeRestart.createdAt);
      assert.equal(
        peer.cases.cases.filter((record) => record.id === childId).length,
        1,
      );
      const active = peer.snapshot.candidates.find((candidate) =>
        candidate.id === first.id
      )!;
      assert.equal(active.stage, "active");
      assert.deepEqual(active.admission, originalAdmission);
      assert.equal(active.requiredAuthority, "human");
      assert.equal(active.admission?.authority, "delegate");
      assert.equal(active.admission?.actorId, mainId);
      assert.equal(active.admission?.candidateDigest, active.digest);
      assert.equal(
        active.admission?.authorityExercise?.candidateDelegation?.policyId,
        policy.policyId,
      );
      assert.equal(
        active.admission?.authorityExercise?.candidateDelegation
          ?.policyRevision,
        1,
      );
      assert.equal(
        active.admission?.authorityExercise?.candidateDelegation?.requestedBy,
        peerView.nativeId,
      );
      assert.equal(
        active.admission?.authorityExercise?.candidateDelegation?.caseId,
        childId,
      );
      assert.equal(active.admissionContinuation, undefined);
      assert.equal(
        contexts.findLast((context) =>
          context.case?.owner === peerView.nativeId
        )?.case?.id,
        childId,
      );
      assert.equal(
        peer.cases.cases.find((record) => record.id === childId)?.status,
        "waiting",
      );
      assert(
        contexts.filter((context) => context.case?.owner === peerView.nativeId)
          .length > peerChoicesBeforeAdmission,
      );
      assert.equal(
        peer.snapshot.messages.findLast((message) =>
          message.role === "assistant"
        )?.text,
        "Waiting in this Request.",
      );
      assert(lastInspection);
      assert.equal(
        publications.filter((entry) => entry.candidateId === first.id).length,
        1,
      );
      const firstPublication = publications.find((entry) =>
        entry.candidateId === first.id
      )!;
      const receipt = await realRepository.findPublication(
        firstPublication.changeId,
      );
      assert(receipt?.receipt?.type === "candidate-activation");
      assert.deepEqual(receipt.receipt.admission, active.admission);
      const replayBase = (await realRepository.current()).version;
      await peerEntry.model.activateCandidate(
        peer.snapshot.model!,
        active,
        active.admission!.authorityExercise!.baseModelDigest,
      );
      assert.equal((await realRepository.current()).version, replayBase);

      const raced = await prepareCandidate("reader_revoked_before_write");
      let revocationVersion: string | undefined;
      beforeActivation = async () => {
        // A second writer publishes an actual owner-approved policy revision
        // after the candidate's port preflight but before its locked callback.
        const ownerModel = postgres!.backend.createSourceModel({});
        const native = await ownerModel.readExecutableModel(
          primary.snapshot.model!,
        );
        const governance = SystemGovernance.fromExecutable(native);
        const pending = governance.propose(
          {
            kind: "propose_mandate_change",
            text: "Revoke future tool admissions",
            reason:
              "A competing owner decision revokes the grant before publication",
            requestedRights: {
              toolAdmission: {
                ...policy,
                expectedPolicyRevision: 1,
                enabled: false,
              },
            },
          },
          crypto.randomUUID(),
          "2026-10-26T00:00:00Z",
          { requestedBy: mainId, caseId: parentId },
        );
        pending.diff = await ownerModel.previewApprovedChange(
          native.identity,
          pending,
          native.version.digest,
        );
        const approved = SystemGovernance.fromExecutable(native, [pending])
          .decideChange(
            pending.id,
            pending.baseRevision,
            true,
            "2026-10-26T00:01:00Z",
          );
        const changed = await ownerModel.applyApprovedChange(
          native.identity,
          approved,
          native.version.digest,
          changePublication(approved, native.version),
        );
        revocationVersion = changed.version.repositoryVersion;
        assert.equal(changed.toolAdmissionPolicies?.[0]?.enabled, false);
      };
      await decideCandidate(raced);
      const failed = peer.snapshot.candidates.find((candidate) =>
        candidate.id === raced.id
      )!;
      assert(revocationVersion);
      assert.equal(failed.stage, "failed");
      assert.equal(failed.errorCode, "ADMITTED_MODEL_CHANGED");
      assert.equal(failed.activationModelDigest, undefined);
      assert.equal(
        publications.filter((entry) => entry.candidateId === raced.id).length,
        0,
      );
      assert.equal((await realRepository.current()).version, revocationVersion);
      const current = await validateSourceExecutable(
        await realRepository.current(),
        projectId,
        peerScope,
      );
      assert.equal(
        current.catalog.filter((entry) =>
          entry.candidateId === first.id && entry.status === "active"
        ).length,
        1,
      );
      assert.equal(
        current.catalog.some((entry) => entry.candidateId === raced.id),
        false,
      );

      // A previously attested effect is recoverable after revocation. This is
      // reconciliation of the original receipt, never another delegated act.
      const beforeRecovery = (await realRepository.current()).version;
      const recovered = await peerEntry.model.activateCandidate(
        peer.snapshot.model!,
        active,
        active.admission!.authorityExercise!.baseModelDigest,
      );
      assert.equal(recovered.elementId, active.binding!.elementId);
      assert.equal((await realRepository.current()).version, beforeRecovery);
      assert.equal(
        publications.filter((entry) => entry.candidateId === first.id).length,
        1,
      );
      assert.deepEqual(
        (await realRepository.findPublication(firstPublication.changeId))
          ?.receipt,
        receipt.receipt,
      );
    } finally {
      await postgres?.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});
