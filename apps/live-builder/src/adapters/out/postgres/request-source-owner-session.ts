import type {
  RequestSourceOwnerSessionEvidence,
  RequestSourceOwnerSessionPort,
} from "../../../application/model/source-admission/owner-authorization.ts";
import type { SpaceControlPort } from "../../../application/work/request-spaces/ports.ts";
import type { PrismaClient } from "./client.ts";
import type { PostgresPrimarySpaceControlSource } from "./primary-space-control-source.ts";
import { PostgresSpaceCredentials } from "./request-space-control-store.ts";

/** Current local channel identity only. D1 still needs the independently
 * compiled prior source and its concrete native model-revision grant. */
export class PostgresRequestSourceOwnerSessions
  implements RequestSourceOwnerSessionPort {
  private readonly credentials: PostgresSpaceCredentials;
  constructor(
    private readonly client: PrismaClient,
    private readonly controls: Pick<SpaceControlPort, "authenticateSession">,
    primary: PostgresPrimarySpaceControlSource,
  ) {
    this.credentials = new PostgresSpaceCredentials(client, primary);
  }

  async authenticate(
    secret: string,
  ): Promise<RequestSourceOwnerSessionEvidence> {
    const controller = structuredClone(
      await this.controls.authenticateSession(secret),
    );
    const current = await this.client.$transaction((tx) =>
      this.credentials.assertCurrentController(tx, controller)
    );
    return {
      kind: "request-source-owner-session",
      controller,
      sessionRevision: current.sessionRevision,
    };
  }

  async revalidate(input: RequestSourceOwnerSessionEvidence): Promise<void> {
    const evidence = structuredClone(input);
    await this.client.$transaction((tx) =>
      this.credentials.assertCurrentController(
        tx,
        evidence.controller,
        evidence.sessionRevision,
      )
    );
  }
}
