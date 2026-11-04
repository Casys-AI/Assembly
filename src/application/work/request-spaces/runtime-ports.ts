import type { OpeningRecord } from "../../../domain/work/request-spaces.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { ScopedOperatorRef } from "../../../domain/governance/authority.ts";
import type {
  RequestAdoptionManifest,
  RequestAdoptionReceipt,
} from "../../model/evolution/request-adoption-ports.ts";
import type { SkillStorePort } from "../../skills/ports.ts";
import type { WorkBudgetStorePort } from "../budget/ports.ts";
import type { CaseNumberPort } from "../cases/ports/out/case-number.port.ts";
import type {
  NativeExecutionPort,
  ResolvedOperatorScope,
  RuntimeStateHistoryPort,
} from "../native-execution/contract.ts";
import type { OperatorExecutionDispatchPort } from "../operators/execution.ts";
import type { StorePort } from "../runtime/ports.ts";

/** A verified admitted fold, read in one snapshot before independent run reads. */
export interface RequestAdmittedSourceReader {
  read(record: OpeningRecord): Promise<{
    readonly execution: {
      readonly adoptions: readonly {
        readonly manifest:
          & Pick<RequestAdoptionManifest, "commandId" | "intent">
          & {
            readonly nativeRetirement: Pick<
              RequestAdoptionManifest["nativeRetirement"],
              "predecessorThreadIds" | "successorThreadIds"
            >;
          };
        readonly receipt: RequestAdoptionReceipt;
      }[];
    };
  }>;
}

export interface ExecutionSpaceLifecycleReader {
  read(record: OpeningRecord): Promise<
    {
      caseId: string | null;
      parentExecutionSpaceId: string | null;
      lifecycle: string;
      closedAt: Date | null;
    } | null
  >;
}

/** Preserve every waiting row, including null snapshots, in storage order. */
export interface WaitingExecutionRunReader {
  read(
    scope: Readonly<ScopedOperatorRef>,
    target?: { threadId: string; checkpointId?: string },
  ): Promise<readonly { snapshotJson: string | null }[]>;
}

/** The runtime consumes only these stores; callers may retain richer stores. */
export interface RequestOperatorStorage {
  readonly state: StorePort & RuntimeStateHistoryPort;
  readonly skills: SkillStorePort;
  readonly budget: WorkBudgetStorePort;
}

export interface RequestHostStorage<
  S extends RequestOperatorStorage = RequestOperatorStorage,
> {
  readonly scope: { projectId: string; systemId: string };
  caseSpace(executionSpaceId: string, caseId: string): Promise<{
    operator(operatorId: string): Promise<S>;
  }>;
  readCaseRuntimeState(
    executionSpaceId: string,
    caseId: string,
    operatorId: string,
  ): Promise<SystemRuntimeState | null>;
  caseNumbers(): CaseNumberPort;
}

export interface AdmittedRequestRuntime {
  readonly scope: {
    projectId: string;
    systemId: string;
    executionSpaceId: string;
  };
  forCaseSpace(executionSpaceId: string, caseId: string): Promise<{
    scope: ResolvedOperatorScope;
    execution: NativeExecutionPort;
    dispatch:
      & OperatorExecutionDispatchPort
      & Required<Pick<OperatorExecutionDispatchPort, "inspectAccepted">>;
  }>;
}
