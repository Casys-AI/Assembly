import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type {
  EvolutionAct,
  EvolutionAuthorityExercise,
} from "../../../domain/model/evolution/policy.ts";
import {
  type EvolutionDossier,
  EvolutionError,
  type EvolutionProposal,
} from "./ports.ts";

function require(value: unknown, message: string): asserts value {
  if (!value) throw new EvolutionError("EVOLUTION_INVALID", message);
}

export function assertEvolutionReceipt(
  receipt: EvolutionAuthorityExercise,
  act: EvolutionAct,
  proposal: EvolutionProposal,
): void {
  require(
    receipt.act === act && receipt.proposalDigest === proposal.digest,
    "Authority receipt does not bind this act and exact proposal",
  );
  require(
    canonical([...receipt.targets].sort()) ===
        canonical(proposal.targets.map((t) => t.operatorId).sort()) &&
      canonical([...receipt.categories].sort()) ===
        canonical([...proposal.categories].sort()),
    "Authority receipt does not cover the complete target/category set",
  );
}

export function assertEvolutionDossier(d: EvolutionDossier): void {
  require(
    d.v === 1 && d.id?.trim() && d.repositoryId?.trim(),
    "Invalid dossier identity",
  );
  require(
    Number.isSafeInteger(d.revision) && d.revision >= 0,
    "Invalid dossier revision",
  );
  require(
    d.accounting?.id === `evolution:${d.repositoryId}:${d.id}` &&
      d.accounting.agentInvocations === 0,
    "Evolution finalization requires its own zero-invocation accounting identity",
  );
  require(
    d.finalizerActorId?.trim() && d.origin?.operatorId?.trim(),
    "Missing actor or origin provenance",
  );
  require(
    d.proposal.id?.trim() && d.proposal.version?.trim() &&
      d.proposal.baseVersion?.trim() &&
      d.proposal.sourceDigest?.trim() && d.proposal.recipeDigest?.trim() &&
      d.proposal.digest?.trim(),
    "Incomplete exact proposal identity",
  );
  require(
    d.proposal.targets.length > 0 && d.proposal.categories.length > 0,
    "Evolution requires targets and categories",
  );
  require(
    new Set(d.proposal.targets.map((t) => t.operatorId)).size ===
        d.proposal.targets.length &&
      d.proposal.targets.every((t) =>
        t.operatorId?.trim() && t.previousDigest?.trim() &&
        t.candidateDigest?.trim()
      ),
    "Invalid or duplicate evolution target",
  );
  require(
    new Set(d.proposal.categories).size === d.proposal.categories.length &&
      d.proposal.categories.every((c) =>
        ["flow", "instructions", "budgets", "context", "memory", "contracts"]
          .includes(c)
      ),
    "Unsupported or duplicate evolution category",
  );
  require(
    [
      "prepared",
      "accepted",
      "armed",
      "publishing",
      "published-awaiting-adoption",
      "adopted",
      "cancelled",
      "superseded",
      "refused",
      "needs-decision",
    ].includes(d.status),
    "Invalid evolution status",
  );
  assertEvolutionReceipt(d.preparation, "prepare", d.proposal);
  require(
    d.origin.operatorId === d.preparation.operatorNativeId,
    "Origin operator differs from the preparing authority actor",
  );
  require(
    !(d.origin.requestId && d.origin.designerScopeId),
    "Origin cannot name both a Request and designer scope",
  );
  if (d.origin.targetScopes) {
    require(
      new Set(d.origin.targetScopes.map((s) => s.operatorId)).size ===
        d.origin.targetScopes.length,
      "Duplicate target origin scope",
    );
    for (const scope of d.origin.targetScopes) {
      require(
        d.proposal.targets.some((t) => t.operatorId === scope.operatorId) &&
          Boolean(scope.requestId?.trim()) !==
            Boolean(scope.designerScopeId?.trim()),
        "Target origin scope is not an exact affected target with one proven scope",
      );
    }
  }
  if (d.acceptance) assertEvolutionReceipt(d.acceptance, "accept", d.proposal);
  if (d.adoptionAuthorization) {
    assertEvolutionReceipt(d.adoptionAuthorization, "adopt", d.proposal);
    require(
      d.adoptionAuthorization.operatorNativeId === d.finalizerActorId,
      "Finalizer must be the explicitly authorized adoption actor",
    );
  }
  if (d.cancellation) {
    assertEvolutionReceipt(d.cancellation, "accept", d.proposal);
  }
  if (d.status === "cancelled" || d.status === "superseded") {
    require(d.cancellation, "Cancellation has no decision authority receipt");
  }
  if (
    [
      "accepted",
      "armed",
      "publishing",
      "published-awaiting-adoption",
      "adopted",
    ].includes(d.status)
  ) {
    require(d.acceptance, "Accepted revision has no acceptance receipt");
  }
  if (
    ["armed", "publishing", "published-awaiting-adoption", "adopted"].includes(
      d.status,
    )
  ) {
    require(
      d.adoptionAuthorization,
      "Armed revision has no adoption authority",
    );
  }
  if (["published-awaiting-adoption", "adopted"].includes(d.status)) {
    require(d.publication, "Missing publication receipt");
  }
  if (d.publication) {
    require(
      d.status === "published-awaiting-adoption" || d.status === "adopted",
      "Publication cannot be attached to an unpublished or cancelled revision",
    );
    require(
      d.publication.proposalDigest === d.proposal.digest &&
        d.publication.sourceDigest === d.proposal.sourceDigest &&
        d.publication.commandId === d.proposal.id &&
        d.publication.commandDigest?.trim() && d.publication.version?.trim(),
      "Publication receipt differs from the exact proposal",
    );
  }
  require(
    new Set(d.adoptions.map((r) => r.operatorId)).size === d.adoptions.length,
    "Duplicate adoption receipt",
  );
  if (d.adoptions.length) {
    require(d.publication, "Adoption requires a publication receipt");
  }
  for (const receipt of d.adoptions) {
    const target = d.proposal.targets.find((t) =>
      t.operatorId === receipt.operatorId
    );
    require(
      d.publication && target &&
        receipt.previousDigest === target.previousDigest &&
        receipt.candidateDigest === target.candidateDigest &&
        receipt.proposalDigest === d.proposal.digest &&
        receipt.version === d.publication.version &&
        receipt.effectiveAt?.trim(),
      "Adoption receipt differs from the exact target",
    );
  }
  if (d.status === "adopted") {
    require(
      d.adoptions.length === d.proposal.targets.length,
      "Not every target was adopted",
    );
  }
}

const transitions: Record<
  EvolutionDossier["status"],
  readonly EvolutionDossier["status"][]
> = {
  prepared: ["prepared", "accepted", "cancelled", "superseded", "refused"],
  accepted: [
    "accepted",
    "armed",
    "cancelled",
    "superseded",
    "needs-decision",
    "refused",
  ],
  armed: [
    "armed",
    "publishing",
    "published-awaiting-adoption",
    "cancelled",
    "superseded",
    "needs-decision",
    "refused",
  ],
  publishing: ["publishing", "published-awaiting-adoption"],
  "published-awaiting-adoption": ["published-awaiting-adoption", "adopted"],
  adopted: [],
  cancelled: [],
  superseded: [],
  refused: [],
  "needs-decision": [],
};

export function assertEvolutionTransition(
  previous: EvolutionDossier,
  next: EvolutionDossier,
): void {
  assertEvolutionDossier(next);
  require(
    next.id === previous.id && next.repositoryId === previous.repositoryId &&
      next.revision === previous.revision + 1,
    "Dossier CAS identity or revision changed",
  );
  const immutable = (d: EvolutionDossier) => ({
    v: d.v,
    id: d.id,
    repositoryId: d.repositoryId,
    origin: d.origin,
    finalizerActorId: d.finalizerActorId,
    accounting: d.accounting,
    createdAt: d.createdAt,
    proposal: d.proposal,
    preparation: d.preparation,
  });
  require(
    canonical(immutable(previous)) === canonical(immutable(next)),
    "Immutable evolution dossier changed",
  );
  require(
    transitions[previous.status].includes(next.status),
    "Invalid evolution state transition",
  );
  for (
    const key of ["acceptance", "adoptionAuthorization", "publication"] as const
  ) {
    if (previous[key]) {
      require(
        canonical(previous[key]) === canonical(next[key]),
        "Recorded evolution receipt changed",
      );
    }
  }
  require(
    previous.adoptions.every((r) =>
      next.adoptions.some((n) => canonical(n) === canonical(r))
    ),
    "Recorded adoption receipt was removed or changed",
  );
}
