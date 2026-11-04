import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  canonicalDigest,
  isSha256Hex,
} from "../../../domain/primitives/execution-digest.ts";
import {
  type ModelRevisionRef,
  parseModelRevisionRef,
} from "../../../domain/model/value-objects/element-ref.ts";
import {
  type BuildDescriptor,
  buildKey,
  parseBuildDescriptorStrict,
  recipeDigest,
} from "../../../domain/model/value-objects/build.ts";
import {
  modelWriteCommandDigestV2,
  type ModelWriteCommandV2,
  modelWriteDossierDigestV2,
  modelWriteIntentDigestV2,
  parseModelWriteCommandV2,
  parseModelWriteDossierV2,
} from "../publication/write-command-v2.ts";
import {
  assertRequestChangeDossier,
  type RequestChangeDossier,
} from "../publication/request-change.ts";
import { requestChangeProposalDigest } from "../../../domain/governance/records/request-change.ts";
import {
  isSessionlessRequestAuthority,
  parseRequestWriteAuthority,
  type RequestWriteAuthority,
  requestWriteAuthorityDestination,
  requestWriteAuthorityDigest,
  requestWriteAuthorityHasMemberPin,
  requestWriteAuthorityPrior,
} from "./request-delegated-authority.ts";
import {
  requestSourceAdmissionRef,
  requestSourceCommandRef,
} from "../../../domain/model/editing/request-source-publication.ts";
import type { ModelIdentity } from "../../../domain/shared-kernel/model-identity.ts";
import { RequestSpaceError } from "../../../domain/work/request-spaces.ts";

/** An immutable receipt of one past publication, never a credential or grant. */
type RequestSourceAdmissionCommand =
  | (ModelWriteCommandV2 & { readonly kind: "accept-proposal" })
  | (ModelWriteCommandV2 & { readonly kind: "approved-change" });
export interface RequestSourceAdmission {
  readonly format: "request-source-admission/v1";
  readonly destination: ModelWriteCommandV2["destination"];
  readonly openingBaseDigest: string;
  readonly predecessor: {
    readonly revision: number;
    readonly manifestDigest: string;
    readonly source: ModelRevisionRef;
    readonly sourceDigest: string;
  };
  readonly result: {
    readonly source: ModelRevisionRef;
    readonly sourceDigest: string;
    readonly build: BuildDescriptor;
    readonly buildDigest: string;
    readonly model: {
      readonly identity: ModelIdentity;
      readonly digest: string;
    };
  };
  readonly command: RequestSourceAdmissionCommand;
  readonly commandDigest: string;
  readonly dossierDigest: string;
  readonly decisionDigest: string;
  readonly authority: RequestWriteAuthority;
  readonly authorityDigest: string;
  readonly publication: {
    readonly repositoryId: string;
    readonly commandId: string;
    readonly commandRef: string;
    readonly publicationRef: string;
    readonly commit: string;
    readonly receiptDigest: string;
  };
}
const invalid = (): never => {
  throw new RequestSpaceError(
    "UNAVAILABLE",
    "The Request source admission receipt is invalid.",
  );
};
const obj = (v: unknown, names: string): Record<string, unknown> => {
  if (
    !v || typeof v !== "object" || Array.isArray(v) ||
    Object.keys(v).sort().join(",") !== names
  ) return invalid();
  return v as Record<string, unknown>;
};
const hash = (v: unknown): v is string => isSha256Hex(v);
const ref = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 512 &&
  /^refs\/[A-Za-z0-9._/-]+$/.test(v) && !v.includes("..") &&
  !v.includes("//") && !v.endsWith("/") && !v.endsWith(".lock");

/** Decode one caller-independent snapshot before digest awaits. The caller must
 * separately prove the anchor from Git and current authorization when required. */
export async function parseRequestSourceAdmission(
  input: unknown,
): Promise<RequestSourceAdmission> {
  const owned = structuredClone(input);
  const v = obj(
    owned,
    "authority,authorityDigest,command,commandDigest,decisionDigest,destination,dossierDigest,format,openingBaseDigest,predecessor,publication,result",
  );
  if (v.format !== "request-source-admission/v1") return invalid();
  const command = parseModelWriteCommandV2(v.command);
  const authority = parseRequestWriteAuthority(v.authority);
  const prior = requestWriteAuthorityPrior(authority);
  const before = obj(
    v.predecessor,
    "manifestDigest,revision,source,sourceDigest",
  );
  const after = obj(v.result, "build,buildDigest,model,source,sourceDigest");
  const model = obj(after.model, "digest,identity");
  const publication = obj(
    v.publication,
    "commandId,commandRef,commit,publicationRef,receiptDigest,repositoryId",
  );
  const source = parseModelRevisionRef(before.source);
  const resultSource = parseModelRevisionRef(after.source);
  const build = parseBuildDescriptorStrict(after.build);
  const target = command.destination;
  const { v: _v, intentDigest: _intentDigest, ...intent } = command;
  const authorityRef = command.authorityRef;
  if (
    (command.kind !== "accept-proposal" &&
      command.kind !== "approved-change") ||
    !Number.isSafeInteger(before.revision) || Number(before.revision) < 1 ||
    !hash(before.manifestDigest) || !hash(before.sourceDigest) ||
    !hash(after.sourceDigest) ||
    !hash(after.buildDigest) || !hash(model.digest) ||
    !hash(v.openingBaseDigest) ||
    !hash(v.commandDigest) || !hash(v.dossierDigest) ||
    !hash(v.decisionDigest) || !hash(v.authorityDigest) ||
    !hash(publication.receiptDigest) ||
    canonical(v.destination) !== canonical(target) ||
    before.revision !== target.expectedAdmittedSource.revision ||
    canonical(source) !== canonical(target.expectedAdmittedSource.source) ||
    before.sourceDigest !== target.expectedAdmittedSource.sourceDigest ||
    resultSource.repositoryId !== command.repositoryId ||
    build.repositoryId !== command.repositoryId ||
    build.sourceDigest !== after.sourceDigest ||
    await canonicalDigest(build) !== after.buildDigest ||
    await recipeDigest(build.recipe) !== build.recipe.digest ||
    await buildKey(build.sourceDigest, build.recipe.digest) !==
      build.buildKey ||
    command.recipeDigest !== build.recipe.digest ||
    canonical(model.identity) !== canonical(prior.identity) ||
    prior.identity.projectId !== `git:${command.repositoryId}` ||
    !requestWriteAuthorityHasMemberPin(authority) &&
      prior.version.repositoryVersion !== source.version ||
    (isSessionlessRequestAuthority(authority)
      ? command.kind !== "approved-change" ||
        canonical(requestWriteAuthorityDestination(authority)) !==
          canonical(target)
      : authority.acceptance.priorModel.version.digest !==
          authority.proposal.priorModel.version.digest ||
        authority.proposal.priorModel.version.repositoryVersion !==
          source.version ||
        canonical(authority.acceptance.destination) !== canonical(target) ||
        canonical(authority.proposal.destination) !== canonical(target)) ||
    authorityRef.kind !== authority.kind ||
    authorityRef.digest !== v.authorityDigest ||
    await requestWriteAuthorityDigest(authority) !== v.authorityDigest ||
    await modelWriteCommandDigestV2(command) !== v.commandDigest ||
    await modelWriteIntentDigestV2(intent) !== command.intentDigest ||
    command.decisionRef.id !== command.commandId ||
    command.decisionRef.digest !== v.decisionDigest ||
    publication.repositoryId !== command.repositoryId ||
    publication.commandId !== command.commandId ||
    !ref(publication.commandRef) || !ref(publication.publicationRef) ||
    publication.commandRef !== requestSourceCommandRef(command.commandId) ||
    publication.publicationRef !==
      requestSourceAdmissionRef(command.commandId, resultSource.version) ||
    publication.commit !== resultSource.version ||
    resultSource.version === source.version ||
    after.sourceDigest === before.sourceDigest ||
    model.digest === prior.version.digest
  ) return invalid();
  return owned as RequestSourceAdmission;
}
export async function requestSourceAdmissionDigest(
  input: RequestSourceAdmission,
): Promise<string> {
  return await canonicalDigest(await parseRequestSourceAdmission(input));
}

/** A receipt alone is historical integrity, not a network decision. Require its
 * complete exact dossier before projecting the approved network permission. */
export async function requestNetworkAdmissionEvidence(
  input: RequestSourceAdmission,
  dossierInput: unknown,
): Promise<{
  admission: RequestSourceAdmission;
  dossier: RequestChangeDossier;
  proposalIntentDigest: string;
  approvedChangeDigest: string;
}> {
  const ownedDossier = structuredClone(dossierInput);
  const admission = await parseRequestSourceAdmission(input);
  const dossier = await parseModelWriteDossierV2(ownedDossier);
  assertRequestChangeDossier(dossier);
  if (
    admission.command.kind !== "approved-change" ||
    canonical(dossier.command) !== canonical(admission.command) ||
    canonical(dossier.authority) !== canonical(admission.authority) ||
    dossier.decision.change.diff?.sourceDigest !==
      admission.result.sourceDigest ||
    await modelWriteDossierDigestV2(dossier) !== admission.dossierDigest
  ) return invalid();
  return {
    admission,
    dossier,
    proposalIntentDigest: await requestChangeProposalDigest(
      dossier.decision.change,
    ),
    approvedChangeDigest: await canonicalDigest(dossier.decision.change),
  };
}
