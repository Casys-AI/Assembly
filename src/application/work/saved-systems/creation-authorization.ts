import {
  RequestSpaceError,
  type SpaceController,
} from "../../../domain/work/request-spaces.ts";
import { SavedSystemError } from "../../../domain/work/saved-systems.ts";
import {
  assertReleaseRetentionIntent,
  type ReleaseRetentionAuthorization,
  type ReleaseRetentionIntent,
} from "../../../domain/work/release-retention.ts";
import type { SpaceControlPort } from "../request-spaces/ports.ts";

export interface ReleaseCreationAuthorizationPort {
  authorize(
    intent: ReleaseRetentionIntent,
    controller: SpaceController,
  ): Promise<ReleaseRetentionAuthorization>;
  revalidate(authorization: ReleaseRetentionAuthorization): Promise<void>;
}
/** Existing authenticated modeled control only. No execution admission is issued. */
export class ReleaseCreationAuthority
  implements ReleaseCreationAuthorizationPort {
  constructor(private readonly control: Pick<SpaceControlPort, "revalidate">) {}
  async authorize(
    intent: ReleaseRetentionIntent,
    controller: SpaceController,
  ): Promise<ReleaseRetentionAuthorization> {
    const authorization = structuredClone({ intent, controller });
    await this.revalidate(authorization);
    return authorization;
  }
  async revalidate(
    authorization: ReleaseRetentionAuthorization,
  ): Promise<void> {
    assertReleaseRetentionIntent(authorization.intent);
    try {
      await this.control.revalidate(authorization.controller);
    } catch (error) {
      if (error instanceof RequestSpaceError) {
        throw new SavedSystemError(
          "FORBIDDEN",
          "The current local retention control is unavailable.",
        );
      }
      throw error;
    }
    if (!authorization.controller.authority.acts.includes("retain-release")) {
      throw new SavedSystemError(
        "FORBIDDEN",
        "Current modeled retain-release authority is required.",
      );
    }
  }
}
