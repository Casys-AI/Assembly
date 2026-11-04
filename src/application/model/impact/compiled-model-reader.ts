import type { SourceExecutablesCompilationPort } from "../source-compilation.ts";
import type { ModelRepositoryPort } from "../repository.ts";
import type { NetworkImpactModelReader } from "./ports/out/network-impact-model-reader.port.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import { buildRefFromDescriptor } from "../../../domain/model/value-objects/element-ref.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";
import {
  type NetworkImpactFrame,
  type NetworkImpactGuard,
  type NetworkImpactIssue,
  type NetworkImpactPath,
  networkImpactPathState,
  type NetworkImpactWitness,
} from "../../../domain/model/consultation/network-impact.ts";
import { matchesLocalSkillExposure } from "../../skills/behavior.ts";
import { projectSourceGraph } from "../../../domain/model/projections/source-graph.ts";
import { sourceLiterals } from "../../../domain/model/projections/source-facts.ts";

interface CompiledNetworkImpactModelReaderOptions {
  compilation: SourceExecutablesCompilationPort;
  repository: Pick<ModelRepositoryPort, "at" | "descriptorAt">;
  projectId: string;
}

/** Metadata only: instructions and native literal contents never leave this reader. */
function witnesses(revision: ModelRevision) {
  const byId = new Map(
    revision.elements.map((element) => [String(element["@id"]), element]),
  );
  return (ids: readonly string[], role: string): NetworkImpactWitness[] =>
    [...new Set(ids)].slice(0, 128).map((elementId) => {
      const element = byId.get(elementId);
      const path = element?.["sysx:sourceDocument"];
      const line = element?.["sysx:sourceLine"];
      const column = element?.["sysx:sourceColumn"];
      return {
        role,
        elementId,
        ...(typeof element?.["@type"] === "string"
          ? { metaclass: element["@type"].slice(0, 128) }
          : {}),
        ...(typeof element?.qualifiedName === "string"
          ? { qualifiedName: element.qualifiedName.slice(0, 1024) }
          : {}),
        ...(typeof path === "string" && Object.hasOwn(revision.sources, path) &&
            typeof line === "number" && Number.isSafeInteger(line) &&
            line > 0 &&
            typeof column === "number" && Number.isSafeInteger(column) &&
            column > 0
          ? { path, line, column }
          : {}),
      };
    });
}

function witnessLimitIssue(
  issues: NetworkImpactIssue[] | undefined,
  version: string,
  recordId: string,
): void {
  if (
    issues?.some((issue) =>
      issue.code === "WITNESS_LIMIT" && issue.version === version &&
      issue.recordId === recordId
    )
  ) return;
  issues?.push({
    code: "WITNESS_LIMIT",
    message:
      "Relevant native witness metadata exceeds the 128-entry limit; the route identity is incomplete.",
    version,
    recordId,
  });
}

/** Facts from the production executable contract; never an invocation or a grant. */
export function projectNetworkImpactPaths(
  revision: ModelRevision,
  model: ExecutableModel,
  models: readonly ExecutableModel[],
  host: string,
  issues?: NetworkImpactIssue[],
): NetworkImpactPath[] {
  const locate = witnesses(revision);
  const graph = projectSourceGraph(revision.elements, model.identity);
  const literals = sourceLiterals(revision.elements);
  const literalIds = (owner: string, name: string) =>
    literals.filter((literal) =>
      literal.owner === owner && literal.name === name
    ).flatMap((literal) => [literal.attributeId, literal.literalId]);
  const owned = (name: string) =>
    revision.elements.filter((element) =>
      element.declaredName === name &&
      (element.owner as { "@id"?: unknown } | undefined)?.["@id"] ===
        model.identity.systemId
    ).map((element) => String(element["@id"]));
  const guard = (
    code: string,
    state: NetworkImpactGuard["state"],
    explanation: string,
    ids: readonly string[],
  ): NetworkImpactGuard => {
    if (new Set(ids).size > 128) {
      witnessLimitIssue(issues, revision.version, code);
    }
    return { code, state, explanation, witnesses: locate(ids, code) };
  };
  const webAllowed = model.configuration.network?.allowedHosts.includes(host);
  const active = model.catalog.filter((entry) =>
    entry.status === "active" &&
    model.contracts.some((contract) =>
      contract.nativeId === entry.contractId && contract.kind === entry.kind
    )
  );
  const nativeIds = new Set(
    revision.elements.map((element) => String(element["@id"])),
  );
  const holderMandates = graph.nodes.filter((node) =>
    node.nativeId === model.identity.builderId &&
    node.mandate?.holderNativeId === model.identity.builderId
  ).flatMap((node) => node.mandate ? [node.mandate] : []);
  const holderMandate = holderMandates.length === 1
    ? holderMandates[0]
    : undefined;
  // The annotation also contains the free-text `source` literal. Only actual
  // native element identities are evidence references, never that literal text.
  const mandateIds = holderMandate
    ? [holderMandate.nativeId, ...holderMandate.sourceRefs].filter((id) =>
      nativeIds.has(id)
    )
    : [];
  const policyIds = revision.elements.filter((element) =>
    element.declaredName === "executionPolicy" &&
    owned("conversation").includes(
      String((element.owner as { "@id"?: unknown } | undefined)?.["@id"]),
    )
  ).map((element) => String(element["@id"]));
  const webGuards = [
    guard(
      "WEB_HOST_SCOPE",
      webAllowed === undefined ? "unknown" : webAllowed ? "pass" : "fail",
      "The web runner consumes the exact host list of the operator configuration.",
      graph.networkScope?.nativeSourceIds ?? [],
    ),
    guard(
      "WEB_INVOKE_MANDATE",
      model.mandate.mayInvoke === "active-catalog-only" ? "pass" : "fail",
      "Web invocation requires the native active-catalog invocation mandate." +
        (holderMandate
          ? ""
          : " Exact holder-binding witness metadata is unavailable; the authority value comes from the validated executable contract."),
      [
        ...mandateIds,
        ...mandateIds.flatMap((id) => literalIds(id, "mayInvokeActiveCatalog")),
      ],
    ),
    guard(
      "WEB_NATIVE_ACTIVE_CATALOG",
      active.length ? "pass" : "fail",
      "At least one native active entry must bind its exact native tool contract.",
      [
        model.identity.catalogId,
        ...active.flatMap((entry) => [entry.nativeId, entry.contractId]),
      ],
    ),
    guard(
      "WEB_TOOL_BYTES_AND_INPUT",
      "conditional",
      "An actual invocation must still match admitted tool bytes and use a valid HTTPS URL; operational candidate bytes are not proved by this model read.",
      [],
    ),
    guard(
      "WEB_URL_SELECTION",
      "conditional",
      model.policy.urlSelectionMode === "user-provided"
        ? "The URL must come from the current human conversation or the admitted scheduled Case declaration."
        : "The caller may choose a URL within an explicitly allowed host.",
      [
        ...policyIds,
        ...policyIds.flatMap((id) => literalIds(id, "urlSelectionMode")),
      ],
    ),
  ];
  const entryMap = new Map(
    models.flatMap((current) =>
      (current.operatorEntries ?? []).map((entry) =>
        [entry.id, {
          ownerId: current.identity.builderId,
          kind: entry.kind,
        }] as const
      )
    ),
  );
  const exposures = (model.behaviors ?? []).filter((behavior) =>
    matchesLocalSkillExposure(model, behavior, "skill-install", entryMap)
  );
  const skill = model.skillPolicy;
  const skillAllowed = skill?.allowedHosts.includes(host) ?? false;
  const skillGuards = [
    guard(
      "SKILL_LOCAL_POLICY",
      skill?.ownerId === model.identity.builderId ? "pass" : "fail",
      "Installation requires the caller's own admitted skill policy.",
      skill?.sourceIds ?? [model.identity.systemId],
    ),
    guard(
      "SKILL_HOST_SCOPE",
      skillAllowed ? "pass" : "fail",
      "The skill downloader consumes skillPolicy.allowedHosts independently of the web network host list.",
      skill?.sourceIds ?? [],
    ),
    guard(
      "SKILL_LOCAL_INSTALL_EXPOSURE",
      exposures.length ? "pass" : "fail",
      "Installation requires an enabled native exposure with the exact local caller, allocated target and builtin input schema.",
      exposures.flatMap((behavior) => [
        ...behavior.sourceIds,
        ...(model.operatorEntries ?? []).filter((entry) =>
          entry.id === behavior.targetNativeId
        ).flatMap((entry) => entry.sourceIds),
      ]),
    ),
    guard(
      "SKILL_DOWNLOAD_INPUT_AND_LIMITS",
      "conditional",
      "An invocation must supply a valid HTTPS SKILL.md URL without a redirect, satisfy the local installation limits and any expected digest, and receive a valid response." +
        (skill
          ? ` The admitted maximum download size is ${skill.maxSkillBytes} bytes; the admitted maximum installed skill count is ${skill.maxInstalledSkills}.`
          : " No admitted local installation limits are available."),
      skill?.sourceIds ?? [],
    ),
  ];
  const path = (
    channel: NetworkImpactPath["channel"],
    hostPermission: NetworkImpactPath["hostPermission"],
    guards: NetworkImpactGuard[],
    consumer: NetworkImpactPath["consumer"],
  ): NetworkImpactPath => {
    // A native fact may support several guards. Keep their precise roles above;
    // the path summary counts each native element once, independently of reuse.
    const unique = new Map(
      guards.flatMap((entry) => entry.witnesses).map((witness) =>
        [witness.elementId, { ...witness, role: "path" }] as const
      ),
    );
    if (unique.size > 128) {
      witnessLimitIssue(issues, revision.version, channel);
    }
    return {
      id: `${model.identity.builderId}:${channel}`,
      channel,
      hostPermission,
      state: networkImpactPathState(guards),
      guards,
      witnesses: [...unique.values()].slice(0, 128),
      consumer,
    };
  };
  // Preserve historical source labels: they participate in route signatures.
  // Current physical locations are tracked separately by the move manifest.
  return [
    path(
      "web",
      webAllowed === undefined ? "unknown" : webAllowed ? "allowed" : "denied",
      webGuards,
      {
        symbol: "DenoToolRunner.checkedUrl",
        source: "src/adapters/tool-runner.ts",
      },
    ),
    path("skill-install", skillAllowed ? "allowed" : "denied", skillGuards, {
      symbol: "requireSkillUrl",
      source: "src/domain/context-skills.ts",
    }),
  ];
}

/** Reads immutable verified artifacts and reuses only the executable contract projection. */
export class CompiledNetworkImpactModelReader
  implements NetworkImpactModelReader {
  constructor(readonly options: CompiledNetworkImpactModelReaderOptions) {}

  async read(
    version: string,
    operatorId: string,
    host: string,
    signal?: AbortSignal,
  ): Promise<NetworkImpactFrame> {
    const frame: NetworkImpactFrame = {
      version,
      state: "unknown",
      paths: [],
      issues: [],
      indirectAccess: "not-covered",
    };
    let stage = "MODEL_READ_FAILED";
    try {
      signal?.throwIfAborted();
      const revision = await this.options.repository.at(version, signal);
      signal?.throwIfAborted();
      frame.sourceDigest = revision.sourceDigest;
      if (revision.version !== version) {
        throw new Error("Immutable revision mismatch");
      }
      stage = "BUILD_DESCRIPTOR_FAILED";
      const descriptor = await this.options.repository.descriptorAt?.(
        version,
        signal,
      );
      signal?.throwIfAborted();
      if (descriptor) {
        if (
          descriptor.sourceDigest !== revision.sourceDigest ||
          descriptor.repositoryId !==
            this.options.projectId.replace(/^git:/, "")
        ) {
          throw new Error("Build pin mismatch");
        }
        frame.build = buildRefFromDescriptor(descriptor);
      } else {
        frame.issues.push({
          code: "BUILD_RECIPE_UNKNOWN",
          message:
            "This revision has no persisted build descriptor; its compilation recipe identity is unknown.",
          version,
        });
      }
      stage = "EXECUTABLE_MODEL_UNAVAILABLE";
      if (!revision.elements.length) {
        throw new Error("No calculated native artifact");
      }
      const compiled = await this.options.compilation.compile(
        revision,
        this.options.projectId,
      );
      signal?.throwIfAborted();
      const selected = compiled.filter(({ model }) =>
        model.identity.builderId === operatorId
      );
      if (selected.length !== 1) {
        frame.issues.push({
          code: "OPERATOR_UNRESOLVED",
          message:
            "The exact native operator identity is absent or ambiguous in this revision.",
          version,
        });
        return frame;
      }
      const { model, unit } = selected[0]!;
      frame.operatorId = operatorId;
      frame.systemQualifiedName = unit.systemQualifiedName;
      frame.contractDigest = model.version.digest;
      stage = "NETWORK_PATH_PROJECTION_FAILED";
      frame.paths = projectNetworkImpactPaths(
        revision,
        model,
        compiled.map((entry) => entry.model),
        host,
        frame.issues,
      );
      frame.state = "known";
    } catch {
      // Compiler diagnostics may contain instruction literals: keep failures metadata-only.
      frame.issues.push({
        code: signal?.aborted ? "MODEL_READ_ABORTED" : stage,
        message:
          "The revision could not establish the requested model facts; no absence of permission is inferred.",
        version,
      });
    }
    return frame;
  }
}
