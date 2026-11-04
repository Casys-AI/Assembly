import type {
  ExecutionSpaceRef,
  ScopedOperatorRef,
} from "../../../domain/governance/authority.ts";

export interface RequestInformationScopeValidationPort {
  assertSystemScope(
    scope: Pick<ExecutionSpaceRef, "projectId" | "systemId">,
  ): void;
  assertRuntimeScope(scope: ScopedOperatorRef): void;
}
