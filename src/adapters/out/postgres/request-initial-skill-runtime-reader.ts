import type { RequestInitialSkillRuntimeReader } from "../../../application/work/request-spaces/request-initial-skill-authority.ts";
import type { PostgresHostStorage } from "./host-storage.ts";
import { createRequestSpaceResolver } from "./request-space-execution.ts";
import { decodePostgresRuntimeState } from "./runtime-state-snapshot.ts";

export function createRequestInitialSkillRuntimeReader(
  storage: PostgresHostStorage,
): RequestInitialSkillRuntimeReader {
  const resolve = createRequestSpaceResolver(storage);
  return {
    get scope() {
      return storage.scope;
    },
    resolve,
    async readState(scope) {
      const row = await storage.client.runtimeState.findFirst({ where: scope });
      return row ? decodePostgresRuntimeState(row) : null;
    },
  };
}
