import type { ScopedOperatorRef } from "../../domain/governance/authority.ts";
import { parseModelRevisionRef } from "../../domain/model/value-objects/element-ref.ts";
import { canonical } from "../../domain/primitives/canonical-json.ts";
import { modelSourceDigest } from "../../domain/model/value-objects/sources.ts";
import {
  assertRequestTeamPublicationBase,
  requestCreationPolicyCompatibility,
  requestInstructionCompatibility,
  requestNetworkCompatibility,
  requestTeamCompatibility,
} from "../../application/model/evolution/request-adoption-invariants.ts";
import { canonicalDigest } from "../../domain/primitives/execution-digest.ts";
import {
  readRequestCreationPolicySourceAdmissionProof,
  readRequestNetworkSourceAdmissionProof,
  readRequestTeamSourceAdmissionProof,
} from "../out/postgres/request-source-publication-participant.ts";
import { decidedByNetworkAuthority } from "../../domain/governance/records/request-network-change.ts";
import {
  assertRequestTeamChange,
  decidedByTeamAuthority,
  requestChangeEffect,
} from "../../domain/governance/records/request-change.ts";
import { branchTeam } from "../../domain/work/request-spaces.ts";
import {
  type RequestTeamCreationModelReader,
  requestTeamCreationReceiptVerifies,
} from "../../application/work/request-spaces/request-space-model.ts";
import {
  type RequestAdoptionContextPort,
  RequestAdoptionError,
  type RequestAdoptionSession,
} from "../../application/model/evolution/request-adoption-ports.ts";
import type {
  OpeningRecord,
  SpaceController,
} from "../../domain/work/request-spaces.ts";
import type {
  OpeningStorePort,
  SpaceControlPort,
} from "../../application/work/request-spaces/ports.ts";
import { isOpenCase } from "../../domain/work/entities/cases.ts";
import { PostgresSpaceCredentials } from "../out/postgres/request-space-control-store.ts";
import type { PostgresHostStorage } from "../out/postgres/host-storage.ts";
import { PostgresRequestExecutionBindingReader } from "../out/postgres/request-execution-binding.ts";
import { PostgresRequestSourceAdmissionStore } from "../out/postgres/request-source-admission-store.ts";
import type { GitModelRepositoryReader } from "../out/git/repository.ts";
import { validateSourceExecutables } from "../model/sources/source-model.ts";
import { Prisma } from "../out/postgres/client.ts";
import { requestWriteAuthorityPrior } from "../../application/model/source-admission/request-delegated-authority.ts";
import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";

function refuse(message: string): never {
  throw new RequestAdoptionError("UNAVAILABLE", message);
}
export class RequestAdoptionContexts implements RequestAdoptionContextPort {
  readonly #credentials: PostgresSpaceCredentials;
  constructor(
    private readonly options: {
      storage: Pick<
        PostgresHostStorage,
        "client" | "scope" | "primarySpaceControl" | "readCaseRuntimeState"
      >;
      controls: Pick<SpaceControlPort, "authenticateSession">;
      openings: Pick<OpeningStorePort, "forCase">;
      binding: PostgresRequestExecutionBindingReader;
      journal: PostgresRequestSourceAdmissionStore;
      repositoryId: string;
      creationModels?: RequestTeamCreationModelReader;
      reader(): Promise<
        Pick<
          GitModelRepositoryReader,
          "repositoryId" | "projectId" | "at" | "descriptorAt"
        >
      >;
    },
  ) {
    this.#credentials = new PostgresSpaceCredentials(
      options.storage.client,
      options.storage.primarySpaceControl,
    );
  }
  async authenticate(secret: string): Promise<RequestAdoptionSession> {
    const controller = structuredClone(
      await this.options.controls.authenticateSession(secret),
    );
    const current = await this.options.storage.client.$transaction((tx) =>
      this.#credentials.assertCurrentController(tx, controller)
    );
    return { controller, sessionRevision: current.sessionRevision };
  }
  async ownedOpening(
    controller: SpaceController,
    caseId: string,
  ): Promise<OpeningRecord> {
    const opening = structuredClone(
      await this.options.openings.forCase(caseId),
    );
    if (
      !opening?.base || !opening.baseDigest || opening.caseId !== caseId ||
      opening.ownerId !== controller.ownerId ||
      opening.executionSpaceId === "main" ||
      canonical(opening.scope) !== canonical(this.options.storage.scope) ||
      canonical(controller.authority.scope) !== canonical(opening.scope) ||
      opening.base.manifest.source?.repositoryId !== this.options.repositoryId
    ) refuse("The owned Request is unavailable.");
    return opening;
  }
  /** Host-internal (4.8c): the same Request checks, owned by no session. */
  async hostOpening(caseId: string): Promise<OpeningRecord> {
    const opening = structuredClone(
      await this.options.openings.forCase(caseId),
    );
    if (
      !opening?.base || !opening.baseDigest || opening.caseId !== caseId ||
      opening.executionSpaceId === "main" ||
      canonical(opening.scope) !== canonical(this.options.storage.scope) ||
      opening.base.manifest.source?.repositoryId !== this.options.repositoryId
    ) refuse("The Request is unavailable.");
    return opening;
  }
  async revalidateRead(
    session: RequestAdoptionSession,
    opening: OpeningRecord,
  ): Promise<void> {
    await this.options.storage.client.$transaction((tx) =>
      this.#credentials.assertCurrentController(
        tx,
        session.controller,
        session.sessionRevision,
      )
    );
    const latest = await this.ownedOpening(session.controller, opening.caseId);
    if (
      latest.id !== opening.id ||
      latest.executionSpaceId !== opening.executionSpaceId ||
      latest.baseDigest !== opening.baseDigest
    ) refuse("The owned Request selection changed.");
  }
  private async assertAdmissionLive(expiresAt: string): Promise<void> {
    const [clock] = await this.options.storage.client.$queryRaw<
      Array<{ live: boolean }>
    >(Prisma.sql`SELECT ${new Date(
      expiresAt,
    )}::timestamptz > clock_timestamp() AS live`);
    if (typeof clock?.live !== "boolean") {
      refuse("The current execution admission expiry is unavailable.");
    }
    if (clock?.live !== true) {
      throw new RequestAdoptionError(
        "FORBIDDEN",
        "The current execution admission has expired.",
      );
    }
  }
  async resolve(
    session: RequestAdoptionSession,
    input: OpeningRecord,
    changeId?: string,
  ) {
    return await this.#resolve(
      input,
      changeId,
      (opening) => this.revalidateRead(session, opening),
    );
  }
  #hostRevalidate = async (opening: OpeningRecord) => {
    const latest = await this.hostOpening(opening.caseId);
    if (
      latest.id !== opening.id ||
      latest.executionSpaceId !== opening.executionSpaceId ||
      latest.baseDigest !== opening.baseDigest
    ) refuse("The Request selection changed.");
  };
  /** Host-internal (4.8c): no session; the recorded decision and the network
   * publication must both carry this exact delegated authority. */
  async resolveDelegated(
    input: OpeningRecord,
    networkChangeId: string,
    authorityDigest: string,
    requester?: ScopedOperatorRef,
  ) {
    return await this.#resolve(input, networkChangeId, this.#hostRevalidate, {
      kind: "delegated",
      digest: authorityDigest,
      requester,
    });
  }
  /** Host-internal (4.8e): no session; the recorded decision and the team
   * publication must both carry this exact creation-grant authority. */
  async resolveCreationGrant(
    input: OpeningRecord,
    teamChangeId: string,
    authorityDigest: string,
    requester?: ScopedOperatorRef,
  ) {
    return await this.#resolve(input, teamChangeId, this.#hostRevalidate, {
      kind: "creation-grant",
      digest: authorityDigest,
      requester,
    });
  }
  async #resolve(
    input: OpeningRecord,
    changeId: string | undefined,
    revalidate: (opening: OpeningRecord) => Promise<void>,
    hostAuthority?: {
      kind: "delegated" | "creation-grant";
      digest: string;
      requester?: ScopedOperatorRef;
    },
  ) {
    const opening = structuredClone(input);
    if (opening.phase !== "dispatched") {
      throw new RequestAdoptionError(
        "BLOCKED",
        "Complete normal R0 initialization, skills and initial delivery before adopting instructions.",
      );
    }
    const binding = await this.options.binding.read(
        opening,
        hostAuthority?.requester,
      ),
      previous = binding.state.executionModel;
    const space = await this.options.storage.client.executionSpace.findUnique({
      where: {
        projectId_systemId_executionSpaceId: {
          ...opening.scope,
          executionSpaceId: opening.executionSpaceId,
        },
      },
    });
    if (
      !space || space.lifecycle !== "active" || space.closedAt !== null ||
      binding.admission.status !== "active" || !previous ||
      !(hostAuthority?.requester &&
          hostAuthority.requester.operatorId !==
            opening.base!.requestOwner.operatorId
        ? (await this.options.binding.read(opening)).state
        : binding.state).cases?.some((record) =>
          record.id === opening.caseId && isOpenCase(record)
        )
    ) refuse("An open initialized Request with active admission is required.");
    // Cheap current-state feedback before source/build work. This is not the
    // effect authorization: final adoption still checks expiry under its locks.
    await this.assertAdmissionLive(binding.admission.expiresAt);
    const chain = await this.options.storage.client.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
      return await this.options.journal.readAdmittedSource(tx, opening);
    }, { isolationLevel: "RepeatableRead" });
    const receipt = chain.receipts.at(-1);
    if (
      !receipt || receipt.revision !== chain.head.revision ||
      chain.head.source.version === binding.pin.source.version
    ) {
      refuse(
        "A current admitted instruction distinct from execution is required.",
      );
    }
    const reader = await this.options.reader();
    if (
      reader.repositoryId !== this.options.repositoryId ||
      reader.projectId !== `git:${this.options.repositoryId}`
    ) refuse("The Request source repository changed.");
    const revision = await reader.at(chain.head.source.version),
      build = await reader.descriptorAt(chain.head.source.version);
    if (
      !build ||
      await modelSourceDigest(revision.sources) !== chain.head.sourceDigest ||
      canonical(build) !== canonical(receipt.payload.result.build)
    ) refuse("The exact admitted source/build is unavailable.");
    const compiled = await validateSourceExecutables(
      revision,
      `git:${this.options.repositoryId}`,
    );
    const matches = compiled.map((entry) => entry.model).filter((model) =>
      model.identity.builderId === previous.identity.builderId
    );
    if (matches.length !== 1) {
      refuse("The exact admitted Request operator is unavailable.");
    }
    const model = matches[0];
    if (
      canonical(model.identity) !==
        canonical(receipt.payload.result.model.identity) ||
      model.version.digest !== receipt.payload.result.model.digest ||
      model.version.repositoryVersion !== chain.head.source.version ||
      canonical(model.identity) !== canonical(previous.identity)
    ) refuse("The admitted model differs from its exact source receipt.");
    let network:
      | import("../../application/model/evolution/request-adoption-ports.ts").RequestNetworkAdoptionProof
      | undefined;
    let team:
      | import("../../application/model/evolution/request-adoption-ports.ts").RequestTeamAdoptionProof
      | undefined;
    let creationPolicy:
      | import("../../application/model/evolution/request-adoption-ports.ts").RequestCreationPolicyAdoptionProof
      | undefined;
    let compatibilityDigest: string;
    if (changeId) {
      const change = binding.state.configuration?.changes.find((item) =>
        item.id === changeId
      );
      const decision = binding.state.requestNetworkDecisions?.[changeId];
      const effect = change ? requestChangeEffect(change) : undefined;
      const expectedRef = hostAuthority?.kind === "delegated"
        ? "request-delegated-authority"
        : hostAuthority?.kind === "creation-grant"
        ? "request-creation-grant"
        : undefined;
      if (
        !change || !decision || decision.verdict !== "approve" ||
        decision.caseId !== opening.caseId ||
        decision.openingId !== opening.id ||
        decision.executionSpaceId !== opening.executionSpaceId ||
        decision.commandId !== changeId ||
        hostAuthority !== undefined &&
          (decision.authority?.kind !== hostAuthority.kind ||
            decision.authority.digest !== hostAuthority.digest ||
            receipt.payload.command.authorityRef.kind !== expectedRef ||
            receipt.payload.authorityDigest !== hostAuthority.digest) ||
        hostAuthority?.kind === "delegated" && effect !== "network" ||
        hostAuthority?.kind === "creation-grant" && effect !== "team-member"
      ) refuse("The approved Request change is unavailable.");
      if (effect === "team-member") {
        assertRequestTeamChange(change);
        const proof = await this.options.storage.client.$transaction(
          (tx) =>
            readRequestTeamSourceAdmissionProof(
              tx,
              receipt,
              this.options.storage.client,
            ),
          { isolationLevel: "RepeatableRead" },
        );
        if (
          proof.changeId !== changeId ||
          proof.proposalIntentDigest !== decision.proposalIntentDigest ||
          proof.approvedChangeDigest !== await canonicalDigest(change) ||
          !decidedByTeamAuthority(change)
        ) refuse("The exact approved Request team proof differs.");
        let publicationBase: ExecutableModel | undefined;
        const predecessor = receipt.payload.predecessor;
        if (
          previous.identity.builderId !==
            opening.base!.requestOwner.operatorId &&
          previous.version.repositoryVersion !== predecessor.source.version
        ) {
          const baseRevision = await reader.at(predecessor.source.version);
          if (
            baseRevision.version !== predecessor.source.version ||
            await modelSourceDigest(baseRevision.sources) !==
              predecessor.sourceDigest
          ) refuse("The exact team publication predecessor is unavailable.");
          const bases = (await validateSourceExecutables(
            baseRevision,
            `git:${this.options.repositoryId}`,
          )).map((entry) => entry.model).filter((entry) =>
            canonical(entry.identity) === canonical(previous.identity)
          );
          if (bases.length !== 1) {
            refuse("The exact team publication predecessor is unavailable.");
          }
          publicationBase = bases[0];
          assertRequestTeamPublicationBase(
            publicationBase,
            predecessor.source.version,
            requestWriteAuthorityPrior(receipt.payload.authority),
          );
        }
        compatibilityDigest = await requestTeamCompatibility(
          previous,
          model,
          change,
          publicationBase,
        );
        const added = (model.operatorCreationPolicies ?? []).flatMap(
          (policy, index) =>
            policy.children.filter((child) =>
              !(previous.operatorCreationPolicies ?? [])[index]?.children
                .includes(child)
            ),
        );
        if (added.length !== 1) {
          refuse("The exact approved Request team proof differs.");
        }
        const { addedHosts: _ignored, ...proofRest } = proof;
        // The whole verified team at the candidate source, from the one
        // producer: the transition writes exactly these permissions.
        const candidateModels = compiled.map((entry) => entry.model);
        const byOperator = new Map(
          candidateModels.map((entry) => [entry.identity.builderId, entry]),
        );
        const parentStates = new Map(
          await Promise.all(
            binding.admission.permissions.operatorIds.map(async (operatorId) =>
              [
                operatorId,
                operatorId === previous.identity.builderId
                  ? binding.state
                  : await this.options.storage.readCaseRuntimeState(
                    opening.executionSpaceId,
                    opening.caseId,
                    operatorId,
                  ),
              ] as const
            ),
          ),
        );
        const births = await this.options.creationModels?.(
          opening,
          binding.admission.permissions.operatorIds.slice(1),
        ) ?? new Map<string, ExecutableModel>();
        const verifiedTeam = branchTeam(
          opening.base!,
          candidateModels,
          opening.caseId,
          (child) => {
            const childModel = byOperator.get(child.identity.builderId);
            const parentModel = childModel?.operatorTeam
              ? byOperator.get(childModel.operatorTeam.parentOperatorId)
              : undefined;
            return childModel !== undefined && parentModel !== undefined &&
              requestTeamCreationReceiptVerifies(
                candidateModels,
                childModel,
                {
                  space: {
                    projectId: parentModel.identity.projectId,
                    systemId: parentModel.identity.systemId,
                    executionSpaceId: opening.executionSpaceId,
                  },
                },
                (parent) =>
                  parentStates.get(parent.identity.builderId)?.configuration
                    ?.changes ?? [],
                births,
              );
          },
          binding.admission.permissions.operatorIds.slice(1),
        );
        if (
          !verifiedTeam.some((member) =>
            byOperator.get(member.operatorId)?.identity.systemId === added[0]
          )
        ) refuse("The exact approved Request team proof differs.");
        if (
          previous.identity.builderId !== opening.base!.requestOwner.operatorId
        ) {
          const admitted = binding.admission.permissions.operatorIds;
          const position = (id: string) => {
            const index = admitted.indexOf(id);
            return index < 0 ? admitted.length : index;
          };
          verifiedTeam.sort((a, b) =>
            position(a.operatorId) - position(b.operatorId)
          );
        }
        team = {
          kind: "request-team-creation-adoption/v1",
          ...proofRest,
          childSystemId: added[0],
          ...(publicationBase ? { publicationBase } : {}),
          team: verifiedTeam.map((member) => ({
            operatorId: member.operatorId,
            modelDigest: member.modelDigest,
          })),
        };
      } else if (effect === "creation-policy") {
        const proof = await this.options.storage.client.$transaction(
          (tx) =>
            readRequestCreationPolicySourceAdmissionProof(
              tx,
              receipt,
              this.options.storage.client,
            ),
          { isolationLevel: "RepeatableRead" },
        );
        if (
          hostAuthority || change.authority !== "human" ||
          proof.changeId !== changeId ||
          proof.proposalIntentDigest !== decision.proposalIntentDigest ||
          proof.approvedChangeDigest !== await canonicalDigest(change)
        ) {
          refuse("The exact approved Request creation policy proof differs.");
        }
        creationPolicy = {
          kind: "request-creation-policy-adoption/v1",
          ...proof,
        };
        compatibilityDigest = await requestCreationPolicyCompatibility(
          previous,
          model,
          change,
        );
      } else {
        const proof = await this.options.storage.client.$transaction(
          (tx) =>
            readRequestNetworkSourceAdmissionProof(
              tx,
              receipt,
              this.options.storage.client,
            ),
          { isolationLevel: "RepeatableRead" },
        );
        if (
          proof.changeId !== changeId ||
          proof.proposalIntentDigest !== decision.proposalIntentDigest ||
          proof.approvedChangeDigest !== await canonicalDigest(change) ||
          !decidedByNetworkAuthority(change)
        ) refuse("The exact approved Request network proof differs.");
        network = { kind: "request-network-host-adoption/v1", ...proof };
        compatibilityDigest = await requestNetworkCompatibility(
          previous,
          model,
          change,
        );
      }
    } else {
      compatibilityDigest = await requestInstructionCompatibility(
        previous,
        model,
      );
    }
    await revalidate(opening);
    const current = await this.options.binding.read(
      opening,
      hostAuthority?.requester,
    );
    if (
      canonical(current.pin) !== canonical(binding.pin) ||
      canonical(current.admission) !== canonical(binding.admission)
    ) refuse("The executing Request pin changed during preparation.");
    const after = await this.options.storage.client.$transaction(
      (tx) => this.options.journal.readAdmittedSource(tx, opening),
      { isolationLevel: "RepeatableRead" },
    );
    if (canonical(after.head) !== canonical(chain.head)) {
      refuse("The current admitted source changed during preparation.");
    }
    await this.assertAdmissionLive(current.admission.expiresAt);
    return {
      ...(network ? { network } : {}),
      ...(team ? { team } : {}),
      ...(creationPolicy ? { creationPolicy } : {}),
      opening,
      target: {
        v: 1 as const,
        kind: "request" as const,
        repositoryId: this.options.repositoryId,
        host: opening.scope,
        openingId: opening.id,
        executionSpaceId: opening.executionSpaceId,
        caseId: opening.caseId,
        branchId: opening.branchId,
        ref: `refs/heads/requests/${opening.branchId}`,
        operatorId: previous.identity.builderId,
      },
      binding: current,
      candidate: {
        source: parseModelRevisionRef(chain.head.source),
        sourceDigest: chain.head.sourceDigest,
        sourceAdmission: {
          revision: chain.head.revision,
          manifestDigest: chain.head.manifestDigest,
        },
        build,
        model,
        compatibilityDigest,
      },
    };
  }
}
