import type {
  OpeningStorePort,
  SpaceControlPort,
} from "../request-spaces/ports.ts";
import {
  requestSpaceIdentity,
  type RequestSpaceScope,
  type SpaceController,
  type SpaceControlPrincipal,
} from "../../../domain/work/request-spaces.ts";
import {
  SavedSystemError,
  type SavedSystemMetadata,
  type SavedSystemScope,
  type SavedSystemSourceSelection,
  type SavedSystemView,
} from "../../../domain/work/saved-systems.ts";
import type { RequestReleaseCataloguePort } from "./request-release-ports.ts";
import type { ArtifactSourceInspection } from "../../../domain/work/records/artifact-source-inspection.ts";
import type {
  ModelTagCreation,
  ModelTagCreationCommand,
  ReleaseTagBinding,
  ReleaseTagSelection,
} from "../../../domain/work/release-tags.ts";

type ReleaseSaveCommand = SavedSystemMetadata & {
  saveKey: string;
  source: SavedSystemSourceSelection;
  tag?: ReleaseTagSelection;
};
export interface ScopedReleaseService {
  createTag?(
    command: ModelTagCreationCommand,
    controller: SpaceController,
  ): Promise<ModelTagCreation>;
  /** Actual production service requires current modeled retain-release authority. */
  save(
    command: ReleaseSaveCommand,
    controller: SpaceController,
  ): Promise<SavedSystemView>;
  list(): Promise<SavedSystemView[]>;
  inspect(id: string): Promise<SavedSystemView>;
  readTool(
    id: string,
    operatorId: string,
    candidateId: string,
  ): Promise<ArtifactSourceInspection>;
  listTags?(
    source: SavedSystemSourceSelection,
  ): Promise<{ tags: ReleaseTagBinding[] }>;
}
const unavailable = () =>
  new SavedSystemError(
    "UNAVAILABLE",
    "The selected Release or Request source is unavailable.",
  );

/** Authenticated catalogue/source selection. Ownership bounds access; the
 * injected retention service independently requires the explicit creation act. */
export class RequestReleases {
  constructor(
    private readonly options: {
      scope: RequestSpaceScope;
      control: SpaceControlPort;
      openings: Pick<OpeningStorePort, "forCase">;
      catalogue: RequestReleaseCataloguePort;
      service(scope: SavedSystemScope): ScopedReleaseService;
    },
  ) {}

  private async caseScope(
    controller: SpaceControlPrincipal,
    caseId: string,
  ): Promise<SavedSystemScope> {
    if (!requestSpaceIdentity(caseId)) throw unavailable();
    const record = await this.options.openings.forCase(caseId);
    if (
      !record || record.caseId !== caseId ||
      record.ownerId !== controller.ownerId ||
      record.scope.projectId !== this.options.scope.projectId ||
      record.scope.systemId !== this.options.scope.systemId ||
      !record.base ||
      !["runtime-ready", "admitted", "dispatched"].includes(record.phase)
    ) throw unavailable();
    return { ...this.options.scope, executionSpaceId: record.executionSpaceId };
  }

  async save(
    secret: string,
    command: ReleaseSaveCommand,
  ): Promise<SavedSystemView> {
    const controller = await this.options.control.authenticateSession(secret);
    const scope = command.source.branch.kind === "case"
      ? await this.caseScope(controller, command.source.branch.caseId)
      : { ...this.options.scope, executionSpaceId: "main" };
    await this.options.control.revalidate(controller);
    const result = await this.options.service(scope).save(command, controller);
    await this.options.control.revalidate(controller);
    return result;
  }

  async createTag(
    secret: string,
    command: ModelTagCreationCommand,
  ): Promise<ModelTagCreation> {
    const controller = await this.options.control.authenticateSession(secret);
    const scope = command.source.branch.kind === "case"
      ? await this.caseScope(controller, command.source.branch.caseId)
      : { ...this.options.scope, executionSpaceId: "main" };
    await this.options.control.revalidate(controller);
    const service = this.options.service(scope);
    if (!service.createTag) throw unavailable();
    const result = await service.createTag(command, controller);
    await this.options.control.revalidate(controller);
    return result;
  }

  async list(secret: string, caseId?: string): Promise<SavedSystemView[]> {
    const controller = await this.options.control.authenticateSession(secret);
    if (caseId !== undefined) {
      const scope = await this.caseScope(controller, caseId);
      const result = await this.options.service(scope).list();
      await this.options.control.revalidate(controller);
      return result;
    }
    const result = await this.#owned(controller.ownerId);
    await this.options.control.revalidate(controller);
    return result;
  }

  /** The owner's catalogue, with the origins whose source is still visible. */
  async #owned(ownerId: string): Promise<SavedSystemView[]> {
    const selected = await this.options.catalogue.listOwned(ownerId);
    const views = new Map<string, SavedSystemView>();
    const scopes = new Map(
      selected.map((entry) => [entry.scope.executionSpaceId, entry.scope]),
    );
    for (const scope of scopes.values()) {
      try {
        for (const view of await this.options.service(scope).list()) {
          views.set(view.id, view);
        }
      } catch (error) {
        // Source visibility can be withdrawn independently of the saved row.
        // The owner catalogue omits that origin; it never borrows Main's list.
        if (
          !(error instanceof SavedSystemError && error.code === "FORBIDDEN")
        ) throw error;
      }
    }
    return selected.flatMap(({ record }) =>
      views.has(record.id) ? [views.get(record.id)!] : []
    );
  }

  /** Host-internal (4.8d D3, settled Q2): the owner's retained Releases a
   * Main Operator opening may start from, newest first, at most 20. No
   * session and no HTTP route; opening re-verifies the exact Release. */
  async listForMain(
    ownerId: string,
  ): Promise<Array<{ id: string; digest: string; name: string }>> {
    return (await this.#owned(ownerId)).filter((view) =>
      view.status === "retained" && !view.issues.length && !!view.digest
    ).sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id < b.id ? -1 : 1
        : a.createdAt < b.createdAt
        ? 1
        : -1
    ).slice(0, 20).map((view) => ({
      id: view.id,
      digest: view.digest!,
      name: view.metadata.name,
    }));
  }
  async listTags(secret: string, source: SavedSystemSourceSelection) {
    const controller = await this.options.control.authenticateSession(secret);
    const scope = source.branch.kind === "case"
      ? await this.caseScope(controller, source.branch.caseId)
      : { ...this.options.scope, executionSpaceId: "main" };
    await this.options.control.revalidate(controller);
    const service = this.options.service(scope);
    if (!service.listTags) throw unavailable();
    const result = await service.listTags(source);
    await this.options.control.revalidate(controller);
    return result;
  }

  private async selected(
    controller: SpaceControlPrincipal,
    id: string,
    requestsOnly: boolean,
  ) {
    if (!requestSpaceIdentity(id)) throw unavailable();
    await this.options.control.revalidate(controller);
    const selected = await this.options.catalogue.selected(
      controller.ownerId,
      id,
    );
    if (
      !selected || requestsOnly && selected.scope.executionSpaceId === "main" ||
      selected.scope.projectId !== this.options.scope.projectId ||
      selected.scope.systemId !== this.options.scope.systemId
    ) throw unavailable();
    if (selected.scope.executionSpaceId !== "main") {
      const branch = selected.record.capture.source?.branch;
      if (branch?.kind !== "case") throw unavailable();
      const scope = await this.caseScope(controller, branch.caseId);
      if (scope.executionSpaceId !== selected.scope.executionSpaceId) {
        throw unavailable();
      }
    }
    return selected;
  }

  async inspect(secret: string, id: string): Promise<SavedSystemView> {
    const controller = await this.options.control.authenticateSession(secret);
    const selected = await this.selected(controller, id, true);
    const view = await this.options.service(selected.scope).inspect(id);
    await this.options.control.revalidate(controller);
    return view;
  }

  /** Opening already authenticated its controller; it supplies it server-side,
   * never through the public releaseId/digest source DTO. */
  async inspectForOpening(
    id: string,
    controller?: SpaceControlPrincipal,
  ): Promise<SavedSystemView> {
    if (!controller) {
      throw new SavedSystemError(
        "FORBIDDEN",
        "A current controller is required for Release selection.",
      );
    }
    const selected = await this.selected(controller, id, false);
    const view = await this.options.service(selected.scope).inspect(id);
    await this.options.control.revalidate(controller);
    return view;
  }

  async readTool(
    secret: string,
    id: string,
    operatorId: string,
    candidateId: string,
  ): Promise<ArtifactSourceInspection> {
    const controller = await this.options.control.authenticateSession(secret);
    const selected = await this.selected(controller, id, true);
    const result = await this.options.service(selected.scope).readTool(
      id,
      operatorId,
      candidateId,
    );
    await this.options.control.revalidate(controller);
    return result;
  }
}
