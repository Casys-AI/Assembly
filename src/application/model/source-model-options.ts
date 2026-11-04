import type { SourceModelServices } from "./source-model-services.ts";
import type { SourceRepository } from "./source-repository.ts";
import type { ModelSources as Sources } from "../../domain/model/value-objects/sources.ts";
import type { ModelToolingPort } from "./tooling.ts";
import type { ModelWriteSubmissionPort } from "./publication/submission.ts";
import type { AuthorityExercise } from "../../domain/governance/authority.ts";

export interface SourceModelOptions {
  repository: SourceRepository;
  services: SourceModelServices;
  /** Namespaces the identity independently of an editor or mutable branch head. */
  projectId: string;
  /** Exact concrete ConversationSystem occurrence in the shared model. */
  systemQualifiedName?: string;
  /** Explicit migration input prepared and backed up outside this orchestration. */
  initialSources?: Sources;
  /** Required source tooling; stored compilation and admission stay unchanged. */
  tooling: ModelToolingPort;
  writer?: ModelWriteSubmissionPort;
  /** A branch publication of a Main Operator's decision: its recorded
   * delegated exercise, compared instead of Main's current policy (4.8c A2). */
  recordedDelegation?: { exercise: AuthorityExercise };
  /** A branch preview/publication: creation policies read in the
   * requester's branch with its verified whole-team size (4.8e E1/E4).
   * Absent on main, where the model's own main scope applies. */
  creationScope?:
    import("../../domain/governance/policies/operator-creation-policy.ts").CreationScope;
}
