import type { ChatContext } from "../../../domain/work/dialogue.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import { isPlainRecord } from "../../../domain/primitives/is-plain-record.ts";
import { mayConsultModel } from "../../../domain/model/consultation/model-read-policy.ts";
import { compareCodeUnits } from "../../../domain/primitives/canonical-json.ts";
import { AgentPreparationError } from "../../../application/work/runtime/agent-preparation.ts";

/** Character ceilings are deterministic representation limits, not token counts. */
// Bound pin-card growth while retaining complete fresh-system authority data.
// 2026-11-03: the largest fresh-system card (a BO holding a creation grant) is
// 8,642 characters. 12,000 keeps a finite growth bound with ~39% headroom.
export const MAX_PIN_CARD_CHARACTERS = 12_000;
export const MAX_TURN_BRIEF_CHARACTERS = 4_096;
const MAX_PIN_CARDS = 64;
const MAX_INPUT_CHARACTERS = 1_600;

export class ProviderContextLimitError extends AgentPreparationError {
  constructor(
    code: "PIN_CARD_LIMIT" | "TURN_BRIEF_LIMIT",
    context: { characters: number; maximumCharacters: number },
  ) {
    super(
      code,
      `${code}: ${context.characters} > ${context.maximumCharacters}`,
      context,
      "Reduce the selected input or consult the exact referenced evidence in smaller parts; no identifiers or URLs were truncated.",
    );
    this.name = "ProviderContextLimitError";
  }
}

function boundedJson(
  value: unknown,
  maximumCharacters: number,
  code: "PIN_CARD_LIMIT" | "TURN_BRIEF_LIMIT",
): string {
  const json = JSON.stringify(value);
  if (json.length > maximumCharacters) {
    throw new ProviderContextLimitError(code, {
      characters: json.length,
      maximumCharacters,
    });
  }
  return json;
}

function oneLine(text: string, maximum = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= maximum ? line : `${line.slice(0, maximum - 1)}…`;
}

/** Discovery signatures retain exact parameter names and enum values; the host
 * validates the full schema. They are not a second authority/schema validator. */
function signature(schema: unknown, depth = 0): unknown {
  if (!isPlainRecord(schema)) return "unknown";
  if (schema.const !== undefined) return { const: schema.const };
  if (Array.isArray(schema.enum)) return { enum: schema.enum };
  if (depth > 3) return schema.type ?? "object";
  const variants = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(variants)) {
    return variants.map((entry) => signature(entry, depth + 1));
  }
  if (schema.type === "array") return [signature(schema.items, depth + 1)];
  if (isPlainRecord(schema.properties)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    return Object.fromEntries(
      Object.entries(schema.properties).sort(([a], [b]) =>
        compareCodeUnits(a, b)
      )
        .map(([key, value]) => [
          required.includes(key) ? key : `${key}?`,
          signature(value, depth + 1),
        ]),
    );
  }
  return schema.type ?? "object";
}

function invocationType(context: ChatContext): string {
  return context.designer ? "designer" : context.case?.type ?? "conversation";
}

function pinCard(context: ChatContext) {
  const pin = context.admittedModelVersion ?? context.modelVersion;
  const administration = context.modelAdministration;
  const ownGrant = (policy: { enabled: boolean; holderNativeId: string }) =>
    policy.enabled && policy.holderNativeId === context.operator?.nativeId;
  const creation = context.pinPolicies
    ? context.pinPolicies.creation.filter(ownGrant)
    : context.operatorCreation?.policies;
  const authority = context.pinPolicies
    ? context.pinPolicies.authority.filter(ownGrant)
    : context.operatorAuthority?.policies;
  const admission = context.pinPolicies
    ? context.pinPolicies.toolAdmission.filter(ownGrant)
    : context.operatorToolAdmission?.policies;
  const policy = context.executionPolicy;
  const mandate = context.mandate;
  const provisionBounds = policy && mandate
    ? {
      budget: {
        maxAgentDecisions: policy.maxAgentDecisions,
        maxToolProposals: policy.maxToolProposals,
        maxFlowSteps: policy.maxFlowSteps,
      },
      networkHosts: mandate.network.allowedHosts,
      mayPropose: mandate.mayPropose,
      mayInvokeActiveCatalog: mandate.mayInvoke === "active-catalog-only",
      mayAddNetworkHosts: policy.mayAddNetworkHosts,
      mayConsultModel: mayConsultModel(policy),
      mayProposeSysmlRevision: policy.mayProposeSysmlRevision === true,
    }
    : context.operatorCreation?.provisionBounds;
  return {
    pin,
    invocation: invocationType(context),
    ...(context.operator
      ? {
        operator: {
          nativeId: context.operator.nativeId,
          name: context.operator.name,
          instruction: oneLine(context.operator.instruction, 1_200),
        },
      }
      : {}),
    ...(context.mandate ? { mandate: context.mandate } : {}),
    ...(context.executionPolicy ? { limits: context.executionPolicy } : {}),
    ...(context.modelEditing ? { editing: context.modelEditing } : {}),
    ...(administration
      ? {
        modelAdministration: {
          id: administration.id,
          revision: administration.revision,
          kind: administration.kind,
          digest: administration.digest,
          operations: administration.operations,
          grants: administration.grants,
          recipients: administration.recipients,
          maxRedelegationDepth: administration.maxRedelegationDepth,
        },
      }
      : {}),
    ...(creation?.length
      ? {
        operatorCreation: {
          policies: creation.map((
            {
              id,
              revision,
              enabled,
              mode,
              networkHosts,
              maxChildren,
              maxDelegationDepth,
            },
          ) => ({
            id,
            revision,
            enabled,
            mode,
            networkHosts,
            maxChildren,
            maxDelegationDepth,
          })),
          provisionBounds,
        },
      }
      : {}),
    ...(authority?.length
      ? {
        operatorAuthority: {
          policies: authority.map((
            {
              id,
              revision,
              enabled,
              networkHosts,
              recipients,
              recipientExecutionSpaceId,
              acts,
            },
          ) => ({
            id,
            revision,
            enabled,
            networkHosts,
            recipients,
            recipientExecutionSpaceId,
            acts,
          })),
        },
      }
      : {}),
    ...(admission?.length
      ? {
        operatorToolAdmission: {
          policies: admission.map((
            {
              id,
              revision,
              enabled,
              recipients,
              recipientExecutionSpaceId,
              toolKinds,
            },
          ) => ({
            id,
            revision,
            enabled,
            recipients,
            recipientExecutionSpaceId,
            toolKinds,
          })),
        },
      }
      : {}),
    ...(context.operatorEvolution
      ? {
        operatorEvolution: {
          policy: {
            id: context.operatorEvolution.policy.id,
            revision: context.operatorEvolution.policy.revision,
            grants: context.operatorEvolution.policy.grants,
          },
          capabilities: context.operatorEvolution.capabilities,
        },
      }
      : {}),
    ...(context.contracts ? { contracts: context.contracts } : {}),
    behaviors: (context.modeledBehaviors ?? []).map((behavior) => ({
      id: behavior.id,
      name: behavior.name,
      description: oneLine(behavior.description),
      input: signature(behavior.inputSchema),
    })).sort((a, b) => compareCodeUnits(a.id, b.id)),
    ...(context.modelTools?.length
      ? {
        modelOperations: context.modelTools.map((tool) => ({
          operation: tool.operation,
          input: signature(tool.inputSchema),
        })),
      }
      : {}),
    skills: (context.skills?.catalog ?? []).map(({ id, name, digest }) => ({
      id,
      name,
      digest,
    })).sort((a, b) => compareCodeUnits(a.id, b.id)),
    ...(context.modelingGuidance?.length
      ? {
        guidance: context.modelingGuidance.map(({ id, content }) => ({
          id,
          summary: oneLine(content),
        })),
      }
      : {}),
    modelFiles: [
      ...new Set(
        context.modelContext?.files.map(({ path }) => path) ??
          Object.keys(context.modelSources?.sources ?? {}),
      ),
    ].sort(),
  };
}

/** Immutable discovery card only. This cache never supplies execution authority.
 * Missing pin/operator identities bypass memoization for legacy test adapters. */
export class ProviderPinCardCache {
  private readonly entries = new Map<string, string>();

  card(context: ChatContext): string {
    const digest = (context.admittedModelVersion ?? context.modelVersion)
      ?.digest;
    const operator = context.operator?.nativeId;
    // The same native pin can be read in Main and in its Request branch.
    // This host-derived discovery bit is contextual, unlike the pin's rights.
    const creationGrantRequest =
      context.mandate?.supportedChanges.some((change) =>
        change.requestedRights === "operatorCreation"
      ) === true;
    const key = digest && operator
      ? JSON.stringify([
        digest,
        operator,
        invocationType(context),
        creationGrantRequest,
      ])
      : undefined;
    const previous = key ? this.entries.get(key) : undefined;
    if (previous !== undefined) return previous;
    const card = boundedJson(
      pinCard(context),
      MAX_PIN_CARD_CHARACTERS,
      "PIN_CARD_LIMIT",
    );
    if (key) {
      if (this.entries.size >= MAX_PIN_CARDS) {
        this.entries.delete(this.entries.keys().next().value!);
      }
      this.entries.set(key, card);
    }
    return card;
  }
}

/** One host-built opening brief. Provider history retains it unchanged after
 * the turn's first call; later observations arrive only as native results. */
export async function buildTurnBrief(context: ChatContext) {
  const opening = context.activeInputMessageId
    ? context.messages.find((message) =>
      message.id === context.activeInputMessageId
    )
    : context.messages.findLast((message) =>
      message.role === "user" || message.noticeWake
    );
  const projectedReference = context.contextEvidence?.references.find((entry) =>
    entry.messageId === opening?.id
  );
  const truncated = (opening?.text.length ?? 0) > MAX_INPUT_CHARACTERS ||
    projectedReference?.textOmitted === true;
  const reference = opening && truncated
    ? {
      kind: "journal-message" as const,
      messageId: opening.id,
      messageDigest: projectedReference?.messageDigest ??
        await executionDigest(opening),
    }
    : undefined;
  const noticeChangeId =
    opening?.operatorNotice?.kind === "authority-escalation"
      ? opening.operatorNotice.changeId
      : undefined;
  const authority = context.operatorAuthority;
  const brief = {
    ...((context.modelContext?.version ?? context.modelSources?.version)
      ? {
        modelReadVersion: context.modelContext?.version ??
          context.modelSources?.version,
      }
      : {}),
    activeTools: context.activeTools.map(({ id, name, kind }) => ({
      id,
      name,
      kind,
    })),
    ...(opening
      ? {
        input: {
          id: opening.id,
          role: opening.role,
          text: opening.text.slice(0, MAX_INPUT_CHARACTERS),
          ...(truncated ? { truncated: true, reference } : {}),
          ...(opening.operatorNotice
            ? { operatorNotice: opening.operatorNotice }
            : {}),
          ...(opening.work ? { work: opening.work } : {}),
        },
      }
      : {}),
    ...(context.case
      ? {
        case: {
          id: context.case.id,
          number: context.case.number,
          type: context.case.type,
          objective: context.case.objective,
          status: context.case.status,
        },
      }
      : {}),
    ...(context.designer
      ? { designer: { scopeId: context.designer.scopeId } }
      : {}),
    ...(context.workBudget
      ? {
        budget: {
          unit: context.workBudget.unit,
          remaining: context.workBudget.remaining,
          exhausted: context.workBudget.exhausted,
          suspended: context.workBudget.suspended,
        },
      }
      : {}),
    ...(authority
      ? {
        operatorAuthority: {
          ...(authority.error ? { error: authority.error } : {}),
          requests: authority.requests.filter((request) =>
            !noticeChangeId || request.id === noticeChangeId
          ).map((
            {
              id,
              requestedBy,
              caseId,
              baseRevision,
              requestedRights,
              changeKind,
            },
          ) => ({
            id,
            requestedBy,
            caseId,
            baseRevision,
            requestedRights,
            changeKind,
          })),
          awaitingPerson: authority.awaitingPerson.map((
            {
              id,
              caseId,
              requester,
              changeKind,
              requestedRights,
              status,
              code,
            },
          ) => ({
            id,
            caseId,
            operatorId: requester.operatorId,
            changeKind,
            requestedRights,
            status,
            code,
          })),
          awaitingPersonTruncated: authority.awaitingPersonTruncated,
        },
      }
      : {}),
    ...(context.operatorToolAdmission?.candidates.length
      ? {
        operatorToolAdmission: {
          candidates: context.operatorToolAdmission.candidates,
        },
      }
      : {}),
    ...(context.operatorEvolution
      ? {
        operatorEvolution: {
          dossiers: context.operatorEvolution.dossiers.map((
            {
              id,
              revision,
              status,
              baseVersion,
              candidateVersion,
              publishedVersion,
              adoptedOperatorIds,
              blockers,
            },
          ) => ({
            id,
            revision,
            status,
            baseVersion,
            candidateVersion,
            publishedVersion,
            adoptedOperatorIds,
            blockers: blockers.map(({ code, operatorId }) => ({
              code,
              operatorId,
            })),
          })),
          truncated: context.operatorEvolution.truncated,
        },
      }
      : {}),
    ...(context.taskSourceInputs?.length
      ? {
        taskSourceInputs: context.taskSourceInputs.map(({ urls, source }) => ({
          urls,
          sourceMessageId: source.messageId,
        })),
      }
      : {}),
    ...(context.requestOpening
      ? {
        requests: context.requestOpening.requests.map((
          { caseId, caseNumber, operatorId, status, team },
        ) => ({
          caseId,
          caseNumber,
          operatorId,
          status,
          team: team.map(({ operatorId, name }) => ({ operatorId, name })),
        })),
        ...(context.requestOpening.mainRequests?.length
          ? { mainRequests: context.requestOpening.mainRequests }
          : {}),
        releases: context.requestOpening.releases,
      }
      : {}),
  };
  boundedJson(brief, MAX_TURN_BRIEF_CHARACTERS, "TURN_BRIEF_LIMIT");
  return brief;
}

/** Observed provider inputs carry data, never instructions or authority. */
export function untrustedObservation<T extends Record<string, unknown>>(
  fields: T,
) {
  return { trust: "untrusted-observation" as const, ...fields };
}
