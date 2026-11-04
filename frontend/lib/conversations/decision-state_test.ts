import { deepStrictEqual, equal } from "node:assert/strict";
import { creation, grant } from "../../test/support/operator-fixture.ts";
import {
  applicationUnfinished,
  applyingSteps,
  decisionLabel,
  decisionState,
} from "./decision-state.ts";

const published = "commit:" + "f".repeat(40);
const team = {
  kind: "request-team-member" as const,
  instruction: "Review the hooks",
  provision: {
    budget: { maxAgentDecisions: 3, maxToolProposals: 1, maxFlowSteps: 20 },
    networkHosts: [],
    mayPropose: [],
    mayInvokeActiveCatalog: false,
  },
};
const phase = (...args: Parameters<typeof decisionState>) =>
  decisionLabel[decisionState(...args).phase];

Deno.test("a decision reads as To decide, Applying, Applied or Declined, whatever the host recorded", () => {
  equal(phase(grant()), "To decide");
  equal(phase(grant({ status: "refused" })), "Declined");
  equal(phase(grant({ status: "superseded" })), "Superseded");
  // Main: published is in service; approved sources not yet published apply.
  equal(
    phase(grant({ status: "approved", publishedCommit: published })),
    "Applied",
  );
  deepStrictEqual(decisionState(grant({ status: "approved" })), {
    phase: "applying",
    reached: 1,
    blocked: false,
    unfinished: false,
    inconsistent: false,
    checking: false,
  });
  // Nothing to publish: applied at once, except a new team member.
  equal(
    phase({ ...grant({ status: "approved" }), diff: undefined }),
    "Applied",
  );
  equal(
    phase({
      ...creation({ status: "approved", operator: team }),
      diff: undefined,
    }),
    "Applying",
  );
});

Deno.test("a Request's application record moves Applying step by step to Applied", () => {
  const approved = grant({ status: "approved", publishedCommit: published });
  const at = (status: Parameters<typeof decisionState>[1]) => {
    const { phase, reached, blocked } = decisionState(approved, status);
    return [phase, reached, blocked];
  };
  deepStrictEqual(at("decision-recorded"), ["applying", 1, false]);
  deepStrictEqual(at("publication-pending"), ["applying", 1, false]);
  deepStrictEqual(at("published-awaiting-adoption"), ["applying", 2, false]);
  deepStrictEqual(at("blocked"), ["applying", 2, true]);
  deepStrictEqual(at("adopted"), ["applied", 3, false]);
  // Until it is read, nothing past the decision is claimed: it is checking.
  deepStrictEqual(at("unread"), ["applying", 0, false]);
  equal(decisionState(approved, "unread").checking, true);
  equal(decisionState(approved).checking, false);
  equal(
    applyingSteps(decisionState(approved, "blocked")),
    "Decided ✓ · Saved ✓ · In service · blocked",
  );
  equal(
    applyingSteps(decisionState(grant({ status: "approved" }), "unread")),
    "Decided · Saved · In service",
  );
});

Deno.test("only a status with a step left is unfinished; a terminal one never asks for a retry", () => {
  const refused = grant({ status: "refused" });
  equal(
    decisionState(refused, "refused-awaiting-continuation").unfinished,
    true,
  );
  equal(decisionState(refused, "refused").unfinished, false);
  const approved = grant({ status: "approved" });
  equal(decisionState(approved, "blocked").unfinished, true);
  equal(decisionState(approved, "adopted").unfinished, false);
  equal(applicationUnfinished("published-awaiting-adoption"), true);
  equal(applicationUnfinished("adopted"), false);
  equal(applicationUnfinished("refused"), false);
});

Deno.test("a record that contradicts the verdict is set aside and flagged", () => {
  const approved = decisionState(grant({ status: "approved" }), "refused");
  deepStrictEqual(
    [approved.phase, approved.inconsistent, approved.unfinished],
    ["applying", true, false],
  );
  const refused = decisionState(grant({ status: "refused" }), "adopted");
  deepStrictEqual([refused.phase, refused.inconsistent], ["declined", true]);
});
