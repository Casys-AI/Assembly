import { computed, type ReadonlySignal, signal } from "@preact/signals";
import { canActOnRead, operatorsIdle } from "../../conversations/proposals.ts";
import { operatorName } from "./change.ts";
import {
  type CodedProblem,
  type createRevisionApi,
  problemOf,
  resolveRevision,
  retainInspectedCommit,
  RevisionRequestError,
  type RevisionSelection,
  type RevisionSnapshot,
  type RuntimeAdoption,
  runtimeAdoption,
  type RuntimeOperator,
  selectedRevision,
  type SourceDiff,
  type SourceProposal,
  type SourceRevisions,
} from "./api.ts";
import type { OperatorRun } from "./rows.ts";
import { runSourceCommand, type SharedSources } from "../sources/command.ts";

/**
 * The history of the model as the Revisions page reads it: main's commits, the
 * proposals, the changes each one makes, what each operator has in service, the
 * decision on a proposal and putting the accepted model in service. It reads
 * through the revision API and acts through the shared source state, so a
 * decision or an adoption made here, in a conversation or on another page is
 * one change in flight for all of them.
 */

export type RevisionApi = ReturnType<typeof createRevisionApi>;

/** What went wrong, for a program to act on; `message` is for the person. */
export type ProblemCode =
  | "read-failed"
  | "diff-failed"
  | "runtime-failed"
  | "decision-unavailable"
  | "decision-busy"
  | "decision-conflict"
  | "decision-failed"
  | "adoption-unavailable"
  | "adoption-busy"
  | "adoption-operator-busy"
  | "adoption-conflict"
  | "adoption-failed";

export type HistoryProblem = CodedProblem<ProblemCode>;

const messages: Record<ProblemCode, string> = {
  "read-failed": "The history could not be read.",
  "diff-failed": "The changes could not be read.",
  "runtime-failed": "What is in service could not be read.",
  "decision-unavailable": "This proposal cannot be decided now.",
  "decision-busy": "Another decision is being recorded.",
  "decision-conflict":
    "The decision was refused. The history was read again; review it before deciding again.",
  "decision-failed":
    "The decision may not have been recorded. The history was read again; review it before deciding again.",
  "adoption-unavailable": "The model cannot be put in service now.",
  "adoption-busy": "Another change is being recorded.",
  "adoption-operator-busy":
    "An operator is running. Try again when it has finished.",
  "adoption-conflict":
    "Putting the model in service was refused. The history was read again; review it before trying again.",
  "adoption-failed":
    "The model may not have been put in service. The history was read again; review it before trying again.",
};

const problem = (code: ProblemCode, failure?: unknown): HistoryProblem =>
  problemOf(code, messages[code], failure);

/** The changes a revision makes, as far as they are read. */
export type DiffState =
  | { status: "loading" }
  | { status: "ready"; diff: SourceDiff }
  | { status: "failed"; problem: HistoryProblem };

/** What an operator has in service, as its runtime answered, or why it did not. */
export type OperatorRuntime =
  | {
    operator: RuntimeOperator;
    state: "ready";
    runtime: SourceRevisions["runtime"];
  }
  | { operator: RuntimeOperator; state: "failed"; problem: HistoryProblem };

/** An operator whose runtime is behind the model, and what puts it in service. */
export interface AdoptionOffer {
  operator: RuntimeOperator;
  adoption: RuntimeAdoption;
}

/**
 * The operators the accepted model can be put in service for: those whose
 * runtime holds a different executable contract from the one available. The
 * primary operator comes first, then the roster's order.
 */
export function adoptionOffers(
  runtimes: readonly OperatorRuntime[],
): AdoptionOffer[] {
  const offers = runtimes.flatMap((entry): AdoptionOffer[] => {
    const adoption = entry.state === "ready"
      ? runtimeAdoption(entry.operator.nativeId, entry.runtime)
      : undefined;
    return adoption ? [{ operator: entry.operator, adoption }] : [];
  });
  return [
    ...offers.filter((offer) => offer.operator.primary),
    ...offers.filter((offer) => !offer.operator.primary),
  ];
}

/** The version an operator runs, for the operators whose runtime was read. */
export function runningVersions(
  runtimes: readonly OperatorRuntime[],
): OperatorRun[] {
  return runtimes.flatMap((entry) =>
    entry.state === "ready"
      ? [{
        name: entry.operator.name,
        version: entry.runtime.active?.repositoryVersion,
      }]
      : []
  );
}

export type DecisionVerdict = "approve" | "refuse";
/** How a decision or an adoption ended: sent and confirmed, or why it was not. */
export type CommandOutcome =
  | { ok: true }
  | { ok: false; problem: HistoryProblem };

/** The longest history the host lists. */
export const LONGEST_HISTORY = 200;

/** Diffs of two fixed versions never change; this many stay at hand. */
const KEPT_DIFFS = 32;
const diffKey = (base: string, target: string) => `${base}\n${target}`;

export interface ModelHistory {
  /** The last coherent read, kept while the next one is made. */
  readonly snapshot: ReadonlySignal<RevisionSnapshot | undefined>;
  readonly reading: ReadonlySignal<boolean>;
  /** Why the last read failed, if it did. */
  readonly problem: ReadonlySignal<HistoryProblem | null>;
  /**
   * What each operator has in service, read with the history and published
   * with it; in the order of the roster.
   */
  readonly runtimes: ReadonlySignal<readonly OperatorRuntime[]>;
  /** The operators the accepted model can be put in service for. */
  readonly offers: ReadonlySignal<readonly AdoptionOffer[]>;
  /** The proposal whose decision is in flight. */
  readonly deciding: ReadonlySignal<string | null>;
  /** Why the last decision attempted was not recorded, and for which proposal. */
  readonly refusal: ReadonlySignal<
    { id: string; problem: HistoryProblem } | null
  >;
  /** The operator whose adoption is in flight. */
  readonly adopting: ReadonlySignal<string | null>;
  /**
   * Why the last adoption attempted was not recorded, and for which operator
   * (`operator` is the name the roster gives it). It is dropped when a read
   * shows that operator is no longer offered the model: nothing is left to try.
   */
  readonly adoptionRefusal: ReadonlySignal<
    { agentId: string; operator?: string; problem: HistoryProblem } | null
  >;
  /** A settled read at the current generation, and no change in flight. */
  readonly canAct: ReadonlySignal<boolean>;
  /** Reads the history again; reads asked for while one runs share its end. */
  refresh(): Promise<void>;
  /** Drops the read in flight, as a page does when the address moves. */
  cancel(): void;
  /** What the change from `base` to `target` is, once read. */
  diff(base: string, target: string): DiffState | undefined;
  /** Reads that change unless it is read or being read. */
  readDiff(base: string, target: string): Promise<void>;
  /** Accepts or declines a proposal, against the head the page examined. */
  decide(
    proposal: SourceProposal,
    verdict: DecisionVerdict,
  ): Promise<CommandOutcome>;
  /**
   * Like `decide`, for the proposal of this identity as the last read lists it;
   * one it does not list is refused as unavailable.
   */
  decideById(id: string, verdict: DecisionVerdict): Promise<CommandOutcome>;
  /**
   * Puts the accepted model in service for one operator, against the contract
   * and version its runtime was read to hold.
   */
  adopt(agentId: string): Promise<CommandOutcome>;
  /** Nothing is stored or sent after this. */
  dispose(): void;
}

export function createModelHistory(options: {
  api: RevisionApi;
  sources: SharedSources;
  /** The revision the address names: a read keeps it in the list. */
  selection(): RevisionSelection | undefined;
  /** The model's sources changed: the other views read again. */
  onChanged(): void | Promise<void>;
  /**
   * The operators that can have the model in service: each is asked what its
   * runtime holds whenever the history is read. None when absent.
   */
  operators?(): readonly RuntimeOperator[];
}): ModelHistory {
  const { api, sources } = options;
  const snapshot = signal<RevisionSnapshot | undefined>();
  const runtimes = signal<readonly OperatorRuntime[]>([]);
  const offers = computed(() => adoptionOffers(runtimes.value));
  const readGeneration = signal<number | null>(null);
  const reading = signal(false);
  const readProblem = signal<HistoryProblem | null>(null);
  const deciding = signal<string | null>(null);
  const refusal = signal<{ id: string; problem: HistoryProblem } | null>(null);
  const adopting = signal<string | null>(null);
  const adoptionRefusal = signal<
    { agentId: string; operator?: string; problem: HistoryProblem } | null
  >(null);
  const diffs = signal<ReadonlyMap<string, DiffState>>(new Map());
  let disposed = false;
  let flight: Promise<void> | undefined;
  let again = false;
  let current: AbortController | undefined;
  const lifetime = new AbortController();

  const canAct = computed(() =>
    canActOnRead({
      canWrite: true,
      pending: deciding.value !== null || adopting.value !== null ||
        sources.inFlight.value,
      generation: sources.generation.value,
      readGeneration: readGeneration.value,
      loading: reading.value,
      error: readProblem.value?.code ?? "",
    })
  );

  /**
   * What each operator's runtime holds at the history just read. The operator
   * the history itself answers for already has it there; the others are asked.
   * One that cannot be read is told as such: the history and the others stand.
   */
  function readRuntimes(
    read: RevisionSnapshot,
    signal: AbortSignal,
  ): Promise<OperatorRuntime[]> {
    return Promise.all((options.operators?.() ?? []).map(
      async (operator): Promise<OperatorRuntime> => {
        try {
          const runtime = read.revisions.agentId === operator.nativeId
            ? read.revisions.runtime
            : (await api.runtime(operator.nativeId, signal)).runtime;
          return { operator, state: "ready", runtime };
        } catch (failure) {
          return {
            operator,
            state: "failed",
            problem: problem("runtime-failed", failure),
          };
        }
      },
    ));
  }

  /**
   * The history at the host's default length. A commit the address names that
   * it lacks may only be older than that reaches: unless the page already holds
   * it, or it is the version of a proposal, the history is read once more at the
   * longest the host lists.
   */
  async function readSnapshot(signal: AbortSignal): Promise<RevisionSnapshot> {
    const recent = await api.snapshot(signal);
    const named = options.selection();
    if (named?.kind !== "commit" || !recent.history.truncated) return recent;
    const held = retainInspectedCommit(recent, snapshot.peek(), named);
    const sought = resolveRevision(held, named);
    if (sought.kind !== "commit" || selectedRevision(held, sought)) {
      return recent;
    }
    try {
      return await api.snapshot(signal, { limit: LONGEST_HISTORY });
    } catch {
      // The look further back is a courtesy: the history just read stands.
      return recent;
    }
  }

  async function readOnce(): Promise<void> {
    const read = current = new AbortController();
    // Tagged with the generation it starts in: a read overtaken by a decision
    // anywhere is discarded whole, and made again.
    const tagged = sources.generation.peek();
    const overtaken = () => {
      if (tagged === sources.generation.peek()) return false;
      again = true;
      return true;
    };
    try {
      const next = await readSnapshot(read.signal);
      if (read.signal.aborted || disposed) return;
      if (overtaken()) return;
      const held = await readRuntimes(next, read.signal);
      if (read.signal.aborted || disposed) return;
      if (overtaken()) return;
      // Published together: the versions and what runs them agree.
      snapshot.value = retainInspectedCommit(
        next,
        snapshot.peek(),
        options.selection(),
      );
      runtimes.value = held;
      // A refusal about an operator the model is no longer offered to is told
      // for the last time: another session may have put it in service.
      const refused = adoptionRefusal.peek();
      if (
        refused &&
        !offers.peek().some((offer) =>
          offer.operator.nativeId === refused.agentId
        )
      ) adoptionRefusal.value = null;
      readGeneration.value = tagged;
      readProblem.value = null;
    } catch (failure) {
      if (!read.signal.aborted && !disposed) {
        readProblem.value = problem("read-failed", failure);
      }
    }
  }

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (flight) {
      // The read in flight may predate this call: it reads once more.
      again = true;
      return flight;
    }
    reading.value = true;
    flight = (async () => {
      try {
        do {
          again = false;
          await readOnce();
        } while (again && !disposed);
      } finally {
        // Nothing awaits between the last check and this: no call is lost.
        flight = undefined;
        reading.value = false;
      }
    })();
    return flight;
  }

  function setDiff(key: string, state: DiffState) {
    const next = new Map(diffs.peek());
    next.delete(key);
    next.set(key, state);
    while (next.size > KEPT_DIFFS) next.delete(next.keys().next().value!);
    diffs.value = next;
  }

  async function readDiff(base: string, target: string): Promise<void> {
    const key = diffKey(base, target);
    const known = diffs.peek().get(key);
    if (disposed || known && known.status !== "failed") return;
    setDiff(key, { status: "loading" });
    try {
      const diff = await api.diff(base, target, lifetime.signal);
      if (!disposed) setDiff(key, { status: "ready", diff });
    } catch (failure) {
      if (!disposed) {
        setDiff(key, {
          status: "failed",
          problem: problem("diff-failed", failure),
        });
      }
    }
  }

  /** A change not even attempted: the page's controls do not offer it. */
  const denied = (code: ProblemCode): CommandOutcome => ({
    ok: false,
    problem: problem(code),
  });
  /** No operator is running: the host refuses to put the model in service. */
  const idle = () => operatorsIdle(options.operators?.());
  /** Whether a change is in flight, here or in any other panel. */
  const busy = () =>
    deciding.peek() !== null || adopting.peek() !== null ||
    sources.inFlight.peek();

  /**
   * One change sent from this page: confirmed, it advances the generation,
   * reads the history again and tells the other views. A change that fails
   * reads what the host holds now, whatever the failure: a refusal as stale
   * (409) says the page was behind, and an answer that never came does not say
   * whether the host applied it. Whatever refused it is handed to `refused`, to
   * be told on its subject; `codes.conflict` is a function when a 409 can mean
   * more than one thing.
   */
  async function send(
    operation: () => Promise<unknown>,
    codes: {
      busy: ProblemCode;
      conflict: ProblemCode | (() => ProblemCode);
      failed: ProblemCode;
    },
    refused: (why: HistoryProblem) => void,
  ): Promise<CommandOutcome> {
    try {
      const sent = await runSourceCommand(sources, {
        operation,
        reread: refresh,
        changed: options.onChanged,
      });
      return sent ? { ok: true } : denied(codes.busy);
    } catch (failure) {
      void refresh();
      const conflict = failure instanceof RevisionRequestError &&
        failure.status === 409;
      const why = problem(
        !conflict
          ? codes.failed
          : typeof codes.conflict === "function"
          ? codes.conflict()
          : codes.conflict,
        failure,
      );
      refused(why);
      return { ok: false, problem: why };
    }
  }

  async function decide(
    proposal: SourceProposal,
    verdict: DecisionVerdict,
  ): Promise<CommandOutcome> {
    const examined = snapshot.peek();
    if (disposed) return denied("decision-unavailable");
    if (busy()) return denied("decision-busy");
    if (
      !examined || proposal.status !== "proposed" || !canAct.peek() ||
      proposal.authorization?.kind === "operator-evolution" ||
      examined.revisions.proposals.find((entry) => entry.id === proposal.id)
          ?.authorization?.kind === "operator-evolution"
    ) {
      return denied("decision-unavailable");
    }
    refusal.value = null;
    deciding.value = proposal.id;
    try {
      return await send(
        () =>
          api.decide({
            id: proposal.id,
            verdict,
            // The head and the sources the person examined: the host refuses
            // the decision when either has moved.
            expectedVersion: examined.revisions.version,
            sourceDigest: proposal.sourceDigest,
          }),
        {
          busy: "decision-busy",
          conflict: "decision-conflict",
          failed: "decision-failed",
        },
        (why) => refusal.value = { id: proposal.id, problem: why },
      );
    } finally {
      deciding.value = null;
    }
  }

  function decideById(
    id: string,
    verdict: DecisionVerdict,
  ): Promise<CommandOutcome> {
    const proposal = snapshot.peek()?.revisions.proposals.find((entry) =>
      entry.id === id
    );
    return proposal
      ? decide(proposal, verdict)
      : Promise.resolve(denied("decision-unavailable"));
  }

  async function adopt(agentId: string): Promise<CommandOutcome> {
    if (disposed) return denied("adoption-unavailable");
    if (busy()) return denied("adoption-busy");
    if (!idle()) return denied("adoption-operator-busy");
    const offer = offers.peek().find((entry) =>
      entry.operator.nativeId === agentId
    );
    if (!offer || !canAct.peek()) return denied("adoption-unavailable");
    adoptionRefusal.value = null;
    adopting.value = agentId;
    try {
      const { expectedDigest, expectedVersion } = offer.adoption;
      const operator = operatorName(options.operators?.(), agentId);
      return await send(
        // The contract and version the runtime was read to hold: the host
        // refuses the adoption when either has moved.
        () => api.adopt(expectedDigest, { expectedVersion, agentId }),
        {
          busy: "adoption-busy",
          // The host also answers 409 while the operator runs, which the
          // roster knows: the history is not stale then.
          conflict: () =>
            idle() ? "adoption-conflict" : "adoption-operator-busy",
          failed: "adoption-failed",
        },
        (why) =>
          adoptionRefusal.value = {
            agentId,
            ...(operator ? { operator } : {}),
            problem: why,
          },
      );
    } finally {
      adopting.value = null;
    }
  }

  return {
    snapshot,
    reading,
    problem: readProblem,
    runtimes,
    offers,
    deciding,
    refusal,
    adopting,
    adoptionRefusal,
    canAct,
    refresh,
    cancel: () => current?.abort(),
    diff: (base, target) => diffs.value.get(diffKey(base, target)),
    readDiff,
    decide,
    decideById,
    adopt,
    dispose() {
      disposed = true;
      current?.abort();
      lifetime.abort();
    },
  };
}
