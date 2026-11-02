import type {
  OperatorDeliveryReceipt,
  OperatorExecutionDelivery,
} from "./execution.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";

/** A transport state alone is insufficient: it must still name the exact
 * accepted job, thread and immutable delivery. Missing/uncertain stays closed. */
export function terminalAcceptedTransport(
  accepted: {
    receipt: OperatorDeliveryReceipt;
    delivery: OperatorExecutionDelivery;
  },
  job: {
    id: string;
    state: string;
    data: { threadId: string; delivery: OperatorExecutionDelivery };
  } | null,
): "completed" | "failed" | undefined {
  if (
    !job || accepted.receipt.id !== accepted.delivery.id ||
    job.id !== accepted.receipt.jobId ||
    job.data?.threadId !== accepted.receipt.threadId ||
    canonical(job.data?.delivery) !== canonical(accepted.delivery)
  ) return;
  if (job.state === "completed" && accepted.receipt.status === "completed") {
    return "completed";
  }
  if (job.state === "failed" && accepted.receipt.status === "failed") {
    return "failed";
  }
}
