import { PostgresRequestExecutionBindingReader } from "../adapters/out/postgres/request-execution-binding.ts";
import { PostgresRequestSourceAdmissionStore } from "../adapters/out/postgres/request-source-admission-store.ts";
import {
  SpaceAdmissions,
  SpaceControls,
} from "../application/work/request-spaces/control.ts";
import type { PostgresHostStorage } from "../adapters/out/postgres/host-storage.ts";
import {
  PostgresSpaceAdmissions,
  PostgresSpaceCredentials,
} from "../adapters/out/postgres/request-space-control-store.ts";
import { ModeledSpaceControlAuthority } from "../application/work/request-spaces/space-control-authority.ts";
import { CryptographicSpaceSecrets } from "../infrastructure/space-control-secrets.ts";
import { RequestSpaceError } from "../domain/work/request-spaces.ts";

/** Uses the configured PRIMARY handle, never a second locator or policy default.
 * Constructing internal control handles issues no credential. */
export function createRequestSpaceControls(
  storage: Pick<
    PostgresHostStorage,
    "client" | "scope" | "primarySpaceControl"
  >,
) {
  const primary = storage.primarySpaceControl;
  primary.assertClient(storage.client);
  if (
    primary.binding.scope.projectId !== storage.scope.projectId ||
    primary.binding.scope.systemId !== storage.scope.systemId
  ) {
    throw new RequestSpaceError(
      "FORBIDDEN",
      "The PRIMARY binding belongs to another host",
    );
  }
  const credentials = new PostgresSpaceCredentials(storage.client, primary);
  const sqlAdmissions = new PostgresSpaceAdmissions(storage.client, primary);
  const authority = new ModeledSpaceControlAuthority(primary, primary.binding);
  const controls = new SpaceControls(
    credentials,
    authority,
    new CryptographicSpaceSecrets(),
  );
  const admissions = new SpaceAdmissions(
    sqlAdmissions,
    credentials,
    authority,
    controls,
    undefined,
    undefined,
    new PostgresRequestExecutionBindingReader(
      storage.client,
      storage.scope,
      new PostgresRequestSourceAdmissionStore(storage.client),
    ),
  );
  return { controls, admissions, sqlAdmissions };
}
