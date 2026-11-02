/** Provider transport validation for the closed domain decision union.
 * Returning these values is a proposal, never a grant or an admission.
 */
import { Ajv } from "ajv";
import { MODEL_EDIT_TYPE_NAME_PATTERN } from "../../../domain/model/editing/tooling.ts";
import { TOOL_KINDS } from "../../../domain/shared-kernel/tool-kind.ts";
import { MAX_OPERATOR_UNITS } from "../../../domain/work/records/conversations.ts";
import { MAX_TOOL_NAME_LENGTH } from "../../../domain/work/value-objects/tool-name.ts";
import type {
  ChatDecision,
  ChatDecisionBatch,
} from "../../../domain/work/dialogue.ts";
import type { ReviewDecision } from "../../../domain/work/candidates.ts";

export const REQUESTED_BUILDER_RIGHTS = Object.freeze(
  {
    mayAdmitOwnCandidates: true,
  } as const,
);
export const REQUESTED_REVIEWER_MANDATE = Object.freeze(
  {
    mayReviewExactCandidate: true,
    mayAdmitReviewedCandidates: true,
  } as const,
);

const string = { type: "string", minLength: 1 };
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", additionalProperties: false, properties, required });
const exactRights = (rights: Record<string, boolean>) =>
  object(Object.fromEntries(
    Object.entries(rights).map(([key, value]) => [
      key,
      { const: value },
    ]),
  ));

// Exact DNS hosts only; the domain separately validates public scope and grants.
const networkHost = {
  ...string,
  maxLength: 253,
  pattern:
    "^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$",
};

const nativeOperatorId = { ...string, maxLength: 512, pattern: "^[^\\s*]+$" };

/** A delegated policy names a recipient Case (4.8d D4); the host derives its
 * execution space. The agent never sends `recipientExecutionSpaceId`. */
const recipientCaseId = { ...string, maxLength: 128, pattern: "^[^\\s]+$" };

const operatorCandidateReference = {
  operatorId: nativeOperatorId,
  candidateId: { ...string, maxLength: 128 },
  candidateDigest: { ...string, pattern: "^[a-f0-9]{64}$" },
  expectedRevision: { type: "integer", minimum: 0 },
  caseId: { ...string, maxLength: 128 },
  policyId: { ...string, maxLength: 128 },
  policyRevision: { type: "integer", minimum: 1 },
};

const diagnosticAddresses = {
  type: "array",
  maxItems: 128,
  uniqueItems: true,
  items: object({
    code: { ...string, maxLength: 128, pattern: "\\S" },
    elementId: { ...string, maxLength: 512, pattern: "\\S" },
  }),
};

const referenceSite = object({
  unit: { ...string, maxLength: 4096 },
  line: { type: "integer", minimum: 1, maximum: 2147483647 },
  col: { type: "integer", minimum: 1, maximum: 2147483647 },
  endLine: { type: "integer", minimum: 1, maximum: 2147483647 },
  endCol: { type: "integer", minimum: 1, maximum: 2147483647 },
  kind: { ...string, maxLength: 128 },
  ownerId: { ...string, maxLength: 128 },
  chainRootId: { anyOf: [{ ...string, maxLength: 128 }, { type: "null" }] },
  preimage: { ...string, maxLength: 65536 },
});

/** Shared by native JSON output, Muse and local validation. No coercion/defaults. */
export const decisionSchema = {
  type: "object",
  oneOf: [
    object({
      kind: { const: "open_request" },
      text: string,
      objective: { ...string, maxLength: 2000, pattern: "\\S" },
      openingId: { ...string, maxLength: 128, pattern: "^[^\\s]+$" },
      source: {
        oneOf: [
          object({ kind: { const: "current-main" } }),
          object({
            kind: { const: "release" },
            releaseId: {
              ...string,
              maxLength: 128,
              pattern: "^[A-Za-z0-9_-]{1,128}$",
            },
            digest: { ...string, pattern: "^[a-f0-9]{64}$" },
          }),
        ],
      },
    }),
    object({
      kind: { const: "resume_request" },
      text: string,
      operatorId: nativeOperatorId,
      caseId: { ...string, maxLength: 128 },
      resumeId: { ...string, maxLength: 128, pattern: "^[^\\s]+$" },
      instruction: { ...string, maxLength: 2000, pattern: "\\S" },
    }, ["kind", "text", "caseId", "resumeId", "instruction"]),
    object({
      kind: { const: "reply" },
      text: string,
      caseClosure: { enum: ["done", "abandoned"] },
      watchResult: object({
        changed: { type: "boolean" },
        summary: { type: "string", maxLength: 4000 },
      }),
    }, ["kind", "text"]),
    object({
      kind: { const: "consult_model" },
      text: string,
      inputJson: { ...string, maxLength: 65_536 },
    }),
    object({
      kind: { const: "propose_tool" },
      text: string,
      tool: object({
        name: { ...string, maxLength: MAX_TOOL_NAME_LENGTH },
        description: string,
        kind: { enum: [...TOOL_KINDS] },
        code: { ...string, maxLength: 40_000 },
      }),
    }),
    object({
      kind: { const: "invoke_tool" },
      text: string,
      toolId: string,
      input: object({ url: { ...string, maxLength: 4096 } }),
    }),
    object({
      kind: { const: "invoke_behavior" },
      text: string,
      behaviorId: string,
      inputJson: { ...string, maxLength: 65_536 },
    }),
    object({
      kind: { const: "propose_mandate_change" },
      text: string,
      reason: string,
      requestedRights: {
        oneOf: [
          exactRights(REQUESTED_BUILDER_RIGHTS),
          object({
            grantModelEditing: object({
              file: { ...string, maxLength: 240 },
              root: { ...string, maxLength: 512 },
              operations: {
                type: "array",
                minItems: 1,
                maxItems: 6,
                uniqueItems: true,
                items: {
                  enum: [
                    "set-value",
                    "set-type",
                    "retarget-reference",
                    "rename",
                    "insert-member",
                    "remove",
                  ],
                },
              },
            }),
          }),
          object({
            operatorAuthority: object({
              policyId: { ...string, maxLength: 128 },
              expectedPolicyRevision: { type: "integer", minimum: 0 },
              enabled: { type: "boolean" },
              recipients: {
                type: "array",
                minItems: 1,
                maxItems: 32,
                uniqueItems: true,
                items: nativeOperatorId,
              },
              recipientCaseId,
              acts: {
                type: "array",
                minItems: 1,
                maxItems: 1,
                items: { const: "addNetworkHosts" },
              },
              networkHosts: {
                type: "array",
                minItems: 1,
                maxItems: 32,
                uniqueItems: true,
                items: networkHost,
              },
              toolIds: { type: "array", maxItems: 0, items: string },
              maxDelegationDepth: { const: 0 },
            }, [
              "policyId",
              "expectedPolicyRevision",
              "enabled",
              "recipients",
              "acts",
              "networkHosts",
              "toolIds",
              "maxDelegationDepth",
            ]),
          }),
          object({
            addNetworkHosts: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              uniqueItems: true,
              items: networkHost,
            },
          }),
          object({
            toolAdmission: object({
              policyId: { ...string, maxLength: 128 },
              expectedPolicyRevision: { type: "integer", minimum: 0 },
              enabled: { type: "boolean" },
              recipients: {
                type: "array",
                minItems: 1,
                maxItems: 32,
                uniqueItems: true,
                items: nativeOperatorId,
              },
              recipientCaseId,
              toolKinds: {
                type: "array",
                minItems: 1,
                maxItems: TOOL_KINDS.length,
                uniqueItems: true,
                items: { enum: [...TOOL_KINDS] },
              },
              maxDelegationDepth: { const: 0 },
            }, [
              "policyId",
              "expectedPolicyRevision",
              "enabled",
              "recipients",
              "toolKinds",
              "maxDelegationDepth",
            ]),
          }),
          object({
            setUrlSelectionMode: { enum: ["authorized-host", "user-provided"] },
          }),
        ],
      },
    }),
    object({
      kind: { const: "decide_operator_change" },
      text: string,
      operatorId: nativeOperatorId,
      changeId: { ...string, maxLength: 128 },
      expectedRevision: { type: "integer", minimum: 0 },
      policyId: { ...string, maxLength: 128 },
      policyRevision: { type: "integer", minimum: 1 },
      verdict: { enum: ["approve", "refuse"] },
    }),
    object({
      kind: { const: "inspect_operator_candidate" },
      text: string,
      ...operatorCandidateReference,
    }),
    object({
      kind: { const: "decide_operator_candidate" },
      text: string,
      ...operatorCandidateReference,
      verdict: { enum: ["approve", "refuse"] },
      reason: { ...string, maxLength: 2000 },
    }),
    object({
      kind: { const: "prepare_operator_evolution" },
      text: { ...string, maxLength: 4000 },
      reason: { ...string, maxLength: 2000 },
      editJson: { ...string, maxLength: 100_000 },
    }),
    object({
      kind: { const: "decide_operator_evolution" },
      text: { ...string, maxLength: 4000 },
      dossierId: { ...string, maxLength: 128, pattern: "^\\S+$" },
      decision: { enum: ["accept", "cancel"] },
    }),
    object({
      kind: { const: "adopt_operator_evolution" },
      text: { ...string, maxLength: 4000 },
      dossierId: { ...string, maxLength: 128, pattern: "^\\S+$" },
    }),
    object({
      kind: { const: "propose_sysml_revision" },
      text: { ...string, maxLength: 4000 },
      reason: { ...string, maxLength: 2000 },
      baseVersion: { ...string, maxLength: 256 },
      addresses: diagnosticAddresses,
      sources: {
        type: "object",
        minProperties: 1,
        maxProperties: 16,
        propertyNames: {
          type: "string",
          maxLength: 240,
          pattern:
            "^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\\.sysml$",
        },
        additionalProperties: { ...string, maxLength: 100_000 },
      },
    }, ["kind", "text", "reason", "baseVersion", "sources"]),
    object({
      kind: { const: "propose_sysml_edit" },
      text: { ...string, maxLength: 4000 },
      reason: { ...string, maxLength: 2000 },
      baseVersion: {
        ...string,
        pattern: "^(?:branch|commit):[A-Za-z0-9_-]{1,120}$",
      },
      sourceDigest: { ...string, pattern: "^[a-f0-9]{64}$" },
      addresses: diagnosticAddresses,
      edits: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: {
          oneOf: [
            object({
              kind: { const: "set-value" },
              elementId: { ...string, maxLength: 512 },
              expression: { ...string, maxLength: 4096 },
            }),
            object({
              kind: { const: "set-type" },
              elementId: { ...string, maxLength: 512 },
              typeName: {
                ...string,
                maxLength: 4096,
                pattern: MODEL_EDIT_TYPE_NAME_PATTERN,
              },
            }),
            object({
              kind: { const: "retarget-reference" },
              fromId: { ...string, maxLength: 128 },
              toId: { ...string, maxLength: 128 },
              site: referenceSite,
            }),
            object({
              kind: { const: "rename" },
              elementId: { ...string, maxLength: 512 },
              name: { ...string, maxLength: 512 },
            }),
            object({
              kind: { const: "insert-member" },
              elementId: { ...string, maxLength: 512 },
              text: { ...string, maxLength: 100_000 },
            }),
            object({
              kind: { const: "remove" },
              elementId: { ...string, maxLength: 512 },
            }),
          ],
        },
      },
    }, ["kind", "text", "reason", "baseVersion", "sourceDigest", "edits"]),
    object({
      kind: { const: "propose_model_delegation" },
      text: { ...string, maxLength: 4000 },
      reason: { ...string, maxLength: 2000 },
      baseVersion: {
        ...string,
        pattern: "^(?:branch|commit):[A-Za-z0-9_-]{1,120}$",
      },
      sourceDigest: { ...string, pattern: "^[a-f0-9]{64}$" },
      change: {
        oneOf: [
          object({
            kind: { const: "grant" },
            id: { ...string, maxLength: 128 },
            targetSystem: { ...string, maxLength: 512 },
            operations: {
              type: "array",
              minItems: 1,
              maxItems: 7,
              uniqueItems: true,
              items: {
                enum: [
                  "set-value",
                  "set-type",
                  "retarget-reference",
                  "rename",
                  "insert-member",
                  "remove",
                  "replace-source",
                ],
              },
            },
            grants: {
              type: "array",
              minItems: 1,
              maxItems: 64,
              items: object({
                file: { ...string, maxLength: 240 },
                qualifiedRoots: {
                  type: "array",
                  minItems: 1,
                  maxItems: 128,
                  uniqueItems: true,
                  items: { ...string, maxLength: 512 },
                },
              }),
            },
            mayEdit: { type: "boolean" },
            recipients: {
              type: "array",
              maxItems: 128,
              uniqueItems: true,
              items: { ...string, maxLength: 512 },
            },
            maxRedelegationDepth: {
              type: ["integer", "null"],
              minimum: 0,
              maximum: 8,
            },
          }),
          object({
            kind: { const: "revoke" },
            id: { ...string, maxLength: 128 },
          }),
        ],
      },
    }),
    object({
      kind: { const: "propose_agent_creation" },
      text: string,
      reason: string,
      name: { ...string, maxLength: 80 },
      role: { const: "operator" },
      operator: {
        oneOf: [
          object({
            instruction: { ...string, maxLength: 4000 },
            networkHosts: {
              type: "array",
              maxItems: 32,
              uniqueItems: true,
              items: networkHost,
            },
            requestType: object({
              name: { ...string, maxLength: 80 },
              maxInvocations: { type: "integer", minimum: 1, maximum: 100 },
            }),
            firstRequest: object({ objective: { ...string, maxLength: 2000 } }),
            creationGrant: object({
              networkHosts: {
                type: "array",
                maxItems: 32,
                uniqueItems: true,
                items: networkHost,
              },
              maxChildren: {
                type: "integer",
                minimum: 1,
                maximum: MAX_OPERATOR_UNITS,
              },
              maxDelegationDepth: {
                type: "integer",
                minimum: 0,
                maximum: MAX_OPERATOR_UNITS - 1,
              },
              mode: { enum: ["autonomous", "per-creation"] },
            }, ["networkHosts", "maxChildren", "maxDelegationDepth"]),
          }, ["instruction", "networkHosts", "requestType", "firstRequest"]),
          object({
            kind: { const: "request-team-member" },
            instruction: { ...string, maxLength: 4000 },
            provision: object({
              budget: object({
                maxAgentDecisions: { type: "integer", minimum: 1 },
                maxToolProposals: { type: "integer", minimum: 0 },
                maxFlowSteps: { type: "integer", minimum: 1 },
              }),
              networkHosts: {
                type: "array",
                maxItems: 32,
                uniqueItems: true,
                items: networkHost,
              },
              mayPropose: {
                type: "array",
                maxItems: TOOL_KINDS.length,
                uniqueItems: true,
                items: { enum: [...TOOL_KINDS] },
              },
              mayInvokeActiveCatalog: { type: "boolean" },
              mayAddNetworkHosts: { type: "boolean" },
              mayConsultModel: { type: "boolean" },
              mayProposeSysmlRevision: { type: "boolean" },
            }, [
              "budget",
              "networkHosts",
              "mayPropose",
              "mayInvokeActiveCatalog",
            ]),
            creationGrant: object({
              networkHosts: {
                type: "array",
                maxItems: 32,
                uniqueItems: true,
                items: networkHost,
              },
              maxChildren: {
                type: "integer",
                minimum: 1,
                maximum: MAX_OPERATOR_UNITS,
              },
              maxDelegationDepth: {
                type: "integer",
                minimum: 0,
                maximum: MAX_OPERATOR_UNITS - 1,
              },
              mode: { enum: ["autonomous", "per-creation"] },
            }, ["networkHosts", "maxChildren", "maxDelegationDepth"]),
          }, ["kind", "instruction", "provision"]),
        ],
      },
    }),
    object({
      kind: { const: "propose_agent_creation" },
      text: string,
      reason: string,
      name: { ...string, maxLength: 120 },
      role: { const: "reviewer" },
      mandate: exactRights(REQUESTED_REVIEWER_MANDATE),
    }),
  ],
};
/** One provider response is accepted only after its complete group is valid. */
export const MAX_DECISION_CALLS = 8;
export function decisionBatchSchema(memberSchema: object = decisionSchema) {
  return object({
    calls: {
      type: "array",
      minItems: 1,
      maxItems: MAX_DECISION_CALLS,
      items: object({
        id: { ...string, maxLength: 256, pattern: "^\\S+$" },
        decision: memberSchema,
      }),
    },
  });
}

/** Cross-member constraints are checked before the host can dispatch any call. */
export function decisionBatchError(value: unknown): string | undefined {
  if (
    !value || typeof value !== "object" ||
    !Array.isArray((value as { calls?: unknown }).calls)
  ) {
    return "calls must be an array";
  }
  if (
    Object.keys(value).some((key) =>
      !["calls", "assistantBlocks"].includes(key)
    )
  ) return "unknown batch field";
  if ("assistantBlocks" in value && !Array.isArray(value.assistantBlocks)) {
    return "assistant blocks must be an array";
  }
  const calls = (value as { calls: unknown[] }).calls;
  if (calls.length < 1 || calls.length > MAX_DECISION_CALLS) {
    return `expected 1 to ${MAX_DECISION_CALLS} tool calls`;
  }
  const ids = new Set<string>();
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index];
    if (!call || typeof call !== "object") return "each call must be an object";
    if (Object.keys(call).some((key) => !["id", "decision"].includes(key))) {
      return "unknown call field";
    }
    const { id, decision } = call as { id?: unknown; decision?: unknown };
    if (typeof id !== "string" || !/^\S{1,256}$/.test(id) || ids.has(id)) {
      return "tool call IDs must be nonempty, distinct strings without whitespace";
    }
    ids.add(id);
    if (!validateDecision(decision)) return "invalid tool decision schema";
    if (
      ["reply", "decide_operator_candidate", "decide_operator_change"].includes(
        decision.kind,
      ) && index !== calls.length - 1
    ) {
      return "a terminal decision must be last and unique in its group";
    }
    if (
      decision.kind === "reply" && decision.caseClosure &&
      calls.slice(0, index).some((previous) =>
        String((previous as { decision: ChatDecision }).decision.kind)
          .startsWith("propose_")
      )
    ) {
      return "Case closure cannot accompany a proposal requiring separate admission";
    }
  }
  return undefined;
}

export function isDecisionBatch(value: unknown): value is ChatDecisionBatch {
  return decisionBatchError(value) === undefined;
}

export const reviewSchema = object({
  candidateDigest: string,
  verdict: { enum: ["approve", "refuse"] },
  reason: string,
});
const ajv = new Ajv({ strict: true });
export const validateDecision = ajv.compile<ChatDecision>(decisionSchema);
export const validateReview = ajv.compile<ReviewDecision>(reviewSchema);

type ValidationError = NonNullable<typeof validateDecision.errors>[number];

function pointer(root: unknown, path: string): unknown {
  let node = root;
  for (const raw of path.split("/").slice(1)) {
    if (node === null || typeof node !== "object") return undefined;
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** A branch is beside the point when one of its constants contradicts the value. */
function branchFits(branch: unknown, data: unknown): boolean {
  const properties = pointer(branch, "/properties");
  if (!properties || typeof properties !== "object") return true;
  if (!data || typeof data !== "object") return true;
  if (
    pointer(branch, "/additionalProperties") === false &&
    ["kind", "role"].some((key) =>
      Object.hasOwn(data, key) && !Object.hasOwn(properties, key)
    )
  ) return false;
  for (const [key, property] of Object.entries(properties)) {
    const expected = (property as { const?: unknown }).const;
    if (
      expected !== undefined &&
      (!Object.hasOwn(data, key) ||
        (data as Record<string, unknown>)[key] !== expected)
    ) return false;
  }
  return true;
}

/**
 * The errors a correction needs. Within each oneOf, Ajv reports every branch;
 * keep those of the branches the value names by its constants (kind, role),
 * so that a long union does not hide the one error that matters.
 */
export function relevantErrors(
  schema: object,
  value: unknown,
  errors: readonly ValidationError[] | null | undefined,
): ValidationError[] {
  const all = [...(errors ?? [])];
  const unions = all.filter((error) => error.keyword === "oneOf");
  const kept = all.filter((error) =>
    error.keyword !== "oneOf" && unions.every((union) => {
      const prefix = `${union.schemaPath}/`;
      if (!error.schemaPath.startsWith(prefix)) return true;
      const branch = error.schemaPath.slice(prefix.length).split("/")[0];
      return branchFits(
        pointer(schema, `${union.schemaPath.slice(1)}/${branch}`),
        pointer(value, union.instancePath),
      );
    })
  );
  return kept.length ? kept : all;
}
