import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { evolutionAuthorization } from "../../../test/support/evolution-fixture.ts";
import {
  commitRows,
  commitTitle,
  isShown,
  openProposals,
  proposalOfCommit,
  proposalRows,
  proposalState,
  revisionView,
  shownRevision,
} from "./rows.ts";
import type { SourceCommit } from "./api.ts";
import {
  DESIGNER,
  HEAD,
  history,
  operatorAuthorization,
  PARENT,
  PROPOSED,
  ROOT,
} from "../../../test/support/revision-fixture.ts";

const operators = [{ nativeId: DESIGNER, name: "Designer" }];

Deno.test("an evolution remains inspectable in Revisions without owner-control decision buttons", () => {
  const snapshot = history();
  const proposal = snapshot.revisions.proposals.find((entry) =>
    entry.status === "proposed"
  )!;
  proposal.authorization = evolutionAuthorization();
  const view = revisionView(
    snapshot,
    { kind: "proposal", id: proposal.id },
    proposal,
    operators,
  );
  equal(view.decidable, false);
  equal(view.target, proposal.proposalVersion);
  ok(view.notice?.includes("authorized operator"));
});

Deno.test("commits keep the history's order and carry their badges: main on the head, running on the version the operator runs", () => {
  const rows = commitRows(history());
  deepStrictEqual(rows.map((row) => row.id), [HEAD, PARENT, ROOT]);
  deepStrictEqual(rows.map((row) => row.main), [true, false, false]);
  deepStrictEqual(rows.map((row) => row.running), [false, true, false]);
  // The short hash is the seven characters a person recognises.
  equal(rows[0].short, "ccccccc");
});

Deno.test("each operator has one version in service: a commit runs for the operators whose version it is", () => {
  const snapshot = history();
  const rows = commitRows(snapshot, [
    { name: "Designer", version: PARENT },
    { name: "Reviewer", version: HEAD },
    { name: "Archivist", version: PARENT },
  ]);
  deepStrictEqual(rows.map((row) => row.running), [true, true, false]);
  deepStrictEqual(rows.map((row) => row.runningFor), [
    ["Reviewer"],
    ["Designer", "Archivist"],
    [],
  ]);
  // A version outside the loaded history marks no commit, and the host's own
  // runtime no longer speaks once the operators have.
  const elsewhere = commitRows(snapshot, [{ name: "Designer", version: "x" }]);
  deepStrictEqual(elsewhere.map((row) => row.running), [false, false, false]);
  // Versions are the same with or without their prefix.
  const bare = commitRows(snapshot, [{
    name: "Designer",
    version: PARENT.replace("commit:", ""),
  }]);
  deepStrictEqual(bare.map((row) => row.running), [false, true, false]);
  // Without a runtime read, the host's own runtime stands in and names nobody.
  deepStrictEqual(
    commitRows(snapshot).map((row) => [row.running, row.runningFor]),
    [[false, []], [true, []], [false, []]],
  );
});

Deno.test("a commit is named by the reason of the proposal it became, else by its message", () => {
  const snapshot = history();
  // PARENT is what "p-taken" was accepted as.
  equal(commitTitle(snapshot.history.commits[1], snapshot), "Add the reader");
  equal(
    commitTitle(snapshot.history.commits[0], snapshot),
    "Accept a proposal",
  );
  equal(
    commitTitle({ ...snapshot.history.commits[0], message: "" }, snapshot),
    "Model commit",
  );
});

Deno.test("proposals list those waiting first, then the accepted, then the declined, each newest first", () => {
  const rows = proposalRows(history());
  deepStrictEqual(rows.map((row) => row.id), [
    "p-prepare",
    "p-open",
    "p-taken",
    "p-declined",
  ]);
  deepStrictEqual(rows.map((row) => row.state), [
    "pending",
    "pending",
    "accepted",
    "declined",
  ]);
});

Deno.test("proposal summaries retain actual author, branch and complete reason for the detail", () => {
  const snapshot = history();
  const proposal = snapshot.revisions.proposals.find((entry) =>
    entry.id === "p-open"
  )!;
  proposal.reason = "Add a ranking step\nExplain the ordering and tradeoffs.";
  proposal.branch = "proposal/ranking";
  const row = proposalRows(snapshot, operators).find((entry) =>
    entry.id === proposal.id
  )!;
  equal(row.title, "Add a ranking step");
  equal(row.author, "Designer");
  equal(row.branch, "proposal/ranking");
  const view = revisionView(
    snapshot,
    { kind: "proposal", id: proposal.id },
    proposal,
    operators,
  );
  equal(view.reason, proposal.reason);
  equal(view.branch, "proposal/ranking");
  equal(view.proposalStatus, "proposed");
});

Deno.test("a proposal waits until it is accepted or declined; only a proposed one needs a decision", () => {
  equal(proposalState("preparing"), "pending");
  equal(proposalState("proposed"), "pending");
  equal(proposalState("accepting"), "pending");
  equal(proposalState("accepted"), "accepted");
  equal(proposalState("rejected"), "declined");
  // The count on the Proposals tab is those that need a decision.
  equal(openProposals(history()), 1);
});

Deno.test("an address that names a revision shows it, found or not; otherwise a tab opens on its most useful one", () => {
  const snapshot = history();
  const named = { kind: "commit" as const, id: PARENT };
  equal(shownRevision(snapshot, "commit", named)?.selection.id, PARENT);
  equal(
    (shownRevision(snapshot, "commit", named)?.item as SourceCommit).version,
    PARENT,
  );
  // A revision the loaded history lacks is shown as missing, not swapped for main.
  const missing = shownRevision(snapshot, "commit", {
    kind: "commit",
    id: "commit:gone",
  });
  equal(missing?.selection.id, "commit:gone");
  equal(missing?.item, undefined);
  // No address, or one of the other kind: main's head, the first open proposal.
  equal(shownRevision(snapshot, "commit", undefined)?.selection.id, HEAD);
  equal(
    shownRevision(snapshot, "commit", {
      kind: "proposal",
      id: "p-open",
    })?.selection.id,
    HEAD,
  );
  equal(shownRevision(snapshot, "proposal", named)?.selection.id, "p-open");
  // Nothing waiting: the first proposal; nothing at all: nothing.
  snapshot.revisions.proposals = snapshot.revisions.proposals.filter((entry) =>
    entry.status !== "proposed"
  );
  equal(
    shownRevision(snapshot, "proposal", undefined)?.selection.id,
    "p-prepare",
  );
  snapshot.revisions.proposals = [];
  equal(shownRevision(snapshot, "proposal", undefined), undefined);
});

Deno.test("a commit is shown by the 'commit' address whatever prefix it was written with", () => {
  const snapshot = history();
  const [head] = commitRows(snapshot);
  ok(isShown(head, { kind: "commit", id: HEAD.replace("commit:", "branch:") }));
  ok(!isShown(head, { kind: "proposal", id: HEAD }));
  const [first] = proposalRows(snapshot);
  ok(isShown(first, { kind: "proposal", id: "p-prepare" }));
  ok(!isShown(first, { kind: "commit", id: "p-prepare" }));
});

Deno.test("the detail of a proposal reads against its base; a commit against its parent", () => {
  const snapshot = history();
  const open = snapshot.revisions.proposals.find((entry) =>
    entry.id === "p-open"
  )!;
  const view = revisionView(
    snapshot,
    { kind: "proposal", id: open.id },
    open,
    operators,
  );
  deepStrictEqual(
    [view.base, view.target, view.state, view.decidable, view.author],
    [HEAD, PROPOSED, "pending", true, "Designer"],
  );
  equal(view.commitLabel, "Base commit");
  const [head, , root] = snapshot.history.commits;
  const commit = revisionView(
    snapshot,
    { kind: "commit", id: head.version },
    head,
    operators,
  );
  deepStrictEqual(
    [commit.base, commit.target, commit.state, commit.decidable, commit.author],
    [PARENT, HEAD, "applied", false, "You"],
  );
  // The first commit is read against the empty model.
  equal(
    revisionView(snapshot, { kind: "commit", id: ROOT }, root, operators).base,
    "empty",
  );
});

Deno.test("an accepted proposal says which commit it became; a proposal in the making says why it cannot be decided yet", () => {
  const snapshot = history();
  const find = (id: string) =>
    snapshot.revisions.proposals.find((entry) => entry.id === id)!;
  const taken = revisionView(
    snapshot,
    { kind: "proposal", id: "p-taken" },
    find("p-taken"),
    operators,
  );
  deepStrictEqual([taken.state, taken.decidable, taken.mergedAs], [
    "accepted",
    false,
    PARENT,
  ]);
  const preparing = revisionView(
    snapshot,
    { kind: "proposal", id: "p-prepare" },
    find("p-prepare"),
    operators,
  );
  equal(preparing.target, undefined);
  equal(preparing.notice, "The operator is still preparing this proposal.");
  const declined = revisionView(
    snapshot,
    { kind: "proposal", id: "p-declined" },
    find("p-declined"),
    operators,
  );
  deepStrictEqual([declined.state, declined.notice], [
    "declined",
    "Reason: Too broad",
  ]);
});

Deno.test("a commit is told with the author the host parsed, a proposal with the authorization the host pinned on it", () => {
  const snapshot = history();
  const roster = [{ nativeId: DESIGNER, name: "Designer" }];
  const view = (kind: "commit" | "proposal", id: string) => {
    const item = kind === "commit"
      ? snapshot.history.commits.find((entry) => entry.version === id)!
      : snapshot.revisions.proposals.find((entry) => entry.id === id)!;
    return revisionView(snapshot, { kind, id }, item, roster);
  };
  // The fixture's commits are the host's own control, and Assembly's admission.
  equal(view("commit", PARENT).author, "You");
  equal(view("commit", ROOT).author, "Assembly");
  equal(view("proposal", "p-open").author, "Designer");
  // An operator the roster lacks is not named.
  const stranger = snapshot.revisions.proposals.find((entry) =>
    entry.id === "p-open"
  )!;
  equal(
    revisionView(
      snapshot,
      { kind: "proposal", id: "p-open" },
      {
        ...stranger,
        author: "agent:stranger",
        authorization: operatorAuthorization("stranger"),
      },
      roster,
    ).author,
    undefined,
  );
});

Deno.test("the proposal a commit is the acceptance of is the one the journal names, else the one accepted as that version", () => {
  const snapshot = history();
  const parent = snapshot.history.commits.find((entry) =>
    entry.version === PARENT
  )!;
  equal(proposalOfCommit(parent, snapshot)?.id, "p-taken");
  // Read without the journal's link, the accepted version finds it.
  const { proposalId: _, ...bare } = parent;
  equal(proposalOfCommit(bare, snapshot)?.id, "p-taken");
  // The journal's link wins over the version match.
  equal(
    proposalOfCommit({ ...parent, proposalId: "p-open" }, snapshot)?.id,
    "p-open",
  );
  // A host publication is the acceptance of nothing.
  const head = snapshot.history.commits.find((entry) =>
    entry.version === HEAD
  )!;
  equal(proposalOfCommit(head, snapshot), undefined);
});
