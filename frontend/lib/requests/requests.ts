import {
  type CaseModelScope,
  readCaseModelScope,
} from "../case-model-scope.ts";
import { signal } from "@preact/signals";
import {
  isSessionFailure,
  isStaleConversation,
  responseError,
  retryOnceAfterStale,
  sendErrorMessage,
} from "../api-error.ts";
import { type AssemblyEnvironment, parseEnvironment } from "../environment.ts";
import type {
  AgentConversation,
  ConversationsSnapshot,
} from "../../../src/application/work/operators/conversation-types.ts";
import type {
  OpeningCommand,
  OpeningSourceChoice,
} from "../../../src/domain/work/request-spaces/opening.ts";
import type { OpeningView } from "../../../src/application/work/request-spaces/opening-view.ts";
import { createCases, isOpenCase, parseCasesSnapshot } from "../cases/cases.ts";
import {
  parseConversationsSnapshot,
  takesHumanMessage,
} from "../conversations/state.ts";
import {
  createSavedSystemsApi,
  releaseOpeningKind,
  type SavedSystemView,
} from "../system/saved-systems.ts";
import type { Fetcher } from "../workbench/api.ts";

export interface RequestHost {
  projectId?: string;
  systemId?: string;
}
export interface IntentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
// Host locators include the canonical `git:<project UUID>` namespace. They are
// checked against the trusted endpoint, not interpreted as command identities.
const hostIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024 &&
  value.trim() === value && value !== "*" &&
  // deno-lint-ignore no-control-regex -- Host locators exclude control characters.
  !/[\u0000-\u001f\u007f]/.test(value);
const exact = (value: unknown): value is string =>
  typeof value === "string" && /^commit:[a-f0-9]{40}$/.test(value);
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Request unavailable.";

/** Selection checks only. The server alone authenticates this credential. */
export function capabilitySecretFromFile(
  text: string,
  origin: string,
  host: RequestHost,
  now = Date.now(),
): string {
  if (text.length > 4096) {
    throw new Error("Select a bounded local control file.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Select a valid local control file.");
  }
  if (
    !object(value) || Object.keys(value).sort().join(",") !==
      "capabilitySecret,credentialId,expiresAt,format,origin,projectId,systemId" ||
    value.format !== 1 || !hostIdentity(value.projectId) ||
    !hostIdentity(value.systemId) ||
    !identity(value.credentialId) || value.origin !== origin ||
    host.projectId !== undefined && value.projectId !== host.projectId ||
    host.systemId !== undefined && value.systemId !== host.systemId ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= now || !digest(value.capabilitySecret)
  ) {
    throw new Error(
      "The local control file does not match this host or has expired.",
    );
  }
  return value.capabilitySecret;
}

function command(value: unknown): value is OpeningCommand {
  if (
    !object(value) ||
    Object.keys(value).sort().join(",") !== "openingKey,source,text" ||
    !identity(value.openingKey) || typeof value.text !== "string" ||
    !value.text.trim() ||
    value.text.length > 100_000 || value.text.includes("\0") ||
    !object(value.source)
  ) return false;
  const source = value.source;
  return source.kind === "current-main" &&
      Object.keys(source).every((key) =>
        ["kind", "expectedVersion"].includes(key)
      ) &&
      (source.expectedVersion === undefined || exact(source.expectedVersion)) ||
    source.kind === "release" &&
      Object.keys(source).sort().join(",") === "digest,kind,releaseId" &&
      identity(source.releaseId) && digest(source.digest);
}

/** Independent Requests never use a Main command, store, event or fallback. */
export function createRequests(options: {
  fetch?: Fetcher;
  origin?: () => string;
  host?: () => RequestHost;
  storage?: () => IntentStorage;
  createKey?: () => string;
}) {
  const fetcher = options.fetch ?? ((path, init) => fetch(path, init));
  const origin = options.origin ?? (() => location.origin);
  const storage = options.storage ?? (() => localStorage);
  const createKey = options.createKey ?? (() => crypto.randomUUID());
  const context = signal<RequestHost | null>(options.host?.() ?? null);
  const host = () => options.host?.() ?? context.peek() ?? {};
  let contextFlight: Promise<boolean> | null = null;
  const source = signal<OpeningSourceChoice>({ kind: "current-main" });
  const releases = signal<SavedSystemView[]>([]);
  const releaseCatalogue = signal<SavedSystemView[]>([]);
  const error = signal("");
  const sessionReady = signal(false);
  const environment = signal<AssemblyEnvironment | null>(null);
  let connectionFlight: Promise<boolean> | null = null;
  let connectionError: string | null = null;
  let localSessionExpires = 0;
  const sessionGeneration = signal(0);
  const pending = signal(false);
  const selectingRelease = signal(false);
  let selectionFlight: Promise<boolean> | null = null;
  const intent = signal<OpeningCommand | null>(null);
  const opening = signal<OpeningView | null>(null);
  const scopes = signal(new Map<string, CaseModelScope>());
  const snapshots = signal(new Map<string, ConversationsSnapshot>());
  const readErrors = signal(new Map<string, string>());
  const writeErrors = signal(new Map<string, string>());
  const sending = signal<string | null>(null);
  const flights = new Map<
    string,
    { promise: Promise<void>; controller: AbortController; ordinary: boolean }
  >();
  const readers = new Map<string, { count: number }>();
  const caseReads = new Set<AbortController>();
  const scopeReads = new Map<string, number>();
  const scopeHost = () => {
    const selected = host();
    return JSON.stringify([
      selected.projectId ?? null,
      selected.systemId ?? null,
    ]);
  };
  let scopeContext = scopeHost(), scopeContextGeneration = 0;
  let disposed = false;
  let savedIntentKey: string | null = null;
  let generation = 0;
  let requestReadFence = 0;
  const requestInvalidations = new Map<string, number>();
  let snapshotHost = scopeHost();
  const clearSnapshots = () => {
    snapshots.value = new Map();
    readErrors.value = new Map();
  };
  const releaseReadFences = [
    context.subscribe(() => {
      requestReadFence++;
      const nextHost = scopeHost();
      if (nextHost !== snapshotHost) {
        snapshotHost = nextHost;
        clearSnapshots();
      }
    }),
    sessionReady.subscribe(() => {
      requestReadFence++;
    }),
    sessionGeneration.subscribe(() => {
      requestReadFence++;
      clearSnapshots();
    }),
  ];
  let releaseGeneration = 0;
  const setError = (target: typeof readErrors, id: string, value: string) => {
    target.value = new Map(target.peek()).set(id, value);
  };
  async function json(path: string, init?: RequestInit): Promise<unknown> {
    const session = sessionGeneration.peek(), selectedHost = scopeHost();
    const fence = requestReadFence;
    const response = await fetcher(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      // Error text is deliberately bounded; never echo credential payloads.
      const failure = responseError(
        response.status,
        body,
        `Request unavailable (${response.status}).`,
      );
      if (
        isSessionFailure(failure) && !disposed && !init?.signal?.aborted &&
        session === sessionGeneration.peek() && selectedHost === scopeHost() &&
        fence === requestReadFence
      ) {
        localSessionExpires = 0;
        sessionReady.value = false;
      }
      throw failure;
    }
    return body;
  }
  const post = (path: string, body: unknown) =>
    json(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const unavailable = () =>
    Promise.reject(new Error("This Request action is not connected yet."));
  /** Case reads share the same session fences and stop with this store. */
  async function readCase<T>(
    path: string,
    accept: (body: unknown) => T,
  ): Promise<T> {
    const controller = new AbortController();
    caseReads.add(controller);
    try {
      while (!disposed && !controller.signal.aborted) {
        const fence = requestReadFence, session = sessionGeneration.peek();
        const selectedHost = scopeHost();
        const currentRead = () =>
          !disposed && !controller.signal.aborted &&
          fence === requestReadFence &&
          session === sessionGeneration.peek() && selectedHost === scopeHost();
        let body: unknown;
        try {
          body = await json(path, { signal: controller.signal });
        } catch (failure) {
          if (currentRead() || disposed || !sessionReady.peek()) throw failure;
          continue;
        }
        if (currentRead()) return accept(body);
        if (!disposed && sessionReady.peek()) continue;
        throw new Error(
          "The Request session changed. Reconnect to read its Cases.",
        );
      }
      throw new Error("The Request Case reader stopped.");
    } finally {
      caseReads.delete(controller);
    }
  }
  const cases = createCases({
    port: {
      read() {
        return readCase("/api/cases?space=requests", (body) => {
          const value = parseCasesSnapshot(body);
          if (
            host().systemId && value.systemId !== host().systemId
          ) throw new Error("The Request host changed.");
          if (
            value.cases.some((entry) => entry.type !== "request")
          ) throw new Error("The Request collection received is invalid.");
          sessionReady.value = true;
          return value;
        });
      },
      readOne(id) {
        return readCase(
          `/api/cases/${encodeURIComponent(id)}?space=requests`,
          (value) => {
            if (
              !object(value) || !object(value.case) || value.case.id !== id ||
              host().systemId && value.systemId !== host().systemId
            ) throw new Error("The Request received does not match.");
            const record = parseCasesSnapshot({
              systemId: value.systemId,
              cases: [value.case],
            })
              .cases[0];
            if (!record || record.type !== "request") {
              throw new Error("The Request received is unreadable.");
            }
            return record;
          },
        );
      },
      async close(id, outcome, verdict) {
        await post(
          `/api/cases/${encodeURIComponent(id)}/close?space=requests`,
          {
            outcome,
            verdict,
          },
        );
      },
      act: unavailable,
    },
  });
  async function loadContext(): Promise<boolean> {
    if (options.host) return !!host().projectId && !!host().systemId;
    if (contextFlight) return contextFlight;
    contextFlight = (async () => {
      try {
        const value = await json("/api/request-space-openings/context");
        if (
          !object(value) ||
          Object.keys(value).sort().join(",") !== "projectId,systemId" ||
          !hostIdentity(value.projectId) || !hostIdentity(value.systemId)
        ) throw new Error("The Request host identity is unavailable.");
        const previous = context.peek();
        if (
          previous &&
          (previous.projectId !== value.projectId ||
            previous.systemId !== value.systemId)
        ) {
          sessionReady.value = false;
          throw new Error(
            "The Request host changed. Reload before continuing.",
          );
        }
        if (disposed) return false;
        context.value = {
          projectId: value.projectId,
          systemId: value.systemId,
        };
        return true;
      } catch (failure) {
        if (!disposed) error.value = message(failure);
        return false;
      }
    })();
    try {
      return await contextFlight;
    } finally {
      contextFlight = null;
    }
  }
  /** Runtime mode and cookie issuance belong to the backend. Production never
   * calls the local-development session endpoint. Concurrent views share one read. */
  async function prepareConnection(): Promise<boolean> {
    if (disposed) return false;
    if (connectionFlight) return await connectionFlight;
    connectionFlight = (async () => {
      try {
        if (environment.peek() === null) {
          const mode = parseEnvironment(await json("/api/environment"));
          if (disposed) return false;
          environment.value = mode;
        }
        if (
          environment.peek() === "development" &&
          localSessionExpires <= Date.now() + 60_000
        ) {
          const value = await post("/api/space-session/local", {});
          if (
            !object(value) || Object.keys(value).join() !== "expiresAt" ||
            typeof value.expiresAt !== "string" ||
            !Number.isFinite(Date.parse(value.expiresAt)) ||
            Date.parse(value.expiresAt) <= Date.now()
          ) {
            throw new Error("The local development session is unavailable.");
          }
          if (disposed) return false;
          localSessionExpires = Date.parse(value.expiresAt);
          sessionGeneration.value++;
        }
        const ready = await loadContext();
        if (!disposed) {
          if (!ready) connectionError = error.peek();
          else if (connectionError !== null) {
            // Retire this bootstrap's error without clearing a later action error.
            if (error.peek() === connectionError) error.value = "";
            connectionError = null;
          }
        }
        return ready;
      } catch (failure) {
        if (!disposed) {
          connectionError = message(failure);
          error.value = connectionError;
        }
        return false;
      }
    })();
    try {
      return await connectionFlight;
    } finally {
      connectionFlight = null;
    }
  }
  function intentKey() {
    const scope = host();
    if (!scope.projectId || !scope.systemId) {
      throw new Error("Wait for the host identity before opening a Request.");
    }
    return `assembly-request-opening:${origin()}:${scope.projectId}:${scope.systemId}`;
  }
  function restore() {
    if (disposed) return false;
    try {
      const key = intentKey();
      if (savedIntentKey) {
        if (savedIntentKey !== key) {
          throw new Error(
            "The Request host changed. Reload before continuing.",
          );
        }
        return true;
      }
      const raw = storage().getItem(key);
      if (raw) {
        if (raw.length > 410_000) {
          throw new Error("The saved opening intention is unreadable.");
        }
        const parsed: unknown = JSON.parse(raw);
        if (!command(parsed)) {
          throw new Error("The saved opening intention is unreadable.");
        }
        intent.value = parsed;
        source.value = structuredClone(parsed.source);
      }
      savedIntentKey = key;
      return true;
    } catch (failure) {
      error.value = message(failure);
      return false;
    }
  }
  async function connect(file: Pick<File, "size" | "text">) {
    if (pending.peek()) return false;
    pending.value = true;
    error.value = "";
    let secret = "";
    try {
      if (!await loadContext()) return false;
      if (file.size < 1 || file.size > 4096) {
        throw new Error("Select a bounded local control file (up to 4 KB).");
      }
      secret = capabilitySecretFromFile(await file.text(), origin(), host());
      // Exchange errors are fixed text: a server/network error cannot expose a secret.
      const response = await fetcher("/api/space-session/exchange", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capabilitySecret: secret }),
      });
      secret = "";
      if (!response.ok) {
        throw new Error(
          "The local control file could not establish a session.",
        );
      }
      sessionGeneration.value++;
      sessionReady.value = true;
      await cases.refresh();
      return sessionReady.peek();
    } catch {
      error.value =
        "The local control file is invalid, expired, unavailable or belongs to another host.";
      return false;
    } finally {
      secret = "";
      pending.value = false;
    }
  }
  // The Release an address asked for, until a complete catalogue read takes it.
  let wanted: string | null = null;
  async function loadReleases() {
    const epoch = ++releaseGeneration;
    const currentHost = { ...host() };
    const selectedHost = scopeHost();
    if (scopeContext !== selectedHost) {
      scopeContext = selectedHost;
      scopeContextGeneration++;
    }
    const contextEpoch = scopeContextGeneration;
    const session = sessionGeneration.peek(), ready = sessionReady.peek();
    const results = await Promise.allSettled([
      createSavedSystemsApi({ fetch: fetcher as typeof fetch }).list(),
      createSavedSystemsApi({
        fetch: fetcher as typeof fetch,
        catalogue: { kind: "owned-requests" },
      }).list(),
    ]);
    if (
      disposed || epoch !== releaseGeneration ||
      contextEpoch !== scopeContextGeneration || selectedHost !== scopeHost() ||
      session !== sessionGeneration.peek() || ready !== sessionReady.peek()
    ) return;
    const records: SavedSystemView[] = [];
    let partial = false;
    for (const result of results) {
      if (result.status === "fulfilled") records.push(...result.value);
      else {
        partial = true;
      }
    }
    const counts = new Map<string, number>();
    for (const record of records) {
      counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
    }
    releaseCatalogue.value = records.filter((entry) =>
      counts.get(entry.id) === 1 &&
      (!currentHost.projectId ||
        entry.origin.projectId === currentHost.projectId) &&
      (!currentHost.systemId || entry.origin.systemId === currentHost.systemId)
    );
    releases.value = releaseCatalogue.peek().filter((entry) =>
      releaseOpeningKind(entry) !== null
    );
    const catalogueError =
      "Some Releases could not be read in this source scope. Check the local session; the list refreshes automatically.";
    if (partial) error.value = catalogueError;
    else if (error.peek() === catalogueError) error.value = "";
    if (wanted && !partial) {
      const id = wanted;
      wanted = null;
      await selectRelease(id);
    }
  }
  function selectRelease(id: string): Promise<boolean> {
    if (selectionFlight) return selectionFlight;
    if (pending.peek() || intent.peek() || disposed) {
      return Promise.resolve(false);
    }
    const listed = releases.peek().filter((entry) => entry.id === id);
    if (listed.length !== 1 || !listed[0].source) {
      error.value = "Select an exact listed Release.";
      return Promise.resolve(false);
    }
    const selected = listed[0];
    // A first send waits for this exact selection. A failed inspection leaves
    // the previously verified choice intact and reports the refusal.
    selectingRelease.value = true;
    error.value = "";
    selectionFlight = inspectRelease(selected).finally(() => {
      selectionFlight = null;
      if (!disposed) selectingRelease.value = false;
    });
    return selectionFlight;
  }
  /** The Release a new Request should start from (named by an address): the
   * next complete catalogue read selects it once, as a person's choice is. */
  function startFrom(releaseId: string) {
    wanted = releaseId;
  }
  async function inspectRelease(selected: SavedSystemView): Promise<boolean> {
    try {
      const id = selected.id;
      const catalogue = selected.source!.branch.kind === "case"
        ? { kind: "owned-requests" as const }
        : { kind: "main" as const };
      const release = await createSavedSystemsApi({
        fetch: fetcher as typeof fetch,
        catalogue,
      }).inspect(id);
      const scope = host();
      if (disposed) return false;
      if (
        release.id !== id || release.digest !== selected.digest ||
        !releaseOpeningKind(release, true) ||
        !release.source ||
        release.source.sourceVersion !== selected.source!.sourceVersion ||
        JSON.stringify(release.source.branch) !==
          JSON.stringify(selected.source!.branch) ||
        scope.projectId && release.origin.projectId !== scope.projectId ||
        scope.systemId && release.origin.systemId !== scope.systemId ||
        release.origin.executionSpaceId !== selected.origin.executionSpaceId
      ) throw new Error("The exact Release is unavailable for this host.");
      releases.value = releases.peek().map((entry) =>
        entry.id === release.id ? release : entry
      );
      source.value = {
        kind: "release",
        releaseId: selected.id,
        digest: selected.digest!,
      };
      return true;
    } catch (failure) {
      if (!disposed) error.value = message(failure);
      return false;
    }
  }
  async function loadScope(caseId: string) {
    const selectedHost = scopeHost();
    if (scopeContext !== selectedHost) {
      scopeContext = selectedHost;
      scopeContextGeneration++;
    }
    const contextEpoch = scopeContextGeneration, lifetime = generation;
    const session = sessionGeneration.peek(), ready = sessionReady.peek();
    const read = (scopeReads.get(caseId) ?? 0) + 1;
    scopeReads.set(caseId, read);
    const current = () =>
      !disposed && lifetime === generation &&
      read === scopeReads.get(caseId) &&
      contextEpoch === scopeContextGeneration &&
      selectedHost === scopeHost() &&
      session === sessionGeneration.peek() &&
      ready === sessionReady.peek();
    try {
      const scope = await readCaseModelScope(
        caseId,
        undefined,
        fetcher as typeof fetch,
      );
      if (current()) scopes.value = new Map(scopes.peek()).set(caseId, scope);
    } catch {
      if (current()) {
        const next = new Map(scopes.peek());
        next.delete(caseId);
        scopes.value = next;
      }
    }
  }
  /** A confirmed adoption invalidates only this Case before starting its read. */
  function refreshScope(caseId: string): Promise<void> {
    scopeReads.set(caseId, (scopeReads.get(caseId) ?? 0) + 1);
    const next = new Map(scopes.peek());
    next.delete(caseId);
    scopes.value = next;
    return loadScope(caseId);
  }
  /**
   * Reads a Request's conversation. A reply from a read context that changed
   * meanwhile (session, host) never lands; the conversation is read again in
   * the new one while the session is ready, so a caller is not left without.
   */
  function refresh(caseId: string, invalidated = false): Promise<void> {
    return readConversation(caseId, invalidated, "ordinary");
  }
  function readConversation(
    caseId: string,
    invalidated: boolean,
    consumer: "held" | "ordinary",
  ): Promise<void> {
    if (disposed) return Promise.resolve();
    // A new notice can overtake an existing read; its caller waits for a fresh
    // response without starting a parallel request or losing the invalidation.
    if (invalidated) {
      requestInvalidations.set(
        caseId,
        (requestInvalidations.get(caseId) ?? 0) + 1,
      );
    }
    const flight = flights.get(caseId);
    if (flight) {
      flight.ordinary ||= consumer === "ordinary";
      return flight.promise;
    }
    const epoch = generation;
    const controller = new AbortController();
    const next = (async () => {
      // Every caller waits for the whole read, including a reply overtaken by
      // a session or host change. No caller receives the abandoned attempt.
      do {
        const fence = requestReadFence, selectedHost = scopeHost();
        const invalidation = requestInvalidations.get(caseId);
        const currentRead = () =>
          !disposed && !controller.signal.aborted && epoch === generation &&
          fence === requestReadFence &&
          selectedHost === scopeHost();
        try {
          const value = parseConversationsSnapshot(
            await json(
              `/api/conversations?${new URLSearchParams({ caseId })}`,
              {
                signal: controller.signal,
              },
            ),
          );
          if (
            value.conversations.some((agent) =>
              agent.messages.some((entry) =>
                entry.caseId !== undefined && entry.caseId !== caseId
              )
            )
          ) {
            throw new Error(
              "The Request conversation received does not match.",
            );
          }
          if (currentRead()) {
            snapshots.value = new Map(snapshots.peek()).set(caseId, value);
            setError(readErrors, caseId, "");
            if (invalidation === requestInvalidations.get(caseId)) return;
          }
        } catch (failure) {
          if (currentRead()) {
            setError(readErrors, caseId, message(failure));
            if (invalidation === requestInvalidations.get(caseId)) return;
          }
        }
      } while (
        !disposed && !controller.signal.aborted && epoch === generation &&
        sessionReady.peek()
      );
    })().finally(() => {
      if (flights.get(caseId)?.promise === next) flights.delete(caseId);
    });
    flights.set(caseId, {
      promise: next,
      controller,
      ordinary: consumer === "ordinary",
    });
    return next;
  }
  /** Holds a useful conversation independently of its historical cache. */
  function retain(caseId: string): () => void {
    if (disposed) return () => {};
    let reader = readers.get(caseId);
    if (reader) reader.count++;
    else {
      reader = { count: 1 };
      readers.set(caseId, reader);
      if (sessionReady.peek()) void readConversation(caseId, true, "held");
    }
    let released = false;
    return () => {
      if (released || readers.get(caseId) !== reader) return;
      released = true;
      if (--reader.count > 0) return;
      readers.delete(caseId);
      const flight = flights.get(caseId);
      if (flight && !flight.ordinary) {
        flight.controller.abort();
        flights.delete(caseId);
      }
    };
  }
  /** Advisory identities trigger authorized reads, never a new selection. */
  async function invalidateConversation(caseId: string): Promise<void> {
    if (disposed || !sessionReady.peek()) return;
    await Promise.all([
      cases.byId(caseId) ? cases.refreshOne(caseId) : cases.refresh(),
      ...(readers.has(caseId) ? [readConversation(caseId, true, "held")] : []),
    ]);
  }
  /** A stream opening recovers missed changes for held conversations only. */
  async function reconcile(): Promise<void> {
    if (disposed || !sessionReady.peek()) return;
    await Promise.all([
      cases.refresh(),
      ...[...readers.keys()].map((caseId) =>
        readConversation(caseId, true, "held")
      ),
    ]);
  }
  async function open(text: string): Promise<string | null> {
    if (pending.peek() || !sessionReady.peek() || disposed) return null;
    if (!restore()) return null;
    if (selectionFlight && !await selectionFlight) return null;
    if (pending.peek() || !sessionReady.peek() || disposed) return null;
    pending.value = true;
    error.value = "";
    try {
      const key = intentKey();
      const existing = intent.peek();
      if (
        existing &&
        (existing.text !== text.trim() ||
          JSON.stringify(existing.source) !== JSON.stringify(source.peek()))
      ) {
        throw new Error(
          "Retry the saved opening first. Its message and source stay fixed until the host acknowledges it.",
        );
      }
      const next = existing ??
        {
          openingKey: createKey(),
          text: text.trim(),
          source: structuredClone(source.peek()),
        };
      if (!command(next)) {
        throw new Error(
          "Select current Main or an exact Release and enter a bounded request.",
        );
      }
      // Persist before the first network byte. A failed write prevents the command.
      storage().setItem(key, JSON.stringify(next));
      savedIntentKey = key;
      intent.value = next;
      const value = await post("/api/request-space-openings/open", next);
      if (
        !object(value) || !identity(value.caseId) || !identity(value.id) ||
        !identity(value.branchId) ||
        !identity(value.executionSpaceId) ||
        !identity(value.initialContributionId) ||
        !Number.isSafeInteger(value.caseNumber) ||
        Number(value.caseNumber) < 1 || !Number.isSafeInteger(value.revision) ||
        Number(value.revision) < 0 ||
        ![
          "allocated",
          "source-selected",
          "branch-ready",
          "runtime-ready",
          "admitted",
          "dispatched",
        ].includes(String(value.phase)) ||
        value.admissionId !== null && !identity(value.admissionId) ||
        (value.phase === "admitted" || value.phase === "dispatched") &&
          !identity(value.admissionId) ||
        value.sourceVersion !== null && !exact(value.sourceVersion) ||
        !Array.isArray(value.issues) || value.issues.some((entry) =>
          typeof entry !== "string"
        )
      ) {
        throw new Error(
          "The opening acknowledgement is unreadable; retry this same intention.",
        );
      }
      if (
        value.phase === "dispatched" && !exact(value.sourceVersion) ||
        next.source.kind === "release" &&
          (value.release !== null || value.phase === "dispatched") &&
          (!object(value.release) ||
            value.release.id !== next.source.releaseId ||
            value.release.digest !== next.source.digest) ||
        next.source.kind === "current-main" && value.release !== null
      ) {
        throw new Error(
          "The opening source acknowledgement does not match; retry the saved intention.",
        );
      }
      opening.value = value as unknown as OpeningView;
      // Only the complete durable ACK retires the retry command. Earlier phases
      // remain recoverable after a reload and are never treated as an empty Case.
      if (value.phase !== "dispatched") {
        error.value =
          "The opening is pending. Retry this same intention to continue it.";
        return null;
      }
      storage().removeItem(key);
      intent.value = null;
      await Promise.all([
        cases.refresh(),
        cases.ensure(value.caseId),
        refresh(value.caseId),
        loadScope(value.caseId),
      ]);
      return value.caseId;
    } catch (failure) {
      error.value = message(failure);
      return null;
    } finally {
      pending.value = false;
    }
  }
  function conversation(
    caseId: string,
    agentId?: string | null,
  ): AgentConversation | null {
    const value = snapshots.value.get(caseId);
    if (!value) return null;
    return value.conversations.find((agent) =>
      agent.agentId === (agentId ?? value.defaultAgentId)
    ) ?? null;
  }
  function targetCanSend(
    caseId: string,
    agent: AgentConversation | null,
  ): boolean {
    const record = cases.byId(caseId);
    return !!record && isOpenCase(record) && !!agent &&
      agent === conversation(caseId, agent.agentId) &&
      agent.nativeId === record.owner && takesHumanMessage(agent, caseId) &&
      !agent.busy && sessionReady.value &&
      !readErrors.value.get(caseId);
  }
  function canSend(caseId: string, agent: AgentConversation | null): boolean {
    return sending.value === null && targetCanSend(caseId, agent);
  }
  async function send(
    caseId: string,
    agent: AgentConversation,
    text: string,
  ): Promise<boolean> {
    if (!canSend(caseId, agent) || !text.trim() || text.length > 100_000) {
      return false;
    }
    sending.value = caseId;
    setError(writeErrors, caseId, "");
    const submittedIdentity = JSON.stringify([
      snapshots.peek().get(caseId)?.systemId,
      agent.nativeId,
    ]);
    try {
      const value = await retryOnceAfterStale(
        (target: AgentConversation = agent) =>
          post(
            `/api/conversations/${
              encodeURIComponent(target.nativeId)
            }/messages?space=requests`,
            {
              caseId,
              text: text.trim(),
              expectedRevision: target.revision,
            },
          ),
        async () => {
          // Finish an older read before starting the post-refusal read.
          const activeRead = flights.get(caseId);
          if (activeRead) {
            activeRead.ordinary = true;
            await activeRead.promise;
          }
          const beforeRead = snapshots.peek().get(caseId);
          await refresh(caseId);
          const reloaded = snapshots.peek().get(caseId);
          const fresh = conversation(caseId, agent.agentId);
          return reloaded !== beforeRead &&
              JSON.stringify([reloaded?.systemId, fresh?.nativeId]) ===
                submittedIdentity &&
              targetCanSend(caseId, fresh)
            ? fresh
            : null;
        },
      );
      if (
        !object(value) || value.accepted !== true || value.caseId !== caseId
      ) {
        throw new Error(
          "The contribution acknowledgement is unavailable. Refresh before deciding whether to send again.",
        );
      }
      await refresh(caseId);
      return true;
    } catch (failure) {
      const detail = sendErrorMessage(failure, "Request unavailable.");
      setError(
        writeErrors,
        caseId,
        isStaleConversation(failure)
          ? detail
          : `${detail} Refresh before deciding whether to send again; the contribution may have been accepted.`,
      );
      await refresh(caseId);
      return false;
    } finally {
      sending.value = null;
    }
  }
  return {
    cases,
    context,
    source,
    releases,
    releaseCatalogue,
    sessionReady,
    environment,
    sessionGeneration,
    pending,
    selectingRelease,
    intent,
    opening,
    scopes,
    snapshots,
    readErrors,
    writeErrors,
    sending,
    error,
    loadContext,
    prepareConnection,
    restore,
    connect,
    loadReleases,
    selectRelease,
    startFrom,
    loadScope,
    refreshScope,
    refresh,
    retain,
    invalidateConversation,
    reconcile,
    open,
    send,
    canSend,
    conversation,
    dispose() {
      disposed = true;
      for (const release of releaseReadFences) release();
      generation++;
      releaseGeneration++;
      readers.clear();
      for (const controller of caseReads) controller.abort();
      caseReads.clear();
      for (const flight of flights.values()) flight.controller.abort();
      flights.clear();
      cases.dispose();
      snapshots.value = new Map();
    },
  };
}
