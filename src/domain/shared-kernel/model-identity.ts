export interface ModelIdentity {
  /** Concrete native ConversationSystem selected in a shared source revision. */
  systemQualifiedName?: string;
  backend?: "native";
  projectId: string;
  editingContextId: string;
  rootId: string;
  systemId: string;
  catalogId: string;
  builderId: string;
  reviewerId?: string;
}
