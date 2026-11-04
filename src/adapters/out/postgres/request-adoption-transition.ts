import { assertRequestCancellationNativePins } from "../../../application/model/evolution/request-adoption-cancellation.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { type OpeningRecord } from "../../../domain/work/request-spaces.ts";
import { sameOwnerAuthorityIdentity } from "../../../domain/governance/authority.ts";
import { sameSpaceControlPrincipal } from "../../../domain/work/request-space-authority.ts";
import { isOpenCase } from "../../../domain/work/entities/cases.ts";
import { requestExecutionPinFor } from "../../../application/model/evolution/request-execution-pin.ts";
import {
  invocationKey,
  requestChangeInvocation,
} from "../../../application/work/operators/journal.ts";
import {
  type RequestAdoptionDecision,
  RequestAdoptionError,
  type RequestAdoptionIntent,
  type RequestAdoptionManifest,
  type RequestAdoptionSession,
  type RequestAdoptionTransitionPort,
  type RequestOwnerAdoptionDossier,
} from "../../../application/model/evolution/request-adoption-ports.ts";
import {
  adoptionRequester,
  assertRequestTeamPublicationBase,
  assertSameRequestAdoptionCompletion,
  parseRequestOwnerAdoptionDossier,
} from "../../../application/model/evolution/request-adoption-invariants.ts";
import { requestWriteAuthorityPrior } from "../../../application/model/source-admission/request-delegated-authority.ts";
import { prepareRequestInstructionStates } from "../../../application/work/runtime/request-instruction-adoption.ts";
import {
  readRequestCreationPolicySourceAdmissionProof,
  readRequestNetworkSourceAdmissionProof,
  readRequestTeamSourceAdmissionProof,
} from "./request-source-publication-participant.ts";
import {
  emptyNativeEvolutionAwait,
  exactNativeChangeApprovalWait,
} from "../../../application/work/runtime/evolution.ts";
import { runtimeRevisionReference } from "../../../application/work/native-execution/contract.ts";
import type {
  RequestSpaceRuntime,
  RequestSpaceRuntimeDependencies,
} from "../../../application/work/request-spaces/runtime.ts";
import type { PostgresAdmittedRequestRuntime } from "../native-execution/postgres.ts";
import { parseNeverStartedAdoptionSource } from "../../../application/work/evolution/native-adoption-successor.ts";
import {
  canonicalDigest,
  sha256,
} from "../../../domain/primitives/execution-digest.ts";
import type { OperatorStorage } from "./host-storage.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { PostgresEvolutionStore } from "./evolution-store.ts";
import type { PostgresRequestExecutionBindingReader } from "./request-execution-binding.ts";
import type { PostgresRequestSourceAdmissionStore } from "./request-source-admission-store.ts";
import {
  decodeSpaceExecutionAdmission,
  PostgresSpaceCredentials,
} from "./request-space-control-store.ts";
import {
  currentPostgresExecutionTransaction,
  withPostgresExecutionTransaction,
} from "./execution-transaction.ts";
import type { PostgresPrimarySpaceControlSource } from "./primary-space-control-source.ts";
import { postgresQualifiedTable, Prisma, type PrismaClient } from "./client.ts";

function conflict(message: string): never {
  throw new RequestAdoptionError("CONFLICT", message, {
    context: { operation: "request-adoption", reason: message },
    recovery:
      "Reload the recorded adoption dossier and current Request binding before retrying.",
  });
}

/** Only the machine code belongs in the serializable context; the original
 * error remains the cause for the private technical journal. */
function adoptionFailureCause(error: unknown) {
  const record = error as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  } | null;
  const code = record?.code === "P2010"
    ? record.meta?.driverAdapterError?.cause?.originalCode ?? record.code
    : record?.code;
  return { code: typeof code === "string" ? code : "UNEXPECTED_ERROR" };
}

/** Admission is shared by the branch. Only this target's digest advances;
 * a team proof adds exactly its new child while preserving every bystander. */
export function requestAdoptionPermissions(
  opening: OpeningRecord,
  intent: RequestAdoptionIntent,
) {
  const before = intent.previous.admission.permissions;
  const owner = opening.base!.requestOwner.operatorId;
  const target = intent.target.operatorId;
  const index = before.operatorIds.indexOf(target);
  if (
    before.operatorIds[0] !== owner || index < 0 ||
    before.modelDigests[index] !== intent.previous.pin.modelDigest
  ) conflict("The exact admitted adoption target changed.");
  const digests = [...before.modelDigests];
  digests[index] = intent.candidate.model.version.digest;
  let operatorIds = [...before.operatorIds];
  let modelDigests = digests;
  if (intent.team) {
    operatorIds = [
      owner,
      ...intent.team.team.map((member) => member.operatorId),
    ];
    modelDigests = [
      target === owner
        ? intent.candidate.model.version.digest
        : before.modelDigests[0],
      ...intent.team.team.map((member) => member.modelDigest),
    ];
    if (
      target !== owner &&
      (operatorIds.length !== before.operatorIds.length + 1 ||
        new Set(operatorIds).size !== operatorIds.length ||
        before.operatorIds.some((id, i) =>
          operatorIds.indexOf(id) < 0 ||
          modelDigests[operatorIds.indexOf(id)] !== digests[i]
        ) ||
        canonical(operatorIds.slice(0, before.operatorIds.length)) !==
          canonical(before.operatorIds))
    ) {
      conflict(
        "The candidate team changed a bystander or the adoption target.",
      );
    }
  }
  return {
    ...before,
    sourceVersion: target === owner
      ? intent.candidate.source.version
      : before.sourceVersion,
    operatorIds,
    modelDigests,
  };
}
/** Concrete atomic composition only. No application port exposes Prisma/SQL callbacks. */
export class PostgresRequestAdoptionTransition
  implements RequestAdoptionTransitionPort {
  readonly #credentials: PostgresSpaceCredentials;
  constructor(
    private readonly options: {
      client: PrismaClient;
      primary: PostgresPrimarySpaceControlSource;
      runtime: RequestSpaceRuntime<OperatorStorage>;
      native: PostgresAdmittedRequestRuntime;
      store: PostgresEvolutionStore;
      binding: PostgresRequestExecutionBindingReader;
      journal: PostgresRequestSourceAdmissionStore;
      opening(caseId: string): Promise<OpeningRecord>;
      dependencies(
        stores: OperatorStorage,
        model: ExecutableModel,
        current: () => SystemRuntimeState | undefined,
      ): RequestSpaceRuntimeDependencies;
      now(): string;
      fault?(
        phase:
          | "after-authorization"
          | "after-native"
          | "after-state"
          | "before-commit"
          | "after-commit",
      ): void | Promise<void>;
    },
  ) {
    this.#credentials = new PostgresSpaceCredentials(
      options.client,
      options.primary,
    );
  }

  async attempt(
    input: RequestOwnerAdoptionDossier,
    completionInput: RequestAdoptionDecision,
  ): Promise<RequestOwnerAdoptionDossier> {
    let dossier = await parseRequestOwnerAdoptionDossier(input);
    const completion = assertSameRequestAdoptionCompletion(
      dossier.intent,
      completionInput,
    );
    if (dossier.receipt) return dossier;
    const inherited = currentPostgresExecutionTransaction();
    if (inherited?.session || inherited?.transaction || inherited?.fence) {
      throw new RequestAdoptionError(
        "BLOCKED",
        "Adoption cannot run inside a native delivery or inherited execution fence.",
      );
    }
    const opening = await this.options.opening(dossier.intent.target.caseId);
    if (opening.id !== dossier.intent.target.openingId) {
      conflict("The original Request opening changed.");
    }
    try {
      return await this.options.runtime.withInstructionAdoptionReservation(
        opening,
        dossier.id,
        async ({ runtime, stores }) => {
          const changeProof = dossier.intent.network ?? dossier.intent.team ??
            dossier.intent.creationPolicy;
          const checkpoint = await runtime.evolutionBoundary(
            dossier.id,
            undefined,
            changeProof
              ? {
                changeId: changeProof.changeId,
                caseId: dossier.intent.target.caseId,
              }
              : undefined,
          );
          if (!checkpoint.safe) {
            if (dossier.status === "armed") {
              throw new RequestAdoptionError(
                "BLOCKED",
                "The armed adoption remains blocked until its exact boundary is proved.",
                {
                  context: {
                    dossierId: dossier.id,
                    adoptionKey: dossier.intent.adoptionKey,
                    blockers: checkpoint.blockers,
                  },
                },
              );
            }
            const next = await parseRequestOwnerAdoptionDossier({
              ...dossier,
              revision: dossier.revision + 1,
              updatedAt: this.options.now(),
              blockers: checkpoint.blockers,
            });
            return await this.options.store.requestAdoptions.compareAndSwap(
              dossier.intent.target,
              dossier.id,
              dossier.revision,
              next,
            );
          }
          // The prior native selection is a historical fact from the same
          // snapshot as current execution, never a fresh grant of authority.
          const { binding, previousSuccessors } = await this.options.client
            .$transaction(async (tx) => {
              // Binding may lock the already-published network receipt for a
              // consistent historical read; no writes are performed here.
              const binding = await this.options.binding.readInTransaction(
                tx,
                opening,
                adoptionRequester(dossier.intent),
              );
              const chain = await this.options.journal.readAdmittedSource(
                tx,
                opening,
              );
              if (
                canonical(
                  requestExecutionPinFor(
                    chain.execution,
                    dossier.intent.target.operatorId,
                    opening.base!,
                  ),
                ) !== canonical(binding.pin)
              ) {
                conflict("The prior native selection changed.");
              }
              const last = chain.execution.adoptions.filter((entry) =>
                entry.manifest.intent.target.operatorId ===
                  dossier.intent.target.operatorId
              ).at(-1);
              if (
                binding.pin.adoption &&
                (!last ||
                  last.manifest.commandId !== binding.pin.adoption.commandId ||
                  last.receipt.receiptDigest !==
                    binding.pin.adoption.receiptDigest ||
                  last.manifest.committedRuntimeRevision !==
                    binding.pin.adoption.committedRuntimeRevision)
              ) conflict("The last executed adoption proof is unavailable.");
              return {
                binding,
                previousSuccessors: {
                  currentPin: binding.pin,
                  // One exact latest receipt exhausts possible current inert
                  // successors; older executed versions cannot authorize one.
                  adoptions: binding.pin.adoption && last ? [last] : [],
                },
              };
            }, { isolationLevel: "RepeatableRead" });
          if (
            canonical(binding.pin) !== canonical(dossier.intent.previous.pin) ||
            canonical(binding.admission) !==
              canonical(dossier.intent.previous.admission)
          ) conflict("The original execution pin or admission changed.");
          const scoped = await this.options.native.forCaseSpace(
            opening.executionSpaceId,
            opening.caseId,
          );
          const executions = await scoped.execution.inspect(
            dossier.intent.target.operatorId,
          );
          const selected = executions.filter((execution) =>
            emptyNativeEvolutionAwait(binding.state, execution) ||
            Boolean(
              changeProof && exactNativeChangeApprovalWait(
                binding.state,
                execution,
                binding.state.executionModel!,
                {
                  changeId: changeProof.changeId,
                  proposalIntentDigest: changeProof.proposalIntentDigest,
                  caseId: dossier.intent.target.caseId,
                },
              ),
            )
          );
          const projected = { current: structuredClone(binding.state) };
          projected.current.executionModel = structuredClone(
            dossier.intent.candidate.model,
          );
          projected.current.model = structuredClone(
            dossier.intent.candidate.model.identity,
          );
          const dependencies = this.options.dependencies(
            stores,
            dossier.intent.candidate.model,
            () => projected.current,
          );
          const states = await prepareRequestInstructionStates({
            state: binding.state,
            intent: dossier.intent,
            commandId: dossier.id,
            at: this.options.now(),
            hasConsultModel: Boolean(dependencies.information?.consultModel),
            modelTools: dependencies.information?.modelTools?.(
              dossier.intent.candidate.model,
            ),
          });
          projected.current = states.adopted;
          const authorizationPacket = stores.state.prepareSave(
              states.authorization,
              binding.state.revision,
            ),
            adoptedPacket = stores.state.prepareSave(
              states.adopted,
              states.authorization.revision,
            );
          const nativePacket = await scoped.ledger.prepareRetirementBatch(
            selected,
            {
              kind: "owner-adoption",
              businessRevision: runtimeRevisionReference(states.authorization),
              authorizationEventId: states.authorizationEventId,
              ...(dossier.intent.creationPolicy
                ? {
                  creationPolicy: dossier.intent.creationPolicy,
                  creationPolicyCompatibilityDigest:
                    dossier.intent.candidate.compatibilityDigest,
                }
                : dossier.intent.network
                ? {
                  network: dossier.intent.network,
                  networkCompatibilityDigest:
                    dossier.intent.candidate.compatibilityDigest,
                }
                : dossier.intent.team
                ? {
                  team: dossier.intent.team,
                  teamCompatibilityDigest:
                    dossier.intent.candidate.compatibilityDigest,
                }
                : {}),
            },
            dossier.intent.candidate.model,
            previousSuccessors,
          );
          if (changeProof) {
            const matching = selected.filter((execution) =>
              Boolean(exactNativeChangeApprovalWait(
                binding.state,
                execution,
                binding.state.executionModel!,
                {
                  changeId: changeProof.changeId,
                  proposalIntentDigest: changeProof.proposalIntentDigest,
                  caseId: dossier.intent.target.caseId,
                },
              ))
            );
            if (matching.length !== 1) {
              conflict("The exact approval wait is unavailable.");
            }
            const wait = exactNativeChangeApprovalWait(
              binding.state,
              matching[0],
              binding.state.executionModel!,
              {
                changeId: changeProof.changeId,
                proposalIntentDigest: changeProof.proposalIntentDigest,
                caseId: dossier.intent.target.caseId,
              },
            )!;
            if (dossier.intent.team) {
              await scoped.ledger.prepareTeamApprovalCheckpoint(
                nativePacket,
                matching[0],
                wait,
              );
            } else {
              await scoped.ledger.prepareNetworkApprovalCheckpoint(
                nativePacket,
                matching[0],
                wait,
              );
            }
          }
          if (dossier.status === "prepared") {
            const armed = await parseRequestOwnerAdoptionDossier({
              ...dossier,
              revision: dossier.revision + 1,
              status: "armed",
              updatedAt: this.options.now(),
              completion,
              blockers: [],
            });
            const swap = await this.options.store.prepareRequestSwap(
              dossier.intent.target,
              dossier.id,
              dossier.revision,
              armed,
            );
            await this.options.client.$transaction(async (tx) => {
              await tx.$executeRaw(
                Prisma.sql`SET LOCAL lock_timeout = '250ms'`,
              );
              const nativeLock = await scoped.ledger
                .lockRetirementInTransaction(tx, nativePacket);
              await this.lockAndValidate(tx, opening, dossier, completion);
              const dossierLock = await this.options.store
                .lockRequestMutationInTransaction(tx, swap);
              await stores.state.lockMutationInTransaction(tx);
              await this.validateBoundaryState(
                tx,
                opening,
                dossier,
                binding.state,
              );
              await scoped.ledger.assertRetirementPreparedLocked(
                tx,
                nativePacket,
                nativeLock,
              );
              await this.assertCutoff(tx, dossier, completion);
              await this.options.store.swapRequestPreparedLocked(
                tx,
                swap,
                dossierLock,
              );
            }, {
              isolationLevel: "ReadCommitted",
              maxWait: 500,
              timeout: 5_000,
            });
            dossier = armed;
            this.options.store.notifyRequestCommitted(armed);
          }
          if (dossier.status !== "armed") {
            throw new RequestAdoptionError(
              "BLOCKED",
              "The exact adoption is not armed.",
            );
          }
          const result = await this.options.client.$transaction(async (tx) => {
            await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '250ms'`);
            const nativeLock = await scoped.ledger.lockRetirementInTransaction(
              tx,
              nativePacket,
            );
            const chain = await this.lockAndValidate(
              tx,
              opening,
              dossier,
              completion,
            );
            const stateLock = await stores.state.lockMutationInTransaction(tx);
            await this.validateBoundaryState(
              tx,
              opening,
              dossier,
              binding.state,
            );
            await scoped.ledger.assertRetirementPreparedLocked(
              tx,
              nativePacket,
              nativeLock,
            );
            // One database cutoff after ALL selected locks and before the first write.
            await this.assertCutoff(tx, dossier, completion);
            await stores.state.savePreparedInTransaction(
              tx,
              authorizationPacket,
              stateLock,
            );
            await this.options.fault?.("after-authorization");
            const nativeRetirement = await scoped.ledger.retirePreparedLocked(
              tx,
              nativePacket,
              nativeLock,
            );
            await this.options.fault?.("after-native");
            await stores.state.savePreparedInTransaction(
              tx,
              adoptedPacket,
              stateLock,
            );
            await this.options.fault?.("after-state");
            const before = dossier.intent.previous.admission;
            // A team adoption writes the whole verified candidate team
            // (E4); any other adoption preserves the admitted team.
            const permission = requestAdoptionPermissions(
              opening,
              dossier.intent,
            );
            const manifest: RequestAdoptionManifest = {
              format: "request-runtime-adoption/v2",
              commandId: dossier.id,
              intent: dossier.intent,
              completion,
              predecessor: chain.cursor,
              sourceHead: {
                revision: chain.head.revision,
                manifestDigest: chain.head.manifestDigest,
              },
              previousRuntimeRevision: binding.state.revision,
              authorizationRuntimeRevision: states.authorization.revision,
              committedRuntimeRevision: states.adopted.revision,
              admissionRevision: before.revision + 1,
              nativeRetirement,
            };
            const journalPacket = await this.options.journal
              .prepareAdoptionAppend(opening, manifest);
            const receipt = await this.options.journal
              .appendAdoptionPreparedLocked(tx, opening, journalPacket);
            // The immutable exact manifest is visible to the admission trigger
            // in this SAME transaction; all native/state/journal effects still
            // roll back together if this guarded pin CAS or completion fails.
            const advanced = await tx.spaceExecutionAdmission.updateMany({
              where: {
                ...opening.scope,
                id: before.id,
                openingId: opening.id,
                executionSpaceId: opening.executionSpaceId,
                revision: before.revision,
                status: "active",
                capabilityId: before.capabilityId,
                capabilityRevision: before.capabilityRevision,
              },
              data: {
                revision: before.revision + 1,
                permissionsJson: canonical(permission),
              },
            });
            if (advanced.count !== 1) {
              conflict("The exact execution admission changed.");
            }
            const adopted = await parseRequestOwnerAdoptionDossier({
              ...dossier,
              revision: dossier.revision + 1,
              status: "adopted",
              updatedAt: receipt.recordedAt,
              completion,
              receipt,
              blockers: [],
            });
            const swap = await this.options.store.prepareRequestSwap(
              dossier.intent.target,
              dossier.id,
              dossier.revision,
              adopted,
            );
            const dossierLock = await this.options.store
              .lockRequestMutationInTransaction(tx, swap);
            await this.options.store.swapRequestPreparedLocked(
              tx,
              swap,
              dossierLock,
            );
            if (changeProof) {
              const matches = selected.flatMap((snapshot) => {
                const wait = exactNativeChangeApprovalWait(
                  binding.state,
                  snapshot,
                  binding.state.executionModel!,
                  {
                    changeId: changeProof.changeId,
                    proposalIntentDigest: changeProof.proposalIntentDigest,
                    caseId: opening.caseId,
                  },
                );
                return wait ? [{ snapshot, wait }] : [];
              });
              if (matches.length !== 1) {
                conflict("The exact network continuation wait is unavailable.");
              }
              const { snapshot, wait } = matches[0];
              const index = nativeRetirement.predecessorThreadIds.indexOf(
                snapshot.threadId,
              );
              const successorThreadId =
                nativeRetirement.successorThreadIds[index];
              if (index < 0 || !successorThreadId || !snapshot.checkpointId) {
                conflict("The network continuation successor is unavailable.");
              }
              const networkAdoption = {
                commandId: dossier.id,
                receiptDigest: receipt.receiptDigest,
                changeId: wait.changeId,
                proposalIntentDigest: wait.proposalIntentDigest,
                predecessorThreadId: snapshot.threadId,
                checkpointId: snapshot.checkpointId,
                successorThreadId,
                originalInputMessageId: wait.inputMessageId,
              };
              const proofKind = dossier.intent.team ? "team" : "network";
              const invocation = requestChangeInvocation(
                binding.state,
                changeProof.changeId,
                opening.caseId,
                wait.inputMessageId,
              );
              if (invocationKey(invocation) !== wait.identity.invocationKey) {
                conflict("The exact adoption continuation invocation changed.");
              }
              await withPostgresExecutionTransaction({
                client: this.options.client,
                transaction: tx,
              }, () =>
                scoped.dispatch.enqueue({
                  id: `${proofKind}-adoption:${receipt.receiptDigest}`,
                  kind: "continuation",
                  identity: structuredClone(wait.identity),
                  modelPin: {
                    modelDigest: dossier.intent.candidate.model.version.digest,
                    repositoryVersion: dossier.intent.candidate.source.version,
                  },
                  payload: {
                    inputMessageId: wait.inputMessageId,
                    invocation,
                    ...(proofKind === "team"
                      ? { teamAdoption: networkAdoption }
                      : { networkAdoption }),
                  },
                }));
            }
            await this.options.fault?.("before-commit");
            return adopted;
          }, { isolationLevel: "ReadCommitted", maxWait: 500, timeout: 5_000 });
          this.options.store.notifyRequestCommitted(result);
          await this.options.fault?.("after-commit");
          // Reconstruction has no authority/effect and follows the committed pin. A
          // failure leaves the durable receipt recoverable and R1 unavailable.
          await this.options.runtime.restoreInstructionAdoption(opening);
          return result;
        },
        adoptionRequester(dossier.intent),
      );
    } catch (error) {
      // An uncertain acknowledgement never authorizes another effect or barrier
      // release. Read the same durable identity first, including post-commit
      // reconstruction/listener failures.
      const observed = await this.options.store.requestAdoptions.get(
        dossier.intent.target,
        dossier.id,
      );
      if (observed?.receipt) return observed;
      if (observed?.status === "prepared") {
        const detail = error instanceof RequestAdoptionError
          ? error.message
          : "The exact R0 safe boundary could not be proved. The previous execution version is preserved.";
        const next = await parseRequestOwnerAdoptionDossier({
          ...observed,
          revision: observed.revision + 1,
          updatedAt: this.options.now(),
          blockers: [{
            code: error instanceof RequestAdoptionError
              ? error.code
              : "SETTLE_R0_FIRST",
            detail,
          }],
        });
        return await this.options.store.requestAdoptions.compareAndSwap(
          observed.intent.target,
          observed.id,
          observed.revision,
          next,
        );
      }
      if (error instanceof RequestAdoptionError) throw error;
      throw new RequestAdoptionError(
        "BLOCKED",
        "The original adoption remains armed or unknown. Inspect or resume the same key.",
        {
          cause: error,
          context: {
            dossierId: dossier.id,
            adoptionKey: dossier.intent.adoptionKey,
            cause: adoptionFailureCause(error),
          },
          recovery:
            "Inspect or resume this same adoption key; do not create another adoption.",
        },
      );
    }
  }

  /** Explicit same-key cancellation, under current READ rights, issues no new
   * adoption authority. Final effects are atomic: unchanged R0 state/admission,
   * strict absent journal receipt and no native R1 selection prove no effect.
   * Ambiguous/mixed facts retain the blocker; connection errors prove nothing. */
  async settleObsolete(
    input: RequestOwnerAdoptionDossier,
    session?: RequestAdoptionSession,
  ): Promise<RequestOwnerAdoptionDossier | null> {
    const dossier = await parseRequestOwnerAdoptionDossier(input),
      target = dossier.intent.target;
    const opening = await this.options.opening(target.caseId);
    // Only a sessionless dossier is settled without a session (4.8c A1).
    const delegated = dossier.intent.decision.kind !==
      "request-human-adoption-decision";
    if (
      (session ? opening.ownerId !== session.controller.ownerId : !delegated) ||
      opening.id !== target.openingId
    ) {
      throw new RequestAdoptionError(
        "FORBIDDEN",
        "The original Request is unavailable to this reader.",
      );
    }
    const result = await this.options.client.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout='250ms'`);
      if (session) {
        await this.#credentials.assertCurrentController(
          tx,
          session.controller,
          session.sessionRevision,
        );
      }
      await tx.$queryRaw(
        Prisma.sql`SELECT "repositoryId" FROM ${
          postgresQualifiedTable(this.options.client, "SourceRepository")
        } WHERE "projectId"=${target.host.projectId} AND "systemId"=${target.host.systemId} AND "repositoryId"=${target.repositoryId} FOR UPDATE NOWAIT`,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM ${
          postgresQualifiedTable(this.options.client, "EvolutionDossier")
        } WHERE "projectId"=${target.host.projectId} AND "systemId"=${target.host.systemId} AND "id"=${dossier.id} FOR UPDATE NOWAIT`,
      );
      const stored = await tx.evolutionDossier.findUnique({
        where: { projectId_systemId_id: { ...target.host, id: dossier.id } },
      });
      if (
        !stored || stored.kind !== "request-owner-adoption-v2" ||
        stored.targetScopeKey !== `request:${target.executionSpaceId}` ||
        stored.executionSpaceId !== target.executionSpaceId
      ) conflict("The original adoption dossier is unavailable.");
      const current = await parseRequestOwnerAdoptionDossier(
        JSON.parse(stored.payload),
      );
      if (
        canonical(current.intent) !== canonical(dossier.intent) ||
        current.revision !== Number(stored.revision)
      ) conflict("The original adoption intent changed.");
      // A committed completion is returned before every obsolete-intent check.
      const chainBefore = await this.options.journal.readAdmittedSource(
          tx,
          opening,
        ),
        committed = chainBefore.execution.adoptions.find((entry) =>
          entry.manifest.commandId === current.id
        );
      if (committed) {
        if (
          !current.receipt ||
          canonical(current.receipt) !== canonical(committed.receipt) ||
          canonical(committed.manifest.intent) !== canonical(current.intent)
        ) {
          throw new RequestAdoptionError(
            "UNAVAILABLE",
            "The exact completion facts disagree; the barrier is retained.",
          );
        }
        return current;
      }
      if (current.receipt) {
        throw new RequestAdoptionError(
          "UNAVAILABLE",
          "The exact journal receipt is unavailable; the barrier is retained.",
        );
      }
      if (current.status === "cancelled" || current.status === "refused") {
        return current;
      }
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM ${
          postgresQualifiedTable(this.options.client, "SpaceOpening")
        } WHERE "projectId"=${target.host.projectId} AND "systemId"=${target.host.systemId} AND "id"=${target.openingId} FOR UPDATE NOWAIT`,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "executionSpaceId" FROM ${
          postgresQualifiedTable(this.options.client, "ExecutionSpace")
        } WHERE "projectId"=${target.host.projectId} AND "systemId"=${target.host.systemId} AND "executionSpaceId"=${target.executionSpaceId} FOR SHARE NOWAIT`,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM ${
          postgresQualifiedTable(this.options.client, "SpaceExecutionAdmission")
        } WHERE "projectId"=${target.host.projectId} AND "systemId"=${target.host.systemId} AND "id"=${current.intent.previous.admission.id} FOR UPDATE NOWAIT`,
      );
      const parent = await tx.operatorRuntime.updateMany({
        where: {
          ...target.host,
          executionSpaceId: target.executionSpaceId,
          operatorId: target.operatorId,
        },
        data: { operatorId: target.operatorId },
      });
      if (parent.count !== 1) {
        conflict("The original native parent is unavailable.");
      }
      const binding = await this.options.binding.readInTransaction(
          tx,
          opening,
          adoptionRequester(current.intent),
        ),
        chain = await this.options.journal.readAdmittedSource(tx, opening);
      const oldAdmission = current.intent.previous.admission,
        admission = binding.admission;
      const sameAdmission = (value: typeof admission) => {
        const { revision: _revision, status: _status, ...rest } = value;
        return rest;
      };
      if (
        canonical(binding.pin) !== canonical(current.intent.previous.pin) ||
        canonical(sameAdmission(admission)) !==
          canonical(sameAdmission(oldAdmission)) ||
        binding.state.events.some((event) =>
          event.id === `${current.id}:authorization` ||
          event.id === `${current.id}:admitted` ||
          event.effectiveModelUpdate?.dossierId === current.id
        )
      ) {
        throw new RequestAdoptionError(
          "UNAVAILABLE",
          "The no-effect R0 facts disagree; the barrier is retained.",
        );
      }
      const native = await tx.$queryRaw<
        Array<
          {
            threadId: string;
            predecessorThreadId: string | null;
            identityJson: string;
            retiredAt: Date | null;
            authorizedPinJson: string | null;
            advanceAuthorizationJson: string | null;
            pinJson: string | null;
          }
        >
      >(Prisma
        .sql`SELECT e."threadId",e."predecessorThreadId",e."identityJson",e."retiredAt",e."authorizedPinJson",e."advanceAuthorizationJson",r."pinJson" FROM ${
        postgresQualifiedTable(this.options.client, "OperatorExecution")
      } e LEFT JOIN ${
        postgresQualifiedTable(this.options.client, "ExecutionRun")
      } r ON r."projectId"=e."projectId" AND r."systemId"=e."systemId" AND r."executionSpaceId"=e."executionSpaceId" AND r."operatorId"=e."operatorId" AND r."threadId"=e."threadId" AND r."runId"=e."currentRunId" WHERE e."projectId"=${target.host.projectId} AND e."systemId"=${target.host.systemId} AND e."executionSpaceId"=${target.executionSpaceId} AND e."operatorId"=${target.operatorId} ORDER BY e."threadId" LIMIT 257`);
      if (!native.length || native.length > 256) {
        throw new RequestAdoptionError(
          "UNAVAILABLE",
          "The complete native no-effect proof is unavailable.",
        );
      }
      for (const row of native) {
        const authorization = row.advanceAuthorizationJson
          ? JSON.parse(row.advanceAuthorizationJson)
          : null;
        if (authorization !== null) {
          const eventId = authorization?.authorization?.authorizationEventId;
          const recorded = chain.execution.adoptions.find((entry) =>
            eventId === `${entry.manifest.commandId}:authorization`
          );
          if (
            eventId === `${current.id}:authorization` || !recorded ||
            authorization.authorization.kind !== "owner-adoption" ||
            canonical(authorization.target) !==
              canonical({
                identity: recorded.manifest.intent.candidate.model.identity,
                version: recorded.manifest.intent.candidate.model.version,
              }) ||
            authorization.authorization.businessRevision
                ?.__assemblyRuntimeRevision?.revision !==
              recorded.manifest.authorizationRuntimeRevision
          ) {
            throw new RequestAdoptionError(
              "UNAVAILABLE",
              "Native adoption authority has no matching executed lineage; the barrier is retained.",
            );
          }
          if (authorization.source?.kind !== undefined) {
            const source = (() => {
                try {
                  return parseNeverStartedAdoptionSource(authorization.source);
                } catch {
                  throw new RequestAdoptionError(
                    "UNAVAILABLE",
                    "The native selection source is unknown; the barrier is retained.",
                  );
                }
              })(),
              previous = native.find((entry) =>
                entry.threadId === source.threadId
              ),
              earlier = recorded.manifest.intent.previous.pin.adoption,
              paired = recorded.manifest.nativeRetirement.successorThreadIds
                .indexOf(row.threadId);
            if (
              !previous?.retiredAt || !earlier || paired < 0 ||
              row.predecessorThreadId !== source.threadId ||
              recorded.manifest.nativeRetirement
                  .predecessorThreadIds[paired] !==
                source.threadId ||
              source.predecessorThreadId !== previous.predecessorThreadId ||
              previous.identityJson !== row.identityJson ||
              canonical(JSON.parse(row.identityJson)) !== row.identityJson ||
              await sha256(row.identityJson) !== source.identityDigest ||
              earlier.commandId !== source.previousCommandId ||
              earlier.receiptDigest !== source.previousReceiptDigest ||
              earlier.committedRuntimeRevision !==
                source.previousCommittedRuntimeRevision ||
              earlier.committedRuntimeRevision - 1 !==
                source.previousAuthorizationRuntimeRevision ||
              typeof previous.authorizedPinJson !== "string" ||
              typeof previous.advanceAuthorizationJson !== "string" ||
              await sha256(previous.authorizedPinJson) !==
                source.authorizedPinDigest ||
              await sha256(previous.advanceAuthorizationJson) !==
                source.advanceAuthorizationDigest
            ) {
              throw new RequestAdoptionError(
                "UNAVAILABLE",
                "Native never-started selection proof disagrees; the barrier is retained.",
              );
            }
          }
        }
      }
      const observations = (() => {
        try {
          return native.map((row) => ({
            retired: row.retiredAt !== null,
            authorizedPin: row.authorizedPinJson === null
              ? null
              : JSON.parse(row.authorizedPinJson),
            runPin: row.pinJson === null ? null : JSON.parse(row.pinJson),
          }));
        } catch {
          throw new RequestAdoptionError(
            "UNAVAILABLE",
            "The native no-effect pin bytes are unavailable; the barrier is retained.",
          );
        }
      })();
      const birthOwner = opening.base!.manifest.operators.find((entry) =>
        entry.operatorId === target.operatorId
      );
      const birthMember = chain.execution.adoptions.flatMap((entry) =>
        entry.manifest.intent.team?.team.filter((member) =>
          member.operatorId === target.operatorId
        ).map((member) => ({
          modelDigest: member.modelDigest,
          sourceVersion: entry.manifest.intent.candidate.source.version,
        })) ?? []
      )[0];
      if (!birthOwner && !birthMember) {
        throw new RequestAdoptionError(
          "UNAVAILABLE",
          "The original native lineage is unavailable.",
        );
      }
      assertRequestCancellationNativePins(observations, {
        identity: current.intent.previous.identity,
        previous: {
          digest: current.intent.previous.pin.modelDigest,
          repositoryVersion: current.intent.previous.pin.source.version,
        },
        candidate: {
          digest: current.intent.candidate.model.version.digest,
          repositoryVersion: current.intent.candidate.source.version,
        },
        executed: [
          {
            digest: birthOwner?.modelDigest ?? birthMember!.modelDigest,
            repositoryVersion: birthOwner
              ? chain.baseline.source.version
              : birthMember!.sourceVersion,
          },
          ...chain.execution.adoptions.filter((entry) =>
            entry.manifest.intent.target.operatorId === target.operatorId
          ).map((entry) => ({
            digest: entry.manifest.intent.candidate.model.version.digest,
            repositoryVersion: entry.manifest.intent.candidate.source.version,
          })),
        ],
      });
      const space = await tx.executionSpace.findUnique({
        where: {
          projectId_systemId_executionSpaceId: {
            ...target.host,
            executionSpaceId: target.executionSpaceId,
          },
        },
      });
      const capability = await tx.spaceControlCredential.findFirst({
        where: {
          ...target.host,
          id: oldAdmission.capabilityId,
          kind: "capability",
        },
      });
      const clock = await tx.$queryRaw<Array<{ at: Date }>>(
        Prisma.sql`SELECT clock_timestamp() AS at`,
      );
      const at = clock[0]?.at;
      if (!(at instanceof Date)) {
        throw new RequestAdoptionError(
          "UNAVAILABLE",
          "The cancellation database cutoff is unavailable.",
        );
      }
      const ownerState =
        target.operatorId === opening.base!.requestOwner.operatorId
          ? binding.state
          : (await this.options.binding.readInTransaction(tx, opening)).state;
      const obsolete = canonical(chain.head.source) !==
          canonical(current.intent.candidate.source) ||
        chain.head.manifestDigest !==
          current.intent.candidate.sourceAdmission.manifestDigest ||
        admission.status !== "active" ||
        Date.parse(admission.expiresAt) <= at.getTime() || !space ||
        space.lifecycle !== "active" || !ownerState.cases?.some((entry) =>
          entry.id === target.caseId && isOpenCase(entry)
        ) || !capability || capability.status !== "active" ||
        capability.revision !== oldAdmission.capabilityRevision ||
        capability.expiresAt <= at ||
        // Another credential of the same person and authority (a reload, a
        // second device) can still complete this intent; it is not obsolete.
        !!session && (
            !sameSpaceControlPrincipal(session.controller, oldAdmission) ||
            !sameOwnerAuthorityIdentity(
              session.controller.authority.owner,
              current.intent.decision.exercise,
            )
          );
      if (!obsolete) {
        return null;
      }
      const barrier = await tx.evolutionTargetBarrier.findUnique({
        where: {
          projectId_systemId_repositoryId_targetScopeKey_operatorId: {
            ...target.host,
            repositoryId: target.repositoryId,
            targetScopeKey: `request:${target.executionSpaceId}`,
            operatorId: target.operatorId,
          },
        },
      });
      if (
        current.status === "armed"
          ? barrier?.dossierId !== current.id ||
            barrier.executionSpaceId !== target.executionSpaceId
          : barrier !== null
      ) {
        throw new RequestAdoptionError(
          "UNAVAILABLE",
          "The exact barrier ownership is ambiguous; it is retained.",
        );
      }
      const cancelled = await parseRequestOwnerAdoptionDossier({
        ...current,
        revision: current.revision + 1,
        status: "cancelled",
        updatedAt: at.toISOString(),
        blockers: [{
          code: "INTENT_OBSOLETE",
          detail:
            "The original intent is no longer executable. No adoption committed; the previous execution version is preserved.",
        }],
      });
      const packet = await this.options.store.prepareRequestSwap(
          target,
          current.id,
          current.revision,
          cancelled,
        ),
        token = await this.options.store.lockRequestMutationInTransaction(
          tx,
          packet,
        );
      return await this.options.store.swapRequestPreparedLocked(
        tx,
        packet,
        token,
      );
    }, { isolationLevel: "ReadCommitted", maxWait: 500, timeout: 5_000 });
    if (result) this.options.store.notifyRequestCommitted(result);
    return result;
  }

  private async lockAndValidate(
    tx: Prisma.TransactionClient,
    opening: OpeningRecord,
    dossier: RequestOwnerAdoptionDossier,
    completion: RequestAdoptionDecision,
  ) {
    // A delegated decision has no session; it stands once recorded (4.8c A2).
    if (completion.kind === "request-human-adoption-decision") {
      await this.#credentials.assertCurrentController(
        tx,
        completion.controller,
        completion.sessionRevision,
      );
    }
    const repository = await tx.$queryRaw<Array<{ repositoryId: string }>>(
      Prisma.sql`SELECT "repositoryId" FROM ${
        postgresQualifiedTable(this.options.client, "SourceRepository")
      } WHERE "projectId"=${opening.scope.projectId} AND "systemId"=${opening.scope.systemId} AND "repositoryId"=${dossier.repositoryId} FOR UPDATE NOWAIT`,
    );
    if (!repository.length) conflict("The Request repository is unavailable.");
    const rows = await tx.$queryRaw<
      Array<
        {
          payload: string;
          revision: bigint;
          kind: string;
          targetScopeKey: string;
          executionSpaceId: string | null;
        }
      >
    >(Prisma
      .sql`SELECT "payload","revision","kind","targetScopeKey","executionSpaceId" FROM ${
      postgresQualifiedTable(this.options.client, "EvolutionDossier")
    } WHERE "projectId"=${opening.scope.projectId} AND "systemId"=${opening.scope.systemId} AND "id"=${dossier.id} FOR UPDATE NOWAIT`);
    const row = rows[0];
    if (
      !row || row.kind !== "request-owner-adoption-v2" ||
      row.targetScopeKey !== `request:${opening.executionSpaceId}` ||
      row.executionSpaceId !== opening.executionSpaceId ||
      row.revision !== BigInt(dossier.revision) ||
      row.payload !== canonical(dossier)
    ) conflict("The exact adoption dossier changed.");
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM ${
        postgresQualifiedTable(this.options.client, "SpaceOpening")
      } WHERE "projectId"=${opening.scope.projectId} AND "systemId"=${opening.scope.systemId} AND "id"=${opening.id} FOR UPDATE NOWAIT`,
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT "executionSpaceId" FROM ${
        postgresQualifiedTable(this.options.client, "ExecutionSpace")
      } WHERE "projectId"=${opening.scope.projectId} AND "systemId"=${opening.scope.systemId} AND "executionSpaceId"=${opening.executionSpaceId} FOR SHARE NOWAIT`,
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM ${
        postgresQualifiedTable(this.options.client, "SpaceExecutionAdmission")
      } WHERE "projectId"=${opening.scope.projectId} AND "systemId"=${opening.scope.systemId} AND "id"=${dossier.intent.previous.admission.id} FOR UPDATE NOWAIT`,
    );
    const lockedOpening = await tx.spaceOpening.findUnique({
      where: {
        projectId_systemId_executionSpaceId: {
          ...opening.scope,
          executionSpaceId: opening.executionSpaceId,
        },
      },
    });
    if (
      !lockedOpening || lockedOpening.id !== opening.id ||
      lockedOpening.phase !== "dispatched"
    ) {
      throw new RequestAdoptionError(
        "BLOCKED",
        "Complete normal R0 initialization, skills and initial delivery before adopting instructions.",
      );
    }
    const space = await tx.executionSpace.findUnique({
      where: {
        projectId_systemId_executionSpaceId: {
          ...opening.scope,
          executionSpaceId: opening.executionSpaceId,
        },
      },
    });
    if (
      !space || space.caseId !== opening.caseId ||
      space.lifecycle !== "active" || space.closedAt !== null
    ) conflict("The Request is no longer active.");
    const chain = await this.options.journal.readAdmittedSource(tx, opening);
    if (
      chain.head.source.version !== dossier.intent.candidate.source.version ||
      chain.head.manifestDigest !==
        dossier.intent.candidate.sourceAdmission.manifestDigest ||
      chain.head.revision !==
        dossier.intent.candidate.sourceAdmission.revision ||
      chain.head.sourceDigest !== dossier.intent.candidate.sourceDigest ||
      canonical(
          requestExecutionPinFor(
            chain.execution,
            dossier.intent.target.operatorId,
            opening.base!,
          ),
        ) !== canonical(dossier.intent.previous.pin)
    ) conflict("The exact admitted source or execution lineage changed.");
    if (dossier.intent.network) {
      const receipt = chain.receipts.find((item) =>
        item.revision === chain.head.revision
      );
      if (!receipt) conflict("The network publication receipt is unavailable.");
      const proof = await readRequestNetworkSourceAdmissionProof(
        tx,
        receipt,
        this.options.client,
      );
      if (
        canonical({ kind: "request-network-host-adoption/v1", ...proof }) !==
          canonical(dossier.intent.network)
      ) {
        conflict("The exact network publication proof changed.");
      }
    }
    if (dossier.intent.creationPolicy) {
      const receipt = chain.receipts.find((item) =>
        item.revision === chain.head.revision
      );
      if (!receipt) {
        conflict("The creation policy publication receipt is unavailable.");
      }
      const proof = await readRequestCreationPolicySourceAdmissionProof(
        tx,
        receipt,
        this.options.client,
      );
      if (
        canonical({ kind: "request-creation-policy-adoption/v1", ...proof }) !==
          canonical(dossier.intent.creationPolicy)
      ) {
        conflict("The exact creation policy publication proof changed.");
      }
    }
    if (dossier.intent.team) {
      const receipt = chain.receipts.find((item) =>
        item.revision === chain.head.revision
      );
      if (!receipt) conflict("The team publication receipt is unavailable.");
      assertRequestTeamPublicationBase(
        dossier.intent.team.publicationBase,
        receipt.payload.predecessor.source.version,
        requestWriteAuthorityPrior(receipt.payload.authority),
      );
      const proof = await readRequestTeamSourceAdmissionProof(
        tx,
        receipt,
        this.options.client,
      );
      // The publication proves the change; the child and the candidate team
      // were derived from the published source when the intent was prepared.
      const { addedHosts: _ignored, ...proofRest } = proof;
      const {
        childSystemId: _child,
        team: _team,
        publicationBase: _publicationBase,
        ...expectedRest
      } = dossier.intent.team;
      if (
        canonical({
          kind: "request-team-creation-adoption/v1",
          ...proofRest,
        }) !== canonical(expectedRest)
      ) {
        conflict("The exact team publication proof changed.");
      }
    }
    const admissionRow = await tx.spaceExecutionAdmission.findFirst({
      where: { ...opening.scope, id: dossier.intent.previous.admission.id },
    });
    if (
      !admissionRow ||
      canonical(decodeSpaceExecutionAdmission(admissionRow)) !==
        canonical(dossier.intent.previous.admission)
    ) conflict("The original execution admission changed.");
    const barrier = await tx.evolutionTargetBarrier.findUnique({
      where: {
        projectId_systemId_repositoryId_targetScopeKey_operatorId: {
          ...opening.scope,
          repositoryId: dossier.repositoryId,
          targetScopeKey: `request:${opening.executionSpaceId}`,
          operatorId: dossier.intent.target.operatorId,
        },
      },
    });
    if (
      dossier.status === "armed"
        ? barrier?.dossierId !== dossier.id ||
          barrier?.executionSpaceId !== opening.executionSpaceId
        : barrier !== null
    ) conflict("The exact scoped adoption barrier changed.");
    return chain;
  }
  private async validateBoundaryState(
    tx: Prisma.TransactionClient,
    opening: OpeningRecord,
    dossier: RequestOwnerAdoptionDossier,
    expected: SystemRuntimeState,
  ) {
    const current = await this.options.binding.readInTransaction(
        tx,
        opening,
        adoptionRequester(dossier.intent),
      ),
      model = current.state.executionModel;
    const ownerState =
      dossier.intent.target.operatorId === opening.base!.requestOwner.operatorId
        ? current.state
        : (await this.options.binding.readInTransaction(tx, opening)).state;
    if (dossier.intent.network || dossier.intent.creationPolicy) {
      const proof = (dossier.intent.network ?? dossier.intent.creationPolicy)!;
      const change = current.state.configuration?.changes.find((item) =>
        item.id === proof.changeId
      );
      const decision = current.state.requestNetworkDecisions?.[proof.changeId];
      const delegated = dossier.intent.decision.kind ===
          "request-delegated-adoption-decision"
        ? dossier.intent.decision
        : undefined;
      if (
        !change || !decision || decision.verdict !== "approve" ||
        decision.caseId !== opening.caseId ||
        decision.openingId !== opening.id ||
        decision.executionSpaceId !== opening.executionSpaceId ||
        decision.commandId !== proof.changeId ||
        decision.proposalIntentDigest !== proof.proposalIntentDigest ||
        await canonicalDigest(change) !== proof.approvedChangeDigest ||
        dossier.intent.creationPolicy &&
          (change.authority !== "human" || decision.authority !== undefined) ||
        delegated && (decision.authority?.kind !== "delegated" ||
            decision.authority.digest !== delegated.authorityDigest)
      ) conflict("The exact approved network decision changed.");
    }
    if (dossier.intent.team) {
      const proof = dossier.intent.team;
      const change = current.state.configuration?.changes.find((item) =>
        item.id === proof.changeId
      );
      const decision = current.state.requestNetworkDecisions?.[proof.changeId];
      const granted = dossier.intent.decision.kind ===
          "request-creation-grant-adoption-decision"
        ? dossier.intent.decision
        : undefined;
      if (
        !change || !decision || decision.verdict !== "approve" ||
        decision.caseId !== opening.caseId ||
        decision.openingId !== opening.id ||
        decision.executionSpaceId !== opening.executionSpaceId ||
        decision.commandId !== proof.changeId ||
        decision.proposalIntentDigest !== proof.proposalIntentDigest ||
        await canonicalDigest(change) !== proof.approvedChangeDigest ||
        granted && (decision.authority?.kind !== "creation-grant" ||
            decision.authority.digest !== granted.authorityDigest)
      ) conflict("The exact approved team decision changed.");
    }
    if (
      canonical(current.state) !== canonical(expected) ||
      canonical(current.pin) !== canonical(dossier.intent.previous.pin) ||
      canonical(current.admission) !==
        canonical(dossier.intent.previous.admission) ||
      !model || model.version.authoritySchema !== 2 ||
      model.ownerAuthority?.ownerSource !== "modeled" ||
      !sameOwnerAuthorityIdentity(
        model.ownerAuthority,
        dossier.intent.decision.exercise,
      ) ||
      model.version.digest !==
        dossier.intent.decision.exercise.baseModelDigest ||
      !ownerState.cases?.some((entry) =>
        entry.id === opening.caseId && isOpenCase(entry)
      )
    ) conflict("The exact R0 authorization or quiet boundary changed.");
  }
  private async assertCutoff(
    tx: Prisma.TransactionClient,
    dossier: RequestOwnerAdoptionDossier,
    completion: RequestAdoptionDecision,
  ) {
    const target = dossier.intent.target;
    if (completion.kind !== "request-human-adoption-decision") {
      // No session: the original execution admission alone bounds the effect.
      const admitted = await tx.$queryRaw<Array<{ at: Date }>>(
        Prisma
          .sql`WITH cutoff AS MATERIALIZED (SELECT clock_timestamp() AS at) SELECT cutoff.at FROM cutoff, ${
          postgresQualifiedTable(this.options.client, "SpaceExecutionAdmission")
        } a WHERE a."projectId"=${target.host.projectId} AND a."systemId"=${target.host.systemId} AND a."id"=${dossier.intent.previous.admission.id} AND a."revision"=${dossier.intent.previous.admission.revision} AND a."status"='active' AND a."expiresAt">cutoff.at`,
      );
      if (admitted.length !== 1) {
        throw new RequestAdoptionError(
          "FORBIDDEN",
          "The execution admission expired before adoption.",
        );
      }
      return;
    }
    const c = completion.controller;
    const rows = await tx.$queryRaw<Array<{ at: Date }>>(
      Prisma
        .sql`WITH cutoff AS MATERIALIZED (SELECT clock_timestamp() AS at) SELECT cutoff.at FROM cutoff, ${
        postgresQualifiedTable(this.options.client, "SpaceControlCredential")
      } c, ${
        postgresQualifiedTable(this.options.client, "SpaceControlCredential")
      } s, ${
        postgresQualifiedTable(this.options.client, "SpaceExecutionAdmission")
      } a WHERE c."projectId"=${target.host.projectId} AND c."systemId"=${target.host.systemId} AND c."id"=${c.capabilityId} AND c."kind"='capability' AND c."ownerId"=${c.ownerId} AND c."revision"=${c.capabilityRevision} AND c."status"='active' AND s."projectId"=c."projectId" AND s."systemId"=c."systemId" AND s."id"=${c.sessionId} AND s."parentCapabilityId"=c."id" AND s."ownerId"=c."ownerId" AND s."kind"='session' AND s."revision"=${completion.sessionRevision} AND s."status"='active' AND a."projectId"=c."projectId" AND a."systemId"=c."systemId" AND a."id"=${dossier.intent.previous.admission.id} AND a."revision"=${dossier.intent.previous.admission.revision} AND a."status"='active' AND LEAST(c."expiresAt",s."expiresAt",a."expiresAt")>cutoff.at`,
    );
    if (rows.length !== 1) {
      throw new RequestAdoptionError(
        "FORBIDDEN",
        "Current human control or execution admission expired before adoption.",
      );
    }
  }
}
