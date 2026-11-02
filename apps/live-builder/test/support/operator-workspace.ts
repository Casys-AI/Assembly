import { AjvSchemaValidator } from "../../src/infrastructure/ajv-schema-validation.ts";
import { openOperatorWorkspace as open } from "../../src/adapters/work/operator-workspace.ts";
import type { SchemaValidationPort } from "../../src/application/work/behaviors/schema-validation.ts";
import type { CaseNumberPort } from "../../src/application/work/cases/ports/out/case-number.port.ts";
import type { openPostgresRuntimeFixture } from "./postgres-runtime-fixture.ts";

type PostgresFixture = Awaited<ReturnType<typeof openPostgresRuntimeFixture>>;
type WorkspaceOptions = Parameters<typeof open>[0];
type FixtureOptions = {
  schemaValidator?: SchemaValidationPort;
  caseNumbers?: CaseNumberPort;
};
type ExplicitOptions =
  & Omit<WorkspaceOptions, "schemaValidator">
  & { schemaValidator?: SchemaValidationPort };
type PostgresOptions =
  & Omit<
    WorkspaceOptions,
    keyof PostgresFixture["workspacePorts"] | "schemaValidator"
  >
  & FixtureOptions
  & { postgres: PostgresFixture };

/** Dependencies stay explicit. A real fixture can own worker startup; unit
 * fixtures continue to supply their own execution, storage and authority ports. */
export async function openOperatorWorkspace(
  options: ExplicitOptions | PostgresOptions,
) {
  const postgres = "postgres" in options ? options.postgres : undefined;
  const { postgres: _postgres, ...workspaceOptions } = { postgres, ...options };
  const workspace = await open({
    schemaValidator: new AjvSchemaValidator(),
    ...postgres?.workspacePorts,
    ...workspaceOptions,
  } as WorkspaceOptions);
  if (postgres) {
    try {
      await postgres.start(workspace);
    } catch (error) {
      await workspace.close().catch(() => {});
      throw error;
    }
  }
  return workspace;
}
