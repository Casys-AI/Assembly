import { scopedOperator } from "../../../domain/governance/policies/delegation-scope.ts";
import type { PostgresRequestExecutionBindingReader } from "./request-execution-binding.ts";
import { decodeRequestSpaceOpening } from "./request-space-store.ts";
import {
  type PostgresRequestSourceAdmissionStore,
  requestReleaseSourceEvidence,
} from "./request-source-admission-store.ts";
import {
  requestReleaseOriginMatches,
  type VerifiedRequestReleaseSource,
} from "../../../domain/work/request-release-origin.ts";
import type { SavedSystemManifest } from "../../../domain/work/saved-systems.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  retainedToolAdmissionId,
  retainedToolDescriptors,
  retainedToolResourceId,
} from "../../../domain/work/retained-tool-dependencies.ts";
import {
  assertBaseForChoice,
  assertOpeningBase,
  type OpeningBase,
  recordedOpeningCommand,
  requestSpaceDigest,
  RequestSpaceError,
} from "../../../domain/work/request-spaces.ts";
import type { Prisma, PrismaClient } from "./client.ts";
import type { PostgresHostStorage } from "./host-storage.ts";
import type { PostgresSpaceAdmissions } from "./request-space-control-store.ts";
import type { PostgresSystemScope } from "./scope.ts";
import type { PostgresSpaceEffectStartGuard } from "../native-execution/postgres-ledger.ts";
import type { ResolvedOperatorScope } from "../../../application/work/native-execution/contract.ts";

const refused = () =>
  new RequestSpaceError(
    "ADMISSION_REFUSED",
    "The recorded Request scope, base or admission is unavailable.",
  );
function sameHost(scope: PostgresSystemScope, host: PostgresSystemScope) {
  return scope.projectId === host.projectId && scope.systemId === host.systemId;
}

/** Identity discovery only. Both native dispatch and the final transaction use
 * the same durable binding; neither a cached handle nor an operator identifies a Case. */
async function resolveCaseSpace(
  client:
    | Pick<PrismaClient, "executionSpace">
    | Pick<Prisma.TransactionClient, "executionSpace">,
  host: PostgresSystemScope,
  executionSpaceId: string,
): Promise<ResolvedOperatorScope | null> {
  if (
    !executionSpaceId?.trim() || executionSpaceId === "main" ||
    executionSpaceId.includes("\0")
  ) return null;
  const space = await client.executionSpace.findUnique({
    where: {
      projectId_systemId_executionSpaceId: { ...host, executionSpaceId },
    },
    include: { case: true },
  });
  if (
    !space || !sameHost(space, host) ||
    space.executionSpaceId !== executionSpaceId ||
    space.parentExecutionSpaceId !== "main" ||
    space.lifecycle !== "active" || space.closedAt !== null ||
    !space.caseId?.trim() || space.caseId.includes("\0") ||
    !space.case || !sameHost(space.case, host) ||
    space.case.caseId !== space.caseId
  ) return null;
  return { ...host, executionSpaceId, caseId: space.caseId };
}

/** No getters using the host client, source access or initialization may enter
 * this callback. Discovery takes no UPDATE locks; CAP-3 owns the lock order. */
export function createRequestSpaceEffectStartGuard(
  host: PostgresSystemScope,
  sqlAdmissions: Pick<PostgresSpaceAdmissions, "assertEffectStart">,
  executionBindings?: Pick<
    PostgresRequestExecutionBindingReader,
    "readInTransaction"
  >,
  sourceAdmissions?: Pick<
    PostgresRequestSourceAdmissionStore,
    "readAdmittedSource"
  >,
): PostgresSpaceEffectStartGuard {
  const boundHost = Object.freeze({ ...host });
  return async (tx, { scope, request, node, target }) => {
    if (!sameHost(scope, boundHost) || scope.executionSpaceId === "main") {
      throw refused();
    }
    const space = await resolveCaseSpace(tx, boundHost, scope.executionSpaceId);
    if (!space) throw refused();
    const opening = await tx.spaceOpening.findUnique({
      where: {
        projectId_systemId_executionSpaceId: {
          ...boundHost,
          executionSpaceId: scope.executionSpaceId,
        },
      },
    });
    if (
      !opening || !sameHost(opening, boundHost) ||
      opening.executionSpaceId !== space.executionSpaceId ||
      opening.caseId !== space.caseId ||
      !["admitted", "dispatched"].includes(opening.phase) ||
      !opening.baseJson || !opening.baseDigest ||
      !opening.admissionId?.trim() ||
      request.identity.scope.kind !== "request" ||
      request.identity.scope.scopeId !== space.caseId ||
      request.identity.scope.rootRequestId !== space.caseId ||
      request.identity.purpose !== "conversation"
    ) throw refused();
    // Invalid JSON remains a technical codec failure, not an authority refusal.
    const base = JSON.parse(opening.baseJson) as OpeningBase;
    const commandValue = JSON.parse(opening.commandJson);
    let command: ReturnType<typeof recordedOpeningCommand>;
    try {
      command = recordedOpeningCommand(commandValue);
      assertBaseForChoice(base, command.source);
    } catch (error) {
      if (
        error instanceof RequestSpaceError &&
        (error.code === "INVALID_COMMAND" ||
          error.code === "OPENING_CONFLICT" ||
          error.code === "UNAVAILABLE")
      ) throw refused();
      throw error;
    }
    // Preflight has already verified exact retained models/assets. At effect
    // start recheck their durable immutable origin relation using this caller's
    // transaction only. Historical origin closure is not target execution.
    const executingCaseId = space.caseId!;
    // PostgresHostStorage.sourceScopeId is the host systemId; registration
    // rejects a repository bound to another source scope. Match the same
    // host-local visibility contract as saved-system preflight.
    const expectedSourceScopeId = boundHost.systemId;
    const assertOrigin = async (
      manifest: SavedSystemManifest,
      seen: ReadonlySet<string>,
    ): Promise<void> => {
      if (!sameHost(manifest.origin, boundHost) || !manifest.source) {
        throw refused();
      }
      if (manifest.origin.executionSpaceId === "main") {
        if (
          manifest.source.branch.kind !== "main" ||
          manifest.source.branchRef !== "refs/heads/admitted" ||
          manifest.source.requestAdmission !== undefined
        ) throw refused();
        return;
      }
      const source = manifest.source;
      if (
        source.branch.kind !== "case" ||
        source.branch.caseId === executingCaseId || seen.size >= 32 ||
        seen.has(source.branch.caseId)
      ) throw refused();
      const origin = await tx.spaceOpening.findUnique({
        where: {
          projectId_systemId_executionSpaceId: {
            ...boundHost,
            executionSpaceId: manifest.origin.executionSpaceId,
          },
        },
      });
      if (
        !origin || !sameHost(origin, boundHost) ||
        origin.executionSpaceId !== manifest.origin.executionSpaceId ||
        origin.caseId !== source.branch.caseId ||
        origin.ownerId !== opening.ownerId ||
        !["runtime-ready", "admitted", "dispatched"].includes(origin.phase) ||
        !origin.baseJson || !origin.baseDigest ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(origin.branchId)
      ) throw refused();
      const originBase = JSON.parse(origin.baseJson) as OpeningBase;
      const originCommand = recordedOpeningCommand(
        JSON.parse(origin.commandJson),
      );
      assertOpeningBase(originBase);
      assertBaseForChoice(originBase, originCommand.source);
      let admitted: VerifiedRequestReleaseSource | undefined;
      if (source.requestAdmission) {
        if (!sourceAdmissions) throw refused();
        const record = decodeRequestSpaceOpening(origin);
        const chain = await sourceAdmissions.readAdmittedSource(tx, record);
        admitted = requestReleaseSourceEvidence(
          record,
          chain,
          source.requestAdmission,
        );
      }
      if (
        await requestSpaceDigest(originBase) !== origin.baseDigest ||
        await requestSpaceDigest(originBase.manifest) !==
          originBase.manifestDigest ||
        await requestSpaceDigest({
            scope: boundHost,
            ownerId: origin.ownerId,
            command: originCommand,
          }) !== origin.commandDigest ||
        !requestReleaseOriginMatches(
          manifest,
          {
            scope: boundHost,
            caseId: origin.caseId,
            executionSpaceId: origin.executionSpaceId,
            base: originBase,
            id: origin.id,
            baseDigest: origin.baseDigest,
          },
          `refs/heads/requests/${origin.branchId}`,
          admitted,
        )
      ) throw refused();
      const originSpace = await tx.executionSpace.findUnique({
        where: {
          projectId_systemId_executionSpaceId: {
            ...boundHost,
            executionSpaceId: origin.executionSpaceId,
          },
        },
      });
      const repository = await tx.sourceRepository.findUnique({
        where: {
          projectId_systemId_repositoryId: {
            ...boundHost,
            repositoryId: source.repositoryId,
          },
        },
      });
      if (
        !originSpace || !sameHost(originSpace, boundHost) ||
        originSpace.executionSpaceId !== origin.executionSpaceId ||
        originSpace.caseId !== origin.caseId ||
        originSpace.parentExecutionSpaceId !== "main" ||
        !repository || !sameHost(repository, boundHost) ||
        repository.repositoryId !== source.repositoryId ||
        repository.sourceScopeId !== expectedSourceScopeId
      ) throw refused();
      await assertOrigin(originBase.manifest, new Set(seen).add(origin.caseId));
    };
    try {
      await assertOrigin(base.manifest, new Set());
    } catch (error) {
      if (
        error instanceof RequestSpaceError &&
        ["INVALID_COMMAND", "OPENING_CONFLICT", "UNAVAILABLE"].includes(
          error.code,
        )
      ) throw refused();
      throw error;
    }
    const owner = base.manifest.operators.filter((operator) =>
      operator.operatorId === base.requestOwner.operatorId
    );
    // The executing operator is the BO or an admitted branch-team member;
    // identity, scope and model must agree on that one operator.
    const executingOperatorId = request.identity.operatorId;
    const isOwner = executingOperatorId === base.requestOwner.operatorId;
    if (
      !sameHost(base.manifest.origin, boundHost) ||
      await requestSpaceDigest(base) !== opening.baseDigest ||
      await requestSpaceDigest(base.manifest) !== base.manifestDigest ||
      await requestSpaceDigest({
          scope: boundHost,
          ownerId: opening.ownerId,
          command,
        }) !== opening.commandDigest ||
      owner.length !== 1 ||
      scope.operatorId !== executingOperatorId ||
      request.model.identity.builderId !== executingOperatorId ||
      !executionBindings &&
        (!isOwner ||
          request.model.version.digest !== owner[0].modelDigest ||
          request.model.version.repositoryVersion !==
            base.manifest.source!.sourceVersion)
    ) throw refused();
    const binding = executionBindings
      ? await executionBindings.readInTransaction(
        tx,
        decodeRequestSpaceOpening(opening),
        isOwner ? undefined : scopedOperator({
          ...request.model.identity,
          executionSpaceId: scope.executionSpaceId,
        }, executingOperatorId),
      )
      : undefined;
    if (
      binding &&
      (binding.pin.modelDigest !== request.model.version.digest ||
        binding.pin.source.version !== request.model.version.repositoryVersion)
    ) throw refused();
    const admission = await tx.spaceExecutionAdmission.findFirst({
      where: { ...boundHost, id: opening.admissionId },
    });
    if (
      !admission || !sameHost(admission, boundHost) ||
      admission.id !== opening.admissionId ||
      admission.openingId !== opening.id ||
      admission.executionSpaceId !== opening.executionSpaceId ||
      admission.ownerId !== opening.ownerId ||
      admission.baseDigest !== opening.baseDigest ||
      !Number.isSafeInteger(admission.revision) || admission.revision < 0 ||
      binding &&
        (binding.admission.id !== admission.id ||
          binding.admission.revision !== admission.revision)
    ) throw refused();
    const permissions = JSON.parse(admission.permissionsJson) as {
      resourceIds?: unknown;
      operatorIds?: unknown;
      modelDigests?: unknown;
      sourceVersion?: unknown;
    };
    const resources = permissions.resourceIds;
    if (!Array.isArray(resources)) throw refused();
    if (!isOwner) {
      // A team member executes only under its own admitted index and digest
      // of this space's current admission, on the pin's source version.
      const operatorIds = permissions.operatorIds;
      const modelDigests = permissions.modelDigests;
      const index = Array.isArray(operatorIds)
        ? operatorIds.indexOf(executingOperatorId)
        : -1;
      if (
        !binding || index <= 0 || !Array.isArray(modelDigests) ||
        modelDigests[index] !== request.model.version.digest
      ) throw refused();
    }
    let descriptors: ReturnType<typeof retainedToolDescriptors> = [];
    let expectedResources: string[] = [];
    try {
      if (resources.length) {
        descriptors = retainedToolDescriptors(
          decodeRequestSpaceOpening(opening),
          admission.id,
        );
        expectedResources = await Promise.all(
          descriptors.map(retainedToolResourceId),
        );
      }
    } catch {
      throw refused();
    }
    if (
      resources.length &&
      (admission.id !== await retainedToolAdmissionId(boundHost, opening.id) ||
        canonical(resources) !== canonical(expectedResources))
    ) throw refused();
    const retainedTool = target?.retainedTool;
    // Retained tools belong to the BO alone: a team member presenting one
    // is refused at this trust boundary, whatever its descriptors say.
    if (!isOwner && retainedTool) throw refused();
    if (node?.mechanism === "invoke_tool") {
      if (target?.behaviorId && !target.toolId && !retainedTool) {
        if (!target.admitted) throw refused();
      } else if (
        resources.length || retainedTool || owner[0].tools.length > 0
      ) {
        const index = descriptors.findIndex((item) =>
          item.tool.candidateId === target?.toolId
        );
        if (
          !target?.admitted || !target.toolId || !retainedTool || index < 0 ||
          retainedTool.toolId !== target.toolId ||
          retainedTool.toolDigest !== descriptors[index].tool.digest ||
          retainedTool.resourceId !== expectedResources[index] ||
          retainedTool.descriptorDigest !==
            expectedResources[index].slice("retained-tool:v1:".length)
        ) throw refused();
      }
    } else if (target || retainedTool) throw refused();
    // The persisted revision is reread under UPDATE by CAP-3. In particular,
    // a concurrent revocation cannot be accepted using this discovery snapshot.
    return await sqlAdmissions.assertEffectStart(tx, {
      admissionId: admission.id,
      expectedRevision: admission.revision,
      openingId: opening.id,
      executionSpaceId: opening.executionSpaceId,
      operatorId: executingOperatorId,
      modelDigest: request.model.version.digest,
      sourceVersion: request.model.version.repositoryVersion!,
      baseDigest: opening.baseDigest,
      act: "conversation",
      expectedResourceIds: resources,
      ...(retainedTool ? { retainedTool } : {}),
    });
  };
}

export function createRequestSpaceResolver(storage: PostgresHostStorage) {
  const host = Object.freeze({ ...storage.scope });
  return (executionSpaceId: string) =>
    resolveCaseSpace(storage.client, host, executionSpaceId);
}
