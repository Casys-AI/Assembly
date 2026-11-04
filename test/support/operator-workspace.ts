import { sourceExecutablesCompilation } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { createSourceModel } from "../../src/composition/source-model-services.ts";
import { AjvSchemaValidator } from "../../src/infrastructure/ajv-schema-validation.ts";
import { openOperatorWorkspace as open } from "../../src/composition/operator-workspace.ts";
import type { SchemaValidationPort } from "../../src/application/work/behaviors/schema-validation.ts";
import type { CaseNumberPort } from "../../src/application/work/cases/ports/out/case-number.port.ts";
import type { openPostgresRuntimeFixture } from "./postgres-runtime-fixture.ts";

type PostgresFixture = Awaited<ReturnType<typeof openPostgresRuntimeFixture>>;
type WorkspaceOptions = Parameters<typeof open>[0];
type FixtureOptions = {
  schemaValidator?: SchemaValidationPort;
  caseNumbers?: CaseNumberPort;
  createSourceModel?: WorkspaceOptions["createSourceModel"];
  sourceExecutablesCompilation?:
    WorkspaceOptions["sourceExecutablesCompilation"];
};
type ExplicitOptions =
  & Omit<
    WorkspaceOptions,
    "schemaValidator" | "createSourceModel" | "sourceExecutablesCompilation"
  >
  & FixtureOptions;
type PostgresOptions =
  & Omit<
    WorkspaceOptions,
    | keyof PostgresFixture["workspacePorts"]
    | "schemaValidator"
    | "createSourceModel"
    | "sourceExecutablesCompilation"
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
  const projectId = workspaceOptions.primary.snapshot.executionModel?.identity
    .projectId;
  const workspace = await open({
    schemaValidator: new AjvSchemaValidator(),
    ...postgres?.workspacePorts,
    ...workspaceOptions,
    sourceExecutablesCompilation:
      workspaceOptions.sourceExecutablesCompilation ??
        sourceExecutablesCompilation,
    createSourceModel: workspaceOptions.createSourceModel ??
      ((sourceOptions) =>
        createSourceModel({
          ...sourceOptions,
          tooling: workspaceOptions.tooling,
          repository: workspaceOptions.repository,
          projectId: projectId!,
        })),
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
