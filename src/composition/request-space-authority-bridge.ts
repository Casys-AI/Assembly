import { scopedOperator } from "../domain/governance/policies/delegation-scope.ts";
import type { ScopedOperatorRef } from "../domain/governance/authority.ts";
import type { RequestSpaceRuntimeOptions } from "../application/work/request-spaces/runtime.ts";
import {
  RequestSpaceAuthorityBridge,
} from "../application/governance/request-space-authority-bridge.ts";
import type { PostgresHostStorage } from "../adapters/out/postgres/host-storage.ts";
import type { PostgresRequestSpaceStore } from "../adapters/out/postgres/request-space-store.ts";
import type { RequestExecutionBindingPort } from "../application/model/evolution/request-adoption-ports.ts";
import type { SystemRuntime } from "../application/work/runtime/system.ts";
import type { SystemRuntimeState } from "../application/work/runtime/state.ts";
import { designerScopeId } from "../application/work/cases/runtime.ts";
import { canonical } from "../domain/primitives/canonical-json.ts";
import {
  errorLogProperties,
  technicalLogger,
} from "../infrastructure/logging.ts";

import type { RequestChangeDecision } from "../application/work/request-spaces/request-change-decision.ts";
import type { RequestSourceOwnerContext } from "../application/model/source-admission/request-source-owner.ts";
import {
  buildRequestCreationGrantAuthority,
  buildRequestDelegatedAuthority,
  parseRequestCreationGrantAuthority,
  parseRequestDelegatedAuthority,
} from "../application/model/source-admission/request-delegated-authority.ts";
import { OperatorAuthorityError } from "../domain/governance/operator-authority-error.ts";
import { RequestSpaceError } from "../domain/work/request-spaces/scope.ts";
import { bindHostBackgroundTask } from "../infrastructure/host-background-task.ts";

const log = technicalLogger("composition");

function sourceMatchesRequester(
  source: RequestSourceOwnerContext,
  request: SystemRuntimeState,
  ownerId: string,
): boolean {
  const model = request.executionModel!;
  return canonical(source.priorModel.identity) === canonical(model.identity) &&
    canonical({
        ...source.priorModel.version,
        ...(model.identity.builderId !== ownerId
          ? { repositoryVersion: model.version.repositoryVersion }
          : {}),
      }) === canonical(model.version);
}

/** Late-bound to the actual registered Main after host composition. No human
 * session is constructed or persisted; this route only delivers observations. */
export function createRequestSpaceAuthorityBridge(options: {
  storage: PostgresHostStorage;
  openings: Pick<PostgresRequestSpaceStore, "forCase" | "openCaseIds">;
  bindings: RequestExecutionBindingPort;
  main(): SystemRuntime | undefined;
  branchRuntime?(caseId: string): SystemRuntime | undefined;
  /** The delegated decision capability, late-bound with the network decision. */
  delegated?(): {
    decision: RequestChangeDecision;
    sourceContext(
      caseId: string,
      requester?: ScopedOperatorRef,
    ): Promise<RequestSourceOwnerContext>;
    now(): string;
  } | undefined;
}): RequestSpaceAuthorityBridge {
  return new RequestSpaceAuthorityBridge({
    async resolve(caseId) {
      const opening = await options.openings.forCase(caseId);
      if (
        !opening?.base ||
        opening.scope.projectId !== options.storage.scope.projectId ||
        opening.scope.systemId !== options.storage.scope.systemId
      ) return null;
      try {
        const [binding, space] = await Promise.all([
          options.bindings.read(opening),
          options.storage.client.executionSpace.findUnique({
            where: {
              projectId_systemId_executionSpaceId: {
                ...options.storage.scope,
                executionSpaceId: opening.executionSpaceId,
              },
            },
          }),
        ]);
        if (!space) return null;
        // The operators the admission names after the BO (4.8e E5); the
        // bridge verifies each state against the admission.
        const members: SystemRuntimeState[] = [];
        for (
          const operatorId of binding.admission.permissions.operatorIds.slice(1)
        ) {
          const state = await options.storage.readCaseRuntimeState(
            opening.executionSpaceId,
            opening.caseId,
            operatorId,
          );
          if (!state) return null;
          members.push(state);
        }
        const main = options.main()?.snapshot;
        return {
          opening,
          space,
          admission: binding.admission,
          request: binding.state,
          members,
          ...(main ? { main } : {}),
        };
      } catch {
        // An unavailable proof is never translated into human authority.
        return null;
      }
    },
    async receiveMain(notice, origin, delivery) {
      const main = options.main();
      const state = main?.snapshot;
      if (
        !main || !state?.executionModel ||
        state.id !== origin.conversationId ||
        designerScopeId(state) !== origin.designerScopeId ||
        notice.kind === "authority-escalation" &&
          state.executionModel.identity.builderId !== notice.recipient
      ) {
        throw new Error("The registered Main changed before notice delivery");
      }
      await main.receiveOperatorNotice(notice, origin, delivery);
    },
    async receiveBranch(caseId, notice, origin, delivery) {
      const runtime = options.branchRuntime?.(caseId);
      if (
        !runtime || runtime.snapshot.id !== origin.conversationId ||
        notice.kind !== "authority-escalation" ||
        notice.recipient !== runtime.snapshot.executionModel?.identity.builderId
      ) {
        throw new OperatorAuthorityError(
          "AUTHORITY_OUT_OF_BOUNDS",
          "The registered branch decider is unavailable",
          { caseId },
        );
      }
      await runtime.receiveOperatorNotice(notice, origin, delivery);
    },
    openCases: () => options.openings.openCaseIds(),
    async decide(input) {
      const delegated = options.delegated?.();
      const { snapshot, requester, change, route, command, origin } = input;
      const context = { caseId: snapshot.opening.caseId, changeId: change.id };
      if (!delegated) {
        throw new OperatorAuthorityError(
          "AUTHORITY_OUT_OF_BOUNDS",
          "Delegated branch decisions are unavailable on this host",
          context,
        );
      }
      try {
        if (!route) {
          // A4: a decided change replays only the recorded envelope of this
          // exact operator command; another decision is final.
          const recorded = requester.requestNetworkDecisions
            ?.[change.id]?.authority;
          const envelope = recorded?.kind === "delegated"
            ? parseRequestDelegatedAuthority(recorded.envelope)
            : undefined;
          if (envelope?.origin.effectKey !== origin.effectKey) {
            throw new OperatorAuthorityError(
              "AUTHORITY_REQUEST_STALE",
              "Another authority or command already decided this change",
              context,
            );
          }
          await delegated.decision.resume(
            { kind: "delegated", envelope: envelope! },
            snapshot.opening,
            command.operatorId,
            change.id,
          );
          return;
        }
        const source = await delegated.sourceContext(
          snapshot.opening.caseId,
          scopedOperator(
            input.space,
            input.requester.executionModel!.identity.builderId,
          ),
        );
        if (
          !sourceMatchesRequester(
            source,
            input.requester,
            snapshot.opening.base!.requestOwner.operatorId,
          )
        ) {
          throw new OperatorAuthorityError(
            "AUTHORITY_REQUEST_STALE",
            "The Case's admitted source differs from its executing model",
            context,
          );
        }
        const envelope = buildRequestDelegatedAuthority({
          opening: snapshot.opening,
          admission: snapshot.admission,
          request: input.requester,
          states: [snapshot.request, ...snapshot.members ?? []],
          space: input.space,
          main: snapshot.main,
          change,
          route,
          destination: source.destination,
          origin,
          capturedAt: delegated.now(),
        });
        await delegated.decision.decide(
          {
            kind: "delegated",
            envelope,
            policyModel: input.decider.executionSpaceId === "main"
              ? snapshot.main.executionModel!
              : snapshot.request.executionModel!,
          },
          snapshot.opening,
          {
            agentId: command.operatorId,
            caseId: snapshot.opening.caseId,
            changeId: change.id,
            expectedRevision: input.requester.revision,
            configurationRevision: command.expectedRevision,
            verdict: command.verdict,
          },
        );
      } catch (error) {
        // The MO's turn reads coded refusals; other failures stay failures.
        if (
          error instanceof RequestSpaceError &&
          error.code === "OPENING_CONFLICT"
        ) {
          throw new OperatorAuthorityError(
            "AUTHORITY_REQUEST_STALE",
            error.message,
            context,
          );
        }
        throw error;
      }
    },
    creationGrant() {
      const delegated = options.delegated?.();
      if (!delegated) return undefined;
      return async (input) => {
        const { snapshot, requester, space, branchTeamSize, change } = input;
        const source = await delegated.sourceContext(
          snapshot.opening.caseId,
          scopedOperator(
            input.space,
            input.requester.executionModel!.identity.builderId,
          ),
        );
        if (
          !sourceMatchesRequester(
            source,
            input.requester,
            snapshot.opening.base!.requestOwner.operatorId,
          )
        ) {
          throw new OperatorAuthorityError(
            "AUTHORITY_REQUEST_STALE",
            "The Case's admitted source differs from its executing model",
            { caseId: snapshot.opening.caseId, changeId: change.id },
          );
        }
        try {
          return buildRequestCreationGrantAuthority({
            opening: snapshot.opening,
            admission: snapshot.admission,
            request: requester,
            space,
            branchTeamSize,
            change,
            destination: source.destination,
            capturedAt: delegated.now(),
          });
        } catch (error) {
          // No autonomous grant covers this creation now (per-creation,
          // absent, exhausted or provision): it routes to its decider.
          if (
            error instanceof OperatorAuthorityError &&
            error.code === "AUTHORITY_OUT_OF_BOUNDS"
          ) return undefined;
          throw error;
        }
      };
    },
    async resumeCreation({ snapshot, requester, change }) {
      const delegated = options.delegated?.();
      const recorded = requester.requestNetworkDecisions?.[change.id]
        ?.authority;
      if (!delegated || recorded?.kind !== "creation-grant") {
        throw new OperatorAuthorityError(
          "AUTHORITY_OUT_OF_BOUNDS",
          "Branch team decisions are unavailable on this host",
          { caseId: snapshot.opening.caseId, changeId: change.id },
        );
      }
      const result = await delegated.decision.resume(
        {
          kind: "creation-grant",
          envelope: parseRequestCreationGrantAuthority(recorded.envelope),
        },
        snapshot.opening,
        change.requestedBy!,
        change.id,
      );
      if (result.status !== "adopted") {
        throw new RequestSpaceError(
          "UNAVAILABLE",
          "The recorded team creation is not adopted yet",
          {
            context: {
              caseId: snapshot.opening.caseId,
              changeId: change.id,
              status: result.status,
            },
            recovery:
              "Resumed at the Case's next settled turn or provisioning; inspect the adoption dossier if it stays blocked.",
          },
        );
      }
    },
    async decideCreation({ snapshot, requester, envelope, change }) {
      const delegated = options.delegated?.();
      if (!delegated) {
        throw new OperatorAuthorityError(
          "AUTHORITY_OUT_OF_BOUNDS",
          "Branch team decisions are unavailable on this host",
          { caseId: snapshot.opening.caseId, changeId: change.id },
        );
      }
      const result = await delegated.decision.decide(
        { kind: "creation-grant", envelope },
        snapshot.opening,
        {
          agentId: change.requestedBy!,
          caseId: snapshot.opening.caseId,
          changeId: change.id,
          expectedRevision: requester.revision,
          configurationRevision: change.baseRevision,
          verdict: "approve",
        },
      );
      // Decided in the background: a creation that did not reach adoption
      // is reported, never dropped. The record stands; the next settlement
      // resumes it.
      if (result.status !== "adopted") {
        throw new RequestSpaceError(
          "UNAVAILABLE",
          "The team creation was decided but is not adopted yet",
          {
            context: {
              caseId: snapshot.opening.caseId,
              changeId: change.id,
              status: result.status,
            },
            recovery:
              "Resumed at the Case's next settled turn or provisioning; inspect the adoption dossier if it stays blocked.",
          },
        );
      }
    },
    refused(detail) {
      log.warn("Request authority proof refused", { ...detail });
    },
  });
}

/** Replay once Main registers, then whenever what routes a pending request
 * changes: its admitted policies (a revocation or a new mandate may flip the
 * route), its model appearing (the only wait left) and its design scope. */
export async function bindMainAuthorityReplay(
  bridge: RequestSpaceAuthorityBridge,
  main: SystemRuntime,
): Promise<void> {
  const fingerprint = () => {
    const { executionModel } = main.snapshot;
    return canonical({
      operator: executionModel?.identity.builderId ?? null,
      policies: executionModel?.operatorAuthorityPolicies ?? null,
      designerScope: designerScopeId(main.snapshot),
    });
  };
  let observed = fingerprint();
  let replaying = Promise.resolve();
  const replay = () => {
    replaying = replaying.then(() => bridge.replay()).catch((error) =>
      log.error("Request authority replay failed", errorLogProperties(error))
    );
    return replaying;
  };
  main.onState(() => {
    const current = fingerprint();
    if (current === observed) return;
    observed = current;
    void replay();
  });
  // A woken notice persisted without its turn before a restart.
  await main.resumeNoticeWakes();
  await replay();
}

/** Shared by normal and cold Request construction; this never starts work. */
export function requestAuthorityLifecycleBindings(
  bridge: RequestSpaceAuthorityBridge,
  /** Schedules `bridge.settled` for a Case; see `requestTeamSettlement`. */
  settle?: (caseId: string) => void,
  registerBranch?: (
    record: Parameters<
      NonNullable<RequestSpaceRuntimeOptions["bindRequestAuthority"]>
    >[0],
    runtime: SystemRuntime,
  ) => void,
  admittedOperatorIds?: (
    record: Parameters<
      NonNullable<RequestSpaceRuntimeOptions["bindRequestAuthority"]>
    >[0],
  ) => Promise<readonly string[]>,
): Pick<
  RequestSpaceRuntimeOptions,
  "bindRequestAuthority" | "recoverRequestAuthority"
> {
  return {
    bindRequestAuthority(record, target) {
      // Called before initialization; the BO's seed identity is fixed by this opening.
      const isBranchOwner = () =>
        target.snapshot.executionModel?.identity.builderId ===
          record.base?.requestOwner.operatorId;

      target.bindOperatorAuthorityLifecycle({
        decisionContext: async () => {
          const empty = {
            policies: [],
            requests: [],
            awaitingPerson: [],
            awaitingPersonTruncated: false,
          };
          const model = target.snapshot.executionModel;
          if (!isBranchOwner() || !model) return undefined;
          const candidates = (model.operatorAuthorityPolicies ?? []).filter((
            policy,
          ) =>
            policy.enabled &&
            policy.holderNativeId === model.identity.builderId &&
            (policy.recipientExecutionSpaceId === undefined ||
              policy.recipientExecutionSpaceId === record.executionSpaceId) &&
            policy.recipients.some((id) => id !== model.identity.builderId)
          );
          if (!candidates.length) return undefined;
          const unavailable = (error: unknown) => {
            const detail = {
              code: "AUTHORITY_CONTEXT_UNAVAILABLE",
              context: {
                caseId: record.caseId,
                executionSpaceId: record.executionSpaceId,
              },
              recovery:
                "Restore the admitted Request binding and retry the turn.",
            };
            log.warn("Request authority decision context unavailable", {
              ...errorLogProperties(error),
              ...detail,
            });
            return { ...empty, error: detail };
          };
          if (!admittedOperatorIds) {
            return unavailable("Admission member reader is unavailable");
          }
          try {
            const members = new Set(
              (await admittedOperatorIds(record)).filter((id) =>
                id !== model.identity.builderId
              ),
            );
            if (
              !candidates.some((policy) =>
                policy.recipients.some((id) => members.has(id))
              )
            ) return undefined;
            const view = await bridge.branchView(record.caseId);
            const policies = view.policies.filter((policy) =>
              candidates.some((candidate) =>
                canonical(candidate) === canonical(policy)
              ) && policy.recipients.some((id) => members.has(id))
            );
            if (!policies.length) {
              return unavailable(
                "Admitted policy changed during decision context resolution",
              );
            }
            return { ...view, policies };
          } catch (error) {
            return unavailable(error);
          }
        },
        decide: async (command, origin) => {
          if (!isBranchOwner() || !origin) {
            throw new OperatorAuthorityError(
              "AUTHORITY_OUT_OF_BOUNDS",
              "Only the registered branch decider's native command may decide",
              { caseId: record.caseId, changeId: command.changeId },
            );
          }
          await bridge.decideInBranch({
            caseId: record.caseId,
            command,
            origin,
          });
        },
        async proposed(change) {
          await bridge.proposed(record.caseId, change.id);
        },
        approved: () => Promise.resolve(),
        async closed(closed) {
          if (closed.id === record.caseId) await bridge.closed(record.caseId);
        },
      });
    },
    async recoverRequestAuthority(record, target) {
      if (
        target.snapshot.executionModel?.identity.builderId ===
          record.base?.requestOwner.operatorId
      ) registerBranch?.(record, target);
      await target.resumeNoticeWakes();
      for (const change of target.snapshot.configuration?.changes ?? []) {
        if (
          change.status === "pending" && change.caseId === record.caseId &&
          !change.publishedCommit
        ) {
          await bridge.proposed(record.caseId, change.id);
        }
      }
      // A creation left pending by a restart: decided once the runtime is
      // provisioned, never inside this provisioning.
      settle?.(record.caseId);
    },
  };
}

/** One serialized, host-context driver per Case for `bridge.settled`: an
 * autonomous creation is decided after its creator's turn settles, outside
 * any worker's execution fence. A failure is logged and the next settlement
 * of the Case (or the next provisioning) tries again. */
export function requestTeamSettlement(
  bridge: () => RequestSpaceAuthorityBridge | undefined,
): (caseId: string) => Promise<void> {
  const chains = new Map<string, Promise<void>>();
  return bindHostBackgroundTask((caseId: string) => {
    const next = (chains.get(caseId) ?? Promise.resolve())
      .then(() => bridge()?.settled(caseId))
      .catch((error) =>
        log.error("Request team creation is blocked", {
          ...errorLogProperties(error),
          caseId,
        })
      );
    chains.set(caseId, next);
    return next;
  });
}
