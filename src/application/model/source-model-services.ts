import type { ModelSourceFilesPort } from "./source-files.ts";
import type { SourceCompilationPort } from "./source-compilation.ts";
import type { SourceRevision } from "../../domain/model/records/source-revision.ts";
import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";
import type { ModelEditOperation } from "../../domain/governance/model-access/model-edit-policy.ts";
import type { ModelDelegationChange } from "../../domain/governance/model-access/model-delegation-request.ts";
import type {
  ModelAdministrationAuthorization,
  ModelProposalAuthorization,
} from "../../domain/governance/model-access/model-edit-authorization.ts";
import type { OperatorAuthorityRequest } from "../governance/operator-authority-request.ts";
import type { HostEditRequest } from "../../domain/model/editing/host-edit.ts";

export interface SourceAuthorityPort {
  requests(
    base: SourceRevision,
    request: OperatorAuthorityRequest,
  ): Promise<{ requests: HostEditRequest[]; systemQualifiedName: string }>;
  authorizeEdit(
    model: ExecutableModel,
    revision: SourceRevision,
    operations: readonly ModelEditOperation[],
  ): Promise<Extract<ModelProposalAuthorization, { kind: "operator" }>>;
  administer(
    base: SourceRevision,
    projectId: string,
    current: ExecutableModel,
    input: ModelDelegationChange,
  ): Promise<
    {
      sources: SourceRevision["sources"];
      authorization: ModelAdministrationAuthorization;
    }
  >;
}

/** Dependencies assembled by the host; repository and live tooling have their own contracts. */
export interface SourceModelServices {
  files: ModelSourceFilesPort;
  compilation: SourceCompilationPort;
  authority: SourceAuthorityPort;
}
