import type { ScopedOperatorRef } from "../../../domain/governance/authority.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { canonicalDigest } from "../../../domain/primitives/execution-digest.ts";
import {
  runtimeRevisionReference,
} from "../../work/native-execution/contract.ts";
import { captureEvolutionOrigin } from "../../work/runtime/evolution.ts";
import {
  EvolutionFinalizationJob,
  operatorEvolutionCommands,
} from "../../work/runtime/evolution-commands.ts";
import {
  type EvolutionAuthorityPort,
  type EvolutionCheckpoint,
  EvolutionError,
  type EvolutionRepositoryPort,
  type EvolutionStorePort,
  type EvolutionTarget,
  type EvolutionTargetPort,
  type ScopedSoftwareAdoptionPort,
  type ScopedSoftwareEvolutionBinding,
  type ScopedSoftwareRuntimeTarget,
} from "./ports.ts";
import { EvolutionService } from "./service.ts";
import {
  assertScopedSoftwareDossier,
  createScopedSoftwareDossier,
  type ScopedSoftwareEvolutionDossierV2,
} from "./scoped-software-dossier.ts";
import {
  parseScopedSoftwareContext,
  type ScopedSoftwareContextV2,
} from "./scoped-software-context.ts";
import type { ScopedSoftwareFinalBoundaryV2 } from "./scoped-software-adoption.ts";

function refuse(code: string, detail: string): never {
  throw new EvolutionError(code, detail);
}
/** The stable locator owns reads after publication; frozen source/pins belong
 * to each dossier, rather than a mutable current-scope slot. */
function locator(scope: ScopedSoftwareContextV2) {
  const { expectedAdmittedSource: _expected, ...destination } =
    scope.destination;
  return {
    destination,
    actor: scope.actor,
    openingBaseDigest: scope.openingBaseDigest,
  };
}

export function createScopedSoftwareEvolution<TStores>(options: {
  scope: ScopedSoftwareContextV2;
  actor: ScopedSoftwareRuntimeTarget<TStores>;
  store: EvolutionStorePort<ScopedSoftwareEvolutionDossierV2>;
  authority: EvolutionAuthorityPort;
  repository: EvolutionRepositoryPort<ScopedSoftwareEvolutionDossierV2>;
  resolve(
    ref: Readonly<ScopedOperatorRef>,
  ): Promise<ScopedSoftwareRuntimeTarget<TStores>>;
  candidate(
    dossier: ScopedSoftwareEvolutionDossierV2,
    target: EvolutionTarget,
  ): Promise<ExecutableModel>;
  adoption: ScopedSoftwareAdoptionPort<TStores>;
  now(): string;
  failed(error: unknown): void;
  /** Captured by host composition BEFORE deliveries, never by this per-Request
   * factory. Finalization must not retain its triggering native claim/signal. */
  runInHostContext(operation: () => void | Promise<void>): void | Promise<void>;
}): ScopedSoftwareEvolutionBinding {
  const scope = parseScopedSoftwareContext(options.scope);
  const owns = (d: ScopedSoftwareEvolutionDossierV2) =>
    canonical(locator(d.scope)) === canonical(locator(scope));
  if (
    canonical(options.actor.ref) !== canonical(scope.actor) ||
    scope.actor.executionSpaceId !== scope.destination.executionSpaceId
  ) {
    refuse(
      "EVOLUTION_ORIGIN_INVALID",
      "The bound actor is not an admitted runtime in this Request",
    );
  }
  const resolve = async (
    d: ScopedSoftwareEvolutionDossierV2,
    target: EvolutionTarget,
  ) => {
    if (!owns(d)) {
      refuse(
        "EVOLUTION_SCOPE_CHANGED",
        "The evolution dossier belongs to another Request",
      );
    }
    const entry = d.scope.targets.find((t) =>
      t.target.operatorId === target.operatorId
    );
    if (!entry) {
      refuse(
        "EVOLUTION_TARGET_MISSING",
        "The affected target has no signed scoped identity",
      );
    }
    const actual = await options.resolve(entry.target);
    if (
      canonical(actual.ref) !== canonical(entry.target) ||
      actual.opening.id !== d.scope.destination.openingId ||
      actual.opening.caseId !== d.scope.destination.caseId ||
      actual.opening.baseDigest !== d.scope.openingBaseDigest
    ) {
      refuse(
        "EVOLUTION_SCOPE_CHANGED",
        "The actual target does not match the signed Request",
      );
    }
    return { entry, actual };
  };
  const ordered = (d: ScopedSoftwareEvolutionDossierV2) =>
    [...d.proposal.targets].sort((a, b) =>
      a.operatorId < b.operatorId ? -1 : a.operatorId > b.operatorId ? 1 : 0
    );
  const targets: EvolutionTargetPort<ScopedSoftwareEvolutionDossierV2> = {
    async captureOrigin(input, proposal) {
      if (
        !proposal.scoped ||
        canonical(locator(proposal.scoped.context)) !==
          canonical(locator(scope))
      ) {
        refuse(
          "EVOLUTION_ORIGIN_INVALID",
          "The source proposal has another immutable destination",
        );
      }
      const actual = await Promise.all(
        proposal.scoped.context.targets.map(async (entry) => {
          const target = await options.resolve(entry.target);
          if (
            canonical(target.ref) !== canonical(entry.target) ||
            target.opening.id !==
              proposal.scoped!.context.destination.openingId ||
            target.opening.caseId !==
              proposal.scoped!.context.destination.caseId
          ) {
            refuse(
              "EVOLUTION_SCOPE_CHANGED",
              "The source origin resolved another actual Request target",
            );
          }
          return target;
        }),
      );
      return captureEvolutionOrigin(input, proposal, [
        options.actor.runtime.snapshot,
        ...actual.map((t) => t.runtime.snapshot),
      ]);
    },
    async withArmingTargets(d, save) {
      const list = ordered(d);
      const reserve = async (
        i: number,
      ): Promise<Awaited<ReturnType<typeof save>>> => {
        if (i === list.length) return await save();
        const { entry, actual } = await resolve(d, list[i]);
        return await actual.runtime.withEvolutionArming(async () => {
          const binding = await actual.readBinding();
          if (canonical(binding.pin) !== canonical(entry.previousPin)) {
            refuse(
              "EVOLUTION_ADMISSION_CHANGED",
              "The target execution pin changed before arming",
            );
          }
          return await reserve(i + 1);
        });
      };
      return await reserve(0);
    },
    async withReservedTargets(d, operation) {
      const list = ordered(d);
      const reserve = async (
        i: number,
      ): Promise<Awaited<ReturnType<typeof operation>>> => {
        if (i < list.length) {
          const { actual } = await resolve(d, list[i]);
          return await actual.runtime.withEvolutionReservation(
            d.id,
            () => reserve(i + 1),
          );
        }
        const evaluate = async (): Promise<EvolutionCheckpoint> => {
          const result: EvolutionCheckpoint = { safe: true, blockers: [] };
          for (const target of list) {
            const { entry, actual } = await resolve(d, target);
            const binding = await actual.readBinding();
            if (canonical(binding.pin) !== canonical(entry.previousPin)) {
              const receipt = d.publication
                ? await options.adoption.inspect({
                  dossier: d,
                  target,
                  publication: d.publication,
                  runtime: actual,
                })
                : null;
              if (!receipt) {
                refuse(
                  "EVOLUTION_ADMISSION_CHANGED",
                  "The immutable previous execution pin changed without an adoption receipt",
                );
              }
            }
            const boundary = await actual.runtime.evolutionBoundary(d.id);
            result.safe &&= boundary.safe;
            result.blockers.push(...boundary.blockers);
          }
          return result;
        };
        return await operation(await evaluate(), evaluate);
      };
      return await reserve(0);
    },
    async inspectAdoption(d, target, publication) {
      const { actual } = await resolve(d, target);
      return await options.adoption.inspect({
        dossier: d,
        target,
        publication,
        runtime: actual,
      });
    },
    async adoptExact(d, target, publication) {
      const { entry, actual } = await resolve(d, target);
      if (
        await options.store.targetOwner(d.repositoryId, target.operatorId) !==
          d.id
      ) refuse("EVOLUTION_BARRIER_LOST", "The scoped target barrier changed");
      const candidate = await options.candidate(d, target);
      if (
        candidate.identity.builderId !== target.operatorId ||
        candidate.version.digest !== target.candidateDigest ||
        candidate.version.repositoryVersion !== publication.version
      ) {
        refuse(
          "EVOLUTION_ADOPTION_MISMATCH",
          "The candidate differs from the exact compiled publication",
        );
      }
      const revalidate = async () => {
        await options.authority.revalidate(
          d.adoptionAuthorization!,
          d.proposal,
        );
        const binding = await actual.readBinding();
        if (canonical(binding.pin) !== canonical(entry.previousPin)) {
          refuse(
            "EVOLUTION_ADMISSION_CHANGED",
            "The previous pin changed under the final reservation",
          );
        }
        const checkpoint = await actual.runtime.evolutionBoundary(d.id);
        if (!checkpoint.safe) {
          refuse(
            "EVOLUTION_BOUNDARY_UNSAFE",
            checkpoint.blockers.map((b) => b.detail).join("; "),
          );
        }
      };
      await revalidate();
      // rFinal is captured HERE after settled native/business evidence, under
      // every target reservation. Preparation/arming revisions are never reused.
      const persisted = await actual.runtime.readPersistedState();
      if (
        !persisted ||
        canonical(persisted) !== canonical(actual.runtime.snapshot)
      ) refuse("EVOLUTION_STATE_DRIFT", "Final durable business state changed");
      const nativeSnapshots = await actual.inspectNative();
      const boundary: ScopedSoftwareFinalBoundaryV2 = {
        format: "software-evolution-final-boundary/v2",
        target: entry.target,
        previousPin: entry.previousPin,
        previousRuntimeRevision: persisted.revision,
        previousBusinessRevision: runtimeRevisionReference(persisted),
        checkpointDigest: await canonicalDigest({
          state: persisted,
          nativeSnapshots,
        }),
        nativeSnapshots,
      };
      return await options.adoption.adopt({
        dossier: d,
        target,
        publication,
        runtime: actual,
        candidate,
        boundary,
        revalidate,
      });
    },
  };
  const service = new EvolutionService<ScopedSoftwareEvolutionDossierV2>({
    store: options.store,
    authority: options.authority,
    repository: options.repository,
    targets,
    now: options.now,
    dossier: {
      assert: assertScopedSoftwareDossier,
      create: async (draft, input) => {
        if (!draft.proposal.scoped) {
          refuse("EVOLUTION_INVALID", "The scoped preimage is absent");
        }
        if (!input.callerCommandId || !input.callerCommandDigest) {
          refuse(
            "EVOLUTION_ORIGIN_INVALID",
            "Scoped preparation requires its actual native command identity",
          );
        }
        return await createScopedSoftwareDossier(draft, draft.proposal.scoped, {
          callerCommandId: input.callerCommandId,
          callerCommandDigest: input.callerCommandDigest,
        });
      },
    },
  });
  let closed = false;
  const recover = async () => {
    await options.runInHostContext(async () => {
      if (!closed) await service.recover(scope.destination.repositoryId);
    });
  };
  const job = new EvolutionFinalizationJob(recover, options.failed);
  const schedule = () => {
    if (!closed) options.runInHostContext(() => job.schedule());
  };
  options.actor.runtime.configureOperatorEvolution(
    operatorEvolutionCommands({
      repositoryId: scope.destination.repositoryId,
      store: options.store,
      service,
      snapshot: () => options.actor.runtime.snapshot,
      armed: schedule,
      owns,
      preparationIdentity: async ({ command, source, native }) => {
        if (!native?.effectKey || !native.inputMessageId) {
          refuse(
            "EVOLUTION_ORIGIN_INVALID",
            "No actual admitted native effect identifies this software command",
          );
        }
        const callerCommandId = native.effectKey;
        return {
          id: `software-evolution-scoped:${await canonicalDigest({
            format: "software-evolution-id/v2",
            host: scope.destination.host,
            repositoryId: scope.destination.repositoryId,
            preparer: scope.actor,
            callerCommandId,
          })}`,
          callerCommandId,
          callerCommandDigest: await canonicalDigest({
            format: "software-evolution-native-command/v2",
            actor: scope.actor,
            native,
            command,
            source,
          }),
        };
      },
      matchesReplay: (d, digest) => d.callerCommandDigest === digest,
    }),
  );
  options.actor.runtime.bindEvolutionBarrier(
    scope.destination.repositoryId,
    options.store,
  );
  const stopState = options.actor.runtime.onState((state) => {
    if (!state.busy) schedule();
  });
  // Dossier writes include durable blocker updates. Scheduling from those same
  // writes would turn an unsafe checkpoint into an unbounded self-trigger loop.
  // Explicit arm, settled runtime events and cold recovery are the wake sources.
  return {
    service,
    requestFinalization: schedule,
    recover,
    dispose: () => {
      closed = true;
      stopState();
    },
  };
}
