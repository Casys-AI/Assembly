import { deepStrictEqual, equal, throws } from "node:assert/strict";
import {
  assertReleasePublication,
  publicationEvent,
  RELEASE_PUBLICATION_HISTORY_LIMIT,
  releasePublicationView,
} from "./release-publication.ts";

const at = "2026-10-31T00:00:00.000Z";
Deno.test("publication records only observed ordered events and strips internal run ownership", () => {
  const accepted = publicationEvent(
    undefined,
    { step: "acceptance", status: "completed" },
    "pending",
    at,
  );
  const started = publicationEvent(
    accepted,
    { step: "recovery", status: "started" },
    "preparing",
    at,
    "run_1",
  );
  const recovered = publicationEvent(
    started,
    { step: "recovery", status: "started" },
    "preparing",
    at,
    "run_2",
  );
  equal(recovered.attempt, 2);
  deepStrictEqual(recovered.events.map((event) => event.sequence), [1, 2, 3]);
  const view = releasePublicationView(recovered);
  equal("runId" in view, false);
  equal(view.outcome, "preparing");
  // Starting recovery never fabricates a failure or completion of lost work.
  equal(view.events.some((event) => event.status === "failed"), false);
});
Deno.test("publication log bounds disclose truncated history while sequence stays ordered", () => {
  let publication = publicationEvent(
    undefined,
    { step: "recovery", status: "started" },
    "preparing",
    at,
    "run_1",
  );
  for (let member = 0; member < RELEASE_PUBLICATION_HISTORY_LIMIT; member++) {
    publication = publicationEvent(
      publication,
      { step: "asset-retention", status: "completed", member },
      "preparing",
      at,
      "run_1",
    );
  }
  equal(publication.events.length, RELEASE_PUBLICATION_HISTORY_LIMIT);
  equal(publication.historyTruncated, true);
  equal(publication.events[0].sequence, 2);
  equal(publication.nextSequence, RELEASE_PUBLICATION_HISTORY_LIMIT + 2);
});
Deno.test("publication rejects unbounded or private diagnostic payloads instead of exposing them", () => {
  const publication = publicationEvent(
    undefined,
    { step: "acceptance", status: "completed" },
    "pending",
    at,
  );
  throws(() =>
    assertReleasePublication({ ...publication, stack: "/private/path" })
  );
  throws(() => assertReleasePublication({ ...publication, runId: 123 }));
  throws(() =>
    assertReleasePublication({
      ...publication,
      events: [{ ...publication.events[0], issue: "/private/path" }],
    })
  );
  throws(() =>
    assertReleasePublication({
      ...publication,
      events: [{ ...publication.events[0], source: "secret" }],
    })
  );
});
