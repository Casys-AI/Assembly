import { canonicalDigest } from "../../../domain/primitives/execution-digest.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type {
  NetworkImpactEvidence,
  NetworkImpactEvidenceRead,
  NetworkImpactLimits,
} from "../../../domain/model/consultation/network-impact.ts";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue
    : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    Array.from(value).every((character) =>
      character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
    ? value
    : undefined;

function hostname(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
        (!url.port || url.port === "443")
      ? url.hostname
      : undefined;
  } catch {
    return undefined;
  }
}

function exactHost(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 253) return undefined;
  const parsed = hostname(`https://${value}/`);
  return parsed === value ? parsed : undefined;
}

function reference(raw: ObjectValue): Partial<NetworkImpactEvidence> {
  const version = object(raw.execution);
  return {
    modelVersion: string(version.repositoryVersion),
    contractDigest: string(version.digest),
    runtimeDigest: string(object(version.runtime).digest),
    actionId: string(version.actionId),
    edgeId: string(version.edgeId),
  };
}

/** Shared metadata-only extraction and deduplication for closed-file and live
 * owner-handle readers. Payloads and their text never appear in the result. */
export function createNetworkImpactEvidenceAccumulator(input: {
  operatorId: string;
  host: string;
  limits: NetworkImpactLimits;
  signal?: AbortSignal;
}, onInterrupt?: () => void) {
  const result: NetworkImpactEvidenceRead = {
    evidence: [],
    complete: true,
    snapshotsRead: 0,
    recordsRead: 0,
    bytesRead: 0,
    issues: [],
    sources: [],
  };
  let activeSourceId: string | undefined;
  const issue = (
    code: string,
    message: string,
    incomplete = true,
    recordId?: string,
    sourceId = activeSourceId,
  ) => {
    if (
      !result.issues.some((entry) =>
        entry.code === code && entry.sourceId === sourceId &&
        entry.recordId === recordId
      )
    ) {
      result.issues.push({ code, message, sourceId, recordId });
    }
    if (incomplete) {
      result.complete = false;
      for (const source of result.sources ?? []) {
        if (source.id === sourceId) source.complete = false;
      }
    }
  };
  issue(
    "HTTP_HOPS_NOT_RECORDED",
    "Les journaux ne décrivent pas tous les sauts HTTP.",
    false,
  );
  issue(
    "HTTP_START_ORDER_UNKNOWN",
    "L’instant réel de départ HTTP n’est pas journalisé.",
    false,
  );
  issue(
    "UNPERSISTED_FAILURES_UNKNOWN",
    "Les échecs avant persistance peuvent être absents.",
    false,
  );
  issue(
    "ABSENCE_IS_NOT_NO_ACCESS",
    "Une absence de preuve ne démontre pas une absence d’accès.",
    false,
  );
  if (!exactHost(input.host) || !string(input.operatorId)) {
    issue("INVALID_EVIDENCE_SCOPE", "Le périmètre de lecture est invalide.");
    return { valid: false as const, result, issue };
  }
  const limits = input.limits;
  if (
    Object.values(limits).some((value) =>
      !Number.isSafeInteger(value) || value < 1
    )
  ) {
    issue("INVALID_EVIDENCE_LIMITS", "Les bornes de lecture sont invalides.");
    return { valid: false as const, result, issue };
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  const interrupt = () => onInterrupt?.();
  controller.signal.addEventListener("abort", interrupt);
  const seen = new Map<string, string>();
  const origins = new Map<string, Set<string>>();
  const conflicting = new Set<string>();
  const contractOwners = new Map<string, Set<string>>();
  const checkpoint = (): boolean => {
    if (controller.signal.aborted) {
      issue(
        input.signal?.aborted ? "EVIDENCE_ABORTED" : "EVIDENCE_TIMEOUT",
        "La lecture des preuves a été interrompue.",
      );
      return false;
    }
    return true;
  };
  const record = async (key: string, value: unknown): Promise<boolean> => {
    if (!checkpoint()) return false;
    if (result.recordsRead >= limits.maxRecords) {
      issue(
        "EVIDENCE_RECORD_LIMIT",
        "La borne globale de journaux a été atteinte.",
      );
      return false;
    }
    result.recordsRead++;
    const sources = origins.get(key) ?? new Set<string>();
    if (activeSourceId) sources.add(activeSourceId);
    origins.set(key, sources);
    const digest = await canonicalDigest(value);
    const previous = seen.get(key);
    if (previous !== undefined) {
      if (previous !== digest) {
        conflicting.add(key);
        issue(
          "EVIDENCE_RECORD_DIVERGED",
          "Un identifiant de journal contient des représentations divergentes.",
          true,
          key,
        );
      }
      return false;
    }
    seen.set(key, digest);
    return true;
  };
  const invalidRecord = (code: string, message: string): boolean => {
    if (!checkpoint()) return false;
    if (result.recordsRead >= limits.maxRecords) {
      issue(
        "EVIDENCE_RECORD_LIMIT",
        "La borne globale de journaux a été atteinte.",
      );
      return false;
    }
    result.recordsRead++;
    issue(code, message);
    return true;
  };
  const append = (evidence: NetworkImpactEvidence) => {
    evidence.sourceIds = activeSourceId ? [activeSourceId] : [];
    for (const entry of evidence.issues) entry.sourceId ??= activeSourceId;
    if (!evidence.modelVersion) {
      evidence.issues.push({
        code: "EVIDENCE_VERSION_UNKNOWN",
        message: "La version de cette observation n’est pas établie.",
        sourceId: activeSourceId,
      });
      issue(
        "EVIDENCE_VERSION_UNKNOWN",
        "Certaines observations n’identifient pas leur version source.",
      );
    }
    if (!evidence.operatorId) {
      evidence.issues.push({
        code: "EVIDENCE_ACTOR_UNKNOWN",
        message: "L’opérateur de cette observation n’est pas établi.",
        sourceId: activeSourceId,
      });
    }
    if (evidence.operatorId && evidence.operatorId !== input.operatorId) {
      return;
    }
    result.evidence.push(evidence);
  };

  const state = async (snapshot: ObjectValue, revision: number) => {
    const systemId = string(snapshot.id);
    if (
      !systemId || !Array.isArray(snapshot.messages) ||
      !Array.isArray(snapshot.events)
    ) {
      issue(
        "EVIDENCE_STATE_INVALID",
        "Un snapshot ne possède pas un journal identifiable.",
      );
      return;
    }
    const executionModel = object(snapshot.executionModel);
    const version = object(executionModel.version);
    const builderId = string(object(executionModel.identity).builderId);
    if (
      string(version.digest) && string(version.repositoryVersion) && builderId
    ) {
      const contractKey = canonical([
        version.digest,
        version.repositoryVersion,
      ]);
      const owners = contractOwners.get(contractKey) ?? new Set<string>();
      owners.add(builderId);
      contractOwners.set(contractKey, owners);
    }
    for (const source of ["message", "event"] as const) {
      const entries = list(
        source === "message" ? snapshot.messages : snapshot.events,
      );
      for (const entry of entries) {
        if (!checkpoint()) return;
        if (result.recordsRead >= limits.maxRecords) {
          issue(
            "EVIDENCE_RECORD_LIMIT",
            "La borne globale de journaux a été atteinte.",
          );
          return;
        }
        const raw = object(entry);
        const id = string(raw.id);
        if (!id) {
          if (
            !invalidRecord(
              "EVIDENCE_RECORD_INVALID",
              "Un journal ne possède pas d’identifiant exploitable.",
            )
          ) return;
          continue;
        }
        const key = canonical([systemId, source, id]);
        if (!await record(key, entry)) continue;
        const observation = object(raw.observation);
        const value = object(observation.value);
        let kind: NetworkImpactEvidence["kind"] | undefined;
        let host: string | undefined;
        const observationIssues: NetworkImpactEvidence["issues"] = [];
        if (observation.kind === "tool-failure") {
          const missing = object(value.missingPermission);
          const denied = exactHost(missing.host);
          const requested = hostname(value.url);
          const refusal = missing.kind === "network-host" && !!denied &&
            (value.code === "NETWORK_SCOPE_DENIED" ||
              value.code === "REPEATED_FAILURE") &&
            !(Array.isArray(value.allowedHosts) &&
              value.allowedHosts.includes(denied));
          host = denied === input.host ? denied : requested;
          if (host !== input.host) continue;
          kind = refusal && denied === input.host
            ? "network-refused"
            : requested === input.host
            ? "attempt-unconfirmed"
            : "context-only";
          if (
            !refusal &&
            (Object.keys(missing).length > 0 ||
              value.code === "NETWORK_SCOPE_DENIED")
          ) {
            observationIssues.push({
              code: "NETWORK_REFUSAL_INVALID",
              message:
                "Les métadonnées ne prouvent pas un refus réseau cohérent.",
            });
            issue(
              "NETWORK_REFUSAL_INVALID",
              "Les métadonnées ne prouvent pas un refus réseau cohérent.",
              true,
              key,
            );
          }
        } else if (observation.kind === "tool-result") {
          host = hostname(value.url);
          if (host !== input.host) continue;
          const pageResult = typeof value.url === "string" &&
            typeof value.title === "string" && typeof value.text === "string";
          kind = pageResult ? "page-received" : "context-only";
          if (!pageResult) {
            observationIssues.push({
              code: "PAGE_RESULT_INVALID",
              message:
                "L’observation ne possède pas la forme d’un résultat de page.",
            });
            issue(
              "PAGE_RESULT_INVALID",
              "L’observation ne possède pas la forme d’un résultat de page.",
              true,
              key,
            );
          }
        } else if (
          source === "event" &&
          (raw.kind === "tool-called" || raw.kind === "flow-action" ||
            raw.kind === "flow-edge")
        ) {
          kind = "context-only";
        } else continue;
        const refs = reference(raw);
        const caseId = string(raw.caseId);
        append({
          id: key,
          source,
          kind,
          ...refs,
          at: string(raw.at),
          systemId,
          snapshotRevision: revision,
          caseId,
          toolId: string(value.toolId) ?? string(raw.candidateId),
          host,
          code: string(value.code) ??
            (source === "event" ? string(raw.kind) : undefined),
          startOrder: "unknown",
          issues: observationIssues,
          ...(Array.isArray(value.allowedHosts)
            ? {
              allowedHosts: value.allowedHosts.map(exactHost).filter((
                host,
              ): host is string => !!host),
            }
            : {}),
        });
        if (kind === "context-only") {
          issue(
            "CONTEXT_IS_NOT_NETWORK_USE",
            "Les actions et appels déclarés ne prouvent pas un accès réseau.",
            false,
          );
        }
      }
    }
  };

  const skills = async (catalog: ObjectValue) => {
    const owner = string(catalog.ownerId);
    if (
      owner !== input.operatorId || !Array.isArray(catalog.operations) ||
      !Array.isArray(catalog.skills) ||
      catalog.revision !== catalog.operations.length
    ) {
      issue(
        "EVIDENCE_SKILLS_INVALID",
        "Un catalogue ne correspond pas au propriétaire demandé.",
      );
      return;
    }
    const first = new Set<string>();
    for (const [index, entry] of catalog.operations.entries()) {
      if (!checkpoint()) return;
      if (result.recordsRead >= limits.maxRecords) {
        issue(
          "EVIDENCE_RECORD_LIMIT",
          "La borne globale de journaux a été atteinte.",
        );
        return;
      }
      const op = object(entry);
      const invocationId = string(op.invocationId);
      const caller = string(op.callerId);
      if (
        !invocationId || caller !== owner || op.revision !== index + 1 ||
        !["install", "load", "unload"].includes(String(op.kind))
      ) {
        if (
          !invalidRecord(
            "EVIDENCE_SKILL_OPERATION_INVALID",
            "Une opération de skill ne possède pas d’identité exploitable.",
          )
        ) return;
        continue;
      }
      const skillId = string(op.skillId);
      const initial = op.kind === "install" && !first.has(skillId ?? "");
      if (op.kind === "install" && skillId) first.add(skillId);
      const matches = catalog.skills.map(object).filter((skill) =>
        skill.id === skillId && skill.digest === op.skillDigest
      );
      const skill = matches.length === 1 ? matches[0]! : {};
      const source = object(skill.source);
      const key = canonical([owner, "skill-operation", caller, invocationId]);
      if (
        !await record(key, {
          operation: entry,
          skill: {
            id: skill.id,
            digest: skill.digest,
            installedAt: skill.installedAt,
            source,
          },
        })
      ) continue;
      if (op.kind !== "install") continue;
      const version = object(op.modelVersion);
      const requestedHost = hostname(source.requestedUrl);
      const finalHost = hostname(source.finalUrl);
      const linked = initial && !!skillId && matches.length === 1 &&
        !!string(op.at) && Number.isFinite(Date.parse(String(op.at))) &&
        !!string(version.digest) && !!string(version.repositoryVersion) &&
        op.at === skill.installedAt && op.at === source.acquiredAt &&
        canonical(version) === canonical(object(source.modelVersion));
      if (source.kind === "bundled" && matches.length === 1) continue;
      const downloaded = linked && source.kind === "https" &&
        !!requestedHost &&
        requestedHost === finalHost &&
        source.requestedUrl === source.finalUrl &&
        source.location === source.requestedUrl;
      if (downloaded && requestedHost !== input.host) continue;
      append({
        id: key,
        source: "skill-operation",
        kind: downloaded ? "skill-downloaded" : "skill-operation-unattributed",
        operatorId: caller,
        modelVersion: string(version.repositoryVersion),
        contractDigest: string(version.digest),
        at: string(op.at),
        invocationId,
        behaviorId: string(op.behaviorId),
        policyId: string(op.policyId),
        ...(downloaded ? { host: requestedHost } : {}),
        startOrder: "unknown",
        issues: downloaded ? [] : [{
          code: "SKILL_OPERATION_HOST_UNKNOWN",
          message:
            "La provenance initiale ne prouve pas l’hôte de cette opération.",
        }],
      });
      if (!downloaded) {
        issue(
          "SKILL_OPERATION_HOST_UNKNOWN",
          "Certaines opérations ne conservent pas leur propre provenance de téléchargement.",
        );
      }
    }
  };

  return {
    valid: true as const,
    result,
    issue,
    checkpoint,
    signal: controller.signal,
    source(id: string | undefined) {
      activeSourceId = id;
    },
    state,
    skills,
    finish() {
      checkpoint();
      activeSourceId = undefined;
      for (const evidence of result.evidence) {
        evidence.sourceIds = [...(origins.get(evidence.id) ?? [])];
        // Network authority is supplied by the builder of the exact contract,
        // not the action's technical performer or a delegated Case's owner.
        if (evidence.source === "message" || evidence.code === "tool-called") {
          const owners = contractOwners.get(canonical([
            evidence.contractDigest,
            evidence.modelVersion,
          ]));
          if (owners?.size === 1) {
            evidence.operatorId = [...owners][0];
            evidence.issues = evidence.issues.filter((entry) =>
              entry.code !== "EVIDENCE_ACTOR_UNKNOWN"
            );
          }
        }
        if (conflicting.has(evidence.id)) {
          for (const sourceId of evidence.sourceIds) {
            issue(
              "EVIDENCE_RECORD_DIVERGED",
              "Les représentations de ce journal divergent.",
              true,
              evidence.id,
              sourceId,
            );
          }
          evidence.kind = evidence.source === "skill-operation"
            ? "skill-operation-unattributed"
            : "context-only";
          delete evidence.host;
          evidence.issues.push({
            code: "EVIDENCE_RECORD_DIVERGED",
            message: "Les représentations de ce journal divergent.",
            sourceId: evidence.sourceIds[0],
            recordId: evidence.id,
          });
        }
      }
      result.evidence = result.evidence.filter((evidence) =>
        !evidence.operatorId || evidence.operatorId === input.operatorId
      );
      for (
        const evidence of result.evidence.filter((entry) => !entry.operatorId)
      ) {
        for (
          const sourceId of evidence.sourceIds?.length
            ? evidence.sourceIds
            : [undefined]
        ) {
          issue(
            "EVIDENCE_ACTOR_UNKNOWN",
            "Certaines observations n’identifient pas leur opérateur.",
            true,
            evidence.id,
            sourceId,
          );
        }
      }
      return result;
    },
    close() {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      controller.signal.removeEventListener("abort", interrupt);
    },
  };
}
