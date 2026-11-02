import { matchesExactRevision } from "../../../domain/shared-kernel/revision-id.ts";
import type { ModelFirstParentInterval } from "../../../domain/model/records/revision.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { normalizeNetworkHost } from "../../../domain/governance/policies/network-policy.ts";
import {
  DEFAULT_NETWORK_IMPACT_LIMITS,
  HARD_NETWORK_IMPACT_LIMITS,
  NETWORK_IMPACT_RULE_VERSION,
  type NetworkImpactEvidence,
  type NetworkImpactEvidenceMatch,
  type NetworkImpactEvidenceRead,
  type NetworkImpactFrame,
  type NetworkImpactIssue,
  type NetworkImpactLimits,
  type NetworkImpactPath,
  type NetworkImpactReport,
  type NetworkImpactRequest,
  type NetworkImpactTransition,
} from "../../../domain/model/consultation/network-impact.ts";
import type { NetworkImpactEvidenceReader } from "./ports/out/network-impact-evidence-reader.port.ts";
import type { NetworkImpactLineageReader } from "./ports/out/network-impact-lineage-reader.port.ts";
import type { NetworkImpactModelReader } from "./ports/out/network-impact-model-reader.port.ts";

const channels = ["web", "skill-install"] as const;

/** Strict request identity: do not silently turn a URL, alias or wildcard into H. */
export function validateNetworkImpactRequest(
  input: NetworkImpactRequest,
): NetworkImpactLimits {
  if (!input || typeof input !== "object") {
    throw new Error("Network impact request is required");
  }
  if (
    typeof input.operatorId !== "string" || !input.operatorId.trim() ||
    input.operatorId.length > 1024 ||
    Array.from(input.operatorId).some((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  ) throw new Error("Expected an exact native operator identity");
  if (normalizeNetworkHost(input.host) !== input.host) {
    throw new Error(
      "Expected an exact lowercase host without URL, port or wildcard",
    );
  }
  for (const version of [input.fromVersion, input.toVersion]) {
    if (typeof version !== "string" || !matchesExactRevision(version)) {
      throw new Error(
        "Expected immutable model versions commit:<40 lowercase hex digits>",
      );
    }
  }
  const limits = { ...DEFAULT_NETWORK_IMPACT_LIMITS };
  if (input.limits !== undefined) {
    if (
      !input.limits || typeof input.limits !== "object" ||
      Array.isArray(input.limits)
    ) {
      throw new Error("Invalid network impact limits");
    }
    for (const [key, value] of Object.entries(input.limits)) {
      if (
        !Object.hasOwn(limits, key) || !Number.isSafeInteger(value) ||
        typeof value !== "number" || value < 1 ||
        value > HARD_NETWORK_IMPACT_LIMITS[key as keyof NetworkImpactLimits]
      ) throw new Error(`Invalid network impact limit: ${key}`);
      limits[key as keyof NetworkImpactLimits] = value;
    }
  }
  return limits;
}

function known(frame: NetworkImpactFrame): boolean {
  return frame.state === "known" && !frame.issues.length &&
    channels.every((channel) =>
      frame.paths.filter((path) => path.channel === channel).length === 1
    );
}

function route(
  frame: NetworkImpactFrame,
  channel: NetworkImpactPath["channel"],
): NetworkImpactPath | undefined {
  const paths = frame.paths.filter((path) => path.channel === channel);
  return paths.length === 1 ? paths[0] : undefined;
}

/** Locations and display names describe provenance, not a change in authority. */
function routeSignature(path: NetworkImpactPath): string {
  const identities = (values: NetworkImpactPath["witnesses"]) =>
    values.map(({ role, elementId, metaclass }) => ({
      role,
      elementId,
      metaclass,
    })).map(canonical).sort();
  return canonical({
    id: path.id,
    channel: path.channel,
    state: path.state,
    hostPermission: path.hostPermission,
    consumer: path.consumer,
    witnesses: identities(path.witnesses),
    guards: path.guards.map(({ code, state, explanation, witnesses }) => ({
      code,
      state,
      explanation,
      witnesses: identities(witnesses),
    })).map(canonical).sort(),
  });
}

export function compareNetworkImpactFrames(
  before: NetworkImpactFrame,
  after: NetworkImpactFrame,
): NetworkImpactTransition {
  const changes = channels.map((channel) => {
    const left = route(before, channel);
    const right = route(after, channel);
    const kind = !known(before) || !known(after) || !left || !right ||
        left.hostPermission === "unknown" || right.hostPermission === "unknown"
      ? "indeterminate"
      : left.hostPermission === "allowed" && right.hostPermission === "denied"
      ? "permission-revoked"
      : left.hostPermission === "denied" && right.hostPermission === "allowed"
      ? "permission-granted"
      : routeSignature(left) === routeSignature(right)
      ? "unchanged"
      : "route-changed";
    return { channel, kind, before: left, after: right } as const;
  });
  const paths = channels.map((channel) => route(after, channel));
  return {
    fromVersion: before.version,
    toVersion: after.version,
    changes,
    directAccessAfter: !known(after)
      ? "unknown"
      : paths.some((path) =>
          path?.state === "conditional" && path.hostPermission === "allowed"
        )
      ? "possible"
      : paths.every((path) => path?.state === "blocked")
      ? "blocked"
      : "unknown",
    issues: changes.some((change) => change.kind === "indeterminate")
      ? [{
        code: "TRANSITION_INDETERMINATE",
        message:
          "One or more direct routes could not be established for both revisions.",
      }]
      : [],
  };
}

/** A contract match is not a substitute for a recorded version or actor. */
export function matchNetworkImpactEvidence(
  evidence: NetworkImpactEvidence,
  frames: readonly NetworkImpactFrame[],
  operatorId: string,
  host: string,
): NetworkImpactEvidenceMatch {
  const result: NetworkImpactEvidenceMatch = {
    ...evidence,
    issues: [...evidence.issues],
    match: "unresolved",
    relatedVersions: [],
    policyAtRecordedVersion: "unknown",
  };
  const add = (code: string, message: string) =>
    result.issues.push({ code, message, recordId: evidence.id });
  if (evidence.operatorId !== operatorId) {
    add(
      "EVIDENCE_OPERATOR_UNRESOLVED",
      "The exact network authority holder is not established for this observation.",
    );
    return result;
  }
  const candidates = frames.filter((frame) =>
    known(frame) && frame.operatorId === operatorId &&
    !!evidence.contractDigest &&
    frame.contractDigest === evidence.contractDigest
  );
  if (evidence.modelVersion) {
    const exact = candidates.find((frame) =>
      frame.version === evidence.modelVersion
    );
    if (!exact) {
      add(
        "EVIDENCE_VERSION_UNRESOLVED",
        "The recorded version and contract do not resolve together within the calculated interval.",
      );
      return result;
    }
    result.match = "exact-version";
    result.relatedVersions = [exact.version];
    if (
      evidence.host === host &&
      (evidence.kind === "network-refused" ||
        evidence.kind === "page-received" ||
        evidence.kind === "attempt-unconfirmed" ||
        evidence.kind === "skill-downloaded")
    ) {
      result.policyAtRecordedVersion = route(
        exact,
        evidence.source === "skill-operation" ? "skill-install" : "web",
      )?.hostPermission ?? "unknown";
    }
  } else if (candidates.length) {
    result.match = "contract-only";
    result.relatedVersions = candidates.map((frame) => frame.version);
    add(
      "EVIDENCE_VERSION_NOT_RECORDED",
      "The contract is identified, but no version is inferred from the current snapshot or identical contracts.",
    );
  } else {
    add(
      "EVIDENCE_CONTRACT_UNRESOLVED",
      "The recorded contract is not resolved within the calculated interval.",
    );
  }
  return result;
}

export class NetworkImpactService {
  constructor(
    private readonly ports: {
      lineage: NetworkImpactLineageReader;
      models: NetworkImpactModelReader;
      evidence?: NetworkImpactEvidenceReader;
    },
  ) {}

  async analyze(
    input: NetworkImpactRequest,
    signal?: AbortSignal,
  ): Promise<NetworkImpactReport> {
    const limits = validateNetworkImpactRequest(input);
    // Detach caller-owned values before the first await.
    const request = {
      operatorId: input.operatorId,
      host: input.host,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
    };
    const issues: NetworkImpactIssue[] = [];
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, limits.timeoutMs);
    const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
      controller.signal.throwIfAborted();
      let onAbort: () => void = () => {};
      try {
        return await Promise.race([
          work(),
          new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(new Error("Analysis interrupted"));
            controller.signal.addEventListener("abort", onAbort, {
              once: true,
            });
            if (controller.signal.aborted) onAbort();
          }),
        ]);
      } finally {
        controller.signal.removeEventListener("abort", onAbort);
      }
    };
    let lineage: ModelFirstParentInterval = {
      fromVersion: request.fromVersion,
      toVersion: request.toVersion,
      versions: [],
      complete: false,
    };
    const frames: NetworkImpactFrame[] = [];
    let evidenceRead: NetworkImpactEvidenceRead = {
      evidence: [],
      complete: false,
      snapshotsRead: 0,
      recordsRead: 0,
      bytesRead: 0,
      issues: [{
        code: "EVIDENCE_NOT_CONFIGURED",
        message:
          "No observation source was provided; absence of observations is unknown.",
      }],
    };
    try {
      try {
        lineage = await bounded(() =>
          this.ports.lineage.readFirstParentInterval(
            request.fromVersion,
            request.toVersion,
            limits.maxVersions,
            controller.signal,
          )
        );
      } catch {
        issues.push({
          code: "LINEAGE_UNAVAILABLE",
          message: "The immutable first-parent interval could not be read.",
        });
      }
      if (!lineage.complete) {
        issues.push({
          code: "LINEAGE_INCOMPLETE",
          message: `First-parent coverage is incomplete${
            lineage.reason ? `: ${lineage.reason}` : ""
          }.`,
        });
      }
      if (lineage.versions.some((entry) => entry.parents.length > 1)) {
        issues.push({
          code: "SIDE_BRANCHES_NOT_TRAVERSED",
          message:
            "Merge parents are reported as provenance; only first-parent transitions are calculated.",
        });
      }
      for (const { version } of lineage.versions) {
        let frame: NetworkImpactFrame;
        try {
          frame = await bounded(() =>
            this.ports.models.read(
              version,
              request.operatorId,
              request.host,
              controller.signal,
            )
          );
          if (
            frame.version !== version ||
            (frame.operatorId !== undefined &&
              frame.operatorId !== request.operatorId)
          ) throw new Error("Mismatched model identity");
        } catch {
          frame = {
            version,
            state: "unknown",
            paths: [],
            indirectAccess: "not-covered",
            issues: [{
              code: "MODEL_READ_UNAVAILABLE",
              message:
                "The requested revision could not establish model facts.",
              version,
            }],
          };
        }
        frames.push(frame);
      }
      if (this.ports.evidence) {
        try {
          evidenceRead = await bounded(() =>
            this.ports.evidence!.read({
              operatorId: request.operatorId,
              host: request.host,
              limits,
              signal: controller.signal,
            })
          );
        } catch {
          evidenceRead.issues = [{
            code: "EVIDENCE_UNAVAILABLE",
            message:
              "Observation reads did not complete; no absence is inferred.",
          }];
        }
      }
      if (controller.signal.aborted) {
        issues.push({
          code: signal?.aborted && signal.reason?.name !== "TimeoutError"
            ? "ANALYSIS_ABORTED"
            : "ANALYSIS_TIMEOUT",
          message:
            "The analysis was interrupted; all uncalculated facts remain unknown.",
        });
      }
      const transitions = frames.slice(1).map((frame, index) =>
        compareNetworkImpactFrames(frames[index], frame)
      );
      const { evidence, ...readMetadata } = evidenceRead;
      const modelReadComplete = frames.length > 0 && frames.every(known);
      return {
        ruleVersion: NETWORK_IMPACT_RULE_VERSION,
        request,
        limits,
        lineage,
        frames,
        transitions,
        evidence: evidence.map((entry) =>
          matchNetworkImpactEvidence(
            entry,
            frames,
            request.operatorId,
            request.host,
          )
        ),
        evidenceRead: readMetadata,
        coverage: {
          calculationComplete: lineage.complete && modelReadComplete &&
            !controller.signal.aborted,
          versionsComplete: lineage.complete,
          modelReadComplete,
          recordsReadComplete: evidenceRead.complete,
          networkObservationComplete: false,
          indirectAccess: "not-covered",
        },
        issues,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}
