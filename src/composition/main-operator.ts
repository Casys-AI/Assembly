/** Main Operator composition: the one sequence that turns an initialized Main
 * runtime into the registered Main of the host. The host and its PostgreSQL
 * witnesses call this same function, so the operator workspace, its Branch
 * Operator authority and the delivery start order are never rebuilt by hand. */
import type { QueuedArtifactSourcePublication } from "../domain/work/artifacts/source-publication.ts";
import { ArtifactSourceError } from "../domain/work/artifacts/source-reference.ts";
import type { DecisionInformationPort } from "../application/work/context/information-ports.ts";
import type { SystemRuntime } from "../application/work/runtime/system.ts";
import type { RequestChangeDecision } from "../application/work/request-spaces/request-change-decision.ts";
import { openOperatorWorkspace } from "./operator-workspace.ts";
import {
  type PostgresHostStorage,
  publicPostgresFailure,
} from "../adapters/out/postgres/host-storage.ts";
import type { createRequestSpacesComposition } from "./request-spaces.ts";
import type { RequestReleases } from "../application/work/saved-systems/request-releases.ts";
import { startPrimaryDeliveries } from "./lifecycle.ts";

type WorkspaceOptions = Parameters<typeof openOperatorWorkspace>[0];

export interface MainOperatorCompositionInput {
  primaryOperatorId: string;
  storage: PostgresHostStorage;
  requestSpaces: Awaited<ReturnType<typeof createRequestSpacesComposition>>;
  /** The owner's Release catalogue: what a Main Operator opening may start from. */
  releases: Pick<RequestReleases, "listForMain">;
  /** The model backend's single source authority gate. */
  bindArtifactSourceAuthority(
    verify: (publication: QueuedArtifactSourcePublication) => Promise<void>,
  ): () => void;
  /** Workspace ports the host resolves itself; the Request-facing ports
   * (origins, source authority, branch authority) are wired here. */
  workspace: Omit<
    WorkspaceOptions,
    | "storage"
    | "assertArtifactSourceOrigin"
    | "bindArtifactSourceAuthority"
    | "assertCommandOrigin"
    | "branchAuthority"
    | "requestOpenings"
  >;
  informationReader: { current?: DecisionInformationPort };
  /** Read lazily by the Request authority; set once Main registers. */
  registeredMain: { current?: SystemRuntime };
  prepareNetworkDecision(): RequestChangeDecision;
}

/** Open the operator workspace over Main, then start primary deliveries:
 * registered Main, network decision, software recovery, native workers,
 * runtime deliveries and the Branch Operator authority replay, in that order. */
export async function composeMainOperator(
  input: MainOperatorCompositionInput,
) {
  const { storage, requestSpaces } = input;
  const nativeRuntime = requestSpaces.nativeRuntime;
  const workspace = await openOperatorWorkspace({
    ...input.workspace,
    storage,
    assertArtifactSourceOrigin: (publication) =>
      nativeRuntime.assertArtifactSourceOrigin(publication).catch((error) => {
        throw publicPostgresFailure(error) ?? error;
      }),
    bindArtifactSourceAuthority: (verifyMain) =>
      input.bindArtifactSourceAuthority(async (publication) => {
        const target = publication.target;
        if (
          target.projectId !== storage.scope.projectId ||
          target.systemId !== storage.scope.systemId
        ) throw new ArtifactSourceError("scope");
        // Select the execution space before any native operator lookup. A
        // Request refusal must never retry through Main's authority.
        if (target.executionSpaceId === storage.executionSpaceId) {
          await verifyMain(publication);
        } else {
          await requestSpaces.assertArtifactSourcePublication(publication);
        }
      }),
    assertCommandOrigin: (origin) =>
      nativeRuntime.assertCommandOrigin(origin).catch((error) => {
        throw publicPostgresFailure(error) ?? error;
      }),
    ...(requestSpaces.branchAuthority
      ? {
        branchAuthority: requestSpaces.branchAuthority,
        requestOpenings: {
          openForMain: (command, opener) =>
            requestSpaces.openings.openForMain(command, opener),
          writeForMain: (caseId, written, opener) =>
            requestSpaces.openings.writeForMain(caseId, written, opener),
          releases: () => {
            const owner = input.workspace.primary.snapshot.executionModel
              ?.ownerAuthority;
            return owner?.ownerSource === "modeled"
              ? input.releases.listForMain(owner.operatorId)
              : Promise.resolve([]);
          },
        },
      }
      : {}),
  });
  await startPrimaryDeliveries({
    primaryOperatorId: input.primaryOperatorId,
    workspace,
    informationReader: input.informationReader,
    registeredMain: input.registeredMain,
    requestSpaces,
    prepareNetworkDecision: input.prepareNetworkDecision,
    nativeRuntime,
  });
  return workspace;
}
