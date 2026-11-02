/** A qualified host primitive occurrence, owned and allocated by native source. */
export interface OperatorEntry {
  id: string;
  kind:
    | "inbox"
    | "reuse-tool"
    | "published-tools"
    | "inspect-work-artifacts"
    | "work-plan"
    | "context-evidence"
    | "memory-capture"
    | "memory-recall"
    | "memory-revise"
    | "memory-review"
    | "memory-withdraw"
    | "skill-install"
    | "skill-list"
    | "skill-load"
    | "skill-unload";
  typeId: string;
  performerId: string;
  allocationId: string;
  sourceIds: string[];
}
