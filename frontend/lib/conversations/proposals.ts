import { computed, signal } from "@preact/signals";
import type {
  SourceProposal,
  SourceRevisions,
} from "../model/revisions/api.ts";
import {
  createDecisionLock,
  type DecisionLock,
} from "../model/sources/command.ts";

export interface ProposalDifference {
  id: string;
  label: string;
  before: string;
  after: string;
}
export interface ProposalPreview {
  proposalId: string;
  agentId: string;
  baseVersion: string;
  proposalVersion: string;
  expectedVersion: string;
  sourceDigest: string;
  stale: boolean;
  completeness: boolean;
  rows: ProposalDifference[];
  sourceChanges: Array<{
    path: string;
    kind: "added" | "changed" | "deleted";
    before?: string;
    after?: string;
  }>;
  sourceDiff?: {
    patch: string;
    files: {
      path: string;
      kind: string;
      additions: number;
      deletions: number;
    }[];
    additions: number;
    deletions: number;
  };
}
export function proposalOwner(
  proposal: Pick<SourceProposal, "author" | "authorization">,
): string | undefined {
  const authorization = proposal.authorization;
  if (!authorization || authorization.kind === "local-owner") return undefined;
  return proposal.author === `agent:${authorization.operatorNativeId}`
    ? authorization.operatorNativeId
    : undefined;
}
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const sameVersion = (a: string, b: string) =>
  a.replace(/^(commit|branch):/, "") === b.replace(/^(commit|branch):/, "");

export function createChatProposalApi(
  request: (path: string, init?: RequestInit) => Promise<Response> = fetch,
) {
  async function read<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await request(path, { cache: "no-store", ...init });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "Action not confirmed.");
    return value as T;
  }
  const write = (path: string, value: unknown) =>
    read<unknown>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  return {
    read: (agentId: string, signal?: AbortSignal) =>
      read<SourceRevisions>(
        `/api/model-revisions?${new URLSearchParams({ agentId })}`,
        { signal },
      ),
    preview: (id: string, agentId: string, signal?: AbortSignal) =>
      read<ProposalPreview>(
        `/api/model-revisions/${
          encodeURIComponent(id)
        }/preview?${new URLSearchParams({ agentId })}`,
        { signal },
      ),
    decide: (id: string, decision: {
      verdict: "approve" | "refuse";
      expectedVersion: string;
      sourceDigest: string;
      reason?: string;
    }) =>
      write(
        `/api/model-revisions/${encodeURIComponent(id)}/decision`,
        decision,
      ),
    adopt: (agentId: string, expectedDigest: string, expectedVersion: string) =>
      write("/api/model-version/adopt", {
        agentId,
        expectedDigest,
        expectedVersion,
      }),
  };
}
export type ChatProposalApi = ReturnType<typeof createChatProposalApi>;

/**
 * The one rule behind every decision, refusal and activation button, in a
 * conversation or in Evolution: a settled, error-free read made at the current
 * source generation, with writes allowed and no other decision in flight.
 */
export function canActOnRead(read: {
  canWrite: boolean;
  pending: boolean;
  generation: number;
  readGeneration: number | null;
  loading: boolean;
  error: string;
}): boolean {
  return read.canWrite && !read.pending && read.loading === false &&
    !read.error && read.readGeneration === read.generation;
}

/**
 * Whether no operator is running. The host refuses to put the accepted model in
 * service for an operator that is, so every control that offers it stays shut
 * meanwhile: the activation in a conversation and "Put in service" on the
 * Revisions page both read this one rule.
 */
export function operatorsIdle(
  operators: readonly { busy?: boolean }[] = [],
): boolean {
  return !operators.some((operator) => operator.busy);
}

/**
 * Proposals per conversation under one shared generation. Any successful
 * decision or adoption, from a conversation or from Evolution, advances the
 * generation; every read is tagged with the generation it started in, and a
 * read overtaken by a newer generation is discarded and made again. A thread
 * whose read is from an older generation, still loading or failed is shown but
 * never decidable: `canAct` is the one predicate behind every decision button.
 * A thread is a read scope, never an inferred decision authority.
 */
export function createChatProposals(options: {
  api: ChatProposalApi;
  systemId(): string | null;
  canWrite(): boolean;
  canAdopt?(): boolean;
  afterChange(): Promise<void>;
  /** Shared with every other decision command of the workbench. */
  lock?: DecisionLock;
}) {
  const lock = options.lock ?? createDecisionLock();
  const generation = signal(0);
  const loaded = signal(
    new Map<
      string,
      { systemId: string; generation: number; data: SourceRevisions }
    >(),
  );
  const loadingAgents = signal(new Set<string>());
  const errors = signal(new Map<string, string>());
  const pending = signal("");
  /** A decision or adoption is in flight anywhere: no panel may act. */
  const inFlight = computed(() => Boolean(pending.value) || lock.held.value);
  const previews = signal(new Map<string, ProposalPreview>());
  const previewErrors = signal(new Map<string, string>());
  // A newer read for the same agent supersedes and aborts the older one only.
  const reads = new Map<string, AbortController>();
  let lifecycle = 0;
  const previewFlights = new Map<string, Promise<void>>();
  function setLoading(agentId: string, value: boolean) {
    const next = new Set(loadingAgents.peek());
    if (value) next.add(agentId);
    else next.delete(agentId);
    loadingAgents.value = next;
  }
  function setError(agentId: string, message: string) {
    const next = new Map(errors.peek());
    if (message) next.set(agentId, message);
    else next.delete(agentId);
    errors.value = next;
  }
  function visible(agentId: string) {
    const value = loaded.value.get(agentId);
    return value?.systemId === options.systemId() ? value.data : null;
  }
  function loadingFor(agentId: string) {
    return loadingAgents.value.has(agentId);
  }
  function errorFor(agentId: string) {
    return errors.value.get(agentId) ?? "";
  }
  /** Shown proposals read before the latest decision anywhere. */
  function isStale(agentId: string) {
    const value = loaded.value.get(agentId);
    return !value || value.generation !== generation.value;
  }
  /** The one predicate behind every decision and activation in a thread. */
  function canAct(agentId: string) {
    const value = loaded.value.get(agentId);
    return Boolean(visible(agentId)) && canActOnRead({
      canWrite: options.canWrite(),
      pending: inFlight.value,
      generation: generation.value,
      readGeneration: value?.generation ?? null,
      loading: loadingFor(agentId),
      error: errorFor(agentId),
    });
  }
  async function refresh(agentId: string) {
    const systemId = options.systemId();
    if (!systemId) return;
    reads.get(agentId)?.abort();
    const read = new AbortController();
    reads.set(agentId, read);
    const requestLifecycle = lifecycle;
    const current = () =>
      requestLifecycle === lifecycle && reads.get(agentId) === read &&
      systemId === options.systemId();
    setLoading(agentId, true);
    try {
      for (;;) {
        const tagged = generation.peek();
        const data = await options.api.read(agentId, read.signal);
        if (!current()) return;
        // A decision landed while this read was in flight: read again.
        if (tagged !== generation.peek()) continue;
        if (data.agentId !== agentId) {
          throw new Error(
            "The proposals received belong to another agent.",
          );
        }
        loaded.value = new Map(loaded.peek()).set(agentId, {
          systemId,
          generation: tagged,
          data,
        });
        setError(agentId, "");
        return;
      }
    } catch (cause) {
      if (current()) setError(agentId, messageOf(cause));
    } finally {
      if (requestLifecycle === lifecycle && reads.get(agentId) === read) {
        setLoading(agentId, false);
      }
    }
  }
  /**
   * The shared sources changed (a decision or adoption, wherever it was made):
   * advance the generation and reread every thread already shown. Reads still
   * in flight notice the new generation themselves and read again.
   */
  function invalidate(): Promise<void> {
    generation.value++;
    return rereadAll();
  }
  function rereadAll(): Promise<void> {
    return Promise.all([...loaded.peek().keys()].map(refresh)).then(() => {});
  }
  /** Holds the shared lock while a change made elsewhere settles. */
  function track<T>(change: () => Promise<T>): Promise<T> {
    return lock.track(change);
  }
  const previewKey = (
    proposal: SourceProposal,
    agentId: string,
    version: string,
  ) =>
    JSON.stringify([
      options.systemId(),
      agentId,
      proposal.id,
      proposal.sourceDigest,
      version,
    ]);
  function preview(proposal: SourceProposal, agentId: string) {
    const data = visible(agentId);
    return data
      ? previews.value.get(previewKey(proposal, agentId, data.version))
      : undefined;
  }
  function previewError(proposal: SourceProposal, agentId: string) {
    const data = visible(agentId);
    return data
      ? previewErrors.value.get(previewKey(proposal, agentId, data.version))
      : undefined;
  }
  function loadPreview(
    proposal: SourceProposal,
    agentId: string,
  ): Promise<void> {
    const data = visible(agentId);
    if (
      !data || proposalOwner(proposal) !== agentId || !proposal.proposalVersion
    ) return Promise.resolve();
    const key = previewKey(proposal, agentId, data.version);
    if (previews.peek().has(key)) return Promise.resolve();
    if (previewFlights.has(key)) return previewFlights.get(key)!;
    const systemId = options.systemId();
    const flight = (async () => {
      try {
        const value = await options.api.preview(proposal.id, agentId);
        if (systemId !== options.systemId()) return;
        if (
          value.agentId !== agentId || value.proposalId !== proposal.id ||
          value.sourceDigest !== proposal.sourceDigest ||
          !sameVersion(value.proposalVersion, proposal.proposalVersion!) ||
          !sameVersion(value.baseVersion, proposal.baseVersion) ||
          !sameVersion(value.expectedVersion, data.version)
        ) {
          throw new Error(
            "The proposal changed. Refresh to read it again.",
          );
        }
        previews.value = new Map(previews.peek()).set(key, value);
        const errors = new Map(previewErrors.peek());
        errors.delete(key);
        previewErrors.value = errors;
      } catch (cause) {
        if (systemId === options.systemId()) {
          previewErrors.value = new Map(previewErrors.peek()).set(
            key,
            messageOf(cause),
          );
        }
      }
    })().finally(() => previewFlights.delete(key));
    previewFlights.set(key, flight);
    return flight;
  }
  function canDecide(
    proposal: SourceProposal,
    agentId: string,
    verdict: "approve" | "refuse",
  ) {
    const data = visible(agentId);
    const exact = data?.proposals.find((entry) => entry.id === proposal.id);
    const comparison = preview(proposal, agentId);
    return Boolean(
      canAct(agentId) &&
        exact?.authorization?.kind !== "operator-evolution" &&
        exact?.status === "proposed" &&
        exact.sourceDigest === proposal.sourceDigest &&
        proposalOwner(exact) === agentId &&
        (verdict === "refuse" || comparison && !comparison.stale),
    );
  }
  async function decide(
    proposal: SourceProposal,
    agentId: string,
    verdict: "approve" | "refuse",
    reason?: string,
  ) {
    if (!canDecide(proposal, agentId, verdict)) return false;
    const data = visible(agentId)!;
    pending.value = proposal.id;
    setError(agentId, "");
    let failure = "";
    try {
      await options.api.decide(proposal.id, {
        verdict,
        expectedVersion: data.version,
        sourceDigest: proposal.sourceDigest,
        ...(reason ? { reason } : {}),
      });
      // Confirmed: every earlier read is stale now, before any reread.
      generation.value++;
      await options.afterChange();
      return true;
    } catch (cause) {
      failure = messageOf(cause);
      return false;
    } finally {
      if (failure) await refresh(agentId);
      else await rereadAll();
      if (failure) setError(agentId, failure);
      pending.value = "";
    }
  }
  /** Activation of the accepted version: the shared predicate, then runtime facts. */
  function canAdopt(agentId: string) {
    const data = visible(agentId);
    const available = data?.runtime.available;
    return Boolean(
      canAct(agentId) && options.canAdopt?.() !== false &&
        data?.runtime.executable && available?.repositoryVersion &&
        available.digest !== data.runtime.active?.digest,
    );
  }
  async function adopt(agentId: string) {
    if (!canAdopt(agentId)) return false;
    const available = visible(agentId)!.runtime.available!;
    pending.value = "adopt";
    let failure = "";
    try {
      await options.api.adopt(
        agentId,
        available.digest,
        available.repositoryVersion!,
      );
      generation.value++;
      await options.afterChange();
      return true;
    } catch (cause) {
      failure = messageOf(cause);
      return false;
    } finally {
      if (failure) await refresh(agentId);
      else await rereadAll();
      if (failure) setError(agentId, failure);
      pending.value = "";
    }
  }
  function dispose() {
    lifecycle++;
    for (const read of reads.values()) read.abort();
    reads.clear();
    loaded.value = new Map();
    loadingAgents.value = new Set();
    errors.value = new Map();
  }
  return {
    pending,
    inFlight,
    track,
    visible,
    generation,
    loadingFor,
    errorFor,
    isStale,
    canAct,
    canAdopt,
    invalidate,
    refresh,
    preview,
    previewError,
    loadPreview,
    canDecide,
    decide,
    adopt,
    dispose,
  };
}
