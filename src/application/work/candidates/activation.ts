import type { ClockPort } from "../runtime/ports.ts";
import type {
  NativeExecutionPort,
  NativeExecutionSnapshot,
} from "../native-execution/contract.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  activationFailure,
  CandidateActivationError,
  hasActivationIntent,
  MAX_ACTIVATION_ATTEMPTS,
  requireActivation,
} from "../../../domain/work/policies/candidate-activation.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  Candidate,
  ExecutableCatalogEntry,
  ModelBinding,
} from "../../../domain/work/records/candidates.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import type { CandidateModelPort } from "./ports/out/candidate-model.port.ts";
import { draftDigest, errorText, makeEvent } from "../runtime/values.ts";
import {
  applySiblingCatalogRefresh,
  prepareSiblingCatalogRefresh,
} from "./sibling-refresh.ts";

/** Why an admitted activation is being driven; only the events differ. */
type ActivationTrigger = "admission" | "retry" | "restart" | "abandon";

type ActivationOutcome =
  /** Published and adopted: the candidate is `active`. */
  | { status: "active" }
  /** A transient failure: the intent is kept for the next trigger. */
  | { status: "interrupted"; error: unknown }
  /** A terminal failure: the candidate is `failed` and the intent is gone. */
  | { status: "failed"; code: string; error: unknown };

export interface CandidateActivationHost {
  readonly state: SystemRuntimeState;
  readonly ports: {
    clock: ClockPort;
    execution?: NativeExecutionPort;
    model: CandidateModelPort;
  };
  update(
    change: (state: SystemRuntimeState) => void,
    when?: (state: SystemRuntimeState) => boolean,
  ): Promise<void>;
  /** Host-owned Case reservation for a new delegated publication only. */
  withCandidatePublication?<T>(
    candidate: Candidate,
    publish: () => Promise<T>,
  ): Promise<T>;
}

export interface ActivationResumeHost extends CandidateActivationHost {
  feedback(text: string): Promise<void>;
}

/** Exact active catalog entries of the candidate, whatever their binding. */
function publishedEntries(
  native: ExecutableModel,
  candidate: Candidate,
): ExecutableCatalogEntry[] {
  return native.catalog.filter((entry) =>
    entry.candidateId === candidate.id && entry.digest === candidate.digest &&
    entry.kind === candidate.kind && entry.name === candidate.name &&
    entry.status === "active" && native.contracts.filter((contract) =>
        contract.nativeId === entry.contractId &&
        contract.kind === candidate.kind
      ).length === 1
  );
}

function holdsIntent(host: CandidateActivationHost, id: string): boolean {
  const candidate = host.state.candidates.find((c) => c.id === id);
  return candidate !== undefined && hasActivationIntent(candidate);
}

function intentOf(host: CandidateActivationHost, id: string): Candidate {
  const candidate = host.state.candidates.find((c) => c.id === id);
  if (!candidate || !hasActivationIntent(candidate)) throw noActivation();
  return candidate;
}

function noActivation(): Error {
  return new Error("Aucune activation admise à reprendre pour ce candidat.");
}

/** Publications made so far for the admitted activation. */
function attemptsMade(host: CandidateActivationHost, id: string): number {
  return host.state.candidates.find((c) => c.id === id)?.activationAttempts ??
    0;
}

/** What another driver already settled: the candidate is `active`, or failed
 * with a code. Without an intent and without such an exit there is nothing to
 * report. */
function settledOutcome(
  host: CandidateActivationHost,
  id: string,
): ActivationOutcome | undefined {
  const candidate = host.state.candidates.find((c) => c.id === id);
  if (candidate?.stage === "active") return { status: "active" };
  if (candidate?.stage === "failed" && candidate.errorCode !== undefined) {
    return {
      status: "failed",
      code: candidate.errorCode,
      error: new Error(candidate.error ?? candidate.errorCode),
    };
  }
  return undefined;
}

/** A write found the intent gone. Report what the record now says instead of
 * claiming a result nobody stored. */
function intentGone(
  host: CandidateActivationHost,
  id: string,
): ActivationOutcome {
  return settledOutcome(host, id) ?? {
    status: "interrupted",
    error: new Error(
      "L’activation admise n’est plus en cours pour ce candidat.",
    ),
  };
}

/** Write only while the candidate still holds its intent, and say whether the
 * write was applied: a skipped write is never a success. */
async function writeWhileAdmitted(
  host: CandidateActivationHost,
  id: string,
  change: (candidate: Candidate, state: SystemRuntimeState) => void,
): Promise<boolean> {
  let applied = false;
  await host.update(
    (s) => change(s.candidates.find((c) => c.id === id)!, s),
    (s) =>
      applied = s.candidates.some((c) => c.id === id && hasActivationIntent(c)),
  );
  return applied;
}

/** Activation drivers waiting on one candidate, per runtime. A publication is
 * slow (a Toolkit process) while Cases are closed and contributions arrive
 * meanwhile: every driver of a candidate waits for the one already running, so
 * no exit is decided on a state the running one is about to change. */
const drivers = new WeakMap<object, Map<string, Promise<void>>>();

function exclusively<T>(
  host: CandidateActivationHost,
  id: string,
  drive: () => Promise<T>,
): Promise<T> {
  let queue = drivers.get(host.ports);
  if (!queue) drivers.set(host.ports, queue = new Map());
  const waiting = queue;
  const run = (waiting.get(id) ?? Promise.resolve()).then(drive);
  const tail = run.then(() => {}, () => {});
  waiting.set(id, tail);
  void tail.then(() => {
    if (waiting.get(id) === tail) waiting.delete(id);
  });
  return run;
}

/** The candidate is still exactly what was tested, reviewed and admitted. */
async function assertAdmittedCandidate(candidate: Candidate): Promise<void> {
  const context = { candidateId: candidate.id };
  requireActivation(
    await draftDigest(candidate) === candidate.digest,
    "CANDIDATE_CHANGED",
    context,
    "Le candidat a changé depuis son admission.",
  );
  requireActivation(
    candidate.tests?.passed === true,
    "TESTS_NOT_PASSED",
    context,
    "Le candidat n’a pas d’essais réussis.",
  );
  requireActivation(
    candidate.admission?.candidateId === candidate.id &&
      candidate.admission.candidateDigest === candidate.digest,
    "ADMISSION_CANDIDATE_MISMATCH",
    context,
    "L’admission ne vise plus le candidat exact.",
  );
}

/** A new publication only runs under the contract and catalog base admitted. */
function assertPublishable(
  host: CandidateActivationHost,
  candidate: Candidate,
  native: ExecutableModel,
): void {
  const admitted = host.state.executionModel?.version.digest;
  requireActivation(
    candidate.activationModelDigest === admitted &&
      native.version.digest === admitted,
    "ADMITTED_MODEL_CHANGED",
    {
      candidateId: candidate.id,
      admittedDigest: candidate.activationModelDigest ?? "",
      currentDigest: native.version.digest,
    },
    "Le contrat admis n’est plus celui du modèle natif.",
  );
  requireActivation(
    candidate.baseCatalogRevision === host.state.catalogRevision,
    "CATALOG_BASE_CHANGED",
    {
      candidateId: candidate.id,
      baseRevision: candidate.baseCatalogRevision,
      catalogRevision: host.state.catalogRevision,
    },
    "Le catalogue a changé depuis la proposition du candidat.",
  );
}

/** Persist the exit of an admitted activation: the candidate is `active`. */
async function adopt(
  host: CandidateActivationHost,
  id: string,
  binding: ModelBinding,
  native: ExecutableModel,
  trigger: ActivationTrigger,
): Promise<boolean> {
  const current = host.state.candidates.find((candidate) =>
    candidate.id === id
  );
  const refresh = current && hasActivationIntent(current)
    ? await prepareSiblingCatalogRefresh(
      host.state,
      current,
      native,
      await host.ports.execution?.inspect(native.identity.builderId) ?? [],
    )
    : undefined;
  return await writeWhileAdmitted(host, id, (c, s) => {
    c.binding = binding;
    c.stage = "active";
    delete c.activationModelDigest;
    delete c.activationAttempts;
    delete c.error;
    delete c.errorCode;
    delete c.promotionCursor;
    delete c.promotionContext;
    s.catalogRevision++;
    applySiblingCatalogRefresh(host.ports.clock, s, refresh);
    if (s.executionModel?.version.digest === native.version.digest) {
      s.executionModel = structuredClone(native);
    }
    s.events.push(
      makeEvent(
        host.ports.clock,
        "tool-active",
        trigger === "admission"
          ? `${c.name} est maintenant disponible`
          : trigger === "restart"
          ? `${c.name} : activation reprise après redémarrage`
          : trigger === "retry"
          ? `${c.name} : activation reprise`
          : `${c.name} : activation constatée au catalogue natif`,
        c,
      ),
    );
  });
}

/** A terminal refusal ends the admission: the native catalog was read first
 * and holds no exact active entry, so nothing was published. */
function fail(
  host: CandidateActivationHost,
  id: string,
  code: string,
  error: unknown,
): Promise<boolean> {
  return writeWhileAdmitted(host, id, (c, s) => {
    c.stage = "failed";
    delete c.activationModelDigest;
    delete c.activationAttempts;
    delete c.promotionCursor;
    delete c.promotionContext;
    c.error = errorText(error);
    c.errorCode = code;
    s.events.push({
      ...makeEvent(host.ports.clock, "tool-failed", c.error, c),
      code,
    });
  });
}

async function interrupt(
  host: CandidateActivationHost,
  id: string,
  error: unknown,
  trigger: ActivationTrigger,
): Promise<ActivationOutcome> {
  const kept = await writeWhileAdmitted(host, id, (c, s) => {
    c.error = errorText(error);
    if (trigger === "retry") {
      s.events.push(
        makeEvent(host.ports.clock, "tool-activation-interrupted", c.error, c),
      );
    }
  });
  return kept ? { status: "interrupted", error } : intentGone(host, id);
}

/** Terminal rule shared by every exit: the native catalog decides. An exact
 * active entry is adopted whatever the refusal, otherwise the admission ends. */
async function settleTerminal(
  host: CandidateActivationHost,
  id: string,
  error: unknown,
  code: string,
  trigger: ActivationTrigger,
): Promise<ActivationOutcome> {
  let native: ExecutableModel | undefined;
  let binding: ModelBinding | undefined;
  let failure: { code: string; error: unknown } = { code, error };
  try {
    native = await host.ports.model.readExecutableModel(host.state.model!);
    const candidate = intentOf(host, id);
    const entries = publishedEntries(native, candidate);
    requireActivation(
      entries.length <= 1,
      "CANDIDATE_AMBIGUOUS",
      { candidateId: id, count: entries.length },
      "Plusieurs entrées natives actives portent ce candidat.",
    );
    if (entries.length === 1) {
      try {
        await assertAdmittedCandidate(candidate);
        // The catalog entry was matched exactly above: the binding lookup only
        // supplies the graph path, so its failure never keeps the intent alive.
        binding = await host.ports.model.findCandidate?.(
          host.state.model!,
          structuredClone(candidate),
        ).catch(() => null) ??
          { elementId: entries[0]!.nativeId, graphPath: "" };
      } catch (refusal) {
        // An entry that no longer matches the admitted candidate is not adopted.
        if (!(refusal instanceof CandidateActivationError)) throw refusal;
        failure = { code: refusal.code, error: refusal };
      }
    }
  } catch (readFailure) {
    if (readFailure instanceof CandidateActivationError) {
      failure = { code: readFailure.code, error: readFailure };
      binding = undefined;
    } else {
      // The catalog cannot be read now: the intent stays until it can.
      return await interrupt(host, id, readFailure, trigger);
    }
  }
  if (binding) {
    return await adopt(host, id, binding, native!, trigger)
      ? { status: "active" }
      : intentGone(host, id);
  }
  return await fail(host, id, failure.code, failure.error)
    ? { status: "failed", code: failure.code, error: failure.error }
    : intentGone(host, id);
}

/** One bounded attempt that publishes (idempotently) and adopts the candidate.
 * Only a publication actually requested of the port counts as an attempt: a
 * catalog that cannot be read, or an admission that no longer holds, never
 * consumes the budget of a publication that was not tried. */
async function publishAttempt(
  host: CandidateActivationHost,
  id: string,
  trigger: ActivationTrigger,
): Promise<ActivationOutcome> {
  const candidate = intentOf(host, id);
  const native = await host.ports.model.readExecutableModel(host.state.model!);
  const published = publishedEntries(native, candidate);
  requireActivation(
    published.length <= 1,
    "CANDIDATE_AMBIGUOUS",
    { candidateId: id, count: published.length },
    "Plusieurs entrées natives actives portent ce candidat.",
  );
  await assertAdmittedCandidate(candidate);
  // An exact publication is already the effect: reconciliation must not call
  // the writer again or count another publication, even with a settled receipt.
  if (published.length === 1) {
    const binding = await host.ports.model.findCandidate?.(
      host.state.model!,
      structuredClone(candidate),
    ).catch(() => null) ?? { elementId: published[0]!.nativeId, graphPath: "" };
    requireActivation(
      binding.elementId === published[0]!.nativeId,
      "ACTIVATION_NOT_VERIFIED",
      { candidateId: id, elementId: binding.elementId },
      "The native binding does not identify the exact published candidate",
    );
    return await adopt(host, id, binding, native, trigger)
      ? { status: "active" }
      : intentGone(host, id);
  }
  // Only a new publication depends on the admitted catalog base.
  assertPublishable(host, candidate, native);
  const delegatedPublication = published.length === 0 &&
    candidate.admission?.authority === "delegate";
  if (delegatedPublication) {
    requireActivation(
      host.withCandidatePublication,
      "ADMISSION_AUTHORITY_INVALID",
      { candidateId: id },
      "A new delegated publication requires the host's Case reservation",
    );
  }
  const publish = async () => {
    const counted = await writeWhileAdmitted(host, id, (c) => {
      c.activationAttempts = (c.activationAttempts ?? 0) + 1;
    });
    if (!counted) return undefined;
    return await host.ports.model.activateCandidate(
      host.state.model!,
      structuredClone(intentOf(host, id)),
      candidate.activationModelDigest!,
    );
  };
  const binding = delegatedPublication
    ? await host.withCandidatePublication!(candidate, publish)
    : await publish();
  if (!binding) return intentGone(host, id);
  const after = await host.ports.model.readExecutableModel(host.state.model!);
  requireActivation(
    publishedEntries(after, candidate).filter((entry) =>
      entry.nativeId === binding.elementId
    ).length === 1,
    "ACTIVATION_NOT_VERIFIED",
    { candidateId: id, elementId: binding.elementId },
    "L’activation native du candidat exact n’a pas été vérifiée.",
  );
  return await adopt(host, id, binding, after, trigger)
    ? { status: "active" }
    : intentGone(host, id);
}

/** A generic driver is not the native effect owner. An unknown owned effect
 * permits catalog reconciliation only, never a second publication or a terminal
 * conclusion inferred from an empty catalog. The first admission runs inside
 * its own native action and is deliberately outside this recovery guard. */
async function nativeRecoveryBlocked(
  host: CandidateActivationHost,
  candidate: Candidate,
): Promise<boolean> {
  const promotion = candidate.promotionExecution;
  const transfer = candidate.initialAdmissionTransfer;
  if (!promotion && !transfer) return !!candidate.admissionContinuation;
  if (!host.ports.execution) return true;
  let executions: NativeExecutionSnapshot[];
  try {
    executions = await host.ports.execution.inspect(
      host.state.executionModel!.identity.builderId,
    );
  } catch {
    // An unavailable native journal cannot authorize a new publication either.
    return true;
  }
  const owners = executions.filter((snapshot) => {
    if (transfer) {
      return canonical(snapshot.identity) ===
          canonical(transfer.target.identity) &&
        snapshot.modelDigest === transfer.pin.modelDigest;
    }
    const scope = snapshot.identity.scope;
    return snapshot.identity.purpose === "promotion" &&
      snapshot.identity.subjectId === promotion!.subjectId &&
      snapshot.modelDigest === promotion!.modelDigest &&
      (!promotion!.threadId || snapshot.threadId === promotion!.threadId) &&
      (candidate.caseId
        ? scope.kind === "request" && scope.scopeId === candidate.caseId
        : scope.kind === "designer" &&
          scope.scopeId === candidate.designerScopeId);
  });
  // A missing/ambiguous owner is not evidence that its effect never ran.
  return owners.length !== 1 ||
    owners.some((snapshot) =>
      ["uncertain", "running", "advancing"].includes(snapshot.status) ||
      snapshot.unsettledEffects.length > 0 ||
      !!snapshot.openImmutableConsultationGroups?.length
    );
}

async function reconcileUnknownActivation(
  host: CandidateActivationHost,
  id: string,
  trigger: ActivationTrigger,
): Promise<ActivationOutcome> {
  const error = new Error(
    "The native activation effect is unresolved; automatic publication is refused",
  );
  try {
    const candidate = intentOf(host, id);
    const native = await host.ports.model.readExecutableModel(
      host.state.model!,
    );
    const entries = publishedEntries(native, candidate);
    if (entries.length !== 1) return { status: "interrupted", error };
    await assertAdmittedCandidate(candidate);
    const found = await host.ports.model.findCandidate?.(
      host.state.model!,
      structuredClone(candidate),
    ).catch(() => null);
    if (found && found.elementId !== entries[0]!.nativeId) {
      return { status: "interrupted", error };
    }
    const binding = found ?? { elementId: entries[0]!.nativeId, graphPath: "" };
    return await adopt(host, id, binding, native, trigger)
      ? { status: "active" }
      : intentGone(host, id);
  } catch (readFailure) {
    return { status: "interrupted", error: readFailure };
  }
}

/** The settlement itself, run alone on its candidate. */
async function drive(
  host: CandidateActivationHost,
  id: string,
  trigger: ActivationTrigger,
): Promise<ActivationOutcome> {
  if (!holdsIntent(host, id)) {
    // Another driver may have settled the candidate while this one waited.
    const settled = settledOutcome(host, id);
    if (settled) return settled;
    throw noActivation();
  }
  if (
    trigger !== "admission" &&
    await nativeRecoveryBlocked(host, intentOf(host, id))
  ) {
    return await reconcileUnknownActivation(host, id, trigger);
  }
  if (trigger === "abandon") {
    return await settleTerminal(
      host,
      id,
      new CandidateActivationError(
        "CASE_ABANDONED",
        { candidateId: id },
        "Le Case a été abandonné avant la fin de l’activation.",
      ),
      "CASE_ABANDONED",
      trigger,
    );
  }
  const exhausted = (error?: unknown) =>
    new CandidateActivationError(
      "ACTIVATION_RETRIES_EXHAUSTED",
      { candidateId: id, attempts: attemptsMade(host, id) },
      `Activation abandonnée après ${MAX_ACTIVATION_ATTEMPTS} tentatives${
        error ? ` : ${errorText(error)}` : ""
      }.`,
    );
  if (attemptsMade(host, id) >= MAX_ACTIVATION_ATTEMPTS) {
    return await settleTerminal(
      host,
      id,
      exhausted(),
      "ACTIVATION_RETRIES_EXHAUSTED",
      trigger,
    );
  }
  try {
    return await publishAttempt(host, id, trigger);
  } catch (error) {
    const failure = activationFailure(error);
    if (
      !failure.terminal && attemptsMade(host, id) < MAX_ACTIVATION_ATTEMPTS
    ) {
      return await interrupt(host, id, error, trigger);
    }
    if (!failure.terminal) {
      return await settleTerminal(
        host,
        id,
        exhausted(error),
        "ACTIVATION_RETRIES_EXHAUSTED",
        trigger,
      );
    }
    return await settleTerminal(host, id, error, failure.code, trigger);
  }
}

/** Drive an admitted activation to an exit. It is retryable while the failure
 * is transient and bounded; any other failure reads the native catalog and
 * either adopts the exact active entry or ends the admission as failed.
 * `abandon` never publishes: it only reads the catalog. Drivers of one
 * candidate run one at a time, whatever Case or contribution started them. */
export function settleActivation(
  this: CandidateActivationHost,
  id: string,
  trigger: ActivationTrigger,
): Promise<ActivationOutcome> {
  return exclusively(this, id, () => drive(this, id, trigger));
}

/** Retry every interrupted admitted activation without restarting the process. */
export async function resumeActivations(
  this: ActivationResumeHost,
): Promise<void> {
  for (
    const candidate of this.state.candidates.filter(hasActivationIntent)
  ) {
    // Its accepted decision delivery and native effect receipts own recovery;
    // the generic publication driver must not replay an unknown native effect.
    if (
      candidate.initialAdmissionTransfer ||
      Object.values(this.state.initialToolsPreparations ?? {}).some((intent) =>
        intent.phase === "pending" && intent.caseId === candidate.caseId &&
        intent.seedId === candidate.initialToolSeed?.id
      ) ||
      !holdsIntent(this, candidate.id)
    ) continue;
    const outcome = await settleActivation.call(this, candidate.id, "retry");
    if (outcome.status === "active") {
      await this.feedback(
        `Tool admis et ACTIF après reprise de son activation : id=${candidate.id}, nom=${candidate.name}.`,
      );
    } else if (outcome.status === "failed") {
      await this.feedback(
        `Activation refusée [${outcome.code}] pour ${candidate.name} : ${
          errorText(outcome.error)
        }`,
      );
    }
  }
}

/** Explicit abandon of a Case ends its admitted activations by the terminal
 * rule. A catalog that cannot be read leaves the Case open instead. */
export async function settleCaseActivations(
  this: CandidateActivationHost,
  caseId: string,
): Promise<void> {
  for (
    const candidate of this.state.candidates.filter((c) =>
      c.caseId === caseId && hasActivationIntent(c)
    )
  ) {
    if (!holdsIntent(this, candidate.id)) continue;
    const outcome = await settleActivation.call(this, candidate.id, "abandon");
    if (outcome.status === "interrupted") throw outcome.error;
  }
}
