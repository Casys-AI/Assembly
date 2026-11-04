import { createSourceModel } from "./source-model-services.ts";
import { RequestNetworkChangePublisher } from "../application/model/publication/request-network-change-publisher.ts";
import { RequestChangeDecision } from "../application/work/request-spaces/request-change-decision.ts";
import type { RequestCaseChangeDecisionPort } from "../application/work/request-spaces/conversations.ts";
import { bindHostBackgroundTask } from "../infrastructure/host-background-task.ts";

/** Construct the real decision service (the person's and the MO's) from the
 * same production ports. Construction alone does not expose a route or start
 * an adoption. */
export function createRequestChangeDecision(
  options:
    & Omit<
      ConstructorParameters<typeof RequestChangeDecision>[0],
      "publisher"
    >
    & {
      publisher: Omit<
        ConstructorParameters<typeof RequestNetworkChangePublisher>[0],
        "createSourceModel"
      >;
    },
): RequestChangeDecision {
  const adoption = options.adoption;
  return new RequestChangeDecision({
    ...options,
    adoption: {
      status: (...args) => adoption.status(...args),
      prepareNetwork: (...args) => adoption.prepareNetwork(...args),
      prepareTeam: (...args) => adoption.prepareTeam(...args),
      resume: (...args) => adoption.resume(...args),
      statusDelegated: (...args) => adoption.statusDelegated(...args),
      statusCreationGrant: (...args) => adoption.statusCreationGrant(...args),
      // The Main Operator decides inside its own turn, a native delivery,
      // while adoption refuses an inherited execution fence: its delegated
      // adoption runs in the host context bound here, at composition.
      prepareNetworkDelegated: bindHostBackgroundTask((
        ...args: Parameters<typeof adoption.prepareNetworkDelegated>
      ) => adoption.prepareNetworkDelegated(...args)),
      resumeDelegated: bindHostBackgroundTask((
        ...args: Parameters<typeof adoption.resumeDelegated>
      ) => adoption.resumeDelegated(...args)),
      // A creation is likewise driven inside its creator's native turn.
      prepareTeamCreationGrant: bindHostBackgroundTask((
        ...args: Parameters<typeof adoption.prepareTeamCreationGrant>
      ) => adoption.prepareTeamCreationGrant(...args)),
      resumeCreationGrant: bindHostBackgroundTask((
        ...args: Parameters<typeof adoption.resumeCreationGrant>
      ) => adoption.resumeCreationGrant(...args)),
    },
    publisher: new RequestNetworkChangePublisher({
      ...options.publisher,
      createSourceModel,
    }),
  });
}

/** The person-facing port: a session secret only, never a delegated envelope
 * (4.8c A1). */
export function personRequestChangeDecision(
  decision: RequestChangeDecision,
): Required<RequestCaseChangeDecisionPort> {
  return {
    decide: (secret, record, command) =>
      decision.decide({ kind: "human", secret }, record, command),
    status: (secret, record, agentId, changeId) =>
      decision.status({ kind: "human", secret }, record, agentId, changeId),
    resume: (secret, record, agentId, changeId) =>
      decision.resume({ kind: "human", secret }, record, agentId, changeId),
  };
}
