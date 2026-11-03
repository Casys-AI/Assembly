/** Spec 4.8e witness — sub-operators in Case branches.
 *
 * Real Toolkit, Git writer, PostgreSQL, native queue and Request control.
 * Requests are opened through `RequestSpaceOpenings`, the interface path; Main
 * is composed by the host's own `composeMainOperator`. Only provider decisions
 * and the page fetch are deterministic doubles: they never fabricate notices,
 * routes, decisions, publications, adoptions or admissions.
 *
 * PRIMARY may hold a native creation grant mirrored onto each Branch Operator
 * (BO), or a grantless BO requests its own through the person's card. Creations
 * are published in the requester's branch only (E4).
 *
 * Opt-in, Darwin only, from the repository root:
 *   ASSEMBLY_POSTGRES_TEST_URL=postgres://…/assembly_pg1_test \
 *   SYSML_TOOLKIT_DIR=… nice -n 10 deno task test:postgres-toolkit \
 *     --allow-slow test/integration/postgres-request-branch-team_test.ts
 */
import assert from "node:assert/strict";
import { type LogRecord, reset } from "@logtape/logtape";
import { configureTechnicalLogging } from "../../src/infrastructure/logging.ts";
import { sourcePublicationError } from "../support/request-source-publication-diagnostics.ts";
import { scopedOperator } from "../../src/domain/governance/policies/delegation-scope.ts";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import {
  openInitialNormalRequest,
  openNormalAdmissionWitnessHost,
} from "../support/request-source-admission-normal-host.ts";
import {
  retainedWitnessDrafts,
  retainedWitnessRunner,
} from "../support/request-retained-tool-witness.ts";
import { eventually } from "../support/eventually.ts";
import { decodePostgresRuntimeState } from "../../src/adapters/out/postgres/runtime-state-snapshot.ts";
import { parseRequestOwnerAdoptionDossier } from "../../src/application/model/evolution/request-adoption-invariants.ts";
import type { SystemRuntimeState } from "../../src/domain/work/dialogue.ts";
import { MAX_BRANCH_TEAM } from "../../src/domain/work/records/conversations.ts";
import {
  recordedWorkCompletion,
  workReceipt,
} from "../../src/application/work/operators/journal.ts";

import {
  branchTeamAgent,
  observingMain,
  PRIMARY_NAME,
} from "../support/request-branch-team-provider.ts";

function teamCreations(state: SystemRuntimeState | null | undefined) {
  return (state?.configuration?.changes ?? []).filter((change) =>
    change.kind === "operator-creation"
  );
}

type Opened = Awaited<ReturnType<typeof openInitialNormalRequest>>;

/** One host per scenario, composed as production composes it, with PRIMARY's
 * optional native creation grant and the person's helpers. */
async function branchTeamWitness(
  database: Parameters<Parameters<typeof withPostgresDatabase>[0]>[0],
  creationPolicy?: {
    maxChildren: number;
    maxDelegationDepth?: number;
    mode?: "per-creation";
  },
) {
  const technicalErrors: LogRecord[] = [];
  // Registered before host resources: LIFO cleanup keeps the sink until they stop.
  database.registerCleanup(() => reset());
  await configureTechnicalLogging({
    level: "error",
    sink: (record) => {
      technicalErrors.push(record);
      if (technicalErrors.length > 16) technicalErrors.shift();
    },
  });
  const team = branchTeamAgent();
  const runner = retainedWitnessRunner();
  const mo = observingMain();
  const host = await openNormalAdmissionWitnessHost(database, {
    wholeSystemClosure: true,
    enableRuntimeAdoption: true,
    enableNetworkChangeWitness: true,
    tools: [{ ...retainedWitnessDrafts[0], id: "network-reader-v1" }],
    agent: team.agent,
    runner: runner.runner,
    preparationRunner: runner.runner,
    networkHost: "example.net",
    mainAgents: mo.agent,
    creationPolicy,
    observeSettledContributions: true,
  });
  const conversations = host.networkConversationsForWitness();
  async function diagnose(request: Opened) {
    const state = await request.stores.state.load();
    const main = host.workspace?.runtimeFor(host.primaryOperatorId)?.runtime
      .snapshot;
    const writes = await host.storage.client.modelWriteCommand.findMany({
      where: { ...host.storage.scope },
      take: 16,
      select: { state: true, attempts: true, lastErrorJson: true },
    });
    const memberRows = await host.storage.client.runtimeState.findMany({
      where: {
        ...host.storage.scope,
        executionSpaceId: request.record.executionSpaceId,
        operatorId: { not: host.primaryOperatorId },
      },
      take: MAX_BRANCH_TEAM + 1,
      select: { operatorId: true, revision: true, payload: true },
    });
    // Diagnostic snapshots only: do not open a transaction per member or use
    // these rows as admission or execution proof.
    const members = [];
    for (const row of memberRows) {
      let member: SystemRuntimeState;
      try {
        member = decodePostgresRuntimeState(row);
      } catch (error) {
        members.push({
          operatorId: row.operatorId,
          decodeError: String(error).slice(0, 1200),
        });
        continue;
      }
      members.push({
        operatorId: row.operatorId,
        runtimeId: member?.id ?? null,
        revision: member?.revision ?? null,
        busy: member?.busy ?? null,
        error: member?.error?.slice(0, 1200) ?? null,
        activeInputMessageId: member?.activeInputMessageId ?? null,
        invocationKind: member?.caseInvocation?.kind ?? null,
        budgetSuspension: member?.budgetSuspension ?? null,
        lastToolFailure: member?.lastToolFailure ?? null,
        messages: member?.messages.slice(-6).map((message) => ({
          id: message.id,
          role: message.role,
          caseId: message.caseId ?? null,
          text: message.text.slice(0, 1200),
        })) ?? [],
        changes: member?.configuration?.changes.map((change) => ({
          id: change.id,
          kind: change.kind,
          status: change.status,
          requestedBy: change.requestedBy ?? null,
        })) ?? [],
        changeDecisionContinuations: member?.changeDecisionContinuations ??
          null,
        pendingContributions: member?.pendingContributions ?? null,
      });
    }
    return {
      technicalErrors: technicalErrors.map((record) =>
        sourcePublicationError(record.properties)
      ),
      main: {
        busy: main?.busy ?? null,
        error: main?.error?.slice(0, 1200) ?? null,
        messages: main?.messages.slice(-6).map(({ role, text }) => ({
          role,
          text: text.slice(0, 1200),
        })) ?? [],
      },
      requestError: state?.error?.slice(0, 600) ?? null,
      busy: state?.busy ?? null,
      events: state?.events.slice(-10).map((event) => ({
        kind: event.kind,
        code: event.code ?? null,
        label: event.label?.slice(0, 200) ?? null,
      })),
      creations: teamCreations(state).map((change) => ({
        status: change.status,
        authority: change.authority ?? null,
        decision: state?.requestNetworkDecisions?.[change.id]?.authority
          ?.kind ?? null,
      })),
      messages: state?.messages.slice(-4).map((message) => ({
        role: message.role,
        text: message.text.slice(0, 400),
      })),
      writes: writes.map((write) => ({
        state: write.state,
        attempts: String(write.attempts),
        error: write.lastErrorJson?.slice(0, 400) ?? null,
      })),
      dossiers: (await host.storage.client.evolutionDossier.findMany({
        where: { ...host.storage.scope },
        select: { kind: true, status: true, payload: true },
        take: 16,
      })).map((row) => {
        const payload = JSON.parse(row.payload);
        return {
          kind: row.kind,
          status: row.status,
          blockers: JSON.stringify(
            payload.blockers ?? payload.issues ??
              null,
          ).slice(0, 600),
        };
      }),
      unavailableMembers: await host.stage.runtime
        .unavailableTeamMembers(request.record).catch((error) =>
          String(error).slice(0, 300)
        ),
      activeInputMessageId: state?.activeInputMessageId ?? null,
      changeDecisionContinuations: state?.changeDecisionContinuations ?? null,
      members,
      workerErrors: host.workerErrors.map((error) =>
        (error instanceof Error ? String(error) : JSON.stringify(error))
          .slice(0, 400)
      ),
    };
  }
  /** The person writes once the BO is idle; a conversation that moved
   * between the read and the write is read again, as a page reload does. */
  async function ask(request: Opened, text: string) {
    const caseId = request.record.caseId;
    await eventually(async () => {
      const state = await request.stores.state.load();
      if (!state || state.busy) return undefined;
      const view = await conversations.conversations(
        request.session.secret,
        caseId,
      );
      const owner = view.conversations.find((entry) =>
        entry.agentId === host.primaryOperatorId
      );
      assert(owner);
      try {
        await conversations.submitHuman(request.session.secret, {
          caseId,
          agentId: owner.agentId,
          expectedRevision: owner.revision,
          text,
        });
        return true;
      } catch (error) {
        if (
          error instanceof Error &&
          /conversation a changé|AGENT_BUSY|réponse est déjà en cours/
            .test(`${error.message} ${(error as { code?: string }).code}`)
        ) return undefined;
        throw error;
      }
    }, {
      label: `person writes to the BO in ${caseId}`,
      timeoutMs: 60_000,
      pollMs: 250,
    });
  }
  async function admittedTeam(request: Opened) {
    const binding = await host.stage.executionBindings.read(
      request.record,
    );
    return binding.admission.permissions.operatorIds;
  }
  async function admittedTeamAtSize(request: Opened, size: number) {
    // This row is only a cheap scheduling hint while publication is running.
    // A matching count still requires the complete verified binding below.
    assert(
      request.record.admissionId,
      "the Request has an execution admission",
    );
    const admission = await host.storage.client.spaceExecutionAdmission
      .findFirstOrThrow({
        where: {
          ...host.storage.scope,
          id: request.record.admissionId,
          openingId: request.record.id,
          executionSpaceId: request.record.executionSpaceId,
        },
        select: { permissionsJson: true },
      });
    const permissions = JSON.parse(admission.permissionsJson);
    assert(Array.isArray(permissions.operatorIds));
    if (permissions.operatorIds.length !== size) return undefined;
    const ids = await admittedTeam(request);
    return ids.length === size ? ids : undefined;
  }
  async function create(request: Opened, name: string, size: number) {
    team.armCreation(request.record.caseId, name);
    await ask(request, `Create a teammate named ${name}.`);
    const created = await eventually(
      () => admittedTeamAtSize(request, size + 1),
      {
        label: `${name} admitted in ${request.record.caseId}`,
        timeoutMs: 120_000,
        diagnose: () => diagnose(request),
      },
    );
    // The BO reads the settled creation in its own thread before it
    // goes on (the team adoption continuation).
    const state = await eventually(async () => {
      const current = await request.stores.state.load();
      const outcome = current?.messages.findIndex((message) =>
        message.text.startsWith("Request team creation outcome") &&
        message.text.includes(name)
      ) ?? -1;
      return current && outcome >= 0 && !current.busy &&
          current.messages.slice(outcome + 1).some((message) =>
            message.role === "assistant"
          )
        ? current
        : undefined;
    }, {
      label: `BO resumed after ${name}`,
      timeoutMs: 60_000,
      diagnose: () =>
        diagnose(request),
    });
    const change = teamCreations(state).find((entry) => entry.name === name);
    assert.equal(change?.status, "approved");
    assert.equal(change?.authority, "builder", "self-approved by grant");
    assert(change?.authorityExercise?.creationDelegation);
    assert.equal(
      state?.requestNetworkDecisions?.[change!.id]?.authority?.kind,
      "creation-grant",
    );
    return { ids: created, change: change! };
  }

  return {
    host,
    team,
    mo,
    conversations,
    diagnose,
    ask,
    admittedTeam,
    admittedTeamAtSize,
    create,
  };
}

Deno.test({
  name:
    "BO asks for its creation grant, the person approves, and the BO creates in its branch",
  ignore: Deno.build.os !== "darwin" ||
    !postgresTestEnabled || !toolkitIntegrationEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const w = await branchTeamWitness(database);
      const { host, team, mo, conversations } = w;
      const main = host.workspace!.runtimeFor(host.primaryOperatorId)!.runtime;
      const a = await openInitialNormalRequest(host);
      const b = await openInitialNormalRequest(host);
      const sourceB = await host.sourceAdmission.admittedSource(b.record);
      const beforeB = await b.stores.state.load();
      assert(beforeB?.executionModel);
      assert.equal(
        beforeB.executionModel.identity.builderId,
        host.primaryOperatorId,
      );
      const caseId = a.record.caseId;
      const mainVersion = (await host.backend.repository.current()).version;
      const before = await a.stores.state.load();
      assert.equal(
        before?.executionModel?.operatorCreationPolicies?.length ?? 0,
        0,
      );
      assert.equal(
        main.snapshot.executionModel?.operatorCreationPolicies?.length ?? 0,
        0,
      );
      const requestedRights = {
        operatorCreation: {
          networkHosts: ["example.net"],
          maxChildren: 3,
          mode: "autonomous" as const,
        },
      };
      team.armCreationGrant(caseId);
      await w.ask(a, "Ask for the right to create sub-operators.");
      const pending = await eventually(async () => {
        const state = await a.stores.state.load();
        if (!state || state.busy) return undefined;
        const change = state.configuration?.changes.find((entry) =>
          entry.kind === "mandate-change" && entry.requestedRights &&
          "operatorCreation" in entry.requestedRights
        );
        return change?.status === "pending" ? { state, change } : undefined;
      }, {
        label: "recorded BO creation grant proposal",
        timeoutMs: 60_000,
        diagnose: () => w.diagnose(a),
      });
      assert.deepEqual(pending.change.requestedRights, requestedRights);
      assert.equal(pending.change.requestedBy, host.primaryOperatorId);
      assert.equal(pending.change.caseId, caseId);
      assert.equal(
        pending.state.requestNetworkDecisions?.[pending.change.id],
        undefined,
      );
      const notice = await eventually(
        async () =>
          (await host.mainAuthorityNotices(caseId)).find((entry) =>
            entry.changeId === pending.change.id
          ),
        { label: "creation grant card relayed to Main" },
      );
      assert.equal(notice.decisionAuthority, "human");
      assert.equal(notice.changeKind, "mandate-change");
      assert.deepEqual(notice.requestedRights, requestedRights);
      assert.equal(mo.turns(), 0, "a notice grants Main no decision authority");

      const result = await conversations.decideChange(a.session.secret, {
        caseId,
        agentId: host.primaryOperatorId,
        changeId: pending.change.id,
        expectedRevision: pending.state.revision,
        configurationRevision: pending.change.baseRevision,
        verdict: "approve",
      });
      assert.deepEqual(result, {
        status: "adopted",
        caseId,
        changeId: pending.change.id,
      });
      const adopted = await a.stores.state.load();
      const decided = adopted?.configuration?.changes.find((entry) =>
        entry.id === pending.change.id
      );
      assert.equal(decided?.status, "approved");
      assert.equal(decided?.authority, "human");
      const policy = adopted?.executionModel?.operatorCreationPolicies?.find((
        entry,
      ) => entry.holderNativeId === host.primaryOperatorId && entry.enabled);
      assert(
        policy,
        "the BO's adopted branch model carries its approved grant",
      );
      assert.deepEqual(policy.networkHosts, ["example.net"]);
      assert.equal(policy.maxChildren, 3);
      assert.equal(policy.maxDelegationDepth, 0);
      assert.equal(policy.mode, "autonomous");
      const created = await w.create(a, "Granted reviewer", 1);
      assert.equal(created.ids.length, 2);
      assert.equal(
        (await host.backend.repository.current()).version,
        mainVersion,
      );
      assert.equal(
        main.snapshot.executionModel?.operatorCreationPolicies?.length ?? 0,
        0,
      );
      assert.equal(
        (await host.sourceAdmission.admittedSource(b.record)).head.source
          .version,
        sourceB.head.source.version,
        "the grant and creation leave the other branch source unchanged",
      );
      const afterB = await b.stores.state.load();
      assert(afterB?.executionModel);
      assert.deepEqual(
        afterB.executionModel.version,
        beforeB.executionModel.version,
      );
      assert.equal(
        afterB.executionModel.operatorCreationPolicies?.some((entry) =>
          entry.enabled
        ) ?? false,
        false,
        "the same native BO identity acquires no creation grant in another branch",
      );
      assert.equal(mo.turns(), 0);
      assert.deepEqual(host.workerErrors, []);
    });
  },
});

Deno.test({
  name:
    "4.8e: an autonomous grant creates a durable member in the BO's branch only, reachable by its inbox; each branch counts its own",
  ignore: Deno.build.os !== "darwin" ||
    !postgresTestEnabled || !toolkitIntegrationEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const w = await branchTeamWitness(database, { maxChildren: 5 });
      const { host, team, mo, conversations, diagnose, ask, admittedTeam } = w;
      const main = host.workspace!.runtimeFor(host.primaryOperatorId)!.runtime;
      assert.equal(
        main.snapshot.executionModel?.operatorCreationPolicies?.length,
        1,
        "PRIMARY holds the seeded native creation grant",
      );
      const a = await openInitialNormalRequest(host);
      const b = await openInitialNormalRequest(host);
      const mainVersion = (await host.backend.repository.current()).version;
      const sourceB = await host.sourceAdmission.admittedSource(b.record);

      // BO@A creates under its mirrored autonomous grant: published and
      // adopted in A, the member admitted and listed, main and B unchanged.
      const sourceA = await host.sourceAdmission.admittedSource(a.record);
      const first = await w.create(a, "Helper one", 1);
      assert.equal(first.ids[0], host.primaryOperatorId);
      const publishedA = await host.sourceAdmission.admittedSource(a.record);
      assert.notEqual(
        publishedA.head.source.version,
        sourceA.head.source.version,
      );
      const listed = await eventually(async () => {
        const view = await conversations.conversations(
          a.session.secret,
          a.record.caseId,
        );
        return view.conversations.length === 2 ? view : undefined;
      }, { label: "team listed in A" });
      const member = listed.conversations.find((entry) =>
        entry.agentId === first.ids[1]
      );
      assert.equal(
        member?.operatorTeam?.parentOperatorId,
        host.primaryOperatorId,
      );
      assert.equal(member?.operatorTeam?.requestId, a.record.caseId);
      assert.equal(
        (await host.backend.repository.current()).version,
        mainVersion,
        "main never moves",
      );
      assert.equal(
        (await host.sourceAdmission.admittedSource(b.record)).head.source
          .version,
        sourceB.head.source.version,
        "another branch never moves",
      );
      assert.deepEqual(await admittedTeam(b), [host.primaryOperatorId]);

      // Reachable by inbox: the BO contributes to its member, which runs the
      // work in its own runtime; the BO receives the correlated completion.
      const helperOneInstruction = "Ask Helper one for the first passage.";
      team.armContribution(a.record.caseId, "Helper one", helperOneInstruction);
      await ask(a, helperOneInstruction);
      const helperOne = first.ids[1];
      await eventually(async () => {
        const memberState = await host.storage.readCaseRuntimeState(
          a.record.executionSpaceId,
          a.record.caseId,
          helperOne,
        );
        const state = await a.stores.state.load();
        return memberState?.messages.some((message) =>
            message.text === "Extract the first passage."
          ) &&
            state?.messages.some((message) =>
              message.text.startsWith("Correlated contribution completion") &&
              message.text.includes('"status":"completed"') &&
              message.text.includes(helperOne)
            )
          ? true
          : undefined;
      }, {
        label: "member reached through its inbox",
        timeoutMs: 60_000,
        diagnose: async () => {
          const member = await host.storage.readCaseRuntimeState(
            a.record.executionSpaceId,
            a.record.caseId,
            helperOne,
          );
          return {
            ...await diagnose(a),
            member: {
              error: member?.error ?? null,
              events: member?.events.slice(-6).map((event) =>
                `${event.kind}: ${event.label?.slice(0, 300)}`
              ),
              messages: member?.messages.slice(-4).map((message) =>
                `${message.role}: ${message.text.slice(0, 200)}`
              ),
            },
            seen: team.seen.map((entry) => entry.operator),
          };
        },
      });
      // The member decides its work with its own provider turn.
      assert(
        team.seen.some((entry) => entry.operator === "Helper one"),
        "Helper one called its own provider",
      );

      // B counts only its own team: its BO creates in B; A keeps its own.
      await w.create(b, "Helper of B", 1);
      assert.equal((await admittedTeam(a)).length, 2);
      assert.equal(
        (await host.backend.repository.current()).version,
        mainVersion,
      );
      assert.equal(mo.turns(), 0, "an autonomous creation wakes no MO");
      assert.deepEqual(host.workerErrors, []);
    });
  },
});

Deno.test({
  name:
    "4.8e: the bound of three counts the whole branch team; the fourth creation is refused and nothing is written",
  ignore: Deno.build.os !== "darwin" ||
    !postgresTestEnabled || !toolkitIntegrationEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      // A wider native bound than the branch: the whole team caps at 3.
      const w = await branchTeamWitness(database, { maxChildren: 5 });
      const { host, team, diagnose, ask, admittedTeam } = w;
      const a = await openInitialNormalRequest(host);
      await w.create(a, "Helper one", 1);
      await w.create(a, "Helper two", 2);
      await w.create(a, "Helper three", 3);
      const beforeFourth = await host.sourceAdmission.admittedSource(a.record);
      team.armCreation(a.record.caseId, "Helper four");
      await ask(a, "Create a teammate named Helper four.");
      const refusal = await eventually(async () => {
        const state = await a.stores.state.load();
        if (!state || state.busy) return undefined;
        // The creation approvability check refuses it before any record,
        // as every creation outside its grant (see the 4.8e log).
        return state.messages.findLast((message) =>
          message.role === "tool" &&
          message.text.includes('"code":"PROPOSAL_NOT_AUTHORIZED"') &&
          message.text.includes("remaining capacity")
        );
      }, {
        label: "fourth creation refused",
        timeoutMs: 60_000,
        diagnose: () => diagnose(a),
      });
      assert(refusal);
      const afterFourth = await a.stores.state.load();
      assert(
        !teamCreations(afterFourth).some((change) =>
          change.name === "Helper four"
        ),
        "nothing is recorded for a refused creation",
      );
      assert.equal(
        (await host.sourceAdmission.admittedSource(a.record)).head.source
          .version,
        beforeFourth.head.source.version,
        "nothing is written",
      );
      assert.equal((await admittedTeam(a)).length, 4);
      assert.deepEqual(host.workerErrors, []);
    });
  },
});

Deno.test({
  name:
    "4.8e: under a per-creation grant the person decides each creation on the Case card; never self-approved",
  ignore: Deno.build.os !== "darwin" ||
    !postgresTestEnabled || !toolkitIntegrationEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const w = await branchTeamWitness(database, {
        maxChildren: 3,
        mode: "per-creation",
      });
      const { host, team, mo, conversations } = w;
      const a = await openInitialNormalRequest(host);
      const caseId = a.record.caseId;
      const mainVersion = (await host.backend.repository.current()).version;
      await eventually(async () => {
        const state = await a.stores.state.load();
        return state && !state.busy ? true : undefined;
      }, { label: "BO idle", timeoutMs: 60_000 });
      const view = await conversations.conversations(a.session.secret, caseId);
      const owner = view.conversations.find((entry) =>
        entry.agentId === host.primaryOperatorId
      )!;
      team.armCreation(caseId, "Reviewer one");
      await conversations.submitHuman(a.session.secret, {
        caseId,
        agentId: owner.agentId,
        expectedRevision: owner.revision,
        text: "Create a teammate named Reviewer one.",
      });
      const pending = await eventually(async () => {
        const state = await a.stores.state.load();
        if (!state || state.busy) return undefined;
        const change = teamCreations(state).find((entry) =>
          entry.name === "Reviewer one"
        );
        return change?.status === "pending" ? { state, change } : undefined;
      }, { label: "pending per-creation proposal", timeoutMs: 60_000 });
      // Never self-approved: the BO's turn settled and nothing was decided.
      assert.equal(
        pending.state.requestNetworkDecisions?.[pending.change.id],
        undefined,
      );
      const [notice] = await eventually(async () => {
        const notices = (await host.mainAuthorityNotices(caseId)).filter((
          entry,
        ) => entry.changeId === pending.change.id);
        return notices.length ? notices : undefined;
      }, { label: "relayed notice to the MO" });
      assert.equal(notice.decisionAuthority, "human");
      assert.equal(notice.changeKind, "operator-creation");
      assert.equal(mo.turns(), 0, "a human decision wakes no MO");

      // The person approves on the Case card.
      const result = await conversations.decideChange(a.session.secret, {
        caseId,
        agentId: host.primaryOperatorId,
        changeId: pending.change.id,
        expectedRevision: pending.state.revision,
        configurationRevision: pending.change.baseRevision,
        verdict: "approve",
      });
      assert.deepEqual(result, {
        status: "adopted",
        caseId,
        changeId: pending.change.id,
      });
      const decided = teamCreations(await a.stores.state.load()).find((
        entry,
      ) => entry.id === pending.change.id)!;
      assert.equal(decided.status, "approved");
      assert.equal(decided.authority, "human");
      assert.equal(decided.authorityExercise?.creationDelegation, undefined);
      const binding = await host.stage.executionBindings.read(a.record);
      assert.equal(binding.admission.permissions.operatorIds.length, 2);
      assert.equal(
        (await host.backend.repository.current()).version,
        mainVersion,
        "main never moves",
      );
      assert.deepEqual(host.workerErrors, []);
    });
  },
});

Deno.test({
  name:
    "4.8e: a member's uncovered network proposal reaches the person with a relayed notice",
  ignore: Deno.build.os !== "darwin" ||
    !postgresTestEnabled || !toolkitIntegrationEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const w = await branchTeamWitness(database, { maxChildren: 5 });
      const a = await openInitialNormalRequest(w.host);
      const member = (await w.create(a, "Network reader", 1)).ids[1];
      const turnsBefore = w.mo.turns();
      w.team.armProposal(a.record.caseId, "Network reader");
      const networkReaderInstruction = "Ask Network reader to read the page.";
      w.team.armContribution(
        a.record.caseId,
        "Network reader",
        networkReaderInstruction,
      );
      await w.ask(a, networkReaderInstruction);
      const change = await eventually(async () => {
        const state = await w.host.storage.readCaseRuntimeState(
          a.record.executionSpaceId,
          a.record.caseId,
          member,
        );
        return state?.configuration?.changes.find((entry) =>
          entry.status === "pending" && entry.requestedRights &&
          "addNetworkHosts" in entry.requestedRights
        );
      }, {
        label: "member network proposal",
        timeoutMs: 90_000,
        diagnose: () => w.diagnose(a),
      });
      assert.equal(change.requestedBy, member);
      const notice = await eventually(async () => {
        const entries = (await w.host.mainAuthorityNotices(a.record.caseId))
          .filter((entry) => entry.changeId === change.id);
        return entries.length === 1 ? entries[0] : undefined;
      }, { label: "member proposal relayed to Main", timeoutMs: 60_000 });
      assert.equal(notice.decisionAuthority, "human");
      assert.equal(notice.route?.status, "human-decision");
      assert.equal(notice.route?.requester.operatorId, member);
      assert.equal(
        w.mo.turns(),
        turnsBefore,
        "a human decision does not wake Main",
      );
      assert.deepEqual(w.host.workerErrors, []);
    });
  },
});

Deno.test({
  name:
    "4.8e: a Main order reaches the selected member and records one parent notice on replay",
  ignore: Deno.build.os !== "darwin" ||
    !postgresTestEnabled || !toolkitIntegrationEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const w = await branchTeamWitness(database, { maxChildren: 5 });
      const a = await openInitialNormalRequest(w.host);
      const member = (await w.create(a, "Ordered reader", 1)).ids[1];
      const main =
        w.host.workspace!.runtimeFor(w.host.primaryOperatorId)!.runtime;
      const send = async () => {
        await main.idle();
        w.mo.armOrder({ caseId: a.record.caseId, operatorId: member });
        await main.submit("Order the selected member.");
      };
      await send();
      await eventually(async () => {
        const state = await w.host.storage.readCaseRuntimeState(
          a.record.executionSpaceId,
          a.record.caseId,
          member,
        );
        return state?.messages.some((message) =>
            message.text === "List the page headings."
          )
          ? true
          : undefined;
      }, {
        label: "Main order reaches member",
        timeoutMs: 90_000,
        diagnose: () => w.diagnose(a),
      });
      const notices = async () =>
        (await a.stores.state.load())?.messages.filter(
          (message) =>
            message.operatorNotice?.kind === "subordinate-order" &&
            message.operatorNotice.subordinate === member,
        ) ?? [];
      const [notice] = await eventually(async () => {
        const found = await notices();
        return found.length === 1 ? found : undefined;
      }, { label: "parent observes order", timeoutMs: 60_000 });
      assert.equal(notice.operatorNotice?.kind, "subordinate-order");
      assert.equal(
        notice.noticeWake,
        undefined,
        "notice does not wake the parent",
      );
      await send();
      const outcomes = await eventually(() => {
        const outcomes = main.snapshot.messages.filter((message) =>
          message.role === "tool" &&
          message.text.startsWith("Request continuation result;")
        );
        return outcomes.length >= 2 ? outcomes : undefined;
      }, { label: "replayed order completes", timeoutMs: 60_000 });
      assert(
        outcomes.every((message) =>
          !message.text.includes('"status":"refused"')
        ),
      );
      assert.deepEqual((await notices()).map((message) => message.id), [
        notice.id,
      ]);
      assert.deepEqual(w.host.workerErrors, []);
    });
  },
});

Deno.test({
  name:
    "4.8e: only an explicit grant lets a member create within the whole-team bound",
  ignore: Deno.build.os !== "darwin" || !postgresTestEnabled ||
    !toolkitIntegrationEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const w = await branchTeamWitness(database, {
        maxChildren: 5,
        maxDelegationDepth: 1,
      });
      const a = await openInitialNormalRequest(w.host);
      const caseId = a.record.caseId;
      w.team.armCreation(caseId, "Granted parent", PRIMARY_NAME, true);
      await w.ask(a, "Create Granted parent.");
      const grantedMember = await eventually(async () => {
        const ids = await w.admittedTeamAtSize(a, 2);
        if (!ids?.[1]) return undefined;
        const state = await w.host.storage.readCaseRuntimeState(
          a.record.executionSpaceId,
          caseId,
          ids[1],
        );
        return state?.executionModel
          ? { id: ids[1], identity: state.executionModel.identity }
          : undefined;
      }, {
        label: "granted member admitted",
        timeoutMs: 120_000,
        diagnose: () => w.diagnose(a),
      });
      const granted = grantedMember.id;
      const requester = {
        projectId: grantedMember.identity.projectId,
        systemId: grantedMember.identity.systemId,
        executionSpaceId: a.record.executionSpaceId,
        operatorId: granted,
      };
      const retained = await w.host.stage.executionBindings.read(
        a.record,
        requester,
      );
      const pinR = structuredClone(retained.pin);
      assert.equal(
        retained.state.executionModel?.version.digest,
        pinR.modelDigest,
      );
      await w.create(a, "Ungrantable parent", 2);
      const sourceA = await w.host.sourceAdmission.admittedSource(a.record);
      const afterSibling = await w.host.stage.executionBindings.read(
        a.record,
        requester,
      );
      assert.notEqual(sourceA.head.source.version, pinR.source.version);
      assert.deepEqual(afterSibling.pin, pinR);
      assert.equal(
        afterSibling.state.executionModel?.version.digest,
        pinR.modelDigest,
      );
      const ungranted = (await w.admittedTeam(a)).find((operatorId) =>
        operatorId !== w.host.primaryOperatorId && operatorId !== granted
      );
      assert(
        ungranted,
        "the newly admitted member is distinct from its BO and Granted parent",
      );
      w.team.armCreation(caseId, "Refused grandchild", "Ungrantable parent");
      const ungrantedInstruction =
        "Ask Ungrantable parent to create a teammate.";
      w.team.armContribution(
        caseId,
        "Ungrantable parent",
        ungrantedInstruction,
      );
      await w.ask(a, ungrantedInstruction);
      const refused = await eventually(async () => {
        const state = await w.host.storage.readCaseRuntimeState(
          a.record.executionSpaceId,
          caseId,
          ungranted,
        );
        const refusalIndex = state?.messages.findIndex((message) =>
          message.role === "tool" &&
          message.text.includes('"code":"PROPOSAL_NOT_AUTHORIZED"')
        ) ?? -1;
        if (!state || state.busy || refusalIndex < 0) {
          return undefined;
        }
        const input = state.messages.find((message) =>
          message.id === state.activeInputMessageId
        );
        const work = input && workReceipt(input);
        const completion = work && recordedWorkCompletion(state, work);
        return completion ? { state, completion, refusalIndex } : undefined;
      }, {
        label: "member without grant refused",
        timeoutMs: 90_000,
        diagnose: () =>
          w.diagnose(a),
      });
      assert.equal(
        refused.state.error,
        undefined,
        "the refusing member completes without runtime error",
      );
      assert.equal(refused.completion.work.status, "completed");
      assert.equal(refused.completion.work.caseId, caseId);
      const refusalReply = refused.state.messages.findIndex((
        message,
        index,
      ) =>
        index > refused.refusalIndex &&
        message.role === "assistant" &&
        message.text === "Observed by Ungrantable parent"
      );
      assert(
        refusalReply > refused.refusalIndex &&
          refused.completion.work.messageRanges?.some((range) =>
            range.start <= refusalReply && refusalReply < range.end
          ),
        "the member explains the refusal in its completed original contribution",
      );
      assert.equal((await w.admittedTeam(a)).length, 3);
      w.team.armCreation(caseId, "Granted grandchild", "Granted parent");
      const grantedInstruction = "Ask Granted parent to create a teammate.";
      w.team.armContribution(caseId, "Granted parent", grantedInstruction);
      await w.ask(a, grantedInstruction);
      await eventually(
        async () => await w.admittedTeamAtSize(a, 4) ? true : undefined,
        {
          label: "granted member's child admitted",
          timeoutMs: 120_000,
          diagnose: () => w.diagnose(a),
        },
      );
      const state = await w.host.storage.readCaseRuntimeState(
        a.record.executionSpaceId,
        caseId,
        granted,
      );
      const child = teamCreations(state).find((entry) =>
        entry.name === "Granted grandchild"
      );
      assert.equal(child?.status, "approved");
      assert.equal(child?.authority, "builder");
      assert(child?.authorityExercise?.creationDelegation);
      const rows = await w.host.storage.client.evolutionDossier.findMany({
        where: {
          ...w.host.storage.scope,
          executionSpaceId: a.record.executionSpaceId,
          kind: "request-owner-adoption-v2",
        },
        select: { payload: true },
      });
      const dossiers = await Promise.all(
        rows.map((row) =>
          parseRequestOwnerAdoptionDossier(JSON.parse(row.payload))
        ),
      );
      const matches = dossiers.filter((dossier) =>
        dossier.status === "adopted" &&
        dossier.intent.target.operatorId === granted &&
        dossier.intent.team?.changeId === child.id
      );
      assert.equal(
        matches.length,
        1,
        "the creator has one exact adoption dossier",
      );
      const intent = matches[0].intent;
      assert.deepEqual(intent.previous.pin, pinR);
      const publicationBase = intent.team?.publicationBase;
      assert(publicationBase);
      assert.equal(
        publicationBase.version.repositoryVersion,
        sourceA.head.source.version,
      );
      assert.equal(publicationBase.version.digest, pinR.modelDigest);
      assert.deepEqual(
        publicationBase.identity,
        retained.state.executionModel?.identity,
      );
      assert.notEqual(
        intent.candidate.source.version,
        sourceA.head.source.version,
      );
      assert.equal(intent.candidate.source.version, child.publishedCommit);
      w.team.armCreation(caseId, "Over bound", "Granted parent");
      const overBoundInstruction = "Ask Granted parent for another teammate.";
      w.team.armContribution(caseId, "Granted parent", overBoundInstruction);
      await w.ask(a, overBoundInstruction);
      await eventually(async () => {
        const current = await w.host.storage.readCaseRuntimeState(
          a.record.executionSpaceId,
          caseId,
          granted,
        );
        return current?.messages.some((m) =>
            m.role === "tool" &&
            m.text.includes('"code":"PROPOSAL_NOT_AUTHORIZED"') &&
            m.text.includes("remaining capacity")
          )
          ? true
          : undefined;
      }, {
        label: "whole-team bound enforced on member",
        timeoutMs: 90_000,
        diagnose: () => w.diagnose(a),
      });
      assert.equal((await w.admittedTeam(a)).length, 4);
      assert.deepEqual(w.host.workerErrors, []);
    });
  },
});

Deno.test({
  name:
    "4.8e: Main decides a covered member network proposal and only that branch adopts it",
  ignore: Deno.build.os !== "darwin" || !postgresTestEnabled ||
    !toolkitIntegrationEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const w = await branchTeamWitness(database, { maxChildren: 5 });
      const a = await openInitialNormalRequest(w.host);
      const b = await openInitialNormalRequest(w.host);
      const member = (await w.create(a, "Covered reader", 1)).ids[1];
      const main =
        w.host.workspace!.runtimeFor(w.host.primaryOperatorId)!.runtime;
      await main.idle();
      w.mo.armGrant({
        caseId: a.record.caseId,
        operatorId: member,
        inputText: "Prepare authority over the member.",
      });
      await main.submit("Prepare authority over the member.");
      const grant = await eventually(
        () =>
          main.snapshot.configuration?.changes.find((change) =>
            change.status === "pending" && !!change.requestedRights &&
            "operatorAuthority" in change.requestedRights
          ),
        {
          label: "Main authority proposal",
          timeoutMs: 60_000,
          diagnose: () => {
            const state = main.snapshot;
            return {
              busy: state.busy,
              error: state.error ?? null,
              messages: state.messages.slice(-3).map(({ role, text }) => ({
                role,
                text: text.slice(0, 400),
              })),
              changes: state.configuration?.changes.slice(-3).map((
                { kind, status },
              ) => ({
                kind,
                status,
              })),
            };
          },
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
            ) => policy.id === "member-network"
            )
            ? true
            : undefined,
        { label: "Main authority admitted", timeoutMs: 90_000 },
      );
      const mainVersion = (await w.host.backend.repository.current()).version;
      const beforeA = await w.host.sourceAdmission.admittedSource(a.record);
      const beforeB = await w.host.sourceAdmission.admittedSource(b.record);
      w.mo.armCoveredDecision();
      w.team.armProposal(a.record.caseId, "Covered reader");
      const coveredReaderInstruction = "Ask Covered reader to read the page.";
      w.team.armContribution(
        a.record.caseId,
        "Covered reader",
        coveredReaderInstruction,
      );
      await w.ask(a, coveredReaderInstruction);
      const changed = await eventually(async () => {
        const state = await w.host.storage.readCaseRuntimeState(
          a.record.executionSpaceId,
          a.record.caseId,
          member,
        );
        return state?.configuration?.changes.find((entry) =>
          entry.status === "approved" && entry.requestedRights &&
          "addNetworkHosts" in entry.requestedRights
        );
      }, {
        label: "covered member decision",
        timeoutMs: 120_000,
        diagnose: () => w.diagnose(a),
      });
      assert.equal(changed.requestedBy, member);
      assert.equal(changed.authority, "builder");
      assert(changed.authorityExercise?.delegation);
      const notice = await eventually(
        async () =>
          (await w.host.mainAuthorityNotices(a.record.caseId)).find((entry) =>
            entry.changeId === changed.id
          ),
        { label: "covered member notice" },
      );
      assert.equal(notice.route?.status, "actor-decision");
      assert.equal(notice.route?.requester.operatorId, member);
      await eventually(async () => {
        const state = await w.host.storage.readCaseRuntimeState(
          a.record.executionSpaceId,
          a.record.caseId,
          member,
        );
        return state?.executionModel?.configuration.network?.allowedHosts
            .includes("example.org")
          ? true
          : undefined;
      }, {
        label: "member adopts its network right",
        timeoutMs: 120_000,
        diagnose: () => w.diagnose(a),
      });
      await eventually(async () => {
        const state = await w.host.storage.readCaseRuntimeState(
          a.record.executionSpaceId,
          a.record.caseId,
          member,
        );
        return state?.changeDecisionContinuations?.[changed.id] === "resumed"
          ? true
          : undefined;
      }, {
        label: "member resumes its own adopted continuation",
        timeoutMs: 120_000,
        diagnose: () => w.diagnose(a),
      });
      assert.notEqual(
        (await w.host.sourceAdmission.admittedSource(a.record)).head.source
          .version,
        beforeA.head.source.version,
      );
      assert.equal(
        (await w.host.sourceAdmission.admittedSource(b.record)).head.source
          .version,
        beforeB.head.source.version,
      );
      assert.equal(
        (await w.host.backend.repository.current()).version,
        mainVersion,
      );
      const owner = await a.stores.state.load();
      assert(
        !owner?.executionModel?.configuration.network?.allowedHosts.includes(
          "example.org",
        ),
      );
      const memberModel = (await w.host.storage.readCaseRuntimeState(
        a.record.executionSpaceId,
        a.record.caseId,
        member,
      ))!.executionModel!;
      const executed = w.host.stage.executedModels!;
      const binding = await w.host.stage.executionBindings.read(a.record);
      const models = await executed.currentModels(a.record, binding);
      assert.equal(models.length, 2);
      for (const expected of [owner!.executionModel!, memberModel]) {
        assert.deepEqual(
          models.find((model) =>
            model.identity.builderId === expected.identity.builderId
          ),
          expected,
        );
      }
      const scope = scopedOperator({
        ...w.host.storage.scope,
        executionSpaceId: a.record.executionSpaceId,
      }, member);
      const version = {
        digest: memberModel.version.digest,
        repositoryVersion: memberModel.version.repositoryVersion!,
      };
      assert.deepEqual(await executed.historical(scope, version), memberModel);
      await assert.rejects(
        () =>
          executed.historical({ ...scope, operatorId: "unadmitted" }, version),
        { code: "UNAVAILABLE" },
      );
      assert.deepEqual(w.host.workerErrors, []);
    });
  },
});
