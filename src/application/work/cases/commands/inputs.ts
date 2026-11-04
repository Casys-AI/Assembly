import type { Case } from "../../../../domain/work/entities/cases.ts";

export interface OperatorRequestOpening {
  changeId: string;
  caseTypeId: string;
  objective: string;
  openedBy: string;
  openedFrom: Case["openedFrom"];
}

/** Actual opener captured by the Main host. */
export interface IndependentRequestResume {
  taskSourceInputs?:
    import("../../../../domain/work/records/task-source-input.ts").TaskSourceInputCapture[];
  caseId: string;
  resumeId: string;
  instruction: string;
  openedBy: string;
  conversationId: string;
  designerScopeId: string;
}
