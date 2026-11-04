/** Spec 4.8c witness — written before the implementation (step 9).
 *
 * Real Toolkit, Git writer, PostgreSQL, native queue and Request control. Both
 * Requests are opened through `RequestSpaceOpenings`, the interface path. Only
 * provider decisions and the page fetch are deterministic doubles; they never
 * fabricate notices, routes, decisions, publications or adoptions.
 *
 * It checks: a BO request reaches the MO as a notice naming the BO by its
 * composite identity; without a mandate the person decides; with an MO mandate
 * naming BO@A the route is `actor-decision`, the MO is woken and its decision
 * is published in A's branch while main stays unchanged; BO@B, not named by
 * the mandate, stays with the person.
 *
 * Main is composed by the host's own `composeMainOperator`, the function
 * `src/composition/root.ts` calls: operator workspace, branch authority and
 * delivery order. The witness reads Main through the composed workspace.
 *
 * Opt-in, Darwin only, from the repository root:
 *   ASSEMBLY_POSTGRES_TEST_URL=postgres://…/assembly_pg1_test \
 *   SYSML_TOOLKIT_DIR=… nice -n 10 deno task test:postgres-toolkit \
 *     --allow-slow test/integration/postgres-request-branch-authority_test.ts
 */
import assert from "node:assert/strict";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import {
  openInitialNormalRequest,
  openNormalAdmissionWitnessHost,
  readCompletedNormalRequest,
} from "../support/request-source-admission-normal-host.ts";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import {
  retainedWitnessDrafts,
  retainedWitnessRunner,
  retainedWitnessUrl,
} from "../support/request-retained-tool-witness.ts";
import { caseNetworkWitnessAgent } from "../support/request-case-network-witness.ts";
import { eventually } from "../support/eventually.ts";
import type { AgentPort } from "../../src/application/work/runtime/ports.ts";
import type { ChatContext } from "../../src/application/work/conversation/chat-context.ts";
import type { ChatDecision } from "../../src/application/work/conversation/chat-decision.ts";
import type { PendingChange } from "../../src/domain/governance/records/pending-change.ts";

type Ref = {
  projectId: string;
  systemId: string;
  executionSpaceId: string;
  operatorId: string;
};
/** Planned v2 notice fields (C5). */
type PlannedNotice = {
  changeId: string;
  decisionAuthority: string;
  changeKind?: string;
  requestedRights?: unknown;
  route?: {
    version: number;
    status: string;
    requester?: Ref;
    designatedDecider?: Record<string, unknown>;
  };
};
/** Planned decision-context entries (C8). */
type PlannedRequest = {
  id: string;
  requestedBy: string;
  baseRevision: number;
  executionSpaceId?: string;
};

/** Main Operator double: it grants nothing itself and decides only the exact
 * request the host lists in its decision context. */
function mainAuthorityAgent() {
  const decisions: Array<{ executionSpaceId?: string; changeId: string }> = [];
  const reports: Array<
    NonNullable<ChatContext["operatorAuthority"]>["awaitingPerson"]
  > = [];
  let turns = 0;
  let grant: { caseId: string; operatorId: string } | undefined;
  let opening: { objective: string; openingId: string } | undefined;
  let report = false;
  let write: { caseId: string; operatorId: string } | undefined;
  let redecide:
    | { changeId: string; operatorId: string; baseRevision: number }
    | undefined;
  const agent: AgentPort = {
    label: "Controlled Main Operator for the branch authority witness",
    decide(context) {
      turns++;
      if (opening) {
        // 4.8d D3: the MO opens a branch Request under its own mandate.
        const request = opening;
        opening = undefined;
        if (context.requestOpening?.canOpen !== true) {
          return Promise.resolve({
            kind: "reply",
            text: "No open-request act",
          } as ChatDecision);
        }
        return Promise.resolve({
          kind: "open_request",
          text: "Open the Request in its own branch",
          objective: request.objective,
          openingId: request.openingId,
          source: { kind: "current-main" },
        } as ChatDecision);
      }
      if (report) {
        // 4.8d D2: asked what is pending, the MO names what the host lists.
        report = false;
        const waiting = context.operatorAuthority?.awaitingPerson ?? [];
        reports.push(structuredClone(waiting));
        return Promise.resolve({
          kind: "reply",
          text: waiting.length
            ? waiting.map((entry) =>
              `${entry.id} in Case ${entry.caseId} waits for you on its card`
            ).join("; ")
            : "Nothing waits for you",
        } as ChatDecision);
      }
      if (grant) {
        const recipient = grant;
        grant = undefined;
        return Promise.resolve({
          kind: "propose_mandate_change",
          text: "Ask the person for a mandate over this branch operator",
          reason: "Decide network requests of one Case branch operator",
          requestedRights: {
            operatorAuthority: {
              policyId: "bo-a-network",
              expectedPolicyRevision: 0,
              enabled: true,
              recipients: [recipient.operatorId],
              // 4.8d D4: the MO names the Case; the host derives the space.
              recipientCaseId: recipient.caseId,
              acts: ["addNetworkHosts"],
              networkHosts: ["example.org"],
              toolIds: [],
              maxDelegationDepth: 0,
            },
          },
        } as unknown as ChatDecision);
      }
      if (write) {
        // Q3: after opening, the MO writes to the BO of the Request.
        const target = write;
        write = undefined;
        return Promise.resolve({
          kind: "resume_request",
          text: "Add an instruction to the Request",
          operatorId: target.operatorId,
          caseId: target.caseId,
          resumeId: "mo-write-1",
          instruction: "Also list the page headings.",
        } as ChatDecision);
      }
      if (redecide) {
        // The MO issues its command again for a change it already decided.
        const again = redecide;
        redecide = undefined;
        return Promise.resolve({
          kind: "decide_operator_change",
          text: "Approve this exact covered branch request",
          operatorId: again.operatorId,
          changeId: again.changeId,
          expectedRevision: again.baseRevision,
          policyId: "bo-a-network",
          policyRevision: 1,
          verdict: "approve",
        } as unknown as ChatDecision);
      }
      const pending =
        (context.operatorAuthority?.requests ?? []) as PlannedRequest[];
      const next = pending.find((request) =>
        !decisions.some((entry) => entry.changeId === request.id)
      );
      if (next) {
        decisions.push({
          executionSpaceId: next.executionSpaceId,
          changeId: next.id,
        });
        // A6: the MO never types the space; the host derives it from the Case.
        return Promise.resolve({
          kind: "decide_operator_change",
          text: "Approve this exact covered branch request",
          operatorId: next.requestedBy,
          changeId: next.id,
          expectedRevision: next.baseRevision,
          policyId: "bo-a-network",
          policyRevision: 1,
          verdict: "approve",
        } as unknown as ChatDecision);
      }
      return Promise.resolve({ kind: "reply", text: "Observed" });
    },
    review() {
      throw new Error("The Main witness never reviews a candidate");
    },
  };
  return {
    agent,
    decisions,
    reports,
    armWrite(target: { caseId: string; operatorId: string }) {
      write = target;
    },
    armRedecide(
      change: { changeId: string; operatorId: string; baseRevision: number },
    ) {
      redecide = change;
    },
    armReport() {
      report = true;
    },
    turns: () => turns,
    armOpening(request: { objective: string; openingId: string }) {
      opening = request;
    },
    armGrant(recipient: { caseId: string; operatorId: string }) {
      grant = recipient;
    },
  };
}

Deno.test({
  name:
    "4.8c: BO requests reach the MO by composite identity; only a covering MO mandate decides, in the branch",
  ignore: Deno.build.os !== "darwin" ||
    !postgresTestEnabled || !toolkitIntegrationEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const controlled = caseNetworkWitnessAgent();
      const branchContexts: ChatContext[] = [];
      const observedBranchAgent: AgentPort = {
        ...controlled.agent,
        decide(context) {
          branchContexts.push(structuredClone(context));
          return controlled.agent.decide(context);
        },
      };
      const runner = retainedWitnessRunner();
      const mo = mainAuthorityAgent();
      const host = await openNormalAdmissionWitnessHost(database, {
        wholeSystemClosure: true,
        enableRuntimeAdoption: true,
        enableNetworkChangeWitness: true,
        tools: [{ ...retainedWitnessDrafts[0], id: "network-reader-v1" }],
        agent: observedBranchAgent,
        runner: runner.runner,
        preparationRunner: runner.runner,
        networkHost: "example.net",
        mainAgents: mo.agent,
      });
      const main = host.workspace!.runtimeFor(host.primaryOperatorId)!.runtime;
      const conversations = host.networkConversationsForWitness();
      const operatorId = host.primaryOperatorId;
      // Composite identities are anchored on the admitted model's identity.
      const identity = main.snapshot.executionModel!.identity;
      const at = (executionSpaceId: string): Ref => ({
        projectId: identity.projectId,
        systemId: identity.systemId,
        executionSpaceId,
        operatorId,
      });
      /** A person types only when Main has finished its current reply. */
      async function submitToMain(text: string, arm: () => void) {
        await eventually(async () => {
          await main.idle();
          return main.snapshot.busy ? undefined : true;
        }, { label: "Main ready for the person" });
        arm();
        await main.submit(text);
        // submit returns a Request scope ID (or undefined for Main), not the
        // accepted contribution ID. Identify the unique immutable delivery.
        const rows = await host.storage.client.executionContribution.findMany({
          where: {
            ...host.storage.scope,
            executionSpaceId: "main",
            operatorId,
            kind: "contribution",
          },
          select: { contributionId: true, payloadJson: true },
        });
        const matches = rows.filter((row) =>
          JSON.parse(row.payloadJson).payload?.text === text
        );
        assert.equal(matches.length, 1, "exact Main contribution is unique");
        const accepted = await host.stage.nativeRuntime.dispatch
          .inspectAccepted(
            operatorId,
            matches[0].contributionId,
          );
        assert(accepted);
        assert.equal(accepted.delivery.payload?.text, text);
        assert.equal(accepted.delivery.kind, "contribution");
        return accepted.receipt.id;
      }
      const a = await openInitialNormalRequest(host);
      const b = await openInitialNormalRequest(host);
      assert.notEqual(a.record.executionSpaceId, b.record.executionSpaceId);
      const mainModel = main.snapshot.executionModel!;
      assert.equal(mainModel.policy.mayConsultModel, true);
      assert.equal(mainModel.policy.mayProposeSysmlRevision, true);
      for (const request of [a, b]) {
        const state = await request.stores.state.load();
        assert(
          state?.executionModel,
          "The real Request has an admitted BO model",
        );
        const model = state.executionModel;
        assert.equal(model.identity.builderId, mainModel.identity.builderId);
        assert.equal(model.version.digest, mainModel.version.digest);
        assert.equal(
          model.version.repositoryVersion,
          mainModel.version.repositoryVersion,
        );
        assert.equal(model.policy.mayConsultModel, true);
        assert.equal(model.policy.mayProposeSysmlRevision, true);
      }

      async function propose(request: typeof a) {
        const caseId = request.record.caseId;
        const view = await conversations.conversations(
          request.session.secret,
          caseId,
        );
        const owner = view.conversations.find((entry) =>
          entry.agentId === operatorId
        );
        assert(owner);
        controlled.armProposal(caseId);
        await conversations.submitHuman(request.session.secret, {
          caseId,
          agentId: owner.agentId,
          expectedRevision: owner.revision,
          text: `Please read ${retainedWitnessUrl}; request the missing host.`,
        });
        return await eventually(async () => {
          const state = await request.stores.state.load();
          return state?.configuration?.changes.find((change) =>
            change.status === "pending" && change.caseId === caseId &&
            change.requestedRights &&
            "addNetworkHosts" in change.requestedRights
          );
        }, {
          label: `pending BO request in ${caseId}`,
          diagnose: async () => {
            const state = await request.stores.state.load();
            return {
              provider: controlled.diagnostics.filter((entry) =>
                entry.caseId === caseId
              ),
              events: state?.events.slice(-8).map((event) => ({
                kind: event.kind,
                code: event.code ?? null,
              })),
              changes: state?.configuration?.changes.map((change) => ({
                status: change.status,
                kind: change.kind,
              })),
              busy: state?.busy,
              workerErrors: host.workerErrors.length,
            };
          },
        });
      }
      async function noticesFor(caseId: string, changeId: string) {
        return (await host.mainAuthorityNotices(caseId))
          .filter((notice) =>
            notice.changeId === changeId
          ) as unknown[] as PlannedNotice[];
      }

      // 1. No mandate: BO@B's request reaches the MO and stays with the person.
      const turnsBefore = mo.turns();
      const changeB = await propose(b);
      const branchContext = branchContexts.find((context) =>
        context.case?.id === b.record.caseId
      );
      assert(branchContext, "The Request provider saw its effective policy");
      assert.equal(branchContext.executionPolicy?.mayConsultModel, true);
      assert.equal(
        branchContext.executionPolicy?.mayProposeSysmlRevision,
        true,
      );
      const [noticeB] = await eventually(async () => {
        const notices = await noticesFor(b.record.caseId, changeB.id);
        return notices.length ? notices : undefined;
      }, { label: "MO notice for BO@B" });
      assert.equal(noticeB.route?.version, 2);
      assert.deepEqual(noticeB.route?.requester, at(b.record.executionSpaceId));
      assert.equal(noticeB.route?.status, "human-decision");
      assert.equal(noticeB.decisionAuthority, "human");
      assert.equal(noticeB.changeKind, "mandate-change");
      assert.deepEqual(noticeB.requestedRights, {
        addNetworkHosts: ["example.org"],
      });
      assert.equal(mo.turns(), turnsBefore, "a human decision wakes no MO");

      // 4.8d D2: asked, the MO names the request waiting for the person; it
      // is read-only context, never a request the MO may decide.
      await submitToMain("Is anything waiting for me?", () => mo.armReport());
      const [waiting] = await eventually(
        () => mo.reports.length ? mo.reports : undefined,
        { label: "MO report of waiting requests" },
      );
      assert.deepEqual(
        waiting.map((entry) => [entry.id, entry.caseId, entry.status]),
        [[changeB.id, b.record.caseId, "human-decision"]],
      );
      assert.deepEqual(
        waiting[0].requester,
        at(b.record.executionSpaceId),
      );
      const answer = await eventually(
        () =>
          main.snapshot.messages.findLast((message) =>
            message.role === "assistant" && message.text.includes(changeB.id)
          ),
        { label: "MO answer naming the waiting request" },
      );
      assert(answer.text.includes(b.record.caseId));

      // 4.8d D3: the MO opens a Request by chat: a branch and its BO, under
      // the open-request act of its own mandate, with no person session.
      const sessions = () =>
        host.storage.client.spaceControlCredential.count({
          where: { ...host.storage.scope, kind: "session" },
        });
      const sessionsBefore = await sessions();
      assert.equal(
        main.snapshot.executionModel!.flows.conversation.nodes.some((node) =>
          node.mechanism === "consult_declared_source"
        ),
        false,
      );
      const beforeOpeningMessageIds = new Set(
        main.snapshot.messages.map((message) => message.id),
      );
      await submitToMain(
        "Open a Request to summarize the witness page",
        () =>
          mo.armOpening({
            objective: `Summarize ${retainedWitnessUrl} for the person.`,
            openingId: "mo-opening-1",
          }),
      );
      const opened = await eventually(async () => {
        const rows = await host.storage.client.spaceOpening.findMany({
          where: { ...host.storage.scope },
        });
        const row = rows.find((entry) =>
          entry.commandJson.includes('"opener"') && entry.phase === "dispatched"
        );
        return row
          ? await new PostgresRequestSpaceStore(
            host.storage.client,
            host.storage.scope,
          ).get(row.id)
          : undefined;
      }, {
        label: "MO-opened branch Request",
        timeoutMs: 90_000,
        diagnose: async () => ({
          mainError: main.snapshot.error?.slice(0, 400) ?? null,
          canOpen: main.snapshot.executionModel?.mandate.mayOpenRequests ??
            null,
          messages: main.snapshot.messages.slice(-3).map((message) => ({
            role: message.role,
            text: message.text.slice(0, 400),
          })),
          openings: (await host.storage.client.spaceOpening.findMany({
            where: { ...host.storage.scope },
            select: { phase: true, issuesJson: true, openingKey: true },
          })).map((row) => ({
            phase: row.phase,
            issues: row.issuesJson,
            main: row.openingKey.startsWith("main-"),
          })),
        }),
      });
      assert.deepEqual(opened?.command.opener?.operator, at("main"));
      assert.equal(opened?.command.opener?.origin.openingId, "mo-opening-1");
      assert.equal(await sessions(), sessionsBefore, "no session row");
      assert.equal(
        main.snapshot.messages.some((message) =>
          !beforeOpeningMessageIds.has(message.id) &&
          message.observation?.kind === "model-context"
        ),
        false,
        "Opening the Request emits no declared model consultation observation",
      );
      const moRequest = await readCompletedNormalRequest(host, opened!.id);
      assert.equal(moRequest.state.cases?.[0]?.openedBy, operatorId);
      // The opening text is the MO's input, never the person's: its URLs are
      // not a person's selection (4.8d D3).
      assert.equal(
        moRequest.state.messages.find((message) =>
          message.id === opened!.initialContributionId
        )?.role,
        "tool",
      );
      const outcome = await eventually(
        () =>
          main.snapshot.messages.findLast((message) =>
            message.role === "tool" &&
            message.text.includes("Request opening result") &&
            message.text.includes(opened!.caseId)
          ),
        { label: "MO observes its opening" },
      );
      assert(outcome.text.includes('"status":"opened"'));

      // Q3: the MO then writes to that BO; it arrives as the MO's input.
      await submitToMain(
        "Ask that Request to also list the headings",
        () => mo.armWrite({ caseId: opened!.caseId, operatorId }),
      );
      const instruction = await eventually(async () => {
        const state = await moRequest.stores.state.load();
        return state?.messages.find((message) =>
          message.text === "Also list the page headings."
        );
      }, { label: "MO instruction reaches the BO", timeoutMs: 60_000 });
      assert.equal(instruction.role, "tool");

      // 2. The person grants the MO a mandate naming BO@A only (main card).
      await submitToMain(
        "Prepare a mandate for the branch operator of Case A",
        () => mo.armGrant({ caseId: a.record.caseId, operatorId }),
      );
      const grant = await eventually(
        () =>
          main.snapshot.configuration?.changes.find((change: PendingChange) =>
            change.status === "pending" && !!change.requestedRights &&
            "operatorAuthority" in change.requestedRights
          ),
        {
          label: "MO mandate proposal in main",
          diagnose: () => ({
            mainError: main.snapshot.error?.slice(0, 400) ?? null,
            busy: main.snapshot.busy,
            turns: mo.turns(),
            messages: main.snapshot.messages.slice(-3).map((message) => ({
              role: message.role,
              text: message.text.slice(0, 300),
            })),
          }),
        },
      );
      await main.decideChange({
        changeId: grant.id,
        expectedRevision: grant.baseRevision,
        verdict: "approve",
      });
      await eventually(
        () =>
          main.snapshot.executionModel?.operatorAuthorityPolicies?.some((
              policy,
            ) =>
              policy.id === "bo-a-network" &&
              (policy as { recipientExecutionSpaceId?: string })
                  .recipientExecutionSpaceId === a.record.executionSpaceId
            )
            ? true
            : undefined,
        {
          label: "admitted MO mandate over BO@A",
        },
      );
      const mainVersion = (await host.backend.repository.current()).version;
      const mainNetwork = structuredClone(
        main.snapshot.executionModel!.configuration.network,
      );
      const sourceA = await host.sourceAdmission.admittedSource(a.record);
      const sourceB = await host.sourceAdmission.admittedSource(b.record);

      // 3. Covered: BO@A's request designates the MO, wakes it, and its
      // decision is published in A's branch.
      const changeA = await propose(a);
      const [noticeA] = await eventually(async () => {
        const notices = await noticesFor(a.record.caseId, changeA.id);
        return notices.length ? notices : undefined;
      }, { label: "MO notice for BO@A" });
      assert.deepEqual(noticeA.route?.requester, at(a.record.executionSpaceId));
      assert.equal(noticeA.route?.status, "actor-decision");
      assert.equal(noticeA.decisionAuthority, "operator");
      assert.deepEqual(noticeA.route?.designatedDecider, {
        operatorId,
        executionSpaceId: "main",
        policyId: "bo-a-network",
        policyRevision: 1,
      });
      const decided = await eventually(async () => {
        const state = await a.stores.state.load();
        const change = state?.configuration?.changes.find((entry) =>
          entry.id === changeA.id
        );
        return change?.status === "approved" ? change : undefined;
      }, { label: "MO decision recorded in A", timeoutMs: 90_000 });
      assert.deepEqual(mo.decisions, [{
        executionSpaceId: a.record.executionSpaceId,
        changeId: changeA.id,
      }]);
      assert.equal(decided.authority, "builder");
      const delegation = decided.authorityExercise?.delegation as
        | { actor?: Ref; requester?: Ref }
        | undefined;
      assert.deepEqual(delegation?.actor, at("main"));
      assert.deepEqual(delegation?.requester, at(a.record.executionSpaceId));
      const publishedA = await eventually(async () => {
        const source = await host.sourceAdmission.admittedSource(a.record);
        return source.head.source.version !== sourceA.head.source.version
          ? source
          : undefined;
      }, {
        label: "A branch publication",
        timeoutMs: 90_000,
        diagnose: async () => {
          const state = await a.stores.state.load();
          const writes = await host.storage.client.modelWriteCommand.findMany({
            where: { ...host.storage.scope },
            take: 16,
            select: { state: true, attempts: true, lastErrorJson: true },
          });
          const code = (raw: string | null) => {
            try {
              const value = raw ? JSON.parse(raw) : null;
              return value && typeof value === "object"
                ? { code: value.code ?? null, name: value.name ?? null }
                : null;
            } catch {
              return "unparsable";
            }
          };
          return {
            decision: state?.requestNetworkDecisions?.[changeA.id]
              ? {
                verdict: state.requestNetworkDecisions[changeA.id].verdict,
                authority: state.requestNetworkDecisions[changeA.id].authority
                  ?.kind,
              }
              : null,
            writes: writes.map((write) => ({
              state: write.state,
              attempts: String(write.attempts),
              error: code(write.lastErrorJson),
            })),
            mainEvents: main.snapshot.events.slice(-10).map((event) => ({
              kind: event.kind,
              code: event.code ?? null,
              outcome: event.operatorCommandOutcome?.result.status ?? null,
              refusal: event.operatorCommandOutcome?.result.status === "refused"
                ? event.operatorCommandOutcome.result.refusal.code
                : null,
            })),
            mainError: main.snapshot.error?.slice(0, 600) ?? null,
            workerErrors: host.workerErrors.length,
          };
        },
      });
      assert.notEqual(publishedA.head.source.version, mainVersion);
      const adoptedA = await eventually(async () => {
        const state = await a.stores.state.load();
        return state?.executionModel?.configuration.network?.allowedHosts
            .includes("example.org")
          ? state
          : undefined;
      }, {
        label: "A adopts its approved host",
        timeoutMs: 90_000,
        diagnose: async () => {
          const state = await a.stores.state.load();
          const dossiers = await host.storage.client.evolutionDossier.findMany({
            where: { ...host.storage.scope },
            select: { kind: true, status: true },
            take: 16,
          });
          return {
            mainError: main.snapshot.error?.slice(0, 600) ?? null,
            requestError: state?.error?.slice(0, 600) ?? null,
            requestEvents: state?.events.slice(-8).map((event) => ({
              kind: event.kind,
              label: event.label?.slice(0, 160) ?? null,
            })),
            dossiers,
          };
        },
      });
      assert(adoptedA.executionModel);

      // 4.8d: a decision the MO recorded is found again by its record and
      // reaches the bridge's replay, never main's path (same native ID). A
      // command other than the recorded one is refused there, with its code.
      const replayContributionId = await submitToMain(
        "Decide that request again",
        () =>
          mo.armRedecide({
            changeId: changeA.id,
            operatorId,
            baseRevision: changeA.baseRevision,
          }),
      );
      const replayed = await eventually(
        () =>
          main.snapshot.messages.findLast((message) =>
            message.role === "tool" &&
            message.text.includes("AUTHORITY_REQUEST_STALE")
          ),
        {
          label: "MO replay reaches the bridge",
          diagnose: () =>
            main.snapshot.messages.slice(-3).map((message) =>
              message.text.slice(0, 300)
            ),
        },
      );
      assert(replayed.text.includes("already decided"));
      const replayTerminal = await eventually(
        async () =>
          await host.stage.nativeRuntime.dispatch.inspectTerminalAccepted(
            operatorId,
            replayContributionId,
          ) ?? undefined,
        {
          label: "exact Main replay transport completion",
          diagnose: async () => {
            const [stateA, stateB] = await Promise.all([
              a.stores.state.load(),
              b.stores.state.load(),
            ]);
            return {
              replayContributionId,
              main: { busy: main.snapshot.busy, error: main.snapshot.error },
              a: {
                id: a.record.executionSpaceId,
                busy: stateA?.busy,
                error: stateA?.error,
              },
              b: {
                id: b.record.executionSpaceId,
                busy: stateB?.busy,
                error: stateB?.error,
              },
            };
          },
        },
      );
      assert.equal(replayTerminal.terminal, "completed");
      assert.equal(replayTerminal.receipt.id, replayContributionId);
      await main.idle();
      assert.equal(main.snapshot.busy, false);
      assert(!main.snapshot.error);

      // Main is unchanged by a decision taken for a BO.
      assert.equal(
        (await host.backend.repository.current()).version,
        mainVersion,
      );
      assert.deepEqual(
        main.snapshot.executionModel!.configuration.network,
        mainNetwork,
      );

      // 4. BO@B is not named by the mandate: still the person's decision.
      await host.coldAuthorityRuntimeForWitness().provision(b.record);
      const afterB = await noticesFor(b.record.caseId, changeB.id);
      assert.equal(afterB.length, 1, "recovery adds no duplicate notice");
      assert.equal(afterB[0].decisionAuthority, "human");
      const stateB = await b.stores.state.load();
      assert.equal(
        stateB?.configuration?.changes.find((entry) => entry.id === changeB.id)
          ?.status,
        "pending",
      );
      assert.equal(
        (await host.sourceAdmission.admittedSource(b.record)).head.source
          .version,
        sourceB.head.source.version,
      );
      assert(
        !mo.decisions.some((entry) => entry.changeId === changeB.id),
        "the MO never decides for an uncovered BO",
      );

      // Complete every owned delivery before the fixture starts its unchanged
      // bounded shutdown drain; message arrival alone precedes its handler ACK.
      await eventually(async () => {
        const pending = await host.storage.client.executionContribution.count({
          where: {
            ...host.storage.scope,
            status: { in: ["queued", "running"] },
          },
        });
        return pending === 0 ? true : undefined;
      }, { label: "owned contributions acknowledged" });
      await host.workspace!.drainRuntimeDeliveries();
      await main.idle();
      await host.stage.nativeRuntime.dispatch.drain();
      assert.deepEqual(host.workerErrors, []);
    });
  },
});
