import { ACCEPTED_CASE_CLOSURE } from "../support/case-closure.ts";
/** Real compiler/Git/queued writer/PostgreSQL lifecycle/runtime. Zero real provider calls. */
import assert from "node:assert/strict";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import {
  nativeEvolutionMain,
  nativeEvolutionPeer,
  openNativeEvolutionFixture,
  privateEvolutionFlow,
} from "../fixtures/native-evolution.ts";
import { editRequest, nativeId } from "../fixtures/model-edit-mandate.ts";
import type { ModelEdit } from "../../src/domain/model/editing/tooling.ts";
import type { EvolutionCategory } from "../../src/domain/model/evolution/policy.ts";
import type { EvolutionDossier } from "../../src/application/model/evolution/ports.ts";
import {
  sourceEvolutionCompilation,
  validateSourceExecutable,
} from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { NativeEvolutionSourceAssessment } from "../../src/application/model/evolution/assessment.ts";
import { NativeEvolutionAuthority } from "../../src/application/model/evolution/authority.ts";
import { buildEvolutionPolicyEdits } from "../support/evolution-policy/writer.ts";
import { budgetState } from "../../src/domain/work/policies/budget.ts";
import { sourceSnapshot } from "../../src/domain/model/projections/source-facts.ts";
import { selectedFlowRoot } from "../../src/adapters/out/sysml-toolkit/compilation-policies/work/operator-flow.ts";
import { caseMessages } from "../../src/application/work/cases/runtime.ts";
import { readDecisionContextEvidence } from "../../src/application/work/context/separation.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import type { ChatContext, Message } from "../../src/domain/work/dialogue.ts";

type Fixture = Awaited<ReturnType<typeof openNativeEvolutionFixture>>;

/** Compare the bytes actually observed before deciding with their admitted Git
 * revision. The independent design working set may legitimately follow HEAD. */
async function assertAdmittedSourceObserved(f: Fixture, context: ChatContext) {
  const pin = context.admittedModelVersion;
  assert(
    pin?.repositoryVersion,
    "The decision must retain its exact admitted source pin",
  );
  const observed = context.messages.findLast((message) => {
    if (message.observation?.kind !== "model-context") return false;
    const value = message.observation.value as {
      request?: { operation?: string; path?: string; version?: string };
      modelVersion?: { digest?: string; repositoryVersion?: string };
    };
    return value.request?.operation === "read_source" &&
      value.request.path === "conversation.sysml" &&
      value.request.version === pin.repositoryVersion &&
      value.modelVersion?.digest === pin.digest &&
      value.modelVersion.repositoryVersion === pin.repositoryVersion;
  });
  assert(
    observed,
    "The declared read must expose its exact source observation to the next decision",
  );
  const evidence = observed.observation!.value as {
    actionId: string;
    modelVersion: { digest: string; repositoryVersion: string };
    result: {
      operation: string;
      version: string;
      sourceDigest: string;
      path: string;
      sha256: string;
      content: string;
    };
  };
  assert(
    evidence.actionId,
    "The observation must identify the actual native read action",
  );
  assert.equal(observed.execution?.actionId, evidence.actionId);
  assert.equal(observed.execution?.digest, pin.digest);
  assert.equal(observed.execution?.repositoryVersion, pin.repositoryVersion);
  assert.deepEqual(evidence.modelVersion, pin);
  const revision = await f.backend.repository.at(pin.repositoryVersion);
  const expected = revision.sources["conversation.sysml"];
  assert.equal(typeof expected, "string");
  assert.equal(evidence.result.operation, "read_source");
  assert.equal(evidence.result.version, pin.repositoryVersion);
  assert.equal(evidence.result.sourceDigest, revision.sourceDigest);
  assert.equal(evidence.result.path, "conversation.sysml");
  assert.equal(
    evidence.result.sha256,
    revision.sourceHashes["conversation.sysml"],
  );
  assert.equal(evidence.result.content, expected);
  assert.equal("loaded" in evidence.result, false);
}

async function prepared(
  f: Fixture,
  edits: ModelEdit[],
  category: EvolutionCategory[],
  caseId?: string,
) {
  const head = await f.backend.repository.current();
  const count =
    (await f.evolutionStore.listRecent(f.backend.project.id, 256)).length;
  await f.turn(
    [
      {
        kind: "consult_model",
        text: "Read the exact admitted source before editing",
        inputJson: JSON.stringify({
          operation: "read_source",
          path: "configuration.sysml",
          version: head.version,
        }),
      },
      {
        kind: "prepare_operator_evolution",
        text: "Prepare a bounded typed revision",
        reason: "Qualify the actual native evolution lifecycle",
        editJson: JSON.stringify({ edits }),
      },
    ],
    "Prepare the exact native replacement",
    caseId ? { caseId } : {},
  );
  const dossiers = await f.evolutionStore.listRecent(f.backend.project.id, 256);
  assert.equal(
    dossiers.length,
    count + 1,
    "The real preparation command must create a durable dossier",
  );
  const d = dossiers.find((d) =>
    d.proposal.baseVersion === head.version && d.status === "prepared"
  )!;
  assert(d, "Expected prepared dossier for the exact current source base");
  assert.deepEqual(d.proposal.categories, [...category].sort());
  assert.equal(
    (await f.backend.repository.current()).version,
    head.version,
    "Preparation cannot publish",
  );
  assert.equal(
    d.origin.operatorId,
    f.primary.snapshot.executionModel!.identity.builderId,
  );
  if (caseId) assert.equal(d.origin.requestId, caseId);
  else {assert(
      d.origin.designerScopeId,
      "Origin comes from the actual designer invocation",
    );}
  assert.equal(d.accounting.agentInvocations, 0);
  assert.equal(
    await f.evolutionStore.targetOwner(
      f.backend.project.id,
      d.origin.operatorId,
    ),
    null,
  );
  return d;
}

async function accept(f: Fixture, d: EvolutionDossier) {
  await f.turn([{
    kind: "decide_operator_evolution",
    text: "Accept this exact revision",
    dossierId: d.id,
    decision: "accept",
  }]);
  const accepted = (await f.evolutionStore.get(d.id))!;
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.preparation.act, "prepare");
  assert.equal(accepted.acceptance!.act, "accept");
  assert.equal(accepted.acceptance!.proposalDigest, d.proposal.digest);
  assert.equal(
    (await f.backend.repository.current()).version,
    d.proposal.baseVersion,
    "Acceptance alone cannot publish",
  );
  return accepted;
}

async function awaitAdoption(f: Fixture, id: string) {
  await f.captureEvidence("before-finalize");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const d = await Promise.race([
      // Join the actual already-running finalizer instead of sampling its
      // intermediate published state against an arbitrary 60-second poll.
      f.workspace.evolution!.finalize(id),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            "Native qualification diagnostic deadline (300s); not a product refusal",
          );
          error.name = "NativeEvolutionDiagnosticTimeout";
          reject(error);
        }, 300_000);
      }),
    ]);
    await f.captureEvidence("after-finalize");
    assert.equal(d.status, "adopted", JSON.stringify(d.blockers));
    return d;
  } catch (error) {
    f.preserveEvidence();
    await f.captureEvidence("failed-finalize");
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function assertPublication(f: Fixture, d: EvolutionDossier) {
  assert(d.publication);
  const publication = await f.backend.repository.findPublicationByCommand!(
    d.proposal.id,
  );
  assert(
    publication,
    "Actual Git publication must anchor the exact queued command",
  );
  assert.equal(publication.commandDigest, d.publication.commandDigest);
  assert.equal(publication.revision.version, d.publication.version);
  const queued = await f.backend.queue.get(f.backend.project.id, d.proposal.id);
  assert.equal(queued?.state, "published");
  assert.equal(queued?.commandDigest, d.publication.commandDigest);
  assert.equal(
    f.primary.snapshot.executionModel!.version.digest,
    d.proposal.targets[0]!.candidateDigest,
  );
  assert.equal(
    f.primary.snapshot.executionModel!.version.repositoryVersion,
    d.publication.version,
  );
  const dividers = f.primary.snapshot.events.filter((event) =>
    event.effectiveModelUpdate?.dossierId === d.id
  );
  assert.equal(dividers.length, 1);
  assert.equal(
    dividers[0]!.effectiveModelUpdate!.to.repositoryVersion,
    d.publication.version,
  );
  assert.equal(d.adoptions.length, 1);
  assert.equal(d.accounting.agentInvocations, 0);
}

/** Inspect the actual projected provider context against its retained journal. */
async function assertEvolvedContextSelection(
  context: ChatContext,
  before: readonly Message[],
  journal: readonly Message[],
  currentText: string,
): Promise<void> {
  const evidence = context.contextEvidence;
  assert(evidence);
  assert.equal(evidence.policy.recentMessages, 8);
  assert(
    before.length >= 8,
    "Real preceding turns must provide sufficient history",
  );
  assert(
    evidence.journalMessageCount > 8,
    "The actual decision must have omitted history",
  );
  assert.equal(evidence.references.length, evidence.journalMessageCount);
  assert.equal(evidence.projectedMessageCount, context.messages.length);
  const ids = evidence.references.map((reference) => reference.messageId);
  assert.equal(new Set(ids).size, ids.length);
  const selectedIds = context.messages.map((message) => message.id);
  const selected = new Set(selectedIds);
  assert.equal(selected.size, selectedIds.length);
  // The current request is preserved independently of the ordinary recent window.
  const currentId = evidence.currentRequestMessageId;
  assert(currentId);
  const current = journal.find((message) => message.id === currentId);
  assert(current);
  assert.equal(current.role, "user");
  assert.equal(current.text, currentText);
  assert(selected.has(currentId));
  assert.equal(
    context.messages.find((message) => message.id === currentId)?.text,
    currentText,
  );
  for (const id of ids.slice(-8)) {
    assert(selected.has(id), `Recent message ${id} missing`);
  }
  const omitted = evidence.references.filter((reference) =>
    !selected.has(reference.messageId)
  );
  assert(
    omitted.length > 0,
    "Earlier journal entries must actually be omitted",
  );
  for (const reference of evidence.references) {
    assert.equal(
      reference.reasons.includes("history"),
      !selected.has(reference.messageId),
    );
    const recovered = await readDecisionContextEvidence(journal, reference);
    assert.equal(await executionDigest(recovered), reference.messageDigest);
    const retained = journal.find((message) =>
      message.id === reference.messageId
    );
    assert(retained);
    assert.equal(JSON.stringify(recovered), JSON.stringify(retained));
  }
  for (const previous of before) {
    const retained = journal.find((message) => message.id === previous.id);
    assert(
      retained,
      `Historical message ${previous.id} must remain in the journal`,
    );
    assert.equal(JSON.stringify(retained), JSON.stringify(previous));
    assert.equal(
      await executionDigest(retained),
      await executionDigest(previous),
    );
  }
}

Deno.test({
  name:
    "native evolution commands publish and execute every non-flow category without resetting Peer, memory or budget",
  ignore: !toolkitIntegrationEnabled,
  async fn(t) {
    const f = await openNativeEvolutionFixture();
    try {
      const peer = (await validateSourceExecutable(
        await f.backend.repository.current(),
        f.backend.projectId,
        nativeEvolutionPeer,
      )).identity.builderId;
      const peerDigest =
        f.workspace.runtimeFor(peer)!.runtime.snapshot.executionModel!.version
          .digest;
      const evolvedContractCriterion =
        "Return the actual nonempty HTML document title and readable text. NATIVE_EVOLVED_CONTRACT.";
      const settings: Array<
        {
          category: EvolutionCategory;
          field: string;
          expression: string;
          verify(): void;
        }
      > = [
        {
          category: "instructions",
          field: "operatorInstruction",
          expression: JSON.stringify(
            "Use only admitted facts. NATIVE_EVOLVED_INSTRUCTION.",
          ),
          verify() {
            assert(
              f.contexts.at(-1)!.operator!.instruction.includes(
                "NATIVE_EVOLVED_INSTRUCTION",
              ),
            );
          },
        },
        {
          category: "budgets",
          field: "invocationBudget::limit",
          expression: "150",
          verify() {
            assert.equal(
              f.primary.snapshot.executionModel!.workBudgetPolicy!.limit,
              150,
            );
            assert.equal(f.contexts.at(-1)!.workBudget!.limit, 150);
          },
        },
        {
          category: "context",
          field: "contextPolicy::recentMessages",
          expression: "8",
          verify() {
            assert.equal(
              f.contexts.at(-1)!.contextEvidence!.policy.recentMessages,
              8,
            );
          },
        },
        {
          category: "memory",
          field: "memoryPolicy::maxValidityMs",
          expression: "172800000",
          verify() {
            assert.equal(
              f.primary.snapshot.executionModel!.memoryPolicy!.maxValidityMs,
              172800000,
            );
          },
        },
        {
          category: "contracts",
          field: "catalog::readWebPageContract::acceptanceCriteria",
          expression: JSON.stringify(evolvedContractCriterion),
          verify() {
            const contract = f.contexts.at(-1)!.contracts!.find((contract) =>
              contract.kind === "read_web_page"
            );
            assert(contract);
            assert.deepEqual(contract.acceptanceCriteria, [
              evolvedContractCriterion,
            ]);
          },
        },
      ];
      for (const setting of settings) {
        const selectedCategory = Deno.env.get("ASSEMBLY_EVOLUTION_CATEGORY");
        if (selectedCategory && selectedCategory !== setting.category) continue;
        const passed = await t.step(setting.category, async () => {
          const head = await f.backend.repository.current();
          const d = await prepared(f, [{
            kind: "set-value",
            elementId: nativeId(
              head,
              `${nativeEvolutionMain}::${setting.field}`,
            ),
            expression: setting.expression,
          }], [setting.category]);
          const accepted = await accept(f, d);
          const binding = f.primary.snapshot.workBudgetBinding!;
          const previous = (await f.ledger.load(binding.scopeId))!;
          const previousView = budgetState(previous).view;
          let reservedAttempt: string | undefined;
          if (setting.category === "budgets") {
            reservedAttempt = "retained-native-reservation";
            await f.workBudget.reserve({
              scopeId: binding.scopeId,
              ownerId: previous.ownerId,
              policy: f.primary.snapshot.executionModel!.workBudgetPolicy,
              operation: "decide",
              attemptId: reservedAttempt,
              modelVersion: f.primary.snapshot.executionModel!.version,
            });
          }
          await f.turn([{
            kind: "adopt_operator_evolution",
            text: "Arm adoption and return from this contribution",
            dossierId: accepted.id,
          }]);
          const callsAfterCommand = f.contexts.length;
          if (reservedAttempt) {
            const armed = (await f.evolutionStore.get(d.id))!;
            assert.equal(
              armed.status,
              "armed",
              "A real outstanding reservation prevents publication",
            );
            const retained = (await f.ledger.load(binding.scopeId))!;
            assert.equal(budgetState(retained).view.reserved, 1);
            assert.equal(
              (await f.backend.repository.current()).version,
              d.proposal.baseVersion,
            );
            assert.deepEqual(
              retained.events.slice(0, previous.events.length),
              previous.events,
            );
            await f.workBudget.settle({
              scopeId: binding.scopeId,
              ownerId: previous.ownerId,
              attemptId: reservedAttempt,
              outcome: "returned",
            });
            await f.workspace.evolution!.finalize(d.id);
          }
          const adopted = await awaitAdoption(f, d.id);
          assert.equal(
            f.contexts.length,
            callsAfterCommand,
            "Finalization must make zero provider invocations",
          );
          await assertPublication(f, adopted);
          assert.equal(adopted.adoptionAuthorization!.act, "adopt");
          const after = (await f.ledger.load(binding.scopeId))!;
          assert.deepEqual(
            after.events.slice(0, previous.events.length),
            previous.events,
            "Cumulative budget events survive exact adoption",
          );
          assert(budgetState(after).view.consumed >= previousView.consumed);
          assert.equal(budgetState(after).view.reserved, 0);
          const previousJournal = setting.category === "context"
            ? structuredClone(caseMessages(f.primary.snapshot))
            : undefined;
          const nextInput =
            "Observe the admitted replacement on the next real decision";
          await f.turn([], nextInput);
          setting.verify();
          if (previousJournal) {
            await assertEvolvedContextSelection(
              f.contexts.at(-1)!,
              previousJournal,
              caseMessages(f.primary.snapshot),
              nextInput,
            );
          }
          assert.equal(
            f.workspace.runtimeFor(peer)!.runtime.snapshot.executionModel!
              .version.digest,
            peerDigest,
          );
          const providerCalls = f.contexts.length;
          await f.workspace.evolution!.finalize(d.id);
          assert.equal(f.contexts.length, providerCalls);
          await assertPublication(f, (await f.evolutionStore.get(d.id))!);
        });
        if (!passed) {
          f.preserveEvidence();
          break;
        }
      }
      await f.verifyRetainedMemory();
    } catch (error) {
      f.preserveEvidence();
      await f.captureEvidence("test-failure");
      throw error;
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  name:
    "native private flow uses its exact ActionDefinition and creator template while the existing Peer stays unchanged",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const f = await openNativeEvolutionFixture({
      consultingStartingContract: true,
    });
    try {
      const head = await f.backend.repository.current();
      const originalFlow =
        f.primary.snapshot.executionModel!.flows.conversation;
      const mainRoot = nativeId(head, `${nativeEvolutionMain}::conversation`);
      const templateRoot = nativeId(
        head,
        `${nativeEvolutionMain}::operatorFlowTemplate`,
      );
      const privateDefinition = nativeId(head, privateEvolutionFlow);
      const flowGrants = f.primary.snapshot.executionModel!.evolutionPolicy!
        .grants
        .filter((grant) => grant.category === "flow");
      assert.equal(flowGrants.length, 3);
      for (const grant of flowGrants) {
        assert.equal(
          grant.targetNativeId,
          f.primary.snapshot.executionModel!.identity.builderId,
        );
        assert.deepEqual(
          [...grant.bounds.rootNativeIds].sort(),
          [mainRoot, templateRoot, privateDefinition].sort(),
        );
      }
      const peerBefore = await validateSourceExecutable(
        head,
        f.backend.projectId,
        nativeEvolutionPeer,
      );
      const members = [
        "readCaseState",
        "consultDeclaredSource",
        "executeOperatorCommand",
        "chooseNextMove",
        "replyOrClarify",
        "waitForInput",
        "checkRequestedAction",
        "executeAction",
        "recordRefusal",
        "submitChangeProposal",
        "observeOutcome",
      ];
      assert(
        f.backend.tooling.referenceSites,
        "The pinned Toolkit must expose native site fingerprints",
      );
      const rebindings: ModelEdit[] = [];
      for (const member of members) {
        const fromId = nativeId(
          head,
          `AssemblyConversation::ImmutableGroupConversationV1::${member}`,
        );
        const toId = nativeId(head, `${privateEvolutionFlow}::${member}`);
        const sites = await f.backend.tooling.referenceSites(
          head.sources,
          fromId,
        );
        const selected = sites.filter((site) =>
          site.unit === "configuration.sysml" &&
          site.chainRootId ===
            nativeId(head, `${nativeEvolutionMain}::conversation`) &&
          site.preimage.includes(member)
        );
        assert.equal(
          selected.length,
          1,
          `The exact Main allocation site for ${member} must be unique`,
        );
        rebindings.push({
          kind: "retarget-reference",
          fromId,
          toId,
          site: selected[0]!,
        });
      }
      assert.equal(
        new Set(rebindings.map((edit) => JSON.stringify(edit))).size,
        members.length,
      );
      const d = await prepared(f, [
        {
          kind: "set-type",
          elementId: nativeId(head, `${nativeEvolutionMain}::conversation`),
          typeName: privateEvolutionFlow,
        },
        {
          kind: "set-type",
          elementId: nativeId(
            head,
            `${nativeEvolutionMain}::operatorFlowTemplate`,
          ),
          typeName: privateEvolutionFlow,
        },
        ...rebindings,
      ], ["flow"]);
      await accept(f, d);
      await f.turn([{
        kind: "adopt_operator_evolution",
        text: "Adopt this private flow after returning",
        dossierId: d.id,
      }]);
      const adopted = await awaitAdoption(f, d.id);
      await assertPublication(f, adopted);
      const active = f.primary.snapshot.executionModel!;
      // A selected definition supplies behavior; it does not replace the
      // identity of the performing occurrence that owns the actual run.
      assert.equal(
        active.flows.conversation.rootNativeId,
        mainRoot,
      );
      assert.equal(
        active.flows.conversation.rootOccurrenceId,
        originalFlow.rootOccurrenceId,
      );
      const adoptedSource = await f.backend.repository.current();
      const mainSelection = selectedFlowRoot(
        sourceSnapshot(adoptedSource.elements, active.identity.rootId),
        active.identity.systemId,
        "conversation",
      );
      assert.equal(mainSelection.root.id, mainRoot);
      assert.equal(mainSelection.definition.id, privateDefinition);
      for (const member of members) {
        assert(
          active.flows.conversation.nodes.some((node) =>
            node.nativeId ===
              nativeId(head, `${privateEvolutionFlow}::${member}`)
          ),
          `The Main flow must compile the private native child ${member}`,
        );
      }
      assert.equal(
        active.flows.conversation.executionProfile,
        "operator-command-immutable-group-v1",
      );
      assert.equal(
        active.operatorFlowTemplate!.qualifiedName,
        privateEvolutionFlow,
      );
      assert.equal(active.operatorFlowTemplate!.revision, 2);
      assert.equal(
        active.operatorFlowTemplate!.typeNativeId,
        privateDefinition,
      );
      const beforeCalls = f.contexts.length;
      await f.turn([], "Execute the exact private flow");
      assert.equal(f.contexts.length, beforeCalls + 1);
      await assertAdmittedSourceObserved(f, f.contexts.at(-1)!);
      const peerAfter = await validateSourceExecutable(
        await f.backend.repository.current(),
        f.backend.projectId,
        nativeEvolutionPeer,
      );
      assert.equal(peerAfter.version.digest, peerBefore.version.digest);
      assert.deepEqual(peerAfter.flows, peerBefore.flows);
      // Creation uses the real SourceModel writer with the creator's admitted selection.
      await f.turn([{
        kind: "propose_agent_creation",
        text: "Create a future template consumer",
        role: "operator",
        name: "Native future consumer",
        reason: "Qualify selected version consumption",
        operator: {
          instruction: "Read only after separate source-read authorization.",
          networkHosts: [],
          requestType: { name: "Native template request", maxInvocations: 4 },
          firstRequest: { objective: "Read the declared source, then reply." },
        },
      }]);
      const change = f.primary.snapshot.configuration!.changes.at(-1)!;
      assert.equal(change.kind, "operator-creation");
      await f.primary.decideChange({
        changeId: change.id,
        expectedRevision: change.baseRevision,
        verdict: "approve",
      });
      await f.postgres.idle(f.primary);
      assert.equal(f.primary.snapshot.error, undefined);
      // The approved creation command already reconciles and opens the new
      // operator. Observe that production path without a second global pass.
      console.log("Native private-flow milestone: creation command completed");
      const future = f.workspace.conversations.snapshot.conversations.find((
        entry,
      ) =>
        entry.agentId !== active.identity.builderId &&
        entry.agentId !== peerBefore.identity.builderId
      )!;
      assert(future);
      const futureRuntime = f.workspace.runtimeFor(future.agentId)!.runtime;
      await f.postgres.idle(futureRuntime);
      const futureModel = futureRuntime.snapshot.executionModel!;
      const futureSource = await f.backend.repository.current();
      const futureRoot = nativeId(
        futureSource,
        `${futureModel.identity.systemQualifiedName}::conversation`,
      );
      assert.equal(
        futureModel.flows.conversation.rootNativeId,
        futureRoot,
      );
      assert.notEqual(futureRoot, mainRoot);
      assert.notEqual(
        futureModel.flows.conversation.rootOccurrenceId,
        active.flows.conversation.rootOccurrenceId,
      );
      const futureSelection = selectedFlowRoot(
        sourceSnapshot(futureSource.elements, futureModel.identity.rootId),
        futureModel.identity.systemId,
        "conversation",
      );
      assert.equal(futureSelection.root.id, futureRoot);
      assert.equal(futureSelection.definition.id, privateDefinition);
      for (const member of members) {
        const childId = nativeId(
          futureSource,
          `${privateEvolutionFlow}::${member}`,
        );
        const mainNode = active.flows.conversation.nodes.find((node) =>
          node.nativeId === childId
        )!;
        const futureNode = futureModel.flows.conversation.nodes.find((node) =>
          node.nativeId === childId
        );
        assert(
          futureNode,
          `The future flow must select the private native child ${member}`,
        );
        assert.notEqual(
          futureNode.id,
          mainNode.id,
          "Shared definition children retain distinct execution occurrences",
        );
      }
      assert.equal(
        futureRuntime.snapshot.executionModel!.flows.conversation
          .executionProfile,
        "operator-command-immutable-group-v1",
      );
      assert.equal(
        futureRuntime.snapshot.executionModel!.policy.mayProposeSysmlRevision,
        false,
        "Selecting the private template grants no revision right",
      );
      const request = futureRuntime.cases.cases[0]!;
      assert(request, "The future operator owns an actual originating Request");
      const futureContext = f.contexts.find((context) =>
        context.operator?.nativeId === future.agentId
      );
      assert(
        futureContext,
        "The future operator must execute its private flow",
      );
      await assertAdmittedSourceObserved(f, futureContext);
      assert.equal(futureContext.case!.id, request.id);
      assert.equal(futureRuntime.cases.cases[0]!.status, "open");

      // Make the private definition request a genuinely absent source, adopt
      // that exact version, then correct it. The failure and recovery exercise
      // the durable declared-read receipt rather than a revision-right proxy.
      const publishPrivateRead = async (from: string, to: string) => {
        const current = await f.backend.repository.current();
        const sources = structuredClone(current.sources);
        const before = sources["configuration.sysml"]!;
        const oldPath = `\\"path\\":\\"${from}\\"`;
        const newPath = `\\"path\\":\\"${to}\\"`;
        assert.equal(before.split(oldPath).length, 2);
        sources["configuration.sysml"] = before.replace(oldPath, newPath);
        await f.ownerPublish(sources, `Set private declared source to ${to}`);
        const available = await f.workspace.runtimeFor(future.agentId)!.model
          .readExecutableModel(futureRuntime.snapshot.executionModel!.identity);
        await f.workspace.adopt({
          agentId: future.agentId,
          expectedDigest: available.version.digest,
          expectedVersion: available.version.repositoryVersion!,
        }, () =>
          futureRuntime.adoptModelVersion({
            expectedDigest: available.version.digest,
            expectedVersion: available.version.repositoryVersion!,
          }));
        assert.equal(
          futureRuntime.snapshot.executionModel!.version.digest,
          available.version.digest,
        );
        assert.equal(
          futureRuntime.snapshot.executionModel!.version.repositoryVersion,
          available.version.repositoryVersion,
        );
        assert.equal(
          futureRuntime.snapshot.executionModel!.policy.mayProposeSysmlRevision,
          false,
        );
        return available;
      };
      const missing = await publishPrivateRead(
        "conversation.sysml",
        "absent-cap2.sysml",
      );
      const beforeFailure = f.contexts.length;
      await f.turn([{
        kind: "resume_request",
        text: "Resume against the unavailable declared source",
        operatorId: future.agentId,
        caseId: request.id,
        resumeId: "native-private-missing-source",
        instruction: "Continue the same Request.",
      }]);
      await f.postgres.idle(futureRuntime);
      assert.equal(
        f.contexts.slice(beforeFailure).some((context) =>
          context.operator?.nativeId === future.agentId
        ),
        false,
        "The declared failure branch must not call the provider",
      );
      const failedRuns = await f.postgres.native.execution.inspect(
        future.agentId,
      );
      const refusal = failedRuns.findLast((run) =>
        run.modelDigest === missing.version.digest &&
        run.localState?.declaredConsultationRefusal
      )?.localState?.declaredConsultationRefusal as
        | { code?: string }
        | undefined;
      assert(
        refusal,
        "The failed declared read must leave its durable refusal receipt",
      );
      assert.equal(
        refusal.code,
        "NOT_FOUND",
        "The exact pinned source is absent",
      );
      assert.equal(futureRuntime.cases.cases[0]!.status, "waiting");

      const corrected = await publishPrivateRead(
        "absent-cap2.sysml",
        "conversation.sysml",
      );
      assert.notEqual(corrected.version.digest, missing.version.digest);
      const beforeRecovery = f.contexts.length;
      await f.turn([{
        kind: "resume_request",
        text: "Retry the same Request under the corrected adopted source",
        operatorId: future.agentId,
        caseId: request.id,
        resumeId: "native-private-corrected-source",
        instruction: "Read the declared source and return one bounded reply.",
      }]);
      await f.postgres.idle(futureRuntime);
      const recoveredContext = f.contexts.slice(beforeRecovery).find((
        context,
      ) => context.operator?.nativeId === future.agentId);
      assert(
        recoveredContext,
        "The same Request must reach the provider after correction and adoption",
      );
      await assertAdmittedSourceObserved(f, recoveredContext);
      assert.equal(recoveredContext.case!.id, request.id);
      assert.equal(futureRuntime.cases.cases[0]!.status, "open");
    } catch (error) {
      f.preserveEvidence();
      await f.captureEvidence("test-failure");
      throw error;
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  name:
    "native self evolution retires only the empty wait and finalizes with an open or subsequently closed originating Request",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const f = await openNativeEvolutionFixture();
    try {
      const requestId = await f.turn([], "Open one persistent Root Request", {
        newConversation: true,
      });
      assert(requestId);
      const owner = f.primary.snapshot.executionModel!.identity.builderId;
      const history = f.primary.snapshot.messages.map((message) => message.id);
      for (const closeOrigin of [false, true]) {
        const head = await f.backend.repository.current();
        const d = await prepared(
          f,
          [{
            kind: "set-value",
            elementId: nativeId(
              head,
              `${nativeEvolutionMain}::operatorInstruction`,
            ),
            expression: JSON.stringify(
              closeOrigin
                ? "Replacement prepared before closing its origin."
                : "Replacement effective while the same Root Request stays open.",
            ),
          }],
          ["instructions"],
          requestId,
        );
        assert.equal(d.origin.requestId, requestId);
        if (closeOrigin) {
          await f.primary.closeCase(requestId, "done", ACCEPTED_CASE_CLOSURE);
        }
        await accept(f, d);
        await f.turn(
          [{
            kind: "adopt_operator_evolution",
            text: "Arm then finish this contribution",
            dossierId: d.id,
          }],
          "Authorize exact idle adoption",
          closeOrigin ? {} : { caseId: requestId },
        );
        const requestStatusAfterTurn:
          import("../../src/domain/work/entities/cases.ts").Case["status"] =
            f.primary.cases.cases.find((record) => record.id === requestId)!
              .status;
        assert.equal(
          requestStatusAfterTurn,
          closeOrigin ? "closed-done" : "waiting",
        );
        const calls = f.contexts.length;
        const adopted = await awaitAdoption(f, d.id);
        assert.equal(
          f.contexts.length,
          calls,
          "The finalizer never re-enters the originating Request or provider",
        );
        await assertPublication(f, adopted);
        assert.equal(
          f.primary.snapshot.executionModel!.identity.builderId,
          owner,
        );
        const request: import("../../src/domain/work/entities/cases.ts").Case =
          f.primary.cases.cases.find((record) => record.id === requestId)!;
        assert.equal(request.owner, owner);
        assert.equal(request.status, requestStatusAfterTurn);
        assert.deepEqual(
          f.primary.snapshot.messages.slice(0, history.length).map((message) =>
            message.id
          ),
          history,
        );
        if (!closeOrigin) {
          await f.turn(
            [],
            "Continue the same Root Request after exact activation",
            { caseId: requestId },
          );
          assert.equal(f.contexts.at(-1)!.case!.id, requestId);
          assert.equal(f.contexts.at(-1)!.operator!.nativeId, owner);
        }
      }
    } catch (error) {
      f.preserveEvidence();
      await f.captureEvidence("test-failure");
      throw error;
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  name:
    "native evolution refuses grantless, cross-target, stale-base and revoked authority without publication",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const f = await openNativeEvolutionFixture();
    try {
      const head = await f.backend.repository.current();
      const main = f.primary.snapshot.executionModel!;
      const peer = await validateSourceExecutable(
        head,
        f.backend.projectId,
        nativeEvolutionPeer,
      );
      const repository = f.backend.createEvolutionRepository(
        new NativeEvolutionSourceAssessment({
          compilation: sourceEvolutionCompilation,
          projectId: f.backend.projectId,
        }),
      );
      const input = {
        id: "refusal",
        repositoryId: f.backend.project.id,
        actorId: peer.identity.builderId,
        finalizerActorId: peer.identity.builderId,
        origin: {
          operatorId: peer.identity.builderId,
          designerScopeId: "untrusted-origin-not-used-by-repository",
        },
        expectedVersion: head.version,
        reason: "Refusal qualification",
        edit: editRequest(head, [{
          kind: "set-value" as const,
          elementId: nativeId(
            head,
            `${nativeEvolutionPeer}::operatorInstruction`,
          ),
          expression: JSON.stringify("No grant cannot take effect"),
        }]),
      };
      await assert.rejects(
        () => repository.prepare(input),
        /scope|grant|authority|policy/i,
      );
      await assert.rejects(
        () =>
          repository.prepare({ ...input, actorId: main.identity.builderId }),
        /scope|grant|authority|policy/i,
      );
      assert.equal(
        (await f.backend.repository.current()).version,
        head.version,
      );
      const d = await prepared(f, [{
        kind: "set-value",
        elementId: nativeId(
          head,
          `${nativeEvolutionMain}::operatorInstruction`,
        ),
        expression: JSON.stringify(
          "Exact staged replacement awaiting separate authority",
        ),
      }], ["instructions"]);
      await assert.rejects(
        () => f.workspace.evolution!.accept(d.id, peer.identity.builderId),
        /grant|authority|policy/i,
      );
      await f.ownerPublish({
        ...head.sources,
        "configuration.sysml": head.sources["configuration.sysml"]! +
          "\n// Owner advances the exact base.\n",
      }, "Advance source without changing executable authority");
      await assert.rejects(
        () => repository.revalidate(d),
        /base|rebase|revision/i,
      );
      assert.equal(
        f.primary.snapshot.executionModel!.version.digest,
        main.version.digest,
      );
      const current = await f.backend.repository.current();
      const currentMain = await validateSourceExecutable(
        current,
        f.backend.projectId,
      );
      const revoked = buildEvolutionPolicyEdits(current, currentMain.identity, {
        id: currentMain.evolutionPolicy!.id,
        expectedRevision: currentMain.evolutionPolicy!.revision,
        grants: currentMain.evolutionPolicy!.grants.filter((grant) =>
          grant.category !== "instructions"
        ),
      });
      await f.ownerPublish(
        (await f.backend.tooling.edit(current.sources, revoked)).sources,
        "Human revokes the prior instruction grant",
      );
      const authority = new NativeEvolutionAuthority({
        compilation: sourceEvolutionCompilation,
        projectId: f.backend.projectId,
        repository: f.backend.repository,
      });
      await assert.rejects(
        () => authority.revalidate(d.preparation, d.proposal),
        /grant|authority|policy/i,
      );
      assert.equal((await f.evolutionStore.get(d.id))!.status, "prepared");
      assert.equal(
        await f.backend.repository.findPublicationByCommand!(d.proposal.id),
        null,
      );
      assert.equal(
        f.primary.snapshot.executionModel!.version.digest,
        main.version.digest,
      );
    } catch (error) {
      f.preserveEvidence();
      await f.captureEvidence("test-failure");
      throw error;
    } finally {
      await f.close();
    }
  },
});
