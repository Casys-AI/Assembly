import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  assertEvolutionDossier,
  assertEvolutionReceipt,
} from "./invariants.ts";
import {
  type EvolutionAuthorityPort,
  type EvolutionBlocker,
  type EvolutionDossier,
  type EvolutionDossierBase,
  EvolutionError,
  type EvolutionPreparationInput,
  type EvolutionRepositoryPort,
  type EvolutionStorePort,
  type EvolutionTargetPort,
  type SoftwareEvolutionDossier,
} from "./ports.ts";

/** Deterministic host commands. Never opens/resumes a Case or calls a model. */
export class EvolutionService<
  D extends SoftwareEvolutionDossier = EvolutionDossier,
> {
  readonly #running = new Map<string, Promise<D>>();
  constructor(
    readonly ports: {
      store: EvolutionStorePort<D>;
      authority: EvolutionAuthorityPort;
      repository: EvolutionRepositoryPort<D>;
      targets: EvolutionTargetPort<D>;
      now: () => string;
      /** Immutable family composition. Main keeps its original bytes/validator. */
      dossier?: {
        create(
          draft: EvolutionDossier,
          input: EvolutionPreparationInput,
        ): Promise<D>;
        assert(dossier: D): void;
      };
    },
  ) {}

  #assert(dossier: D): void {
    if (this.ports.dossier) this.ports.dossier.assert(dossier);
    else assertEvolutionDossier(dossier as EvolutionDossier);
  }

  async #get(id: string): Promise<D> {
    const dossier = await this.ports.store.get(id);
    if (!dossier) {
      throw new EvolutionError(
        "EVOLUTION_NOT_FOUND",
        "Unknown evolution dossier",
      );
    }
    this.#assert(dossier);
    return dossier;
  }

  async #save(
    d: D,
    changes: Partial<EvolutionDossierBase>,
  ): Promise<D> {
    const next = {
      ...structuredClone(d),
      ...changes,
      revision: d.revision + 1,
      updatedAt: this.ports.now(),
    };
    this.#assert(next);
    return await this.ports.store.compareAndSwap(d.id, d.revision, next);
  }

  async prepare(input: EvolutionPreparationInput): Promise<D> {
    if (input.origin.operatorId !== input.actorId) {
      throw new EvolutionError(
        "EVOLUTION_ORIGIN_INVALID",
        "Origin must name the actual preparing operator",
      );
    }
    if (await this.ports.store.get(input.id)) {
      throw new EvolutionError(
        "EVOLUTION_CONFLICT",
        "Dossier identity already exists",
      );
    }
    const proposal = await this.ports.repository.prepare(
      structuredClone(input),
    );
    // Copy only the claimed source scope; destination mapping comes exclusively
    // from host runtime evidence, never a model/HTTP-provided targetScopes.
    const origin = await this.ports.targets.captureOrigin({
      actorId: input.actorId,
      origin: {
        operatorId: input.origin.operatorId,
        ...(input.origin.requestId !== undefined
          ? { requestId: input.origin.requestId }
          : {}),
        ...(input.origin.designerScopeId !== undefined
          ? { designerScopeId: input.origin.designerScopeId }
          : {}),
      },
    }, proposal);
    if (
      origin.operatorId !== input.actorId ||
      origin.requestId !== input.origin.requestId ||
      origin.designerScopeId !== input.origin.designerScopeId
    ) {
      throw new EvolutionError(
        "EVOLUTION_ORIGIN_INVALID",
        "Captured origin differs from the preparer's claimed current invocation",
      );
    }
    const preparation = await this.ports.authority.authorize(
      "prepare",
      input.actorId,
      proposal,
    );
    assertEvolutionReceipt(preparation, "prepare", proposal);
    if (preparation.operatorNativeId !== input.actorId) {
      throw new EvolutionError(
        "EVOLUTION_INVALID",
        "Preparation receipt names another actor",
      );
    }
    const now = this.ports.now();
    const d: EvolutionDossier = {
      v: 1,
      id: input.id,
      repositoryId: input.repositoryId,
      revision: 0,
      status: "prepared",
      origin: structuredClone(origin),
      finalizerActorId: input.finalizerActorId,
      accounting: {
        id: `evolution:${input.repositoryId}:${input.id}`,
        agentInvocations: 0,
      },
      createdAt: now,
      updatedAt: now,
      proposal,
      preparation,
      adoptions: [],
      blockers: [],
    };
    const captured = this.ports.dossier
      ? await this.ports.dossier.create(d, input)
      : d as unknown as D;
    this.#assert(captured);
    return await this.ports.store.create(captured);
  }

  async accept(id: string, actorId: string): Promise<D> {
    const d = await this.#get(id);
    if (d.status !== "prepared") {
      throw new EvolutionError(
        "EVOLUTION_STATE",
        "Only a prepared revision can be accepted",
      );
    }
    await this.ports.authority.revalidate(d.preparation, d.proposal);
    const acceptance = await this.ports.authority.authorize(
      "accept",
      actorId,
      d.proposal,
    );
    assertEvolutionReceipt(acceptance, "accept", d.proposal);
    if (acceptance.operatorNativeId !== actorId) {
      throw new EvolutionError(
        "EVOLUTION_INVALID",
        "Acceptance receipt names another actor",
      );
    }
    // This receipt does not publish HEAD or place work in the writer queue.
    return await this.#save(d, { status: "accepted", acceptance });
  }

  async authorizeAdoption(
    id: string,
    actorId: string,
  ): Promise<D> {
    const d = await this.#get(id);
    if (d.status !== "accepted" || actorId !== d.finalizerActorId) {
      throw new EvolutionError(
        "EVOLUTION_STATE",
        "Adoption requires an accepted revision and the named finalizer actor",
      );
    }
    await this.ports.authority.revalidate(d.acceptance!, d.proposal);
    const adoptionAuthorization = await this.ports.authority.authorize(
      "adopt",
      actorId,
      d.proposal,
    );
    assertEvolutionReceipt(adoptionAuthorization, "adopt", d.proposal);
    // Store CAS atomically arms every target before any publication can begin.
    return await this.ports.targets.withArmingTargets(
      d,
      () => this.#save(d, { status: "armed", adoptionAuthorization }),
    );
  }

  async cancel(
    id: string,
    actorId: string,
    superseded = false,
  ): Promise<D> {
    const d = await this.#get(id);
    if (!["prepared", "accepted", "armed"].includes(d.status)) {
      throw new EvolutionError(
        "EVOLUTION_STATE",
        "Publication has started; cancellation cannot release its barrier",
      );
    }
    const receipt = await this.ports.authority.authorize(
      "accept",
      actorId,
      d.proposal,
    );
    assertEvolutionReceipt(receipt, "accept", d.proposal);
    if (receipt.operatorNativeId !== actorId) {
      throw new EvolutionError(
        "EVOLUTION_INVALID",
        "Cancellation receipt names another actor",
      );
    }
    return await this.#save(d, {
      status: superseded ? "superseded" : "cancelled",
      cancellation: receipt,
      blockers: [],
    });
  }

  finalize(id: string): Promise<D> {
    const existing = this.#running.get(id);
    if (existing) return existing;
    const running = this.#finalize(id).finally(() => this.#running.delete(id));
    this.#running.set(id, running);
    return running;
  }

  async #finalize(id: string): Promise<D> {
    const initial = await this.#get(id);
    if (
      !["armed", "publishing", "published-awaiting-adoption"].includes(
        initial.status,
      )
    ) return initial;
    return await this.ports.targets.withReservedTargets(
      initial,
      async (checkpoint, revalidate) => {
        let d = await this.#get(id);
        if (
          !["armed", "publishing", "published-awaiting-adoption"].includes(
            d.status,
          )
        ) return d;
        try {
          // Git/queue evidence wins after a crash, before considering re-publication.
          const found = d.publication ??
            await this.ports.repository.findPublication(d);
          if (found && !d.publication) {
            d = await this.#save(d, {
              status: "published-awaiting-adoption",
              publication: found,
            });
          }
          if (!checkpoint.safe) {
            return await this.#save(d, {
              blockers: checkpoint.blockers.length ? checkpoint.blockers : [{
                code: "BOUNDARY_UNPROVEN",
                detail: "Target checkpoint is not proven safe",
              }],
            });
          }
          if (!d.publication) {
            await this.ports.authority.revalidate(d.preparation, d.proposal);
            await this.ports.authority.revalidate(d.acceptance!, d.proposal);
            await this.ports.authority.revalidate(
              d.adoptionAuthorization!,
              d.proposal,
            );
            await this.ports.repository.revalidate(d);
            if (revalidate) {
              const fresh = await revalidate();
              if (!fresh.safe) {
                return await this.#save(d, { blockers: fresh.blockers });
              }
            }
            // Durable barrier already exists; publishing means the writer may have
            // an interrupted accepting journal even if no anchor is visible yet.
            if (d.status !== "publishing") {
              d = await this.#save(d, {
                status: "publishing",
                blockers: [],
              });
            }
            const publication = await this.ports.repository.publish(d);
            d = await this.#save(d, {
              status: "published-awaiting-adoption",
              publication,
            });
          }
          for (
            const target of [...d.proposal.targets].sort((a, b) =>
              a.operatorId < b.operatorId
                ? -1
                : a.operatorId > b.operatorId
                ? 1
                : 0
            )
          ) {
            if (
              d.adoptions.some((r) => r.operatorId === target.operatorId)
            ) continue;
            const recovered = await this.ports.targets.inspectAdoption(
              d,
              target,
              d.publication!,
            );
            let receipt = recovered;
            if (!receipt) {
              await this.ports.authority.revalidate(
                d.adoptionAuthorization!,
                d.proposal,
              );
              receipt = await this.ports.targets.adoptExact(
                d,
                target,
                d.publication!,
              );
            }
            // A scoped admission transaction commits its exact dossier receipt
            // atomically with the pin. Reconcile that CAS before writing again.
            const committed = await this.#get(d.id);
            if (committed.revision !== d.revision) {
              const recorded = committed.adoptions.find((r) =>
                r.operatorId === target.operatorId
              );
              if (!recorded || canonical(recorded) !== canonical(receipt)) {
                throw new EvolutionError(
                  "EVOLUTION_RECEIPT_MISMATCH",
                  "The atomic adoption receipt changed",
                );
              }
              d = committed;
            } else {d = await this.#save(d, {
                adoptions: [...d.adoptions, receipt],
              });}
          }
          return d.status === "adopted"
            ? d
            : await this.#save(d, { status: "adopted", blockers: [] });
        } catch (error) {
          // Re-read after possible CAS races. Never overwrite a concurrent cancel
          // or newer receipt, and never release an ambiguous publication barrier.
          d = await this.#get(id);
          if (
            !["armed", "publishing", "published-awaiting-adoption"].includes(
              d.status,
            )
          ) return d;
          const blocker: EvolutionBlocker = {
            code: error instanceof EvolutionError
              ? error.code
              : "EVOLUTION_FINALIZATION_BLOCKED",
            detail: error instanceof Error ? error.message : String(error),
          };
          return await this.#save(d, { blockers: [blocker] });
        }
      },
    ).catch(async (error: unknown) => {
      // Failure to acquire/inspect a target is also durable and inspectable.
      const d = await this.#get(id);
      if (
        !["armed", "publishing", "published-awaiting-adoption"].includes(
          d.status,
        )
      ) return d;
      return await this.#save(d, {
        blockers: [{
          code: error instanceof EvolutionError
            ? error.code
            : "EVOLUTION_TARGET_RESERVATION_FAILED",
          detail: error instanceof Error ? error.message : String(error),
        }],
      });
    });
  }

  async recover(repositoryId: string): Promise<D[]> {
    const results: D[] = [];
    for (const d of await this.ports.store.listPending(repositoryId)) {
      results.push(await this.finalize(d.id));
    }
    return results;
  }
}
