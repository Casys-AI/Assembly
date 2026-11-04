import { SourceModel } from "../application/model/source-model.ts";
import type { SourceModelOptions } from "../application/model/source-model-options.ts";
import type { SourceModelServices } from "../application/model/source-model-services.ts";
import { modelSourceFiles } from "../adapters/out/filesystem/model-source-files.ts";
import { sourceCompilation } from "../adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { operatorAuthorityRequests as prepareOperatorAuthorityRequests } from "../application/governance/operator-writer.ts";
import type { OperatorAuthorityRequest } from "../application/governance/operator-authority-request.ts";
import type { SourceRevision } from "../domain/model/records/source-revision.ts";
import { operatorFlowReader } from "../adapters/out/sysml-toolkit/compilation-policies/governance/authority/operator/flow-reader.ts";
import { prepareModelAdministration } from "../application/governance/model-access/administration/operations.ts";
import { createOperatorEditAuthorization } from "../application/governance/model-access/operator-edit-authorization.ts";

export function operatorAuthorityRequests(
  base: SourceRevision,
  request: OperatorAuthorityRequest,
) {
  return prepareOperatorAuthorityRequests(base, request, operatorFlowReader);
}

export const sourceModelServices: SourceModelServices = {
  files: modelSourceFiles,
  compilation: sourceCompilation,
  authority: {
    requests: operatorAuthorityRequests,
    authorizeEdit: createOperatorEditAuthorization,
    administer: (base, projectId, current, input) =>
      prepareModelAdministration(
        base,
        projectId,
        current,
        input,
        sourceCompilation,
      ),
  },
};

export function createSourceModel(
  options: Omit<SourceModelOptions, "services">,
): SourceModel {
  return new SourceModel({ ...options, services: sourceModelServices });
}
