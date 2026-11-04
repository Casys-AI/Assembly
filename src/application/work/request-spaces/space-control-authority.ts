import type { SpaceCapabilityAuthorityPort } from "./ports.ts";
import type {
  SpaceControlAdoptedState,
  SpaceControlAuthority,
  SpaceControlSourceBinding,
} from "../../../domain/work/request-spaces/space-control.ts";
import {
  projectSpaceControlAuthority,
  type SpaceControlSource,
} from "../../../domain/work/policies/space-control-source.ts";

/** Required admitted control source. Missing policy confers no authority. */
export interface CurrentSpaceControlSourcePort {
  read(): Promise<SpaceControlSource | null>;
  capture(): Promise<
    {
      source: SpaceControlSource | null;
      adoptedState: SpaceControlAdoptedState;
    }
  >;
}
export class ModeledSpaceControlAuthority
  implements SpaceCapabilityAuthorityPort {
  private readonly binding: SpaceControlSourceBinding;
  constructor(
    private readonly source: CurrentSpaceControlSourcePort,
    binding: SpaceControlSourceBinding,
  ) {
    this.binding = Object.freeze({
      scope: Object.freeze({ ...binding.scope }),
      sourceSystemNativeId: binding.sourceSystemNativeId,
    });
  }
  async capture(ownerId: string) {
    const captured = await this.source.capture();
    return {
      authority: projectSpaceControlAuthority(
        captured.source,
        this.binding,
        ownerId,
      ),
      adoptedState: structuredClone(captured.adoptedState),
    };
  }
  async current(ownerId: string): Promise<SpaceControlAuthority> {
    return projectSpaceControlAuthority(
      await this.source.read(),
      this.binding,
      ownerId,
    );
  }
}
