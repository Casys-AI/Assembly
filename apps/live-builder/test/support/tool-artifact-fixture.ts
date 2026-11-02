import { toolDraftDigest } from "../../src/application/work/artifacts/catalog.ts";
import type { PublishedToolArtifact } from "../../src/application/work/artifacts/catalog.ts";
import type { NativeBehaviorContract } from "../../src/domain/model/execution/native-contracts.ts";
import { SystemGovernance } from "../../src/domain/governance/policies/governance.ts";
import { executableFixture } from "./execution-fixture.ts";
import { createMemoryArtifactSources } from "./memory-artifact-sources.ts";

export function artifactModel(agentId: string) {
  const configuration =
    SystemGovernance.fresh(`configuration-${agentId}`).snapshot;
  configuration.builder.admissionAuthority = "builder";
  const model = executableFixture({
    projectId: "shared-model",
    editingContextId: "shared-model/main",
    rootId: "shared-model/root",
    systemId: `system-${agentId}`,
    catalogId: `catalog-${agentId}`,
    builderId: agentId,
  }, configuration);
  model.version.digest = `${agentId}-admitted-digest`;
  model.version.repositoryVersion = "commit:shared-source";
  return model;
}

export function reuseBehavior(
  callerId = "destination",
): NativeBehaviorContract {
  return {
    id: `reuse-access-${callerId}`,
    name: "Importer un outil publié",
    description: "Proposer les mêmes octets au catalogue local.",
    callerNativeId: callerId,
    targetNativeId: `reuse-target-${callerId}`,
    targetTypeId: "ASEWork::ReuseTool",
    inputTypeId: "ToolReuseInput",
    sourceIds: ["native-access", "native-reuse-input", "native-reuse-target"],
    inputSchema: {
      type: "object",
      properties: {
        sourceAgentId: { type: "string" },
        candidateId: { type: "string" },
        digest: { type: "string" },
      },
      required: ["sourceAgentId", "candidateId", "digest"],
      additionalProperties: false,
    },
  };
}

export function listBehavior(callerId = "destination"): NativeBehaviorContract {
  return {
    ...reuseBehavior(callerId),
    id: `list-access-${callerId}`,
    name: "Consulter les outils publiés",
    targetNativeId: `list-target-${callerId}`,
    targetTypeId: "ASEWork::ListPublishedTools",
    inputTypeId: "EmptyRequest",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  };
}

export async function publishedArtifact(): Promise<PublishedToolArtifact> {
  const model = artifactModel("source");
  const draft = {
    name: "html-reader",
    description: "Transforme le HTML fourni.",
    kind: "read_web_page" as const,
    code: "export default ({html}) => ({title:'Page',text:html})",
  };
  const digest = await toolDraftDigest(draft);
  // This in-memory source service does not prove durable Git retention.
  const sources = createMemoryArtifactSources();
  const invocationId = "fixture-source-publication";
  const sourceBinding = await sources.publishTool({
    artifactId: "source-candidate",
    ownerId: "source",
    localArtifactId: "source-candidate",
    invocationId,
    baseVersion: model.version.repositoryVersion!,
    expectedDigest: digest,
    draft,
    proof: {
      kind: "admitted-model-seed",
      ownerId: "source",
      sourceElementId: "fixture-source-seed",
      modelVersion: {
        digest: model.version.digest,
        repositoryVersion: model.version.repositoryVersion!,
      },
    },
  });
  const retainedDraft = await sources.resolveTool({
    expectedBinding: sourceBinding,
    bindingId: sourceBinding.bindingId,
    ownerId: "source",
    localArtifactId: "source-candidate",
    expectedDigest: digest,
    reference: sourceBinding.reference,
  });
  if (JSON.stringify(retainedDraft) !== JSON.stringify(draft)) {
    throw new Error("The retained fixture source differs from its draft");
  }
  const candidate = {
    ...draft,
    id: "source-candidate",
    digest,
    stage: "active" as const,
    createdAt: "2026-10-21T10:00:00Z",
    sourceBinding,
    baseCatalogRevision: 0,
    binding: {
      elementId: "native-source-tool",
      statusAttributeId: "source-status",
      statusLiteralId: "source-active",
      graphPath: "source::catalog::tool",
    },
    tests: {
      passed: true,
      checks: [{
        name: "fixture",
        passed: true,
        detail: "Recorded fixture result",
      }],
    },
    admission: {
      candidateId: "source-candidate",
      candidateDigest: digest,
      mandateRevision: 1,
      configurationRevision: 0,
      authority: "builder" as const,
      actorId: "source",
      reason: "Separate delegated admission",
      at: "2026-10-21T10:00:01Z",
    },
  };
  model.catalog.push({
    nativeId: candidate.binding.elementId,
    candidateId: candidate.id,
    contractId: model.contracts[0]!.nativeId,
    name: candidate.name,
    kind: candidate.kind,
    digest,
    status: "active",
  });
  return { agentId: "source", candidate, model };
}
