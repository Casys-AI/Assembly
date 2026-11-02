import { useEffect } from "preact/hooks";
import type { Candidate } from "../../../src/domain/work/candidates.ts";
import type {
  PendingChange,
} from "../../../src/domain/governance/records/pending-change.ts";
import { caseHref } from "../../lib/cases/cases.ts";
import {
  authorityName,
  authorityOwner,
  type AuthorityReading,
  type AuthorityRoster,
  currentAuthorityLabel,
  delegatedDecisionLabel,
  recordedCandidateDelegation,
  recordedDelegation,
  recordedOwnerAuthority,
} from "../../lib/conversations/operator-authority.ts";
import type { WorkbenchState } from "../../lib/workbench/state.ts";
import { modelLive } from "../../lib/model/live.ts";

type AuthorityStore = WorkbenchState["chatProposals"];
const sourceFollowers = new WeakMap<
  AuthorityStore,
  Map<string, { users: number; stop(): void }>
>();

/** One source reread per owner and announcement, shared by its visible cards. */
function followAuthority(store: AuthorityStore, owner: string) {
  let owners = sourceFollowers.get(store);
  if (!owners) sourceFollowers.set(store, owners = new Map());
  let follower = owners.get(owner);
  if (!follower) {
    follower = {
      users: 0,
      stop: modelLive.follow(() => store.refresh(owner)),
    };
    owners.set(owner, follower);
    // No follower listened while the last card was absent. Recheck on return.
    void store.refresh(owner);
  }
  follower.users++;
  return () => {
    if (--follower.users === 0) {
      follower.stop();
      owners.delete(owner);
    }
  };
}

/** Recorded facts inside an existing change card, never a decision surface. */
export function OperatorAuthorityFacts(
  { change, roster = [], reading, historical = false }: {
    change: PendingChange;
    roster?: AuthorityRoster;
    reading?: AuthorityReading;
    historical?: boolean;
  },
) {
  const request =
    change.requestedRights && "toolAdmission" in change.requestedRights
      ? change.requestedRights.toolAdmission
      : change.requestedRights && "operatorAuthority" in change.requestedRights
      ? change.requestedRights.operatorAuthority
      : undefined;
  const delegated = recordedDelegation(change);
  if (!request && !change.authorityExercise?.delegation) return null;
  if (!request && !delegated) {
    return <p class="proposal-notice">Decision receipt unavailable</p>;
  }
  const owner = authorityOwner(change);
  const policyId = request?.policyId ?? delegated!.policyId;
  const revision = request
    ? request.expectedPolicyRevision + 1
    : delegated!.policyRevision;
  const title = delegatedDecisionLabel(change, roster) ??
    (change.status === "pending"
      ? "Awaiting person"
      : change.status === "refused"
      ? "Policy proposal declined"
      : !change.publishedCommit
      ? "Approved · publication pending"
      : request?.enabled
      ? request.expectedPolicyRevision === 0
        ? "Policy grant published"
        : "Policy revision published"
      : "Policy revocation published");
  const person = recordedOwnerAuthority(change);
  const actor = delegated?.actorId ?? person?.operatorNativeId;
  const toolAdmission = request && "toolKinds" in request;
  const hosts =
    (request && "networkHosts" in request ? request.networkHosts : undefined) ??
      (change.requestedRights && "addNetworkHosts" in change.requestedRights
        ? change.requestedRights.addNetworkHosts
        : []);
  const recipients = request?.recipients ?? [delegated!.requestedBy];
  const space = request?.recipientExecutionSpaceId;
  const rows: Array<{ label: string; value: string; identity?: string }> = [
    {
      label: "Policy",
      value: request ? policyId : `${policyId} · revision ${revision}`,
    },
    ...(request
      ? [{
        label: "Expected current revision",
        value: String(request.expectedPolicyRevision),
      }, {
        label: change.status === "approved" && change.publishedCommit
          ? "Published revision"
          : "Proposed revision",
        value: String(revision),
      }]
      : []),
    { label: "Change", value: change.id },
    ...(actor
      ? [{
        label: "Decided by",
        value: person ? "System owner" : authorityName(roster, actor),
        identity: actor,
      }]
      : []),
    ...(owner
      ? [{
        label: "Holder",
        value: authorityName(roster, owner),
        identity: owner,
      }]
      : []),
    {
      label: "Recipients",
      // A named space is a Case branch: its operator shares a main native ID
      // but is another instance (4.8c C2).
      value: space
        ? `${
          recipients.map((id) =>
            `Branch Operator of ${authorityName(roster, id)}`
          ).join(", ")
        } · branch ${space.slice(0, 8)}`
        : recipients.map((id) => authorityName(roster, id)).join(", "),
      identity: `${recipients.join(", ")}${space ? ` @ ${space}` : ""}`,
    },
    {
      label: "Act",
      value: toolAdmission
        ? "Admit exact tested candidates"
        : "Add exact network hosts",
    },
    ...(toolAdmission
      ? [{ label: "Tool kinds", value: request.toolKinds.join(", ") }, {
        label: "Network decisions",
        value: "Not included",
      }]
      : [{
        label: request ? "Allowed hosts" : "Hosts in this decision",
        value: hosts.join(", "),
      }, { label: "Tool admission", value: "Not included" }]),
    { label: "Further delegation", value: "Not allowed · depth 0" },
  ];
  return (
    <details
      class="proposal-rationale operator-authority"
      data-authority={toolAdmission ? "tool-admission" : "network"}
    >
      <summary>{title}</summary>
      <dl class="operator-authority-facts">
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}{row.identity && <code>{row.identity}</code>}</dd>
          </div>
        ))}
        {change.caseId && (
          <div>
            <dt>Request</dt>
            <dd>
              <a href={caseHref(change.caseId)}>{change.caseId}</a>
            </dd>
          </div>
        )}
        {change.publishedCommit && (
          <div>
            <dt>Published commit</dt>
            <dd>
              <code>{change.publishedCommit}</code>
            </dd>
          </div>
        )}
        {change.designerScopeId && (
          <div>
            <dt>Design conversation</dt>
            <dd>
              <code>{change.designerScopeId}</code>
            </dd>
          </div>
        )}
        {!historical && (
          <div>
            <dt>Current sources</dt>
            <dd>{currentAuthorityLabel(change, reading)}</dd>
          </div>
        )}
      </dl>
      {historical && (
        <p>
          Recorded at this revision. This receipt does not describe current
          policy status.
        </p>
      )}
    </details>
  );
}

/** The recorded delegate and owning operator remain distinct after publication. */
export function CandidateAuthorityFacts(
  { candidate, operatorId, roster = [] }: {
    candidate: Candidate;
    operatorId: string;
    roster?: AuthorityRoster;
  },
) {
  const proof = recordedCandidateDelegation(candidate, operatorId);
  const claimed =
    candidate.admissionDecision?.authorityExercise?.candidateDelegation ||
    candidate.admission?.authority === "delegate";
  if (!proof) {
    return claimed
      ? <p class="proposal-notice">Decision receipt unavailable</p>
      : null;
  }
  const verdict = candidate.admissionDecision!.verdict;
  const label = verdict === "refuse"
    ? "Declined"
    : candidate.admission
    ? "Admitted"
    : "Decided";
  return (
    <details
      class="proposal-rationale operator-authority"
      data-authority="candidate-admission"
    >
      <summary>
        {label} by {authorityName(roster, proof.actorId)} · {proof.policyId}
        {" "}
        revision {proof.policyRevision}
      </summary>
      <dl class="operator-authority-facts">
        <div>
          <dt>Decided by</dt>
          <dd>
            {authorityName(roster, proof.actorId)}
            <code>{proof.actorId}</code>
          </dd>
        </div>
        <div>
          <dt>Owning operator</dt>
          <dd>
            {authorityName(roster, operatorId)}
            <code>{operatorId}</code>
          </dd>
        </div>
        <div>
          <dt>Authority</dt>
          <dd>Delegate under the person’s tool admission grant</dd>
        </div>
        <div>
          <dt>Policy</dt>
          <dd>{proof.policyId} · revision {proof.policyRevision}</dd>
        </div>
        <div>
          <dt>Grant issuer</dt>
          <dd>
            System owner<code>{proof.policyIssuer.operatorNativeId}</code>
          </dd>
        </div>
        <div>
          <dt>Candidate</dt>
          <dd>
            <code>{proof.candidateId}</code>
          </dd>
        </div>
        <div>
          <dt>Candidate digest</dt>
          <dd>
            <code>{proof.candidateDigest}</code>
          </dd>
        </div>
        <div>
          <dt>Request</dt>
          <dd>
            <a href={caseHref(proof.caseId)}>{proof.caseId}</a>
          </dd>
        </div>
        <div>
          <dt>Tool kind</dt>
          <dd>{proof.toolKind}</dd>
        </div>
        <div>
          <dt>Decision reason</dt>
          <dd>{candidate.admissionDecision!.reason}</dd>
        </div>
      </dl>
      <p>
        Recorded decision. This receipt does not describe current policy status.
      </p>
    </details>
  );
}

/** Read source authority in its native owner's scope; historical facts stay fixed. */
export function ObservedOperatorAuthority(
  { change, state, historical = false }: {
    change: PendingChange;
    state: WorkbenchState;
    historical?: boolean;
  },
) {
  const owner = authorityOwner(change);
  const store = state.chatProposals;
  const frozen = historical || state.readOnly.value;
  const systemId = state.current.value?.id;
  const generation = store.generation.value;
  const online = state.connection.value === "live";
  useEffect(() => {
    if (frozen || !online || !owner || !systemId) return;
    return followAuthority(store, owner);
  }, [store, owner, frozen, online, systemId]);
  useEffect(() => {
    if (frozen || !online || !owner || !systemId || store.loadingFor(owner)) {
      return;
    }
    if (!store.visible(owner) || store.isStale(owner)) {
      void store.refresh(owner);
    }
  }, [owner, frozen, online, systemId, generation]);
  const reading = !frozen && owner
    ? {
      data: store.visible(owner),
      fresh: online && Boolean(sourceFollowers.get(store)?.has(owner)) &&
        !store.isStale(owner) && !store.loadingFor(owner) &&
        !store.errorFor(owner),
    }
    : undefined;
  return (
    <OperatorAuthorityFacts
      change={change}
      roster={state.conversationSnapshot.value?.conversations}
      reading={reading}
      historical={frozen}
    />
  );
}
