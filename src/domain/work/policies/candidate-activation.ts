import { ChangePublicationError } from "../../model/publication/change.ts";
import { HostEditError } from "../../model/editing/host-edit.ts";
import type { Candidate } from "../records/candidates.ts";

/** Coded refusals of an admitted activation. Each one is terminal: the same
 * admission can never succeed later, so the candidate must be re-proposed. */
type CandidateActivationRefusalCode =
  | "ADMISSION_MISSING"
  | "TESTS_NOT_PASSED"
  | "ADMISSION_CANDIDATE_MISMATCH"
  | "ADMISSION_CONFIGURATION_CHANGED"
  | "ADMISSION_AUTHORITY_INVALID"
  | "ADMISSION_RECORD_INCOMPLETE"
  | "ADMISSION_EXERCISE_MISMATCH"
  | "ADMITTED_MODEL_CHANGED"
  | "CANDIDATE_CHANGED"
  | "CATALOG_BASE_CHANGED"
  | "CANDIDATE_AMBIGUOUS"
  | "CONTRACT_NOT_UNIQUE"
  | "CONTRACT_NOT_OWNED"
  | "CONTRACT_PATH_UNSUPPORTED"
  | "ACTIVATION_CHANGED_CONTRACT"
  | "ACTIVATION_NOT_VERIFIED"
  | "ACTIVATION_RETRIES_EXHAUSTED"
  | "CASE_ABANDONED";

/** Machine-readable refusal: a stable code, its scalar context and its recovery. */
export class CandidateActivationError extends Error {
  readonly recovery = "refuse" as const;
  constructor(
    readonly code: CandidateActivationRefusalCode,
    readonly context: Readonly<Record<string, string | number | boolean>>,
    message: string,
  ) {
    super(message);
    this.name = "CandidateActivationError";
  }
}

/** Refuse unless `condition` holds; shared by the writer and the runtime. */
export function requireActivation(
  condition: unknown,
  code: CandidateActivationRefusalCode,
  context: CandidateActivationError["context"],
  message: string,
): asserts condition {
  if (!condition) throw new CandidateActivationError(code, context, message);
}

/** An admitted `activating` candidate with its durable intent. It is retried
 * independently of any Case until it is published or settles as failed. */
export function hasActivationIntent(
  candidate: Pick<Candidate, "stage" | "activationModelDigest">,
): boolean {
  return candidate.stage === "activating" &&
    candidate.activationModelDigest !== undefined &&
    candidate.activationModelDigest !== "";
}

/** Publications requested of the model port for one admitted activation, in
 * process or after restarts. Reading a catalog that cannot be read is not one. */
export const MAX_ACTIVATION_ATTEMPTS = 5;

interface ActivationFailure {
  /** Stable machine code, stored on the candidate when the failure is terminal. */
  code: string;
  /** Retryable failures keep the intent; terminal ones read the native catalog. */
  terminal: boolean;
}

/** Classify an error raised after the activation intent was recorded.
 * Only explicitly transient infrastructure failures stay retryable. */
export function activationFailure(error: unknown): ActivationFailure {
  if (error instanceof CandidateActivationError) {
    return { code: error.code, terminal: true };
  }
  if (error instanceof ChangePublicationError) {
    return { code: error.code, terminal: error.code !== "PUBLICATION_FAILED" };
  }
  if (error instanceof HostEditError) {
    return { code: error.code, terminal: error.recovery === "refuse" };
  }
  return { code: "ACTIVATION_INTERRUPTED", terminal: false };
}
