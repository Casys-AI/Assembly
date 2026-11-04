/** Host lifecycle order: the startup binding sequence of the composition root
 * and the ordered stop of the entry point. Both are load-bearing orders kept
 * as functions so their regressions call the production sequence itself. */
import type { DecisionInformationPort } from "../application/work/context/information-ports.ts";
import type { ProviderObservation } from "./provider-configuration.ts";

interface AcceptingRuntime<D> {
  processAcceptedContribution(delivery: D): Promise<void>;
}

export interface PrimaryDeliveryOptions<
  D extends { identity: { operatorId: string } },
  S,
  R extends AcceptingRuntime<D>,
  N,
> {
  primaryOperatorId: string;
  workspace: {
    readonly information: DecisionInformationPort;
    runtimeFor(operatorId: string): { runtime: R } | undefined;
    activateRuntimeDeliveries(): Promise<void>;
  };
  informationReader: { current?: DecisionInformationPort };
  /** Read lazily by the Request authority; set before any network decision. */
  registeredMain: { current?: R };
  requestSpaces: {
    bindNetworkDecision(decision: N): void;
    recoverSoftwareEvolution(): Promise<void>;
    /** Route pending Branch Operator requests left unrouted while Main was absent. */
    replayAuthority(): Promise<void>;
    dispatchAccepted(
      delivery: D,
      scope: S | undefined,
      mainDispatch: (delivery: D) => Promise<void>,
    ): Promise<void>;
  };
  prepareNetworkDecision(): N;
  nativeRuntime: {
    start(handler: (delivery: D, scope?: S) => Promise<void>): Promise<void>;
  };
}

/** Resolve the registered Main before preparing and binding the network
 * decision, recover software evolution, then start native delivery and only
 * afterwards activate runtime deliveries and replay Branch Operator requests.
 * An absent Main refuses first. */
export async function startPrimaryDeliveries<
  D extends { identity: { operatorId: string } },
  S,
  R extends AcceptingRuntime<D>,
  N,
>(options: PrimaryDeliveryOptions<D, S, R, N>): Promise<void> {
  const { workspace, requestSpaces } = options;
  options.informationReader.current = workspace.information;
  const main = workspace.runtimeFor(options.primaryOperatorId)?.runtime;
  if (!main) throw new Error("The registered Main runtime is unavailable");
  options.registeredMain.current = main;
  requestSpaces.bindNetworkDecision(options.prepareNetworkDecision());
  await requestSpaces.recoverSoftwareEvolution();
  await options.nativeRuntime.start((delivery, scope) =>
    requestSpaces.dispatchAccepted(delivery, scope, async (mainDelivery) => {
      const target = workspace.runtimeFor(mainDelivery.identity.operatorId);
      if (!target) {
        throw new Error(
          "Accepted operator contribution has no admitted runtime",
        );
      }
      await target.runtime.processAcceptedContribution(mainDelivery);
    })
  );
  await workspace.activateRuntimeDeliveries();
  await requestSpaces.replayAuthority();
}

type Closable = { close(): unknown };

/** The assembly members the ordered stop releases, in dependency order. */
export interface StoppableAssembly {
  clients: Set<{ close(): void }>;
  liveGraph: {
    stopPolling(): void;
    graphClients: Set<{ close(): void }>;
    pendingRead(): Promise<unknown> | null | undefined;
  };
  operatorWorkspace: {
    stopAcceptingRuntimeDeliveries(): unknown;
    drainRuntimeDeliveries(): Promise<unknown>;
    close(): Promise<unknown>;
  };
  nativeRuntime: { stopAccepting(): unknown; stop(): Promise<unknown> };
  requestEvents: { close(): Promise<void> };
  requestSpaces: { runtime: { closeConversationObservers(): void } };
  service: { idle(): Promise<unknown> };
  providerObservation: ProviderObservation;
  stopSourceWriter(): Promise<unknown>;
  evolutionStore: Closable;
  revisionNotifications: { close(): Promise<unknown> };
  projectionPreparer: { close(): Promise<unknown> };
  semanticModel: { close(): Promise<unknown> };
  nativeSemantic: { close(): Promise<unknown> };
  closeModelBackend(): Promise<unknown>;
  caseNumbers: { close(): Promise<unknown> };
  storage: { close(): Promise<unknown> };
}

export interface OrderedStopOptions {
  assembly: StoppableAssembly;
  server: { shutdown(): Promise<void> };
  casePoll: ReturnType<typeof setInterval>;
  log: { warn(message: string, properties: Record<string, unknown>): void };
  closeToolkitWorkers(): Promise<unknown>;
}

/** One idempotent ordered stop: stop intake, drain work, bound provider
 * collection, then release writers, stores and native processes. Every step
 * runs even after an earlier failure; failures are reported together. */
export function createOrderedStop(
  options: OrderedStopOptions,
): () => Promise<void> {
  const { assembly, server, log } = options;
  let shutdown: Promise<void> | undefined;
  return () => {
    if (shutdown) return shutdown;
    shutdown = (async () => {
      assembly.liveGraph.stopPolling();
      clearInterval(options.casePoll);
      for (
        const client of [
          ...assembly.clients,
          ...assembly.liveGraph.graphClients,
        ]
      ) {
        try {
          client.close();
        } catch { /* Already disconnected. */ }
      }
      assembly.clients.clear();
      assembly.liveGraph.graphClients.clear();
      const failures: unknown[] = [];
      const attempt = async (close: () => unknown) => {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      };
      await attempt(() =>
        assembly.operatorWorkspace.stopAcceptingRuntimeDeliveries()
      );
      await attempt(() => assembly.nativeRuntime.stopAccepting());
      await attempt(() => assembly.requestEvents.close());
      await attempt(() => server.shutdown());
      // Abort and drain owned queue workers before waiting on business-idle
      // promises which may otherwise depend on those workers being woken.
      await attempt(() => assembly.nativeRuntime.stop());
      await attempt(() =>
        assembly.requestSpaces.runtime.closeConversationObservers()
      );
      await attempt(() =>
        Promise.all([
          assembly.service.idle(),
          assembly.liveGraph.pendingRead() ?? Promise.resolve(),
        ])
      );
      // Keep dependency order, but one failed release must not skip the native
      // process termination or closure of the durable writer and stores.
      await attempt(() => assembly.operatorWorkspace.drainRuntimeDeliveries());
      // Work has drained. Bound collection shutdown; a timeout leaves writes
      // unconfirmed and cannot cancel the underlying append or prove byte loss.
      const observation = assembly.providerObservation;
      if (observation.supported) {
        await attempt(async () => {
          const result = await observation.close(1000);
          const dropped = {
            invalid: result.status.dropped.invalid,
            oversize: result.status.dropped.oversize,
            saturated: result.status.dropped.saturated,
            sinkFailure: result.status.dropped.sinkFailure,
            closed: result.status.dropped.closed,
            disabled: result.status.dropped.disabled,
          };
          if (
            result.unconfirmedPending > 0 ||
            Object.values(dropped).some((count) => count > 0)
          ) {
            log.warn("Provider observation shutdown collection health", {
              pending: result.unconfirmedPending,
              timedOut: result.timedOut,
              dropped,
            });
          }
        });
      }
      // Keep target authority and skill gates bound until the shared Git writer
      // finishes its already claimed model/artifact publications.
      await attempt(() => assembly.stopSourceWriter());
      await attempt(() => assembly.operatorWorkspace.close());
      await attempt(() => assembly.evolutionStore.close());
      await attempt(() => assembly.revisionNotifications.close());
      // Abort pending preparation before draining graph pins: every caller
      // settles, then native graphs and shared build stores close in order.
      await attempt(() => assembly.projectionPreparer.close());
      await attempt(() => assembly.semanticModel.close());
      await attempt(() => assembly.nativeSemantic.close());
      await attempt(() => assembly.closeModelBackend());
      await attempt(() => options.closeToolkitWorkers());
      await attempt(() => assembly.caseNumbers.close());
      await attempt(() => assembly.storage.close());
      if (failures.length) {
        throw new AggregateError(failures, "Shutdown failed");
      }
    })();
    return shutdown;
  };
}
