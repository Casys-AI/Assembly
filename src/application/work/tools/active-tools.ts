import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  Candidate,
  ToolDraft,
} from "../../../domain/work/records/candidates.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import {
  type RetainedToolDependencyDescriptor,
  type RetainedToolInvocationTarget,
  retainedToolResourceId,
} from "../../../domain/work/records/retained-tool-dependencies.ts";
import type { ArtifactSourceServicePort } from "../artifacts/publication.ts";
import { resolveCandidateSource } from "../artifacts/candidate-source.ts";
import { toolDraftDigest } from "../artifacts/catalog.ts";

export type RunnableTool = ToolDraft & { readonly id: string };
interface RetainedToolDependency {
  readonly descriptor: RetainedToolDependencyDescriptor;
  readonly resourceId: string;
  readonly draft: ToolDraft;
}
export interface RetainedToolsPort {
  /** Reads exact bytes and the target's current explicit admission, never executes. */
  list(model: ExecutableModel): Promise<readonly RetainedToolDependency[]>;
}
type ResolvedActiveTool =
  | { readonly kind: "local-candidate"; readonly tool: Candidate }
  | {
    readonly kind: "retained-dependency";
    readonly tool: RunnableTool & { readonly digest: string };
    readonly retainedTool: RetainedToolInvocationTarget;
  };

export function activeToolCatalogEntry(model: ExecutableModel, id: string) {
  const entries = model.catalog.filter((entry) =>
    entry.candidateId === id && entry.status === "active" &&
    model.contracts.filter((contract) =>
        contract.nativeId === entry.contractId && contract.kind === entry.kind
      ).length === 1
  );
  return entries.length === 1 ? entries[0] : undefined;
}
export function activeCatalogEntry(
  model: ExecutableModel,
  tool: Pick<Candidate, "id" | "digest" | "name" | "kind">,
) {
  const entry = activeToolCatalogEntry(model, tool.id);
  return entry?.digest === tool.digest && entry.name === tool.name &&
      entry.kind === tool.kind
    ? entry
    : undefined;
}
/** Both origins use the same native catalogue and byte checks; neither origin grants invocation. */
export async function activeTools(
  state: SystemRuntimeState,
  model: ExecutableModel,
  retained?: RetainedToolsPort,
): Promise<ResolvedActiveTool[]> {
  const result: ResolvedActiveTool[] = [];
  for (const candidate of state.candidates) {
    const entry = activeCatalogEntry(model, candidate);
    if (
      candidate.stage === "active" && entry &&
      (!candidate.binding || candidate.binding.elementId === entry.nativeId) &&
      await toolDraftDigest(candidate) === candidate.digest
    ) result.push({ kind: "local-candidate", tool: candidate });
  }
  for (const dependency of await retained?.list(model) ?? []) {
    const { descriptor, resourceId, draft } = structuredClone(dependency);
    const tool = {
      ...structuredClone(draft),
      id: descriptor.tool.candidateId,
      digest: descriptor.tool.digest,
    };
    if (
      descriptor.target.operatorId !== model.identity.builderId ||
      resourceId !== await retainedToolResourceId(descriptor) ||
      await toolDraftDigest(draft) !== tool.digest ||
      !activeCatalogEntry(model, tool) ||
      result.some((entry) => entry.tool.id === tool.id)
    ) {
      throw new Error(
        "Retained tool dependency differs from the active target model",
      );
    }
    result.push({
      kind: "retained-dependency",
      tool,
      retainedTool: {
        resourceId,
        descriptorDigest: resourceId.slice("retained-tool:v1:".length),
        toolId: tool.id,
        toolDigest: tool.digest,
      },
    });
  }
  return result;
}
export async function resolveActiveTool(
  state: SystemRuntimeState,
  model: ExecutableModel,
  id: string,
  ports: {
    retainedTools?: RetainedToolsPort;
    artifactSources?: ArtifactSourceServicePort;
  },
): Promise<ResolvedActiveTool | undefined> {
  const found = (await activeTools(state, model, ports.retainedTools)).filter(
    (entry) => entry.tool.id === id,
  );
  if (found.length !== 1) return undefined;
  const selected = found[0];
  return selected.kind === "local-candidate"
    ? {
      kind: "local-candidate",
      tool: await resolveCandidateSource(
        selected.tool,
        model.identity.builderId,
        ports.artifactSources,
      ),
    }
    : selected;
}
