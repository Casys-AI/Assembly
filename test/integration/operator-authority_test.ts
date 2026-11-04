import { createSourceModel } from "../../src/composition/source-model-services.ts";
import { ACCEPTED_CASE_CLOSURE } from "../support/case-closure.ts";
/** Scripted production runtime, Git, Toolkit and PostgreSQL. No provider or network. */
import assert from "node:assert/strict";
import { type LogRecord, reset } from "@logtape/logtape";
import { configureTechnicalLogging } from "../../src/infrastructure/logging.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { openPostgresRuntimeFixture } from "../support/postgres-runtime-fixture.ts";
import { openOperatorWorkspace } from "../support/operator-workspace.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  sourceCompilation,
  sourceEvolutionCompilation,
  validateSourceExecutable,
} from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { NativeModelSourceAuthorization } from "../../src/application/governance/model-access/source-authorization.ts";
import { compareModelSources } from "../../src/application/model/revisions/source-diff.ts";
import { createConversationsHandler } from "../../src/adapters/in/http/work/conversations.ts";
import type { AgentPort } from "../../src/application/work/runtime/ports.ts";
import type {
  ChatContext,
  ChatDecision,
} from "../../src/domain/work/dialogue.ts";
import type { PendingChange } from "../../src/domain/governance/records/pending-change.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../../src/application/work/behaviors/invocation.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import { SystemGovernance } from "../../src/domain/governance/policies/governance.ts";
import {
  changePublication,
  ChangePublicationError,
  MAX_APPROVAL_RECEIPT_BYTES,
} from "../../src/domain/model/publication/change.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import {
  isTeamOperatorSpec,
  OperatorAuthorityError,
} from "../../src/domain/governance/operator-authority.ts";
import { operatorAuthorityRequests } from "../../src/composition/source-model-services.ts";
import { requestOperatorSystemName } from "../../src/application/governance/operator-authority-values.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";

Deno.test({
  name:
    "maximum quote-heavy Request operator publishes and recovers within the approval trailer budget",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({ prefix: "ase-max-operator-" });
    try {
      const projectId = `git:${crypto.randomUUID()}`;
      const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
      const repositoryOptions = {
        projectDir: directory,
        compiler: new ToolkitCompiler({ packageDir }),
        sourceAuthorization: new NativeModelSourceAuthorization(
          projectId,
          sourceCompilation,
          sourceEvolutionCompilation,
        ),
      };
      const repository = await GitModelRepository.open(repositoryOptions);
      const model = createSourceModel({
        repository,
        projectId,
        tooling: new SysmlToolkitAdapter({ packageDir }),
        initialSources: await loadInitialSources(undefined, {
          information: false,
        }),
      });
      const identity = await model.initialize();
      const publish = async (
        decision: Extract<ChatDecision, {
          kind: "propose_mandate_change" | "propose_agent_creation";
        }>,
      ) => {
        const current = await model.readExecutableModel(identity);
        const change = SystemGovernance.fromExecutable(current).propose(
          decision,
          crypto.randomUUID(),
          "2026-10-25T00:00:00Z",
          {
            requestedBy: identity.builderId,
            designerScopeId: crypto.randomUUID(),
          },
        );
        if (change.kind === "operator-creation") {
          const head = (await repository.current()).version;
          const oversized = {
            ...structuredClone(change),
            reason: "x".repeat(65000),
          };
          await assert.rejects(
            () =>
              model.previewApprovedChange(
                identity,
                oversized,
                current.version.digest,
              ),
            (error: unknown) =>
              error instanceof ChangePublicationError &&
              error.code === "PUBLICATION_RECEIPT_TOO_LARGE",
          );
          assert.equal((await repository.current()).version, head);
          assert.equal(await repository.findPublication(change.id), null);
          assert.equal(oversized.status, "pending");
          assert.equal(change.status, "pending");
        }
        change.diff = await model.previewApprovedChange(
          identity,
          change,
          current.version.digest,
        );
        assert(change.diff);
        const approved = SystemGovernance.fromExecutable(current, [change])
          .decideChange(
            change.id,
            change.baseRevision,
            true,
            "2026-10-25T00:01:00Z",
          );
        const publication = changePublication(approved, current.version);
        await model.applyApprovedChange(
          identity,
          approved,
          current.version.digest,
          publication,
        );
        return { approved, publication };
      };
      await publish({
        kind: "propose_mandate_change",
        text: "Request bounded source editing",
        reason: "Compose a Request operator",
        requestedRights: {
          grantModelEditing: {
            file: "configuration.sysml",
            root: "AssemblyLiveBuilder::liveBuilder::catalog",
            operations: ["insert-member"],
          },
        },
      });
      // Quotes and backslashes expand in both SysML and durable JSON. Use the
      // full accepted instruction/objective lengths rather than an estimate.
      const instruction = '\\"'.repeat(2000);
      const objective = '\\"'.repeat(1000);
      assert.equal(instruction.length, 4000);
      assert.equal(objective.length, 2000);
      const { approved, publication } = await publish({
        kind: "propose_agent_creation",
        text: "Create maximum Request",
        reason: "Publish the complete bounded instruction and objective",
        role: "operator",
        name: "Maximum Request",
        operator: {
          instruction,
          networkHosts: [],
          requestType: { name: "Maximum request", maxInvocations: 100 },
          firstRequest: { objective },
        },
      });
      // Count exactly what Git writes, including the trailer prefix/newline.
      // Leave 8 KiB for the fixed envelope to grow; this is a regression budget
      // for this fixture, not a bound over every possible network host list.
      const bytes = new TextEncoder().encode(
        `ASE-Approval: ${canonical(publication)}\n`,
      ).length;
      console.log(
        `Maximum operator receipt: ${bytes} trailer bytes; ${
          MAX_APPROVAL_RECEIPT_BYTES - bytes
        } bytes of headroom`,
      );
      assert(bytes <= MAX_APPROVAL_RECEIPT_BYTES);
      assert(
        MAX_APPROVAL_RECEIPT_BYTES - bytes >= 8192,
        `Approval trailer has only ${
          MAX_APPROVAL_RECEIPT_BYTES - bytes
        } bytes of headroom (${bytes} bytes used)`,
      );
      const reopened = await GitModelRepository.open(repositoryOptions);
      const recovered = await createSourceModel({
        repository: reopened,
        projectId,
        tooling: new SysmlToolkitAdapter({ packageDir }),
      }).findApprovedChange(identity, approved.id);
      assert(recovered?.receipt);
      assert.deepEqual(recovered.receipt, publication);
      const created = await validateSourceExecutable(
        await reopened.current(),
        projectId,
        await requestOperatorSystemName(
          "AssemblyLiveBuilder::liveBuilder",
          approved.id,
        ),
      );
      assert.equal(created.operator?.instruction, instruction);
      const recoveredOperator = recovered.receipt.proposal?.operator;
      assert(recoveredOperator && !isTeamOperatorSpec(recoveredOperator));
      assert.equal(
        recoveredOperator.firstRequest.objective,
        objective,
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

for (const verdict of ["approve", "refuse"] as const) {
  Deno.test({
    name:
      `Request authority demonstration: grant, create, escalate, ${verdict}, resume and receipt`,
    ignore: !toolkitIntegrationEnabled,
    async fn() {
      const directory = await Deno.makeTempDir({
        prefix: "ase-request-authority-",
      });
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
        const repository = postgres.repository;
        const tooling = postgres.backend.tooling;
        const model = postgres.backend.model;
        const contexts: ChatContext[] = [];
        let primaryId = "";
        const queues = new Map<string, ChatDecision[]>();
        const agents: AgentPort = {
          label: "scripted-request-authority",
          decide(context) {
            contexts.push(structuredClone(context));
            const actor = context.case?.owner ?? primaryId;
            if (actor !== primaryId && !queues.has(actor)) {
              queues.set(actor, [
                {
                  kind: "propose_mandate_change",
                  text: "Request network permission",
                  reason: "Read example.org for this Request " +
                    "x".repeat(1500),
                  requestedRights: { addNetworkHosts: ["example.org"] },
                },
                {
                  kind: "reply",
                  text: "The decision returned to this Request.",
                },
                {
                  kind: "reply",
                  text: "Request completed with the admitted scope. " +
                    "y".repeat(2000),
                },
              ]);
            }
            const next = queues.get(actor)?.shift();
            assert(next, `Unexpected invocation for ${actor}`);
            return Promise.resolve(next);
          },
          review() {
            throw new Error("This scenario has no tool candidates");
          },
        };
        const store = postgres.primary.state;
        const executors: BehaviorInvocationPort[] = [];
        const caseNumbers = postgres.workspacePorts.caseNumbers;
        const workBudget = new WorkBudgetService(postgres.primary.budget);
        const primary = new SystemRuntime({
          ...postgres.runtimePorts,
          model,
          store,
          agents,
          caseNumbers,
          workBudget,
          runner: {
            test() {
              return Promise.resolve({
                passed: true,
                checks: [{
                  name: "selected reader",
                  passed: true,
                  detail: "Selected bytes tested",
                }],
              });
            },
            run() {
              throw new Error("No network invocation");
            },
          },
          behaviors: new BehaviorInvocationRegistry(executors),
        });
        await primary.initialize(undefined, {
          resumeContinuations: false,
          resumeCandidateContinuations: false,
        });
        primaryId = primary.snapshot.executionModel!.identity.builderId;
        workspace = await openOperatorWorkspace({
          ...postgres.workspacePorts,
          createSourceModel: postgres.backend.createSourceModel,
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
        await postgres.start(workspace);
        const conversations = workspace.conversations;
        const handler = createConversationsHandler(
          conversations,
          "http://localhost:4321",
        );
        const decide = async (
          runtime:
            | SystemRuntime
            | import("../../src/application/work/runtime/system.ts").SystemRuntime,
          change: PendingChange,
          choice = "approve",
        ) => {
          const state = runtime.snapshot;
          const response = await handler(
            new Request(
              `http://localhost:4321/api/conversations/${
                encodeURIComponent(state.executionModel!.identity.builderId)
              }/changes/${change.id}/decision`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  host: "localhost:4321",
                  origin: "http://localhost:4321",
                },
                body: JSON.stringify({
                  expectedRevision: state.revision,
                  configurationRevision: change.baseRevision,
                  verdict: choice,
                }),
              },
            ),
          );
          assert(response);
          assert.equal(response.status, 202, await response.text());
          await postgres!.idle(runtime);
          assert.equal(runtime.snapshot.error, undefined);
        };
        const grant: ChatDecision = {
          kind: "propose_mandate_change",
          text: "Request editing",
          reason: "Compose a Request operator",
          requestedRights: {
            grantModelEditing: {
              file: "configuration.sysml",
              root: "AssemblyLiveBuilder::liveBuilder::catalog",
              operations: ["insert-member"],
            },
          },
        };
        const creation: ChatDecision = {
          kind: "propose_agent_creation",
          text: "Create Research",
          reason: "Process the bounded Request",
          role: "operator",
          name: "Research",
          operator: {
            instruction: "Answer concise research requests.",
            networkHosts: [],
            requestType: { name: "Research request", maxInvocations: 4 },
            firstRequest: {
              objective: "Ask the Designer for permission to read example.org.",
            },
          },
        };
        queues.set(primaryId, [
          grant,
          { kind: "reply", text: "Editing granted." },
          creation,
          { kind: "reply", text: "Request opened." },
          { kind: "reply", text: "Other conversation." },
        ]);
        const executionPin = structuredClone(
          primary.snapshot.executionModel!.version,
        );
        const beforePreview = await repository.current();
        const previewBase = await repository.publishSystemSources(
          {
            ...beforePreview.sources,
            "unrelated.sysml": "package Unrelated { part value; }",
          },
          beforePreview.version,
          "unrelated qualification before preview",
        );
        const parentCaseId = await conversations.submitHuman({
          agentId: primaryId,
          expectedRevision: primary.snapshot.revision,
          text: "Ask for targeted editing",
          newConversation: true,
        });
        await postgres!.idle(primary);
        assert.equal(primary.snapshot.error, undefined);
        assert(parentCaseId);
        const pendingGrant = primary.snapshot.configuration!.changes.at(-1)!;
        assert.equal(pendingGrant.caseId, parentCaseId);
        assert.equal(pendingGrant.requestedBy, primaryId);
        assert(pendingGrant.diff);
        assert.deepEqual(
          primary.snapshot.executionModel!.version,
          executionPin,
        );
        assert.notEqual(previewBase.version, executionPin.repositoryVersion);
        assert.equal(
          pendingGrant.diff.base.repositoryVersion,
          previewBase.version,
        );
        assert.equal(pendingGrant.diff.base.modelDigest, executionPin.digest);
        assert(pendingGrant.diff.patch.includes("modelEditPolicy"));
        assert.equal(
          primary.snapshot.executionModel!.modelEditPolicy,
          undefined,
        );
        const beforeGrant = await repository.current();
        assert("grantModelEditing" in grant.requestedRights);
        for (
          const root of [
            "AssemblyLiveBuilder",
            "AssemblyLiveBuilder::liveBuilder",
            "AssemblyLiveBuilder::liveBuilder::owner",
          ]
        ) {
          const rights = {
            grantModelEditing: {
              ...grant.requestedRights.grantModelEditing,
              root,
            },
          };
          assert.throws(
            () =>
              SystemGovernance.fromExecutable(primary.snapshot.executionModel!)
                .propose(
                  { ...grant, requestedRights: rights },
                  "bad-grant",
                  "now",
                  { requestedBy: primaryId, caseId: parentCaseId },
                ),
            (error) =>
              error instanceof OperatorAuthorityError &&
              error.code === "INVALID_MODEL_EDIT_GRANT" && !!error.context &&
              !!error.recovery,
          );
          await assert.rejects(
            () =>
              operatorAuthorityRequests(beforeGrant, {
                op: "grantModelEditing",
                systemName: "AssemblyLiveBuilder::liveBuilder",
                changeId: "bad-grant",
                grant: rights.grantModelEditing,
              }),
            (error) =>
              error instanceof OperatorAuthorityError &&
              error.code === "INVALID_MODEL_EDIT_GRANT" &&
              error.context.root === root && !!error.recovery,
          );
        }
        // Recomputed hunks must match the displayed ones, even on the same base.
        const approved = SystemGovernance.fromExecutable(
          primary.snapshot.executionModel!,
          [pendingGrant],
        ).decideChange(
          pendingGrant.id,
          pendingGrant.baseRevision,
          true,
          new Date().toISOString(),
        );
        const altered = structuredClone(approved);
        altered.diff!.patch += "\nundisplayed hunk";
        await assert.rejects(
          () =>
            model.applyApprovedChange(
              primary.snapshot.model!,
              altered,
              altered.baseModelDigest!,
              changePublication(
                altered,
                primary.snapshot.executionModel!.version,
              ),
            ),
          (error) =>
            error instanceof ChangePublicationError &&
            error.code === "PUBLICATION_NOT_APPLICABLE",
        );
        assert.equal((await repository.current()).version, beforeGrant.version);
        await decide(primary, pendingGrant);
        assert.deepEqual(
          primary.snapshot.executionModel!.modelEditPolicy!.operations,
          ["insert-member"],
        );
        const afterGrant = await repository.current();
        const publication = await repository.findPublication(pendingGrant.id);
        assert(publication?.receipt);
        assert(publication.receipt.type !== "candidate-activation");
        assert.deepEqual(publication.receipt.adoptedPin, {
          digest: executionPin.digest,
          repositoryVersion: executionPin.repositoryVersion,
        });
        assert.deepEqual(
          publication.receipt.approvedSourceBase,
          pendingGrant.diff.base,
        );
        assert.equal(
          afterGrant.sources["unrelated.sysml"],
          previewBase.sources["unrelated.sysml"],
        );
        assert.deepEqual(
          compareModelSources(beforeGrant.sources, afterGrant.sources),
          {
            patch: pendingGrant.diff.patch,
            files: pendingGrant.diff.files,
            additions: pendingGrant.diff.additions,
            deletions: pendingGrant.diff.deletions,
          },
        );
        assert.equal(contexts.at(-1)!.case!.id, parentCaseId);
        await conversations.submitHuman({
          agentId: primaryId,
          expectedRevision: primary.snapshot.revision,
          caseId: parentCaseId,
          text: "Create Research and open its Request",
        });
        await postgres!.idle(primary);
        assert.equal(primary.snapshot.error, undefined);
        const pendingCreation = primary.snapshot.configuration!.changes.at(-1)!;
        assert.equal(pendingCreation.kind, "operator-creation");
        assert(pendingCreation.diff?.patch.includes("Research request"));
        const priorMessages = primary.snapshot.messages.length;
        const primaryCalls = () =>
          contexts.filter((context) => context.case?.owner === primaryId)
            .length;
        const beforeCreationCalls = primaryCalls();
        await decide(primary, pendingCreation);
        assert.equal(
          primaryCalls(),
          beforeCreationCalls + 1,
          "escalation notices never trigger a designer turn",
        );
        const agentChange = contexts.findLast((context) =>
          context.case?.owner === primaryId
        )!.configuration!.changes.find((entry) =>
          entry.id === pendingCreation.id
        )!;
        const creationPublication = await repository.findPublication(
          pendingCreation.id,
        );
        assert(creationPublication);
        assert.equal(agentChange.status, "pending");
        assert.equal(agentChange.caseId, parentCaseId);
        assert.equal(
          agentChange.publishedCommit,
          creationPublication.revision.version,
        );
        const completedCreation = primary.snapshot.configuration!.changes.find(
          (entry) => entry.id === pendingCreation.id,
        )!;
        assert.equal(completedCreation.status, "approved");
        assert.equal(
          completedCreation.publishedCommit,
          creationPublication.revision.version,
        );
        assert.equal(
          primary.snapshot.changeDecisionContinuations?.[pendingCreation.id],
          "resumed",
        );
        assert(agentChange.diff!.files.length);
        assert(!("patch" in agentChange.diff!));
        assert(!("operator" in agentChange));
        assert(
          primary.snapshot.configuration!.changes.find((entry) =>
            entry.id === pendingCreation.id
          )!.diff!.patch.includes("Research request"),
        );
        assert.equal(primary.snapshot.error, undefined);
        assert(primary.snapshot.messages.length > priorMessages);
        const peerView = conversations.snapshot.conversations.find((entry) =>
          entry.agentId !== primaryId
        )!;
        assert(peerView);
        const peer = workspace.runtimeFor(peerView.agentId)!.runtime;
        assert.equal(peer.snapshot.error, undefined);
        const child = peer.cases.cases.find((entry) =>
          entry.openedFrom.changeId === pendingCreation.id
        )!;
        assert(child);
        assert.equal(child.owner, peerView.agentId);
        assert.equal(child.openedBy, primaryId);
        assert.equal(child.openedFrom.caseId, parentCaseId);
        assert.equal(child.openedFrom.conversationId, primary.snapshot.id);
        const escalation = peer.snapshot.configuration!.changes.at(-1)!;
        assert.equal(escalation.caseId, child.id);
        assert.equal(escalation.requestedBy, peerView.agentId);
        const notice = primary.snapshot.messages.find((entry) =>
          entry.operatorNotice?.kind === "authority-escalation" &&
          entry.operatorNotice.changeId === escalation.id
        )!;
        assert.equal(notice.caseId, parentCaseId);
        assert(notice.operatorNotice?.kind === "authority-escalation");
        assert.equal(notice.operatorNotice.reason.length, 1000);
        assert(notice.operatorNotice.reason.endsWith("[truncated]"));
        assert(
          notice.text.indexOf('"changeId"') < notice.text.indexOf('"reason"'),
        );
        assert.equal(escalation.authority, undefined);
        assert.equal(peer.snapshot.executionModel!.modelEditPolicy, undefined);
        assert.equal(peer.snapshot.executionModel!.mandate.id, "builder-v1");
        // Replaying the accepted creation must not reinitialize either runtime or create another Request.
        const count = peer.cases.cases.length;
        await decide(
          primary,
          primary.snapshot.configuration!.changes.find((entry) =>
            entry.id === pendingCreation.id
          )!,
        );
        assert.equal(peer.cases.cases.length, count);
        assert.equal(
          peer.snapshot.configuration!.changes.at(-1)!.id,
          escalation.id,
        );
        const sourceBeforeDecision = (await repository.current()).version;
        await decide(peer, escalation, verdict);
        assert.equal(peer.snapshot.error, undefined);
        assert.equal(contexts.at(-1)!.case!.id, child.id);
        assert.deepEqual(
          peer.snapshot.executionModel!.configuration.network!.allowedHosts,
          verdict === "approve" ? ["example.org"] : [],
        );
        assert.equal(
          peer.snapshot.executionModel!.mandate.id,
          verdict === "approve" ? "builder-v2" : "builder-v1",
        );
        if (verdict === "refuse") {
          assert.equal(
            (await repository.current()).version,
            sourceBeforeDecision,
          );
        }
        const beforeCompletionCalls = primaryCalls();
        await conversations.submitHuman({
          agentId: peerView.agentId,
          expectedRevision: peer.snapshot.revision,
          caseId: child.id,
          text: "Confirm and close this Request as done.",
        });
        await postgres!.idle(peer);
        assert.equal(peer.snapshot.error, undefined);
        await peer.closeCase(child.id, "done", ACCEPTED_CASE_CLOSURE);
        assert.equal(
          peer.cases.cases.find((entry) => entry.id === child.id)!.status,
          "closed-done",
        );
        const receipt = primary.snapshot.messages.find((entry) =>
          entry.operatorNotice?.kind === "request-completed" &&
          entry.operatorNotice.caseId === child.id
        )!;
        assert.equal(receipt.caseId, parentCaseId);
        assert.deepEqual(receipt.operatorNotice, {
          kind: "request-completed",
          caseId: child.id,
          owner: peerView.agentId,
          openedBy: primaryId,
          status: "closed-done",
          result:
            ("Request completed with the admitted scope. " + "y".repeat(2000))
              .slice(0, 1000 - "… [truncated]".length) + "… [truncated]",
        });
        assert.equal(
          primaryCalls(),
          beforeCompletionCalls,
          "completion notices never trigger a designer turn",
        );
        assert(
          receipt.text.indexOf('"status"') < receipt.text.indexOf('"result"'),
        );
        if (verdict === "approve") {
          const head = await repository.current();
          const peerScope = await requestOperatorSystemName(
            "AssemblyLiveBuilder::liveBuilder",
            pendingCreation.id,
          );
          const seeded: Record<string, string> = {
            ...head.sources,
            "initial-tools.sysml": await Deno.readTextFile(
              new URL("../../models/initial-tools.sysml", import.meta.url),
            ),
          };
          const code = "export default ({html}) => ({title:'Page',text:html})";
          const seed = `
            item adoptedReader : AssemblyInitialTools::ToolSeed {
              attribute :>> id = "adopted-reader";
              attribute :>> name = "adopted-reader";
              attribute :>> description = "Reader selected by the newly adopted contract";
              attribute :>> kind = "read_web_page";
              attribute :>> code = ${JSON.stringify(code)};
            }
          `;
          assert(
            seeded["configuration.sysml"]!.includes(
              "part catalog : ToolCatalog {",
            ),
          );
          assert(seeded["configuration.sysml"]!.includes("maxInvocations = 4"));
          seeded["configuration.sysml"] = seeded["configuration.sysml"]!
            .replace(
              "part catalog : ToolCatalog {",
              "part catalog : ToolCatalog {" + seed,
            )
            .replace("maxInvocations = 4", "maxInvocations = 5");
          const changed = await repository.publishSystemSources(
            seeded,
            head.version,
            "adopt initial reader and revise Request ceiling",
          );
          for (
            const [runtime, scope] of [[peer, peerScope], [
              primary,
              "AssemblyLiveBuilder::liveBuilder",
            ]] as const
          ) {
            const prospective = await validateSourceExecutable(
              changed,
              projectId,
              scope,
            );
            assert.deepEqual(
              (prospective.initialTools ?? []).map(({ id, draft }) => ({
                id,
                code: draft.code,
              })),
              runtime === primary ? [{ id: "adopted-reader", code }] : [],
              "the source selection belongs exactly to Main's local catalog",
            );
            const command = {
              agentId: prospective.identity.builderId,
              expectedDigest: prospective.version.digest,
              expectedVersion: changed.version,
            };
            await workspace.adopt(
              command,
              () => runtime.adoptModelVersion(command),
            );
            assert.equal(
              runtime.snapshot.executionModel!.version.digest,
              prospective.version.digest,
            );
            assert.equal(
              runtime.snapshot.executionModel!.version.repositoryVersion,
              changed.version,
            );
          }
          // Adoption accepts durable preparation; inspect its result only after
          // the fixture worker has settled the exact selected seed.
          await postgres.idle(primary);
          assert.equal(primary.snapshot.error, undefined);
          assert(
            primary.snapshot.candidates.some((candidate) =>
              candidate.initialToolSeed?.id === "adopted-reader" &&
              candidate.stage === "awaiting-admission"
            ),
            "adoption enqueues preparation of the newly selected tool",
          );
          const prepared = primary.snapshot.candidates.filter((candidate) =>
            candidate.initialToolSeed?.id === "adopted-reader"
          );
          assert.equal(prepared.length, 1);
          const candidate = prepared[0]!;
          assert.equal(candidate.code, code);
          const callsBeforeRestart = contexts.length;
          await workspace.close();
          workspace = await openOperatorWorkspace({
            ...postgres.workspacePorts,
            createSourceModel: postgres.backend.createSourceModel,
            primaryHistory: store,
            primary,
            primaryModel: model,
            repository,
            tooling,
            agents,
            directory,
            executors: [],
            caseNumbers,
            workBudget,
          });
          await postgres.start(workspace);
          await postgres.idle(primary);
          assert.equal(
            contexts.length,
            callsBeforeRestart,
            "an edited historical creation is never dispatched again",
          );
          assert.equal(
            workspace.runtimeFor(peerView.agentId)!.runtime.cases.cases.filter((
              record,
            ) => record.openedFrom.changeId === pendingCreation.id).length,
            1,
          );
          const retained = primary.snapshot.candidates.filter((entry) =>
            entry.initialToolSeed?.id === "adopted-reader"
          );
          assert.equal(retained.length, 1);
          assert.equal(retained[0]!.id, candidate.id);
          assert.equal(retained[0]!.digest, candidate.digest);
          assert.equal(retained[0]!.stage, "awaiting-admission");
          assert.deepEqual(
            retained[0]!.initialToolSeed,
            candidate.initialToolSeed,
          );

          // Settle this exact admission before changing its source selection.
          // A pending native promotion must continue to block model adoption.
          await primary.decideCandidate({
            candidateId: candidate.id,
            candidateDigest: candidate.digest,
            verdict: "refuse",
            reason: "Decline the selected reader before removing its source",
          });
          await postgres.idle(primary);
          assert.equal(primary.snapshot.error, undefined);
          assert.equal(
            primary.snapshot.candidates.find((entry) =>
              entry.id === candidate.id
            )!.stage,
            "refused",
          );
          assert.equal(contexts.length, callsBeforeRestart);

          // Remove the created operator after its first Request, then adopt the removal.
          // Only the removed root's owner covers this effect (invariant 3):
          // the fixture default exercises the primary root, so admit the
          // removal with the peer's own exercise.
          const beforeRemoval = await repository.current();
          const removalAuthority = exerciseOwnerAuthority(
            await validateSourceExecutable(
              beforeRemoval,
              projectId,
              peerScope,
            ),
            "model-revision",
          );
          const removalProposal = await repository.propose({
            baseVersion: beforeRemoval.version,
            sources: afterGrant.sources,
            author: "local-owner",
            reason: "remove the completed Request operator",
            authorization: {
              kind: "local-owner",
              authorityExercise: removalAuthority,
            },
          });
          const removed = await repository.accept({
            id: removalProposal.id,
            expectedVersion: beforeRemoval.version,
            author: "local-owner",
            decisionAuthorityExercise: removalAuthority,
          });
          const withoutPeer = await validateSourceExecutable(
            removed,
            projectId,
          );
          const command = {
            agentId: primaryId,
            expectedDigest: withoutPeer.version.digest,
            expectedVersion: removed.version,
          };
          await workspace.adopt(
            command,
            () => primary.adoptModelVersion(command),
          );
          await workspace.close();
          const errors: LogRecord[] = [];
          try {
            await configureTechnicalLogging({
              level: "error",
              sink: (record) => {
                errors.push(record);
              },
            });
            workspace = await openOperatorWorkspace({
              ...postgres.workspacePorts,
              createSourceModel: postgres.backend.createSourceModel,
              primaryHistory: store,
              primary,
              primaryModel: model,
              repository,
              tooling,
              agents,
              directory,
              executors: [],
              caseNumbers,
              workBudget,
            });
            await postgres.start(workspace);
            await postgres.idle(primary);
            assert.equal(contexts.length, callsBeforeRestart);
            assert(
              errors.some((record) =>
                record.category.length === 1 &&
                record.category[0] === "scheduler" &&
                record.level === "error" &&
                record.properties.code === "OPERATOR_OPEN_FAILED" &&
                (record.properties.context as { changeId?: string } | undefined)
                    ?.changeId === pendingCreation.id
              ),
              "a historical missing operator is logged without aborting startup",
            );
          } finally {
            await reset();
          }
        }
      } finally {
        await postgres?.close();
        await Deno.remove(directory, { recursive: true });
      }
    },
  });
}
