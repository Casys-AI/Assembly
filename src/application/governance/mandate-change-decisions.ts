import {
  assertRequestChange,
  requestChangeProposalDigest,
} from "../../domain/governance/records/request-change.ts";
import { nativePromotionDependencies } from "../work/native-execution/model-advance.ts";
import type { NativeExecutionPort } from "../work/native-execution/contract.ts";
import type { NativeExecutionContribution } from "../work/native-execution/contract.ts";
import {
  activeBatchCall,
  cancelQueuedAfterTeamPublication,
} from "../work/conversation/batches.ts";
import {
  isTeamOperatorSpec,
  OperatorAuthorityError,
} from "../../domain/governance/operator-authority.ts";
import {
  assertCreationWithinPolicy,
  creationMode,
} from "../../domain/governance/policies/operator-creation-policy.ts";
import type { DelegatedActor } from "../../domain/governance/policies/operator-authority-policy.ts";
import {
  caseExecutionContext,
  designerExecutionContext,
  selectCaseInvocation,
} from "../work/cases/runtime.ts";
import {
  changeCaseInvocation,
  changeWorkReceipt,
  invocationInput,
  invocationKey,
  type OperatorWorkCompletion,
  type OperatorWorkMessageRange,
  recordedWorkCompletion,
  workReceipt,
} from "../work/operators/journal.ts";
import type { OperatorWorkReceipt } from "../../domain/work/execution/case-context.ts";
import { isRequestTeamMember } from "../../domain/work/request-spaces.ts";
import { OperatorConversationError } from "../work/operators/conversations.ts";
import { CaseError } from "../../domain/work/errors/case.ts";
import { canonical } from "../../domain/primitives/canonical-json.ts";
import {
  assertApprovable,
  assertChangeAuthorityReceipt,
  ChangeApprovabilityError,
} from "../../domain/governance/policies/change-approvability.ts";
import {
  type ApprovedChangePublication,
  assertPublicationMatches,
  changePublication,
  ChangePublicationError,
  publicationFailure,
} from "../../domain/model/publication/change.ts";
import {
  ChangeScopeMissingError,
  SystemGovernance,
} from "../../domain/governance/policies/governance.ts";
import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";
import type {
  ChatDecision,
  Event,
  SystemRuntimeState,
} from "../../domain/work/dialogue.ts";
import type {
  PendingChange,
} from "../../domain/governance/records/pending-change.ts";
import type {
  SystemConfiguration,
} from "../../domain/governance/records/system-configuration.ts";
import type { MandateChangeModelPort } from "./ports/out/mandate-change-model.port.ts";
import { type ClockPort, creationScopeOf } from "../work/runtime/ports.ts";
import type { CreationScope } from "../../domain/governance/policies/operator-creation-policy.ts";
import { makeEvent, valueDigest } from "../work/runtime/values.ts";

export interface MandateChangeHost {
  readonly state: SystemRuntimeState;
  readonly ports: {
    clock: ClockPort;
    model: MandateChangeModelPort;
    execution?: Pick<NativeExecutionPort, "inspect">;
  };
  update(change: (state: SystemRuntimeState) => void): Promise<void>;
  feedback(text: string): Promise<void>;
  control(
    action: () => Promise<void>,
    onSettled?: undefined,
    preserveStatus?: boolean,
  ): Promise<void>;
  currentModel(): Promise<ExecutableModel>;
  adopt(
    native: ExecutableModel,
    changes?: SystemConfiguration["changes"],
    event?: Event,
    onAdopt?: (state: SystemRuntimeState) => void,
  ): Promise<void>;
  runTurn(
    onReply?: (reply: Extract<ChatDecision, { kind: "reply" }>) => void,
    contribution?: NativeExecutionContribution,
  ): Promise<void>;
  workCompletion?(
    work: OperatorWorkReceipt,
    bounds: {
      messageRanges: OperatorWorkMessageRange[];
      candidateIds: string[];
      approvedChange?: PendingChange;
    },
  ): Promise<OperatorWorkCompletion>;
  /** Wakes the caller of a delegated work once its completion is journalled. */
  notifyWorkCompletion?(
    work: OperatorWorkReceipt,
    completion: OperatorWorkCompletion,
  ): Promise<void>;
  isPrimaryOperator?(model: ExecutableModel): boolean;
  canOpenOperatorRequests?(): boolean;
  /** Bound for the registered Main only (4.8d D4): the execution space of an
   * open Request Case of this system, validating its admitted recipients. */
  recipientSpaceFor?(
    caseId: string,
    recipients: readonly string[],
  ): Promise<string>;
  changeProposed?(change: PendingChange): Promise<void>;
  changeApproved?(change: PendingChange): Promise<void>;
  /** Edge hook for best-effort recovery-notice failures; never throws. */
  onNoticeError?(detail: {
    changeId: string;
    status: string;
    error: unknown;
  }): void;
}

/** The creation scope this host's runtime states: branch for a Request
 * space runtime (with its recorded whole-team size), main otherwise. */
function hostCreationScope(host: MandateChangeHost): CreationScope {
  return creationScopeOf(
    host.ports.model,
    host.state.executionModel!.identity,
  );
}

type PublicationHost = Pick<
  MandateChangeHost,
  "state" | "ports" | "update" | "adopt"
>;

/** This publication/recovery belongs to the Case coordinator, never Main's generic adopt. */
function scopedRequestChange(
  host: PublicationHost,
  change: PendingChange,
): boolean {
  const scope = host.ports.model.requestChangeScope;
  if (!scope) return false;
  assertRequestChange(change);
  if (
    change.caseId !== scope.caseId || change.requestedBy !== scope.operatorId
  ) {
    throw new ChangePublicationError("PUBLICATION_NOT_APPLICABLE", {
      changeId: change.id,
    }, "The Request change belongs to another exact owner or Case.");
  }
  return true;
}

function withoutJournal(change: PendingChange): PendingChange {
  const { publication: _legacy, ...record } = change;
  return record;
}

async function findPublication(host: PublicationHost, changeId: string) {
  if (!host.ports.model.findApprovedChange) {
    throw new ChangePublicationError("PUBLICATION_RECEIPT_MISSING", {
      changeId,
    }, "Le dépôt doit fournir la recherche exhaustive de publication.");
  }
  try {
    return await host.ports.model.findApprovedChange(
      host.state.model!,
      changeId,
    );
  } catch (error) {
    throw publicationFailure(error, {
      changeId,
      systemId: host.state.model!.systemId,
    }, "retry");
  }
}

function decisionCompletedEvent(
  clock: ClockPort,
  change: PendingChange,
  adopted: boolean,
): Event {
  return {
    ...makeEvent(
      clock,
      adopted
        ? change.kind === "mandate-change"
          ? "mandate-revised"
          : "reviewer-created"
        : "configuration-change-completed",
      `Publication vérifiée : ${change.id}`,
    ),
    changeId: change.id,
    authorityExercise: change.authorityExercise,
  };
}

/** Record the approval atomically with its completion, when still completing. */
function recordApprovalIfCompleting(
  clock: ClockPort,
  state: SystemRuntimeState,
  changeId: string,
  adopted: boolean,
): void {
  const entry = state.configuration!.changes.find((candidate) =>
    candidate.id === changeId
  )!;
  if (entry.status === "pending" && entry.publishedCommit) {
    entry.status = "approved";
    state.events.push(decisionCompletedEvent(clock, entry, adopted));
  }
}

/** One state write adopts the publication pin; the approval itself is recorded
 * atomically with the dialogue completion, except for legacy attestations
 * without a dialogue origin, which complete here as before. */
async function completePublication(
  host: PublicationHost,
  change: PendingChange,
  published: ApprovedChangePublication,
): Promise<boolean> {
  if (host.ports.model.requestChangeScope) {
    throw new ChangePublicationError("PUBLICATION_NOT_APPLICABLE", {
      changeId: change.id,
    }, "Request publications require their atomic scoped coordinator.");
  }
  const { model, receipt } = published;
  const legacy = change.status === "approved" ? change.publication : undefined;
  if (
    !receipt &&
    (!legacy || !change.authorityExercise || !change.decidedAt ||
      change.authority !== "human")
  ) {
    throw new ChangePublicationError("PUBLICATION_RECEIPT_MISSING", {
      changeId: change.id,
    }, "Le commit de publication ne contient pas de reçu d’approbation.");
  }
  if (receipt) assertPublicationMatches(change, receipt);
  const authority = receipt?.authorityExercise ?? change.authorityExercise!;
  if (
    authority.systemId !== host.state.model!.systemId ||
    authority.authoritySchema !== 2 || authority.action !== "mandate-change" ||
    authority.outOfMandate !== false ||
    change.baseModelDigest !== undefined &&
      authority.baseModelDigest !== change.baseModelDigest
  ) {
    throw new ChangePublicationError("PUBLICATION_RECEIPT_MISMATCH", {
      changeId: change.id,
      systemId: host.state.model!.systemId,
    }, "Le reçu publié ne porte pas l’autorité de cette évolution.");
  }
  if (
    legacy?.applied && (
      legacy.applied.version.digest !== model.version.digest ||
      legacy.applied.version.repositoryVersion !==
        model.version.repositoryVersion
    )
  ) {
    throw new ChangePublicationError("PUBLICATION_RECEIPT_MISMATCH", {
      changeId: change.id,
    }, "La publication diffère du reçu historique.");
  }
  // Old commits carry their exact author but no trailer. Only their already
  // recorded decision may migrate; no authority is issued during recovery.
  const completed = withoutJournal(change);
  // Only a fresh approval still pending in state defers its recording to the
  // atomic completion; already-recorded and legacy attestations complete here.
  const recorded = host.state.configuration!.changes.find((entry) =>
    entry.id === change.id
  );
  const immediate = !change.requestedBy || recorded?.status === "approved";
  completed.status = immediate ? "approved" : "pending";
  completed.publishedCommit = model.version.repositoryVersion;
  if (receipt) {
    completed.authorityExercise = structuredClone(receipt.authorityExercise);
    completed.baseModelDigest = receipt.baseModelDigest;
    completed.decidedAt = receipt.decidedAt;
    completed.authority = receipt.authorityExercise.delegation ||
        receipt.authorityExercise.creationDelegation
      ? "builder"
      : "human";
  }
  const pin = receipt?.adoptedPin ?? {
    digest: change.baseModelDigest,
    repositoryVersion: legacy
      ? legacy.adoptionBaseRepositoryVersion ?? legacy.baseRepositoryVersion
      : undefined,
  };
  const changes = host.state.configuration!.changes.map((entry) =>
    entry.id === change.id ? completed : structuredClone(entry)
  );
  const alreadyAdopted =
    host.state.executionModel!.version.digest === model.version.digest &&
    host.state.executionModel!.version.repositoryVersion ===
      model.version.repositoryVersion;
  const adopt = !alreadyAdopted &&
    host.state.executionModel!.version.digest === pin.digest &&
    host.state.executionModel!.version.repositoryVersion ===
      pin.repositoryVersion;
  if (immediate) {
    const event = decisionCompletedEvent(host.ports.clock, completed, adopt);
    if (adopt) {
      const teamPublication = receipt && change.kind === "operator-creation" &&
        change.operator && isTeamOperatorSpec(change.operator) &&
        change.teamOrigin && receipt.authorityExercise.creationDelegation &&
        change.caseId === change.teamOrigin.requestId;
      await host.adopt(
        model,
        changes,
        event,
        teamPublication
          ? (state) =>
            cancelQueuedAfterTeamPublication(
              state,
              change.id,
              pin.digest!,
              change.teamOrigin!.requestId,
            )
          : undefined,
      );
    } else {
      await host.update((s) => {
        s.configuration!.changes = changes;
        s.events.push(event);
      });
    }
    return !adopt;
  }
  if (alreadyAdopted) return false;
  if (adopt) {
    const teamPublication = receipt && change.kind === "operator-creation" &&
      change.operator && isTeamOperatorSpec(change.operator) &&
      change.teamOrigin && receipt.authorityExercise.creationDelegation &&
      change.caseId === change.teamOrigin.requestId;
    await host.adopt(
      model,
      changes,
      undefined,
      teamPublication
        ? (state) =>
          cancelQueuedAfterTeamPublication(
            state,
            change.id,
            pin.digest!,
            change.teamOrigin!.requestId,
          )
        : undefined,
    );
  } else {
    await host.update((s) => {
      s.configuration!.changes = changes;
    });
  }
  return !adopt;
}

/** Called at startup and before every proposal/decision, under the runtime queue. */
export async function reconcileChangePublications(
  this: PublicationHost,
): Promise<void> {
  for (const change of this.state.configuration?.changes ?? []) {
    if (scopedRequestChange(this, change)) continue;
    const legacy = change.status === "approved"
      ? change.publication
      : undefined;
    if (change.status !== "pending" && (!legacy || legacy.completed)) continue;
    const published = await findPublication(this, change.id);
    if (published) await completePublication(this, change, published);
    else if (legacy) {
      const pending = withoutJournal(change);
      pending.status = "pending";
      delete pending.authorityExercise;
      delete pending.authority;
      delete pending.decidedAt;
      await this.update((s) => {
        s.configuration!.changes = s.configuration!.changes.map((entry) =>
          entry.id === change.id ? pending : entry
        );
      });
    }
  }
}

/** The registered Main retains legacy creation; team creation uses a prior grant. */
function requireRegisteredDesigner(
  host: MandateChangeHost,
  change:
    | PendingChange
    | Extract<
      ChatDecision,
      { kind: "propose_mandate_change" | "propose_agent_creation" }
    >,
): void {
  const creation = change.kind === "operator-creation" ||
    change.kind === "propose_agent_creation" && change.role === "operator";
  const authority = "requestedRights" in change && !!change.requestedRights &&
    ("operatorAuthority" in change.requestedRights ||
      "toolAdmission" in change.requestedRights);
  if (!creation && !authority) return;
  if (
    creation && "operator" in change && change.operator &&
    isTeamOperatorSpec(change.operator)
  ) {
    if (!host.canOpenOperatorRequests?.()) {
      throw new ChangeApprovabilityError(
        "PROPOSAL_NOT_AUTHORIZED",
        "The team creation host is unavailable",
        { systemId: host.state.model!.systemId },
      );
    }
    assertCreationWithinPolicy(
      host.state.executionModel!,
      change.operator,
      undefined,
      hostCreationScope(host),
    );
    return;
  }
  if (
    !host.isPrimaryOperator?.(host.state.executionModel!) ||
    creation && !host.canOpenOperatorRequests?.()
  ) {
    throw new ChangeApprovabilityError(
      "PROPOSAL_NOT_AUTHORIZED",
      creation
        ? "Request operator creation requires the registered Main Operator and its opening service"
        : "Operator authority requires the registered Main Operator",
      {
        systemId: host.state.model!.systemId,
        ...("id" in change ? { changeId: change.id } : {}),
      },
    );
  }
}

/** A delegated policy names a recipient Case; the Main's host derives its
 * space from the Case's verified opening. Only the space is stored. Applied
 * where a proposal enters the host, before it is judged (4.8d D4). */
export async function withRecipientSpace(
  host: Pick<MandateChangeHost, "recipientSpaceFor">,
  decision: Extract<
    ChatDecision,
    { kind: "propose_mandate_change" | "propose_agent_creation" }
  >,
): Promise<typeof decision> {
  if (decision.kind !== "propose_mandate_change") return decision;
  const rights = decision.requestedRights;
  const key = "operatorAuthority" in rights
    ? "operatorAuthority"
    : "toolAdmission" in rights
    ? "toolAdmission"
    : undefined;
  if (!key) return decision;
  const { recipientCaseId, ...request } = (rights as unknown as Record<
    string,
    { recipientCaseId?: string; recipients: string[] }
  >)[key];
  if (recipientCaseId === undefined) return decision;
  if (!host.recipientSpaceFor) {
    throw new OperatorAuthorityError(
      "INVALID_AUTHORITY_POLICY",
      "Only the registered Main Operator may name a recipient Case",
      { recipientCaseId },
    );
  }
  const recipientExecutionSpaceId = await host.recipientSpaceFor(
    recipientCaseId,
    request.recipients,
  );
  return {
    ...decision,
    requestedRights: {
      [key]: { ...request, recipientExecutionSpaceId },
    } as unknown as typeof decision.requestedRights,
  };
}

/** A persisted proposal's current state, read after its notification completes. */
export interface ChangeProposalReceipt {
  status: PendingChange["status"];
  changeId: string;
  proposalIntentDigest?: string;
}

export async function proposeChange(
  this: MandateChangeHost,
  decision: Extract<
    ChatDecision,
    { kind: "propose_mandate_change" | "propose_agent_creation" }
  >,
): Promise<ChangeProposalReceipt> {
  await reconcileChangePublications.call(this);
  requireRegisteredDesigner(this, decision);
  const governance = SystemGovernance.fromExecutable(
    this.state.executionModel!,
    this.state.configuration!.changes,
    hostCreationScope(this),
  );
  const caseId = caseExecutionContext(this.state)?.caseId;
  const designerScopeId = designerExecutionContext(this.state)?.scopeId;
  if (!caseId && !designerScopeId) {
    throw new CaseError(
      "CASE_SCOPE_MISSING",
      "A change requires an explicit invocation scope",
      {
        agentId: this.state.executionModel!.identity.builderId,
        conversationId: this.state.id,
      },
      "Select an open Request or the recorded Main Operator invocation before proposing a change.",
    );
  }
  // A recipient Case was resolved where the proposal entered the host
  // (submitProposal); an unresolved one is refused by the policy validator.
  const change = governance.propose(
    decision,
    crypto.randomUUID(),
    this.ports.clock.now(),
    {
      requestedBy: this.state.executionModel!.identity.builderId,
      ...(caseId ? { caseId } : { designerScopeId: designerScopeId! }),
    },
  );
  if (change.operator && isTeamOperatorSpec(change.operator)) {
    const context = caseExecutionContext(this.state);
    const ownerId = context?.record?.owner ?? context?.budget?.ownerId;
    const team = this.state.executionModel!.operatorTeam;
    const scope = this.ports.model.requestChangeScope;
    if (
      !context || context.caseId !== caseId || !ownerId ||
      team &&
        (team.requestOwnerId !== ownerId ||
          (scope
            ? !isRequestTeamMember(
              this.state.executionModel!.identity.builderId,
              scope,
            )
            : team.requestId !== context.caseId))
    ) {
      throw new CaseError(
        "CASE_SCOPE_MISSING",
        "A team member requires an active Request",
      );
    }
    change.teamOrigin = { operatorId: ownerId, requestId: context.caseId };
  }
  change.diff = await this.ports.model.previewApprovedChange(
    this.state.model!,
    change,
    this.state.executionModel!.version.digest,
  );
  await this.update((s) => {
    s.configuration = governance.snapshot;
    s.configuration.changes = s.configuration.changes.map((entry) =>
      entry.id === change.id ? structuredClone(change) : entry
    );
    const active = activeBatchCall(s);
    if (
      change.operator && isTeamOperatorSpec(change.operator) && active &&
      active.call.status === "started" && active.call.effectStarted &&
      active.call.decision.kind === "propose_agent_creation" &&
      canonical(active.call.decision) === canonical(decision) &&
      active.batch.caseId === caseId
    ) active.call.changeId = change.id;
    (s.changeDecisionContinuations ??= {})[change.id] = "pending";
    const input = invocationInput(s);
    const receipt = input && workReceipt(input);
    if (
      receipt && s.caseInvocation &&
      (s.caseInvocation.kind === "delegated" ||
        s.caseInvocation.kind === "delegated-designer")
    ) {
      (s.changeWorkContinuations ??= {})[change.id] = {
        inputMessageId: input!.id,
        invocationKey: invocationKey(s.caseInvocation),
      };
    }
    s.events.push(
      makeEvent(
        this.ports.clock,
        "configuration-change-proposed",
        `${change.kind} : ${change.reason}`,
      ),
    );
  });
  if (
    change.operator && isTeamOperatorSpec(change.operator) &&
    !this.ports.model.requestChangeScope
  ) {
    let routed = false;
    try {
      const grant = assertCreationWithinPolicy(
        this.state.executionModel!,
        change.operator,
        undefined,
        hostCreationScope(this),
      );
      // Per-creation: no self-approval. The recorded change stays pending
      // and follows the ordinary routed decision below.
      routed = creationMode(grant) === "per-creation";
      if (!routed) {
        await decideChange.call(this, {
          changeId: change.id,
          expectedRevision: change.baseRevision,
          verdict: "approve",
        }, {
          actorId: this.state.executionModel!.identity.builderId,
          policyId: grant.id,
          policyRevision: grant.revision,
        }, { insideTurn: true });
      }
    } catch (error) {
      const recorded = this.state.configuration!.changes.find((entry) =>
        entry.id === change.id
      )!;
      try {
        await this.feedback(
          `Team creation did not finish. Proposal ${recorded.id} remains recorded as ${recorded.status}; inspect its exact diff and publication receipt before retrying.`,
        );
        if (recorded.status === "pending" && !recorded.publishedCommit) {
          await this.changeProposed?.(structuredClone(recorded));
        }
      } catch (notificationError) {
        // A failed notice cannot replace the original publication/authority cause.
        try {
          this.onNoticeError?.({
            changeId: recorded.id,
            status: recorded.status,
            error: notificationError,
          });
        } catch { /* The edge hook must never replace the original cause. */ }
      }
      throw error;
    }
    if (!routed) {
      const recorded = this.state.configuration!.changes.find((entry) =>
        entry.id === change.id
      )!;
      return { status: recorded.status, changeId: recorded.id };
    }
  }
  await this.changeProposed?.(change);
  const recorded = this.state.configuration!.changes.find((entry) =>
    entry.id === change.id
  )!;
  await this.feedback(
    recorded.status === "pending"
      ? "La proposition d’évolution est visible. Elle attend une approbation ou un refus explicite dans le contrôle de décision ; le chat ne modifie aucun droit."
      : `La proposition d’évolution ${recorded.id} est enregistrée avec le statut ${recorded.status}.`,
  );
  return {
    status: recorded.status,
    changeId: recorded.id,
    ...(this.ports.model.requestChangeScope
      ? {
        proposalIntentDigest: await requestChangeProposalDigest(recorded),
      }
      : {}),
  };
}

async function continueChangeDecision(
  host: MandateChangeHost,
  change: PendingChange,
  closedWithoutAdoption = false,
  resumeConversation = true,
): Promise<void> {
  const continuation = host.state.changeDecisionContinuations?.[change.id];
  if (!change.requestedBy || continuation === "resumed") return;
  try {
    await continueChangeDecisionBody(
      host,
      change,
      closedWithoutAdoption,
      resumeConversation,
      continuation,
    );
  } catch (error) {
    // Fail closed with the approval recorded, as before: the publication is
    // real even when its dialogue cannot resume. Never masks the cause.
    const entry = host.state.configuration?.changes.find((candidate) =>
      candidate.id === change.id
    );
    if (entry?.status === "pending" && entry.publishedCommit) {
      try {
        await host.update((state) =>
          recordApprovalIfCompleting(
            host.ports.clock,
            state,
            change.id,
            !closedWithoutAdoption,
          )
        );
      } catch { /* The recording fault must not mask the original cause. */ }
    }
    throw error;
  }
}

async function continueChangeDecisionBody(
  host: MandateChangeHost,
  change: PendingChange,
  closedWithoutAdoption: boolean,
  resumeConversation: boolean,
  continuation: string | undefined,
): Promise<void> {
  const origin = host.state.changeWorkContinuations?.[change.id];
  const work = origin && changeWorkReceipt(host.state, change);
  if (
    !origin && host.state.caseInvocation &&
    ["delegated", "delegated-designer"].includes(host.state.caseInvocation.kind)
  ) {
    const input = invocationInput(host.state);
    if (input && workReceipt(input)) {
      throw new CaseError(
        "CASE_SCOPE_MISSING",
        "This historical change has no exact recorded work origin",
        { changeId: change.id },
      );
    }
  }
  if (origin && !work) {
    throw new CaseError(
      "CASE_SCOPE_MISSING",
      "The change's recorded work origin is unavailable",
      { changeId: change.id },
    );
  }
  if (origin?.attempt) {
    // A prior dispatch without its atomic receipt may have returned or started an
    // opaque effect. Never manufacture a second provider invocation on restart.
    throw new CaseError(
      "CASE_DISPATCH_UNKNOWN",
      "The change dialogue started without a durable work receipt",
      { changeId: change.id },
      "Inspect the exact dialogue and effects before explicitly recovering this work.",
    );
  }
  if (continuation !== "feedback-sent") {
    const feedbackStart = host.state.messages.length;
    await host.feedback(
      change.status === "refused"
        ? "Change refused; rights kept."
        : closedWithoutAdoption
        ? "An earlier publication was found and closed; the model already adopted is kept."
        : change.kind === "operator-creation"
        ? change.operator && isTeamOperatorSpec(change.operator)
          ? "Team operator created and verified for the current Request; use its admitted contribution behavior."
          : "Operator created and verified; its first Request is open with its owner."
        : change.kind === "mandate-change"
        ? change.requestedRights &&
            "toolAdmission" in change.requestedRights
          ? "Tool admission policy published and verified; only its explicit operators and tool kinds apply."
          : change.requestedRights &&
              "operatorAuthority" in change.requestedRights
          ? "Operator authority policy published and verified; only its explicit bounds apply."
          : change.requestedRights &&
              "grantModelEditing" in change.requestedRights
          ? "Droit d’édition ciblée accordé et vérifié ; chaque modification reste soumise à son admission."
          : change.requestedRights &&
              "addNetworkHosts" in change.requestedRights
          ? `Portée réseau révisée et vérifiée : ${
            change.requestedRights.addNetworkHosts.join(", ")
          }. La demande interrompue peut reprendre sous ce mandat.`
          : change.requestedRights &&
              "setUrlSelectionMode" in change.requestedRights
          ? `Sélection d’URL révisée et vérifiée : ${
            host.state.executionModel!.policy.urlSelectionMode
          }. La portée réseau du mandat reste contrôlée à chaque appel.`
          : "Mandat révisé et vérifié : le constructeur peut désormais décider de l’admission de ses propres candidats testés. L’hôte conserve l’activation."
        : "Reviewer créé et vérifié : il examine et décide de l’admission des nouveaux candidats testés. L’hôte conserve l’activation.",
    );
    await host.update((state) => {
      (state.changeDecisionContinuations ??= {})[change.id] = "feedback-sent";
      if (origin) {
        state.changeWorkContinuations![change.id].feedbackRange = {
          start: feedbackStart,
          end: state.messages.length,
        };
      }
    });
  }
  if (resumeConversation) {
    // A refusal or a historical completion need not adopt repository HEAD.
    // Resume dialogue only while its admitted execution contract is current.
    const head = await host.ports.model.readExecutableModel(
      host.state.model!,
    );
    if (head.version.digest === host.state.executionModel!.version.digest) {
      if (origin && work) {
        const invocation = changeCaseInvocation(host.state, change);
        if (
          !host.state.caseInvocation ||
          invocationKey(invocation) !== invocationKey(host.state.caseInvocation)
        ) {
          throw new CaseError(
            "CASE_SCOPE_MISSING",
            "The change's exact work is not selected",
            { changeId: change.id },
          );
        }
        const previous = recordedWorkCompletion(host.state, work);
        if (!previous || !host.workCompletion) {
          throw new CaseError(
            "CASE_SCOPE_MISSING",
            "The original work receipt is unavailable",
            { changeId: change.id },
          );
        }
        const inputIndex = host.state.messages.findIndex((message) =>
          message.id === origin.inputMessageId
        );
        await host.update((state) => {
          // Publication recovery has verified the current contract for this exact
          // work; a prior control/storage diagnostic is not its resumed outcome.
          delete state.error;
          state.changeWorkContinuations![change.id].attempt = {
            messageStart: state.messages.length,
            priorCandidateIds: state.candidates.map((candidate) =>
              candidate.id
            ),
            messageRanges: [
              ...(previous.work.messageRanges ??
                [{ start: inputIndex, end: previous.work.messageCount }]),
              ...(state.changeWorkContinuations![change.id].feedbackRange
                ? [state.changeWorkContinuations![change.id].feedbackRange!]
                : []),
            ],
            candidateIds: [...previous.work.candidateIds],
          };
        });
      }
      try {
        await host.runTurn(undefined, {
          id: `change-decision:${change.id}:${await valueDigest({
            status: change.status,
            decidedAt: change.decidedAt,
            publication: change.publication,
          })}`,
          kind: "resume",
        });
      } catch (error) {
        if (!isMissingClaim(error)) throw error;
        // Claimless restart resumption (durable): the dialogue cannot run
        // here. Record the attested approval; a never-dispatched dialogue
        // defers to the next claimed retry, an already-dispatched one
        // completes bare — at most once, never a second provider invocation.
        await host.update((state) => {
          recordApprovalIfCompleting(
            host.ports.clock,
            state,
            change.id,
            !closedWithoutAdoption,
          );
          if (!origin && continuation === "feedback-sent") {
            (state.changeDecisionContinuations ??= {})[change.id] = "resumed";
          }
        });
        return;
      }
      if (origin && work) {
        const attempt = host.state.changeWorkContinuations![change.id].attempt!;
        const completing = host.state.configuration!.changes.find((entry) =>
          entry.id === change.id
        )!;
        const completionRevision = host.state.revision;
        const completion = await host.workCompletion!(work, {
          ...(completing.status === "pending" && completing.publishedCommit
            ? {
              approvedChange: {
                ...structuredClone(completing),
                status: "approved" as const,
              },
            }
            : {}),
          messageRanges: [...attempt.messageRanges, {
            start: attempt.messageStart,
            end: host.state.messages.length,
          }],
          candidateIds: [
            ...new Set([
              ...attempt.candidateIds,
              ...host.state.candidates.filter((candidate) =>
                !attempt.priorCandidateIds.includes(candidate.id)
              ).map((candidate) => candidate.id),
            ]),
          ],
        });
        await host.update((state) => {
          if (state.revision !== completionRevision) {
            throw new CaseError(
              "CASE_SCOPE_MISSING",
              "The work completion source changed before its atomic approval",
            );
          }
          recordApprovalIfCompleting(
            host.ports.clock,
            state,
            change.id,
            !closedWithoutAdoption,
          );
          state.events.push(completion);
          (state.changeDecisionContinuations ??= {})[change.id] = "resumed";
          delete state.changeWorkContinuations![change.id].attempt;
        });
        // As at the end of any accepted delegated turn: a caller waiting on
        // this work (a closed plan, a team parent) is woken by its receipt.
        if (completion.work.status !== "waiting") {
          await host.notifyWorkCompletion?.(work, completion);
        }
        return;
      }
    } else if (origin) {
      // The publication is real, but no compatible dialogue returned.
      await host.update((state) =>
        recordApprovalIfCompleting(
          host.ports.clock,
          state,
          change.id,
          !closedWithoutAdoption,
        )
      );
      return;
    }
  }
  await host.update((state) => {
    recordApprovalIfCompleting(
      host.ports.clock,
      state,
      change.id,
      !closedWithoutAdoption,
    );
    (state.changeDecisionContinuations ??= {})[change.id] = "resumed";
  });
}

/** Finish recorded dialogue delivery at startup, before a decision can be replayed. */
export async function resumeChangeDecisions(
  this: MandateChangeHost,
): Promise<void> {
  for (const change of this.state.configuration?.changes ?? []) {
    if (scopedRequestChange(this, change)) continue;
    const continuation = this.state.changeDecisionContinuations?.[change.id];
    const completing = change.status === "pending" &&
      !!change.publishedCommit &&
      !!change.requestedBy;
    if (
      change.status !== "approved" &&
        !(change.status === "refused" &&
          this.state.changeWorkContinuations?.[change.id]) &&
        !completing ||
      !continuation ||
      continuation === "resumed" ||
      change.kind === "operator-creation" &&
        !this.canOpenOperatorRequests?.() &&
        !completing
    ) continue;
    if (
      completing && change.kind === "operator-creation" &&
      !this.canOpenOperatorRequests?.()
    ) {
      // Without the opening service there is no dialogue to resume; record
      // the attested approval bare, as the skipped resumption did before.
      await this.update((s) =>
        recordApprovalIfCompleting(
          this.ports.clock,
          s,
          change.id,
          this.state.executionModel!.version.repositoryVersion ===
            change.publishedCommit,
        )
      );
      continue;
    }
    const invocation = changeCaseInvocation(this.state, change);
    if (canonical(invocation) !== canonical(this.state.caseInvocation)) {
      await this.update((s) => selectCaseInvocation(s, invocation));
    }
    if (change.status === "approved" || completing) {
      await this.changeApproved?.(change);
    }
    await continueChangeDecision(
      this,
      change,
      this.state.executionModel!.version.repositoryVersion !==
        change.publishedCommit,
    );
  }
}

function isSupersededProposal(error: unknown): boolean {
  return error instanceof ChangeApprovabilityError &&
    error.reason === "SUPERSEDED_PROPOSAL";
}

/** The durable ledger refuses native execution without a claimed delivery
 * (see PostgresNativeExecutionLedger.open); a restart resumption has none. */
function isMissingClaim(error: unknown): boolean {
  return error instanceof Error &&
    error.message ===
      "Native execution requires a durable claimed operator delivery";
}

/** Only known business refusals may return authority to the person. */
function delegatedRefusal(error: unknown, changeId: string): unknown {
  if (
    error instanceof ChangeApprovabilityError ||
    error instanceof ChangePublicationError &&
      error.code === "PUBLICATION_NOT_APPLICABLE" ||
    error instanceof OperatorConversationError && error.code === "AGENT_BUSY"
  ) {
    return new OperatorAuthorityError(
      "AUTHORITY_REQUEST_STALE",
      error.message,
      {
        changeId,
        reason: error instanceof ChangeApprovabilityError
          ? error.reason
          : error.code,
      },
    );
  }
  return error;
}

export async function decideChange(
  this: MandateChangeHost,
  input: {
    changeId: string;
    expectedRevision: number;
    verdict: "approve" | "refuse";
  },
  delegated?: DelegatedActor,
  execution?: { insideTurn: true },
): Promise<void> {
  if (!["approve", "refuse"].includes(input.verdict)) {
    throw new Error("Décision inconnue.");
  }
  if (this.ports.model.requestChangeScope) {
    throw new ChangePublicationError("PUBLICATION_NOT_APPLICABLE", {
      changeId: input.changeId,
    }, "Use the authenticated Case network decision coordinator.");
  }
  const context = {
    changeId: input.changeId,
    systemId: this.state.model!.systemId,
  };
  if (execution?.insideTurn) {
    const proposal = this.state.configuration?.changes.find((change) =>
      change.id === input.changeId
    );
    const request = caseExecutionContext(this.state);
    if (
      !this.state.busy || !delegated || !proposal?.operator ||
      !isTeamOperatorSpec(proposal.operator) ||
      delegated.actorId !== this.state.executionModel!.identity.builderId ||
      proposal.requestedBy !== delegated.actorId ||
      !request || proposal.caseId !== request.caseId ||
      proposal.teamOrigin?.operatorId !==
        (request.record?.owner ?? request.budget?.ownerId)
    ) {
      throw new OperatorAuthorityError(
        "AUTHORITY_OUT_OF_BOUNDS",
        "Inline creation must belong to the controlled operator's active Request",
        context,
      );
    }
  }
  try {
    // The target operator is not touched by a refused delegated act: control()
    // would bump its revision, so the domain judges the current model first.
    let current: ExecutableModel | undefined;
    if (delegated) {
      const recorded = this.state.configuration!.changes.find((c) =>
        c.id === input.changeId
      );
      if (!recorded || !["pending", "approved"].includes(recorded.status)) {
        throw new OperatorAuthorityError(
          "AUTHORITY_REQUEST_STALE",
          "The request is no longer pending",
          context,
        );
      }
      // Recovery uses the immutable receipt; it does not exercise today's policy.
      if (
        recorded.status === "pending" &&
        !await findPublication(this, recorded.id)
      ) {
        current = await this.ports.model.readExecutableModel(
          this.state.model!,
        );
        SystemGovernance.fromExecutable(
          current,
          this.state.configuration!.changes,
          hostCreationScope(this),
        )
          .decideChange(
            input.changeId,
            input.expectedRevision,
            input.verdict === "approve",
            this.ports.clock.now(),
            delegated,
          );
      }
    }
    const action = async () => {
      const origin = this.state.configuration!.changes.find((change) =>
        change.id === input.changeId
      );
      if (
        origin?.status === "pending" && !origin.requestedBy &&
        input.verdict === "approve"
      ) {
        // Reconcile an already-attested publication, but never issue new authority.
        await reconcileChangePublications.call(this);
        if (
          this.state.configuration!.changes.find((entry) =>
            entry.id === origin.id
          )?.status !== "approved"
        ) {
          throw new ChangeScopeMissingError({ changeId: origin.id });
        }
      }
      if (
        origin?.requestedBy &&
        this.state.changeDecisionContinuations?.[origin.id] !== "resumed" &&
        (origin.status === "pending" || origin.status === "approved")
      ) {
        const invocation = changeCaseInvocation(this.state, origin);
        if (canonical(invocation) !== canonical(this.state.caseInvocation)) {
          await this.update((s) => selectCaseInvocation(s, invocation));
        }
      }
      await reconcileChangePublications.call(this);
      const recorded = this.state.configuration!.changes.find((change) =>
        change.id === input.changeId
      );
      if (recorded?.status === "approved") {
        const prior = recorded.authorityExercise?.creationDelegation ??
          recorded.authorityExercise?.delegation;
        if (
          delegated &&
          (!prior || prior.actorId !== delegated.actorId ||
            prior.policyId !== delegated.policyId ||
            prior.policyRevision !== delegated.policyRevision)
        ) {
          throw new OperatorAuthorityError(
            "AUTHORITY_RECEIPT_MISMATCH",
            "A replay must name the actor and policy of the recorded decision",
            { changeId: recorded.id },
          );
        }
        if (input.verdict === "refuse") {
          throw new ChangePublicationError("PUBLICATION_ALREADY_APPLIED", {
            changeId: recorded.id,
            systemId: this.state.model!.systemId,
          }, "Cette évolution a déjà été publiée ; recharge sa décision.");
        }
        if (input.expectedRevision === recorded.baseRevision) {
          await this.changeApproved?.(recorded);
          await continueChangeDecision(
            this,
            recorded,
            false,
            !execution?.insideTurn,
          );
          return;
        }
      }
      if (
        recorded?.status === "pending" && recorded.publishedCommit &&
        recorded.requestedBy && input.verdict === "refuse"
      ) {
        // The publication already won: reconcile the approval, then reject
        // the refusal exactly as for an already-applied decision.
        await this.update((s) =>
          recordApprovalIfCompleting(
            this.ports.clock,
            s,
            recorded.id,
            this.state.executionModel!.version.repositoryVersion ===
              recorded.publishedCommit,
          )
        );
        throw new ChangePublicationError("PUBLICATION_ALREADY_APPLIED", {
          changeId: recorded.id,
          systemId: this.state.model!.systemId,
        }, "Cette évolution a déjà été publiée ; recharge sa décision.");
      }
      if (
        recorded?.status === "pending" && recorded.publishedCommit &&
        recorded.requestedBy && input.verdict === "approve" &&
        input.expectedRevision === recorded.baseRevision
      ) {
        // A previous attempt published and adopted but never recorded the
        // approval: resume its completion instead of publishing twice.
        const prior = recorded.authorityExercise?.creationDelegation ??
          recorded.authorityExercise?.delegation;
        if (
          delegated &&
          (!prior || prior.actorId !== delegated.actorId ||
            prior.policyId !== delegated.policyId ||
            prior.policyRevision !== delegated.policyRevision)
        ) {
          throw new OperatorAuthorityError(
            "AUTHORITY_RECEIPT_MISMATCH",
            "A replay must name the actor and policy of the recorded decision",
            { changeId: recorded.id },
          );
        }
        await this.changeApproved?.(recorded);
        await continueChangeDecision(
          this,
          recorded,
          this.state.executionModel!.version.repositoryVersion !==
            recorded.publishedCommit,
          !execution?.insideTurn,
        );
        return;
      }
      const decisionModel = delegated
        ? current ??
          await this.ports.model.readExecutableModel(this.state.model!)
        : this.state.executionModel!;
      const governance = SystemGovernance.fromExecutable(
        decisionModel,
        this.state.configuration!.changes,
        hostCreationScope(this),
      );
      let change: PendingChange;
      try {
        change = governance.decideChange(
          input.changeId,
          input.expectedRevision,
          input.verdict === "approve",
          this.ports.clock.now(),
          delegated,
        );
      } catch (error) {
        if (delegated) throw delegatedRefusal(error, input.changeId);
        // A superseded proposal is terminally dead: no publication outcome
        // (and no refuse-and-repropose recovery) applies to either verdict.
        if (isSupersededProposal(error)) throw error;
        if (input.verdict !== "approve") throw error;
        throw publicationFailure(error, context, "refuse");
      }
      let closedWithoutAdoption = false;
      if (input.verdict === "approve") {
        requireRegisteredDesigner(this, change);
        try {
          const execution = this.ports.execution;
          if (
            !execution &&
            this.state.candidates.some((candidate) =>
              candidate.promotionExecution
            )
          ) {
            throw new Error(
              "Native promotion inspection is unavailable before mandate publication",
            );
          }
          const dependencies = execution
            ? nativePromotionDependencies(
              this.state,
              await execution.inspect(
                this.state.executionModel!.identity.builderId,
              ),
            )
            : [];
          if (dependencies.length) {
            throw new ChangeApprovabilityError(
              "PROMOTION_PENDING",
              "Une promotion native suspendue doit être terminée avant cette publication ; la proposition reste en attente.",
              {
                systemId: this.state.model!.systemId,
                changeId: change.id,
                baseRevision: change.baseRevision,
              },
            );
          }
        } catch (error) {
          throw publicationFailure(error, context, "refuse");
        }
        const native = await this.ports.model.readExecutableModel(
          this.state.model!,
        );
        try {
          assertApprovable(native, change, hostCreationScope(this));
          assertChangeAuthorityReceipt(
            native,
            change,
            hostCreationScope(this),
          );
        } catch (error) {
          if (error instanceof OperatorAuthorityError) throw error;
          throw publicationFailure(error, context, "refuse");
        }
        change.baseModelDigest ??= native.version.digest;
        const receipt = changePublication(
          change,
          this.state.executionModel!.version,
        );
        let published: ApprovedChangePublication;
        try {
          const model = await this.ports.model.applyApprovedChange(
            this.state.model!,
            change,
            change.baseModelDigest,
            receipt,
          );
          published = { model, receipt };
        } catch (error) {
          const found = await findPublication(this, change.id);
          if (!found) throw error;
          published = found;
        }
        if (
          !published.receipt ||
          canonical({ ...published.receipt, edits: [] }) !==
            canonical({ ...receipt, edits: [] })
        ) {
          throw new ChangePublicationError("PUBLICATION_RECEIPT_MISMATCH", {
            changeId: change.id,
          }, "Le commit porte un autre reçu que cette approbation.");
        }
        closedWithoutAdoption = await completePublication(
          this,
          change,
          published,
        );
      } else {
        await this.update((s) => {
          s.configuration!.changes = governance.snapshot.changes;
          s.events.push({
            ...makeEvent(
              this.ports.clock,
              "configuration-change-refused",
              delegated
                ? `${change.kind} explicitly refused by the delegated designer`
                : `${change.kind} refusé explicitement par l’opérateur humain`,
            ),
            changeId: change.id,
            authorityExercise: change.authorityExercise,
          });
        });
      }
      if (input.verdict === "approve") {
        await this.changeApproved?.(
          this.state.configuration!.changes.find((entry) =>
            entry.id === change.id
          )!,
        );
      }
      await continueChangeDecision(
        this,
        this.state.configuration!.changes.find((entry) =>
          entry.id === change.id
        )!,
        closedWithoutAdoption,
        !execution?.insideTurn,
      );
    };
    const controlledAction = async () => {
      try {
        await action();
      } catch (error) {
        throw delegated ? delegatedRefusal(error, input.changeId) : error;
      }
    };
    if (execution?.insideTurn) await controlledAction();
    else await this.control(controlledAction, undefined, !!delegated);
  } catch (error) {
    if (delegated) {
      const refusal = delegatedRefusal(error, input.changeId);
      if (refusal !== error) throw refusal;
    }
    if (
      error instanceof OperatorAuthorityError ||
      error instanceof ChangeScopeMissingError || error instanceof CaseError ||
      isSupersededProposal(error)
    ) throw error;
    throw publicationFailure(error, context, "retry");
  }
}
