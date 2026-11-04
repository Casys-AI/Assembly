/** The host's sanitized readiness observation for opening a Request. */
export interface RequestOpeningRunnerPort {
  inspectReadiness(): Promise<
    | { status: "ready" }
    | {
      status: "unavailable";
      reason: "unsupported-platform" | "sandbox-launch-failed";
    }
  >;
}
