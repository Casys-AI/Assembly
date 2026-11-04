import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { skillContentDigest } from "../../../domain/skills/context-skills.ts";
import type { SkillCatalogRecord } from "../../../domain/skills/records/catalog.ts";
import {
  sourceDigest,
  sourceIdentity,
  validateSourceBindingReference,
} from "../../../domain/work/artifacts/source-reference.ts";
import type { ArtifactSourceInspection } from "../../../domain/work/records/artifact-source-inspection.ts";
import type {
  RequestOperatorDetailsReadPort,
  RequestOperatorDetailsSnapshot,
  RequestOperatorSourceCommand,
} from "./operator-details-view.ts";
import { type OpeningRecord } from "../../../domain/work/request-spaces/opening.ts";
import {
  RequestSpaceError,
  requestSpaceIdentity,
  type RequestSpaceScope,
} from "../../../domain/work/request-spaces/scope.ts";
import { type SpaceController } from "../../../domain/work/request-spaces/space-control.ts";
import type { RequestExecutionBinding } from "../../model/evolution/request-adoption-ports.ts";
import type { ArtifactSourceServicePort } from "../artifacts/publication.ts";
import { toolDraftDigest } from "../artifacts/catalog.ts";
import type {
  OpeningSourcePort,
  OpeningStorePort,
  SpaceControlPort,
} from "./ports.ts";

export interface RequestOperatorDetailsObservationPort {
  binding(record: OpeningRecord): Promise<RequestExecutionBinding>;
  skills(record: OpeningRecord): Promise<SkillCatalogRecord | null>;
}
function refused(
  message = "The selected Request details are unavailable.",
): never {
  throw new RequestSpaceError("FORBIDDEN", message);
}
function unavailable(): never {
  throw new RequestSpaceError(
    "UNAVAILABLE",
    "The exact persisted Request details are unavailable.",
  );
}

/** Pure inspection: every dependency is a persisted reader, never a runtime accessor. */
export class RequestOperatorDetails implements RequestOperatorDetailsReadPort {
  constructor(
    private readonly options: {
      scope: RequestSpaceScope;
      control: SpaceControlPort;
      store: Pick<OpeningStorePort, "forCase">;
      observations: RequestOperatorDetailsObservationPort;
      source: Pick<OpeningSourcePort, "readTool">;
      artifactSourcesForScope(
        scope: RequestSpaceScope & {
          executionSpaceId: string;
          operatorId: string;
        },
      ): Promise<Pick<ArtifactSourceServicePort, "resolveSkill">>;
      compare?(sources: ArtifactSourceInspection["sources"]): string;
    },
  ) {}
  private async owned(
    caseId: string,
    operatorId: string,
    controller: SpaceController,
  ): Promise<OpeningRecord> {
    if (!requestSpaceIdentity(caseId) || !sourceIdentity(operatorId)) refused();
    const record = await this.options.store.forCase(caseId);
    if (
      !record?.base || record.ownerId !== controller.ownerId ||
      record.caseId !== caseId ||
      record.scope.projectId !== this.options.scope.projectId ||
      record.scope.systemId !== this.options.scope.systemId ||
      record.executionSpaceId === "main" ||
      record.base.requestOwner.operatorId !== operatorId ||
      !["runtime-ready", "admitted", "dispatched"].includes(record.phase)
    ) refused();
    return record;
  }
  private async capture(
    record: OpeningRecord,
  ): Promise<RequestOperatorDetailsSnapshot> {
    const binding = await this.options.observations.binding(record);
    const operatorId = record.base!.requestOwner.operatorId,
      model = binding.state.executionModel;
    if (
      !model || model.identity.builderId !== operatorId ||
      model.version.digest !== binding.pin.modelDigest ||
      model.version.repositoryVersion !== binding.pin.source.version
    ) unavailable();
    const owners = record.base!.manifest.operators.filter((entry) =>
      entry.operatorId === operatorId
    );
    if (owners.length !== 1 || owners[0].tools.length > 256) unavailable();
    const seen = new Set<string>();
    const tools = owners[0].tools.map((tool) => {
      if (seen.has(tool.candidateId) || !sourceDigest(tool.digest)) {
        unavailable();
      }
      seen.add(tool.candidateId);
      validateSourceBindingReference(tool.sourceBinding);
      const ref = tool.sourceBinding;
      if (
        ref.ownerId !== operatorId ||
        ref.localArtifactId !== tool.candidateId ||
        ref.reference.kind !== "tool-draft" ||
        ref.reference.contentDigest !== tool.digest
      ) unavailable();
      const candidate = binding.state.candidates?.find((entry) =>
        entry.id === tool.candidateId && entry.digest === tool.digest
      );
      const catalogue = model.catalog.find((entry) =>
        entry.candidateId === tool.candidateId && entry.digest === tool.digest
      );
      return {
        id: tool.candidateId,
        name: candidate?.name ?? catalogue?.name ?? tool.candidateId,
        description: candidate?.description ?? "Retained Request dependency",
        digest: tool.digest,
        sourceBinding: structuredClone(ref),
      };
    });
    const catalog = await this.options.observations.skills(record);
    if (catalog && catalog.ownerId !== operatorId) unavailable();
    return {
      caseId: record.caseId,
      executionSpaceId: record.executionSpaceId,
      operatorId,
      observedSource: structuredClone(binding.pin),
      runtimeRevision: binding.state.revision,
      tools,
      skills: catalog
        ? {
          status: "available",
          revision: catalog.revision,
          items: catalog.skills.map((
            { id, name, description, digest, loaded, sourceBinding },
          ) => ({
            id,
            name,
            description,
            digest,
            loaded,
            ...(sourceBinding
              ? { sourceBinding: structuredClone(sourceBinding) }
              : {}),
          })),
        }
        : {
          status: "unavailable",
          reason: "This Request has no persisted skill catalogue.",
        },
    };
  }
  private async revalidate(
    secret: string,
    record: OpeningRecord,
    controller: SpaceController,
    observed: RequestOperatorDetailsSnapshot,
  ) {
    const current = await this.owned(
      record.caseId,
      observed.operatorId,
      controller,
    );
    if (
      current.id !== record.id ||
      current.executionSpaceId !== record.executionSpaceId ||
      current.baseDigest !== record.baseDigest ||
      canonical(current.base) !== canonical(record.base)
    ) refused();
    const now = await this.capture(current);
    if (
      canonical(now.observedSource) !== canonical(observed.observedSource) ||
      canonical(now.tools) !== canonical(observed.tools) ||
      canonical(now.skills) !== canonical(observed.skills)
    ) {
      throw new RequestSpaceError(
        "OPENING_CONFLICT",
        "The Request source or catalogue changed. Read its details again.",
      );
    }
    // Skill/catalogue loading can wait after the binding query. Observe the
    // exact execution pin once more after that wait before releasing metadata.
    const finalBinding = await this.options.observations.binding(current);
    if (canonical(finalBinding.pin) !== canonical(observed.observedSource)) {
      throw new RequestSpaceError(
        "OPENING_CONFLICT",
        "The Request source changed. Read its details again.",
      );
    }
    // The final metadata/binding read may itself have waited. Recheck ownership
    // after it, rather than allowing that delayed read to retain a former owner.
    const finalRecord = await this.owned(
      record.caseId,
      observed.operatorId,
      controller,
    );
    if (
      finalRecord.id !== record.id ||
      finalRecord.executionSpaceId !== record.executionSpaceId ||
      finalRecord.baseDigest !== record.baseDigest ||
      canonical(finalRecord.base) !== canonical(record.base)
    ) refused();
    // Authenticate the original secret again as well as its captured session revision.
    await this.options.control.authenticateSession(secret);
    await this.options.control.revalidate(controller);
  }
  async read(secret: string, caseId: string, operatorId: string) {
    const controller = await this.options.control.authenticateSession(secret);
    const record = await this.owned(caseId, operatorId, controller);
    const result = await this.capture(record);
    await this.revalidate(secret, record, controller, result);
    return result;
  }
  async source(
    secret: string,
    caseId: string,
    operatorId: string,
    command: RequestOperatorSourceCommand,
  ): Promise<ArtifactSourceInspection> {
    const controller = await this.options.control.authenticateSession(secret);
    const record = await this.owned(caseId, operatorId, controller);
    if (
      !command ||
      Object.keys(command).sort().join() !== "observedSource,selections" ||
      !Array.isArray(command.selections) || command.selections.length < 1 ||
      command.selections.length > 2
    ) refused();
    const captured = await this.capture(record);
    if (
      canonical(command.observedSource) !== canonical(captured.observedSource)
    ) refused("The observed Request source changed. Read its details again.");
    const sources: ArtifactSourceInspection["sources"] = [];
    const members = command.selections.map((selection) => {
      if (
        !selection ||
        Object.keys(selection).sort().join() !== "expectedDigest,id,kind" ||
        !sourceIdentity(selection.id) ||
        !sourceDigest(selection.expectedDigest) ||
        !["tool-draft", "skill-document"].includes(selection.kind) ||
        selection.kind !== command.selections[0].kind
      ) refused();
      const item = selection.kind === "tool-draft"
        ? captured.tools.find((tool) => tool.id === selection.id)
        : captured.skills.status === "available"
        ? captured.skills.items.find((skill) => skill.id === selection.id)
        : undefined;
      if (!item?.sourceBinding || item.digest !== selection.expectedDigest) {
        refused();
      }
      const binding = item.sourceBinding;
      validateSourceBindingReference(binding);
      if (
        binding.ownerId !== operatorId ||
        binding.localArtifactId !== selection.id ||
        binding.reference.kind !== selection.kind ||
        binding.reference.contentDigest !== selection.expectedDigest
      ) refused();
      return { selection, binding };
    });
    for (const { selection, binding } of members) {
      let content;
      if (selection.kind === "tool-draft") {
        if (!this.options.source.readTool) unavailable();
        content = await this.options.source.readTool!(
          record.base!,
          operatorId,
          selection.id,
        );
        if (await toolDraftDigest(content) !== selection.expectedDigest) {
          unavailable();
        }
      } else {
        const resolver = await this.options.artifactSourcesForScope({
          ...record.scope,
          executionSpaceId: record.executionSpaceId,
          operatorId,
        });
        content = await resolver.resolveSkill({
          ownerId: operatorId,
          localArtifactId: selection.id,
          bindingId: binding.bindingId,
          expectedBinding: binding,
          expectedDigest: selection.expectedDigest,
          reference: binding.reference,
        });
        if (await skillContentDigest(content) !== selection.expectedDigest) {
          unavailable();
        }
      }
      if (
        new TextEncoder().encode(
          typeof content === "string" ? content : JSON.stringify(content),
        ).byteLength > 1_048_576
      ) unavailable();
      sources.push({ binding: structuredClone(binding), content });
    }
    await this.revalidate(secret, record, controller, captured);
    if (sources.length === 2 && !this.options.compare) unavailable();
    return {
      sources,
      ...(sources.length === 2
        ? { patch: this.options.compare!(sources) }
        : {}),
    };
  }
}
