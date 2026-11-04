import type { AgentConversation } from "../../../src/application/work/operators/conversation-types.ts";
import { MAX_OPERATOR_UNITS } from "../../../src/domain/work/records/conversations.ts";
import {
  isTeamOperatorSpec,
  type TeamOperatorSpec,
} from "../../../src/domain/governance/operator-authority.ts";
import type { Candidate } from "../../../src/domain/work/records/candidates.ts";
import type {
  PendingChange,
} from "../../../src/domain/governance/records/pending-change.ts";
import type { ProposalDifference } from "./proposals.ts";

const operationNames: Record<string, string> = {
  "set-value": "Change a value",
  rename: "Rename",
  "insert-member": "Add an element",
  remove: "Remove an element",
  "replace-source": "Replace a file",
};
/** Format known structured fields only; the complete source remains inspectable. */
export function displaySourceDifferences(
  rows: ProposalDifference[],
  agents: readonly AgentConversation[],
): ProposalDifference[] {
  const value = (row: ProposalDifference, raw: string): string => {
    if (raw === "") return "None";
    if (row.id.endsWith(":targetHolderNativeId")) {
      return agents.find((agent) => agent.nativeId === raw)?.name || raw;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw.replaceAll("::", " / ");
    }
    if (row.id.endsWith(":operations") && Array.isArray(parsed)) {
      return parsed.map((entry) =>
        operationNames[String(entry)] || String(entry)
      ).join("\n") || "None";
    }
    if (row.id.endsWith(":grants") && Array.isArray(parsed)) {
      return parsed.map((entry) =>
        `${entry.file}: ${
          entry.qualifiedRoots.map((root: string) =>
            root.replaceAll("::", " / ")
          ).join(", ")
        }`
      ).join("\n") || "None";
    }
    if (row.id.endsWith(":recipients") && Array.isArray(parsed)) {
      return parsed.map((entry) => String(entry).replaceAll("::", " / ")).join(
        "\n",
      ) || "None";
    }
    if (row.id.endsWith(":maxRedelegationDepth")) {
      return parsed === null
        ? "Not allowed"
        : parsed === 0
        ? "Use only, no further granting"
        : `${parsed} level${Number(parsed) > 1 ? "s" : ""}`;
    }
    if (typeof parsed === "boolean") return parsed ? "Yes" : "No";
    if (typeof parsed === "string") {
      return parsed === "" ? "Empty string" : parsed;
    }
    return raw;
  };
  return rows.filter((row) =>
    (row.before !== row.after || row.id.endsWith(":grants") ||
      row.id.endsWith(":operations")) && !row.id.endsWith(":targetSystem")
  ).map((row) => ({
    ...row,
    label: row.id.endsWith(":targetHolderNativeId")
      ? "Beneficiary"
      : row.label.replaceAll("::", " / "),
    before: value(row, row.before),
    after: value(row, row.after),
  }));
}

const authority = {
  human: "Your approval",
  builder: "The agent",
  reviewer: "The reviewer",
};
/** What a change asks for, in a few words; the kinds the card cannot name say so. */
export function changeTitle(
  change: Pick<PendingChange, "kind" | "name" | "operator" | "requestedRights">,
): string {
  if (change.kind === "operator-creation") {
    if (change.operator && isTeamOperatorSpec(change.operator)) {
      return change.name
        ? `Create team operator ${change.name}`
        : "Create team operator";
    }
    return change.name ? `Create operator ${change.name}` : "Create operator";
  }
  if (change.kind === "reviewer-creation") {
    return `Add ${change.name || "a reviewer"}`;
  }
  const rights = change.requestedRights;
  if (rights && "operatorCreation" in rights) {
    return "Grant team creation rights";
  }
  if (rights && "toolAdmission" in rights) {
    const policy = rights.toolAdmission;
    return !policy.enabled
      ? "Revoke operator tool admission"
      : policy.expectedPolicyRevision === 0
      ? "Grant operator tool admission"
      : "Revise operator tool admission";
  }
  if (rights && "operatorAuthority" in rights) {
    const policy = rights.operatorAuthority;
    return !policy.enabled
      ? "Revoke operator authority"
      : policy.expectedPolicyRevision === 0
      ? "Grant operator authority"
      : "Revise operator authority";
  }
  if (rights && "grantModelEditing" in rights) return "Allow model editing";
  if (rights && "addNetworkHosts" in rights) return "Extend web access";
  if (rights && "setUrlSelectionMode" in rights) {
    return "Choose which pages to read";
  }
  return "Tool admission";
}
/**
 * The few facts that bound a change, for a line under its title: the file and
 * root of an editing grant; the Request type, its limit and the hosts of a new
 * operator. Nothing here is a grant: the diff and the person's decision are.
 */
export function changeScope(change: PendingChange): string[] {
  const rights = change.requestedRights;
  if (rights && "operatorCreation" in rights) {
    const request = rights.operatorCreation;
    return [
      "This Request branch only",
      `Up to ${request.maxChildren} members across the whole team`,
      `Network hosts: ${request.networkHosts.join(", ") || "none"}`,
      request.mode === "autonomous"
        ? "Autonomous creation within these bounds"
        : "Approval for each creation",
      "No further delegation",
    ];
  }
  if (rights && "toolAdmission" in rights) {
    return [
      rights.toolAdmission.policyId,
      rights.toolAdmission.recipients.join(", "),
      rights.toolAdmission.toolKinds.join(", "),
      "No further delegation",
    ];
  }
  if (rights && "grantModelEditing" in rights) {
    const { file, root, operations } = rights.grantModelEditing;
    return [
      file,
      root,
      operations.map((entry) => operationNames[entry] || entry).join(", "),
    ].filter(Boolean);
  }
  if (change.kind === "operator-creation" && change.operator) {
    if (isTeamOperatorSpec(change.operator)) {
      const { creationGrant } = change.operator;
      const networkHosts = memberHosts(change.operator);
      return [
        change.teamOrigin?.requestId
          ? `Originating Request: ${change.teamOrigin.requestId}`
          : "Originating Request not recorded",
        "Contributes within the same Request; no new Request",
        networkHosts.length ? networkHosts.join(", ") : "no network",
        ...(creationGrant
          ? [
            `Creation grant: up to ${creationGrant.maxChildren} operators`,
            `Workspace limit: ${MAX_OPERATOR_UNITS} operators`,
            `Delegation depth: ${creationGrant.maxDelegationDepth}`,
            `Creation hosts: ${
              creationGrant.networkHosts.join(", ") || "none"
            }`,
          ]
          : ["No further operator creation rights"]),
      ];
    }
    const { requestType, networkHosts, creationGrant } = change.operator;
    return [
      requestType.name,
      `up to ${requestType.maxInvocations} invocations`,
      networkHosts.length ? networkHosts.join(", ") : "no network",
      ...(creationGrant
        ? [
          `Creation grant: up to ${creationGrant.maxChildren} operators`,
          `Workspace limit: ${MAX_OPERATOR_UNITS} operators`,
          `Delegation depth: ${creationGrant.maxDelegationDepth}`,
          `Creation hosts: ${creationGrant.networkHosts.join(", ") || "none"}`,
        ]
        : []),
    ];
  }
  return [];
}
/**
 * The hosts a new team member may reach. Creations persisted before E2 carry
 * them at the spec root and no provision: those recorded hosts are shown,
 * never an invented provision.
 */
function memberHosts(spec: TeamOperatorSpec): string[] {
  return spec.provision?.networkHosts ??
    (spec as unknown as { networkHosts?: string[] }).networkHosts ?? [];
}

/** One right of a new team member: a mark, a few words, the exact sentence. */
export interface MemberFact {
  kind: "request" | "network" | "creation";
  label: string;
  detail: string;
}

/**
 * Where a new team member works, what it reaches and whom it may create, read
 * from the rights its creation records: a member always works in its Request.
 */
export function memberFacts(spec: TeamOperatorSpec): MemberFact[] {
  const hosts = memberHosts(spec);
  const grant = spec.creationGrant;
  return [{
    kind: "request",
    label: "this Request",
    detail: "Contributes within this Request; opens no other Request",
  }, {
    kind: "network",
    label: hosts.length ? hosts.join(", ") : "no network",
    detail: hosts.length ? `Network hosts: ${hosts.join(", ")}` : "No network",
  }, {
    kind: "creation",
    label: grant ? `creates ≤ ${grant.maxChildren}` : "creates no one",
    detail: grant
      ? `Creation grant: up to ${grant.maxChildren} operators · delegation depth ${grant.maxDelegationDepth} · hosts ${
        grant.networkHosts.join(", ") || "none"
      }`
      : "No operator creation rights",
  }];
}
/** Current configuration is a valid before only for a still-pending exact base. */
export function changeDifferences(
  change: PendingChange,
  context: NonNullable<AgentConversation["proposalContext"]>,
): ProposalDifference[] {
  if (
    change.status !== "pending" ||
    change.baseRevision !== context.configurationRevision
  ) return [];
  const rights = change.requestedRights;
  const before = context.before;
  if (rights && "operatorCreation" in rights) {
    return [{
      id: "operator-creation-policy",
      label: "Team creation rights",
      before: "None",
      after: changeScope(change).join("\n"),
    }];
  }
  if (rights && "toolAdmission" in rights) {
    const request = rights.toolAdmission;
    return [{
      id: "tool-admission-policy",
      label: "Operator tool admission",
      before: request.expectedPolicyRevision
        ? `Revision ${request.expectedPolicyRevision}`
        : "None",
      after: request.enabled ? changeScope(change).join("\n") : "Revoked",
    }];
  }
  if (change.kind === "reviewer-creation") {
    return [{
      id: "reviewer",
      label: "Reviewer",
      before: before.reviewer?.name || "None",
      after: change.name || "Reviewer",
    }, {
      id: "admission",
      label: "Approval to use a new tool",
      before: authority[before.builder.admissionAuthority],
      after: change.name || "The reviewer",
    }];
  }
  if (change.kind === "operator-creation") {
    const scope = changeScope(change);
    return [
      {
        id: "operator",
        label: "Operator",
        before: "None",
        after: change.name || "New operator",
      },
      ...(scope.length
        ? [{
          id: change.operator && isTeamOperatorSpec(change.operator)
            ? "request-team"
            : "request-type",
          label: change.operator && isTeamOperatorSpec(change.operator)
            ? "Request team"
            : "Request type",
          before: "None",
          after: scope.join("\n"),
        }]
        : []),
    ];
  }
  if (rights && "grantModelEditing" in rights) {
    return [{
      id: "model-editing",
      label: "Model editing",
      before: "None",
      after: changeScope(change).join("\n"),
    }];
  }
  if (rights && "addNetworkHosts" in rights) {
    return [{
      id: "hosts",
      label: "Allowed sites",
      before: before.network.allowedHosts.join("\n") || "None",
      after: [
        ...new Set([
          ...before.network.allowedHosts,
          ...rights.addNetworkHosts,
        ]),
      ].join("\n") || "None",
    }];
  }
  if (rights && "mayAdmitOwnCandidates" in rights) {
    return [{
      id: "authority",
      label: "Approval to use its new tools",
      before: authority[before.builder.admissionAuthority],
      after: "The agent, after checks",
    }];
  }
  if (rights && "setUrlSelectionMode" in rights) {
    const modes = {
      "user-provided": "Pages given in the request",
      "authorized-host": "Pages of the allowed sites",
    };
    return [{
      id: "url",
      label: "Readable pages",
      before: before.urlSelectionMode
        ? modes[before.urlSelectionMode]
        : "Not set",
      after: modes[rights.setUrlSelectionMode],
    }];
  }
  return [];
}
export function candidateDifferences(
  candidate: Candidate,
): ProposalDifference[] {
  return [{
    id: candidate.id,
    label: "Tool available",
    before: "No",
    after: candidate.name,
  }, {
    id: "output",
    label: "Read result",
    before: "—",
    after: candidate.kind === "read_web_page_outline"
      ? "Title, section headings and links"
      : "Title and page text",
  }];
}
