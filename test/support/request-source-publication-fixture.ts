/** Synthetic payloads for dispatch/fence witnesses: no native or Git proof. */
import { normalOwnerEnvelope } from "./request-source-owner.ts";
import {
  buildModelWriteDossierV2,
  modelWriteCommandDigestV2,
  modelWriteDossierDigestV2,
} from "../../src/application/model/publication/write-command-v2.ts";
import {
  requestSourceAdmissionRef,
  requestSourceCommandRef,
} from "../../src/domain/model/editing/source-anchor-refs.ts";
import {
  buildDescriptor,
  buildKey,
  recipeDigest,
} from "../../src/domain/model/value-objects/build.ts";
import { sha256 } from "../../src/domain/primitives/execution-digest.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { parseRequestSourceAdmission } from "../../src/application/model/source-admission/request-source-admission.ts";
import type { ModelRevision } from "../../src/domain/model/records/revision.ts";

export async function requestPublicationFixture() {
  const authority = normalOwnerEnvelope(),
    destination = authority.acceptance.destination;
  const id = "daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    source = destination.expectedAdmittedSource.source;
  const recipe = {
    toolkit: { version: "fixture", bundleDigest: "1".repeat(64) },
    format: "fixture",
    normalizerVersion: 1,
    irVersion: "1",
    artifactSchema: 1,
    engineVersion: "fixture",
  };
  const recipeId = await recipeDigest(recipe);
  const resultVersion = `commit:${"f".repeat(40)}`,
    sourceDigest = "e".repeat(64);
  const dossier = await buildModelWriteDossierV2({
    repositoryId: destination.repositoryId,
    commandId: id,
    kind: "accept-proposal",
    destination,
    authority,
    recipeDigest: recipeId,
    operations: {
      kind: "whole-files",
      files: {
        v: 1,
        base: source,
        baseSourceDigest: destination.expectedAdmittedSource.sourceDigest,
        files: [{
          path: "core.sysml",
          baseDigest: await sha256("before"),
          text: "after",
        }],
      },
    },
    decision: {
      kind: "accept-proposal",
      proposalId: id,
      baseVersion: source.version,
      proposalSourceDigest: sourceDigest,
      proposalVersion: `commit:${"d".repeat(40)}`,
      expectedVersion: source.version,
      author: "local-owner",
      decisionAuthorityExercise: authority.acceptance.exercise,
    },
  });
  const build = buildDescriptor({
    repositoryId: destination.repositoryId,
    sourceDigest,
    recipe,
    recipeDigest: recipeId,
    buildKey: await buildKey(sourceDigest, recipeId),
    artifactDigest: "6".repeat(64),
    bytes: 1,
  });
  const admission = await parseRequestSourceAdmission({
    format: "request-source-admission/v1",
    destination,
    openingBaseDigest: "2".repeat(64),
    predecessor: {
      ...destination.expectedAdmittedSource,
      manifestDigest: "3".repeat(64),
    },
    result: {
      source: {
        repositoryId: destination.repositoryId,
        version: resultVersion,
      },
      sourceDigest,
      build,
      buildDigest: await sha256(canonical(build)),
      model: {
        identity: authority.acceptance.priorModel.identity,
        digest: "9".repeat(64),
      },
    },
    command: dossier.command,
    commandDigest: await modelWriteCommandDigestV2(dossier.command),
    dossierDigest: await modelWriteDossierDigestV2(dossier),
    decisionDigest: dossier.command.decisionRef.digest,
    authority,
    authorityDigest: dossier.command.authorityRef.digest,
    publication: {
      repositoryId: destination.repositoryId,
      commandId: id,
      commandRef: requestSourceCommandRef(id),
      publicationRef: requestSourceAdmissionRef(id, resultVersion),
      commit: resultVersion,
      receiptDigest: "7".repeat(64),
    },
  });
  const revision: ModelRevision = {
    version: resultVersion,
    sourceDigest,
    sources: { "core.sysml": "after" },
    elements: [],
    documents: [],
    sourceHashes: {},
    semanticDigest: "4".repeat(64),
    provenanceDigest: "5".repeat(64),
    engineVersion: "fixture",
  };
  return { dossier, context: { dossier, admission }, revision, recipe };
}
