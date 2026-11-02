import { mayConsultModel } from "../../../domain/model/consultation/model-read-policy.ts";
import { Ajv } from "ajv";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type {
  DecisionInformation,
  DecisionInformationPort,
  ModelConsultationPin,
  ModelConsultationReader,
  ModelConsultationResponseBudget,
} from "../../work/context/information-ports.ts";
import type { NetworkImpactConsultation } from "../impact/consultation.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import {
  immutableModelConsultation,
  ModelContextAccessError,
  type ModelContextCapabilities,
  type ModelContextOverview,
  type ModelContextQuery,
  type ModelContextQueryResult,
  type ModelContextTool,
  modelContextTools,
  type ModelExpressionQuery,
  ModelNavigationError,
  type NetworkImpactConsultationQuery,
} from "../../../domain/model/consultation/context.ts";
import type { BehaviorModelVersion } from "../../../domain/shared-kernel/behavior-model-version.ts";
import { characterCount } from "../../../domain/primitives/character-count.ts";
import type {
  Message,
  ModelSourceRevision,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";

export interface ModelContextInformationOptions {
  projectId: string;
  resolveCallerModel(
    callerId: string,
    version: BehaviorModelVersion,
  ): Promise<ExecutableModel | null>;
  snapshotForCaller?(callerId: string): SystemRuntimeState | undefined;
  readSourceRevision?(callerId: string): Promise<ModelSourceRevision>;
  reader: ModelConsultationReader;
  /** Required read-only compiler tooling, operating on an immutable source pin. */
  toolingQuery(version: string, expression: string): Promise<unknown>;
  toolingReferenceSites?(version: string, elementId: string): Promise<{
    sourceDigest: string;
    sites:
      import("../../../domain/model/editing/tooling.ts").ReferenceSiteFingerprint[];
  }>;
  maxLoadedCharacters?: number;
  maxCallers?: number;
  /** Dedicated host composition; source-reading authority alone never enables history reads. */
  networkImpact?: {
    service: Pick<NetworkImpactConsultation, "consult" | "capability">;
    resolveEvidenceScope(
      callerId: string,
    ): Promise<{ id: string; ownerId: string } | null>;
  };
}

interface WorkingSet {
  requestKey: string;
  admission: BehaviorModelVersion;
  overview: ModelContextOverview;
  sources: Record<string, string>;
  publishedRevisions?: ModelSourceRevision["publishedRevisions"];
  requestSource?: ModelSourceRevision["requestSource"];
}

function requireValue(
  value: unknown,
  code: ModelContextAccessError["code"],
  message: string,
): asserts value {
  if (!value) throw new ModelContextAccessError(code, message);
}

function modelVersion(model: ExecutableModel): BehaviorModelVersion {
  requireValue(
    model.version.repositoryVersion?.trim(),
    "MODEL_CONTEXT_AUTHORITY",
    "The admitted caller has no exact repository version.",
  );
  return {
    digest: model.version.digest,
    repositoryVersion: model.version.repositoryVersion!,
  };
}

const ajv = new Ajv({ strict: true, coerceTypes: false, useDefaults: false });
function validators(tools: ModelContextTool[]) {
  return new Map(tools.map((tool) => [
    tool.operation,
    ajv.compile(tool.inputSchema),
  ]));
}

function input(
  request: Record<string, unknown>,
  inputValidators: ReturnType<typeof validators>,
): ModelContextQuery | ModelExpressionQuery | NetworkImpactConsultationQuery | {
  operation: "unload_sources";
  version: string;
  path?: string;
} {
  const validate = inputValidators.get(
    request.operation as ReturnType<
      typeof modelContextTools
    >[number]["operation"],
  );
  requireValue(
    validate && validate(request),
    "MODEL_CONTEXT_INPUT",
    "Model consultation parameters do not match a standard tool contract.",
  );
  for (const selector of ["elementId", "path"] as const) {
    requireValue(
      request[selector] === undefined ||
        (request[selector] as string).trim().length > 0,
      "MODEL_CONTEXT_INPUT",
      "Model consultation selectors cannot be blank.",
    );
  }
  return request as ReturnType<typeof input>;
}

/** Agent-chosen reads need the admitted model read right. A
 * read the admitted flow declares, executed by the host on its exact pin,
 * needs only the caller's own live admission. */
type ReadAuthority = "read" | "declared";

function mayRead(model: ExecutableModel, authority: ReadAuthority): boolean {
  return authority === "declared" ||
    mayConsultModel(model.policy);
}

/** The model authorizes consultation; this provider only holds a bounded,
 * per-request set of exact files from one immutable design revision. */
export class ModelContextInformation implements DecisionInformationPort {
  readonly #sets = new Map<string, WorkingSet>();
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #maximum: number;
  readonly #maxCallers: number;
  readonly #capabilities: ModelContextCapabilities;
  readonly #inputValidators: ReturnType<typeof validators>;
  constructor(readonly options: ModelContextInformationOptions) {
    this.#maximum = options.maxLoadedCharacters ?? 120_000;
    this.#maxCallers = options.maxCallers ?? 64;
    this.#capabilities = options.networkImpact
      ? {
        networkImpact: structuredClone(
          options.networkImpact.service.capability,
        ),
      }
      : {};
    this.#inputValidators = validators(modelContextTools(this.#capabilities));
    requireValue(
      options.projectId.length > 0 && Number.isSafeInteger(this.#maximum) &&
        this.#maximum > 0 && Number.isSafeInteger(this.#maxCallers) &&
        this.#maxCallers > 0,
      "MODEL_CONTEXT_CONFIGURATION",
      "Model context limits and project identity must be explicit and valid.",
    );
  }

  modelTools(model: ExecutableModel): ModelContextTool[] {
    return model.identity.projectId === this.options.projectId &&
        mayConsultModel(model.policy)
      ? modelContextTools(this.#capabilities)
      : [];
  }

  async #serial<T>(callerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(callerId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    this.#queues.set(callerId, pending);
    try {
      return await pending;
    } finally {
      if (this.#queues.get(callerId) === pending) this.#queues.delete(callerId);
    }
  }

  #requestKey(
    model: ExecutableModel,
    messages?: readonly Message[],
    authority: ReadAuthority = "read",
  ): string {
    const source = messages ??
      this.options.snapshotForCaller?.(model.identity.builderId)?.messages ??
      [];
    const latest = source.findLast((message) =>
      message.role === "user" || !!message.work
    );
    const admission = this.#admission(model, authority);
    return JSON.stringify([
      model.identity.projectId,
      model.identity.systemId,
      admission.digest,
      admission.repositoryVersion,
      latest?.id ?? null,
    ]);
  }

  /** The design view may advance across comment-only publications while the
   * runtime's actual execution admission stays pinned to an older commit. */
  #admission(
    model: ExecutableModel,
    authority: ReadAuthority = "read",
  ): BehaviorModelVersion {
    if (!this.options.snapshotForCaller) return modelVersion(model);
    const live = this.options.snapshotForCaller(model.identity.builderId)
      ?.executionModel;
    requireValue(
      live && live.identity.projectId === model.identity.projectId &&
        live.identity.builderId === model.identity.builderId &&
        live.identity.systemId === model.identity.systemId &&
        mayRead(live, authority) &&
        live.version.digest === model.version.digest,
      "MODEL_CONTEXT_AUTHORITY",
      "The consultation does not match the caller's live admitted contract.",
    );
    return modelVersion(live);
  }

  #assertAdmission(
    model: ExecutableModel,
    expected: BehaviorModelVersion,
    authority: ReadAuthority = "read",
  ): void {
    const current = this.#admission(model, authority);
    requireValue(
      current.digest === expected.digest &&
        current.repositoryVersion === expected.repositoryVersion,
      "MODEL_CONTEXT_AUTHORITY",
      "The network consultation belongs to another live admission pin.",
    );
  }

  #liveRequestKey(
    model: ExecutableModel,
    messages?: readonly Message[],
    authority: ReadAuthority = "read",
  ): string {
    const snapshot = this.options.snapshotForCaller?.(model.identity.builderId);
    if (!snapshot) return this.#requestKey(model, messages, authority);
    const request = messages?.findLast((message) =>
      message.role === "user" || !!message.work
    );
    const current = request
      ? snapshot.messages.filter((message) =>
        message.caseId === request.caseId &&
        (request.caseId !== undefined ||
          message.designerScopeId === request.designerScopeId)
      )
      : snapshot.messages;
    return this.#requestKey(model, current, authority);
  }

  async #resolve(
    requested: ExecutableModel,
    authority: ReadAuthority = "read",
  ): Promise<ExecutableModel> {
    requireValue(
      requested.identity.projectId === this.options.projectId &&
        mayRead(requested, authority),
      "MODEL_CONTEXT_AUTHORITY",
      "The caller has no read authority over this model.",
    );
    const requestedVersion = modelVersion(requested);
    const model = await this.options.resolveCallerModel(
      requested.identity.builderId,
      requestedVersion,
    );
    requireValue(
      model && model.identity.projectId === this.options.projectId &&
        model.identity.builderId === requested.identity.builderId &&
        model.identity.systemId === requested.identity.systemId &&
        mayRead(model, authority),
      "MODEL_CONTEXT_AUTHORITY",
      "The admitted caller has no read authority over this model.",
    );
    const admitted = modelVersion(model);
    requireValue(
      admitted.digest === requestedVersion.digest &&
        admitted.repositoryVersion === requestedVersion.repositoryVersion,
      "MODEL_CONTEXT_AUTHORITY",
      "The consultation does not match the caller's exact admitted contract.",
    );
    this.#admission(model, authority);
    return model;
  }

  async read(
    model: ExecutableModel,
    messages?: readonly Message[],
  ): Promise<DecisionInformation> {
    const copied = structuredClone(model);
    if (!mayConsultModel(copied.policy)) {
      return { memoryGuidance: [] };
    }
    await this.#resolve(copied);
    const key = this.#requestKey(copied, messages);
    return await this.#serial(copied.identity.builderId, async () => {
      let set = this.#sets.get(copied.identity.builderId);
      if (!set || set.requestKey !== key) {
        requireValue(
          set || this.#sets.size < this.#maxCallers,
          "MODEL_CONTEXT_CAPACITY",
          "The model context caller capacity has been reached.",
        );
        const revision = await this.options.readSourceRevision?.(
          copied.identity.builderId,
        );
        const overview = await this.options.reader.overview(revision?.version);
        requireValue(
          !revision || revision.version === overview.version,
          "MODEL_CONTEXT_VERSION",
          "The source overview does not match the publication snapshot.",
        );
        set = {
          requestKey: key,
          admission: this.#admission(copied),
          overview: structuredClone(overview),
          sources: {},
          ...(revision?.requestSource
            ? { requestSource: structuredClone(revision.requestSource) }
            : {}),
          ...(revision?.publishedRevisions
            ? {
              publishedRevisions: structuredClone(revision.publishedRevisions),
            }
            : {}),
        };
        this.#sets.set(copied.identity.builderId, set);
      }
      return {
        memoryGuidance: [],
        modelTools: this.modelTools(copied),
        modelContext: {
          ...structuredClone(set.overview),
          loadedSources: Object.entries(set.sources).map(([path, content]) => ({
            path,
            characters: content.length,
          })),
          maxLoadedCharacters: this.#maximum,
        },
        modelSources: {
          version: set.overview.version,
          sources: structuredClone(set.sources),
          ...(set.requestSource
            ? { requestSource: structuredClone(set.requestSource) }
            : {}),
          ...(set.publishedRevisions
            ? { publishedRevisions: structuredClone(set.publishedRevisions) }
            : {}),
        },
      };
    });
  }

  #workingSet(
    model: ExecutableModel,
    query: { operation: string; version: string },
    messages?: readonly Message[],
    live = false,
  ): WorkingSet {
    const set = this.#sets.get(model.identity.builderId);
    requireValue(
      set,
      "MODEL_CONTEXT_NOT_PINNED",
      "Read the current decision model overview before consulting sources.",
    );
    if (live || query.operation === "network_impact") {
      this.#assertAdmission(model, set.admission);
    }
    if (messages || this.options.snapshotForCaller) {
      requireValue(
        set.requestKey ===
          (live
            ? this.#liveRequestKey(model, messages)
            : this.#requestKey(model, messages)),
        "MODEL_CONTEXT_STALE_REQUEST",
        "The source working set belongs to another decision request.",
      );
    }
    requireValue(
      query.version === set.overview.version,
      "MODEL_CONTEXT_VERSION",
      "Use the exact modelContext.version of the current request.",
    );
    return set;
  }

  #assertExpectedPin(set: WorkingSet, pin: ModelConsultationPin): void {
    const sources = {
      version: set.overview.version,
      sources: set.sources,
      ...(set.requestSource ? { requestSource: set.requestSource } : {}),
      ...(set.publishedRevisions
        ? { publishedRevisions: set.publishedRevisions }
        : {}),
    };
    const {
      loadedSources: _loaded,
      maxLoadedCharacters: _maximum,
      ...overview
    } = pin.modelContext;
    requireValue(
      set.overview.version === pin.version &&
        set.overview.sourceDigest === pin.sourceDigest &&
        canonical(set.overview) === canonical(overview) &&
        canonical(sources) === canonical(pin.modelSources),
      "MODEL_CONTEXT_STALE_PIN",
      "The working set differs from the exact recorded source pin.",
    );
  }

  async assertModelContextPin(
    model: ExecutableModel,
    messages: readonly Message[],
    pin: ModelConsultationPin,
  ): Promise<void> {
    await this.withModelContextPin(
      model,
      messages,
      pin,
      () => Promise.resolve(),
    );
  }

  async withModelContextPin<T>(
    model: ExecutableModel,
    messages: readonly Message[],
    pin: ModelConsultationPin,
    operation: () => Promise<T>,
  ): Promise<T> {
    const resolved = await this.#resolve(structuredClone(model));
    return await this.#serial(resolved.identity.builderId, async () => {
      await this.#resolve(resolved);
      if (!this.#sets.has(resolved.identity.builderId)) {
        requireValue(
          this.#sets.size < this.#maxCallers &&
            pin.version === pin.modelContext.version &&
            pin.sourceDigest === pin.modelContext.sourceDigest &&
            pin.modelSources.version === pin.version,
          "MODEL_CONTEXT_STALE_PIN",
          "The historical working set cannot be restored.",
        );
        const {
          loadedSources: _loaded,
          maxLoadedCharacters: _maximum,
          ...overview
        } = pin.modelContext;
        const restored: WorkingSet = {
          requestKey: this.#requestKey(resolved, messages),
          admission: this.#admission(resolved),
          overview: structuredClone(overview),
          sources: structuredClone(pin.modelSources.sources),
          ...(pin.modelSources.requestSource
            ? { requestSource: structuredClone(pin.modelSources.requestSource) }
            : {}),
          ...(pin.modelSources.publishedRevisions
            ? {
              publishedRevisions: structuredClone(
                pin.modelSources.publishedRevisions,
              ),
            }
            : {}),
        };
        this.#sets.set(resolved.identity.builderId, restored);
      }
      const set = this.#workingSet(
        resolved,
        { operation: "search", version: pin.version },
        messages,
        true,
      );
      this.#assertExpectedPin(set, pin);
      return await operation();
    });
  }

  async #readPinned(
    query: ModelContextQuery,
    set: WorkingSet,
  ): Promise<ModelContextQueryResult> {
    const value = await this.options.reader.query(query);
    requireValue(
      value.version === query.version &&
        value.operation === query.operation &&
        value.sourceDigest === set.overview.sourceDigest,
      "MODEL_CONTEXT_SOURCE",
      "The reader result does not match the pinned model snapshot.",
    );
    if (value.operation === "inspect" || value.operation === "references") {
      if (!value.semantic || value.semantic.state !== "ready") {
        throw new ModelNavigationError(
          value.semantic ?? {
            state: "unavailable",
            advisory: true,
            version: query.version,
            code: "INDEX_UNAVAILABLE",
            message: "Navigation requires the exact native semantic index",
            recovery:
              "Configure or restore the pinned native index. Independent search/read_source remain available.",
          },
        );
      }
      requireValue(
        value.semantic.version === query.version &&
          value.semantic.build.sourceDigest === set.overview.sourceDigest &&
          value.semantic.projection.artifactDigest ===
            value.semantic.build.artifactDigest,
        "MODEL_CONTEXT_SOURCE",
        "Graph navigation does not match the immutable source pin.",
      );
    }
    if (query.operation === "inspect" && query.includeReferenceSites) {
      requireValue(
        this.options.toolingReferenceSites,
        "REFERENCE_SITES_UNAVAILABLE",
        "Native reference-site discovery is unavailable.",
      );
      const native = await this.options.toolingReferenceSites(
        query.version,
        query.elementId!,
      );
      requireValue(
        native.sourceDigest === set.overview.sourceDigest,
        "MODEL_CONTEXT_SOURCE",
        "Native reference sites do not match the immutable source pin.",
      );
      requireValue(
        value.operation === "inspect",
        "MODEL_CONTEXT_SOURCE",
        "Reference sites require an inspection result.",
      );
      const response = { ...value, referenceSites: native.sites };
      requireValue(
        new TextEncoder().encode(JSON.stringify(response)).length <= 65536,
        "REFERENCE_SITES_TOO_LARGE",
        "Native reference sites exceed the response limit.",
      );
      return structuredClone(response);
    }
    return structuredClone(value);
  }

  async #queryPinned(
    query: ModelExpressionQuery,
    set: WorkingSet,
  ): Promise<unknown> {
    requireValue(
      query.expression.trim().length > 0,
      "MODEL_CONTEXT_INPUT",
      "Model expression consultation requires a nonblank expression.",
    );
    if (query.mode === "sparql") {
      if (!this.options.reader.queryGraph) {
        throw new ModelNavigationError({
          state: "unavailable",
          advisory: true,
          version: query.version,
          code: "INDEX_UNAVAILABLE",
          message: "The pinned semantic query backend is not configured",
          recovery:
            "Configure the exact native semantic backend and retry the same SPARQL request.",
        });
      }
      const value = await this.options.reader.queryGraph(
        query.version,
        set.overview.sourceDigest,
        query.expression,
      );
      requireValue(
        value.operation === "query" && value.mode === "sparql" &&
          value.version === query.version &&
          value.sourceDigest === set.overview.sourceDigest &&
          value.build.sourceDigest === set.overview.sourceDigest &&
          value.projection.artifactDigest === value.build.artifactDigest,
        "MODEL_CONTEXT_SOURCE",
        "The graph query result does not match the pinned model snapshot.",
      );
      return structuredClone(value);
    }
    return {
      operation: "query",
      version: query.version,
      sourceDigest: set.overview.sourceDigest,
      result: structuredClone(
        await this.options.toolingQuery(query.version, query.expression),
      ),
    };
  }

  /** Mandatory source reads do not select or mutate the design working set.
   * The flow declares them, so they need no revision right (see ReadAuthority);
   * only this closed inspect/read_source request on the exact pin is served. */
  async consultAdmittedModelSource(
    requested: ExecutableModel,
    request: Record<string, unknown>,
    messages?: readonly Message[],
    budget?: ModelConsultationResponseBudget,
  ): Promise<{ modelVersion: BehaviorModelVersion; result: unknown }> {
    const copied = structuredClone(request);
    const scopedMessages = messages ? structuredClone(messages) : undefined;
    const model = structuredClone(
      await this.#resolve(structuredClone(requested), "declared"),
    );
    const admission = modelVersion(model);
    this.#assertAdmission(model, admission, "declared");
    const selector = copied?.operation === "inspect"
      ? "elementId"
      : copied?.operation === "read_source"
      ? "path"
      : undefined;
    requireValue(
      copied && typeof copied === "object" && !Array.isArray(copied) &&
        selector &&
        Object.keys(copied).every((key) =>
          ["operation", "version", selector].includes(key)
        ),
      "MODEL_CONTEXT_INPUT",
      "Admitted source consultation requires a closed inspect or read_source request.",
    );
    const parsed = input(copied, this.#inputValidators);
    requireValue(
      (parsed.operation === "inspect" || parsed.operation === "read_source") &&
        parsed.version === admission.repositoryVersion,
      "MODEL_CONTEXT_VERSION",
      "Use the exact admitted repository version for mandatory source consultation.",
    );
    const maximum = Math.min(budget?.maxResponseCharacters ?? 65536, 65536);
    requireValue(
      Number.isSafeInteger(maximum) && maximum > 0,
      "MODEL_CONTEXT_INPUT",
      "The admitted source response budget must be a positive integer.",
    );
    const requestKey = this.#requestKey(model, scopedMessages, "declared");
    requireValue(
      requestKey ===
        this.#liveRequestKey(model, scopedMessages, "declared"),
      "MODEL_CONTEXT_STALE_REQUEST",
      "The admitted source consultation belongs to another decision request.",
    );
    const overview = await this.options.reader.overview(
      admission.repositoryVersion,
    );
    requireValue(
      overview.version === admission.repositoryVersion &&
        typeof overview.sourceDigest === "string" &&
        overview.sourceDigest.trim().length > 0,
      "MODEL_CONTEXT_SOURCE",
      "The source overview does not match the exact admitted snapshot.",
    );
    const set: WorkingSet = {
      requestKey,
      admission,
      overview: structuredClone(overview),
      sources: {},
    };
    await this.#resolve(model, "declared");
    this.#assertAdmission(model, admission, "declared");
    requireValue(
      requestKey ===
        this.#liveRequestKey(model, scopedMessages, "declared"),
      "MODEL_CONTEXT_STALE_REQUEST",
      "The admitted source request changed during overview resolution.",
    );
    const result = await this.#readPinned(parsed, set);
    if (parsed.operation === "read_source") {
      requireValue(
        result.operation === "read_source",
        "MODEL_CONTEXT_SOURCE",
        "The source reader returned another operation.",
      );
      const file = overview.files.find((file) => file.path === parsed.path);
      requireValue(
        result.path === parsed.path && typeof result.content === "string" &&
          file?.sha256 === result.sha256 &&
          file.characters === result.content.length,
        "MODEL_CONTEXT_SOURCE",
        "The source reader returned a mismatched file.",
      );
      requireValue(
        result.content.length <= this.#maximum,
        "MODEL_CONTEXT_WORKING_SET_LIMIT",
        "The exact admitted source exceeds the source response limit.",
      );
    }
    const response = { modelVersion: admission, result };
    requireValue(
      characterCount(JSON.stringify(response)) <= maximum,
      "MODEL_CONTEXT_RESPONSE_LIMIT",
      "The exact admitted source exceeds the consultation response budget.",
    );
    await this.#resolve(model, "declared");
    this.#assertAdmission(model, admission, "declared");
    requireValue(
      requestKey ===
        this.#liveRequestKey(model, scopedMessages, "declared"),
      "MODEL_CONTEXT_STALE_REQUEST",
      "The admitted source request changed during the consultation.",
    );
    return structuredClone(response);
  }

  async consultModel(
    requested: ExecutableModel,
    request: Record<string, unknown>,
    messages?: readonly Message[],
    budget?: ModelConsultationResponseBudget,
  ): Promise<{ modelVersion: BehaviorModelVersion; result: unknown }> {
    const copiedRequest = structuredClone(request);
    const model = await this.#resolve(structuredClone(requested));
    requireValue(
      copiedRequest && typeof copiedRequest === "object" &&
        !Array.isArray(copiedRequest),
      "MODEL_CONTEXT_INPUT",
      "Model consultation parameters must be an object.",
    );
    const query = input(copiedRequest, this.#inputValidators);
    if (immutableModelConsultation(query)) {
      const prepared = await this.#serial(
        model.identity.builderId,
        async () => {
          await this.#resolve(model);
          const current = this.#workingSet(model, query, messages, true);
          if (budget?.expectedPin) {
            this.#assertExpectedPin(current, budget.expectedPin);
          }
          return { current, snapshot: structuredClone(current) };
        },
      );
      // These operations depend only on the immutable source pin, not the
      // mutable loaded-source set. The caller's queue protects preparation and
      // publication of their result, while independent reader work can overlap.
      const result = query.operation === "query"
        ? await this.#queryPinned(query, prepared.snapshot)
        : await this.#readPinned(query as ModelContextQuery, prepared.snapshot);
      return await this.#serial(model.identity.builderId, async () => {
        await this.#resolve(model);
        const current = this.#workingSet(model, query, messages, true);
        if (budget?.expectedPin) {
          this.#assertExpectedPin(current, budget.expectedPin);
        }
        requireValue(
          current === prepared.current,
          "MODEL_CONTEXT_STALE_REQUEST",
          "The source working set changed during the consultation.",
        );
        return { modelVersion: modelVersion(model), result };
      });
    }
    return await this.#serial(model.identity.builderId, async () => {
      await this.#resolve(model);
      const set = this.#workingSet(model, query, messages);
      let result: unknown;
      if (query.operation === "network_impact") {
        const configured = this.options.networkImpact;
        requireValue(
          configured,
          "MODEL_CONTEXT_CAPABILITY",
          "Network impact consultation is not configured by this host.",
        );
        requireValue(
          query.action !== "compare" ||
            query.operatorId === model.identity.builderId,
          "MODEL_CONTEXT_SCOPE",
          "Network impact consultation covers only the calling operator's own history; no inter-operator grant is configured.",
        );
        const scope = await configured.resolveEvidenceScope(
          model.identity.builderId,
        );
        requireValue(
          scope?.ownerId === model.identity.builderId && scope.id,
          "MODEL_CONTEXT_SCOPE",
          "The host did not resolve an authorized own-history evidence scope.",
        );
        await this.#resolve(model);
        this.#assertAdmission(model, set.admission);
        requireValue(
          set.requestKey === this.#liveRequestKey(model, messages),
          "MODEL_CONTEXT_STALE_REQUEST",
          "The analysis belongs to another decision request.",
        );
        result = await configured.service.consult(
          {
            projectId: this.options.projectId,
            callerId: model.identity.builderId,
            contractDigest: set.admission.digest,
            admittedVersion: set.admission.repositoryVersion,
            consultationVersion: set.overview.version,
            requestKey: set.requestKey,
            evidenceScopeId: scope.id,
          },
          query,
          {
            ...budget,
            responseOverheadCharacters: JSON.stringify({
              modelVersion: modelVersion(model),
              result: null,
            }).length - 4,
          },
        );
        // A long analysis cannot return data under a contract revoked during its read.
        await this.#resolve(model);
        this.#assertAdmission(model, set.admission);
        requireValue(
          !(messages || this.options.snapshotForCaller) ||
            set.requestKey === this.#liveRequestKey(model, messages),
          "MODEL_CONTEXT_STALE_REQUEST",
          "The analysis belongs to another decision request.",
        );
      } else if (query.operation === "query") {
        result = await this.#queryPinned(query, set);
      } else if (query.operation === "unload_sources") {
        const paths = query.path ? [query.path] : Object.keys(set.sources);
        for (const path of paths) delete set.sources[path];
        result = {
          operation: query.operation,
          version: query.version,
          unloadedPaths: paths,
        };
      } else {
        const value = await this.#readPinned(query, set);
        if (query.operation === "read_source") {
          // Exact source bytes belong in modelSources once, not repeated inside
          // the durable journal and then compacted as an ordinary observation.
          requireValue(
            value.operation === "read_source",
            "MODEL_CONTEXT_SOURCE",
            "The source reader returned another operation.",
          );
          const source = value;
          const file = set.overview.files.find((file) =>
            file.path === query.path
          );
          requireValue(
            source.path === query.path && typeof source.content === "string" &&
              file?.sha256 === source.sha256 &&
              file.characters === source.content.length,
            "MODEL_CONTEXT_SOURCE",
            "The source reader returned a mismatched file.",
          );
          const total = Object.entries(set.sources).reduce(
            (sum, [path, text]) =>
              sum + (path === source.path ? 0 : text.length),
            source.content.length,
          );
          requireValue(
            total <= this.#maximum,
            "MODEL_CONTEXT_WORKING_SET_LIMIT",
            "Loading this exact file exceeds the source working set limit; unload files explicitly first.",
          );
          set.sources[source.path] = source.content;
          result = {
            operation: "read_source",
            version: source.version,
            path: source.path,
            sha256: source.sha256,
            characters: source.content.length,
            loaded: true,
          };
        } else result = value;
      }
      return {
        modelVersion: modelVersion(model),
        result,
      };
    });
  }
}
