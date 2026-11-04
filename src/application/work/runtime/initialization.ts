import type { OpeningRecord } from "../../../domain/work/request-spaces.ts";
import {
  assertContinuationCases,
  caseBudgetPolicy,
  closeCaseById,
  createRequestCase,
  currentCase,
  delegatedCaseContext,
  designerExecutionContext,
  legacyPendingDossier,
  migrateCases,
} from "../cases/runtime.ts";
import {
  isOpenCase,
  MAX_CASE_OBJECTIVE_CHARS,
} from "../../../domain/work/entities/cases.ts";
import { truncateText } from "../context/separation.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import { ownerAuthorityFor } from "../../../domain/governance/authority.ts";
import {
  type RuntimeProvenanceRecord,
  runtimeProvenanceRecord,
  unknownRuntimeProvenance,
} from "../../../domain/work/value-objects/runtime-provenance.ts";
import type { Stage } from "../../../domain/work/candidates.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import {
  budgetState,
  type WorkBudgetView,
} from "../../../domain/work/policies/budget.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { validateBudgetCeilingTransition } from "./budget-transition.ts";
import type { RuntimeProvenancePort } from "./provenance.ts";
import type { AgentPort, ClockPort, ModelPort, StorePort } from "./ports.ts";
import type { CaseNumberPort } from "../cases/ports/out/case-number.port.ts";
import type { WorkBudgetPort } from "../budget/ports.ts";
import { errorText, makeEvent } from "./values.ts";
import { hasActivationIntent } from "../../../domain/work/policies/candidate-activation.ts";
import { settleActivation } from "../candidates/activation.ts";
import { abandonCaseCandidates } from "../candidates/case-candidates.ts";
import {
  completeScheduledExecution,
  materializeScheduledCases,
  missingScheduledTypes,
} from "../cases/scheduling.ts";

/** Initialization uses the facade's state slots and its ordinary mutation queue. */
export interface RuntimeInitializationHost {
  state: SystemRuntimeState;
  runtimeProvenance?: RuntimeProvenanceRecord;
  runtimeRecorded: boolean;
  stage(id: string, stage: Stage, label: string): Promise<void>;
  readonly ports: {
    agents: Pick<AgentPort, "label">;
    clock: ClockPort;
    caseNumbers: CaseNumberPort;
    model: Pick<
      ModelPort,
      | "initialize"
      | "readExecutableModel"
      | "findCandidate"
      | "activateCandidate"
    >;
    store: Pick<StorePort, "load" | "save">;
    workBudget?: WorkBudgetPort;
    runtimeProvenance?: RuntimeProvenancePort;
  };
  update(
    change: (state: SystemRuntimeState) => void,
    when?: (state: SystemRuntimeState) => boolean,
    initializing?: boolean,
  ): Promise<void>;
}

interface InitializationContext {
  admitted: ExecutableModel;
  saved: SystemRuntimeState | null;
  native: ExecutableModel | undefined;
  unavailable: string | undefined;
  initialBudget: WorkBudgetView | undefined;
}

function applyInitialization(
  this: RuntimeInitializationHost,
  s: SystemRuntimeState,
  { admitted, saved, native, unavailable, initialBudget }:
    InitializationContext,
): void {
  const { digest, provenance } = this.runtimeProvenance!;
  s.ownerAuthority = structuredClone(ownerAuthorityFor(admitted));
  s.runtime = {
    digest,
    ...(provenance.complete === undefined
      ? {}
      : { complete: provenance.complete }),
    ...(provenance.incompleteReasons === undefined
      ? {}
      : { incompleteReasons: [...provenance.incompleteReasons] }),
  };
  if (!this.runtimeRecorded) {
    s.events.push({
      ...makeEvent(
        this.ports.clock,
        "runtime-started",
        "Provenance du logiciel d’exécution",
      ),
      runtimeProvenance: structuredClone(this.runtimeProvenance!),
      ownerAuthority: structuredClone(s.ownerAuthority),
    });
  }
  if (initialBudget) {
    s.workBudget = initialBudget;
    if (
      !delegatedCaseContext(s) &&
      s.caseInvocation?.kind !== "delegated-designer"
    ) {
      delete s.caseBudgetPending;
      s.workBudgetBinding = {
        budgetId: initialBudget.budgetId,
        scopeId: initialBudget.scopeId,
      };
      if (s.caseInvocation?.kind === "designer") {
        s.designer!.budget = structuredClone(s.workBudgetBinding);
      }
    }
  }
  s.model = structuredClone(admitted.identity);
  s.executionModel = structuredClone(admitted);
  s.availableExecutionModel = native &&
      native.version.digest !== admitted.version.digest
    ? native
    : undefined;
  s.configuration = {
    ...structuredClone(admitted.configuration),
    changes: structuredClone(saved?.configuration?.changes ?? []),
  };
  s.busy = false;
  s.provider = this.ports.agents.label;
  s.phase = s.budgetSuspension
    ? "Budget : contrôle local attendu"
    : unavailable
    ? "Source native indisponible : exécution suspendue"
    : s.availableExecutionModel
    ? "Nouvelle version du modèle : admission attendue"
    : "Prêt à discuter";
  if (unavailable) {
    s.error = `Le contrat admis est conservé sans exécution : ${unavailable}`;
  }
  for (const c of s.candidates) {
    // A persisted admission intent may finish its idempotent publication below.
    if (hasActivationIntent(c)) continue;
    // The shared abandonment path settles interrupted initialization cases.
    if (
      s.cases?.some((record) =>
        record.id === c.caseId &&
        record.openedFrom.origin === "initialization" &&
        isOpenCase(record)
      )
    ) continue;
    if (
      c.promotionExecution ||
      c.promotionCursor && s.budgetSuspension?.candidateId === c.id
    ) {
      continue;
    }
    if (
      !["active", "refused", "failed", "awaiting-admission"].includes(
        c.stage,
      )
    ) {
      c.stage = "failed";
      c.error =
        "Construction interrompue par le redémarrage ; aucune activation automatique.";
      delete c.promotionCursor;
      delete c.promotionContext;
    }
  }
  // No greeting: a Request starts with the person's own request.
}

export async function initialize(
  this: RuntimeInitializationHost,
  admittedInitialModel?: ExecutableModel,
  options: {
    deferDelegatedCandidateActivations?: boolean;
    deferActivationEffects?: boolean;
    /** The identity a new state is born with, when its host names one (a
     * Request-space member); otherwise a fresh one. */
    runtimeId?: string;
  } = {},
): Promise<void> {
  const saved = await this.ports.store.load();
  if (!this.ports.model.readExecutableModel) {
    throw new Error("Le backend ne fournit pas de modèle exécutable natif.");
  }
  // Reopening an admitted session must not mutate HEAD, which may already
  // contain a separately accepted removal or rename awaiting adoption.
  const pinned = saved?.executionModel ?? admittedInitialModel;
  const identity = pinned?.identity ??
    await this.ports.model.initialize(saved?.model);
  let native: ExecutableModel | undefined;
  let unavailable: string | undefined;
  try {
    native = await this.ports.model.readExecutableModel(identity);
  } catch (error) {
    if (!pinned) throw error;
    unavailable = error instanceof Error ? error.message : String(error);
  }
  if (admittedInitialModel) {
    for (
      const field of [
        "projectId",
        "rootId",
        "systemId",
        "catalogId",
        "builderId",
      ] as const
    ) {
      if (
        admittedInitialModel.identity[field] !== identity[field] ||
        native &&
          admittedInitialModel.identity[field] !== native.identity[field]
      ) {
        throw new Error(
          `Le contrat initial appartient à une autre portée : ${field}.`,
        );
      }
    }
    if (!admittedInitialModel.version.repositoryVersion) {
      throw new Error(
        "Le contrat initial doit identifier sa version source immuable.",
      );
    }
  }
  const admitted = pinned ?? native!;
  this.runtimeProvenance ??= structuredClone(
    await (this.ports.runtimeProvenance?.collect() ??
      runtimeProvenanceRecord(unknownRuntimeProvenance())),
  );
  this.state = saved ?? {
    id: options.runtimeId ?? crypto.randomUUID(),
    revision: 0,
    catalogRevision: 0,
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "Initialisation du modèle",
    provider: this.ports.agents.label,
    // The first durable state must survive a crash before ordinary recovery.
    // Its admission is already exact; reopening must never reconstruct it at HEAD.
    model: structuredClone(admitted.identity),
    executionModel: structuredClone(admitted),
  };
  if (!saved) await this.ports.store.save(this.state, null);
  // Reconstruct historical requests before consulting their existing ledger.
  // An empty new runtime has no invocation and therefore no budget scope.
  this.state.model = structuredClone(admitted.identity);
  this.state.executionModel = structuredClone(admitted);
  const migrationNumber = legacyPendingDossier(this.state)
    ? await this.ports.caseNumbers.allocate()
    : undefined;
  migrateCases(this.state, this.ports.clock, migrationNumber);
  // A crashed trigger is recorded once; its already-advanced deadline is kept.
  completeScheduledExecution(
    this.state,
    "abandoned",
    "Runtime restarted during execution",
  );
  const scheduledNumbers: number[] = [];
  for (const _type of missingScheduledTypes(this.state, admitted)) {
    scheduledNumbers.push(await this.ports.caseNumbers.allocate());
  }
  materializeScheduledCases(
    this.state,
    admitted,
    scheduledNumbers,
    this.ports.clock,
  );
  assertContinuationCases(this.state);
  // Ordinary interrupted preparation has no resumable owner. A persisted exact
  // admission transfer does own its separate control Case across process restarts.
  const abandonedInitializationIds = (this.state.cases ?? []).filter((record) =>
    record.openedFrom.origin === "initialization" && isOpenCase(record) &&
    !Object.values(this.state.initialToolsPreparations ?? {}).some((intent) =>
      intent.phase === "pending" && intent.caseId === record.id
    ) &&
    !this.state.candidates.some((candidate) =>
      candidate.initialAdmissionTransfer?.target.caseId === record.id &&
      canonical(candidate.admissionDecision) ===
        canonical(candidate.initialAdmissionTransfer.decision)
    )
  ).map((record) => record.id);
  let initialBudget: Awaited<ReturnType<WorkBudgetPort["snapshot"]>>;
  const betweenCases = !currentCase(this.state) &&
    !delegatedCaseContext(this.state) && !designerExecutionContext(this.state);
  const ceiling = this.state.budgetCeilingTransition;
  const recoveringCeiling = ceiling?.phase === "authorized-intent" ||
    ceiling?.phase === "budget-policy";
  if (recoveringCeiling && ceiling) {
    // Its policy CAS and canonical admission are separate durable phases. An
    // exact own policy event can therefore precede the still-admitted source
    // policy. Replaying the ordinary snapshot(oldPolicy) would overwrite the
    // immutable exhausted refusal as an unrelated unavailable-budget failure.
    const budget = this.ports.workBudget;
    if (
      !budget?.readRecord ||
      canonical({ identity: admitted.identity, version: admitted.version }) !==
        canonical(ceiling.manifest.from)
    ) {
      throw new Error(
        "BUDGET_CEILING_RECOVERY_REFUSED: exact source admission or ledger reader is unavailable",
      );
    }
    const record = await budget.readRecord(
      ceiling.manifest.budget.scopeId,
      ceiling.manifest.budget.ownerId,
    );
    await validateBudgetCeilingTransition(this.state, record);
    if (
      ceiling.phase === "budget-policy" &&
      record.revision !== ceiling.manifest.budget.originRevision + 1
    ) {
      throw new Error(
        "BUDGET_CEILING_RECOVERY_REFUSED: committed policy phase has no exact linked ledger event",
      );
    }
    initialBudget = budgetState(record).view;
  } else {
    try {
      const delegated = delegatedCaseContext(this.state);
      const designer = designerExecutionContext(this.state);
      const delegatedDesigner =
        this.state.caseInvocation?.kind === "delegated-designer";
      const caseRecord = currentCase(this.state);
      const policy = designer
        ? designer.policy
        : delegated
        ? delegated.budget?.policy
        : caseBudgetPolicy(
          admitted,
          caseRecord?.caseTypeId,
        );
      if (
        saved?.executionModel &&
        (designer
          ? designer.policy
          : caseBudgetPolicy(saved.executionModel, caseRecord?.caseTypeId)) &&
        !this.state.workBudgetBinding && !betweenCases && !delegated &&
        !delegatedDesigner
      ) {
        throw new Error("La liaison durable du budget admis est absente.");
      }
      if (policy && !this.ports.workBudget && !betweenCases) {
        throw new Error("Le budget natif exige son registre durable.");
      }
      initialBudget = betweenCases
        ? undefined
        : delegatedDesigner
        ? await this.ports.workBudget?.snapshot(
          designer!.scopeId,
          designer!.ownerId,
          policy,
        )
        : delegated
        ? await this.ports.workBudget?.snapshot(
          delegated.budget?.scopeId ?? delegated.caseId,
          delegated.budget?.ownerId ?? admitted.identity.builderId,
          policy,
        )
        : this.state.workBudgetBinding && !this.state.caseBudgetPending
        ? await this.ports.workBudget?.snapshot(
          this.state.workBudgetBinding.scopeId,
          admitted.identity.builderId,
          policy,
        )
        : await this.ports.workBudget?.adopt({
          // Only a pre-existing legacy request may retain its historical scope.
          scopeId: this.state.workBudgetBinding?.scopeId ?? designer?.scopeId ??
            caseRecord!.id,
          ownerId: admitted.identity.builderId,
          previousPolicy: undefined,
          policy,
          modelVersion: admitted.version,
        });
      if (
        (delegated ? delegated.budget : this.state.workBudgetBinding) &&
        !initialBudget && !betweenCases
      ) {
        throw new Error("Registre de budget attendu mais absent.");
      }
    } catch (error) {
      this.state.budgetSuspension = {
        nodeId: "initialization",
        operation: "decide",
        recipient: "local-control",
        dispatchStarted: false,
        ...this.state.budgetSuspension,
        reason: "unavailable",
        diagnostic: errorText(error),
      };
    }
  }
  await this.update(
    (s) =>
      applyInitialization.call(this, s, {
        admitted,
        saved,
        native,
        unavailable,
        initialBudget,
      }),
    undefined,
    true,
  );
  this.runtimeRecorded = true;
  // Inspect/recover the same intention only. Initialization does not finish an
  // activation, publish a source or adopt the target on this frozen boundary.
  if (recoveringCeiling) return;
  // Finish only an already admitted, durable activation intent. A restart never
  // invents a decision or replays it under a different execution contract: the
  // shared driver publishes idempotently, adopts an effect already published, or
  // ends the admission as failed. A transient error keeps the intent.
  const resumed = this.state.candidates.filter((candidate) =>
    hasActivationIntent(candidate) && !candidate.initialAdmissionTransfer &&
    !Object.values(this.state.initialToolsPreparations ?? {}).some((intent) =>
      intent.phase === "pending" && intent.caseId === candidate.caseId &&
      intent.seedId === candidate.initialToolSeed?.id
    ) &&
    !options.deferActivationEffects &&
    !(options.deferDelegatedCandidateActivations &&
      candidate.admission?.authority === "delegate")
  );
  for (const candidate of resumed) {
    await settleActivation.call(this, candidate.id, "restart");
  }
  if (resumed.length && native) {
    // The catalog check below must see what the resumed activations published.
    native = await this.ports.model.readExecutableModel(native.identity).catch(
      () => undefined,
    );
  }
  for (const candidate of native ? this.state.candidates : []) {
    const binding = await this.ports.model.findCandidate?.(
      native!.identity,
      candidate,
    );
    const entry = native!.catalog.find((entry) =>
      entry.candidateId === candidate.id &&
      entry.digest === candidate.digest && entry.kind === candidate.kind &&
      entry.name === candidate.name
    );
    if (
      binding ||
      (candidate.stage === "active" && (!entry || entry.status !== "active"))
    ) {
      await this.update((s) => {
        const c = s.candidates.find((c) => c.id === candidate.id)!;
        if (binding) c.binding = binding;
        if (c.stage === "active" && (!entry || entry.status !== "active")) {
          c.stage = entry?.status === "refused" ? "refused" : "failed";
          c.error =
            "Le catalogue natif ne confirme plus l’activation de cet artefact exact.";
        }
      });
    }
  }
  // Restart never writes a cached host stage or configuration back into source.
  // The interrupted initialization is an explicit abandonment, not a replay of
  // cached stages: use the same transition as a requested Case abandonment.
  for (const id of abandonedInitializationIds) {
    await abandonCaseCandidates.call(this, id);
    await this.update((s) =>
      closeCaseById(s, id, "abandoned", this.ports.clock)
    );
  }
}

/** Preallocated durable opening identity. This is a birth seed, not a clock. */
export interface RequestSpaceSeed {
  runtimeId: string;
  openingId: string;
  caseId: string;
  caseNumber: number;
  caseTypeId: string;
  initialContributionId: string;
  createdAt: string;
  openedBy: string;
  text: string;
}

/** Read-only validation also applies to already cached Request handles. */
/** Immutable birth is independent from the current operational execution pin. */
export function assertRequestSpaceBirthIdentity(
  state: SystemRuntimeState,
  seed: RequestSpaceSeed,
  birth: { operatorId: string; modelDigest: string; repositoryVersion: string },
): void {
  const records = state.cases?.filter((record) => record.id === seed.caseId);
  const record = records?.[0];
  if (
    state.id !== seed.runtimeId || records?.length !== 1 || !record ||
    record.number !== seed.caseNumber || record.type !== "request" ||
    record.caseTypeId !== seed.caseTypeId ||
    record.owner !== birth.operatorId ||
    record.openedBy !== seed.openedBy || record.createdAt !== seed.createdAt ||
    canonical(record.openedFrom) !==
      canonical({
        conversationId: seed.runtimeId,
        openingId: seed.openingId,
        messageId: seed.initialContributionId,
      }) ||
    canonical(record.modelPin) !==
      canonical({
        digest: birth.modelDigest,
        repositoryVersion: birth.repositoryVersion,
      })
  ) {
    throw new Error(
      "The Request runtime birth differs from its durable opening",
    );
  }
}
export function assertRequestSpaceBirth(
  state: SystemRuntimeState,
  seed: RequestSpaceSeed,
  model: ExecutableModel,
): void {
  assertRequestSpaceBirthIdentity(state, seed, {
    operatorId: model.identity.builderId,
    modelDigest: model.version.digest,
    repositoryVersion: model.version.repositoryVersion!,
  });
  if (
    canonical(state.model) !== canonical(model.identity) ||
    canonical(state.executionModel) !== canonical(model)
  ) {
    throw new Error(
      "The Request runtime birth differs from its durable opening",
    );
  }
}

/** Fresh Request birth performs one canonical CAS and no ordinary recovery.
 * Restoration preserves all work/status and only journals changed software provenance.
 */
export async function initializeRequestSpace(
  this: Pick<
    RuntimeInitializationHost,
    "state" | "ports" | "runtimeProvenance" | "runtimeRecorded"
  >,
  seed: RequestSpaceSeed,
  model: ExecutableModel,
  verifiedCurrentState?: SystemRuntimeState,
): Promise<void> {
  if (
    !seed.runtimeId || !seed.openingId || !seed.caseId || !seed.openedBy ||
    !seed.initialContributionId || !seed.caseTypeId || !seed.text.trim() ||
    !Number.isFinite(Date.parse(seed.createdAt)) ||
    !model.version.repositoryVersion
  ) throw new Error("An exact preallocated Request birth is required");
  const provenance = structuredClone(
    await (this.ports.runtimeProvenance?.collect() ??
      runtimeProvenanceRecord(unknownRuntimeProvenance())),
  );
  const runtime = {
    digest: provenance.digest,
    ...(provenance.provenance.complete === undefined
      ? {}
      : { complete: provenance.provenance.complete }),
    ...(provenance.provenance.incompleteReasons === undefined
      ? {}
      : { incompleteReasons: [...provenance.provenance.incompleteReasons] }),
  };
  const startEvent = (at: string) => ({
    id: `request-runtime-started:${seed.openingId}:${crypto.randomUUID()}`,
    at,
    kind: "runtime-started",
    label: "Provenance du logiciel d’exécution",
    runtimeProvenance: structuredClone(provenance),
    ownerAuthority: structuredClone(
      ownerAuthorityFor(verifiedCurrentState?.executionModel ?? model),
    ),
  });
  const restore = async (initial: SystemRuntimeState) => {
    let state = initial;
    for (let attempt = 0; attempt < 64; attempt++) {
      assertRequestSpaceBirth(
        verifiedCurrentState
          ? {
            ...state,
            model: model.identity,
            executionModel: model,
          }
          : state,
        seed,
        model,
      );
      if (
        verifiedCurrentState && (
          canonical(state.model) !== canonical(verifiedCurrentState.model) ||
          canonical(state.executionModel) !==
            canonical(verifiedCurrentState.executionModel)
        )
      ) {
        throw new Error(
          "Verified Request execution pin changed during restoration",
        );
      }
      if (
        state.runtime?.digest === provenance.digest &&
        state.events.some((event) =>
          event.kind === "runtime-started" &&
          canonical(event.runtimeProvenance) === canonical(provenance)
        )
      ) {
        this.state = state;
        this.runtimeProvenance = provenance;
        this.runtimeRecorded = true;
        return;
      }
      const next = structuredClone(state);
      next.revision++;
      next.runtime = structuredClone(runtime);
      next.events.push(startEvent(this.ports.clock.now()));
      try {
        await this.ports.store.save(next, state.revision);
        this.state = next;
        this.runtimeProvenance = provenance;
        this.runtimeRecorded = true;
        return;
      } catch (error) {
        const winner = await this.ports.store.load();
        if (!winner || winner.revision === state.revision) throw error;
        state = winner;
      }
    }
    throw new Error("Request runtime provenance contention limit exceeded");
  };
  const saved = await this.ports.store.load();
  if (
    verifiedCurrentState &&
    (!saved || canonical(saved) !== canonical(verifiedCurrentState))
  ) {
    throw new Error(
      "Verified Request restoration state changed or disappeared",
    );
  }
  if (saved) {
    await restore(saved);
    return;
  }
  const fresh: SystemRuntimeState = {
    id: seed.runtimeId,
    revision: 0,
    catalogRevision: 0,
    messages: [],
    cases: [],
    candidates: [],
    events: [startEvent(seed.createdAt)],
    busy: false,
    phase: "Prêt à discuter",
    provider: this.ports.agents.label,
    model: structuredClone(model.identity),
    executionModel: structuredClone(model),
    configuration: { ...structuredClone(model.configuration), changes: [] },
    ownerAuthority: structuredClone(ownerAuthorityFor(model)),
    runtime: structuredClone(runtime),
  };
  createRequestCase(
    fresh,
    {
      id: seed.caseId,
      caseTypeId: seed.caseTypeId,
      objective: truncateText(seed.text.trim(), MAX_CASE_OBJECTIVE_CHARS),
      openedBy: seed.openedBy,
      openedFrom: {
        conversationId: seed.runtimeId,
        openingId: seed.openingId,
        messageId: seed.initialContributionId,
      },
    },
    { now: () => seed.createdAt },
    seed.caseNumber,
  );
  try {
    await this.ports.store.save(fresh, null);
    await restore(fresh);
  } catch (error) {
    // A losing initial CAS may only adopt a winner with this exact birth.
    const winner = await this.ports.store.load();
    if (!winner) throw error;
    await restore(winner);
  }
}

export function requestSpaceSeed(record: OpeningRecord): RequestSpaceSeed {
  return {
    runtimeId: `request:${record.executionSpaceId}:${
      record.base!.requestOwner.operatorId
    }`,
    openingId: record.id,
    caseId: record.caseId,
    caseNumber: record.caseNumber,
    caseTypeId: record.base!.requestOwner.caseTypeId,
    initialContributionId: record.initialContributionId,
    createdAt: record.createdAt,
    // A Main Operator opening is opened by it; the space stays the owner's.
    openedBy: record.command.opener?.operator.operatorId ?? record.ownerId,
    text: record.command.text,
  };
}
