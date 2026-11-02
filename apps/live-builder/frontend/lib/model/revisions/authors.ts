import type { ModelCommitAuthor } from "../../../../src/domain/model/records/revision.ts";
import { proposalOwner } from "../../conversations/proposals.ts";
import { operatorName } from "./change.ts";
import type { SourceProposal } from "./api.ts";

/**
 * The name a person recognises for who made a change to the model. The host
 * parses a raw commit author once (`parsedAuthor` on every commit it lists):
 * this only turns what it parsed into a label, so no page reads a raw author
 * again. A proposal carries the host's pinned authorization instead, the one
 * fact the conversations and To decide already name its operator by.
 */

/** The operators that can be named: the roster of the system. */
export type AuthorRoster = readonly { nativeId: string; name: string }[];

/**
 * Who proposed a change, in the shape the host gives a commit's author. The
 * authorization the host pinned when the proposal was made says it: the person
 * (`local-owner`), or the operator it was made for (`proposalOwner`, the same
 * reading To decide names an operator by). A proposal without that proof is an
 * author the page does not recognise, and keeps what the host gave.
 */
export function proposalAuthor(
  proposal: Pick<SourceProposal, "author" | "authorization">,
): ModelCommitAuthor {
  if (proposal.authorization?.kind === "local-owner") {
    return { kind: "owner", ref: proposal.author };
  }
  const operator = proposalOwner(proposal);
  return operator
    ? { kind: "agent", ref: operator }
    : { kind: "unknown", ref: proposal.author };
}

/**
 * The members of the system who can be named: the operators that own a runtime
 * first, then everyone else the system's roster holds (an operator that only
 * took part in a review wrote changes too). One entry for each identity.
 */
export function authorRoster(
  operators: AuthorRoster,
  everyone: AuthorRoster = [],
): AuthorRoster {
  const seen = new Set(operators.map((operator) => operator.nativeId));
  return [
    ...operators,
    ...everyone.filter((member) => !seen.has(member.nativeId)),
  ];
}

/** "approved-change" is the name of an operation of Assembly: "approved change". */
const operation = (ref: string) => ref.split(":")[0].replaceAll("-", " ");

/**
 * The label of an author, or `undefined` when the page cannot name it: an
 * operator the roster lacks, an author the host does not recognise.
 * - the person and the host's own control are "You";
 * - an operator is named by the roster, never by its identity;
 * - Assembly is named, followed by what it did when it says so.
 */
export function authorName(
  author: ModelCommitAuthor,
  roster: AuthorRoster,
): string | undefined {
  switch (author.kind) {
    case "owner":
    case "host":
      return "You";
    case "agent":
      return operatorName(roster, author.ref);
    case "ase":
      return author.ref === "ase"
        ? "Assembly"
        : `Assembly · ${operation(author.ref)}`;
    case "unknown":
      return undefined;
  }
}

/**
 * Like `authorName`, and always something to read. An operator the roster
 * lacks is "An operator", never its identity; only an author the host itself
 * did not recognise is shown as the host gave it, as there is nothing better.
 */
export function authorLabel(
  author: ModelCommitAuthor,
  roster: AuthorRoster,
): string {
  return authorName(author, roster) ??
    (author.kind === "unknown" ? author.ref : "An operator");
}
