import { createPostgresClient } from "../adapters/out/postgres/client.ts";
import type { PostgresClientConfiguration } from "../adapters/out/postgres/config.ts";
import type { PostgresSystemScope } from "../adapters/out/postgres/scope.ts";
import { existingPrimaryControl } from "../adapters/out/postgres/existing-primary-control.ts";
import { RequestSpaceError } from "../domain/work/request-spaces/scope.ts";
import { createRequestSpaceControls } from "./space-controls.ts";

/** Explicit local CLI only. Reuses canonical services without opening a host,
 * model backend, runtime, worker, writer, HTTP server or migration. */
export async function openLocalSpaceControls(options: {
  database: PostgresClientConfiguration;
  scope: PostgresSystemScope;
  primaryOperatorId: string;
}) {
  const client = createPostgresClient(options.database);
  try {
    const primarySpaceControl = await existingPrimaryControl(
      client,
      options.scope,
      options.primaryOperatorId,
    );
    const { controls } = createRequestSpaceControls({
      client,
      scope: options.scope,
      primarySpaceControl,
    });
    return {
      controls,
      async currentOwnerId() {
        const source = await primarySpaceControl.read();
        if (!source) {
          throw new RequestSpaceError(
            "FORBIDDEN",
            "Current modeled control is unavailable.",
          );
        }
        return source.owner.operatorId;
      },
      close: () => client.$disconnect(),
    };
  } catch (error) {
    await client.$disconnect();
    throw error;
  }
}
