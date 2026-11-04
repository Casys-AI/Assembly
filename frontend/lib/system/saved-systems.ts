import {
  assertReleaseTagBinding,
  assertReleaseTagRejection,
  assertSavedSystemTag,
  type ReleaseTagBinding,
  type ReleaseTagSelection,
} from "../../../src/domain/work/release-tags.ts";
import {
  currentReleaseSaveHost,
  type ReleaseSaveCommand,
  type ReleaseSaveHost,
  releaseSaveHost,
  type ReleaseSaveIntent,
  type ReleaseSaveRecoveryOptions,
  releaseSaveSlot,
  sameReleaseSource,
  sameReleaseTag,
  validReleaseSaveCommand,
} from "./release-save-intent.ts";
import {
  assertSavedSourceSelection,
  type SavedSystemSourceSelection,
  type SavedSystemView,
} from "../../../src/domain/work/saved-systems.ts";
export type { SavedSystemView };
export class SavedSystemsReadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
export type ReleaseCatalogue = { kind: "main" } | { kind: "owned-requests" } | {
  kind: "case";
  caseId: string;
};
export type ReleaseOpeningKind = "retained" | "local-validation";
/** Display/selection gate only. Exact bundle/model/host/admission validation stays
 * server-side. An incomplete candidate never becomes retention-complete here. */
export function releaseOpeningKind(
  view: SavedSystemView,
  inspected = false,
): ReleaseOpeningKind | null {
  const branch = view.source?.branch;
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(view.id) || !view.source || !branch ||
    !(branch.kind === "main" ||
      branch.kind === "case" && /^[A-Za-z0-9_-]{1,128}$/.test(branch.caseId)) ||
    !/^commit:[a-f0-9]{40}$/.test(view.source.sourceVersion) ||
    !/^[a-f0-9]{64}$/.test(view.digest ?? "") ||
    view.assetAvailability === "unavailable" ||
    (inspected && view.assetAvailability !== "verified") ||
    !Array.isArray(view.issues)
  ) return null;
  if (view.status === "retained" && view.issues.length === 0) return "retained";
  return view.status === "incomplete" && view.issues.length === 1 &&
      view.issues[0] === "PREREQUISITES_REQUIRED" &&
      view.manifest?.source?.sourceVersion === view.source.sourceVersion &&
      Array.isArray(view.manifest?.prerequisites) &&
      view.manifest.prerequisites.some((entry) =>
        entry && entry.kind === "skill"
      )
    ? "local-validation"
    : null;
}
/** Catalogue selectors locate records; the cookie/server still grant access. */
export function releaseCatalogueQuery(
  catalogue: ReleaseCatalogue,
  operation: "list" | "inspect" = "inspect",
): string {
  if (catalogue.kind === "main") return "";
  if (
    catalogue.kind === "case" &&
    !/^[A-Za-z0-9_-]{1,128}$/.test(catalogue.caseId)
  ) {
    throw new SavedSystemsReadError(
      "INVALID_SELECTION",
      "Select an exact Request catalogue.",
    );
  }
  const query = new URLSearchParams();
  if (catalogue.kind === "case" && operation === "list") {
    query.set("caseId", catalogue.caseId);
  } else query.set("space", "requests");
  return `?${query}`;
}
/** Validate publication evidence before showing it or retiring a saved intent. */
export function validSavedSystemTag(view: SavedSystemView): boolean {
  try {
    if (view.rejection !== undefined) {
      const rejection = view.rejection;
      if (
        !rejection || typeof rejection !== "object" ||
        Array.isArray(rejection) ||
        Object.keys(rejection).sort().join(",") !== "code,tag" ||
        view.tag !== undefined ||
        view.tagAvailability !== undefined || !view.source ||
        view.status !== "conflict" || view.manifest !== null ||
        view.digest !== null
      ) return false;
      assertReleaseTagRejection(rejection);
      assertSavedSourceSelection({
        branch: view.source.branch,
        sourceVersion: view.source.sourceVersion,
      });
      return true;
    }
    if (!view.tag) {
      return view.tag === undefined && view.tagAvailability === undefined;
    }
    if (
      !view.source ||
      !["unchecked", "verified", "unavailable"].includes(
        view.tagAvailability ?? "",
      )
    ) return false;
    assertSavedSourceSelection({
      branch: view.source.branch,
      sourceVersion: view.source.sourceVersion,
    });
    assertSavedSystemTag(view.tag, view.source.sourceVersion);
    return true;
  } catch {
    return false;
  }
}
const OPENING_ISSUE_CODES = new Set([
  "SOURCE_OPENING_UNAVAILABLE",
  "OPENING_READINESS_UNAVAILABLE",
  "FOREIGN_SOURCE_PROVENANCE",
  "REQUEST_SOURCE_PROVENANCE_UNAVAILABLE",
  "SOURCE_PROVENANCE_UNAVAILABLE",
  "SOURCE_BUILD_OR_DEPENDENCIES_UNAVAILABLE",
  "SOURCE_DEPENDENCY_UNSUPPORTED",
  "SOURCE_DIGEST_DIFFERS",
  "SOURCE_MEMBERSHIP_DIFFERS",
  "SOURCE_MODEL_PIN_DIFFERS",
  "SOURCE_SCHEDULE_UNSUPPORTED",
  "SOURCE_SKILL_REQUIREMENT_MISSING",
  "HOST_REQUIREMENT_UNSUPPORTED",
  "HOST_RUNNER_UNSUPPORTED_PLATFORM",
  "HOST_RUNNER_SANDBOX_LAUNCH_FAILED",
  "HOST_FRESH_CACHE_AND_ENVIRONMENT_UNAVAILABLE",
  "HOST_NO_REMOTE_OR_NPM_RESOLUTION_UNAVAILABLE",
  "HOST_DENIED_IMPORTS_UNAVAILABLE",
  "HOST_MACOS_DENY_DEFAULT_SANDBOX_UNAVAILABLE",
  "HOST_FRESH_PRIVATE_RESOURCE_BINDINGS_UNAVAILABLE",
  "HOST_REQUIREMENT_MISSING_FRESH_CACHE_AND_ENVIRONMENT",
  "HOST_REQUIREMENT_MISSING_NO_REMOTE_OR_NPM_RESOLUTION",
  "HOST_REQUIREMENT_MISSING_DENIED_IMPORTS",
  "HOST_REQUIREMENT_MISSING_MACOS_DENY_DEFAULT_SANDBOX",
  "HOST_REQUIREMENT_MISSING_FRESH_PRIVATE_RESOURCE_BINDINGS",
  "INITIAL_SKILL_MODEL_INVALID",
  "INITIAL_SKILL_POLICY_UNAVAILABLE",
  "INITIAL_SKILL_LIMIT_EXCEEDED",
  "INITIAL_SKILL_EXPOSURE_UNAVAILABLE",
  "INITIAL_SKILL_BUNDLE_UNAVAILABLE",
  "INITIAL_SKILL_CONTENT_INVALID",
  "INITIAL_SKILL_CONTENT_DIFFERS",
]);
/** Read-only host preflight, distinct from retention and caller authority. */
export function validOpeningEvidence(view: SavedSystemView): boolean {
  const availability = view.openingAvailability, issues = view.openingIssues;
  if (availability === undefined && issues === undefined) return true;
  if (
    !Array.isArray(issues) || issues.length > 64 ||
    !issues.every((issue) =>
      typeof issue === "string" && OPENING_ISSUE_CODES.has(issue)
    ) ||
    new Set(issues).size !== issues.length
  ) return false;
  if (availability === "unchecked") return issues.length === 0;
  if (availability === "unavailable") return issues.length > 0;
  if (availability === "ready") {
    if (
      issues.length !== 0 || !view.source || !view.manifest?.source ||
      typeof view.digest !== "string" || !/^[a-f0-9]{64}$/.test(view.digest) ||
      view.assetAvailability !== "verified" ||
      view.tagAvailability === "unavailable" ||
      !(view.status === "retained" || view.status === "incomplete")
    ) return false;
    try {
      assertSavedSourceSelection({
        branch: view.source.branch,
        sourceVersion: view.source.sourceVersion,
      });
      assertSavedSourceSelection({
        branch: view.manifest.source.branch,
        sourceVersion: view.manifest.source.sourceVersion,
      });
      return sameReleaseSource(view.source, view.manifest.source);
    } catch {
      return false;
    }
  }
  return false;
}
export function createSavedSystemsApi(
  options: { fetch?: typeof fetch; catalogue?: ReleaseCatalogue } = {},
) {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const catalogue = options.catalogue ?? { kind: "main" as const };
  async function post(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await request(path, {
      method: "POST",
      signal,
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new SavedSystemsReadError(
        typeof result?.code === "string" ? result.code : "UNAVAILABLE",
        typeof result?.error === "string"
          ? result.error
          : "Releases are unavailable.",
      );
    }
    return result;
  }
  function record(value: unknown, inspected = false): SavedSystemView {
    const view = value as SavedSystemView;
    if (
      !view || typeof view.id !== "string" ||
      !["pending", "incomplete", "retained", "conflict"].includes(
        view.status,
      ) || typeof view.metadata?.name !== "string" ||
      !["unchecked", "verified", "unavailable"].includes(
        view.assetAvailability,
      ) ||
      !Array.isArray(view.issues) || !Array.isArray(view.selectedOperators) ||
      !Array.isArray(view.prerequisites) || !view.origin ||
      !validSavedSystemTag(view) || !validOpeningEvidence(view) ||
      (!inspected && view.openingAvailability !== undefined &&
        view.openingAvailability !== "unchecked")
    ) {
      throw new SavedSystemsReadError(
        "INVALID_RESPONSE",
        "The Release response is invalid.",
      );
    }
    return view;
  }
  return {
    async list(signal?: AbortSignal): Promise<SavedSystemView[]> {
      const result = await post(
        `/api/saved-systems/list${releaseCatalogueQuery(catalogue, "list")}`,
        {},
        signal,
      );
      if (!Array.isArray(result)) {
        throw new SavedSystemsReadError(
          "INVALID_RESPONSE",
          "The Release catalogue response is invalid.",
        );
      }
      return result.map((value) => record(value));
    },
    async tags(
      source: SavedSystemSourceSelection,
      signal?: AbortSignal,
    ): Promise<ReleaseTagBinding[]> {
      const result = await post("/api/saved-systems/tags", { source }, signal);
      const tags = (result as { tags?: unknown })?.tags;
      if (!Array.isArray(tags) || tags.length > 10000) {
        throw new SavedSystemsReadError(
          "INVALID_RESPONSE",
          "The tag list is invalid.",
        );
      }
      try {
        for (const tag of tags) {
          assertReleaseTagBinding(tag, source.sourceVersion);
        }
        if (new Set(tags.map((tag) => tag.name)).size !== tags.length) {
          throw new Error();
        }
      } catch {
        throw new SavedSystemsReadError(
          "INVALID_RESPONSE",
          "The tag list is invalid.",
        );
      }
      return tags;
    },
    async save(
      input: {
        saveKey: string;
        name: string;
        purpose: string;
        source: SavedSystemSourceSelection;
        tag?: ReleaseTagSelection;
      },
    ): Promise<SavedSystemView> {
      return record(await post("/api/saved-systems/save", input));
    },
    async inspect(id: string): Promise<SavedSystemView> {
      return record(
        await post(
          `/api/saved-systems/${encodeURIComponent(id)}/inspect${
            releaseCatalogueQuery(catalogue)
          }`,
          {},
        ),
        true,
      );
    },
  };
}
export type SavedSystemsApi = ReturnType<typeof createSavedSystemsApi> & {
  listWithNotice?: (signal?: AbortSignal) => Promise<
    { records: SavedSystemView[]; notice: string }
  >;
};

/** Main's catalogue combines independent authenticated reads, preserving the
 * origin used for selected inspection and exposing a failed half explicitly. */
export function createCombinedSavedSystemsApi(
  options: { fetch?: typeof fetch } = {},
): SavedSystemsApi {
  const main = createSavedSystemsApi({
    ...options,
    catalogue: { kind: "main" },
  });
  const requests = createSavedSystemsApi({
    ...options,
    catalogue: { kind: "owned-requests" },
  });
  let generation = 0;
  let origins = new Map<string, "main" | "requests">();
  async function listWithNotice(signal?: AbortSignal) {
    const current = ++generation;
    const [mainResult, requestResult] = await Promise.allSettled([
      main.list(signal),
      requests.list(signal),
    ]);
    if (
      mainResult.status === "rejected" && requestResult.status === "rejected"
    ) {
      throw new SavedSystemsReadError(
        "UNAVAILABLE",
        "Main and Request Releases could not be read.",
      );
    }
    const found = new Map<string, "main" | "requests">();
    const records: SavedSystemView[] = [];
    for (
      const [origin, result] of [
        ["main", mainResult],
        ["requests", requestResult],
      ] as const
    ) {
      if (result.status !== "fulfilled") continue;
      for (const record of result.value) {
        if (
          found.has(record.id) ||
          (record.origin.executionSpaceId === "main") !== (origin === "main")
        ) {
          throw new SavedSystemsReadError(
            "INVALID_RESPONSE",
            "Release catalogue origins are inconsistent.",
          );
        }
        found.set(record.id, origin);
        records.push(record);
      }
    }
    if (current === generation && !signal?.aborted) origins = found;
    return {
      records,
      notice: mainResult.status === "rejected"
        ? "Partial catalogue: Main Releases could not be read."
        : requestResult.status === "rejected"
        ? "Partial catalogue: owned Request Releases could not be read."
        : "",
    };
  }
  return {
    ...main,
    listWithNotice,
    async list(signal?: AbortSignal) {
      return (await listWithNotice(signal)).records;
    },
    async inspect(id) {
      const origin = origins.get(id);
      if (!origin) {
        throw new SavedSystemsReadError(
          "UNAVAILABLE",
          "This Release is not in the current catalogue.",
        );
      }
      const record = await (origin === "main" ? main : requests).inspect(id);
      if (
        origins.get(id) !== origin || record.id !== id ||
        (record.origin.executionSpaceId === "main") !== (origin === "main")
      ) {
        throw new SavedSystemsReadError(
          "INVALID_RESPONSE",
          "The inspected Release origin is inconsistent.",
        );
      }
      return record;
    },
    async save(command) {
      const saved = await main.save(command);
      ++generation;
      origins.set(
        saved.id,
        saved.origin.executionSpaceId === "main" ? "main" : "requests",
      );
      return saved;
    },
  };
}

/** The controller owns one active retry identity. Persistence precedes send;
 * a canonical exact ACK retires uncertainty, including incomplete retention.
 * Inspection reconstructs accepted repair identity without a client registry. */
export function createSavedSystemsController(
  api: SavedSystemsApi,
  changed: () => void = () => {},
  createKey: () => string = () => crypto.randomUUID(),
  recovery: ReleaseSaveRecoveryOptions = {},
) {
  const state = {
    records: [] as SavedSystemView[],
    selected: null as SavedSystemView | null,
    intent: null as ReleaseSaveIntent | null,
    repair: null as ReleaseSaveCommand | null,
    busy: false,
    reading: false,
    error: "",
    refused: false,
    readError: "",
    readRefused: false,
    catalogueNotice: "",
  };
  let disposed = false;
  let boundHost: ReleaseSaveHost | null = null;
  let boundOrigin: string | null = null;
  let refreshFlight: Promise<void> | null = null;
  let refreshAgain = false;
  let readAbort: AbortController | null = null;
  let queuedRefresh: (() => void) | null = null;
  // The one explicit command, waiting or running, and how to let it start.
  let commandPending = false;
  let resumeCommand: (() => void) | null = null;
  let inspectionGeneration = 0;
  async function restore() {
    const host = await (recovery.host ?? currentReleaseSaveHost)();
    const origin = (recovery.origin ?? (() => location.origin))();
    if (
      !releaseSaveHost(host) || boundHost &&
        (host.projectId !== boundHost.projectId ||
          host.systemId !== boundHost.systemId || origin !== boundOrigin)
    ) {
      throw new Error("The Release host changed. Reload before continuing.");
    }
    const slot = releaseSaveSlot(
      host,
      origin,
      (recovery.storage ?? (() => localStorage))(),
    );
    const stored = slot.read();
    if (
      state.intent &&
      (!stored || !sameCommand(state.intent.command, stored.command))
    ) {
      throw new Error(
        "The Release creation request changed. It was not replaced.",
      );
    }
    boundHost = structuredClone(host);
    boundOrigin = origin;
    if (!disposed) state.intent = stored;
    return { slot, host };
  }
  function sameCommand(a: ReleaseSaveCommand, b: ReleaseSaveCommand) {
    return a.saveKey === b.saveKey && a.name === b.name &&
      a.purpose === b.purpose &&
      sameReleaseSource(a.source, b.source) && sameReleaseTag(a.tag, b.tag);
  }
  function canonicalCommand(
    view: SavedSystemView,
    host: ReleaseSaveHost,
  ): ReleaseSaveCommand | null {
    const command = {
      saveKey: view.saveKey,
      name: view.metadata?.name,
      purpose: view.metadata?.purpose,
      ...(view.tag || view.rejection
        ? { tag: view.tag?.selection ?? view.rejection!.tag }
        : {}),
      source: view.source &&
        {
          branch: view.source.branch,
          sourceVersion: view.source.sourceVersion,
        },
    };
    return validSavedSystemTag(view) && validReleaseSaveCommand(command) &&
        /^[A-Za-z0-9_-]{1,128}$/.test(view.id) &&
        view.origin?.projectId === host.projectId &&
        view.origin.systemId === host.systemId &&
        typeof view.origin.executionSpaceId === "string" &&
        /^[A-Za-z0-9_-]{1,128}$/.test(view.origin.executionSpaceId) &&
        (command.source.branch.kind === "main"
          ? view.origin.executionSpaceId === "main"
          : view.origin.executionSpaceId !== "main") &&
        Number.isSafeInteger(view.revision) && view.revision >= 0 &&
        ["pending", "incomplete", "retained", "conflict"].includes(view.status)
      ? structuredClone(command)
      : null;
  }
  async function send(
    command: ReleaseSaveCommand,
    selectedSource: SavedSystemSourceSelection,
  ) {
    const { slot, host } = await restore();
    if (disposed) return;
    if (
      !validReleaseSaveCommand(command) ||
      !sameReleaseSource(command.source, selectedSource)
    ) {
      throw new Error(
        "Reopen the exact source before retrying this Release creation.",
      );
    }
    if (state.intent && !sameCommand(state.intent.command, command)) {
      throw new Error(
        "Retry the Release creation first. Its title, notes, tag and source stay fixed until an exact acknowledgement.",
      );
    }
    const intent: ReleaseSaveIntent = {
      format: 1,
      host: structuredClone(host),
      command: structuredClone(command),
    };
    // Same fail-closed pattern as Request opening: durable write before network.
    slot.write(intent);
    state.intent = intent;
    changed();
    const result = await api.save(structuredClone(command));
    if (disposed) return;
    const acknowledged = canonicalCommand(result, host);
    if (!acknowledged || !sameCommand(command, acknowledged)) {
      throw new Error(
        "The Release acknowledgement does not match the creation request. Retry the same request.",
      );
    }
    state.selected = result;
    state.repair = result.status === "pending" || result.status === "incomplete"
      ? acknowledged
      : null;
    state.records = [
      result,
      ...state.records.filter((entry) => entry.id !== result.id),
    ];
    // An exact accepted record owns retry identity even if prerequisites remain.
    // Status remains incomplete/pending; this is an ACK, never an authority grant.
    slot.retire(intent);
    state.intent = null;
    // Only the host's read says whether a Request can start from it now.
    if (result.status !== "conflict") await readRelease(result.id);
  }
  /** Read one exact Release; a failed read leaves the one shown as it was. */
  async function readRelease(id: string) {
    const generation = ++inspectionGeneration;
    const result = await api.inspect(id);
    if (disposed || generation !== inspectionGeneration) return;
    if (
      result.id !== id || !validSavedSystemTag(result) ||
      !validOpeningEvidence(result)
    ) {
      throw new Error("The inspected Release identity or tag is invalid.");
    }
    const { host } = await restore();
    if (disposed || generation !== inspectionGeneration) return;
    if (
      result.origin?.projectId !== host.projectId ||
      result.origin?.systemId !== host.systemId
    ) {
      throw new Error("The inspected Release host does not match.");
    }
    state.selected = result;
    state.repair = result.status === "pending" || result.status === "incomplete"
      ? canonicalCommand(result, host)
      : null;
  }
  async function run(work: () => Promise<void>, background = false) {
    if (disposed) return;
    if (!background) {
      // One explicit command at a time, never dropped in silence. It waits
      // only for the read in progress: reads asked meanwhile queue behind it.
      if (commandPending) {
        state.error = "Another Release action is still running.";
        changed();
        return;
      }
      commandPending = true;
      if (state.busy) {
        await new Promise<void>((resume) => {
          resumeCommand = resume;
        });
      }
      if (disposed) return;
    } else if (state.busy) return;
    state.busy = true;
    state.reading = background;
    if (background) {
      state.readError = "";
      state.readRefused = false;
    } else {
      state.error = "";
      state.refused = false;
    }
    changed();
    try {
      await work();
    } catch (error) {
      if (!disposed) {
        const message = error instanceof Error
          ? error.message
          : "Releases are unavailable.";
        const refused = error instanceof SavedSystemsReadError &&
          error.code === "FORBIDDEN";
        if (background) {
          state.readError = message;
          state.readRefused = refused;
        } else {
          state.error = message;
          state.refused = refused;
        }
      }
    } finally {
      state.busy = false;
      state.reading = false;
      if (!background) commandPending = false;
      if (!disposed) changed();
      const resume = resumeCommand;
      resumeCommand = null;
      if (resume) resume();
      else {
        const next = queuedRefresh;
        queuedRefresh = null;
        next?.();
      }
    }
  }
  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (refreshFlight) return refreshFlight;
    const pending = Promise.withResolvers<void>();
    const abort = new AbortController();
    readAbort = abort;
    refreshFlight = pending.promise;
    const read = () => {
      void run(async () => {
        // Reads recover identity only; they never retry a creation command.
        let recoveryError: unknown;
        try {
          await restore();
        } catch (error) {
          recoveryError = error;
        }
        if (disposed) return;
        let records: SavedSystemView[];
        try {
          const catalogue = api.listWithNotice
            ? await api.listWithNotice(abort.signal)
            : { records: await api.list(abort.signal), notice: "" };
          records = catalogue.records;
          if (!disposed) state.catalogueNotice = catalogue.notice;
        } catch (error) {
          if (!disposed) {
            state.records = [];
            state.selected = null;
            state.repair = null;
          }
          throw error;
        }
        if (!disposed) {
          state.records = records;
          const selected = state.selected;
          if (
            selected &&
            !records.some((record) =>
              record.id === selected.id && record.digest === selected.digest &&
              record.revision === selected.revision
            )
          ) {
            state.selected = null;
            state.repair = null;
          }
        }
        if (recoveryError) {
          if (!disposed) {
            state.selected = null;
            state.repair = null;
          }
          throw recoveryError;
        }
      }, true).finally(() => {
        refreshFlight = null;
        readAbort = null;
        if (refreshAgain && !disposed) {
          refreshAgain = false;
          void refresh().then(pending.resolve);
        } else pending.resolve();
      });
    };
    if (state.busy || commandPending) queuedRefresh = read;
    else read();
    return pending.promise;
  }
  return {
    state,
    open: refresh,
    /** Advisory events during a read require one later authorized reread. */
    invalidate() {
      if (disposed) return Promise.resolve();
      if (refreshFlight) {
        refreshAgain = true;
        return refreshFlight;
      }
      return refresh();
    },
    clearInspection() {
      inspectionGeneration++;
      state.selected = null;
      changed();
    },
    save: (
      name: string,
      purpose: string,
      source: SavedSystemSourceSelection,
      tag?: ReleaseTagSelection,
    ) =>
      run(async () => {
        await restore();
        if (disposed) return;
        const draft = {
          saveKey: state.intent?.command.saveKey ?? "validating",
          name: name.trim(),
          purpose: purpose.trim(),
          source: structuredClone(source),
          ...(tag ? { tag: structuredClone(tag) } : {}),
        };
        if (!tag || !validReleaseSaveCommand(draft)) {
          throw new Error(
            "Use a bounded title, notes, tag and exact model source.",
          );
        }
        if (state.intent && !sameCommand(state.intent.command, draft)) {
          throw new Error(
            "Retry the Release creation first. Its title, notes, tag and source stay fixed until an exact acknowledgement.",
          );
        }
        const command = state.intent?.command ??
          { ...draft, saveKey: createKey() };
        await send(command, source);
      }),
    retry: (source: SavedSystemSourceSelection) =>
      run(async () => {
        await restore();
        const command = state.intent?.command;
        if (!command) {
          throw new Error("There is no uncertain Release intention to retry.");
        }
        await send(command, source);
      }),
    repair: (source: SavedSystemSourceSelection) =>
      run(async () => {
        const id = state.selected?.id;
        const previouslyInspected = state.repair;
        if (!id || !previouslyInspected) {
          throw new Error(
            "Inspect an exact Release before retrying retention.",
          );
        }
        // Fresh visibility and canonical command; no stale catalogue grants access.
        const view = await api.inspect(id);
        const { host } = await restore();
        if (disposed) return;
        const command = canonicalCommand(view, host);
        if (
          view.id !== id || !command ||
          !sameCommand(previouslyInspected, command) ||
          view.status !== "pending" && view.status !== "incomplete"
        ) {
          throw new Error("This Release has no pending retention to retry.");
        }
        await send(command, source);
      }),
    inspect: (id: string) =>
      run(async () => {
        // Another Release's evidence never stands in while this one is read.
        state.selected = null;
        state.repair = null;
        await readRelease(id);
      }),
    dispose() {
      disposed = true;
      readAbort?.abort();
      refreshAgain = false;
      inspectionGeneration++;
      const next = queuedRefresh;
      queuedRefresh = null;
      next?.();
    },
  };
}
