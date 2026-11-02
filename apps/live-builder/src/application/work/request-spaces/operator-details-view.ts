import type { ArtifactSourceBindingReference } from "../../../domain/work/artifacts/source-reference.ts";
import type { ModelRevisionRef } from "../../../domain/model/value-objects/element-ref.ts";
import type { ArtifactSourceInspection } from "../../../domain/work/records/artifact-source-inspection.ts";

/** Observed immutable execution binding, without private runtime state. */
export interface RequestOperatorObservedSource {
  readonly source: ModelRevisionRef;
  readonly modelDigest: string;
  readonly sourceAdmission: {
    readonly revision: number;
    readonly manifestDigest: string;
  };
  readonly adoption: null | {
    readonly commandId: string;
    readonly receiptDigest: string;
    readonly committedRuntimeRevision: number;
  };
}

/** Scoped observed metadata; dependency presence confers no execution authority. */
export interface RequestOperatorDetailsSnapshot {
  caseId: string;
  executionSpaceId: string;
  operatorId: string;
  observedSource: RequestOperatorObservedSource;
  runtimeRevision: number;
  tools: Array<
    {
      id: string;
      name: string;
      description: string;
      digest: string;
      sourceBinding: ArtifactSourceBindingReference;
    }
  >;
  skills: {
    status: "available";
    revision: number;
    items: Array<{
      id: string;
      name: string;
      description: string;
      digest: string;
      loaded: boolean;
      sourceBinding?: ArtifactSourceBindingReference;
    }>;
  } | { status: "unavailable"; reason: string };
}
interface RequestOperatorSourceSelection {
  kind: "tool-draft" | "skill-document";
  id: string;
  expectedDigest: string;
}
export interface RequestOperatorSourceCommand {
  observedSource: RequestOperatorObservedSource;
  selections: RequestOperatorSourceSelection[];
}
export interface RequestOperatorDetailsReadPort {
  read(
    secret: string,
    caseId: string,
    operatorId: string,
  ): Promise<RequestOperatorDetailsSnapshot>;
  source(
    secret: string,
    caseId: string,
    operatorId: string,
    command: RequestOperatorSourceCommand,
  ): Promise<ArtifactSourceInspection>;
}
