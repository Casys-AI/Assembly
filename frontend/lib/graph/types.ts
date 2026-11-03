/** Browser-facing read model. These records carry evidence; they grant no authority. */
export interface CapabilityBinding {
  relationship: string;
  kind?: string;
  nativeId?: string;
  name?: string;
  sourceRefs: string[];
  evidenceLevel: string;
}

export interface OperatorAnnotation {
  nativeId: string;
  roleLabel?: string;
  depictedJudgmentRefs: string[];
  capabilityBindings?: CapabilityBinding[];
}

export interface MandateAnnotation {
  id: string;
  version: string;
  nativeId: string;
  holderNativeId: string;
  scopeLabel: string;
  allowedChoices: string[];
  limits?: string[];
  sourceRefs: string[];
  evidenceLevel: string;
  grantingOperator?: string;
  networkScope?: { allowedHosts: string[]; sourceRefs: string[] };
}

export interface NativeViewMember {
  nativeId?: string;
  importedMembershipId?: string;
  targetNativeId?: string;
  featurePath?: string[];
  recursive?: boolean;
  graphNodeIds?: string[];
  nestedViewId?: string;
  resolution: string;
}

export interface NativeModelView {
  id: string;
  nativeId: string;
  label: string;
  ownerNativeId?: string;
  members: NativeViewMember[];
  sourceEvidenceIds?: string[];
}

export interface GraphNode {
  id: string;
  nativeId?: string;
  label?: string;
  name?: string;
  nativeKind?: string;
  kind?: string;
  metaclass?: string;
  role?: string;
  category?: string;
  dimension?: string;
  parentId?: string | null;
  ownerNativeId?: string;
  symbol?: string;
  typeName?: string;
  typeLabel?: string;
  description?: string;
  runtimeStage?: string;
  modelStage?: string;
  runtimeColor?: string;
  observedState?: boolean;
  runtimeStateEvidence?: unknown;
  stateRole?: string;
  stateRoleSourceId?: string;
  operator?: OperatorAnnotation;
  mandate?: MandateAnnotation;
  effectiveDirection?: string;
  declaredDirection?: string;
  performerLabels?: string[];
  allocatedTo?: Array<string | { label?: string }>;
  patternAnnotations?: Array<string | { label?: string; name?: string }>;
  annotations?: Array<string | { label?: string; name?: string }>;
  viewMembers?: NativeViewMember[];
  sourceEvidence?: unknown;
  contextPath?: string[];
  conjugated?: boolean;
  conjugationSourceIds?: string[];
  directionConjugationIds?: string[];
  displayOnly?: boolean;
  projection?: unknown;
  guard?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  nativeId?: string;
  metaclass?: string;
  label?: string;
  description?: string;
  guard?: string;
  trigger?: string;
  event?: string;
  triggerLabel?: string;
  eventLabel?: string;
  displayOnly?: boolean;
  origin?: string;
  projection?: unknown;
  sourceEvidence?: unknown;
  sourceFeaturePath?: string[];
  targetFeaturePath?: string[];
}

/** Serializable sequence data. Native scenarios and observations retain distinct origins. */
export interface GraphSequenceParticipant {
  id: string;
  name: string;
  typeId?: string;
  typeName?: string;
  origin?: "native" | "host" | "external";
  nativeId?: string;
}

export interface GraphSequenceEvidence {
  messageId?: string;
  eventId?: string;
  nativeSourceIds: string[];
  sourceContextCount?: number;
}

export interface GraphSequenceMessage {
  id: string;
  name: string;
  from: string;
  to: string;
  payloadId?: string;
  payloadName?: string;
  kind?: "message" | "event";
  at?: string;
  recordId?: string;
  sourceEventId?: string;
  targetEventId?: string;
  eventKind?: string;
  actionId?: string;
  modelDigest?: string;
  repositoryVersion?: string;
  sourceIds?: string[];
  evidence?: GraphSequenceEvidence;
}

export interface GraphSequence {
  id: string;
  name: string;
  doc?: string;
  qualifiedName?: string;
  origin?: "native" | "observed";
  nativeId?: string;
  ordering?:
    | "native-partial-order"
    | "declaration"
    | "cyclic"
    | "non-linearizable";
  diagnostics?: string[];
  sourceIds?: string[];
  lifelines: GraphSequenceParticipant[];
  messages: GraphSequenceMessage[];
}

export interface NativeGraphSequence extends GraphSequence {
  nativeId: string;
  origin?: "native";
  ordering:
    | "native-partial-order"
    | "declaration"
    | "cyclic"
    | "non-linearizable";
  diagnostics: string[];
  sourceIds: string[];
}

export interface ObservedGraphSequence extends GraphSequence {
  origin: "observed";
  revision: number;
  busy: boolean;
  phase: string;
  lastActivityAt?: string;
  total: number;
  omitted: number;
  limit: 150;
  diagnostics: string[];
  lifelines: Array<
    GraphSequenceParticipant & {
      typeId: string;
      typeName: string;
      origin: "native" | "host" | "external";
    }
  >;
  messages: Array<
    GraphSequenceMessage & {
      kind: "message" | "event";
      at: string;
      recordId: string;
      payloadId: string;
      payloadName: string;
      evidence: GraphSequenceEvidence & { sourceContextCount: number };
    }
  >;
}

export interface GraphData {
  title?: string;
  sourceFile?: string;
  projectionNote?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  views?: NativeModelView[];
  diagnostics?: string[];
  sequences?: GraphSequence[];
  sequenceDiagnostics?: string[];
  executionSequences?: ObservedGraphSequence[];
}

export type GraphHistory =
  | { revision: number; recordedAt?: string; modelVersion?: never }
  | { modelVersion: string; revision?: never; recordedAt?: never };

export interface GraphSnapshot {
  graph: GraphData;
  version: string;
  projectionDigest: string;
  activityDigest?: string;
  projectionDigestScope?: "native" | "legacy-with-activity";
  history: GraphHistory | null;
  readAt?: string;
  error: string | null;
}
