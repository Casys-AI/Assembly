import type {
  GraphEdge as Edge,
  GraphNode as Node,
} from "../../lib/graph/types.ts";
export function flowFixture() {
  const node = (id: string, kind: string, parentId?: string): Node => ({
    id,
    kind,
    parentId,
    role: "usage",
    category: "action",
    label: id,
  });
  const promotion = node("scope:one", "perform-action-usage", "system");
  const conversation = node("scope:two", "perform-action-usage", "system");
  const nested = node("nested-call", "perform-action-usage", conversation.id);
  const nodes: Node[] = [
    { id: "system", role: "usage", kind: "part-usage", category: "part" },
    promotion,
    conversation,
    {
      id: "def:promotion",
      role: "definition",
      kind: "action-definition",
      label: "CapabilityPromotion",
    },
    {
      id: "def:conversation",
      role: "definition",
      kind: "action-definition",
      label: "ConversationCase",
    },
    node("promotion:first", "action-usage", promotion.id),
    node("promotion:last", "action-usage", promotion.id),
    node("read", "action-usage", conversation.id),
    nested,
    node("wait", "action-usage", conversation.id),
    node("nested:first", "action-usage", nested.id),
    node("nested:last", "action-usage", nested.id),
    {
      ...node("state-scope", "exhibit-state-usage", conversation.id),
      category: "state",
    },
    {
      ...node("state-entry", "action-usage", "state-scope"),
      stateRole: "initial",
    },
    node("state-effect", "action-usage", "state-scope"),
    {
      ...node("unscoped", "action-usage", "system"),
      label: "ConversationCase",
    },
    node("other-unscoped", "action-usage", "system"),
  ];
  const edge = (
    id: string,
    source: string,
    target: string,
    kind = "succession",
  ): Edge => ({ id, source, target, kind });
  const edges = [
    edge("type:p", promotion.id, "def:promotion", "typing"),
    edge("type:c", conversation.id, "def:conversation", "typing"),
    edge("promotion-edge", "promotion:first", "promotion:last"),
    edge("read-call", "read", nested.id),
    edge("call-wait", nested.id, "wait"),
    { ...edge("return", "wait", "read"), guard: "input.available" },
    edge("nested-edge", "nested:first", "nested:last"),
    edge("state-edge", "state-entry", "state-effect"),
    edge("unscoped-edge", "unscoped", "other-unscoped"),
    edge("cross-scope", "promotion:last", "read"),
  ];
  return { nodes, edges, promotion, conversation, nested };
}
