import type {
  RequestExecutionBinding,
  RequestExecutionBindingPort,
} from "../../model/evolution/request-adoption-ports.ts";
import {
  effectiveSpaceControlAuthority,
  sameEffectiveSpaceControlAuthority,
} from "../../../domain/work/request-space-authority.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  retainedToolAdmissionId,
  retainedToolDescriptors,
  retainedToolResourceId,
} from "../../../domain/work/retained-tool-dependencies.ts";
import {
  branchTeam,
  type BranchTeamMember,
  conversationPermissions,
  type HostSpaceController,
  type OpeningRecord,
  requestSpaceDigest,
  RequestSpaceError,
  type SpaceControlAuthority,
  type SpaceController,
  type SpaceControlPrincipal,
  type SpaceExecutionAdmission,
} from "../../../domain/work/request-spaces.ts";
import {
  type RequestTeamCreationModelReader,
  requestTeamCreationReceiptVerifies,
} from "./request-space-model.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { ScopedOperatorRef } from "../../../domain/governance/authority.ts";
import type {
  SpaceAdmissionPort,
  SpaceCapabilityAuthorityPort,
  SpaceControlAuthorityPort,
  SpaceControlPort,
} from "./ports.ts";
import type {
  SpaceAdmissionStorePort,
  SpaceControlCredential,
  SpaceCredentialStorePort,
  SpaceSecretPort,
} from "./control-ports.ts";

/** Host resource bounds, not product performance claims. */
const CAPABILITY_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 30 * 60 * 1000;
export const ADMISSION_MAX_MS = 24 * 60 * 60 * 1000;
const denied = () =>
  new RequestSpaceError(
    "FORBIDDEN",
    "The current local control credential is unavailable.",
  );
function requireAuthority(authority: SpaceControlAuthority, ownerId: string) {
  if (
    !effectiveSpaceControlAuthority(authority) ||
    authority.owner.operatorId !== ownerId
  ) throw denied();
}
export class SpaceControls implements SpaceControlPort {
  constructor(
    private readonly store: SpaceCredentialStorePort,
    private readonly authority: SpaceCapabilityAuthorityPort,
    private readonly secrets: SpaceSecretPort,
    private readonly now: () => number = () => Date.now(),
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {}
  private live(
    row: SpaceControlCredential | null,
    kind: "capability" | "session",
  ): asserts row is SpaceControlCredential {
    if (
      !row || row.kind !== kind || row.status !== "active" ||
      !Number.isFinite(Date.parse(row.expiresAt)) ||
      Date.parse(row.expiresAt) <= this.now()
    ) throw denied();
  }
  private async current(row: SpaceControlCredential) {
    const authority = await this.authority.current(row.ownerId);
    requireAuthority(authority, row.ownerId);
    if (!sameEffectiveSpaceControlAuthority(authority, row.authority)) {
      throw denied();
    }
  }
  /** Local composition/owned-channel only. There is deliberately no issuance HTTP route. */
  async issueCapability(
    ownerId: string,
    lifetimeMs = CAPABILITY_MAX_MS,
  ): Promise<{ secret: string; credentialId: string; expiresAt: string }> {
    if (
      !Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 ||
      lifetimeMs > CAPABILITY_MAX_MS
    ) throw denied();
    const captured = await this.authority.capture(ownerId);
    const authority = captured.authority;
    requireAuthority(authority, ownerId);
    const secret = this.secrets.randomSecret();
    if (!/^[a-f0-9]{64}$/.test(secret)) throw denied();
    const row: SpaceControlCredential & { kind: "capability" } = {
      id: this.id(),
      kind: "capability",
      ownerId,
      parentCapabilityId: null,
      authority,
      secretHash: await requestSpaceDigest({ secret }),
      revision: 0,
      status: "active",
      expiresAt: new Date(this.now() + lifetimeMs).toISOString(),
      createdAt: new Date(this.now()).toISOString(),
    };
    await this.store.insert(row, captured.adoptedState);
    return { secret, credentialId: row.id, expiresAt: row.expiresAt };
  }
  async exchange(
    capabilitySecret: string,
  ): Promise<{ secret: string; expiresAt: string }> {
    if (!/^[a-f0-9]{64}$/.test(capabilitySecret)) throw denied();
    const capability = await this.store.findHash(
      await requestSpaceDigest({ secret: capabilitySecret }),
    );
    this.live(capability, "capability");
    await this.current(capability);
    const secret = this.secrets.randomSecret();
    if (!/^[a-f0-9]{64}$/.test(secret)) throw denied();
    const row: SpaceControlCredential & { kind: "session" } = {
      id: this.id(),
      kind: "session",
      ownerId: capability.ownerId,
      parentCapabilityId: capability.id,
      authority: capability.authority,
      secretHash: await requestSpaceDigest({ secret }),
      revision: 0,
      status: "active",
      expiresAt: new Date(
        Math.min(this.now() + SESSION_MAX_MS, Date.parse(capability.expiresAt)),
      ).toISOString(),
      createdAt: new Date(this.now()).toISOString(),
    };
    await this.store.insert(row);
    return { secret, expiresAt: row.expiresAt };
  }
  async authenticateSession(secret: string): Promise<SpaceController> {
    if (!/^[a-f0-9]{64}$/.test(secret)) throw denied();
    const session = await this.store.findHash(
      await requestSpaceDigest({ secret }),
    );
    this.live(session, "session");
    const capability = session.parentCapabilityId
      ? await this.store.get(session.parentCapabilityId)
      : null;
    this.live(capability, "capability");
    // Session/controller snapshots must still identify their exact credential.
    // Only comparison with the freshly admitted control source uses policy identity.
    if (
      session.ownerId !== capability.ownerId ||
      canonical(session.authority) !== canonical(capability.authority)
    ) throw denied();
    await this.current(capability);
    return {
      ownerId: capability.ownerId,
      capabilityId: capability.id,
      capabilityRevision: capability.revision,
      sessionId: session.id,
      authority: capability.authority,
    };
  }
  /** Host-internal controller of a Main Operator opening (4.8d D3, 4.8c A1):
   * a capability issued by local composition, its secret discarded and no
   * session row. The owner's current policy must admit the opener's operator. */
  async hostController(
    ownerId: string,
    opener: ScopedOperatorRef,
  ): Promise<HostSpaceController> {
    const captured = await this.authority.current(ownerId);
    requireAuthority(captured, ownerId);
    if (!captured.operatorIds.includes(opener.operatorId)) throw denied();
    const issued = await this.issueCapability(ownerId);
    const capability = await this.store.get(issued.credentialId);
    this.live(capability, "capability");
    return {
      kind: "host",
      ownerId,
      capabilityId: capability.id,
      capabilityRevision: capability.revision,
      authority: capability.authority,
      opener: structuredClone(opener),
    };
  }
  async revalidate(controller: SpaceControlPrincipal): Promise<void> {
    if (controller.kind === "host") {
      const capability = await this.store.get(controller.capabilityId);
      this.live(capability, "capability");
      if (
        capability.ownerId !== controller.ownerId ||
        capability.revision !== controller.capabilityRevision ||
        canonical(capability.authority) !== canonical(controller.authority)
      ) throw denied();
      await this.current(capability);
      return;
    }
    const [session, capability] = await Promise.all([
      this.store.get(controller.sessionId),
      this.store.get(controller.capabilityId),
    ]);
    this.live(session, "session");
    this.live(capability, "capability");
    if (
      session.parentCapabilityId !== capability.id ||
      session.ownerId !== controller.ownerId ||
      capability.ownerId !== controller.ownerId ||
      capability.revision !== controller.capabilityRevision ||
      canonical(capability.authority) !== canonical(controller.authority)
    ) throw denied();
    await this.current(capability);
  }
  async revokeCapability(controller: SpaceController): Promise<void> {
    await this.revalidate(controller);
    const authority = await this.authority.current(controller.ownerId);
    if (!authority.acts.includes("revoke-execution")) throw denied();
    await this.store.revokeCapability(
      controller.capabilityId,
      controller.ownerId,
      controller.capabilityRevision,
    );
  }
}

/** The pinned models of a space (BO included). The caller passes the
 * coherent execution binding when one exists; before the first dispatch
 * there is none and the reader returns the opening's birth models. */
type RequestTeamModelReader = (
  record: OpeningRecord,
  binding?: RequestExecutionBinding,
) => Promise<readonly ExecutableModel[]>;

/** Persisted runtime states for the currently admitted members of one Case.
 * The reader returns only states coherent with that admission and pin. */
type RequestTeamStateReader = (
  record: OpeningRecord,
  operatorIds: readonly string[],
) => Promise<
  ReadonlyMap<
    string,
    import("../../../domain/work/dialogue.ts").SystemRuntimeState
  >
>;

export class SpaceAdmissions implements SpaceAdmissionPort {
  constructor(
    private readonly store: SpaceAdmissionStorePort,
    private readonly credentials: SpaceCredentialStorePort,
    private readonly authority: SpaceControlAuthorityPort,
    private readonly control: SpaceControlPort,
    private readonly now: () => number = () => Date.now(),
    private readonly id: () => string = () => crypto.randomUUID(),
    private readonly executionBindings?: RequestExecutionBindingPort,
    /** Pinned models of the space (BO included), when the host can read them. */
    teamModels?: RequestTeamModelReader,
  ) {
    this.#teamModels = teamModels;
  }
  #teamModels?: RequestTeamModelReader;
  #teamStates?: RequestTeamStateReader;
  #teamCreationModels?: RequestTeamCreationModelReader;
  readonly #teamCache = new Map<string, BranchTeamMember[]>();
  /** Composition binds the pinned-model reader once the source exists. */
  bindTeamModels(reader: RequestTeamModelReader): void {
    this.#teamModels = reader;
    this.#teamCache.clear();
  }
  /** Bind coherent persisted member states used to verify member-parent receipts. */
  bindTeamStates(reader: RequestTeamStateReader): void {
    this.#teamStates = reader;
    this.#teamCache.clear();
  }
  bindTeamCreationModels(reader: RequestTeamCreationModelReader): void {
    this.#teamCreationModels = reader;
    this.#teamCache.clear();
  }
  /** The branch team of this Case, from the one `branchTeam` producer. The
   * read is cached per opening base, pin, current BO digest and the BO's
   * creation receipts: what it depends on. A turn's state save changes none
   * of them, so dispatch checks never recompile the pin. */
  private async team(
    record: OpeningRecord,
    binding?: RequestExecutionBinding,
  ): Promise<BranchTeamMember[]> {
    const currentState = binding?.state;
    const current = currentState?.executionModel;
    if (!record.base || !this.#teamModels && !current) return [];
    const memberIds = binding?.admission.permissions.operatorIds?.slice(1) ??
      [];
    const memberStates = memberIds.length && this.#teamStates
      ? await this.#teamStates(record, memberIds)
      : new Map<
        string,
        import("../../../domain/work/dialogue.ts").SystemRuntimeState
      >();
    const key = canonical([
      record.id,
      record.baseDigest,
      binding?.pin.source.version ?? null,
      current?.version.digest ?? null,
      (currentState?.configuration?.changes ?? []).filter((change) =>
        change.kind === "operator-creation"
      ),
      binding?.admission.permissions.modelDigests ?? [],
      memberIds.map((
        id,
      ) => [
        id,
        memberStates.has(id)
          ? (memberStates.get(id)?.configuration?.changes ?? []).filter((
            change,
          ) => change.kind === "operator-creation")
          : null,
      ]),
    ]);
    // Without a coherent state read there is no pin to cache against.
    const cached = currentState ? this.#teamCache.get(key) : undefined;
    if (cached) return cached;
    const models = new Map<string, ExecutableModel>();
    for (const model of await this.#teamModels?.(record, binding) ?? []) {
      models.set(model.identity.builderId, model);
    }
    if (current) models.set(current.identity.builderId, current);
    const pinned = [...models.values()];
    const births = await this.#teamCreationModels?.(record, memberIds) ??
      new Map<string, ExecutableModel>();
    const owner = record.base.requestOwner.operatorId;
    const team = branchTeam(record.base, pinned, record.caseId, (child) => {
      const model = models.get(child.identity.builderId);
      const parentModel = model?.operatorTeam
        ? models.get(model.operatorTeam.parentOperatorId)
        : undefined;
      return model !== undefined && parentModel !== undefined &&
        requestTeamCreationReceiptVerifies(pinned, model, {
          space: {
            projectId: parentModel.identity.projectId,
            systemId: parentModel.identity.systemId,
            executionSpaceId: record.executionSpaceId,
          },
        }, (parent) =>
          // A member parent's receipt must come from its persisted state;
          // a missing state never falls back to the pinned configuration.
          parent.identity.builderId === owner
            ? currentState?.configuration?.changes ??
              parent.configuration.changes ?? []
            : memberStates.get(parent.identity.builderId)?.configuration
              ?.changes ?? [], births);
    }, memberIds);
    if (currentState) this.#teamCache.set(key, team);
    return team;
  }
  private async permissions(record: OpeningRecord, admissionId: string) {
    if (!record.base) throw denied();
    if (!record.admissionId || !this.executionBindings) {
      const permissions = conversationPermissions(
        record.base,
        await this.team(record),
      );
      if (!record.admissionId) {
        permissions.resourceIds = await Promise.all(
          retainedToolDescriptors(record, admissionId).map(
            retainedToolResourceId,
          ),
        );
      }
      return permissions;
    }
    const binding = await this.executionBindings.read(record);
    const team = await this.team(record, binding);
    return {
      operatorIds: [
        record.base.requestOwner.operatorId,
        ...team.map((member) => member.operatorId),
      ],
      acts: ["conversation"] as ["conversation"],
      sourceVersion: binding.pin.source.version,
      modelDigests: [
        binding.pin.modelDigest,
        ...team.map((member) => member.modelDigest),
      ],
      resourceIds: binding.admission.permissions.resourceIds,
    };
  }
  async ensure(
    record: OpeningRecord,
    controller: SpaceControlPrincipal,
  ): Promise<SpaceExecutionAdmission> {
    await this.control.revalidate(controller);
    if (
      !record.base || !record.baseDigest ||
      record.ownerId !== controller.ownerId
    ) throw denied();
    const current = await this.authority.current(controller.ownerId);
    requireAuthority(current, controller.ownerId);
    const hasTools = record.base.manifest.operators.some((operator) =>
      operator.operatorId === record.base!.requestOwner.operatorId &&
      operator.tools.length > 0
    );
    const admissionId = record.admissionId ??
      (hasTools
        ? await retainedToolAdmissionId(record.scope, record.id)
        : this.id());
    const permissions = await this.permissions(record, admissionId);
    // The person's control policy admits the BO only; every further
    // permission operator is a branchTeam member by construction above.
    if (
      canonical(current.scope) !== canonical(record.scope) ||
      !sameEffectiveSpaceControlAuthority(current, controller.authority) ||
      permissions.operatorIds[0] !== record.base.requestOwner.operatorId ||
      !current.operatorIds.includes(record.base.requestOwner.operatorId)
    ) throw denied();
    const admission = await this.store.admit({
      id: admissionId,
      scope: record.scope,
      executionSpaceId: record.executionSpaceId,
      openingId: record.id,
      ownerId: controller.ownerId,
      capabilityId: controller.capabilityId,
      capabilityRevision: controller.capabilityRevision,
      baseDigest: record.baseDigest,
      authority: current,
      permissions,
      expiresAt: new Date(this.now() + ADMISSION_MAX_MS).toISOString(),
    });
    await this.assertDispatch(record, admission);
    return admission;
  }
  async recorded(record: OpeningRecord): Promise<SpaceExecutionAdmission> {
    const admission = record.admissionId
      ? await this.store.get(record.admissionId)
      : null;
    if (!admission) throw denied();
    return admission;
  }
  async assertConversation(
    record: OpeningRecord,
    controller: SpaceController,
    expectedSource?: { sourceVersion: string; modelDigest: string },
  ): Promise<void> {
    await this.control.revalidate(controller);
    if (
      record.ownerId !== controller.ownerId || !record.admissionId ||
      !["admitted", "dispatched"].includes(record.phase)
    ) throw denied();
    const admission = await this.store.get(record.admissionId);
    if (!admission) throw denied();
    if (
      expectedSource && (
        admission.permissions.sourceVersion !== expectedSource.sourceVersion ||
        admission.permissions.operatorIds[0] !==
          record.base?.requestOwner.operatorId ||
        admission.permissions.modelDigests[0] !== expectedSource.modelDigest
      )
    ) {
      throw new RequestSpaceError(
        "ADMISSION_REFUSED",
        "The observed source is no longer the current conversation admission.",
      );
    }
    await this.assertDispatch(record, admission);
  }
  async assertDispatch(
    record: OpeningRecord,
    admission: SpaceExecutionAdmission,
  ): Promise<void> {
    const fresh = await this.store.get(admission.id);
    const capability = await this.credentials.get(admission.capabilityId);
    const current = await this.authority.current(admission.ownerId);
    const permissions = await this.permissions(record, admission.id);
    if (
      !fresh || fresh.revision !== admission.revision ||
      fresh.status !== "active" ||
      !Number.isFinite(Date.parse(fresh.expiresAt)) ||
      Date.parse(fresh.expiresAt) <= this.now() ||
      !capability || capability.kind !== "capability" ||
      capability.status !== "active" ||
      capability.revision !== fresh.capabilityRevision ||
      capability.ownerId !== fresh.ownerId ||
      fresh.openingId !== record.id || fresh.ownerId !== record.ownerId ||
      fresh.executionSpaceId !== record.executionSpaceId ||
      canonical(fresh.scope) !== canonical(record.scope) ||
      fresh.baseDigest !== record.baseDigest ||
      fresh.authority.owner.operatorId !== fresh.ownerId || !record.base ||
      canonical(fresh.permissions) !==
        canonical(permissions) ||
      !sameEffectiveSpaceControlAuthority(current, fresh.authority) ||
      !sameEffectiveSpaceControlAuthority(
        capability.authority,
        fresh.authority,
      ) ||
      canonical(current.scope) !== canonical(record.scope)
    ) {
      throw new RequestSpaceError(
        "ADMISSION_REFUSED",
        "The current space execution admission is unavailable.",
      );
    }
    // No session read here. Browser/session expiry cannot revoke admitted work.
    // This is preflight only; the worker must repeat the transaction guard at start.
  }
  async revoke(
    id: string,
    controller: SpaceController,
  ): Promise<SpaceExecutionAdmission> {
    await this.control.revalidate(controller);
    const authority = await this.authority.current(controller.ownerId);
    if (!authority.acts.includes("revoke-execution")) throw denied();
    return await this.store.revoke(id, controller);
  }
}
