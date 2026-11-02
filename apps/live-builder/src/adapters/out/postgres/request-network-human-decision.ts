import { reservedBranchTeamSize } from "../../../application/governance/request-space-authority-bridge.ts";
import {
  assertRequestCreationGrantAuthorityCurrent,
  assertRequestDelegatedAuthorityCurrent,
  isCreationGrantRequestAuthority,
  isSessionlessRequestAuthority,
  type RequestCreationGrantAuthorityEnvelope,
  type RequestDelegatedAuthorityEnvelope,
  requestWriteAuthorityDestination,
  requestWriteAuthorityMemberProvenanceMatches,
  requestWriteAuthorityPrior,
} from "../../../application/model/source-admission/request-delegated-authority.ts";
import type { PostgresSystemStateStore } from "./system-state-store.ts";
import { assertRequestSourceOwnerPhaseMatches } from "../../../application/model/source-admission/request-source-owner.ts";
import { PostgresRequestSourceAdmissionStore } from "./request-source-admission-store.ts";
import type { OpeningRecord } from "../../../domain/work/request-spaces.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type { SystemRuntime } from "../../../application/work/runtime/system.ts";
import type { RequestSpaceRuntime } from "../../work/request-space-runtime.ts";
import type { PostgresHostStorage } from "./host-storage.ts";
import type { PostgresRequestExecutionBindingReader } from "./request-execution-binding.ts";
import { PostgresSpaceCredentials } from "./request-space-control-store.ts";
import {
  postgresExecutionTransaction,
  withPostgresExecutionTransaction,
} from "./execution-transaction.ts";
import { RequestSpaceError } from "../../../domain/work/request-spaces.ts";
import { postgresQualifiedTable, Prisma } from "./client.ts";

type DecisionInput = Parameters<
  SystemRuntime["recordRequestNetworkDecision"]
>[0];

/** Commits only this decision under exact Request locks: the person's under
 * current control, the MO's with Main's policy and the route re-read in the
 * same transaction (4.8c A2). */
export class PostgresRequestNetworkHumanDecision {
  private readonly credentials: PostgresSpaceCredentials;
  constructor(
    private readonly options: {
      storage: PostgresHostStorage;
      runtime: RequestSpaceRuntime;
      binding: PostgresRequestExecutionBindingReader;
      /** The registered Main's state store; read locked for a delegated decision. */
      main?: Pick<PostgresSystemStateStore, "readLockedInTransaction">;
      /** Qualification hook before SQL locks; never used by production. */
      beforeAuthorityLock?: () => Promise<void>;
    },
  ) {
    this.credentials = new PostgresSpaceCredentials(
      options.storage.client,
      options.storage.primarySpaceControl,
    );
  }
  async record(opening: OpeningRecord, input: DecisionInput) {
    const { storage, runtime, binding } = this.options;
    const requester = isSessionlessRequestAuthority(input.authority)
      ? input.authority.requester
      : undefined;
    return await runtime.withInstructionAdoptionReservation(
      opening,
      input.reservationId,
      async ({ runtime: target, stores }) =>
        await target.recordRequestNetworkDecision(
          input,
          async (next, expectedRevision) => {
            const packet = stores.state.prepareSave(next, expectedRevision);
            let refusal:
              | Awaited<
                ReturnType<RequestSpaceRuntime["prepareNetworkRefusal"]>
              >
              | undefined;
            if (input.verdict === "refuse") {
              const change = next.configuration?.changes.find((entry) =>
                entry.id === input.changeId
              );
              const decision = next.requestNetworkDecisions?.[input.changeId];
              if (!change || !decision) {
                throw new Error(
                  "Prepared Request refusal is unavailable",
                );
              }
              try {
                refusal = await runtime.prepareNetworkRefusal(
                  opening,
                  change,
                  decision,
                );
              } catch (error) {
                if (
                  !(error instanceof RequestSpaceError) ||
                  error.code !== "UNAVAILABLE"
                ) throw error;
                // The human refusal still commits; an explicit retry may wake R0
                // once its exact checkpoint has become durable.
              }
            }
            await this.options.beforeAuthorityLock?.();
            await postgresExecutionTransaction(storage.client, async (tx) => {
              const authority = input.authority;
              const acceptance = isSessionlessRequestAuthority(authority)
                ? undefined
                : authority.acceptance;
              if (acceptance) {
                await this.credentials.assertCurrentController(
                  tx,
                  acceptance.principal.controller,
                  acceptance.principal.sessionRevision,
                );
              }
              const d = requestWriteAuthorityDestination(authority);
              const repositories = await tx.$queryRaw<
                Array<{ sourceScopeId: string }>
              >(Prisma.sql`SELECT "sourceScopeId" FROM ${
                postgresQualifiedTable(storage.client, "SourceRepository")
              } WHERE "projectId"=${opening.scope.projectId} AND "systemId"=${opening.scope.systemId} AND "repositoryId"=${d.repositoryId} FOR SHARE`);
              if (
                repositories.length !== 1 ||
                repositories[0].sourceScopeId !== opening.scope.systemId
              ) throw new Error("Request source repository unavailable");
              if (
                canonical(d.host) !== canonical(opening.scope) ||
                d.openingId !== opening.id ||
                d.executionSpaceId !== opening.executionSpaceId ||
                d.caseId !== opening.caseId ||
                d.branchId !== opening.branchId ||
                !!acceptance &&
                  acceptance.principal.controller.ownerId !== opening.ownerId
              ) throw new Error("Request decision target changed");
              const rows = await tx.$queryRaw<Array<{ id: string }>>(
                Prisma.sql`SELECT "id" FROM ${
                  postgresQualifiedTable(storage.client, "SpaceOpening")
                } WHERE "projectId"=${opening.scope.projectId} AND "systemId"=${opening.scope.systemId} AND "id"=${opening.id} FOR UPDATE`,
              );
              if (rows.length !== 1) {
                throw new Error("Request opening unavailable");
              }
              const spaces = await tx.$queryRaw<
                Array<{ lifecycle: string; closedAt: Date | null }>
              >(Prisma.sql`SELECT "lifecycle", "closedAt" FROM ${
                postgresQualifiedTable(storage.client, "ExecutionSpace")
              } WHERE "projectId"=${opening.scope.projectId} AND "systemId"=${opening.scope.systemId} AND "executionSpaceId"=${opening.executionSpaceId} FOR SHARE`);
              if (
                spaces.length !== 1 || spaces[0].lifecycle !== "active" ||
                spaces[0].closedAt !== null || !opening.admissionId
              ) throw new Error("Request space unavailable");
              const admissions = await tx.$queryRaw<
                Array<{ status: string; expiresAt: Date }>
              >(Prisma.sql`SELECT "status", "expiresAt" FROM ${
                postgresQualifiedTable(
                  storage.client,
                  "SpaceExecutionAdmission",
                )
              } WHERE "projectId"=${opening.scope.projectId} AND "systemId"=${opening.scope.systemId} AND "id"=${opening.admissionId} FOR SHARE`);
              if (
                admissions.length !== 1 || admissions[0].status !== "active"
              ) throw new Error("Request admission unavailable");
              const lock = await stores.state.lockMutationInTransaction(tx);
              const actual = await binding.readInTransaction(
                tx,
                opening,
                requester,
              );
              if (
                !actual.state.executionModel || !opening.base
              ) throw new Error("Request source owner unavailable");
              const readStates = async () => {
                const states:
                  import("../../../domain/work/dialogue.ts").SystemRuntimeState[] =
                    [];

                // The opening lock serializes team changes; lock every actor
                // whose persisted receipt or policy can designate the decider.
                await tx.$queryRaw(
                  Prisma.sql`SELECT "operatorId" FROM ${
                    postgresQualifiedTable(storage.client, "RuntimeState")
                  } WHERE "projectId"=${opening.scope.projectId} AND "systemId"=${opening.scope.systemId} AND "executionSpaceId"=${opening.executionSpaceId} AND "operatorId" IN (${
                    Prisma.join(actual.admission.permissions.operatorIds)
                  }) ORDER BY "operatorId" FOR SHARE`,
                );
                for (
                  const operatorId of actual.admission.permissions.operatorIds
                ) {
                  states.push(
                    operatorId ===
                        actual.state.executionModel!.identity.builderId
                      ? actual.state
                      : (await binding.readOperatorInTransaction(
                        tx,
                        opening,
                        operatorId,
                      )).state,
                  );
                }
                return states;
              };
              if (acceptance) {
                assertRequestSourceOwnerPhaseMatches(acceptance, {
                  destination: d,
                  openingOwnerId: opening.ownerId,
                  targetOperatorId: opening.base.requestOwner.operatorId,
                  priorModel: actual.state.executionModel,
                }, storage.primarySpaceControl.binding);
              } else if (isCreationGrantRequestAuthority(authority)) {
                // Revocation is checked with the record: the branch-read
                // grant, the whole-team size on the locked admission, and
                // the pending change (4.8e E4, A2 analog).
                const change = actual.state.configuration?.changes.find((
                  entry,
                ) => entry.id === input.changeId);
                const model = actual.state.executionModel;
                if (!change) {
                  throw new Error("The pending change is unavailable");
                }
                const states = await readStates();
                assertRequestCreationGrantAuthorityCurrent(
                  authority as RequestCreationGrantAuthorityEnvelope,
                  {
                    opening,
                    admission: actual.admission,
                    request: actual.state,
                    space: {
                      projectId: model.identity.projectId,
                      systemId: model.identity.systemId,
                      executionSpaceId: opening.executionSpaceId,
                    },
                    branchTeamSize: reservedBranchTeamSize(
                      actual.admission,
                      states,
                      opening.caseId,
                    ),
                    change,
                  },
                );
              } else {
                // Revocation is checked with the record: Main's policy, the
                // route, the admission and the pending change, all locked.
                const main = await this.options.main?.readLockedInTransaction(
                  tx,
                );
                const change = actual.state.configuration?.changes.find((
                  entry,
                ) => entry.id === input.changeId);
                const model = actual.state.executionModel;
                if (!main || !change) {
                  throw new Error("Main or the pending change is unavailable");
                }
                const states = await readStates();
                assertRequestDelegatedAuthorityCurrent(
                  authority as RequestDelegatedAuthorityEnvelope,
                  {
                    opening,
                    admission: actual.admission,
                    request: actual.state,
                    space: {
                      projectId: model.identity.projectId,
                      systemId: model.identity.systemId,
                      executionSpaceId: opening.executionSpaceId,
                    },
                    main,
                    states,
                    change,
                  },
                );
              }
              const chain = await new PostgresRequestSourceAdmissionStore(
                storage.client,
              ).readAdmittedSource(tx, opening);
              if (
                canonical({
                  revision: chain.head.revision,
                  source: chain.head.source,
                  sourceDigest: chain.head.sourceDigest,
                }) !== canonical(d.expectedAdmittedSource)
              ) throw new Error("Request source predecessor changed");
              const prior = requestWriteAuthorityPrior(authority);
              if (
                actual.state.revision !== expectedRevision ||
                actual.pin.modelDigest !== prior.version.digest ||
                actual.pin.source.version !== prior.version.repositoryVersion ||
                !requestWriteAuthorityMemberProvenanceMatches(
                  authority,
                  actual.state.executionModel!,
                ) ||
                canonical(actual.state.executionModel?.identity) !==
                  canonical(prior.identity)
              ) throw new Error("Request execution pin changed");
              if (acceptance) {
                await this.credentials.assertCurrentController(
                  tx,
                  acceptance.principal.controller,
                  acceptance.principal.sessionRevision,
                );
              }
              const [clock] = await tx.$queryRaw<Array<{ valid: boolean }>>(
                Prisma.sql`SELECT ${
                  admissions[0].expiresAt
                } > clock_timestamp() AS valid`,
              );
              if (!clock?.valid) throw new Error("Request admission expired");
              await stores.state.savePreparedInTransaction(tx, packet, lock);
              if (refusal) {
                await withPostgresExecutionTransaction({
                  client: storage.client,
                  transaction: tx,
                }, () => refusal!.enqueue());
              }
              // Save and enqueue can wait on further locks. Recheck authority and expiry after it;
              // any failure rolls the prepared state and revision back with the tx.
              if (acceptance) {
                await this.credentials.assertCurrentController(
                  tx,
                  acceptance.principal.controller,
                  acceptance.principal.sessionRevision,
                );
              }
              const [finalClock] = await tx.$queryRaw<
                Array<{ valid: boolean }>
              >(Prisma.sql`SELECT ${
                admissions[0].expiresAt
              } > clock_timestamp() AS valid`);
              if (!finalClock?.valid) {
                throw new Error("Request admission expired before commit");
              }
            });
          },
        ),
      requester,
    );
  }
}
