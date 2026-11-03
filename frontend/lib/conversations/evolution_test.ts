import { deepStrictEqual, equal, match } from "node:assert/strict";
import {
  evolutionMessage,
  evolutionRecord,
} from "../../test/support/evolution-fixture.ts";
import { operatorRoster } from "../../test/support/operator-fixture.ts";
import {
  evolutionForMessage,
  evolutionRequests,
  evolutionRequestText,
  evolutionThreadMatches,
  exactEvolutionDiff,
  messageEvolution,
  readEvolutionRecord,
} from "./evolution.ts";
import { parseConversationsSnapshot } from "./state.ts";

Deno.test("evolution receipts decode only structured host observations and exact dossier metadata", () => {
  const record = evolutionRecord();
  equal(readEvolutionRecord(record), record);
  equal(messageEvolution(evolutionMessage(record)), record);
  equal(
    messageEvolution({ ...evolutionMessage(), observation: undefined }),
    undefined,
  );
  for (
    const patch of [
      { status: "other" },
      { revision: -1 },
      { proposalId: "" },
      { candidate: { version: "commit:candidate" } },
      { origin: { operatorId: "native:designer" } },
      {
        origin: {
          operatorId: "native:designer",
          requestId: "case",
          designerScopeId: "scope",
        },
      },
      { targets: [] },
    ]
  ) equal(readEvolutionRecord({ ...record, ...patch }), undefined);
  const roster = operatorRoster();
  roster.evolutions = {
    version: "evolution:1",
    items: [record],
    truncated: false,
  };
  deepStrictEqual(
    parseConversationsSnapshot(roster).evolutions,
    roster.evolutions,
  );
});
Deno.test("historical receipts never follow live lifecycle state and live joins require exact immutable identity", () => {
  const recorded = evolutionRecord(),
    latest = evolutionRecord({ revision: 4, status: "adopted" });
  equal(evolutionForMessage(recorded, [latest], true), recorded);
  equal(evolutionForMessage(recorded, [latest], false), latest);
  for (
    const patch of [{ proposalId: "other" }, { proposalDigest: "other" }, {
      dossierId: "other",
    }, { revision: 0 }]
  ) {
    equal(
      evolutionForMessage(recorded, [{ ...latest, ...patch }], false),
      recorded,
    );
  }
  equal(evolutionForMessage(recorded, [latest, latest], false), recorded);
});
Deno.test("exact evolution comparisons bind both immutable revisions and both source digests", () => {
  const record = evolutionRecord();
  const diff = {
    fromVersion: record.base.version,
    toVersion: record.candidate.version,
    fromSourceDigest: record.base.sourceDigest,
    toSourceDigest: record.candidate.sourceDigest,
    patch: "diff",
    files: [],
    additions: 1,
    deletions: 0,
  };
  equal(exactEvolutionDiff(record, diff), true);
  for (
    const patch of [
      { fromVersion: "commit:other" },
      { toVersion: "commit:other" },
      { fromSourceDigest: "other" },
      { toSourceDigest: "other" },
    ]
  ) equal(exactEvolutionDiff(record, { ...diff, ...patch }), false);
});
Deno.test("evolution requests name exact dossier revisions without granting approval and stay in their originating thread", () => {
  const record = evolutionRecord(),
    conversation = operatorRoster().conversations[0];
  deepStrictEqual(evolutionRequests(record), ["acceptance", "cancellation"]);
  deepStrictEqual(evolutionRequests({ ...record, status: "accepted" }), [
    "activation",
    "cancellation",
  ]);
  deepStrictEqual(evolutionRequests({ ...record, status: "adopted" }), []);
  match(
    evolutionRequestText(record, "activation"),
    /dossier revision 1, proposal proposal:flow/,
  );
  equal(
    evolutionThreadMatches(record, conversation, {
      designerScopeId: "scope:main",
    }),
    true,
  );
  equal(
    evolutionThreadMatches(record, conversation, {
      designerScopeId: "scope:other",
    }),
    false,
  );
  equal(
    evolutionThreadMatches(record, operatorRoster().conversations[1], {
      designerScopeId: "scope:main",
    }),
    false,
  );
});
