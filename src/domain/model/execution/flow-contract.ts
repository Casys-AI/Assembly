import type { ExecutableModel } from "./executable-model.ts";
import type { CompiledFlow } from "./flow.ts";
import { executionDigest } from "../../primitives/execution-digest.ts";

function flowContract(compiled: CompiledFlow) {
  const { source: _source, ...contract } = compiled;
  return {
    ...contract,
    nodes: compiled.nodes.map(({ source: _source, assertions, ...node }) => ({
      ...node,
      assertions: assertions.map(({ source: _source, ...assertion }) =>
        assertion
      ),
    })),
    edges: compiled.edges.map(({ sourceEvidence: _source, ...edge }) => edge),
    bindings: compiled.bindings.map(({ sourceEvidence: _source, ...binding }) =>
      binding
    ),
  };
}

export function flowContracts(model: ExecutableModel) {
  return {
    flows: Object.fromEntries(
      Object.entries(model.flows).map((
        [key, value],
      ) => [key, flowContract(value)]),
    ),
    ...(model.caseFlows
      ? {
        caseFlows: Object.fromEntries(
          Object.entries(model.caseFlows).map((
            [key, value],
          ) => [key, flowContract(value)]),
        ),
      }
      : {}),
  };
}

export async function nativeUnchangedContractDigest(
  model: ExecutableModel,
): Promise<string> {
  const {
    catalog: _catalog,
    version,
    flows: _flows,
    caseFlows: _caseFlows,
    ...owned
  } = model;
  const {
    repositoryVersion: _repository,
    sourceIds: _sourceIds,
    ...versionContract
  } = version;
  return await executionDigest({
    ...owned,
    version: versionContract,
    ...flowContracts(model),
  });
}

/** Digest of the admitted native flows alone; a mandate publication must leave them intact. */
export async function nativeFlowContractDigest(
  model: ExecutableModel,
): Promise<string> {
  return await executionDigest(flowContracts(model));
}
