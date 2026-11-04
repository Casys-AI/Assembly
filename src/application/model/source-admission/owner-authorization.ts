import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  type ModelWriteDossierV2,
  parseModelWriteDossierV2,
} from "../publication/write-command-v2.ts";
import { assertRequestChangeDossier } from "../publication/request-change.ts";
import {
  assertRequestSourceOwnerPhaseMatches,
  captureRequestSourceOwnerPhase,
  parseRequestSourceOwnerAuthority,
  parseRequestSourceOwnerPhaseBinding,
  type RequestSourceOwnerAuthorityEnvelope,
  type RequestSourceOwnerContext,
  RequestSourceOwnerError,
  type RequestSourceOwnerPhaseBinding,
  type RequestSourceOwnerPrincipal,
} from "./request-source-owner.ts";
import type {
  SpaceController,
  SpaceControlSourceBinding,
} from "../../../domain/work/request-spaces/space-control.ts";

/** Human local channel only. Its adapter must use current real session/parent
 * capability/PRIMARY checks; no token, secret hash or software cast is returned. */
export interface RequestSourceOwnerSessionEvidence {
  readonly kind: "request-source-owner-session";
  readonly controller: SpaceController;
  readonly sessionRevision: number;
}
export interface RequestSourceOwnerSessionPort {
  authenticate(secret: string): Promise<RequestSourceOwnerSessionEvidence>;
  revalidate(evidence: RequestSourceOwnerSessionEvidence): Promise<void>;
}
export interface RequestSourceOwnerContextPort {
  /** D2-resolved initialized active/open owned Request and physically verified,
   * compiled prior A0. Never resolve from inspected I, execution R or raw HEAD. */
  resolve(
    caseId: string,
    controller: SpaceController,
  ): Promise<RequestSourceOwnerContext>;
  assertCurrent(binding: RequestSourceOwnerPhaseBinding): Promise<void>;
}
function sessionOf(
  principal: RequestSourceOwnerPrincipal,
): RequestSourceOwnerSessionEvidence {
  return {
    kind: "request-source-owner-session",
    controller: principal.controller,
    sessionRevision: principal.sessionRevision,
  };
}
export class RequestSourceOwnerAuthorization {
  private readonly binding: SpaceControlSourceBinding;
  constructor(
    private readonly options: {
      binding: SpaceControlSourceBinding;
      sessions: RequestSourceOwnerSessionPort;
      source: RequestSourceOwnerContextPort;
      now(): string;
    },
  ) {
    this.binding = structuredClone(options.binding);
  }
  private async capture<P extends "proposal" | "acceptance">(
    secret: string,
    caseId: string,
    phase: P,
  ): Promise<RequestSourceOwnerPhaseBinding<P>> {
    const session = structuredClone(
      await this.options.sessions.authenticate(secret),
    );
    if (
      session.kind !== "request-source-owner-session" ||
      Object.keys(session).some((key) =>
        !["kind", "controller", "sessionRevision"].includes(key)
      )
    ) throw new RequestSourceOwnerError("human-local-channel-required");
    await this.options.sessions.revalidate(structuredClone(session));
    const context = structuredClone(
      await this.options.source.resolve(
        caseId,
        structuredClone(session.controller),
      ),
    );
    if (context.destination.caseId !== caseId) {
      throw new RequestSourceOwnerError("resolved-case-differs");
    }
    const binding = captureRequestSourceOwnerPhase({
      phase,
      controller: session.controller,
      sessionRevision: session.sessionRevision,
      context,
      binding: this.binding,
      capturedAt: this.options.now(),
    });
    await this.options.source.assertCurrent(structuredClone(binding));
    await this.options.sessions.revalidate(structuredClone(session));
    return parseRequestSourceOwnerPhaseBinding(binding, phase);
  }
  captureProposal(
    secret: string,
    caseId: string,
  ): Promise<RequestSourceOwnerPhaseBinding<"proposal">> {
    return this.capture(secret, caseId, "proposal");
  }
  async captureAcceptance(
    secret: string,
    storedProposal: RequestSourceOwnerPhaseBinding<"proposal">,
  ): Promise<RequestSourceOwnerAuthorityEnvelope> {
    // Preserve the independently recorded proposal before any authentication
    // await; reconnect may supply another valid session for acceptance.
    const proposal = parseRequestSourceOwnerPhaseBinding(
      storedProposal,
      "proposal",
    );
    const acceptance = await this.capture(
      secret,
      proposal.destination.caseId,
      "acceptance",
    );
    return parseRequestSourceOwnerAuthority({
      v: 1,
      kind: "request-source-owner-authority",
      proposal,
      acceptance,
    });
  }
  async revalidateProposal(
    value: RequestSourceOwnerPhaseBinding<"proposal">,
  ): Promise<void> {
    const proposal = parseRequestSourceOwnerPhaseBinding(value, "proposal");
    const session = sessionOf(proposal.principal);
    await this.options.sessions.revalidate(structuredClone(session));
    const context = structuredClone(
      await this.options.source.resolve(
        proposal.destination.caseId,
        structuredClone(session.controller),
      ),
    );
    assertRequestSourceOwnerPhaseMatches(proposal, context, this.binding);
    await this.options.source.assertCurrent(structuredClone(proposal));
    await this.options.sessions.revalidate(structuredClone(session));
  }
  async revalidateAcceptance(
    value: RequestSourceOwnerAuthorityEnvelope,
    commandKind: string,
  ): Promise<void> {
    const authority = parseRequestSourceOwnerAuthority(value);
    if (commandKind !== "accept-proposal") {
      throw new RequestSourceOwnerError("unsupported-human-source-command");
    }
    await this.revalidateCurrentAcceptance(authority);
  }
  /** The command discriminator alone is not authority: validate the complete
   * bounded human-approved dossier and independently revalidate its D2. */
  async revalidateApprovedNetwork(
    value: RequestSourceOwnerAuthorityEnvelope,
    raw: ModelWriteDossierV2,
  ): Promise<void> {
    const authority = parseRequestSourceOwnerAuthority(value);
    const dossier = await parseModelWriteDossierV2(raw);
    await assertRequestChangeDossier(dossier);
    if (canonical(dossier.authority) !== canonical(authority)) {
      throw new RequestSourceOwnerError("network-dossier-authority-differs");
    }
    await this.revalidateCurrentAcceptance(authority);
  }
  /** Revalidate the human channel before recording a decision; this does not
   * authorize any writer or replace the final approved-dossier check. */
  async revalidateHumanDecision(
    value: RequestSourceOwnerAuthorityEnvelope,
  ): Promise<void> {
    await this.revalidateCurrentAcceptance(
      parseRequestSourceOwnerAuthority(value),
    );
  }
  private async revalidateCurrentAcceptance(
    authority: RequestSourceOwnerAuthorityEnvelope,
  ): Promise<void> {
    const acceptance = authority.acceptance,
      session = sessionOf(acceptance.principal);
    await this.options.sessions.revalidate(structuredClone(session));
    const context = structuredClone(
      await this.options.source.resolve(
        acceptance.destination.caseId,
        structuredClone(session.controller),
      ),
    );
    assertRequestSourceOwnerPhaseMatches(acceptance, context, this.binding);
    await this.options.source.assertCurrent(structuredClone(acceptance));
    await this.options.sessions.revalidate(structuredClone(session));
    // The proposal session is historical evidence. It is neither overwritten
    // nor required live for this independent acceptance/new-effect preflight.
  }
}
