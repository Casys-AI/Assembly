import { doesNotThrow, throws } from "node:assert/strict";
import { parseModelRevisionId } from "../../../domain/shared-kernel/revision-id.ts";
import { assertRequestChangeDossier } from "./request-change.ts";
import type { ModelWriteDossierV2 } from "./write-command-v2.ts";
import { buildRequestCreationGrantAuthority } from "../source-admission/request-delegated-authority.ts";
import { branchAuthorityFixture } from "../../../../test/support/branch-authority-fixture.ts";
import { exerciseOwnerAuthority } from "../../../domain/governance/authority.ts";
import { changePublication } from "../../../domain/model/publication/change.ts";
import type { PendingChange } from "../../../domain/governance/records/pending-change.ts";

async function teamDossier(
  kind: "creation-grant" | "human",
  independentMember = false,
  creationPolicy = false,
) {
  const f = await branchAuthorityFixture();
  const pending = f.teamProposal();
  const { opening, admission, request } = f.snapshot;
  const model = request.executionModel!;
  if (independentMember) {
    model.operatorTeam = {
      parentOperatorId: model.identity.builderId,
      requestOwnerId: model.identity.builderId,
      requestId: opening.caseId,
    };
    model.identity.builderId = "member";
    model.operatorCreationPolicies![0].holderNativeId = "member";
    pending.requestedBy = "member";
    admission.permissions.operatorIds.push("member");
    admission.permissions.modelDigests.push(model.version.digest);
  }
  const version = model.version.repositoryVersion!;
  const sourceVersion = independentMember
    ? `commit:${"e".repeat(40)}`
    : version;
  const destination = independentMember
    ? {
      ...f.destination,
      expectedAdmittedSource: {
        ...f.destination.expectedAdmittedSource,
        source: {
          ...f.destination.expectedAdmittedSource.source,
          version: parseModelRevisionId(sourceVersion),
        },
      },
    }
    : f.destination;
  const change = structuredClone(pending) as PendingChange;
  change.status = "approved";
  change.decidedAt = "2026-11-01T00:00:00.000Z";
  change.diff = {
    title: "Create Helper",
    author: "operator",
    base: {
      repositoryVersion: sourceVersion,
      modelDigest: model.version.digest,
      sourceDigest: destination.expectedAdmittedSource.sourceDigest,
    },
    sourceDigest: "e".repeat(64),
    files: [{
      path: "model.sysml",
      kind: "changed",
      additions: 3,
      deletions: 0,
    }],
    patch: "+helper",
    additions: 3,
    deletions: 0,
  };
  if (creationPolicy) {
    change.kind = "mandate-change";
    delete change.operator;
    delete change.name;
    delete change.role;
    delete change.teamOrigin;
    change.requestedRights = {
      operatorCreation: {
        networkHosts: [],
        maxChildren: 3,
        mode: "autonomous",
      },
    };
  }
  let authority: unknown;
  if (kind === "creation-grant") {
    const envelope = buildRequestCreationGrantAuthority({
      opening,
      admission,
      request,
      space: f.space,
      branchTeamSize: 0,
      change: pending,
      destination: destination,
      capturedAt: "2026-11-01T00:00:00.000Z",
    });
    change.authority = "builder";
    change.authorityExercise = structuredClone(envelope.exercise);
    authority = envelope;
  } else {
    change.authority = "human";
    change.authorityExercise = exerciseOwnerAuthority(model, "mandate-change");
    const priorModel = {
      identity: structuredClone(model.identity),
      version: {
        digest: model.version.digest,
        repositoryVersion: version,
      },
    };
    authority = {
      proposal: { priorModel, destination: destination },
      acceptance: {
        priorModel,
        destination: destination,
        principal: { priorOwner: structuredClone(model.ownerAuthority) },
      },
    };
  }
  const approval = changePublication(change, model.version);
  const dossier = {
    command: {
      kind: "approved-change",
      commandId: change.id,
      destination: destination,
      approvedBase: { version: sourceVersion },
    },
    decision: { kind: "approved-change", change, approval },
    operations: {
      kind: "host-edits",
      journal: {
        base: { version: sourceVersion },
        baseSourceDigest: destination.expectedAdmittedSource.sourceDigest,
      },
    },
    authority,
  } as unknown as ModelWriteDossierV2;
  return { dossier, change };
}

Deno.test("a BO creation-policy dossier requires the person's exact decision", async () => {
  const { dossier } = await teamDossier("human", false, true);
  doesNotThrow(() => assertRequestChangeDossier(dossier));
  const { dossier: grant } = await teamDossier("creation-grant");
  const crossed = { ...structuredClone(dossier), authority: grant.authority };
  throws(() => assertRequestChangeDossier(crossed));
});

Deno.test("4.8e E4: the dossier gate discriminates the team effect, then the authority", async () => {
  const { dossier: granted } = await teamDossier("creation-grant");
  doesNotThrow(() => assertRequestChangeDossier(granted));
  const { dossier: human } = await teamDossier("human");
  doesNotThrow(() => assertRequestChangeDossier(human));
  // Crossed authorities never publish a team creation: the person's
  // envelope over a builder receipt, and a creation grant whose exercise
  // is not the change's.
  const crossed = structuredClone(granted) as unknown as Record<
    string,
    unknown
  >;
  crossed.authority = (human as unknown as Record<string, unknown>).authority;
  throws(() =>
    assertRequestChangeDossier(crossed as unknown as ModelWriteDossierV2)
  );
  const tampered = structuredClone(granted) as unknown as {
    decision: { change: { authorityExercise: { baseModelDigest: string } } };
  };
  tampered.decision.change.authorityExercise.baseModelDigest = "f".repeat(64);
  throws(() =>
    assertRequestChangeDossier(tampered as unknown as ModelWriteDossierV2)
  );
});

Deno.test("member creation grant binds its older executed pin while writing from the newer branch source; human still requires equality", async () => {
  const { dossier: member } = await teamDossier("creation-grant", true);
  doesNotThrow(() => assertRequestChangeDossier(member));
  const noMemberProof = structuredClone(member);
  if (noMemberProof.authority.kind !== "request-creation-grant") {
    throw new Error("Creation grant required");
  }
  delete (noMemberProof.authority.priorModel as { operatorTeam?: unknown })
    .operatorTeam;
  throws(() => assertRequestChangeDossier(noMemberProof));
  const changed = structuredClone(member) as unknown as {
    authority: { priorModel: { version: { digest: string } } };
  };
  changed.authority.priorModel.version.digest = "f".repeat(64);
  throws(() =>
    assertRequestChangeDossier(changed as unknown as ModelWriteDossierV2)
  );
  const { dossier: human } = await teamDossier("human", true);
  throws(() => assertRequestChangeDossier(human));
});
