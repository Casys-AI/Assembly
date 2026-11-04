import { equal } from "node:assert/strict";
import type { OpeningRecord } from "../../../domain/work/request-spaces/opening.ts";
import {
  requestOpeningBase,
  requestSpaceScope,
} from "../../../../test/support/request-space-fixture.ts";
import { openingView } from "./opening-view.ts";

Deno.test("opening view excludes the private request input and command digest", async () => {
  const base = await requestOpeningBase();
  const view = openingView(
    {
      id: "open",
      caseId: "case",
      caseNumber: 1,
      executionSpaceId: "space",
      branchId: "branch",
      initialContributionId: "input",
      scope: requestSpaceScope,
      ownerId: "owner",
      command: {
        openingKey: "key",
        text: "Private request input",
        source: { kind: "current-main" },
      },
      commandDigest: "digest",
      base,
      baseDigest: "base",
      phase: "allocated",
      admissionId: null,
      revision: 0,
      issues: [],
      createdAt: "now",
    } satisfies OpeningRecord,
  );
  equal(JSON.stringify(view).includes("Private request input"), false);
  equal("commandDigest" in view, false);
});
