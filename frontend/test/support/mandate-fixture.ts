import type {
  GraphEdge as ViewEdge,
  GraphNode,
  MandateAnnotation,
  OperatorAnnotation,
} from "../../lib/graph/types.ts";
export type ViewNode = GraphNode & { nativeId: string; role: string };
export function mandateFixture() {
  const holder: ViewNode & {
    operator: OperatorAnnotation;
    mandate: MandateAnnotation;
  } = {
    id: "use:builder",
    nativeId: "native-builder",
    label: "builder",
    role: "usage",
    category: "part",
    kind: "part-usage",
    operator: {
      nativeId: "native-builder",
      roleLabel: "Proposal role",
      depictedJudgmentRefs: ["native-propose"],
      capabilityBindings: [],
    },
    mandate: {
      id: "builder-proposal",
      version: "1",
      nativeId: "native-mandate",
      holderNativeId: "native-builder",
      scopeLabel: "Propose one tested candidate",
      allowedChoices: ["propose exact candidate"],
      limits: ["cannot self-admit"],
      sourceRefs: ["native-holder-binding", "src/domain/operator-policy.ts"],
      evidenceLevel: "configured",
      grantingOperator: "unknown",
    },
  };
  const action: ViewNode = {
    id: "use:propose",
    nativeId: "native-propose",
    label: "propose",
    role: "usage",
    category: "action",
    kind: "action-usage",
  };
  const record: ViewNode = {
    id: "use:mandate",
    nativeId: "native-mandate",
    label: "builderMandate",
    role: "usage",
    category: "item",
    kind: "item-usage",
  };
  const edges: ViewEdge[] = [{
    id: "allocated:proposal",
    source: action.id,
    target: holder.id,
    kind: "allocation",
  }];
  return { holder, action, record, nodes: [holder, action, record], edges };
}
