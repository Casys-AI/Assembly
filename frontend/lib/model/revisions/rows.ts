import {
  type RevisionSelection,
  type RevisionSnapshot,
  sameSourceVersion,
  selectedRevision,
  selectionBase,
  type SourceCommit,
  type SourceProposal,
} from "./api.ts";
import { type ChangeOutcome, shortCommit } from "./change.ts";
import { authorName, type AuthorRoster, proposalAuthor } from "./authors.ts";

/**
 * What the Revisions page lists and shows, read from one snapshot of the
 * model's history: pure, so the same snapshot always reads the same.
 */

/** The two lists of the page: what main holds, and what is proposed to it. */
export type RevisionTab = RevisionSelection["kind"];

/** Where a proposal stands for the person who decides: never yet applied. */
export type ProposalState = Exclude<ChangeOutcome, "applied">;

/** The version an operator has in service. */
export interface OperatorRun {
  name: string;
  version: string | undefined;
}

export interface CommitRow {
  kind: "commit";
  /** The version of the commit, as the history gives it. */
  id: string;
  title: string;
  short: string;
  createdAt: string;
  author?: string;
  /** The head of main. */
  main: boolean;
  /** An operator runs this version. */
  running: boolean;
  /** The operators that run it, by name; none when only the host's runtime does. */
  runningFor: readonly string[];
}

export interface ProposalRow {
  kind: "proposal";
  id: string;
  title: string;
  createdAt: string;
  author?: string;
  branch?: string;
  status: SourceProposal["status"];
  state: ProposalState;
}

export type RevisionRow = CommitRow | ProposalRow;

/** Preparing, proposed and accepting proposals wait; the others are settled. */
export function proposalState(status: SourceProposal["status"]): ProposalState {
  return status === "accepted"
    ? "accepted"
    : status === "rejected"
    ? "declined"
    : "pending";
}

/**
 * The proposal a commit is the acceptance of. The host's journal says so
 * (`proposalId`); a commit read without it is matched to the proposal accepted
 * as that version.
 */
export function proposalOfCommit(
  commit: SourceCommit,
  snapshot: RevisionSnapshot,
): SourceProposal | undefined {
  const proposals = snapshot.revisions.proposals;
  return proposals.find((proposal) => proposal.id === commit.proposalId) ??
    proposals.find((proposal) =>
      sameSourceVersion(proposal.acceptedVersion, commit.version)
    );
}

/**
 * A commit is named by the reason of the proposal that created it, otherwise by
 * its own message.
 */
export function commitTitle(
  commit: SourceCommit,
  snapshot: RevisionSnapshot,
): string {
  return proposalOfCommit(commit, snapshot)?.reason || commit.message ||
    "Model commit";
}

/**
 * Main's commits, newest first as the history gives them. Each operator has one
 * version in service: `running` says which, so a commit runs for those whose
 * version it is. Without a runtime read, the host's own runtime stands for it.
 */
export function commitRows(
  snapshot: RevisionSnapshot,
  running: readonly OperatorRun[] = [],
  operators: AuthorRoster = [],
): CommitRow[] {
  const hosts = snapshot.revisions.runtime.active?.repositoryVersion;
  return snapshot.history.commits.map((commit) => {
    const runningFor = running.filter((entry) =>
      sameSourceVersion(entry.version, commit.version)
    ).map((entry) => entry.name);
    return {
      kind: "commit",
      id: commit.version,
      title: commitTitle(commit, snapshot),
      short: shortCommit(commit.version),
      createdAt: commit.createdAt,
      author: authorName(commit.parsedAuthor, operators),
      main: sameSourceVersion(commit.version, snapshot.revisions.version),
      running: running.length > 0
        ? runningFor.length > 0
        : sameSourceVersion(commit.version, hosts),
      runningFor,
    };
  });
}

const stateOrder: Record<ProposalState, number> = {
  pending: 0,
  accepted: 1,
  declined: 2,
};

/**
 * Every proposal: those waiting first, then the accepted, then the declined,
 * each group newest first as the repository lists them.
 */
function proposalTitle(reason: string): string {
  const firstLine = reason.split(/\r?\n/).find((line) => line.trim())?.trim() ??
    "";
  return firstLine.length > 100 ? `${firstLine.slice(0, 99)}…` : firstLine;
}

function proposalBranch(proposal: SourceProposal): string | undefined {
  return typeof proposal.branch === "string" && proposal.branch.trim()
    ? proposal.branch
    : undefined;
}

export function proposalRows(
  snapshot: RevisionSnapshot,
  operators: AuthorRoster = [],
): ProposalRow[] {
  return snapshot.revisions.proposals.map((proposal): ProposalRow => ({
    kind: "proposal",
    id: proposal.id,
    title: proposalTitle(proposal.reason),
    createdAt: proposal.createdAt,
    author: authorName(proposalAuthor(proposal), operators),
    branch: proposalBranch(proposal),
    status: proposal.status,
    state: proposalState(proposal.status),
  })).sort((a, b) => stateOrder[a.state] - stateOrder[b.state]);
}

/** How many proposals wait for a decision: the count on the Proposals tab. */
export function openProposals(snapshot: RevisionSnapshot): number {
  return snapshot.revisions.proposals.filter((proposal) =>
    proposal.status === "proposed"
  ).length;
}

/** Whether a row is the one the page shows. */
export function isShown(
  row: RevisionRow,
  selection: RevisionSelection | undefined,
): boolean {
  return selection?.kind === row.kind &&
    (row.kind === "commit"
      ? sameSourceVersion(row.id, selection.id)
      : row.id === selection.id);
}

export interface ShownRevision {
  selection: RevisionSelection;
  /** Missing when the address names a revision the loaded history lacks. */
  item: SourceCommit | SourceProposal | undefined;
}

/**
 * The revision a tab shows. The address names one of that tab's kind: it is
 * shown, found or not. Otherwise the tab opens on its most useful one: the head
 * of main, or the first proposal waiting for a decision.
 */
export function shownRevision(
  snapshot: RevisionSnapshot,
  tab: RevisionTab,
  named: RevisionSelection | undefined,
): ShownRevision | undefined {
  if (named?.kind === tab) {
    return { selection: named, item: selectedRevision(snapshot, named) };
  }
  if (tab === "commit") {
    const head = snapshot.history.commits.find((commit) =>
      sameSourceVersion(commit.version, snapshot.revisions.version)
    ) ?? snapshot.history.commits[0];
    return head && {
      selection: { kind: "commit", id: head.version },
      item: head,
    };
  }
  const rows = proposalRows(snapshot);
  const first = rows.find((row) => row.status === "proposed") ?? rows[0];
  return first && {
    selection: { kind: "proposal", id: first.id },
    item: snapshot.revisions.proposals.find((proposal) =>
      proposal.id === first.id
    ),
  };
}

/** What the detail of a revision says, apart from the changes it makes. */
export interface RevisionView {
  kind: RevisionTab;
  id: string;
  title: string;
  /** Who made it: the committer of a commit, the proposer of a proposal. */
  author?: string;
  branch?: string;
  reason?: string;
  proposalStatus?: SourceProposal["status"];
  createdAt: string;
  /** A commit is applied; a proposal is pending, accepted or declined. */
  state: ChangeOutcome;
  /** The proposal waits for a decision, and can be given one. */
  decidable: boolean;
  /** The commit it stands on: itself for a commit, the base for a proposal. */
  commit: string;
  commitLabel: string;
  /** What the changes are read against, and what they are read at. */
  base: string;
  target?: string;
  /** The commit an accepted proposal became. */
  mergedAs?: string;
  notice?: string;
}

/** A selected revision, read for the detail. */
export function revisionView(
  snapshot: RevisionSnapshot,
  selection: RevisionSelection,
  item: SourceCommit | SourceProposal,
  operators: readonly { nativeId: string; name: string }[],
): RevisionView {
  if (selection.kind === "commit") {
    const commit = item as SourceCommit;
    return {
      kind: "commit",
      id: commit.version,
      title: commitTitle(commit, snapshot),
      author: authorName(commit.parsedAuthor, operators),
      createdAt: commit.createdAt,
      state: "applied",
      decidable: false,
      commit: commit.version,
      commitLabel: "Commit",
      base: selectionBase(selection, commit),
      target: commit.version,
    };
  }
  const proposal = item as SourceProposal;
  return {
    kind: "proposal",
    id: proposal.id,
    title: proposalTitle(proposal.reason),
    author: authorName(proposalAuthor(proposal), operators),
    branch: proposalBranch(proposal),
    reason: proposal.reason,
    proposalStatus: proposal.status,
    createdAt: proposal.createdAt,
    state: proposalState(proposal.status),
    decidable: proposal.status === "proposed" &&
      proposal.authorization?.kind !== "operator-evolution",
    commit: proposal.baseVersion,
    commitLabel: "Base commit",
    base: selectionBase(selection, proposal),
    target: proposal.proposalVersion,
    mergedAs: proposal.acceptedVersion,
    notice: proposal.authorization?.kind === "operator-evolution"
      ? "This evolution is decided by its authorized operator in the originating conversation."
      : proposal.status === "preparing"
      ? "The operator is still preparing this proposal."
      : proposal.status === "accepting"
      ? "This proposal is being accepted."
      : proposal.rejectionReason
      ? `Reason: ${proposal.rejectionReason}`
      : undefined,
  };
}
