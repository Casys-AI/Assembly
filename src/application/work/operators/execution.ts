/** Durable delivery of host-authenticated operator contributions. The queue does
 * not grant authority, choose a model or advance an admitted native flow. */
import type {
  NativeExecutionIdentity,
  RuntimeRevisionReference,
} from "../native-execution/contract.ts";

export interface OperatorExecutionCommandOrigin {
  businessRevision: RuntimeRevisionReference;
  effectKey: string;
  inputMessageId: string;
}

export interface OperatorExecutionDelivery {
  /** Exact canonical message, decision or notification receipt identity. */
  id: string;
  identity: NativeExecutionIdentity;
  kind:
    | "contribution"
    | "continuation"
    | "notification"
    | "command"
    | "schedule";
  modelPin: { modelDigest: string; repositoryVersion?: string };
  /** Validated command/provenance DTO, never a provider's executable callback. */
  payload?: Record<string, unknown>;
}

export interface OperatorDeliveryReceipt {
  id: string;
  threadId: string;
  jobId: string;
  status:
    | "queued"
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "uncertain";
}

export interface OperatorExecutionDispatchPort {
  /** The immutable accepted-input receipt and job commit atomically. Workers
   * materialize canonical messages/history idempotently from this receipt's ID.
   * This does not claim an atomic transaction with an in-memory SystemRuntime.
   */
  enqueue(
    delivery: OperatorExecutionDelivery,
  ): Promise<OperatorDeliveryReceipt>;
  inspect(
    identity: NativeExecutionIdentity,
    contributionId: string,
  ): Promise<OperatorDeliveryReceipt | null>;
  /** Actual native-effect lineage only; the business resolver still verifies
   * current source grants, selected command, target and exact decision proof. */
  assertSourceEffect?(origin: OperatorExecutionCommandOrigin): Promise<void>;
  /** Exact accepted DTO lookup for command replay, including closed scopes. */
  inspectAccepted?(
    operatorId: string,
    id: string,
  ): Promise<
    | { receipt: OperatorDeliveryReceipt; delivery: OperatorExecutionDelivery }
    | null
  >;
  /** Read an exact accepted job only when its transport is terminal. Unknown and
   * retrying work never qualify for replacement. */
  inspectTerminalAccepted?(operatorId: string, id: string): Promise<
    {
      receipt: OperatorDeliveryReceipt;
      delivery: OperatorExecutionDelivery;
      terminal: "completed" | "failed";
    } | null
  >;
}

/** A worker invokes the existing application's business entry point. Parked
 * decisions return normally; a later durable correlated receipt enqueues wakeup.
 */
export type OperatorExecutionDeliveryHandler = (
  delivery: OperatorExecutionDelivery,
) => Promise<void>;
