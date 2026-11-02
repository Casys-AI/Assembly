import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { canonicalDigest } from "../../../domain/primitives/execution-digest.ts";
import {
  assertRequestNetworkChange,
  requestNetworkProposalDigest,
} from "../../../domain/governance/records/request-network-change.ts";
import {
  assertRequestTeamChange,
  type RequestChangeEffect,
  requestChangeEffect,
  requestChangeProposalDigest,
} from "../../../domain/governance/records/request-change.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { ScopedOperatorRef } from "../../../domain/governance/authority.ts";
import type { PendingChange } from "../../../domain/governance/records/pending-change.ts";
import {
  type OpeningRecord,
  RequestSpaceError,
} from "../../../domain/work/request-spaces.ts";
import type {
  RequestSourceOwnerAuthorityEnvelope,
  RequestSourceOwnerPhaseBinding,
} from "../../model/source-admission/request-source-owner.ts";
import {
  parseRequestCreationGrantAuthority,
  parseRequestDelegatedAuthority,
  requestCreationGrantAuthorityDigest,
  type RequestCreationGrantAuthorityEnvelope,
  requestDelegatedAuthorityDigest,
  type RequestDelegatedAuthorityEnvelope,
  type RequestWriteAuthority,
} from "../../model/source-admission/request-delegated-authority.ts";
import type { RequestSourceRevisionAccessPort } from "../../model/source-admission/revision-ports.ts";
import { parseModelWriteDossierV2 } from "../../model/publication/write-command-v2.ts";
import { assertRequestChangeDossier } from "../../model/publication/request-change.ts";
import type { RequestCaseChangeDecision } from "./conversations.ts";
import type { SystemRuntime } from "../runtime/system.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";
import type { RequestModelWriteDestination } from "../../../domain/model/editing/request-write-destination.ts";

/** Who decides a Case change: the person through their session, the Main
 * Operator under main's policy (4.8c), or the creator itself under its
 * branch-read autonomous creation grant (4.8e E4). Delegated and
 * creation-grant envelopes are built by the host only; no person-facing
 * port accepts or forwards one. */
type RequestChangeDecisionAuthority =
  | { kind: "human"; secret: string }
  | {
    kind: "delegated";
    envelope: RequestDelegatedAuthorityEnvelope;
    /** Main's admitted model the policy was read in; absent on a replay. */
    policyModel?: ExecutableModel;
  }
  | {
    kind: "creation-grant";
    envelope: RequestCreationGrantAuthorityEnvelope;
  };

/** One decision, distinct source publication and atomic adoption, by either
 * authority kind. The person's steps are unchanged; the delegated steps use no
 * session. All persistence and authentication are delegated to existing ports. */
export class RequestChangeDecision {
  constructor(
    private readonly options: {
      repositoryId: string;
      access: RequestSourceRevisionAccessPort;
      authority: {
        captureProposal(
          secret: string,
          caseId: string,
        ): Promise<RequestSourceOwnerPhaseBinding<"proposal">>;
        captureAcceptance(
          secret: string,
          proposal: RequestSourceOwnerPhaseBinding<"proposal">,
        ): Promise<RequestSourceOwnerAuthorityEnvelope>;
        revalidateProposal(
          proposal: RequestSourceOwnerPhaseBinding<"proposal">,
        ): Promise<void>;
        revalidateHumanDecision(
          authority: RequestSourceOwnerAuthorityEnvelope,
        ): Promise<void>;
      };
      runtime: {
        read(
          record: OpeningRecord,
          requester?: ScopedOperatorRef,
        ): Promise<SystemRuntimeState>;
        networkRefusalStatus(
          record: OpeningRecord,
          change: PendingChange,
          decision: NonNullable<
            SystemRuntimeState["requestNetworkDecisions"]
          >[string],
        ): Promise<"accepted" | "pending">;
        ensureNetworkRefusal(
          record: OpeningRecord,
          change: PendingChange,
          decision: NonNullable<
            SystemRuntimeState["requestNetworkDecisions"]
          >[string],
        ): Promise<void>;
      };
      decisionCommit: {
        /** A delegated decision is revalidated in the commit's fenced step. */
        record(
          record: OpeningRecord,
          input: Parameters<SystemRuntime["recordRequestNetworkDecision"]>[0],
        ): Promise<PendingChange>;
      };
      delegation: {
        /** Early, unfenced: Main's policy, the route, the admission and the
         * change as they are now. The commit port repeats it atomically. */
        revalidate(
          envelope: RequestDelegatedAuthorityEnvelope,
          opening: OpeningRecord,
        ): Promise<void>;
      };
      creationGrant: {
        /** Early, unfenced: the branch-read grant, the whole-team size, the
         * admission and the change as they are now. The commit port repeats
         * it atomically. */
        revalidate(
          envelope: RequestCreationGrantAuthorityEnvelope,
          opening: OpeningRecord,
        ): Promise<void>;
      };
      /** The verified whole-team size of a branch, for a person's team
       * decision (the creation-grant envelope carries its own). */
      branchTeamSize(opening: OpeningRecord): Promise<number>;
      preparation: {
        prepare(
          record: OpeningRecord,
          model: ExecutableModel,
          change: PendingChange,
          branchTeamSize?: number,
        ): Promise<{ proposalIntentDigest: string; expectedVersion: string }>;
      };
      publisher: {
        publish(
          value: {
            opening: OpeningRecord;
            model: ExecutableModel;
            change: PendingChange;
            authority: RequestWriteAuthority;
          },
        ): Promise<ExecutableModel>;
        resume(
          commandId: string,
          destination: RequestModelWriteDestination,
        ): Promise<ModelRevision | null>;
      };
      queue: {
        getDossier(repositoryId: string, commandId: string): Promise<unknown>;
        get(
          repositoryId: string,
          commandId: string,
        ): Promise<{ state: string; publishedVersion?: string } | null>;
      };
      admittedSource(
        opening: OpeningRecord,
      ): Promise<
        {
          receipts: readonly {
            payload: {
              command: { commandId: string };
              result: { source: { version: string } };
            };
          }[];
        }
      >;
      adoption: {
        status(
          secret: string,
          input: { caseId: string; adoptionKey: string },
        ): Promise<{ status: string; receipt?: unknown } | null>;
        prepareNetwork(
          secret: string,
          input: {
            caseId: string;
            adoptionKey: string;
            changeId: string;
            expectedAdmittedVersion: string;
            expectedExecutingDigest: string;
          },
        ): Promise<{ status: string; receipt?: unknown }>;
        resume(
          secret: string,
          input: { caseId: string; adoptionKey: string },
        ): Promise<{ status: string; receipt?: unknown }>;
        statusDelegated(
          envelope: RequestDelegatedAuthorityEnvelope,
          input: { caseId: string; adoptionKey: string },
        ): Promise<{ status: string; receipt?: unknown } | null>;
        prepareNetworkDelegated(
          envelope: RequestDelegatedAuthorityEnvelope,
          input: {
            caseId: string;
            adoptionKey: string;
            changeId: string;
            expectedAdmittedVersion: string;
            expectedExecutingDigest: string;
          },
        ): Promise<{ status: string; receipt?: unknown }>;
        resumeDelegated(
          envelope: RequestDelegatedAuthorityEnvelope,
          input: { caseId: string; adoptionKey: string },
        ): Promise<{ status: string; receipt?: unknown }>;
        prepareTeam(
          secret: string,
          input: {
            caseId: string;
            adoptionKey: string;
            changeId: string;
            expectedAdmittedVersion: string;
            expectedExecutingDigest: string;
          },
        ): Promise<{ status: string; receipt?: unknown }>;
        statusCreationGrant(
          envelope: RequestCreationGrantAuthorityEnvelope,
          input: { caseId: string; adoptionKey: string },
        ): Promise<{ status: string; receipt?: unknown } | null>;
        prepareTeamCreationGrant(
          envelope: RequestCreationGrantAuthorityEnvelope,
          input: {
            caseId: string;
            adoptionKey: string;
            changeId: string;
            expectedAdmittedVersion: string;
            expectedExecutingDigest: string;
          },
        ): Promise<{ status: string; receipt?: unknown }>;
        resumeCreationGrant(
          envelope: RequestCreationGrantAuthorityEnvelope,
          input: { caseId: string; adoptionKey: string },
        ): Promise<{ status: string; receipt?: unknown }>;
      };
    },
  ) {}
  status(
    authority: RequestChangeDecisionAuthority,
    opening: OpeningRecord,
    agentId: string,
    changeId: string,
  ) {
    return authority.kind === "human"
      ? this.#statusHuman(authority.secret, opening, agentId, changeId)
      : authority.kind === "delegated"
      ? this.#statusDelegated(authority.envelope, opening, agentId, changeId)
      : this.#statusCreationGrant(
        authority.envelope,
        opening,
        agentId,
        changeId,
      );
  }
  resume(
    authority: RequestChangeDecisionAuthority,
    opening: OpeningRecord,
    agentId: string,
    changeId: string,
  ) {
    return authority.kind === "human"
      ? this.#resumeHuman(authority.secret, opening, agentId, changeId)
      : authority.kind === "delegated"
      ? this.#resumeDelegated(authority.envelope, opening, agentId, changeId)
      : this.#resumeCreationGrant(
        authority.envelope,
        opening,
        agentId,
        changeId,
      );
  }
  decide(
    authority: RequestChangeDecisionAuthority,
    opening: OpeningRecord,
    command: RequestCaseChangeDecision,
  ) {
    return authority.kind === "human"
      ? this.#decideHuman(authority.secret, opening, command)
      : authority.kind === "delegated"
      ? this.#decideDelegated(authority, opening, command)
      : this.#decideCreationGrant(authority, opening, command);
  }
  /** The one place a change is read as its effect, closed per effect. */
  #effectOf(change: PendingChange): RequestChangeEffect {
    const effect = requestChangeEffect(change);
    if (effect === "team-member") assertRequestTeamChange(change);
    else assertRequestNetworkChange(change);
    return effect ?? "network";
  }
  async #prepare(
    opening: OpeningRecord,
    model: ExecutableModel,
    change: PendingChange,
    effect: RequestChangeEffect,
    branchTeamSize?: number,
  ) {
    return await this.options.preparation.prepare(
      opening,
      model,
      change,
      effect === "team-member"
        ? branchTeamSize ?? await this.options.branchTeamSize(opening)
        : undefined,
    );
  }
  private async recordedCommand(
    secret: string,
    opening: OpeningRecord,
    agentId: string,
    changeId: string,
  ) {
    const controller = await this.options.access.authorizeRead(
      secret,
      opening.caseId,
    );
    if (
      controller.ownerId !== opening.ownerId ||
      agentId !== opening.base?.requestOwner.operatorId
    ) throw new RequestSpaceError("FORBIDDEN", "Request decision unavailable");
    const state = await this.options.runtime.read(opening);
    const change = state.configuration?.changes.find((entry) =>
      entry.id === changeId && entry.caseId === opening.caseId &&
      entry.requestedBy === agentId
    );
    if (!change) {
      throw new RequestSpaceError("FORBIDDEN", "Request decision unavailable");
    }
    const effect = this.#effectOf(change);
    const saved = state.requestNetworkDecisions?.[changeId];
    if (
      saved &&
      (saved.openingId !== opening.id ||
        saved.executionSpaceId !== opening.executionSpaceId ||
        saved.caseId !== opening.caseId || saved.commandId !== changeId ||
        saved.proposalIntentDigest !==
          await requestChangeProposalDigest(change) ||
        // The person's decision, or a recorded builder one (4.8d, 4.8e).
        change.authority !== (saved.authority ? "builder" : "human") ||
        change.status !==
          (saved.verdict === "approve" ? "approved" : "refused"))
    ) {
      throw new RequestSpaceError(
        "OPENING_CONFLICT",
        "Request decision changed",
      );
    }
    await this.options.access.revalidateRead(controller, opening.caseId);
    return { controller, change, saved, effect };
  }
  async #statusHuman(
    secret: string,
    opening: OpeningRecord,
    agentId: string,
    changeId: string,
  ) {
    const { controller, change, saved, effect } = await this.recordedCommand(
      secret,
      opening,
      agentId,
      changeId,
    );
    let status:
      | "pending"
      | "decision-recorded"
      | "publication-pending"
      | "published-awaiting-adoption"
      | "adopted"
      | "refused"
      | "refused-awaiting-continuation"
      | "blocked" = "pending";
    if (saved?.verdict === "refuse") {
      const continuation = await this.options.runtime.networkRefusalStatus(
        opening,
        change,
        saved,
      );
      status = continuation === "accepted"
        ? "refused"
        : "refused-awaiting-continuation";
    } else if (saved?.verdict === "approve") {
      const entry = await this.options.queue.get(
        this.options.repositoryId,
        changeId,
      );
      if (!entry) status = "decision-recorded";
      else if (["refused", "needs-decision"].includes(entry.state)) {
        status = "blocked";
      } else if (entry.state !== "published") status = "publication-pending";
      else {
        const raw = await this.options.queue.getDossier(
          this.options.repositoryId,
          changeId,
        );
        if (!raw) {
          throw new RequestSpaceError(
            "UNAVAILABLE",
            "Publication proof unavailable",
          );
        }
        const dossier = await parseModelWriteDossierV2(raw);
        assertRequestChangeDossier(dossier);
        if (
          dossier.command.commandId !== changeId ||
          dossier.command.destination.openingId !== opening.id ||
          dossier.command.destination.executionSpaceId !==
            opening.executionSpaceId ||
          canonical(dossier.command.destination.host) !==
            canonical(opening.scope) ||
          canonical(dossier.decision.change) !== canonical(change)
        ) {
          throw new RequestSpaceError(
            "OPENING_CONFLICT",
            "Publication proof changed",
          );
        }
        await this.options.access.assertOwnedDestination(
          controller,
          opening.caseId,
          dossier.command.destination,
        );
        const chain = await this.options.admittedSource(opening);
        const receipts = chain.receipts.filter((r) =>
          r.payload.command.commandId === changeId &&
          r.payload.result.source.version === entry.publishedVersion
        );
        if (receipts.length !== 1) {
          throw new RequestSpaceError(
            "UNAVAILABLE",
            "Publication receipt unavailable",
          );
        }
        const adoptionKey = await requestChangeAdoptionKey(
          opening,
          changeId,
          effect,
        );
        const lookup = { caseId: opening.caseId, adoptionKey };
        const adoption = saved.authority?.kind === "delegated"
          ? await this.options.adoption.statusDelegated(
            parseRequestDelegatedAuthority(saved.authority.envelope),
            lookup,
          )
          : saved.authority?.kind === "creation-grant"
          ? await this.options.adoption.statusCreationGrant(
            parseRequestCreationGrantAuthority(saved.authority.envelope),
            lookup,
          )
          : await this.options.adoption.status(secret, lookup);
        status = adoption?.status === "adopted" && adoption.receipt
          ? "adopted"
          : "published-awaiting-adoption";
      }
    }
    await this.options.access.revalidateRead(controller, opening.caseId);
    return {
      caseId: opening.caseId,
      changeId,
      status,
      canResume: saved !== undefined,
    };
  }
  async #resumeHuman(
    secret: string,
    opening: OpeningRecord,
    agentId: string,
    changeId: string,
  ) {
    const { saved } = await this.recordedCommand(
      secret,
      opening,
      agentId,
      changeId,
    );
    if (!saved) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "No recorded decision can be resumed",
      );
    }
    const command = {
      agentId,
      caseId: opening.caseId,
      changeId,
      expectedRevision: saved.expectedRevision,
      configurationRevision: saved.configurationRevision,
      verdict: saved.verdict,
    };
    // The MO's recorded decision stands (A2): the person continues it from
    // its record; no new decision is taken.
    const result = saved.authority?.kind === "delegated"
      ? await this.#decideDelegated(
        {
          kind: "delegated",
          envelope: parseRequestDelegatedAuthority(saved.authority.envelope),
        },
        opening,
        command,
      )
      : saved.authority?.kind === "creation-grant"
      ? await this.#decideCreationGrant(
        {
          kind: "creation-grant",
          envelope: parseRequestCreationGrantAuthority(
            saved.authority.envelope,
          ),
        },
        opening,
        command,
      )
      : await this.#decideHuman(secret, opening, command);
    return { ...result, canResume: true };
  }
  async #decideHuman(
    secret: string,
    opening: OpeningRecord,
    command: RequestCaseChangeDecision,
  ) {
    const fail = (): never => {
      throw new RequestSpaceError(
        "OPENING_CONFLICT",
        "The exact Case decision or publication has changed.",
      );
    };
    if (
      !opening.base || !opening.baseDigest ||
      command.caseId !== opening.caseId ||
      command.agentId !== opening.base.requestOwner.operatorId ||
      !["approve", "refuse"].includes(command.verdict)
    ) return fail();
    const controller = await this.options.access.authorizeRead(
      secret,
      opening.caseId,
    );
    if (controller.ownerId !== opening.ownerId) return fail();
    let state = await this.options.runtime.read(opening),
      model = state.executionModel;
    let change = state.configuration?.changes.find((entry) =>
      entry.id === command.changeId
    );
    if (
      !model || !change || change.caseId !== opening.caseId ||
      change.requestedBy !== command.agentId ||
      change.baseRevision !== command.configurationRevision
    ) return fail();
    const effect = this.#effectOf(change);
    const adoptionKey = await requestChangeAdoptionKey(
      opening,
      command.changeId,
      effect,
    );
    const intentDigest = await requestChangeProposalDigest(change);
    let recorded = state.requestNetworkDecisions?.[command.changeId];
    if (recorded) {
      if (
        canonical(recorded) !== canonical({
            openingId: opening.id,
            executionSpaceId: opening.executionSpaceId,
            caseId: opening.caseId,
            commandId: change.id,
            expectedRevision: command.expectedRevision,
            configurationRevision: command.configurationRevision,
            proposalIntentDigest: intentDigest,
            verdict: command.verdict,
          }) ||
        change.authority !== "human" ||
        change.status !==
          (command.verdict === "approve" ? "approved" : "refused")
      ) return fail();
    } else {
      if (
        change.status !== "pending" ||
        state.revision !== command.expectedRevision
      ) return fail();
      const proposal = await this.options.authority.captureProposal(
        secret,
        opening.caseId,
      );
      const prepared = await this.#prepare(opening, model, change, effect);
      if (prepared.proposalIntentDigest !== intentDigest) return fail();
      const authority = await this.options.authority.captureAcceptance(
        secret,
        proposal,
      );
      await this.options.authority.revalidateProposal(proposal);
      await this.options.authority.revalidateHumanDecision(authority);
      change = await this.options.decisionCommit.record(opening, {
        reservationId: `${effect}-decision:${command.changeId}`,
        caseId: opening.caseId,
        openingId: opening.id,
        executionSpaceId: opening.executionSpaceId,
        changeId: command.changeId,
        expectedRevision: command.expectedRevision,
        configurationRevision: command.configurationRevision,
        proposalIntentDigest: intentDigest,
        verdict: command.verdict,
        authority,
      });
      state = await this.options.runtime.read(opening);
      model = state.executionModel;
      recorded = state.requestNetworkDecisions?.[change.id];
      if (!model || !recorded) return fail();
    }
    if (command.verdict === "approve") {
      const status = await this.options.adoption.status(secret, {
        caseId: opening.caseId,
        adoptionKey,
      });
      if (status?.status === "adopted" && status.receipt) {
        // Resume is the dedicated idempotent R1 continuation seam; a read-only
        // adoption status alone cannot ensure that the successor was woken.
        const resumed = await this.options.adoption.resume(secret, {
          caseId: opening.caseId,
          adoptionKey,
        });
        await this.options.access.revalidateRead(controller, opening.caseId);
        return {
          status: resumed.status === "adopted" && resumed.receipt
            ? "adopted" as const
            : "blocked" as const,
          caseId: opening.caseId,
          changeId: command.changeId,
        };
      }
    }
    if (command.verdict === "refuse") {
      if (!recorded) return fail();
      let accepted = false;
      try {
        await this.options.runtime.ensureNetworkRefusal(
          opening,
          change,
          recorded,
        );
        accepted = true;
      } catch (error) {
        if (
          !(error instanceof RequestSpaceError) ||
          !["UNAVAILABLE", "ADMISSION_REFUSED"].includes(error.code)
        ) throw error;
      }
      await this.options.access.revalidateRead(controller, opening.caseId);
      return {
        status: accepted
          ? "refused" as const
          : "refused-awaiting-continuation" as const,
        caseId: opening.caseId,
        changeId: command.changeId,
      };
    }
    let version: string | undefined;
    const raw = await this.options.queue.getDossier(
      this.options.repositoryId,
      change.id,
    );
    if (raw) {
      const dossier = await parseModelWriteDossierV2(raw);
      assertRequestChangeDossier(dossier);
      if (
        dossier.command.commandId !== change.id ||
        dossier.command.destination.openingId !== opening.id ||
        dossier.command.destination.executionSpaceId !==
          opening.executionSpaceId ||
        canonical(dossier.command.destination.host) !==
          canonical(opening.scope) ||
        canonical(dossier.decision.change) !== canonical(change)
      ) return fail();
      await this.options.access.assertOwnedDestination(
        controller,
        opening.caseId,
        dossier.command.destination,
      );
      const result = await this.options.publisher.resume(
        change.id,
        dossier.command.destination,
      );
      version = result?.version;
    } else {
      const proposal = await this.options.authority.captureProposal(
        secret,
        opening.caseId,
      );
      const prepared = await this.#prepare(opening, model, change, effect);
      if (prepared.proposalIntentDigest !== intentDigest) return fail();
      const authority = await this.options.authority.captureAcceptance(
        secret,
        proposal,
      );
      await this.options.authority.revalidateProposal(proposal);
      await this.options.authority.revalidateHumanDecision(authority);
      const published = await this.options.publisher.publish({
        opening,
        model,
        change,
        authority,
      });
      version = published.version.repositoryVersion;
    }
    await this.options.access.revalidateRead(controller, opening.caseId);
    if (!version) {
      return {
        status: "blocked" as const,
        caseId: opening.caseId,
        changeId: command.changeId,
      };
    }
    const adoptionInput = {
      caseId: opening.caseId,
      adoptionKey,
      changeId: change.id,
      expectedAdmittedVersion: version,
      expectedExecutingDigest: change.baseModelDigest!,
    };
    if (effect === "team-member") {
      await this.options.adoption.prepareTeam(secret, adoptionInput);
    } else {
      await this.options.adoption.prepareNetwork(secret, adoptionInput);
    }
    const resumed = await this.options.adoption.resume(secret, {
      caseId: opening.caseId,
      adoptionKey,
    });
    return {
      status: resumed.status === "adopted" && resumed.receipt
        ? "adopted" as const
        : "blocked" as const,
      caseId: opening.caseId,
      changeId: command.changeId,
    };
  }

  /** The delegated record of this exact operator command, if any. */
  async #delegatedCommand(
    envelope: RequestDelegatedAuthorityEnvelope,
    opening: OpeningRecord,
    agentId: string,
    changeId: string,
  ) {
    const fail = (): never => {
      throw new RequestSpaceError(
        "OPENING_CONFLICT",
        "The exact delegated Case decision has changed.",
      );
    };
    const authority = parseRequestDelegatedAuthority(envelope);
    const target = authority.destination;
    if (
      !opening.base || agentId !== authority.requester.operatorId ||
      target.openingId !== opening.id ||
      target.executionSpaceId !== opening.executionSpaceId ||
      target.caseId !== opening.caseId ||
      target.branchId !== opening.branchId ||
      canonical(target.host) !== canonical(opening.scope) ||
      authority.route.changeId !== changeId
    ) return fail();
    const digest = await requestDelegatedAuthorityDigest(authority);
    const state = await this.options.runtime.read(opening, authority.requester);
    const change = state.configuration?.changes.find((entry) =>
      entry.id === changeId && entry.caseId === opening.caseId &&
      entry.requestedBy === agentId
    );
    if (!change) return fail();
    // A delegated envelope decides network changes only; it never creates.
    if (requestChangeEffect(change) === "team-member") return fail();
    assertRequestNetworkChange(change);
    const saved = state.requestNetworkDecisions?.[changeId];
    // A4: a replay of the same operator command reaches its recorded outcome;
    // any other recorded decision, by the person or another command, is final.
    if (
      saved &&
      (saved.authority?.kind !== "delegated" ||
        saved.authority.digest !== digest ||
        saved.openingId !== opening.id ||
        saved.executionSpaceId !== opening.executionSpaceId ||
        saved.caseId !== opening.caseId || saved.commandId !== changeId ||
        saved.proposalIntentDigest !==
          await requestNetworkProposalDigest(change) ||
        change.authority !== "builder" ||
        change.status !==
          (saved.verdict === "approve" ? "approved" : "refused"))
    ) return fail();
    return { authority, digest, state, change, saved, fail };
  }
  async #statusDelegated(
    envelope: RequestDelegatedAuthorityEnvelope,
    opening: OpeningRecord,
    agentId: string,
    changeId: string,
  ) {
    const { authority, change, saved } = await this.#delegatedCommand(
      envelope,
      opening,
      agentId,
      changeId,
    );
    let status:
      | "pending"
      | "decision-recorded"
      | "publication-pending"
      | "published-awaiting-adoption"
      | "adopted"
      | "refused"
      | "refused-awaiting-continuation"
      | "blocked" = "pending";
    if (saved?.verdict === "refuse") {
      status = await this.options.runtime.networkRefusalStatus(
          opening,
          change,
          saved,
        ) === "accepted"
        ? "refused"
        : "refused-awaiting-continuation";
    } else if (saved?.verdict === "approve") {
      const entry = await this.options.queue.get(
        this.options.repositoryId,
        changeId,
      );
      if (!entry) status = "decision-recorded";
      else if (["refused", "needs-decision"].includes(entry.state)) {
        status = "blocked";
      } else if (entry.state !== "published") status = "publication-pending";
      else {
        const adoption = await this.options.adoption.statusDelegated(
          authority,
          {
            caseId: opening.caseId,
            adoptionKey: await requestChangeAdoptionKey(
              opening,
              changeId,
              "network",
            ),
          },
        );
        status = adoption?.status === "adopted" && adoption.receipt
          ? "adopted"
          : "published-awaiting-adoption";
      }
    }
    return {
      caseId: opening.caseId,
      changeId,
      status,
      canResume: saved !== undefined,
    };
  }
  async #resumeDelegated(
    envelope: RequestDelegatedAuthorityEnvelope,
    opening: OpeningRecord,
    agentId: string,
    changeId: string,
  ) {
    const { saved } = await this.#delegatedCommand(
      envelope,
      opening,
      agentId,
      changeId,
    );
    if (!saved) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "No recorded decision can be resumed",
      );
    }
    const result = await this.#decideDelegated(
      {
        kind: "delegated",
        envelope,
      },
      opening,
      {
        agentId,
        caseId: opening.caseId,
        changeId,
        expectedRevision: saved.expectedRevision,
        configurationRevision: saved.configurationRevision,
        verdict: saved.verdict,
      },
    );
    return { ...result, canResume: true };
  }
  /** The MO's decision: revalidated, then recorded atomically with Main's
   * policy (A2), then published in the BO's branch and its approved host delta
   * adopted, from the stored record, with no session. */
  async #decideDelegated(
    input: Extract<RequestChangeDecisionAuthority, { kind: "delegated" }>,
    opening: OpeningRecord,
    command: RequestCaseChangeDecision,
  ) {
    if (
      command.caseId !== opening.caseId ||
      !["approve", "refuse"].includes(command.verdict)
    ) {
      throw new RequestSpaceError(
        "OPENING_CONFLICT",
        "The exact delegated Case decision has changed.",
      );
    }
    const recordedCommand = await this.#delegatedCommand(
      input.envelope,
      opening,
      command.agentId,
      command.changeId,
    );
    const { authority, digest, fail } = recordedCommand;
    let { state, saved: recorded } = recordedCommand;
    let change: PendingChange = recordedCommand.change;
    let model = state.executionModel;
    if (!model || change.baseRevision !== command.configurationRevision) {
      return fail();
    }
    const adoptionKey = await requestChangeAdoptionKey(
      opening,
      change.id,
      "network",
    );
    const intentDigest = await requestNetworkProposalDigest(change);
    if (recorded) {
      if (
        recorded.verdict !== command.verdict ||
        recorded.expectedRevision !== command.expectedRevision ||
        recorded.configurationRevision !== command.configurationRevision
      ) return fail();
    } else {
      if (
        change.status !== "pending" ||
        state.revision !== command.expectedRevision || !input.policyModel
      ) return fail();
      const prepared = await this.options.preparation.prepare(
        opening,
        model,
        change,
      );
      if (prepared.proposalIntentDigest !== intentDigest) return fail();
      await this.options.delegation.revalidate(authority, opening);
      change = await this.options.decisionCommit.record(opening, {
        reservationId: `network-decision:${command.changeId}`,
        caseId: opening.caseId,
        openingId: opening.id,
        executionSpaceId: opening.executionSpaceId,
        changeId: command.changeId,
        expectedRevision: command.expectedRevision,
        configurationRevision: command.configurationRevision,
        proposalIntentDigest: intentDigest,
        verdict: command.verdict,
        authority,
        policyModel: input.policyModel,
      });
      state = await this.options.runtime.read(opening, authority.requester);
      model = state.executionModel;
      recorded = state.requestNetworkDecisions?.[change.id];
      if (!model || !recorded) return fail();
    }
    if (command.verdict === "refuse") {
      let accepted = false;
      try {
        await this.options.runtime.ensureNetworkRefusal(
          opening,
          change,
          recorded,
        );
        accepted = true;
      } catch (error) {
        if (
          !(error instanceof RequestSpaceError) ||
          !["UNAVAILABLE", "ADMISSION_REFUSED"].includes(error.code)
        ) throw error;
      }
      return {
        status: accepted
          ? "refused" as const
          : "refused-awaiting-continuation" as const,
        caseId: opening.caseId,
        changeId: command.changeId,
      };
    }
    const adopted = await this.options.adoption.statusDelegated(authority, {
      caseId: opening.caseId,
      adoptionKey,
    });
    if (adopted?.status === "adopted" && adopted.receipt) {
      // The same idempotent R1 continuation seam as the person's path.
      const resumed = await this.options.adoption.resumeDelegated(authority, {
        caseId: opening.caseId,
        adoptionKey,
      });
      return {
        status: resumed.status === "adopted" && resumed.receipt
          ? "adopted" as const
          : "blocked" as const,
        caseId: opening.caseId,
        changeId: command.changeId,
      };
    }
    let version: string | undefined;
    const raw = await this.options.queue.getDossier(
      this.options.repositoryId,
      change.id,
    );
    if (raw) {
      const dossier = await parseModelWriteDossierV2(raw);
      assertRequestChangeDossier(dossier);
      if (
        dossier.command.commandId !== change.id ||
        dossier.command.authorityRef.kind !== authority.kind ||
        dossier.command.authorityRef.digest !== digest ||
        canonical(dossier.command.destination) !==
          canonical(authority.destination) ||
        canonical(dossier.decision.change) !== canonical(change)
      ) return fail();
      version = (await this.options.publisher.resume(
        change.id,
        dossier.command.destination,
      ))?.version;
    } else {
      version = (await this.options.publisher.publish({
        opening,
        model,
        change,
        authority,
      })).version.repositoryVersion;
    }
    if (!version) {
      return {
        status: "blocked" as const,
        caseId: opening.caseId,
        changeId: command.changeId,
      };
    }
    await this.options.adoption.prepareNetworkDelegated(authority, {
      caseId: opening.caseId,
      adoptionKey,
      changeId: change.id,
      expectedAdmittedVersion: version,
      expectedExecutingDigest: change.baseModelDigest!,
    });
    const resumed = await this.options.adoption.resumeDelegated(authority, {
      caseId: opening.caseId,
      adoptionKey,
    });
    return {
      status: resumed.status === "adopted" && resumed.receipt
        ? "adopted" as const
        : "blocked" as const,
      caseId: opening.caseId,
      changeId: command.changeId,
    };
  }

  /** The creation-grant record of this exact change, if any. */
  async #creationGrantCommand(
    envelope: RequestCreationGrantAuthorityEnvelope,
    opening: OpeningRecord,
    agentId: string,
    changeId: string,
  ) {
    const fail = (): never => {
      throw new RequestSpaceError(
        "OPENING_CONFLICT",
        "The exact creation-grant Case decision has changed.",
      );
    };
    const authority = parseRequestCreationGrantAuthority(envelope);
    const target = authority.destination;
    if (
      !opening.base || agentId !== authority.requester.operatorId ||
      target.openingId !== opening.id ||
      target.executionSpaceId !== opening.executionSpaceId ||
      target.caseId !== opening.caseId ||
      target.branchId !== opening.branchId ||
      canonical(target.host) !== canonical(opening.scope) ||
      authority.exercise.creationDelegation?.changeId !== changeId
    ) return fail();
    const digest = await requestCreationGrantAuthorityDigest(authority);
    const state = await this.options.runtime.read(opening, authority.requester);
    const change = state.configuration?.changes.find((entry) =>
      entry.id === changeId && entry.caseId === opening.caseId &&
      entry.requestedBy === agentId
    );
    if (!change) return fail();
    assertRequestTeamChange(change);
    const saved = state.requestNetworkDecisions?.[changeId];
    if (
      saved &&
      (saved.authority?.kind !== "creation-grant" ||
        saved.authority.digest !== digest ||
        saved.openingId !== opening.id ||
        saved.executionSpaceId !== opening.executionSpaceId ||
        saved.caseId !== opening.caseId || saved.commandId !== changeId ||
        saved.proposalIntentDigest !==
          await requestChangeProposalDigest(change) ||
        change.authority !== "builder" ||
        change.status !== "approved")
    ) return fail();
    return { authority, digest, state, change, saved, fail };
  }
  async #statusCreationGrant(
    envelope: RequestCreationGrantAuthorityEnvelope,
    opening: OpeningRecord,
    agentId: string,
    changeId: string,
  ) {
    const { authority, saved } = await this.#creationGrantCommand(
      envelope,
      opening,
      agentId,
      changeId,
    );
    let status:
      | "pending"
      | "decision-recorded"
      | "publication-pending"
      | "published-awaiting-adoption"
      | "adopted"
      | "blocked" = "pending";
    if (saved?.verdict === "approve") {
      const entry = await this.options.queue.get(
        this.options.repositoryId,
        changeId,
      );
      if (!entry) status = "decision-recorded";
      else if (["refused", "needs-decision"].includes(entry.state)) {
        status = "blocked";
      } else if (entry.state !== "published") status = "publication-pending";
      else {
        const adoption = await this.options.adoption.statusCreationGrant(
          authority,
          {
            caseId: opening.caseId,
            adoptionKey: await requestChangeAdoptionKey(
              opening,
              changeId,
              "team-member",
            ),
          },
        );
        status = adoption?.status === "adopted" && adoption.receipt
          ? "adopted"
          : "published-awaiting-adoption";
      }
    }
    return {
      caseId: opening.caseId,
      changeId,
      status,
      canResume: saved !== undefined,
    };
  }
  async #resumeCreationGrant(
    envelope: RequestCreationGrantAuthorityEnvelope,
    opening: OpeningRecord,
    agentId: string,
    changeId: string,
  ) {
    const { saved } = await this.#creationGrantCommand(
      envelope,
      opening,
      agentId,
      changeId,
    );
    if (!saved) {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "No recorded decision can be resumed",
      );
    }
    const result = await this.#decideCreationGrant(
      { kind: "creation-grant", envelope },
      opening,
      {
        agentId,
        caseId: opening.caseId,
        changeId,
        expectedRevision: saved.expectedRevision,
        configurationRevision: saved.configurationRevision,
        verdict: saved.verdict,
      },
    );
    return { ...result, canResume: true };
  }
  /** The creator's own decision under its branch-read grant: revalidated,
   * recorded atomically with the grant, then published in its branch and
   * the one provisioned teammate adopted, from the stored record, with no
   * session and no route. A creation grant only approves. */
  async #decideCreationGrant(
    input: Extract<RequestChangeDecisionAuthority, { kind: "creation-grant" }>,
    opening: OpeningRecord,
    command: RequestCaseChangeDecision,
  ) {
    if (command.caseId !== opening.caseId) {
      throw new RequestSpaceError(
        "OPENING_CONFLICT",
        "The exact creation-grant Case decision has changed.",
      );
    }
    if (command.verdict !== "approve") {
      throw new RequestSpaceError(
        "FORBIDDEN",
        "A creation grant only approves its own creation",
        {
          context: { changeId: command.changeId, caseId: opening.caseId },
          recovery:
            "Leave the proposal pending for the person's card, or do not create the teammate.",
        },
      );
    }
    const recordedCommand = await this.#creationGrantCommand(
      input.envelope,
      opening,
      command.agentId,
      command.changeId,
    );
    const { authority, digest, fail } = recordedCommand;
    let { state, saved: recorded } = recordedCommand;
    let change: PendingChange = recordedCommand.change;
    let model = state.executionModel;
    if (!model || change.baseRevision !== command.configurationRevision) {
      return fail();
    }
    const adoptionKey = await requestChangeAdoptionKey(
      opening,
      change.id,
      "team-member",
    );
    const intentDigest = await requestChangeProposalDigest(change);
    if (recorded) {
      if (
        recorded.verdict !== command.verdict ||
        recorded.expectedRevision !== command.expectedRevision ||
        recorded.configurationRevision !== command.configurationRevision
      ) return fail();
    } else {
      if (
        change.status !== "pending" ||
        state.revision !== command.expectedRevision
      ) return fail();
      const prepared = await this.#prepare(
        opening,
        model,
        change,
        "team-member",
        authority.branchTeamSize,
      );
      if (prepared.proposalIntentDigest !== intentDigest) return fail();
      await this.options.creationGrant.revalidate(authority, opening);
      change = await this.options.decisionCommit.record(opening, {
        reservationId: `team-member-decision:${command.changeId}`,
        caseId: opening.caseId,
        openingId: opening.id,
        executionSpaceId: opening.executionSpaceId,
        changeId: command.changeId,
        expectedRevision: command.expectedRevision,
        configurationRevision: command.configurationRevision,
        proposalIntentDigest: intentDigest,
        verdict: command.verdict,
        authority,
      });
      state = await this.options.runtime.read(opening, authority.requester);
      model = state.executionModel;
      recorded = state.requestNetworkDecisions?.[change.id];
      if (!model || !recorded) return fail();
    }
    const adopted = await this.options.adoption.statusCreationGrant(
      authority,
      { caseId: opening.caseId, adoptionKey },
    );
    if (adopted?.status === "adopted" && adopted.receipt) {
      const resumed = await this.options.adoption.resumeCreationGrant(
        authority,
        { caseId: opening.caseId, adoptionKey },
      );
      return {
        status: resumed.status === "adopted" && resumed.receipt
          ? "adopted" as const
          : "blocked" as const,
        caseId: opening.caseId,
        changeId: command.changeId,
      };
    }
    let version: string | undefined;
    const raw = await this.options.queue.getDossier(
      this.options.repositoryId,
      change.id,
    );
    if (raw) {
      const dossier = await parseModelWriteDossierV2(raw);
      assertRequestChangeDossier(dossier);
      if (
        dossier.command.commandId !== change.id ||
        dossier.command.authorityRef.kind !== authority.kind ||
        dossier.command.authorityRef.digest !== digest ||
        canonical(dossier.command.destination) !==
          canonical(authority.destination) ||
        canonical(dossier.decision.change) !== canonical(change)
      ) return fail();
      version = (await this.options.publisher.resume(
        change.id,
        dossier.command.destination,
      ))?.version;
    } else {
      version = (await this.options.publisher.publish({
        opening,
        model,
        change,
        authority,
      })).version.repositoryVersion;
    }
    if (!version) {
      return {
        status: "blocked" as const,
        caseId: opening.caseId,
        changeId: command.changeId,
      };
    }
    await this.options.adoption.prepareTeamCreationGrant(authority, {
      caseId: opening.caseId,
      adoptionKey,
      changeId: change.id,
      expectedAdmittedVersion: version,
      expectedExecutingDigest: change.baseModelDigest!,
    });
    const resumed = await this.options.adoption.resumeCreationGrant(
      authority,
      { caseId: opening.caseId, adoptionKey },
    );
    return {
      status: resumed.status === "adopted" && resumed.receipt
        ? "adopted" as const
        : "blocked" as const,
      caseId: opening.caseId,
      changeId: command.changeId,
    };
  }
}

/** The same deterministic adoption key for every authority kind of one
 * effect; the network key keeps its historical bytes. */
async function requestChangeAdoptionKey(
  opening: OpeningRecord,
  changeId: string,
  effect: RequestChangeEffect,
): Promise<string> {
  const prefix = effect === "team-member" ? "team" : "network";
  return `${prefix}-${await canonicalDigest({
    host: opening.scope,
    openingId: opening.id,
    executionSpaceId: opening.executionSpaceId,
    caseId: opening.caseId,
    changeId,
  })}`;
}
