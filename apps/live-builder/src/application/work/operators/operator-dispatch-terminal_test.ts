import { equal } from "node:assert/strict";
import type {
  OperatorDeliveryReceipt,
  OperatorExecutionDelivery,
} from "./execution.ts";
import { terminalAcceptedTransport } from "./operator-dispatch-terminal.ts";

Deno.test("terminal replacement evidence binds immutable job, thread and delivery and closes uncertain states", () => {
  const delivery: OperatorExecutionDelivery = {
    id: "accepted",
    kind: "command",
    modelPin: { modelDigest: "model" },
    identity: {
      operatorId: "operator",
      invocationKey: "local:request",
      purpose: "conversation",
      subjectId: "accepted",
      scope: { kind: "request", scopeId: "request", rootRequestId: "request" },
    },
    payload: { command: "exact" },
  };
  const receipt: OperatorDeliveryReceipt = {
    id: "accepted",
    threadId: "thread",
    jobId: "job",
    status: "failed",
  };
  const accepted = { delivery, receipt };
  const data = {
    delivery,
    threadId: "thread",
  };
  const job = { id: "job", state: "failed", data };
  equal(terminalAcceptedTransport(accepted, job), "failed");
  for (const state of ["created", "retry", "active", "cancelled"]) {
    equal(terminalAcceptedTransport(accepted, { ...job, state }), undefined);
  }
  equal(
    terminalAcceptedTransport({
      ...accepted,
      receipt: { ...receipt, status: "uncertain" },
    }, job),
    undefined,
  );
  equal(
    terminalAcceptedTransport(accepted, { ...job, id: "foreign" }),
    undefined,
  );
  equal(
    terminalAcceptedTransport({
      ...accepted,
      receipt: { ...receipt, id: "foreign" },
    }, job),
    undefined,
  );
  equal(
    terminalAcceptedTransport(accepted, {
      ...job,
      data: { ...data, threadId: "foreign" },
    }),
    undefined,
  );
  equal(
    terminalAcceptedTransport(accepted, {
      ...job,
      data: {
        ...data,
        delivery: { ...delivery, payload: { command: "changed" } },
      },
    }),
    undefined,
  );
  equal(terminalAcceptedTransport(accepted, null), undefined);
  equal(
    terminalAcceptedTransport({
      ...accepted,
      receipt: { ...receipt, status: "completed" },
    }, { ...job, state: "completed" }),
    "completed",
  );
});
