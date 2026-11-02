import { ModelRightsError } from "../../../domain/model/consultation/model-read-policy.ts";
import { withRecipientSpace } from "../../governance/mandate-change-decisions.ts";
import { budgetPromotionPendingSelection } from "../runtime/budget-transition.ts";
import { assertApprovable } from "../../../domain/governance/policies/change-approvability.ts";
import {
  isTeamOperatorSpec,
} from "../../../domain/governance/operator-authority.ts";
import { creationScopeOf } from "../runtime/ports.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  FlowActionResult,
  FlowValues,
} from "../../../domain/model/execution/flow.ts";
import type { ChatDecision } from "../../../domain/work/dialogue.ts";
import type {
  ConversationProposalHost,
  ConversationTurnState,
} from "./turn-context.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import { draftDigest, makeEvent } from "../runtime/values.ts";
import { activeBatchCall, hasQueuedBatchCall } from "./batches.ts";

type SourceProposalHost = Pick<
  ConversationProposalHost,
  "ports" | "state" | "currentModel" | "update" | "feedback"
>;
type SourceDecision = ConversationTurnState["sourceDecision"];

async function proposeDelegation(
  host: SourceProposalHost,
  current: ExecutableModel,
  sourceDecision: SourceDecision,
  decision: Extract<ChatDecision, { kind: "propose_model_delegation" }>,
): Promise<void> {
  if (
    current.policy.mayProposeSysmlRevision !== true ||
    !host.ports.model.proposeDelegation ||
    !current.modelAdministration
  ) {
    throw new ModelRightsError(
      "MODEL_REVISION_AUTHORITY",
      "Le modèle natif ne permet pas de proposer une administration déléguée.",
      { field: "mayProposeSysmlRevision", operation: decision.kind },
      "Utiliser un modèle admis avec le droit de révision et les octrois requis avant de proposer ce changement.",
    );
  }
  if (
    !sourceDecision.modelContext ||
    !sourceDecision.modelSources ||
    decision.baseVersion !==
      sourceDecision.modelContext.version ||
    decision.baseVersion !==
      sourceDecision.modelSources.version ||
    decision.sourceDigest !==
      sourceDecision.modelContext.sourceDigest
  ) {
    throw new Error(
      "La proposition de délégation doit conserver la version et le digest des sources consultées.",
    );
  }
  await host.currentModel();
  const proposal = await host.ports.model.proposeDelegation(
    host.state.model!,
    {
      reason: decision.reason,
      baseVersion: decision.baseVersion,
      sourceDigest: decision.sourceDigest,
      change: structuredClone(decision.change),
    },
    current.version.digest,
  );
  await host.currentModel();
  await host.update((s) => {
    s.events.push(makeEvent(
      "model-revision-proposed",
      `Administration déléguée proposée : ${proposal.id} — ${decision.reason}`,
    ));
  });
  await host.feedback(
    `Administration déléguée proposée : ${
      JSON.stringify(proposal)
    }. Une admission explicite de sa version reste requise ; aucun droit n’est encore modifié.`,
  );
}

async function proposeEdit(
  host:
    & SourceProposalHost
    & Pick<ConversationProposalHost, "diagnosticAddresses">,
  current: ExecutableModel,
  sourceDecision: SourceDecision,
  decision: Extract<ChatDecision, { kind: "propose_sysml_edit" }>,
): Promise<void> {
  if (
    current.policy.mayProposeSysmlRevision !== true ||
    !current.modelEditPolicy ||
    decision.edits.some((edit) =>
      !current.modelEditPolicy!.operations.includes(edit.kind)
    )
  ) {
    throw new ModelRightsError(
      "MODEL_REVISION_AUTHORITY",
      "Le modèle natif ne permet pas de proposer une édition SysML ciblée.",
      { field: "mayProposeSysmlRevision", operation: decision.kind },
      "Utiliser un modèle admis avec le droit de révision et les octrois requis avant de proposer ce changement.",
    );
  }
  if (
    !sourceDecision.modelContext ||
    !sourceDecision.modelSources ||
    decision.baseVersion !==
      sourceDecision.modelContext.version ||
    decision.baseVersion !==
      sourceDecision.modelSources.version ||
    decision.sourceDigest !==
      sourceDecision.modelContext.sourceDigest
  ) {
    throw new Error(
      "La proposition ciblée doit conserver la version et le digest des sources consultées.",
    );
  }
  await host.currentModel();
  const proposal = await host.ports.model.proposeEdit(
    host.state.model!,
    {
      reason: decision.reason,
      baseVersion: decision.baseVersion,
      sourceDigest: decision.sourceDigest,
      edits: structuredClone(decision.edits),
      ...await host.diagnosticAddresses(
        current,
        decision.baseVersion,
        decision.addresses,
      ),
    },
    current.version.digest,
  );
  await host.currentModel();
  await host.update((s) => {
    s.events.push(makeEvent(
      "model-revision-proposed",
      `Édition SysML ciblée proposée : ${proposal.id} — ${decision.reason}`,
    ));
  });
  await host.feedback(
    `Édition SysML ciblée proposée : ${
      JSON.stringify(proposal)
    }. Une admission explicite de sa version reste requise.`,
  );
}

async function proposeRevision(
  host:
    & SourceProposalHost
    & Pick<ConversationProposalHost, "diagnosticAddresses">,
  current: ExecutableModel,
  sourceDecision: SourceDecision,
  decision: Extract<ChatDecision, { kind: "propose_sysml_revision" }>,
): Promise<void> {
  if (
    current.policy.mayProposeSysmlRevision !== true ||
    !host.ports.model.proposeRevision ||
    !current.modelEditPolicy?.operations.includes(
      "replace-source",
    )
  ) {
    throw new ModelRightsError(
      "MODEL_REVISION_AUTHORITY",
      "Le modèle natif ne permet pas de proposer une révision SysML.",
      { field: "mayProposeSysmlRevision", operation: decision.kind },
      "Utiliser un modèle admis avec le droit de révision et les octrois requis avant de proposer ce changement.",
    );
  }
  if (sourceDecision.modelContext) {
    if (
      decision.baseVersion !==
        sourceDecision.modelSources?.version
    ) {
      throw new Error(
        "La proposition doit conserver la version source consultée.",
      );
    }
    const existing = new Set(
      sourceDecision.modelContext.files.map((file) => file.path),
    );
    for (const path of Object.keys(decision.sources)) {
      if (
        existing.has(path) &&
        !Object.hasOwn(
          sourceDecision.modelSources.sources,
          path,
        )
      ) {
        throw new Error(
          `Le fichier ${path} doit être lu intégralement avant sa modification.`,
        );
      }
    }
  }
  await host.currentModel();
  const proposal = await host.ports.model.proposeRevision(
    host.state.model!,
    {
      reason: decision.reason,
      baseVersion: decision.baseVersion,
      sources: decision.sources,
      ...await host.diagnosticAddresses(
        current,
        decision.baseVersion,
        decision.addresses,
      ),
    },
    current.version.digest,
  );
  await host.currentModel();
  await host.update((s) => {
    s.events.push(
      makeEvent(
        "model-revision-proposed",
        `Révision SysML proposée : ${proposal.id} — ${decision.reason}`,
      ),
    );
  });
  await host.feedback(
    `Révision SysML proposée : ${
      JSON.stringify(proposal)
    }. Une admission explicite de sa version reste requise.`,
  );
}

export async function submitProposal(
  this: ConversationProposalHost,
  turn: ConversationTurnState,
  current: ExecutableModel,
  inputs: FlowValues,
): Promise<FlowActionResult> {
  const chosen = inputs.choice as ChatDecision;
  // A named recipient Case becomes its space before the proposal is judged.
  const decision = chosen?.kind === "propose_mandate_change"
    ? await withRecipientSpace(this, chosen)
    : chosen;
  if (!decision) {
    throw new Error(
      "La soumission native exige un choix.",
    );
  }
  if (
    decision.kind === "propose_mandate_change" ||
    decision.kind === "propose_agent_creation"
  ) {
    // Judged before anything is said: a refused proposal leaves no message.
    assertApprovable(
      current,
      decision,
      creationScopeOf(this.ports.model, current.identity),
    );
  }
  const batchCall = decision.kind === "propose_tool"
    ? activeBatchCall(this.state)?.call
    : undefined;
  const resumedId = decision.kind === "propose_tool"
    ? this.state.budgetPromotionCandidateId ?? batchCall?.candidateId
    : undefined;
  const budgetProposalReplay = decision.kind === "propose_tool" &&
    turn.resumedContribution &&
    !!resumedId && budgetPromotionPendingSelection(this.state, resumedId);
  if (
    budgetProposalReplay && decision.kind === "propose_tool" &&
    ((this.state.budgetCeilingTransition?.manifest.family.scalarProposal
      ? await executionDigest(decision) !==
        this.state.budgetCeilingTransition.manifest.family.scalarProposal
          .decisionDigest
      : canonical(decision) !== canonical(batchCall?.decision)) ||
      await draftDigest(decision.tool) !== this.candidate(resumedId!).digest)
  ) {
    throw new Error(
      "The budget continuation must retain its exact proposal call and candidate bytes",
    );
  }
  // A settled parent already emitted and counted this exact proposal before
  // its nested budget wait. Resume its unfinished admission, not that prefix.
  if (!budgetProposalReplay) await this.say(decision.text);
  let awaitingInput = true;
  if (decision.kind === "propose_tool") {
    if (
      turn.proposals > current.policy.maxToolProposals ||
      !budgetProposalReplay &&
        ++turn.proposals > current.policy.maxToolProposals
    ) {
      throw new Error(
        "La limite de propositions du modèle a été atteinte.",
      );
    }
    const beforeIds = new Set(
      this.state.candidates.map((candidate) => candidate.id),
    );
    if (!resumedId) {
      await this.build(decision.tool);
    } else {
      const candidate = this.candidate(resumedId);
      if (
        ["proposed", "testing", "reviewing"].includes(candidate.stage) ||
        candidate.stage === "awaiting-admission" &&
          budgetPromotionPendingSelection(this.state, resumedId)
      ) {
        if (!candidate.promotionExecution) {
          throw new Error(
            "The exact interrupted candidate requires explicit recovery; creating another draft is refused.",
          );
        }
        await this.build(undefined, resumedId);
      }
    }
    if (this.state.budgetSuspension) {
      return { suspend: true };
    }
    const exactCandidate = resumedId
      ? this.candidate(resumedId)
      : batchCall?.id
      ? this.state.candidates.find((candidate) =>
        candidate.batchCall?.callId === batchCall.id &&
        !beforeIds.has(candidate.id)
      )
      : this.state.candidates.find((candidate) => !beforeIds.has(candidate.id));
    awaitingInput = exactCandidate
      ?.stage ===
      "awaiting-admission";
    if (resumedId) {
      await this.update((s) => {
        delete s.budgetPromotionCandidateId;
      });
    }
  } else if (
    decision.kind === "propose_mandate_change" ||
    decision.kind === "propose_agent_creation"
  ) {
    const proposal = await this.proposeChange(decision);
    awaitingInput = proposal?.status !== "approved";
    const requestScope = this.ports.model.requestChangeScope;
    const invocation = this.state.caseInvocation;
    if (
      requestScope?.caseId &&
      (invocation?.kind === "local" &&
          invocation.caseId === requestScope.caseId ||
        invocation?.kind === "delegated" &&
          invocation.work.caseId === requestScope.caseId &&
          invocation.work.caseContext.caseId === requestScope.caseId &&
          current.operatorTeam?.requestId === requestScope.caseId) &&
      requestScope.operatorId === current.identity.builderId &&
      proposal?.status === "pending" && proposal.changeId &&
      proposal.proposalIntentDigest &&
      // A Request change of either effect waits for its decision (4.8e E4):
      // a network request, or a team creation of this Case.
      (decision.kind === "propose_mandate_change" &&
          decision.requestedRights &&
          Object.keys(decision.requestedRights).join(",") ===
            "addNetworkHosts" &&
          "addNetworkHosts" in decision.requestedRights ||
        decision.kind === "propose_agent_creation" &&
          decision.role === "operator" &&
          isTeamOperatorSpec(decision.operator))
    ) {
      turn.changeApprovalProposal = {
        changeId: proposal.changeId,
        proposalIntentDigest: proposal.proposalIntentDigest,
      };
    }
  } else if (
    decision.kind === "prepare_operator_evolution" ||
    decision.kind === "decide_operator_evolution" ||
    decision.kind === "adopt_operator_evolution"
  ) {
    if (!this.executeOperatorEvolution) {
      throw new Error("Evolution commands are unavailable");
    }
    await this.currentModel();
    const result = await this.executeOperatorEvolution(
      decision,
      current,
      turn.sourceDecision,
    );
    await this.feedback(
      "Operator evolution receipt; observed state, not additional authority.\n" +
        JSON.stringify(result),
      result.conversationRecord
        ? {
          kind: "operator-evolution",
          value: structuredClone(result.conversationRecord),
        }
        : undefined,
    );
    // In particular self-adoption never parks the contribution behind its own barrier.
    awaitingInput = false;
  } else if (decision.kind === "propose_model_delegation") {
    await proposeDelegation(this, current, turn.sourceDecision, decision);
  } else if (decision.kind === "propose_sysml_edit") {
    await proposeEdit(this, current, turn.sourceDecision, decision);
  } else if (decision.kind === "propose_sysml_revision") {
    await proposeRevision(this, current, turn.sourceDecision, decision);
  } else {
    throw new Error(
      `Choix non pris en charge par la soumission native : ${decision.kind}`,
    );
  }
  if (hasQueuedBatchCall(this.state)) awaitingInput = false;
  return {
    outputs: {
      submission: { awaitingInput },
      outcome: {
        succeeded: true,
        code: "PROPOSAL_RECORDED",
        details: "Proposition enregistrée",
      },
    },
  };
}
