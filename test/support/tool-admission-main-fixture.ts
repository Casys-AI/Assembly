/** Unit composition: real Main decisions, history, native effects and target
 * workers; controlled models/publication. This does not qualify PostgreSQL,
 * Git or the full operator-workspace composition. */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { SystemRuntime } from "./system-runtime.ts";
import {
  createTestNativeExecution,
  type NativeFixtureEffectBoundary,
} from "./native-execution.ts";
import {
  enableCommandFixtureProfile,
  executableFixture,
} from "./execution-fixture.ts";
import { unexpectedModelAuthoring } from "./model-authoring.ts";
import {
  exactCandidateInspection,
  exactDelegatedCommandDecision,
} from "../../src/application/governance/operator-command-origin.ts";
import { toolAdmissionDecisionContext } from "../../src/application/governance/operator-tool-admission-context.ts";
import {
  type MainCandidateInspection,
  OperatorConversationError,
  OperatorConversations,
} from "../../src/application/work/operators/conversations.ts";
import type {
  OperatorCommandOrigin,
  OperatorControlCommand,
} from "../../src/application/work/operators/command-delivery.ts";
import { caseExecutionContext } from "../../src/application/work/cases/runtime.ts";
import {
  invocationInput,
  invocationKey,
} from "../../src/application/work/operators/journal.ts";
import { legacyOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { OperatorAuthorityError } from "../../src/domain/governance/operator-authority.ts";
import type { CandidateDelegatedActor } from "../../src/domain/governance/policies/tool-admission-policy.ts";
import type {
  ChatDecision,
  SystemRuntimeState,
} from "../../src/domain/work/dialogue.ts";
import { caseTypesForModel } from "../../src/domain/work/records/case-types.ts";
import type { CandidateDecisionInput } from "../../src/application/work/candidates/decisions.ts";
import type { ExecutableModel } from "../../src/domain/model/execution/executable-model.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";

export const toolAdmissionMainCaseId = "operator-request:reader-one";

export async function openToolAdmissionMainFixture(options: {
  target: SystemRuntime;
  model: ExecutableModel;
  actorId: string;
  bindNotifications(conversations: OperatorConversations): void;
  using(dispose: () => Promise<void>): void;
}) {
  const model = executableFixture({
    ...options.model.identity,
    systemId: "main-system",
    catalogId: "main-catalog",
    builderId: options.actorId,
  });
  model.version = {
    ...model.version,
    digest: "main-admitted",
    repositoryVersion: "branch:main",
  };
  model.ownerAuthority = {
    ...legacyOwnerAuthority("main-system"),
    ownerSource: "modeled",
  };
  model.operator = {
    name: "Main",
    primary: true,
    humanInput: true,
    instruction: "Inspect exact candidates before deciding",
  };
  model.toolAdmissionPolicies = structuredClone(
    options.model.toolAdmissionPolicies,
  );
  // The explicit command flow declares a mandatory source-model read before
  // choosing a command. Its admitted read permission is checked by that real
  // primitive, independently of the target's candidate-admission delegation.
  model.policy.mayProposeSysmlRevision = true;
  enableCommandFixtureProfile(model);
  let saved: SystemRuntimeState | null = null;
  const native = createTestNativeExecution({
    load: () => Promise.resolve(structuredClone(saved)),
    save(state, expected) {
      equal(saved?.revision ?? null, expected);
      saved = structuredClone(state);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  });
  const effects = new Map<string, NativeFixtureEffectBoundary>();
  native.effectBoundary((boundary) => {
    effects.set(boundary.key, structuredClone(boundary));
  });
  let pending:
    | { input: CandidateDecisionInput; actor: CandidateDelegatedActor }
    | undefined;
  let phase = 0, messageStart = 0;
  const commands: Array<
    { origin: OperatorCommandOrigin; batchId: string; callId: string }
  > = [];
  const main = new SystemRuntime({
    store: native.store,
    execution: native.execution,
    dispatch: native.dispatch,
    stateHistory: native.stateHistory,
    model: {
      ...unexpectedModelAuthoring,
      initialize: () => Promise.resolve(structuredClone(model.identity)),
      readExecutableModel: () => Promise.resolve(structuredClone(model)),
      applyApprovedChange() {
        throw new Error("No Main model authoring belongs to this fixture");
      },
      activateCandidate() {
        throw new Error("Main must not publish the recipient's candidate");
      },
      graph: () => Promise.resolve({}),
    },
    information: {
      read: () => Promise.resolve({ memoryGuidance: [] }),
      consultAdmittedModelSource(current, input) {
        equal(current.version.digest, model.version.digest);
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
      label: "actual-native-Main-tool-admission",
      decide(): Promise<ChatDecision> {
        if (!pending || phase++ > 1) {
          return Promise.resolve({
            kind: "reply",
            text: "Main decision finished",
          });
        }
        if (phase === 1) {
          return Promise.resolve({
            kind: "inspect_operator_candidate",
            text: "Inspect exact code, contract and tests",
            operatorId: options.model.identity.builderId,
            candidateId: pending.input.candidateId,
            candidateDigest: pending.input.candidateDigest,
            caseId: pending.input.caseId!,
            expectedRevision: options.target.snapshot.revision,
            policyId: pending.actor.policyId,
            policyRevision: pending.actor.policyRevision,
          });
        }
        const observed = main.snapshot.messages.slice(messageStart).findLast((
          message,
        ) => message.observation?.kind === "candidate-inspection");
        ok(
          observed,
          "The native inspection must have produced its real observation",
        );
        const value = observed.observation!.value as MainCandidateInspection & {
          status?: string;
        };
        if (value.status === "refused") {
          return Promise.resolve({
            kind: "reply",
            text: "Exact inspection refused",
          });
        }
        return Promise.resolve({
          kind: "decide_operator_candidate",
          text: "Decide the inspected candidate",
          ...value.decisionReference,
          verdict: pending.input.verdict,
          reason: pending.input.reason,
        });
      },
      review() {
        throw new Error("Main has no review mode in this fixture");
      },
    },
    runner: {
      test() {
        throw new Error("Main must not retest the candidate");
      },
      run() {
        throw new Error("Main must not run a tool");
      },
    },
  });
  const localIdle = main.idle.bind(main);
  let conversations: OperatorConversations | undefined;
  let disposed = false;
  options.using(async () => {
    if (disposed) return;
    disposed = true;
    try {
      if (conversations) await conversations.dispose();
      else await native.idle();
    } finally {
      await native.store.close();
      effects.clear();
      commands.length = 0;
      pending = undefined;
    }
  });
  await main.initialize();
  // Supplying dispatch disables the shared wrapper's automatic bind. Bind this
  // exact native fixture once and preserve the facade's original control drain.
  native.bind(main);
  main.idle = async () => {
    await localIdle();
    await native.idle();
    await localIdle();
  };
  const caseId = await main.openOperatorRequest({
    changeId: "reader-one",
    caseTypeId: caseTypesForModel(model).find((type) =>
      type.type === "request"
    )!.id,
    objective: "Coordinate the reader Request",
    openedBy: options.actorId,
    // A creation change always names exactly one origin (pending-change.ts).
    openedFrom: {
      conversationId: main.snapshot.id,
      designerScopeId: "tool-admission-designer-scope",
    },
  });
  equal(caseId, toolAdmissionMainCaseId);
  await main.idle();
  let manager = new OperatorConversations({
    primary: main,
    factory: { open: () => Promise.resolve(options.target) },
  });
  conversations = manager;
  await manager.initialize({
    repositoryVersion: model.version.repositoryVersion!,
    units: [model, options.target.snapshot.executionModel!].map((unit) => ({
      systemQualifiedName: unit.identity.systemId,
      model: unit,
    })),
  });
  options.bindNotifications(manager);
  async function source(origin: OperatorCommandOrigin) {
    const reference = origin.businessRevision.__assemblyRuntimeRevision;
    const historical = await native.stateHistory.loadRevision(
      reference.revision,
    );
    const effect = effects.get(origin.effectKey);
    ok(
      historical && historical.caseInvocation && effect,
      "Only an observed native effect and accepted source revision may authorize delivery",
    );
    equal(effect.node.mechanism, "execute_operator_command");
    equal(effect.request.identity.operatorId, options.actorId);
    equal(effect.request.identity.invocationKey, reference.invocationKey);
    equal(effect.request.contribution.inputMessageId, origin.inputMessageId);
    equal(effect.request.model.version.digest, reference.modelDigest);
    equal(historical.id, reference.systemId);
    equal(reference.operatorId, options.actorId);
    equal(historical.executionModel?.version.digest, reference.modelDigest);
    equal(invocationKey(historical.caseInvocation), reference.invocationKey);
    equal(invocationInput(historical)?.id, origin.inputMessageId);
    const current = main.snapshot;
    deepStrictEqual(
      current.executionModel?.version,
      historical.executionModel?.version,
    );
    deepStrictEqual(
      invocationInput({
        ...current,
        caseInvocation: historical.caseInvocation,
        activeInputMessageId: origin.inputMessageId,
      }, historical.caseInvocation),
      invocationInput(historical),
    );
    return historical;
  }
  const assertAuthority: Parameters<
    SystemRuntime["bindOperatorCommandAuthority"]
  >[0] = async (command, origin) => {
    ok(command.kind === "decide-candidate");
    const historical = await source(origin);
    const selected = exactDelegatedCommandDecision(
      historical,
      options.model.identity.builderId,
      command,
      origin,
    );
    ok(selected?.kind === "decide_operator_candidate");
    const inspected = historical.messages.find((message) =>
      message.id === origin.inspectionMessageId
    )?.observation?.value as MainCandidateInspection | undefined;
    ok(
      inspected &&
        exactCandidateInspection(historical, inspected.decisionReference)
            ?.id === origin.inspectionMessageId,
    );
    deepStrictEqual(inspected.decisionReference, {
      operatorId: options.model.identity.builderId,
      candidateId: command.input.candidateId,
      candidateDigest: command.input.candidateDigest,
      expectedRevision: selected.expectedRevision,
      caseId: command.input.caseId,
      policyId: command.delegated!.policyId,
      policyRevision: command.delegated!.policyRevision,
    });
    const allowed = toolAdmissionDecisionContext(model, [
      options.target.snapshot,
    ]).candidates.some((candidate) => {
      const { name: _name, kind: _kind, ...reference } = candidate;
      return canonical(reference) === canonical(inspected.decisionReference);
    });
    if (!allowed) {
      throw new OperatorAuthorityError(
        "AUTHORITY_OUT_OF_BOUNDS",
        "The exact current candidate inspection and grant are unavailable",
        { candidateId: command.input.candidateId },
      );
    }
  };
  options.target.bindOperatorCommandAuthority(assertAuthority);
  main.bindOperatorAuthorityLifecycle({
    candidateDecisionContext: () =>
      toolAdmissionDecisionContext(model, [options.target.snapshot]),
    async inspectCandidate(command) {
      try {
        const inspection = await manager.inspectCandidate({
          agentId: command.operatorId,
          ...command,
        }, {
          actorId: options.actorId,
          policyId: command.policyId,
          policyRevision: command.policyRevision,
        });
        const { kind: _kind, text: _text, ...reference } = command;
        return {
          ...inspection,
          decisionReference: {
            ...reference,
            expectedRevision: options.target.snapshot.revision,
          },
        };
      } catch (error) {
        if (error instanceof OperatorConversationError) {
          throw new OperatorAuthorityError(
            "AUTHORITY_REQUEST_STALE",
            error.message,
            { reason: error.code },
          );
        }
        throw error;
      }
    },
    async decideCandidate(command, origin) {
      ok(origin, "The source native action must supply its own origin");
      const historical = await source(origin);
      ok(historical.activeBatchCall);
      const commandEffect = {
        origin: structuredClone(origin),
        ...historical.activeBatchCall,
      };
      const prior = commands.find((entry) =>
        entry.origin.effectKey === origin.effectKey
      );
      if (prior) deepStrictEqual(prior, commandEffect);
      else commands.push(commandEffect);
      const {
        kind: _kind,
        text: _text,
        verdict: _verdict,
        reason: _reason,
        ...reference
      } = command;
      const inspection = exactCandidateInspection(historical, reference);
      ok(
        inspection,
        "Only this source's actual exact inspection may authorize its decision",
      );
      const exactOrigin = { ...origin, inspectionMessageId: inspection.id };
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
        delegated: {
          actorId: options.actorId,
          policyId: command.policyId,
          policyRevision: command.policyRevision,
        },
      };
      ok(
        exactDelegatedCommandDecision(
          historical,
          command.operatorId,
          accepted,
          exactOrigin,
        ),
      );
      await manager.decideCandidate(
        {
          agentId: command.operatorId,
          ...accepted.input,
          expectedRevision: command.expectedRevision,
        },
        accepted.delegated,
        exactOrigin,
      );
    },
    proposed: () => Promise.resolve(),
    approved: () => Promise.resolve(),
    closed: () => Promise.resolve(),
  });
  return {
    main,
    executions: () => native.execution.inspect(options.actorId),
    get conversations() {
      return manager;
    },
    async attach(
      recipient: Pick<typeof options, "target" | "model" | "bindNotifications">,
    ) {
      if (recipient.target !== options.target) {
        await manager.dispose();
        Object.assign(options, recipient);
        manager = new OperatorConversations({
          primary: main,
          factory: { open: () => Promise.resolve(options.target) },
        });
        conversations = manager;
        await manager.initialize({
          repositoryVersion: model.version.repositoryVersion!,
          units: [model, options.target.snapshot.executionModel!].map((
            unit,
          ) => ({ systemQualifiedName: unit.identity.systemId, model: unit })),
        });
      }
      options.bindNotifications(manager);
      options.target.bindOperatorCommandAuthority(assertAuthority);
    },
    context() {
      // The source decision may select another real Main Request. The worker
      // contribution still belongs to the original authoritative central Case.
      const state = main.snapshot;
      const context = caseExecutionContext({
        ...state,
        caseInvocation: { kind: "local", caseId },
      });
      ok(context?.record && context.record.owner === options.actorId);
      equal(context.caseId, toolAdmissionMainCaseId);
      return context;
    },
    async decide(
      input: CandidateDecisionInput,
      actor: CandidateDelegatedActor,
    ) {
      equal(actor.actorId, options.actorId);
      options.bindNotifications(manager);
      options.target.bindOperatorCommandAuthority(assertAuthority);
      pending = { input, actor };
      phase = 0;
      messageStart = main.snapshot.messages.length;
      const previousBatches = new Set(
        main.snapshot.conversationBatches?.map((batch) => batch.id),
      );
      // This method represents a new user attempt, not retry of a pending
      // command. Each gets a real independent source Request; native resumes
      // within that attempt retain their original input/effect/origin. Earlier
      // uncertain effects stay on their original Request and are never cleared.
      const sourceCaseId = await main.submit(
        "Inspect and decide this exact candidate",
        undefined,
        undefined,
        true,
      );
      ok(sourceCaseId && sourceCaseId !== caseId);
      await main.idle();
      // submit returns the Request id. Correlation uses the actual newly
      // materialized source message, never that facade acknowledgement.
      const sourceInput = invocationInput(main.snapshot);
      ok(
        sourceInput?.role === "user" &&
          main.snapshot.messages.slice(messageStart).some((message) =>
            message.id === sourceInput.id
          ),
      );
      const inputId = sourceInput.id;
      const selectedSource = main.snapshot.caseInvocation;
      ok(selectedSource?.kind === "local");
      equal(selectedSource.caseId, sourceCaseId);
      const central = main.snapshot.cases?.find((record) =>
        record.id === caseId
      );
      ok(central && central.owner === options.actorId);
      let workerRefusal: OperatorAuthorityError | undefined;
      try {
        await options.target.idle();
      } catch (error) {
        if (!(error instanceof OperatorAuthorityError)) throw error;
        workerRefusal = error;
      }
      await main.idle();
      const refused = main.snapshot.messages.slice(messageStart).findLast((
        message,
      ) =>
        message.observation?.kind === "candidate-inspection" &&
        (message.observation.value as { status?: string })?.status === "refused"
      )?.observation?.value as {
        code: ConstructorParameters<typeof OperatorAuthorityError>[0];
        message: string;
        context?: Record<string, string>;
      } | undefined;
      if (refused) {
        throw new OperatorAuthorityError(
          refused.code,
          refused.message,
          refused.context,
        );
      }
      const delivered = commands.filter((command) =>
        command.origin.inputMessageId === inputId
      );
      const diagnostic = delivered.length === 1 ? undefined : {
        phase,
        sourceCaseId,
        inputId,
        selectedInputId: invocationInput(main.snapshot)?.id,
        main: {
          revision: main.snapshot.revision,
          busy: main.snapshot.busy,
          phase: main.snapshot.phase,
          error: main.snapshot.error,
          invocation: main.snapshot.caseInvocation,
          modelDigest: main.snapshot.executionModel?.version.digest,
        },
        target: {
          revision: options.target.snapshot.revision,
          busy: options.target.snapshot.busy,
          phase: options.target.snapshot.phase,
          error: options.target.snapshot.error,
          modelDigest: options.target.snapshot.executionModel?.version.digest,
          candidates: options.target.snapshot.candidates.slice(-6).map((
            candidate,
          ) => ({
            id: candidate.id,
            stage: candidate.stage,
            caseId: candidate.caseId,
          })),
        },
        messages: main.snapshot.messages.slice(messageStart).slice(-8).map((
          message,
        ) => ({
          id: message.id,
          role: message.role,
          caseId: message.caseId,
          observation: message.observation?.kind,
          text: message.text.slice(0, 250),
        })),
        batches: main.snapshot.conversationBatches?.filter((batch) =>
          !previousBatches.has(batch.id)
        ).slice(-6).map((batch) => ({
          id: batch.id,
          inputMessageId: batch.inputMessageId,
          invocationKey: batch.invocationKey,
          calls: batch.calls.map((call) => ({
            id: call.id,
            kind: call.decision.kind,
            status: call.status,
            result: call.result &&
              {
                status: call.result.status,
                code: call.result.code,
                details: call.result.details.slice(0, 250),
              },
          })),
        })),
        origins: commands.slice(-6).map((command) => ({
          inputMessageId: command.origin.inputMessageId,
          effectKey: command.origin.effectKey,
          batchId: command.batchId,
          callId: command.callId,
        })),
        executions: (await native.execution.inspect(options.actorId)).slice(-8)
          .map((execution) => ({
            threadId: execution.threadId,
            status: execution.status,
            input: execution.contributionId,
            waits: execution.waits,
            unsettledEffects: execution.unsettledEffects,
          })),
      };
      equal(
        delivered.length,
        1,
        "This exact new input must select one native decision effect" +
          (diagnostic ? `: ${JSON.stringify(diagnostic)}` : ""),
      );
      const selected = delivered[0];
      const batch = main.snapshot.conversationBatches?.find((batch) =>
        batch.id === selected.batchId && !previousBatches.has(batch.id) &&
        batch.inputMessageId === inputId &&
        batch.invocationKey ===
          selected.origin.businessRevision.__assemblyRuntimeRevision
            .invocationKey
      );
      const call = batch?.calls.find((call) => call.id === selected.callId);
      ok(call?.decision.kind === "decide_operator_candidate");
      const chosen = call.decision;
      deepStrictEqual({
        candidateId: chosen.candidateId,
        candidateDigest: chosen.candidateDigest,
        caseId: chosen.caseId,
        verdict: chosen.verdict,
        reason: chosen.reason,
      }, input);
      equal(chosen.operatorId, options.model.identity.builderId);
      equal(chosen.policyId, actor.policyId);
      equal(chosen.policyRevision, actor.policyRevision);
      const result = call.result;
      ok(
        result,
        workerRefusal
          ? `The target refused with ${workerRefusal.code}, but its exact Main source has no coded result`
          : "The real Main must observe its delegated decision result after worker completion",
      );
      if (result.status === "refused") {
        throw Object.assign(new Error(result.details), { code: result.code });
      }
      ok(
        !workerRefusal,
        "A target refusal cannot become a successful Main decision",
      );
      equal(result.status, "succeeded", JSON.stringify(result));
      equal(main.snapshot.error, undefined);
      equal(options.target.snapshot.error, undefined);
    },
  };
}
