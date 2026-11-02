/** Flat native model facts shared by model projections. */
export interface ElementRecord {
  id: string;
  metaclass: string;
  name: string;
  ownerId: string;
  qualifiedName: string;
  typeIds: string[];
  direction: string;
  generalIds: string[];
  isReference: boolean;
  /** Explicit ref token, when proven from the native source declaration. */
  declaredReference?: boolean;
  redefinedIds: string[];
  // Literal bounds of an owned multiplicity range, e.g. "0..*"; empty when none.
  multiplicity: string;
  doc: string;
}

export interface ConnectorEnd {
  chain: Array<{ id: string; name: string }>;
}

export interface ConnectorRecord {
  id: string;
  metaclass: string;
  ownerId: string;
  name: string;
  ends: ConnectorEnd[];
}

interface InvocationRecord {
  ancestorIds: string[];
  targetId: string;
}

interface PatternIdRecord {
  ownerId: string;
  value: string;
}

interface MessageRecord {
  id: string;
  ownerId: string;
  name: string;
  fromId: string;
  toId: string;
  payloadId: string;
  payloadName: string;
}

export interface ModelSnapshot {
  rootId: string;
  elements: ElementRecord[];
  connectors: ConnectorRecord[];
  invocations: InvocationRecord[];
  patternIds: PatternIdRecord[];
  messages?: MessageRecord[];
}
