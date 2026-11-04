/** APE 4.1 Operator Identity & Mandate: the host supplies issuer, parent and mandate. */
import type { SourceCompilationPort } from "../../../model/source-compilation.ts";
import { canonical } from "../../../../domain/primitives/canonical-json.ts";
import { executionDigest } from "../../../../domain/primitives/execution-digest.ts";
import type { ExecutableModel } from "../../../../domain/model/execution/executable-model.ts";
import type { ModelDelegationChange } from "../../../../domain/governance/model-access/model-delegation-request.ts";
import {
  assertModelDelegationWithinAuthority,
  type ModelDelegationRecord,
  validateModelDelegationRecord,
} from "../../../../domain/governance/model-access/model-delegation.ts";
import type { ModelAdministrationAuthorization } from "../../../../domain/governance/model-access/model-edit-authorization.ts";
import {
  MODEL_DELEGATIONS_FILE,
  readModelDelegations,
  renderModelDelegations,
} from "../../../../domain/governance/model-access/model-delegation-ledger.ts";
import { type SourceRevision } from "../../../../domain/model/records/source-revision.ts";
import { ModelRepositoryError } from "../../../model/repository.ts";
import { assertModelEditScope } from "../../../../domain/model/editing/scope.ts";
import { delegationIdentity } from "../delegation/state.ts";
import { AuthorityInvariantError } from "../../../../domain/governance/authority.ts";

function requireAdministration(value: unknown, message: string): asserts value {
  if (!value) throw new ModelRepositoryError("EDIT_SCOPE_DENIED", message);
}

export async function prepareModelAdministration(
  base: SourceRevision,
  projectId: string,
  current: ExecutableModel,
  input: ModelDelegationChange,
  compilation: SourceCompilationPort,
): Promise<
  {
    sources: Record<string, string>;
    authorization: ModelAdministrationAuthorization;
  }
> {
  const change = structuredClone(input);
  const authority = current.modelAdministration;
  requireAdministration(
    authority && current.policy.mayProposeSysmlRevision,
    "Le mandat courant ne permet pas d’administrer les droits d’édition.",
  );
  const expectedKeys = change.kind === "grant"
    ? [
      "kind",
      "id",
      "targetSystem",
      "operations",
      "grants",
      "mayEdit",
      "recipients",
      "maxRedelegationDepth",
    ]
    : ["kind", "id"];
  requireAdministration(
    (change.kind === "grant" || change.kind === "revoke") &&
      Object.keys(change).sort().join(",") === expectedKeys.sort().join(","),
    "Une opération d’administration structurée exacte est requise.",
  );
  const records = readModelDelegations(base.sources);
  let record: ModelDelegationRecord;
  let previousDigest: string | undefined;
  if (change.kind === "grant") {
    requireAdministration(
      !records.some((entry) => entry.id === change.id),
      "Cet identifiant de délégation existe déjà, y compris dans l’historique révoqué.",
    );
    const target = await compilation.compile(
      base,
      projectId,
      change.targetSystem,
    );
    requireAdministration(
      !target.modelAdministration &&
        !target.modelEditPolicy?.delegationDigest &&
        !(change.mayEdit && target.modelEditPolicy),
      "Le destinataire possède déjà une politique incompatible ; révoquez-la explicitement avant une nouvelle attribution.",
    );
    const identity = delegationIdentity(change.targetSystem, target, base);
    requireAdministration(
      identity.mayProposeSysmlRevision,
      "Le mandat du destinataire ne permet pas les propositions SysML.",
    );
    record = {
      id: change.id,
      revision: 1,
      issuerSystem: authority.systemQualifiedName,
      targetSystem: change.targetSystem,
      targetHolderNativeId: identity.holderNativeId,
      targetMandateId: identity.mandateId,
      targetMandateRevision: identity.mandateRevision,
      parent: {
        kind: authority.kind,
        id: authority.id,
        revision: authority.revision,
        digest: authority.digest,
      },
      operations: change.operations,
      grants: change.grants,
      mayEdit: change.mayEdit,
      recipients: change.recipients,
      maxRedelegationDepth: change.maxRedelegationDepth,
      revoked: false,
    };
    validateModelDelegationRecord(record);
    assertModelDelegationWithinAuthority(authority, record);
    // Use the same semantic ownership, source and ambiguity checks as actual editing.
    assertModelEditScope(base, base, record.grants);
    records.push(record);
  } else {
    const index = records.findIndex((entry) => entry.id === change.id);
    const previous = records[index];
    requireAdministration(
      previous && !previous.revoked &&
        previous.issuerSystem === authority.systemQualifiedName,
      "Seul l’émetteur habilité peut révoquer sa délégation directe active.",
    );
    previousDigest = await executionDigest(previous);
    record = { ...previous, revision: previous.revision + 1, revoked: true };
    validateModelDelegationRecord(record);
    records[index] = record;
  }
  const authorization: ModelAdministrationAuthorization = {
    kind: "operator-administration",
    systemQualifiedName: authority.systemQualifiedName,
    operatorNativeId: current.identity.builderId,
    authorityDigest: authority.digest,
    change,
    record,
    ...(previousDigest ? { previousDigest } : {}),
  };
  return {
    sources: {
      ...base.sources,
      [MODEL_DELEGATIONS_FILE]: renderModelDelegations(records, base.sources),
    },
    authorization,
  };
}

/** Rebuild the one permitted mutation at admission/recovery against the current source. */
export async function validateModelAdministration(
  input: {
    authority: SourceRevision;
    before: SourceRevision;
    after: { sources: Record<string, string> };
    authorization: ModelAdministrationAuthorization;
    author: string;
  },
  projectId: string,
  compilation: SourceCompilationPort,
): Promise<void> {
  const principal = input.authorization;
  requireAdministration(
    input.author === `agent:${principal.operatorNativeId}`,
    "L’auteur ne correspond pas à l’opérateur administrateur.",
  );
  const current = await compilation.compile(
    input.authority,
    projectId,
    principal.systemQualifiedName,
  );
  if (!current.modelAdministration || !current.policy.mayProposeSysmlRevision) {
    throw new AuthorityInvariantError(
      3,
      "administration-not-authorized-at-base",
    );
  }
  // A later head cannot retroactively authorize a proposal based on a version
  // in which the issuer did not hold this authority.
  if (input.before.version !== input.authority.version) {
    try {
      const prior = await compilation.compile(
        input.before,
        projectId,
        principal.systemQualifiedName,
      );
      const priorExpected = await prepareModelAdministration(
        input.before,
        projectId,
        prior,
        principal.change,
        compilation,
      );
      if (canonical(priorExpected.authorization) !== canonical(principal)) {
        throw new AuthorityInvariantError(
          3,
          "administration-not-authorized-at-base",
        );
      }
    } catch (error) {
      if (error instanceof AuthorityInvariantError) throw error;
      throw new AuthorityInvariantError(
        3,
        "administration-not-authorized-at-base",
      );
    }
  }
  const expected = await prepareModelAdministration(
    input.before,
    projectId,
    current,
    principal.change,
    compilation,
  );
  if (canonical(expected.authorization) !== canonical(principal)) {
    throw new AuthorityInvariantError(3, "administration-authority-changed");
  }
  requireAdministration(
    canonical(expected.sources) === canonical(input.after.sources),
    "Une administration ne peut modifier que l’attribution ou la révocation exacte demandée.",
  );
}
