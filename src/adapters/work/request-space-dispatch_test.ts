import assert from "node:assert/strict";
import { createRequestSpaceDispatcher } from "./request-space-dispatch.ts";
import type { OperatorExecutionDelivery } from "../../application/work/operators/execution.ts";
import { RequestSpaceError } from "../../domain/work/request-spaces.ts";
import { requestSpaceScope as host } from "../../../test/support/request-space-fixture.ts";

const delivery = {
  identity: { operatorId: "operator" },
} as OperatorExecutionDelivery;

Deno.test("Request composition routes Main and Case by resolved host scope without Case fallback", async () => {
  const seen: string[] = [];
  let caseFailure: Error | undefined = undefined;
  const dispatch = createRequestSpaceDispatcher(host, {
    processAcceptedContribution(found, resolved) {
      assert.equal(found, delivery);
      assert.equal(resolved.caseId, "case");
      seen.push("case");
      if (caseFailure) return Promise.reject(caseFailure);
      return Promise.resolve();
    },
  });
  const main = () => {
    seen.push("main");
    return Promise.resolve();
  };
  await dispatch(delivery, { ...host, executionSpaceId: "main" }, main);
  await dispatch(delivery, {
    ...host,
    executionSpaceId: "space",
    caseId: "case",
  }, main);
  assert.deepEqual(seen, ["main", "case"]);
  for (
    const scope of [
      undefined,
      { ...host, systemId: "foreign", executionSpaceId: "main" },
      {
        ...host,
        projectId: "foreign",
        executionSpaceId: "space",
        caseId: "case",
      },
      { ...host, executionSpaceId: "space" },
      { ...host, executionSpaceId: "main", caseId: "case" },
    ]
  ) {
    await assert.rejects(dispatch(delivery, scope, main), RequestSpaceError);
  }
  const technical = new Error("Request routing unavailable");
  caseFailure = technical;
  await assert.rejects(
    dispatch(
      delivery,
      { ...host, executionSpaceId: "space", caseId: "case" },
      main,
    ),
    (error) => error === technical,
  );
  assert.deepEqual(seen, ["main", "case", "case"]);
});
