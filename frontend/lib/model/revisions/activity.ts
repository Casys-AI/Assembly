import type { ModelChangedFile } from "../../../../src/domain/model/records/revision.ts";
import { authorLabel, type AuthorRoster, proposalAuthor } from "./authors.ts";
import type { ChangeOutcome, DiffStats } from "./change.ts";
import { filesHref } from "../sources/files.ts";
import type {
  RevisionSelection,
  RevisionSnapshot,
  SourceCommit,
  SourceDiff,
} from "./api.ts";
import {
  commitRows,
  proposalOfCommit,
  type ProposalRow,
  proposalRows,
} from "./rows.ts";

/**
 * What the Activity page lists, read from one snapshot of the model's history:
 * what waits for the person, what main accepted, what was declined. Pure, so
 * the same snapshot always reads the same. The host's authors are only given a
 * label here (model-authors.ts); the changes of a row are read on demand.
 */

/** The two versions whose difference is the change a row makes. */
export interface ActivityChange {
  base: string;
  target: string;
}

export interface ActivityRow {
  /**
   * What the row is, whatever it becomes: an accepted proposal keeps the key it
   * had while it waited, so a row left open stays open through its acceptance.
   */
  key: string;
  /** The revision the row opens as. */
  selection: RevisionSelection;
  title: string;
  /** Waiting, merged into main (accepted), declined, or a publication of the host. */
  state: ChangeOutcome;
  /** Who proposed, who accepted: "proposed by Designer, accepted by You". */
  byline: string;
  createdAt: string;
  /** The commit, short; a proposal has none. */
  short?: string;
  /** The version the change leads to; none for a proposal still prepared. */
  version?: string;
  /** The head of main. */
  main: boolean;
  /** A proposal that waits for something other than the person. */
  stage?: "preparing" | "accepting";
  /** What the change amounts to, once known. */
  size?: DiffStats;
  /** What a commit changed, as Git counted it; a proposal's are read from its diff. */
  files?: readonly ModelChangedFile[];
  /** The difference to read for the diff; none for the initial commit, which has no parent. */
  change?: ActivityChange;
}

export type ActivityGroupId = "waiting" | "accepted" | "declined";

export interface ActivityGroup {
  id: ActivityGroupId;
  label: string;
  rows: ActivityRow[];
}

/** What Git counted for a commit; a change compared as text is `diffStats`. */
const sizeOfCommit = (commit: SourceCommit): DiffStats => ({
  files: commit.files.length,
  additions: commit.additions,
  deletions: commit.deletions,
});

/**
 * The feed: the proposals that wait for the person (preparing, proposed or
 * being accepted) first, then main's commits newest first, then the declined
 * proposals. An accepted proposal is its commit's row, so it is told once; a
 * commit with no proposal behind it is a publication of the host. Groups with
 * nothing in them are left out. `sizeOf` says what a change amounts to once it
 * is read: a proposal has no file counts before that.
 */
export function activityGroups(
  snapshot: RevisionSnapshot,
  roster: AuthorRoster,
  sizeOf: (change: ActivityChange) => DiffStats | undefined = () => undefined,
): ActivityGroup[] {
  const proposals = new Map(
    snapshot.revisions.proposals.map((proposal) => [proposal.id, proposal]),
  );
  const proposalActivity = (row: ProposalRow): ActivityRow => {
    const proposal = proposals.get(row.id)!;
    const change = proposal.proposalVersion
      ? { base: proposal.baseVersion, target: proposal.proposalVersion }
      : undefined;
    const size = change && sizeOf(change);
    return {
      key: `proposal:${proposal.id}`,
      selection: { kind: "proposal", id: proposal.id },
      title: row.title,
      state: row.state,
      byline: `proposed by ${authorLabel(proposalAuthor(proposal), roster)}`,
      createdAt: proposal.createdAt,
      version: proposal.proposalVersion,
      main: false,
      ...(proposal.status === "preparing" || proposal.status === "accepting"
        ? { stage: proposal.status }
        : {}),
      ...(size ? { size } : {}),
      ...(change ? { change } : {}),
    };
  };

  const ordered = proposalRows(snapshot);
  const commits = new Map(
    snapshot.history.commits.map((commit) => [commit.version, commit]),
  );
  // A proposal is accepted as one commit; the key is held by the first it finds.
  const taken = new Set<string>();
  const commitActivity = commitRows(snapshot).map((row): ActivityRow => {
    const commit = commits.get(row.id)!;
    const proposal = proposalOfCommit(commit, snapshot);
    const key = proposal && !taken.has(proposal.id)
      ? `proposal:${proposal.id}`
      : `commit:${commit.version}`;
    if (proposal) taken.add(proposal.id);
    const committer = authorLabel(commit.parsedAuthor, roster);
    return {
      key,
      selection: { kind: "commit", id: commit.version },
      title: row.title,
      state: proposal ? "accepted" : "applied",
      byline: proposal
        ? `proposed by ${
          authorLabel(proposalAuthor(proposal), roster)
        }, accepted by ${committer}`
        : `admitted by ${committer}`,
      createdAt: commit.createdAt,
      short: row.short,
      version: commit.version,
      main: row.main,
      size: sizeOfCommit(commit),
      files: commit.files,
      ...(commit.parentVersion
        ? { change: { base: commit.parentVersion, target: commit.version } }
        : {}),
    };
  });

  const groups: ActivityGroup[] = [
    {
      id: "waiting",
      label: "Waiting for you",
      rows: ordered.filter((row) => row.state === "pending").map(
        proposalActivity,
      ),
    },
    { id: "accepted", label: "Accepted", rows: commitActivity },
    {
      id: "declined",
      label: "Declined",
      rows: ordered.filter((row) => row.state === "declined").map(
        proposalActivity,
      ),
    },
  ];
  return groups.filter((group) => group.rows.length > 0);
}

/** A changed file, and where it can be read when it still can. */
export interface ActivityFile extends ModelChangedFile {
  /** The Files page at that file; none for a file the change removed. */
  href?: string;
}

const statusOfKind: Record<
  SourceDiff["files"][number]["kind"],
  ModelChangedFile["status"]
> = {
  added: "added",
  changed: "modified",
  deleted: "deleted",
};

/**
 * The files a row changed, each with the address of the file as it is after
 * the change: on main for the head, which moves with it, and at the row's own
 * version for the others. A commit's files are Git's own; a proposal's are
 * those of its diff once read (before that, none). A removed file has nothing
 * to open.
 */
export function activityFiles(
  row: Pick<ActivityRow, "files" | "main" | "version">,
  diff?: SourceDiff,
): ActivityFile[] {
  const files: readonly ModelChangedFile[] = row.files ??
    diff?.files.map((file) => ({
      path: file.path,
      status: statusOfKind[file.kind],
      additions: file.additions,
      deletions: file.deletions,
    })) ?? [];
  const version = row.main ? undefined : row.version;
  return files.map((file) => ({
    ...file,
    ...(file.status === "deleted"
      ? {}
      : { href: filesHref({ file: file.path, version }) }),
  }));
}
