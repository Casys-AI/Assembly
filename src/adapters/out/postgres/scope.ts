import type { RequestInformationScopeValidationPort } from "../../../application/work/context/request-information-scope-validation.ts";

/** Explicit host-resolved scope; none of these identities grants authority. */
export interface PostgresSystemScope {
  readonly projectId: string;
  readonly systemId: string;
}

export interface PostgresRuntimeScope extends PostgresSystemScope {
  readonly executionSpaceId: string;
  readonly operatorId: string;
}

export function assertPostgresSystemScope(
  scope: PostgresSystemScope,
): void {
  for (const value of [scope.projectId, scope.systemId]) {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
      throw new Error("Invalid PostgreSQL system scope");
    }
  }
}

export function assertPostgresRuntimeScope(
  scope: PostgresRuntimeScope,
): void {
  assertPostgresSystemScope(scope);
  for (const value of [scope.executionSpaceId, scope.operatorId]) {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
      throw new Error("Invalid PostgreSQL runtime scope");
    }
  }
}

export const postgresScopeValidation: RequestInformationScopeValidationPort = {
  assertSystemScope: assertPostgresSystemScope,
  assertRuntimeScope: assertPostgresRuntimeScope,
};
