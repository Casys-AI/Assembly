import type { CompiledModel } from "../../../../domain/model/records/compiled-model.ts";
import type { ModelRevision } from "../../../../domain/model/records/revision.ts";
import type { ModelProposalAuthorization } from "../../../../domain/governance/records/model-edit-authorization.ts";
import type { AuthorityExercise } from "../../../../domain/governance/authority.ts";
import type { EvolutionAuthorityExercise } from "../../../../domain/model/evolution/policy.ts";

export interface ModelSourceAuthorizationPort {
  validate(input: {
    authority: ModelRevision;
    before: ModelRevision;
    after: CompiledModel;
    authorization?: ModelProposalAuthorization;
    decisionAuthorityExercise?: AuthorityExercise;
    evolutionDecision?: EvolutionAuthorityExercise;
    /** The one new teammate system a person's Request team decision creates
     * (4.8e). Honoured only for a local owner whose exercise covers that
     * teammate's parent; every other new root still requires recovery. */
    teamCreationRoot?: string;
    author: string;
    phase: "proposal" | "acceptance" | "recovery";
  }): Promise<void>;
  /** Explicit Request software path: the actual retained execution model is
   * independently resolved and checked by the trusted scoped Git facade. */
  validateScopedSoftware?(
    input: Parameters<ModelSourceAuthorizationPort["validate"]>[0],
    actor:
      import("../../../../domain/model/execution/executable-model.ts").ExecutableModel,
  ): Promise<void>;
}
