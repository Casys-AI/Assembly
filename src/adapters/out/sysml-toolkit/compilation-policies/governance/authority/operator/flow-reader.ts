import type { OperatorFlowReader } from "../../../../../../../application/governance/operator-writer.ts";
import {
  compileSelectedOperatorFlow,
  flowLiteral,
  OPERATOR_FLOW_PERFORMERS,
  resolveNativeActionBaseIds,
} from "../../../work/operator-flow.ts";

export const operatorFlowReader: OperatorFlowReader = {
  select(snapshot, graph, literals, systemId, elements) {
    const selected = compileSelectedOperatorFlow(
      snapshot,
      graph,
      literals,
      systemId,
      "operatorFlowTemplate",
      10000,
      resolveNativeActionBaseIds(elements),
    );
    const revision = flowLiteral(
      snapshot,
      literals,
      systemId,
      "operatorFlowTemplateRevision",
      "Integer",
    );
    return { selected, revision };
  },
  performer(mechanism) {
    return OPERATOR_FLOW_PERFORMERS[mechanism];
  },
};
