import { deepStrictEqual, equal } from "node:assert/strict";
import { parseModelAuthor } from "../../../../src/domain/model/records/revision.ts";
import {
  authorLabel,
  authorName,
  authorRoster,
  proposalAuthor,
} from "./authors.ts";
import {
  DESIGNER,
  operatorAuthorization,
  proposal,
} from "../../../test/support/revision-fixture.ts";

const roster = [
  { nativeId: "designer", name: "Designer" },
  { nativeId: "reviewer", name: " Reviewer " },
  { nativeId: "blank", name: "  " },
];
/** What the host would send for a commit by `raw`. */
const parsed = (raw: string) => parseModelAuthor(raw);

Deno.test("the person and the host's own control are You", () => {
  equal(authorName(parsed("local-owner"), roster), "You");
  equal(authorName(parsed("local-control"), roster), "You");
});

Deno.test("an operator is named by the roster, never by its identity", () => {
  equal(authorName(parsed("agent:designer"), roster), "Designer");
  // The name is the roster's, trimmed as everywhere else.
  equal(authorName(parsed("agent:reviewer"), roster), "Reviewer");
  // An operator the roster lacks, or names with nothing, cannot be named.
  equal(authorName(parsed("agent:gone"), roster), undefined);
  equal(authorName(parsed("agent:blank"), roster), undefined);
  equal(authorName(parsed("agent:designer"), []), undefined);
});

Deno.test("Assembly is told with what it did", () => {
  equal(authorName(parsed("ase"), roster), "Assembly");
  equal(
    authorName(parsed("ase:provision-instance-id"), roster),
    "Assembly · provision instance id",
  );
  equal(
    authorName(parsed("ase:approved-change:change-7"), roster),
    "Assembly · approved change",
  );
  equal(
    authorName(parsed("ase:record-candidate:builder"), roster),
    "Assembly · record candidate",
  );
  equal(
    authorName(parsed("ase:record-stage-observation:builder"), roster),
    "Assembly · record stage observation",
  );
});

Deno.test("an author the host does not recognise is not named, and its label is what the host gave", () => {
  for (const raw of ["someone-else", "ase:made-up", "agent:", "agent:a b"]) {
    equal(parsed(raw).kind, "unknown", raw);
    equal(authorName(parsed(raw), roster), undefined, raw);
    equal(authorLabel(parsed(raw), roster), raw, raw);
  }
});

Deno.test("an operator nobody names is an operator, never its identity; only what the host did not recognise is shown as it gave it", () => {
  equal(authorLabel(parsed("agent:designer"), roster), "Designer");
  // An identity is a UUID to a person: nothing the roster lacks is spelled out.
  const uuid = "e566091d-9812-5a9a-b20f-00fff0f270df";
  equal(authorLabel(parsed(`agent:${uuid}`), roster), "An operator");
  equal(authorLabel(parsed("agent:blank"), roster), "An operator");
  equal(authorLabel(parsed("agent:designer"), []), "An operator");
  equal(authorLabel(parsed("local-owner"), roster), "You");
  equal(
    authorLabel(parsed("ase:approved-change:c1"), roster),
    "Assembly · approved change",
  );
});

Deno.test("a proposal is told by the authorization the host pinned on it, not by reading its raw author again", () => {
  // The person: the authorization says so.
  deepStrictEqual(
    proposalAuthor({
      author: "local-owner",
      authorization: { kind: "local-owner" },
    }),
    { kind: "owner", ref: "local-owner" },
  );
  // An operator: the one the authorization was pinned for, as To decide names it.
  deepStrictEqual(
    proposalAuthor(proposal("p", "proposed", "r", "2026-10-24T10:00:00Z")),
    { kind: "agent", ref: DESIGNER },
  );
  // And it is named by the roster, like the operator behind a commit.
  equal(
    authorName(
      proposalAuthor(proposal("p", "proposed", "r", "2026-10-24T10:00:00Z")),
      roster,
    ),
    "Designer",
  );
});

Deno.test("a proposal without that proof is an author the page does not recognise, and keeps what the host gave", () => {
  const raw = (author: string, authorization?: never) => ({
    author,
    authorization,
  });
  // Nothing pinned: a string that looks like an operator proves nothing.
  deepStrictEqual(proposalAuthor(raw("agent:designer")), {
    kind: "unknown",
    ref: "agent:designer",
  });
  deepStrictEqual(proposalAuthor(raw("local-owner")), {
    kind: "unknown",
    ref: "local-owner",
  });
  // The authorization names another operator than the author string.
  deepStrictEqual(
    proposalAuthor({
      author: "agent:designer",
      authorization: operatorAuthorization("reviewer"),
    }),
    { kind: "unknown", ref: "agent:designer" },
  );
  equal(
    authorLabel(proposalAuthor(raw("somebody-else")), roster),
    "somebody-else",
  );
});

Deno.test("the roster that names authors holds the runtime operators first, then the rest of the system, once each", () => {
  const owning = [{ nativeId: "designer", name: "Designer" }];
  const everyone = [
    { nativeId: "reviewer", name: "Reviewer" },
    { nativeId: "designer", name: "Designer (peer)" },
  ];
  deepStrictEqual(authorRoster(owning, everyone), [
    { nativeId: "designer", name: "Designer" },
    { nativeId: "reviewer", name: "Reviewer" },
  ]);
  deepStrictEqual(authorRoster(owning), owning);
  deepStrictEqual(authorRoster([], []), []);
  // So a reviewer that owns no runtime is named in a byline.
  equal(
    authorLabel(parsed("agent:reviewer"), authorRoster(owning, everyone)),
    "Reviewer",
  );
});
