import {
  canonical,
  compareCodeUnits,
} from "../../primitives/canonical-json.ts";
import type { ExecutableModel } from "../../model/execution/executable-model.ts";
import type { CompiledFlow } from "../../model/execution/flow.ts";

/** An observed activation, independent of proposal/publication and dialogue. */
export interface EffectiveModelUpdate {
  id: string;
  activatedAt: string;
  kind: "action-flow" | "model";
  operatorId: string;
  from: { digest: string; repositoryVersion?: string };
  to: { digest: string; repositoryVersion?: string };
  caseId?: string;
  designerScopeId?: string;
  dossierId?: string;
  actorId?: string;
}

/** Runtime-proved origin only; these references never confer authority. */
export type EffectiveModelUpdateOrigin = Pick<
  EffectiveModelUpdate,
  "caseId" | "designerScopeId" | "dossierId" | "actorId"
>;

function flowSemantics(flow: CompiledFlow) {
  return {
    rootNativeId: flow.rootNativeId,
    rootOccurrenceId: flow.rootOccurrenceId,
    startNodeId: flow.startNodeId,
    nodes: flow.nodes.map(({ source: _source, assertions, ...node }) => ({
      ...node,
      assertions: assertions.map(({
        source: _source,
        expressionSourceIds: _sourceIds,
        ...assertion
      }) => assertion).sort((a, b) => compareCodeUnits(a.nativeId, b.nativeId)),
    })).sort((a, b) => compareCodeUnits(a.id, b.id)),
    edges: flow.edges.map(({ sourceEvidence: _evidence, ...edge }) => edge)
      .sort((a, b) => compareCodeUnits(a.id, b.id)),
    bindings: flow.bindings.map(({ sourceEvidence: _evidence, ...binding }) =>
      binding
    ).sort((a, b) => compareCodeUnits(a.nativeId, b.nativeId)),
  };
}

function actionFlows(model: ExecutableModel) {
  const encode = (flows: Record<string, CompiledFlow>) =>
    Object.fromEntries(
      Object.entries(flows).map(([key, flow]) => [key, flowSemantics(flow)]),
    );
  return {
    flows: encode(model.flows),
    caseFlows: encode(model.caseFlows ?? {}),
  };
}

/** Bootstrap, source-only publication and catalog refresh produce no activation. */
export function effectiveModelUpdate(
  previous: ExecutableModel | undefined,
  next: ExecutableModel,
  activation: {
    /** Stable journal position distinguishes repeated A → B transitions. */
    journalId: string;
    journalPosition: number;
    activatedAt: string;
    origin?: EffectiveModelUpdateOrigin;
  },
): EffectiveModelUpdate | undefined {
  if (!previous || previous.version.digest === next.version.digest) return;
  const version = (model: ExecutableModel) => ({
    digest: model.version.digest,
    ...(model.version.repositoryVersion
      ? { repositoryVersion: model.version.repositoryVersion }
      : {}),
  });
  const from = version(previous), to = version(next);
  const operatorId = next.identity.builderId;
  return {
    id: `model-activation:${
      canonical([
        activation.journalId,
        activation.journalPosition,
        operatorId,
        from,
        to,
      ])
    }`,
    activatedAt: activation.activatedAt,
    kind: canonical(actionFlows(previous)) === canonical(actionFlows(next))
      ? "model"
      : "action-flow",
    operatorId,
    from,
    to,
    ...activation.origin,
  };
}

/** Replay projects each durable activation once, retaining its original identity. */
export function effectiveModelUpdates(
  events: readonly { effectiveModelUpdate?: EffectiveModelUpdate }[],
  operatorId: string,
): EffectiveModelUpdate[] {
  const updates = new Map<string, EffectiveModelUpdate>();
  for (const event of events) {
    const update = event.effectiveModelUpdate;
    if (update?.operatorId === operatorId && !updates.has(update.id)) {
      updates.set(update.id, structuredClone(update));
    }
  }
  return [...updates.values()];
}
