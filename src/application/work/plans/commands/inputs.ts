import type { BehaviorModelVersion } from "../../../../domain/shared-kernel/behavior-model-version.ts";
import type {
  AdmittedWorkTask,
  WorkPlanOrigin,
} from "../../../../domain/work/entities/plans.ts";

export interface WorkPlanExecution {
  id: string;
  caseId?: string;
  callerId: string;
  modelVersion: BehaviorModelVersion;
  origin?: WorkPlanOrigin;
  tasks: AdmittedWorkTask[];
  /** A host resource bound, not another behavior permission. */
  maxConcurrency?: number;
}
