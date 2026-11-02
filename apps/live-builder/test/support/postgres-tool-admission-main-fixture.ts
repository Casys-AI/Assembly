/** Real native Main inspection/decision composition for one PostgreSQL session.
 * Model choices are controlled; source effects, history and target queue are not. */
import assert from "node:assert/strict";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import {
  type MainCandidateInspection,
  OperatorConversations,
} from "../../src/application/work/operators/conversations.ts";
import type { CandidateDecisionInput } from "../../src/application/work/candidates/decisions.ts";
import type { CandidateDelegatedActor } from "../../src/domain/governance/policies/tool-admission-policy.ts";
import type { ExecutableModel } from "../../src/domain/model/execution/executable-model.ts";
import type {
  OperatorCommandOrigin,
  OperatorControlCommand,
} from "../../src/application/work/operators/command-delivery.ts";
import {
  exactCandidateInspection,
  exactDelegatedCommandDecision,
} from "../../src/application/governance/operator-command-origin.ts";
import { toolAdmissionDecisionContext } from "../../src/application/governance/operator-tool-admission-context.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import {
  invocationInput,
  invocationKey,
} from "../../src/application/work/operators/journal.ts";
import { unexpectedModelAuthoring } from "./model-authoring.ts";
import type { openPostgresDurableRecoveryHost } from "./postgres-runtime-fixture.ts";

export const mainBootstrapReply = "Main coordination Request ready";

type Session = Awaited<
  ReturnType<
    Awaited<ReturnType<typeof openPostgresDurableRecoveryHost>>["openSession"]
  >
>;

export async function openPostgresToolAdmissionMain(options: {
  session: Session;
  target: SystemRuntime;
  model: ExecutableModel;
  actor: CandidateDelegatedActor;
  choice: {
    input?: CandidateDecisionInput;
    calls: number;
    decisions: number;
    setupCalls: number;
  };
}) {
  const { session, target, model, actor, choice } = options;
  const ports = await session.runtimePortsFor(actor.actorId);
  const main = new SystemRuntime({
    ...ports,
    model: {
      ...unexpectedModelAuthoring,
      initialize: () => Promise.resolve(structuredClone(model.identity)),
      readExecutableModel: () => Promise.resolve(structuredClone(model)),
      findCandidate: () => Promise.resolve(null),
      findApprovedChange: () => Promise.resolve(null),
      applyApprovedChange() {
        throw new Error("Main cannot author this fixture");
      },
      activateCandidate() {
        throw new Error("Main cannot publish the target tool");
      },
      graph: () => Promise.resolve({}),
    },
    information: {
      read: () => Promise.resolve({ memoryGuidance: [] }),
      consultAdmittedModelSource(current, input) {
        assert.equal(current.version.digest, model.version.digest);
        return Promise.resolve({
          modelVersion: {
            digest: current.version.digest,
            repositoryVersion: current.version.repositoryVersion,
          },
          result: { path: input.path },
        });
      },
    },
    agents: {
      label:
        "Controlled Main choices over real PostgreSQL native source effects",
      decide() {
        choice.calls++;
        const input = choice.input;
        if (!input) {
          choice.setupCalls++;
          assert.equal(
            choice.setupCalls,
            1,
            "Only the explicit central Request bootstrap may run before a candidate is supplied",
          );
          return Promise.resolve({
            kind: "reply" as const,
            text: mainBootstrapReply,
          });
        }
        const observed = main.snapshot.messages.findLast((message) =>
          message.observation?.kind === "candidate-inspection" &&
          (message.observation.value as MainCandidateInspection)
              .decisionReference?.candidateId === input.candidateId
        );
        if (!observed) {
          return Promise.resolve({
            kind: "inspect_operator_candidate" as const,
            text: "Inspect the exact tested candidate",
            operatorId: target.snapshot.executionModel!.identity.builderId,
            candidateId: input.candidateId,
            candidateDigest: input.candidateDigest,
            caseId: input.caseId!,
            expectedRevision: target.snapshot.revision,
            policyId: actor.policyId,
            policyRevision: actor.policyRevision,
          });
        }
        const chosen = main.snapshot.conversationBatches?.flatMap((batch) =>
          batch.calls
        ).find((call) =>
          call.decision.kind === "decide_operator_candidate" &&
          call.decision.candidateId === input.candidateId
        );
        if (chosen) {
          return Promise.resolve({
            kind: "reply" as const,
            text: "Exact decision observed",
          });
        }
        choice.decisions++;
        assert.equal(
          choice.decisions,
          1,
          "Recovery must not select another Main decision",
        );
        const inspection = observed.observation!
          .value as MainCandidateInspection;
        return Promise.resolve({
          kind: "decide_operator_candidate" as const,
          text: "Approve the exact inspected candidate",
          ...inspection.decisionReference,
          verdict: input.verdict,
          reason: input.reason,
        });
      },
      review() {
        throw new Error("No Main review");
      },
    },
    runner: {
      run() {
        throw new Error("No Main tool invocation");
      },
      test() {
        throw new Error("No Main candidate test");
      },
    },
  });
  await main.initialize(undefined, {
    resumeContinuations: false,
    resumeCandidateContinuations: false,
  });
  const manager = new OperatorConversations({
    primary: main,
    factory: {
      open: () => Promise.resolve(target),
      close: () => Promise.resolve(),
    },
  });
  target.bindOperatorRegistry(manager);
  main.bindOperatorRegistry(manager);
  await manager.initialize({
    repositoryVersion: model.version.repositoryVersion!,
    units: [model, target.snapshot.executionModel!].map((unit) => ({
      systemQualifiedName: unit.identity.systemId,
      model: unit,
    })),
  });
  const origins: OperatorCommandOrigin[] = [];
  async function source(origin: OperatorCommandOrigin) {
    await session.native.assertCommandOrigin(origin);
    const reference = origin.businessRevision.__assemblyRuntimeRevision;
    const history = await ports.stateHistory.loadRevision(reference.revision);
    assert(history?.caseInvocation);
    assert.equal(history.id, reference.systemId);
    assert.equal(reference.operatorId, actor.actorId);
    assert.equal(history.executionModel?.version.digest, reference.modelDigest);
    assert.equal(
      invocationKey(history.caseInvocation),
      reference.invocationKey,
    );
    assert.equal(invocationInput(history)?.id, origin.inputMessageId);
    return history;
  }
  let authorityChecks = 0;
  target.bindOperatorCommandAuthority(async (command, origin) => {
    assert.equal(command.kind, "decide-candidate");
    if (command.kind !== "decide-candidate") {
      throw new Error("Unexpected command");
    }
    const history = await source(origin);
    const selected = exactDelegatedCommandDecision(
      history,
      target.snapshot.executionModel!.identity.builderId,
      command,
      origin,
    );
    assert.equal(selected?.kind, "decide_operator_candidate");
    const inspection = history.messages.find((message) =>
      message.id === origin.inspectionMessageId
    )?.observation?.value as MainCandidateInspection | undefined;
    assert(inspection);
    assert.equal(
      exactCandidateInspection(history, inspection.decisionReference)?.id,
      origin.inspectionMessageId,
    );
    assert(
      toolAdmissionDecisionContext(model, [target.snapshot]).candidates.some(
        (candidate) => {
          const { name: _name, kind: _kind, ...reference } = candidate;
          return canonical(reference) ===
            canonical(inspection.decisionReference);
        },
      ),
      "Current policy must still permit the exact inspected candidate",
    );
    authorityChecks++;
  });
  main.bindOperatorAuthorityLifecycle({
    candidateDecisionContext: () =>
      toolAdmissionDecisionContext(model, [target.snapshot]),
    async inspectCandidate(command) {
      const inspected = await manager.inspectCandidate({
        agentId: command.operatorId,
        ...command,
      }, actor);
      const { kind: _kind, text: _text, ...reference } = command;
      return {
        ...inspected,
        decisionReference: {
          ...reference,
          expectedRevision: target.snapshot.revision,
        },
      };
    },
    async decideCandidate(command, origin) {
      assert(
        origin,
        "Only the actual native source action can supply an origin",
      );
      const history = await source(origin);
      const {
        kind: _kind,
        text: _text,
        verdict: _verdict,
        reason: _reason,
        ...reference
      } = command;
      const inspected = exactCandidateInspection(history, reference);
      assert(
        inspected,
        "A real exact inspection must precede the delegated choice",
      );
      const exactOrigin = { ...origin, inspectionMessageId: inspected.id };
      const accepted: Extract<
        OperatorControlCommand,
        { kind: "decide-candidate" }
      > = {
        kind: "decide-candidate",
        input: {
          candidateId: command.candidateId,
          candidateDigest: command.candidateDigest,
          caseId: command.caseId,
          verdict: command.verdict,
          reason: command.reason.trim(),
        },
        delegated: actor,
      };
      assert(
        exactDelegatedCommandDecision(
          history,
          command.operatorId,
          accepted,
          exactOrigin,
        ),
      );
      origins.push(structuredClone(exactOrigin));
      await manager.decideCandidate(
        {
          agentId: command.operatorId,
          ...accepted.input,
          expectedRevision: command.expectedRevision,
        },
        actor,
        exactOrigin,
      );
    },
    proposed: () => Promise.resolve(),
    approved: () => Promise.resolve(),
    closed: () => Promise.resolve(),
  });
  return {
    main,
    manager,
    ports,
    origins,
    authorityChecks: () => authorityChecks,
  };
}
