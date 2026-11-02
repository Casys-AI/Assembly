import assert from "node:assert/strict";
import type { AgentPort } from "../../src/application/work/runtime/ports.ts";
import type { ChatDecision } from "../../src/domain/work/dialogue.ts";
import { MAX_BRANCH_TEAM } from "../../src/domain/work/records/conversations.ts";

export const PRIMARY_NAME = "Main Operator";

/** Branch provider double: the BO proposes the teammate it is armed with,
 * every other turn replies. It decides nothing on anyone's behalf. */
export function branchTeamAgent() {
  const creations = new Map<
    string,
    Array<{ name: string; operator: string; grant?: boolean }>
  >();
  const contributions = new Map<
    string,
    { member: string; inputText: string }
  >();
  const proposals = new Map<string, string>();
  const seen: Array<{ caseId: string; operator: string; text?: string }> = [];
  const agent: AgentPort = {
    label: "Controlled branch team witness",
    decide(context) {
      const caseId = context.case?.id ?? "";
      const operator = context.operator?.name ?? "";
      seen.push({ caseId, operator });
      if (proposals.get(caseId) === operator) {
        proposals.delete(caseId);
        return Promise.resolve({
          kind: "propose_mandate_change",
          text: "Request the page host",
          reason: "Read the selected page",
          requestedRights: { addNetworkHosts: ["example.org"] },
        } as ChatDecision);
      }
      const queue = creations.get(caseId) ?? [];
      const selectedInput = context.messages.find((message) =>
        message.id === context.activeInputMessageId
      );
      const contribution = contributions.get(caseId);
      if (
        operator === PRIMARY_NAME && contribution &&
        selectedInput?.text === contribution.inputText
      ) {
        const { member } = contribution;
        // The BO reaches its member through the inbox access its creation
        // published (parent to child).
        contributions.delete(caseId);
        const child = queue.find((entry) => entry.operator === member);
        const behavior = context.modeledBehaviors?.find((entry) =>
          entry.description.includes(member)
        );
        assert(behavior, `The BO holds an inbox access to ${member}`);
        return Promise.resolve({
          kind: "invoke_behavior",
          text: `Ask ${member} for a passage`,
          behaviorId: behavior.id,
          inputJson: JSON.stringify({
            text: child
              ? `Create a teammate named ${child.name}.`
              : "Extract the first passage.",
          }),
        } as ChatDecision);
      }
      if (
        queue[0]?.operator === operator &&
        selectedInput?.text.includes(queue[0].name)
      ) {
        const { name, grant } = queue.shift()!;
        return Promise.resolve({
          kind: "propose_agent_creation",
          text: `Create ${name}`,
          name,
          reason: "One passage needs its own reader",
          role: "operator",
          operator: {
            kind: "request-team-member",
            ...(grant
              ? {
                creationGrant: {
                  networkHosts: [],
                  maxChildren: MAX_BRANCH_TEAM,
                  maxDelegationDepth: 0,
                },
              }
              : {}),
            // Each teammate has its own mission: two identical creations
            // cannot be told apart by their receipts (see the 4.8e log).
            instruction: `Extract one passage for this Request as ${name}.`,
            provision: {
              budget: {
                maxAgentDecisions: 2,
                maxToolProposals: 1,
                maxFlowSteps: 32,
              },
              networkHosts: [],
              mayPropose: [],
              mayInvokeActiveCatalog: false,
              ...(["Network reader", "Covered reader"].includes(name)
                ? { mayAddNetworkHosts: true }
                : {}),
            },
          },
        } as ChatDecision);
      }
      return Promise.resolve({
        kind: "reply",
        text: `Observed by ${operator}`,
      });
    },
    review() {
      throw new Error("The branch team witness never reviews a candidate");
    },
  };
  return {
    agent,
    seen,
    armCreation(
      caseId: string,
      name: string,
      operator = PRIMARY_NAME,
      grant = false,
    ) {
      creations.set(caseId, [...(creations.get(caseId) ?? []), {
        name,
        operator,
        grant,
      }]);
    },
    armProposal(caseId: string, member: string) {
      proposals.set(caseId, member);
    },
    armContribution(caseId: string, member: string, inputText: string) {
      contributions.set(caseId, { member, inputText });
    },
  };
}

/** Main provider double: ordinary notifications observe; a grant belongs to its selected input. */
export function observingMain() {
  let turns = 0;
  let order: { caseId: string; operatorId: string } | undefined;
  let grant:
    | { caseId: string; operatorId: string; inputText: string }
    | undefined;
  let decideCovered = false;
  const agent: AgentPort = {
    label: "Observing Main Operator",
    decide(context) {
      turns++;
      const selectedInput = context.messages.find((message) =>
        message.id === context.activeInputMessageId
      );
      if (grant && selectedInput?.text === grant.inputText) {
        const target = grant;
        grant = undefined;
        return Promise.resolve({
          kind: "propose_mandate_change",
          text: "Request authority",
          reason: "Decide a member network request",
          requestedRights: {
            operatorAuthority: {
              policyId: "member-network",
              expectedPolicyRevision: 0,
              enabled: true,
              recipients: [target.operatorId],
              recipientCaseId: target.caseId,
              acts: ["addNetworkHosts"],
              networkHosts: ["example.org"],
              toolIds: [],
              maxDelegationDepth: 0,
            },
          },
        } as unknown as ChatDecision);
      }
      if (decideCovered) {
        const request = context.operatorAuthority?.requests.find((entry) =>
          entry.requestedBy !== PRIMARY_NAME
        );
        if (request) {
          decideCovered = false;
          return Promise.resolve({
            kind: "decide_operator_change",
            text: "Approve covered member request",
            operatorId: request.requestedBy,
            changeId: request.id,
            expectedRevision: request.baseRevision,
            policyId: "member-network",
            policyRevision: 1,
            verdict: "approve",
          } as ChatDecision);
        }
      }
      if (order) {
        const target = order;
        order = undefined;
        return Promise.resolve({
          kind: "resume_request",
          text: "Order the member",
          caseId: target.caseId,
          operatorId: target.operatorId,
          resumeId: "member-order-1",
          instruction: "List the page headings.",
        } as ChatDecision);
      }
      return Promise.resolve({ kind: "reply", text: "Observed" });
    },
    review() {
      throw new Error("The Main witness never reviews a candidate");
    },
  };
  return {
    agent,
    turns: () => turns,
    armGrant(
      target: { caseId: string; operatorId: string; inputText: string },
    ) {
      grant = target;
    },
    armCoveredDecision() {
      decideCovered = true;
    },
    armOrder(target: { caseId: string; operatorId: string }) {
      order = target;
    },
  };
}
