import { nativeFrameworkNodeName } from "../../../application/work/native-execution/framework-node-name.ts";
import { isSha256Hex } from "../../../domain/primitives/execution-digest.ts";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
/** Official LangGraph execution behind Assembly's framework-neutral port. */
import {
  type BaseCheckpointSaver,
  type BaseStore,
  Command,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import type {
  ImmutableConsultationGroupSession,
  NativeChangeApprovalWait,
  NativeContinuationReceipt,
  NativeDeclaredConsultationRefusal,
  NativeEffectTarget,
  NativeExecutionActionResult,
  NativeExecutionHandlers,
  NativeExecutionPort,
  NativeExecutionRequest,
  NativeExecutionSelection,
  NativeExecutionSnapshot,
  NativeModelAdvanceEvidence,
  NativeScopeClosure,
  NativeThreadAdvanceAuthorization,
} from "../../../application/work/native-execution/contract.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type { CompiledFlowNode } from "../../../domain/model/execution/flow.ts";
import { type NativeWaitConsumptionEvidence } from "../../../application/work/native-execution/wait-evidence.ts";
import { verifyOfficialFork } from "./checkpoint-wait-evidence.ts";
import {
  compileNativeOperatorGraph,
  type NativeActionResult,
  nativeBudgetContinuationSource,
  type NativeState,
} from "./native-graph.ts";
import type { NativeObservationJournal } from "../../../application/work/native-execution/contract.ts";
import type {
  NativeObservationRecord,
} from "../../../domain/model/execution/native-observation.ts";

/** The queue owns durable claim/fence/receipts; saver owns checkpoint bytes.
 * Implementations must reject uncertain started effects rather than replay them.
 */
export interface NativeExecutionSession {
  immutableConsultations: ImmutableConsultationGroupSession;
  /** Mandatory durable native observation journal (R4b), bound by this
   * session to its authenticated owner/contribution/namespace/pin. */
  nativeObservations: NativeObservationJournal;
  threadId: string;
  checkpointNamespace: string;
  checkpointId?: string;
  runId: string;
  signal?: AbortSignal;
  resumeRequest?: NativeExecutionRequest;
  forceResumeWait?: boolean;
  /** Internal ledger selection, never transport input. The exact committed
   * cursor distinguishes a pending interrupt from its consumed successor. */
  selectedNetworkContinuation?: {
    readonly mode: "awaiting-consumption" | "consumed-successor";
    readonly threadId: string;
    readonly runId: string;
    readonly checkpointNamespace: string;
    readonly checkpointId: string;
    readonly contributionId: string;
  };
  selectedBudgetContinuation?: NativeContinuationReceipt;
  beforeInputAdvance?: {
    source: NativeContinuationReceipt["source"];
    evidence: NativeModelAdvanceEvidence;
    target: NativeExecutionRequest;
    mode: "retained-wait";
  };
  /** Production wraps the official saver with the same durable execution fence. */
  checkpointer?: BaseCheckpointSaver;
  alreadyCompleted?: NativeExecutionSnapshot;
  assertCurrent(): Promise<void>;
  /** Delivery acceptance is separate from a checkpoint-committed wait consumption. */
  contributionConsumed(): Promise<boolean>;
  withSelectionFence(operation: () => Promise<void>): Promise<void>;
  effect(
    key: string,
    node: CompiledFlowNode,
    operation: () => Promise<NativeExecutionActionResult>,
    admit?: () => Promise<void>,
    target?: NativeEffectTarget,
  ): Promise<NativeExecutionActionResult>;
  unsettledEffects(): Promise<string[]>;
  complete(snapshot: NativeExecutionSnapshot): Promise<void>;
  fail(error: unknown): Promise<void>;
  advance(
    request: {
      source: NativeContinuationReceipt["source"];
      evidence: NativeModelAdvanceEvidence;
      target: NativeExecutionRequest;
      mode?: "retained-wait";
    },
    fork: (
      saver: BaseCheckpointSaver,
      sourceConfig: LangGraphRunnableConfig,
    ) => Promise<LangGraphRunnableConfig>,
  ): Promise<
    { receipt: NativeContinuationReceipt; session: NativeExecutionSession }
  >;
}

/** Extract the checked native input, not provider data or a host side channel. */
export function transportNativeEffectTarget(
  node: CompiledFlowNode,
  inputs: Record<string, unknown>,
): NativeEffectTarget | undefined {
  if (node.mechanism !== "invoke_tool") return undefined;
  const decision = inputs.decision && typeof inputs.decision === "object"
    ? inputs.decision as Record<string, unknown>
    : {};
  const retained = decision.retainedTool;
  const evidence = retained && typeof retained === "object"
    ? retained as Record<string, unknown>
    : null;
  const target: NativeEffectTarget = {
    kind: "invocation",
    admitted: decision.admitted === true,
    toolId: typeof decision.toolId === "string" ? decision.toolId : null,
    behaviorId: typeof decision.behaviorId === "string"
      ? decision.behaviorId
      : null,
  };
  if (
    evidence &&
    ["resourceId", "descriptorDigest", "toolId", "toolDigest"].every(
      (key) => typeof evidence[key] === "string",
    )
  ) {
    target.retainedTool = {
      resourceId: evidence.resourceId as string,
      descriptorDigest: evidence.descriptorDigest as string,
      toolId: evidence.toolId as string,
      toolDigest: evidence.toolDigest as string,
    };
  }
  return target;
}

export interface NativeExecutionLedger {
  open(request: NativeExecutionRequest): Promise<NativeExecutionSession>;
  /** Reads the closed source historically, forks unselected, then atomically selects
   * one target under current claims. Ordinary open/advance are unchanged. */
  /** Forks the one ledger-attested approval wait into its adopted successor.
   * The callback has no selection authority; the ledger verifies and selects it. */
  resumeRequestNetworkAdoption?(
    request: NativeExecutionRequest,
    fork: (
      saver: BaseCheckpointSaver,
      sourceConfig: LangGraphRunnableConfig,
      sourceProtocol?: string,
    ) => Promise<LangGraphRunnableConfig>,
  ): Promise<NativeExecutionSession>;
  resumeRequestTeamAdoption?(
    request: NativeExecutionRequest,
    fork: (
      saver: BaseCheckpointSaver,
      sourceConfig: LangGraphRunnableConfig,
      sourceProtocol?: string,
    ) => Promise<LangGraphRunnableConfig>,
  ): Promise<NativeExecutionSession>;
  transferInitialAdmission?(
    request: NativeExecutionRequest,
    fork: (
      saver: BaseCheckpointSaver,
      sourceConfig: LangGraphRunnableConfig,
    ) => Promise<LangGraphRunnableConfig>,
  ): Promise<NativeExecutionSession>;
  inspect(
    operatorId: string,
    selection?: NativeExecutionSelection,
  ): Promise<NativeExecutionSnapshot[]>;
  /** Scoped per-run observation reader; never a business-event fallback. */
  readNativeObservations(
    operatorId: string,
    threadId: string,
    runId: string,
  ): Promise<NativeObservationRecord[]>;
  ownsCandidateRecoveryContribution?(input: {
    snapshot: NativeExecutionSnapshot;
    acceptedDigest: string;
  }): Promise<boolean>;
  /** Retain official checkpoint history; retirement is a business receipt. */
  closeScope(
    snapshot: NativeExecutionSnapshot,
    closure: NativeScopeClosure,
  ): Promise<void>;
  retireAndAdvance(
    snapshot: NativeExecutionSnapshot,
    authorization: NativeThreadAdvanceAuthorization,
    targetModel: ExecutableModel,
  ): Promise<void>;
}

/** No implicit in-memory saver, scripted handler or legacy engine fallback. */
export class NativeGraphExecution implements NativeExecutionPort {
  constructor(
    private readonly store: BaseStore | undefined,
    private readonly ledger: NativeExecutionLedger,
  ) {}

  async run(
    request: NativeExecutionRequest,
    handlers: NativeExecutionHandlers,
  ): Promise<NativeExecutionSnapshot> {
    // A promotion is an independent native run with explicit durable lineage.
    // Public framework isolation prevents ambient parent graph read/saver hooks
    // from overriding its scope, while unrelated business/claim ALS survives.
    return await AsyncLocalStorageProviderSingleton.runWithConfig(
      {},
      () => this.runRoot(request, handlers),
      true,
    );
  }
  private async runRoot(
    request: NativeExecutionRequest,
    handlers: NativeExecutionHandlers,
  ): Promise<NativeExecutionSnapshot> {
    let activeRequest = request;
    const transfer = activeRequest.initialAdmissionTransfer;
    const network = activeRequest.networkAdoptionContinuation ??
      activeRequest.teamAdoptionContinuation;
    const adoptionKind = activeRequest.teamAdoptionContinuation
      ? "team"
      : "network";
    if (network && transfer) {
      throw new Error(
        "A Request network continuation cannot also transfer initial admission",
      );
    }
    if (transfer && !this.ledger.transferInitialAdmission) {
      throw new Error(
        "Initial admission transfer requires a durable ledger implementation",
      );
    }
    if (network) {
      const keys = [
        "commandId",
        "receiptDigest",
        "changeId",
        "proposalIntentDigest",
        "predecessorThreadId",
        "checkpointId",
        "successorThreadId",
        "originalInputMessageId",
      ].sort().join(",");
      if (
        Object.keys(network).sort().join(",") !== keys ||
        Object.values(network).some((value) =>
          typeof value !== "string" || !value || value.length > 512 ||
          // Exact continuation identifiers intentionally reject control characters.
          // deno-lint-ignore no-control-regex
          /[\x00-\x1f\x7f]/.test(value)
        ) || !/^[a-f0-9]{64}$/.test(network.receiptDigest) ||
        !/^[a-f0-9]{64}$/.test(network.proposalIntentDigest) ||
        network.predecessorThreadId === network.successorThreadId ||
        activeRequest.identity.scope.kind !== "request" ||
        activeRequest.identity.subjectId !== network.originalInputMessageId ||
        activeRequest.contribution.kind !== "resume" ||
        activeRequest.contribution.inputMessageId !==
          network.originalInputMessageId ||
        activeRequest.contribution.id !==
          `${adoptionKind}-adoption:${network.receiptDigest}` ||
        canonical(
            adoptionKind === "team"
              ? activeRequest.contribution.teamAdoptionContinuation
              : activeRequest.contribution.networkAdoptionContinuation,
          ) !== canonical(network)
      ) {
        throw new Error(
          "The exact ledger-bound Request network continuation is required",
        );
      }
      if (
        adoptionKind === "team"
          ? !this.ledger.resumeRequestTeamAdoption
          : !this.ledger.resumeRequestNetworkAdoption
      ) {
        throw new Error(
          "A Request network continuation requires its durable fork ledger",
        );
      }
    }
    const forkAdoption: Parameters<
      NonNullable<NativeExecutionLedger["resumeRequestNetworkAdoption"]>
    >[1] = (saver, config, sourceProtocol) =>
      this.forkRequestNetworkAdoption(
        saver,
        config,
        activeRequest,
        sourceProtocol,
      );
    // Called on the ledger: a production ledger keeps private state.
    let session = network
      ? adoptionKind === "team"
        ? await this.ledger.resumeRequestTeamAdoption!(
          activeRequest,
          forkAdoption,
        )
        : await this.ledger.resumeRequestNetworkAdoption!(
          activeRequest,
          forkAdoption,
        )
      : transfer
      ? await this.ledger.transferInitialAdmission!(
        activeRequest,
        (saver, config) =>
          this.forkInitialAdmission(saver, config, activeRequest),
      )
      : await this.ledger.open(activeRequest);
    if (network) {
      const selection = session.selectedNetworkContinuation;
      if (
        session.resumeRequest || session.beforeInputAdvance ||
        session.selectedBudgetContinuation ||
        session.threadId !== network.successorThreadId ||
        !session.alreadyCompleted && (
            !selection || !session.runId || !session.checkpointId ||
            !["awaiting-consumption", "consumed-successor"].includes(
              selection.mode,
            ) ||
            selection.threadId !== session.threadId ||
            selection.runId !== session.runId ||
            selection.checkpointNamespace !== session.checkpointNamespace ||
            selection.checkpointId !== session.checkpointId ||
            selection.contributionId !== activeRequest.contribution.id ||
            session.forceResumeWait !==
              (selection.mode === "awaiting-consumption")
          )
      ) {
        throw new Error(
          "The Request network checkpoint has not been selected by its ledger",
        );
      }
      if (
        !session.alreadyCompleted &&
        await session.contributionConsumed() !==
          (selection!.mode === "consumed-successor")
      ) {
        throw new Error(
          "The Request network selection consumption proof differs",
        );
      }
    } else activeRequest = session.resumeRequest ?? activeRequest;
    await handlers.modelAdvanced?.(activeRequest.model);
    if (session.selectedBudgetContinuation) {
      if (!handlers.continuationSelected) {
        throw new Error("Budget continuation selection handler is required");
      }
      await session.withSelectionFence(() =>
        handlers.continuationSelected!(session.selectedBudgetContinuation!)
      );
    }
    if (session.beforeInputAdvance) {
      const advance = session.beforeInputAdvance;
      if (
        !handlers.readAdoptedModel ||
        canonical(await handlers.readAdoptedModel()) !==
          canonical(advance.target.model)
      ) {
        throw new Error(
          "The retained wait publication is no longer the exact current adopted source",
        );
      }
      const advanced = await session.advance(
        advance,
        (saver, config) =>
          this.forkNativeRun(saver, config, advance.target, advance.source),
      );
      session = advanced.session;
      if (
        advanced.receipt.evidence.kind === "verified-budget-ceiling-advance"
      ) {
        if (!handlers.continuationSelected) {
          throw new Error("Budget continuation selection handler is required");
        }
        await session.withSelectionFence(() =>
          handlers.continuationSelected!(advanced.receipt)
        );
      }
      activeRequest = advance.target;
      await handlers.modelAdvanced?.(activeRequest.model);
    }
    const transitionLimit = Math.max(1, request.model.policy.maxToolProposals) +
      4;
    for (let generation = 0; generation <= transitionLimit; generation++) {
      if (handlers.recoverEvents) {
        const observations = await session.nativeObservations.read();
        // Reading the authenticated run journal verifies its records. Historical
        // projection buffering grants no authority and needs no effect fence.
        await handlers.recoverEvents(
          observations.map(({ event, firstRecordedAt }) => ({
            event,
            firstRecordedAt,
          })),
        );
      }
      if (session.alreadyCompleted) {
        return structuredClone(session.alreadyCompleted);
      }
      if (!session.checkpointer || !session.runId) {
        throw new Error("A fenced execution-session checkpointer is required");
      }
      const currentSession = session;
      const currentRequest = activeRequest;
      if (
        currentRequest.flow.executionProfile ===
          "operator-command-immutable-group-v1" &&
        !handlers.immutableConsultations
      ) {
        throw new Error("Immutable group handlers unavailable");
      }
      let bridge: ReturnType<typeof compileNativeOperatorGraph>;
      try {
        bridge = compileNativeOperatorGraph(
          currentRequest.model,
          async (
            node,
            inputs,
            values,
            invocation,
          ): Promise<NativeActionResult> => {
            const result = await currentSession.effect(
              invocation.effectKey,
              node,
              async () => {
                return await handlers.handle(node, inputs, values, {
                  effectKey: invocation.effectKey,
                  contributionId: currentRequest.contribution.id,
                  inputMessageId: currentRequest.contribution.inputMessageId,
                  resumed: invocation.resume !== undefined,
                  localState: structuredClone(invocation.state.operatorData),
                });
              },
              () => handlers.assertBoundary(node),
              transportNativeEffectTarget(node, inputs),
            );
            const { localState, ...output } = result;
            // Capture only completed (or exactly replayed) effects. A declared
            // refusal lasts until the next action; a pending Request proposal
            // below lasts through its contribution.
            const operatorData = structuredClone(
              localState ?? invocation.state.operatorData,
            );
            const hadRefusal = Object.hasOwn(
              operatorData,
              "declaredConsultationRefusal",
            );
            delete operatorData.declaredConsultationRefusal;
            // A proposal still awaits its decision after later actions (including
            // a final reply) in this contribution. A successor must not inherit it.
            const retainedApprovalWait = invocation.state.operatorData
              .changeApprovalWait as NativeChangeApprovalWait | undefined;
            const hadApprovalWait = retainedApprovalWait !== undefined;
            if (
              retainedApprovalWait?.contributionId !==
                currentRequest.contribution.id
            ) {
              delete operatorData.changeApprovalWait;
            } else {
              operatorData.changeApprovalWait = structuredClone(
                retainedApprovalWait,
              );
            }
            const proposal = operatorData.changeApprovalProposal as {
              changeId?: unknown;
              proposalIntentDigest?: unknown;
            } | undefined;
            delete operatorData.changeApprovalProposal;
            const consultation = result.outputs?.consultation as {
              succeeded?: unknown;
              code?: unknown;
            } | undefined;
            const inputMessageId = currentRequest.contribution.inputMessageId;
            const repositoryVersion =
              currentRequest.model.version.repositoryVersion;
            const refused = node.mechanism === "consult_declared_source" &&
              typeof inputMessageId === "string" && inputMessageId.length > 0 &&
              inputMessageId === currentRequest.identity.subjectId &&
              typeof repositoryVersion === "string" &&
              repositoryVersion.length > 0 &&
              consultation?.succeeded === false &&
              typeof consultation.code === "string" &&
              consultation.code.length > 0 && consultation.code.length <= 128;
            if (refused) {
              const receipt: NativeDeclaredConsultationRefusal = {
                version: 1,
                identity: structuredClone(currentRequest.identity),
                contributionId: currentRequest.contribution.id,
                inputMessageId: inputMessageId!,
                modelDigest: currentRequest.model.version.digest,
                repositoryVersion: repositoryVersion!,
                flowRootId: currentRequest.flow.rootNativeId,
                flowOccurrenceId: currentRequest.flow.rootOccurrenceId,
                nodeId: node.id,
                actionId: node.nativeId,
                effectKey: invocation.effectKey,
                code: consultation!.code as string,
              };
              operatorData.declaredConsultationRefusal = receipt;
            }
            const approvalWait = node.mechanism === "submit_proposal" &&
              currentRequest.identity.scope.kind === "request" &&
              result.outputs?.submission &&
              (result.outputs.submission as { awaitingInput?: unknown })
                  .awaitingInput === true &&
              typeof inputMessageId === "string" && inputMessageId.length > 0 &&
              inputMessageId === currentRequest.identity.subjectId &&
              typeof repositoryVersion === "string" &&
              repositoryVersion.length > 0 &&
              typeof proposal?.changeId === "string" &&
              proposal.changeId.length > 0 &&
              isSha256Hex(proposal.proposalIntentDigest);
            if (approvalWait) {
              const receipt: NativeChangeApprovalWait = {
                version: 1,
                identity: structuredClone(currentRequest.identity),
                contributionId: currentRequest.contribution.id,
                inputMessageId: inputMessageId!,
                modelDigest: currentRequest.model.version.digest,
                repositoryVersion: repositoryVersion!,
                flowRootId: currentRequest.flow.rootNativeId,
                flowOccurrenceId: currentRequest.flow.rootOccurrenceId,
                nodeId: node.id,
                actionId: node.nativeId,
                effectKey: invocation.effectKey,
                changeId: proposal!.changeId as string,
                proposalIntentDigest: proposal!.proposalIntentDigest as string,
              };
              operatorData.changeApprovalWait = receipt;
            }
            return {
              ...output,
              ...(localState || hadRefusal || refused || hadApprovalWait ||
                  approvalWait
                ? { operatorData }
                : {}),
            };
          },
          {
            ...(handlers.immutableConsultations
              ? {
                immutableConsultations: {
                  plan: (node, inputs, values, invocation) =>
                    handlers.immutableConsultations!.plan(
                      node,
                      inputs,
                      values,
                      {
                        request: structuredClone(currentRequest),
                        runId: currentSession.runId,
                        action: {
                          effectKey: invocation.effectKey,
                          contributionId: currentRequest.contribution.id,
                          inputMessageId:
                            currentRequest.contribution.inputMessageId,
                          resumed: invocation.resume !== undefined,
                          localState: structuredClone(
                            invocation.state.operatorData,
                          ),
                        },
                        step: invocation.step,
                        segmentStep: invocation.segmentStep,
                      },
                    ),
                  register: (manifest) =>
                    currentSession.immutableConsultations.register(manifest),
                  member: (manifest, member, node) =>
                    currentSession.immutableConsultations.memberEffect(
                      manifest.groupId,
                      member,
                      node,
                      () =>
                        handlers.immutableConsultations!.execute(
                          manifest,
                          member,
                        ),
                      () => handlers.assertBoundary(node),
                    ),
                  join: async (manifest, outcomes) => {
                    await currentSession.assertCurrent();
                    const { publication, action } = await currentSession
                      .immutableConsultations.withPublicationFence(
                        manifest.groupId,
                        () =>
                          handlers.immutableConsultations!.publish(
                            manifest,
                            outcomes,
                          ),
                      );
                    await currentSession.immutableConsultations.publish(
                      publication,
                    );
                    const { localState, ...result } = action;
                    return {
                      ...result,
                      ...(localState ? { operatorData: localState } : {}),
                    };
                  },
                },
              }
              : {}),
            effectNamespace: currentSession.runId,
            scope: currentRequest.identity.scope,
            operatorId: currentRequest.identity.operatorId,
            flow: currentRequest.flow,
            maxSteps: currentRequest.maxSteps,
            checkpointer: currentSession.checkpointer,
            store: this.store,
            assertBoundary: async (_state, _node) => {
              // Exact completed receipts may reconstruct an old prepared result;
              // only a fresh operation enters the current business admission above.
              await currentSession.assertCurrent();
            },
            assertTechnicalBoundary: () => currentSession.assertCurrent(),
            // R4b order per item: the session commits the observation in its
            // own fenced transaction, then the unchanged business callback is
            // awaited under the selection fence. A callback failure retains
            // the committed prefix; replay re-verifies and re-awaits it.
            onObservation: async (emission) => {
              await currentSession.nativeObservations.append(emission);
              await currentSession.withSelectionFence(() =>
                handlers.onEvent(emission.event)
              );
            },
            shouldAwait: () => handlers.shouldAwait?.() ?? true,
            resolveValues: handlers.resolveValues,
          },
        );
      } catch (error) {
        await currentSession.fail(error);
        throw error;
      }
      const config = {
        ...(currentSession.signal ? { signal: currentSession.signal } : {}),
        configurable: {
          thread_id: currentSession.threadId,
          checkpoint_ns: "",
          ...(currentSession.checkpointId
            ? { checkpoint_id: currentSession.checkpointId }
            : {}),
        },
      };
      try {
        await currentSession.assertCurrent();
        const previous = await bridge.graph.getState(config);
        const pendingTechnical = previous.tasks.some((task) =>
          (task.interrupts ?? []).some((item) =>
            (item.value as { kind?: string })?.kind === "native-model-advance"
          )
        );
        let checkpoint = previous;
        if (!pendingTechnical) {
          const consumed = await currentSession.contributionConsumed();
          const interrupted = previous.tasks.some((task) =>
            (task.interrupts?.length ?? 0) > 0
          );
          const fresh = !previous.values ||
            !Object.keys(previous.values).length;
          // A ledger successor created by retiring a proven empty input wait
          // has no checkpoint yet: its first wake starts from canonical
          // business state. A session that names an exact checkpoint must
          // still find it, or the continuation is genuinely absent.
          if (
            (currentRequest.networkAdoptionContinuation ||
              currentRequest.teamAdoptionContinuation) && fresh
          ) {
            throw new Error(
              "A Request network adoption cannot initialize a fresh graph",
            );
          }
          if (
            fresh && currentRequest.contribution.kind === "resume" &&
            currentSession.checkpointId
          ) {
            throw new Error(
              "The exact native continuation checkpoint is absent",
            );
          }
          const input =
            (interrupted || currentSession.forceResumeWait) && !consumed
              ? new Command({
                resume: { contributionId: currentRequest.contribution.id },
              })
              : !fresh && previous.next.length
              ? null
              : {
                ...bridge.initialState(),
                acceptedContributionIds: [currentRequest.contribution.id],
                waitConsumptions: [
                  {
                    version: 1,
                    kind: "input-v1",
                    contributionId: currentRequest.contribution.id,
                  } satisfies NativeWaitConsumptionEvidence,
                ],
              };
          let finalConfig = config;
          if (!(interrupted && consumed)) {
            const stream = await bridge.graph.stream(input, {
              ...config,
              streamMode: "checkpoints",
              durability: "sync",
            });
            for await (const saved of stream) {
              finalConfig = saved.config as typeof config;
            }
            await currentSession.assertCurrent();
            checkpoint = await bridge.graph.getState(finalConfig);
          }
        }
        const state = checkpoint.values as NativeState;
        const technical = checkpoint.tasks.flatMap((task) =>
          task.interrupts ?? []
        ).map((item) =>
          item.value as {
            kind?: string;
            preparedNodeId?: string;
            settledEffectKey?: string;
            evidence?: NativeModelAdvanceEvidence;
          }
        ).find((value) => value?.kind === "native-model-advance");
        if (technical) {
          if (
            !technical.evidence || !technical.preparedNodeId ||
            !technical.settledEffectKey ||
            !checkpoint.config?.configurable?.checkpoint_id ||
            !handlers.readAdoptedModel
          ) {
            throw new Error(
              "The native model advance lacks exact source checkpoint evidence",
            );
          }
          const targetModel = await handlers.readAdoptedModel();
          if (
            canonical({
              identity: targetModel.identity,
              version: targetModel.version,
            }) !== canonical(technical.evidence.to)
          ) {
            throw new Error(
              "The current adopted model differs from the publication receipt",
            );
          }
          const targetFlow = [
            targetModel.flows.conversation,
            targetModel.flows.promotion,
            ...Object.values(targetModel.caseFlows ?? {}),
          ].find((flow) =>
            flow.rootOccurrenceId === currentRequest.flow.rootOccurrenceId
          );
          if (!targetFlow) {
            throw new Error("The publication removed the selected native flow");
          }
          const target: NativeExecutionRequest = {
            ...currentRequest,
            businessRevision: technical.evidence.businessRevision,
            model: targetModel,
            flow: targetFlow,
          };
          const source: NativeContinuationReceipt["source"] = {
            threadId: currentSession.threadId,
            checkpointNamespace: currentSession.checkpointNamespace,
            checkpointId: String(checkpoint.config.configurable.checkpoint_id),
            preparedNodeId: technical.preparedNodeId,
            settledEffectKey: technical.settledEffectKey,
          };
          const advanced = await currentSession.advance(
            { source, evidence: technical.evidence, target },
            (saver, sourceConfig) =>
              this.forkNativeRun(saver, sourceConfig, target, source),
          );
          session = advanced.session;
          activeRequest = target;
          await handlers.modelAdvanced?.(targetModel);
          continue;
        }
        const waits: NativeExecutionSnapshot["waits"] = [];
        for (const task of checkpoint.tasks) {
          for (const item of task.interrupts ?? []) {
            const value = item.value as { nodeId?: string; kind?: string };
            const node = currentRequest.flow.nodes.find((node) =>
              node.id === value?.nodeId
            );
            if (
              !node ||
              ![
                "native-await-input",
                "native-budget-wait",
                "native-decision-wait",
                "native-contribution-wait",
              ].includes(value.kind ?? "")
            ) {
              throw new Error(
                "Framework wait is outside the admitted native flow",
              );
            }
            waits.push({
              nodeId: node.id,
              mechanism: node.mechanism,
              kind: value.kind === "native-await-input"
                ? "input"
                : value.kind === "native-decision-wait"
                ? "decision"
                : value.kind === "native-contribution-wait"
                ? "contribution"
                : "budget",
            });
          }
        }
        if (
          state.modelPin.version.digest !== currentRequest.model.version.digest
        ) {
          throw new Error(
            "Framework checkpoint does not match the admitted model",
          );
        }
        const continuationSource = nativeBudgetContinuationSource(state, waits);
        const prepared = state.prepared;
        const snapshot: NativeExecutionSnapshot = {
          runId: currentSession.runId,
          checkpointNamespace: currentSession.checkpointNamespace,
          ...(continuationSource
            ? { budgetContinuationSource: continuationSource }
            : {}),
          ...(waits.length === 1 && waits[0].kind === "decision" &&
              waits[0].mechanism === "decide_admission" &&
              prepared?.nodeId === waits[0].nodeId &&
              prepared.result.suspend &&
              prepared.result.suspensionKind === "decision" &&
              !prepared.result.modelAdvance
            ? {
              initialAdmissionSource: {
                occurrenceId: prepared.nodeId,
                actionId: currentRequest.flow.nodes.find((node) =>
                  node.id === prepared.nodeId
                )!.nativeId,
                preparedNodeId: nativeFrameworkNodeName(
                  prepared.nodeId,
                  "await-preparation",
                ),
                settledEffectKey: prepared.effectKey,
              },
            }
            : {}),
          contributionId: currentRequest.contribution.id,
          identity: structuredClone(currentRequest.identity),
          threadId: currentSession.threadId,
          modelDigest: currentRequest.model.version.digest,
          ...(currentRequest.model.version.repositoryVersion
            ? {
              repositoryVersion: currentRequest.model.version.repositoryVersion,
            }
            : {}),
          flowRootId: currentRequest.flow.rootNativeId,
          status: waits.length
            ? "waiting"
            : checkpoint.next.length
            ? "running"
            : "completed",
          checkpointId: checkpoint.config?.configurable?.checkpoint_id,
          waits,
          unsettledEffects: await currentSession.unsettledEffects(),
          openImmutableConsultationGroups:
            (await currentSession.immutableConsultations.pending()).map((
              group,
            ) => group.groupId),
          pendingContributions: handlers.pendingContributions?.() ?? [],
          localState: Object.fromEntries(
            [
              "reply",
              "promotionId",
              "declaredConsultationRefusal",
              "changeApprovalWait",
            ].filter((
              key,
            ) => state.operatorData[key] !== undefined)
              .map((key) => [key, structuredClone(state.operatorData[key])]),
          ),
        };
        await currentSession.complete(snapshot);
        return snapshot;
      } catch (error) {
        await currentSession.fail(error);
        throw error;
      }
    }
    throw new Error(
      "The admitted contribution exceeded its technical model-advance limit",
    );
  }

  private async forkRequestNetworkAdoption(
    saver: BaseCheckpointSaver,
    config: LangGraphRunnableConfig,
    target: NativeExecutionRequest,
    sourceProtocol?: string,
  ): Promise<LangGraphRunnableConfig> {
    const intent = (target.networkAdoptionContinuation ??
      target.teamAdoptionContinuation)!;
    if (
      target.identity.scope.kind !== "request" ||
      target.identity.purpose !== "conversation"
    ) {
      throw new Error(
        "Only the exact Request conversation can resume its network adoption",
      );
    }
    if (
      config.configurable?.thread_id !== intent.successorThreadId ||
      config.configurable?.checkpoint_id !== intent.checkpointId ||
      (config.configurable?.checkpoint_ns ?? "") !== ""
    ) {
      throw new Error(
        "The Request network fork must read its exact historical checkpoint",
      );
    }
    const graph = compileNativeOperatorGraph(target.model, () => {
      throw new Error("A Request network fork cannot execute a primitive");
    }, {
      scope: target.identity.scope,
      operatorId: target.identity.operatorId,
      flow: target.flow,
      maxSteps: target.maxSteps,
      checkpointer: saver,
      store: this.store,
      assertBoundary: () => {
        throw new Error("A Request network fork cannot execute a node");
      },
    });
    const sourceTuple = await saver.getTuple(config);
    if (!sourceTuple) {
      throw new Error(
        "The retained Request network approval checkpoint source tuple is unavailable",
      );
    }
    const source = await graph.graph.getState(config);
    const retained = (source.values ?? {}) as Partial<NativeState>;
    const wait = target.flow.nodes.find((node) =>
      node.id === retained.prepared?.nodeId && node.mechanism === "await_input"
    );
    const receipt = retained.operatorData?.changeApprovalWait as
      | Partial<NativeChangeApprovalWait>
      | undefined;
    if (
      !wait ||
      source.config?.configurable?.checkpoint_id !== intent.checkpointId ||
      canonical(source.next) !==
        canonical([nativeFrameworkNodeName(wait.id)]) ||
      retained.prepared?.result.suspend !== true ||
      retained.prepared.result.modelAdvance ||
      retained.prepared.result.suspensionKind || retained.immutableGroup ||
      !retained.modelPin ||
      canonical(retained.modelPin.identity) !==
        canonical(target.model.identity) ||
      canonical(retained.executionScope) !== canonical(target.identity.scope) ||
      retained.rootRequestId !== target.identity.scope.rootRequestId ||
      retained.operatorId !== target.identity.operatorId ||
      !receipt || receipt.version !== 1 ||
      typeof receipt.effectKey !== "string" || !receipt.effectKey ||
      receipt.changeId !== intent.changeId ||
      receipt.proposalIntentDigest !== intent.proposalIntentDigest ||
      receipt.inputMessageId !== intent.originalInputMessageId ||
      canonical(receipt.identity) !== canonical(target.identity) ||
      receipt.modelDigest !== retained.modelPin.version.digest ||
      receipt.repositoryVersion !==
        retained.modelPin.version.repositoryVersion ||
      receipt.flowRootId !== target.flow.rootNativeId ||
      receipt.flowOccurrenceId !== target.flow.rootOccurrenceId
    ) {
      throw new Error(
        "The exact settled Request network approval checkpoint is unavailable",
      );
    }
    const { version: _oldVersion, ...oldContract } = retained.modelPin;
    const { version: _targetVersion, ...newContract } = graph.metadata.modelPin;
    if (canonical(oldContract) !== canonical(newContract)) {
      throw new Error(
        "The Request network fork changed its native flow identity",
      );
    }
    // The network bytes are historical; a team continuation names its own.
    const continuationRef = `request-${
      target.teamAdoptionContinuation ? "team" : "network"
    }-adoption:${intent.receiptDigest}`;
    const forked = await graph.graph.updateState(config, {
      modelPin: graph.metadata.modelPin,
      continuationRef,
    }, nativeFrameworkNodeName(wait.id, "await-preparation"));
    const after = await graph.graph.getState(forked),
      values = after.values as Partial<NativeState>;
    if (
      forked.configurable?.thread_id !== intent.successorThreadId ||
      !forked.configurable?.checkpoint_id ||
      forked.configurable.checkpoint_id === intent.checkpointId ||
      canonical(after.next) !== canonical([nativeFrameworkNodeName(wait.id)]) ||
      values.continuationRef !== continuationRef ||
      canonical(values.modelPin) !== canonical(graph.metadata.modelPin)
    ) {
      throw new Error(
        "The Request network fork did not retain its exact await-input destination",
      );
    }
    const targetTuple = await saver.getTuple(forked);
    if (!targetTuple) {
      throw new Error(
        "The retained Request network target tuple is unavailable",
      );
    }
    verifyOfficialFork(sourceTuple, targetTuple, {
      modelPin: graph.metadata.modelPin,
      continuationRef,
    }, sourceProtocol);
    return forked;
  }

  private async forkInitialAdmission(
    saver: BaseCheckpointSaver,
    config: LangGraphRunnableConfig,
    target: NativeExecutionRequest,
  ): Promise<LangGraphRunnableConfig> {
    const intent = target.initialAdmissionTransfer!;
    const graph = compileNativeOperatorGraph(target.model, () => {
      throw new Error("An initial admission fork cannot execute a primitive");
    }, {
      scope: target.identity.scope,
      operatorId: target.identity.operatorId,
      flow: target.flow,
      maxSteps: target.maxSteps,
      checkpointer: saver,
      store: this.store,
      assertBoundary: () => {
        throw new Error("An initial admission fork cannot execute a node");
      },
    });
    return await graph.graph.updateState(config, {
      executionScope: structuredClone(target.identity.scope),
      rootRequestId: intent.target.caseId,
      continuationRef: intent.key,
    }, intent.source.preparedNodeId);
  }

  private async forkNativeRun(
    saver: BaseCheckpointSaver,
    sourceConfig: LangGraphRunnableConfig,
    target: NativeExecutionRequest,
    source: NativeContinuationReceipt["source"],
  ): Promise<LangGraphRunnableConfig> {
    const fork = compileNativeOperatorGraph(target.model, () => {
      throw new Error("A checkpoint fork must not run a business primitive");
    }, {
      scope: target.identity.scope,
      operatorId: target.identity.operatorId,
      flow: target.flow,
      maxSteps: target.maxSteps,
      checkpointer: saver,
      store: this.store,
      assertBoundary: () => {
        throw new Error("A checkpoint fork must not execute a native node");
      },
    });
    return await fork.graph.updateState(sourceConfig, {
      modelPin: fork.metadata.modelPin,
      continuationRef: `${source.threadId}:${source.checkpointId}`,
    }, source.preparedNodeId);
  }

  inspect(
    operatorId: string,
    selection?: NativeExecutionSelection,
  ): Promise<NativeExecutionSnapshot[]> {
    return this.ledger.inspect(operatorId, selection);
  }

  ownsCandidateRecoveryContribution(input: {
    snapshot: NativeExecutionSnapshot;
    acceptedDigest: string;
  }): Promise<boolean> {
    return this.ledger.ownsCandidateRecoveryContribution?.(input) ??
      Promise.resolve(false);
  }

  closeScope(
    snapshot: NativeExecutionSnapshot,
    closure: NativeScopeClosure,
  ): Promise<void> {
    if (
      snapshot.identity.scope.kind !== "request" ||
      snapshot.identity.scope.scopeId !== closure.caseId ||
      snapshot.unsettledEffects.length
    ) {
      return Promise.reject(
        new Error("The native execution has no exact settled Request closure"),
      );
    }
    return this.ledger.closeScope(snapshot, closure);
  }

  retireAndAdvance(
    snapshot: NativeExecutionSnapshot,
    authorization: NativeThreadAdvanceAuthorization,
    targetModel: ExecutableModel,
  ): Promise<void> {
    if (
      snapshot.status !== "waiting" || snapshot.unsettledEffects.length ||
      !snapshot.waits.length ||
      snapshot.waits.some((wait) => wait.kind !== "input")
    ) {
      return Promise.reject(
        new Error("Only a proven empty native input wait can retire"),
      );
    }
    return this.ledger.retireAndAdvance(snapshot, authorization, targetModel);
  }
}
