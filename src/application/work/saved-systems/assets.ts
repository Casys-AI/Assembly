import type { RequestReleaseProvenancePort } from "./request-release-ports.ts";
import type {
  SavedSystemAssetsPort,
  SavedSystemRegistryPort,
} from "./ports.ts";
import {
  assertSavedSourceSelection,
  type SavedOperatorSelection,
  type SavedSystemCapture,
  savedSystemDigest,
  SavedSystemError,
  type SavedSystemManifest,
  type SavedSystemScope,
  type SavedSystemSourceEvidence,
  type SavedSystemSourceSelection,
} from "../../../domain/work/saved-systems.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { toolDraftDigest } from "../artifacts/catalog.ts";
import type { SourceExecutablesCompilationPort } from "../../model/source-compilation.ts";
import type { BuildDescriptor } from "../../../domain/model/value-objects/build.ts";
import type { ModelBuildVaultPort } from "../../model/builds/ports/out/build-vault.port.ts";
import type { ModelBuildStore } from "../../model/builds/ports/out/build-store.port.ts";
import { selectValidatedSourceExecutable } from "../../../domain/model/records/source-executables.ts";
import { discoverConversationUnits } from "../../../domain/model/records/source-identity.ts";
import { type SourceRevision } from "../../../domain/model/records/source-revision.ts";
import type { SavedOperatorManifest } from "../../../domain/work/saved-systems.ts";
import { MAX_OPERATOR_UNITS } from "../../../domain/work/records/conversations.ts";

export interface SavedSystemSourceReader {
  readonly repositoryId: string;
  at(version: string): Promise<SourceRevision & { sourceDigest: string }>;
  descriptorAt(version: string): Promise<BuildDescriptor | null>;
  admittedMainSource(
    version: string,
  ): Promise<{ headVersion: string; sourceDigest: string }>;
}

/** Historical inspection only uses openReadOnly().at; neither the compiler nor
 * an invoker is exposed. Retention writes refs/vault bytes through narrow ports. */
export class SavedSystemAssets
  implements SavedSystemAssetsPort, SavedSystemRegistryPort {
  constructor(
    private readonly options: {
      repositoryId: string;
      projectId: string;
      sourceScopeId: string;
      primaryOperatorId: string;
      openSourceReader(): Promise<SavedSystemSourceReader>;
      compilation: SourceExecutablesCompilationPort;
      vault: ModelBuildVaultPort;
      cache: Pick<ModelBuildStore, "get">;
      retainCommit(version: string): Promise<string>;
      findTool(
        operatorId: string,
        entry: {
          candidateId: string;
          digest: string;
          name: string;
          kind: import("../../../domain/shared-kernel/tool-kind.ts").ToolKind;
        },
      ): Promise<SavedOperatorSelection["tools"][number] | null>;
      /** Actual production composition supplies current source visibility. */
      canReadScope?(scope: SavedSystemScope): Promise<boolean>;
      requestProvenance?: RequestReleaseProvenancePort;
      /** Current target binding visibility, supplied by composition. */
      resolveTool(
        selection: Pick<
          SavedOperatorSelection["tools"][number],
          "candidateId" | "digest" | "sourceBinding"
        >,
        operatorId: string,
      ): Promise<unknown>;
    },
  ) {}

  private reader() {
    return this.options.openSourceReader();
  }
  private projectRevision(revision: SourceRevision) {
    let models:
      | ReturnType<SourceExecutablesCompilationPort["compile"]>
      | undefined;
    return {
      units: discoverConversationUnits(revision, this.options.projectId),
      models: () =>
        models ??= this.options.compilation.compile(
          revision,
          this.options.projectId,
        ),
    };
  }
  private async loadExactRevision(version: string) {
    const reader = await this.reader();
    const revision = await reader.at(version);
    const projected = this.projectRevision(revision);
    let descriptor: ReturnType<typeof reader.descriptorAt> | undefined;
    return {
      version,
      reader,
      revision,
      projected,
      descriptor: () => descriptor ??= reader.descriptorAt(version),
    };
  }
  private async exact(
    selection: Pick<
      SavedOperatorSelection,
      | "operatorId"
      | "modelDigest"
      | "repositoryVersion"
      | "settingsDigest"
      | "nativeSystemId"
      | "systemQualifiedName"
    >,
    loaded?: Awaited<ReturnType<SavedSystemAssets["loadExactRevision"]>>,
  ) {
    const source = loaded ??
      await this.loadExactRevision(selection.repositoryVersion);
    const { revision, projected } = source;
    const matches = projected.units
      .filter((entry) => entry.identity.builderId === selection.operatorId);
    const unit = matches[0];
    if (
      matches.length !== 1 || !unit ||
      selection.nativeSystemId &&
        unit.identity.systemId !== selection.nativeSystemId ||
      selection.systemQualifiedName &&
        unit.systemQualifiedName !== selection.systemQualifiedName
    ) throw new Error("Exact operator source unavailable");
    const model = structuredClone(selectValidatedSourceExecutable(
      await projected.models(),
      unit.systemQualifiedName,
    ));
    const settingsDigest = await savedSystemDigest({
      configuration: model.configuration,
      flows: model.flows,
      caseFlows: model.caseFlows ?? null,
      policy: model.policy,
    });
    if (
      model.version.digest !== selection.modelDigest ||
      model.version.repositoryVersion !== selection.repositoryVersion ||
      settingsDigest !== selection.settingsDigest
    ) throw new Error("Exact admitted source differs");
    const build = await source.descriptor();
    if (
      !build || build.sourceDigest !== revision.sourceDigest ||
      build.repositoryId !== this.options.repositoryId
    ) throw new Error("Exact build descriptor unavailable");
    return { revision, build, model };
  }
  private async visible(scope: SavedSystemScope): Promise<void> {
    if (this.options.canReadScope && !await this.options.canReadScope(scope)) {
      throw new SavedSystemError(
        "FORBIDDEN",
        "Release source visibility is unavailable.",
      );
    }
  }
  async resolveSource(
    selection: SavedSystemSourceSelection,
    scope: SavedSystemScope,
  ): Promise<SavedSystemCapture> {
    assertSavedSourceSelection(selection);
    if (selection.branch.kind === "case") {
      // Missing composition is a terminal refusal, never a Main lookup.
      if (
        !("requestProvenance" in this.options) ||
        !this.options.requestProvenance
      ) {
        throw new SavedSystemError(
          "UNAVAILABLE",
          "This Case branch is not available on this host.",
        );
      }
      const source = await this.options.requestProvenance.capture(
        selection,
        scope,
      );
      const capture = await this.captureExact(source, scope);
      if (source.requestAdmission) {
        await this.options.requestProvenance.assertAccepted(capture, scope);
      }
      return capture;
    }
    if (scope.executionSpaceId !== "main") {
      throw new SavedSystemError(
        "UNAVAILABLE",
        "Main source cannot be captured as a Request origin.",
      );
    }
    await this.visible(scope);
    const reader = await this.reader();
    let evidence: { headVersion: string; sourceDigest: string };
    try {
      evidence = await reader.admittedMainSource(selection.sourceVersion);
    } catch {
      throw new SavedSystemError(
        "UNAVAILABLE",
        "The selected version is unavailable or is not admitted on main. Reopen the model and select an admitted version.",
      );
    }
    return await this.captureExact({
      ...structuredClone(selection),
      repositoryId: reader.repositoryId,
      branchRef: "refs/heads/admitted",
      admittedHeadVersion: evidence.headVersion,
      sourceDigest: evidence.sourceDigest,
    }, scope);
  }
  async recoverSource(
    accepted: SavedSystemCapture,
    scope: SavedSystemScope,
  ): Promise<SavedSystemCapture> {
    if (!accepted.source || canonical(accepted.origin) !== canonical(scope)) {
      throw new SavedSystemError(
        "UNAVAILABLE",
        "The accepted Release source is unavailable.",
      );
    }
    await this.visible(scope);
    if (scope.executionSpaceId === "main") {
      if (
        accepted.source.branch.kind !== "main" ||
        accepted.source.branchRef !== "refs/heads/admitted"
      ) {
        throw new SavedSystemError(
          "UNAVAILABLE",
          "The accepted Main provenance is unavailable.",
        );
      }
    } else {
      if (!this.options.requestProvenance) {
        throw new SavedSystemError(
          "UNAVAILABLE",
          "The accepted Request provenance is unavailable.",
        );
      }
      await this.options.requestProvenance.assertAccepted(accepted, scope);
    }
    // Only the durable accepted source enters this path; never choose today's head.
    return await this.captureExact(structuredClone(accepted.source), scope);
  }
  private async captureExact(
    source: SavedSystemSourceEvidence,
    scope: SavedSystemScope,
  ): Promise<SavedSystemCapture> {
    await this.visible(scope);
    const reader = await this.reader();
    const revision = await reader.at(source.sourceVersion);
    if (
      reader.repositoryId !== source.repositoryId ||
      revision.sourceDigest !== source.sourceDigest
    ) {
      throw new SavedSystemError(
        "UNAVAILABLE",
        "The exact accepted source differs.",
      );
    }
    const projection = this.projectRevision(revision);
    const units = projection.units;
    if (
      !units.length || units.length > MAX_OPERATOR_UNITS ||
      new Set(units.map((unit) => unit.identity.builderId)).size !==
        units.length
    ) {
      throw new SavedSystemError(
        "UNAVAILABLE",
        "The selected whole-system source is unavailable.",
      );
    }
    const operators: SavedOperatorSelection[] = [];
    const prerequisites: SavedSystemCapture["prerequisites"] = [];
    const projected = await projection.models();
    for (const unit of units) {
      const model = structuredClone(selectValidatedSourceExecutable(
        projected,
        unit.systemQualifiedName,
      ));
      const operatorId = unit.identity.builderId;
      const tools: SavedOperatorSelection["tools"] = [];
      for (
        const entry of model.catalog.filter((tool) => tool.status === "active")
      ) {
        const tool = await this.options.findTool(operatorId, entry);
        if (!tool) {
          prerequisites.push({
            kind: "missing-asset",
            operatorId,
            code: "SOURCE_TOOL_UNAVAILABLE",
          });
        } else tools.push(tool);
      }
      if (model.initialSkills?.length) {
        prerequisites.push({
          kind: "skill",
          operatorId,
          code: "SKILL_DEPENDENCY",
        });
      }
      // These are host prerequisites, not evidence of any transferable private
      // binding or execution grant. Public source selection copies neither.
      for (
        const code of [
          "FRESH_CACHE_AND_ENVIRONMENT",
          "NO_REMOTE_OR_NPM_RESOLUTION",
          "DENIED_IMPORTS",
          "MACOS_DENY_DEFAULT_SANDBOX",
          "FRESH_PRIVATE_RESOURCE_BINDINGS",
        ]
      ) {
        prerequisites.push({ kind: "host-runtime", operatorId, code });
      }
      operators.push({
        operatorId,
        nativeSystemId: model.identity.systemId,
        systemQualifiedName: unit.systemQualifiedName,
        modelDigest: model.version.digest,
        repositoryVersion: source.sourceVersion,
        settingsDigest: await savedSystemDigest({
          configuration: model.configuration,
          flows: model.flows,
          caseFlows: model.caseFlows ?? null,
          policy: model.policy,
        }),
        tools,
      });
    }
    const operatorIds = operators.map((operator) => operator.operatorId).sort();
    await this.visible(scope);
    return {
      origin: { ...scope },
      source: structuredClone(source),
      registeredOperatorIds: operatorIds,
      operators,
      admission: { operatorIds, prerequisites: [] },
      prerequisites,
    };
  }
  private exactTool(
    model: Awaited<ReturnType<SavedSystemAssets["exact"]>>["model"],
    tool: { candidateId: string; digest: string },
  ): boolean {
    const entries = model.catalog.filter((entry) =>
      entry.candidateId === tool.candidateId && entry.digest === tool.digest &&
      entry.status === "active"
    );
    return entries.length === 1 &&
      model.contracts.filter((contract) =>
          contract.nativeId === entries[0]!.contractId &&
          contract.kind === entries[0]!.kind
        ).length === 1;
  }
  async retain(
    selection: SavedOperatorSelection,
  ): Promise<SavedOperatorManifest> {
    const { revision, build, model } = await this.exact(selection);
    // A verified cache hit becomes retained bytes before any catalogue success.
    const bytes = await this.options.vault.getVerified(build.artifactDigest) ??
      await this.options.cache.get(build.artifactDigest);
    await this.options.vault.putVerified(build.artifactDigest, bytes);
    if (!(await this.options.vault.getVerified(build.artifactDigest))) {
      throw new Error("Exact build retention failed");
    }
    await this.options.retainCommit(selection.repositoryVersion);
    const tools: SavedOperatorManifest["tools"] = [];
    for (const tool of selection.tools) {
      if (
        !tool.sourceBinding ||
        tool.sourceBinding.ownerId !== selection.operatorId ||
        tool.sourceBinding.localArtifactId !== tool.candidateId ||
        tool.sourceBinding.reference.contentDigest !== tool.digest ||
        await toolDraftDigest(tool.draft) !== tool.digest ||
        !this.exactTool(model, tool)
      ) throw new Error("Exact admitted tool unavailable");
      const content = await this.options.resolveTool(
        tool,
        selection.operatorId,
      );
      if (canonical(content) !== canonical(tool.draft)) {
        throw new Error("Exact tool bytes differ");
      }
      await this.options.retainCommit(
        `commit:${tool.sourceBinding.reference.commitOid}`,
      );
      tools.push({
        candidateId: tool.candidateId,
        digest: tool.digest,
        sourceBinding: structuredClone(tool.sourceBinding),
      });
    }
    return {
      operatorId: selection.operatorId,
      ...(selection.nativeSystemId
        ? { nativeSystemId: selection.nativeSystemId }
        : {}),
      ...(selection.systemQualifiedName
        ? { systemQualifiedName: selection.systemQualifiedName }
        : {}),
      ...(selection.stateRevision !== undefined
        ? { stateRevision: selection.stateRevision }
        : {}),
      modelDigest: selection.modelDigest,
      repositoryVersion: selection.repositoryVersion,
      settingsDigest: selection.settingsDigest,
      ...(selection.runtime
        ? { runtime: structuredClone(selection.runtime) }
        : {}),
      sourceDigest: revision.sourceDigest,
      build,
      tools,
    };
  }
  async readTool(
    manifest: SavedSystemManifest,
    operatorId: string,
    candidateId: string,
  ) {
    await this.visible(manifest.origin);
    if (manifest.origin.executionSpaceId !== "main") {
      if (!this.options.requestProvenance) {
        throw new SavedSystemError(
          "UNAVAILABLE",
          "Request Release provenance is unavailable.",
        );
      }
      await this.options.requestProvenance.assertManifest(manifest);
    }
    const operator = manifest.operators.find((entry) =>
      entry.operatorId === operatorId
    );
    const tool = operator?.tools.find((entry) =>
      entry.candidateId === candidateId
    );
    if (!operator || !tool?.sourceBinding) {
      throw new Error("Saved tool unavailable");
    }
    const { model } = await this.exact(operator);
    if (!this.exactTool(model, tool)) {
      throw new Error("Saved tool occurrence differs");
    }
    const content = await this.options.resolveTool(tool, operatorId);
    const draft = content as Parameters<typeof toolDraftDigest>[0];
    if (await toolDraftDigest(draft) !== tool.digest) {
      throw new Error("Saved tool bytes differ");
    }
    await this.visible(manifest.origin);
    return draft;
  }
  async inspect(manifest: SavedSystemManifest): Promise<void> {
    if (manifest.origin.executionSpaceId !== "main") {
      if (!this.options.requestProvenance) {
        throw new SavedSystemError(
          "UNAVAILABLE",
          "Request Release provenance is unavailable.",
        );
      }
      await this.options.requestProvenance.assertManifest(manifest);
      return;
    }
    await this.inspectModels(manifest);
  }
  async inspectModels(
    manifest: SavedSystemManifest,
  ): Promise<
    readonly import("../../../domain/model/execution/executable-model.ts").ExecutableModel[]
  > {
    await this.visible(manifest.origin);
    // One pin, owned only by this inspection. Live visibility, vault and tool
    // checks below are never memoized; another pin replaces this snapshot.
    let retained:
      | Awaited<ReturnType<SavedSystemAssets["loadExactRevision"]>>
      | undefined;
    const load = async (version: string) => {
      if (retained?.version !== version) {
        retained = undefined;
        retained = await this.loadExactRevision(version);
      }
      return retained;
    };
    if (manifest.source?.requestAdmission) {
      const { reader, revision, projected } = await load(
        manifest.source.sourceVersion,
      );
      const units = projected.units;
      const ids = units.map((unit) => unit.identity.builderId).sort();
      if (
        reader.repositoryId !== manifest.source.repositoryId ||
        revision.sourceDigest !== manifest.source.sourceDigest ||
        !ids.length || ids.length > MAX_OPERATOR_UNITS ||
        new Set(ids).size !== ids.length ||
        canonical(ids) !==
          canonical([...manifest.registeredOperatorIds].sort()) ||
        canonical(ids) !== canonical(
            manifest.operators.map((operator) => operator.operatorId).sort(),
          )
      ) {
        throw new Error("Retained whole-system source membership differs");
      }
    }
    const models:
      import("../../../domain/model/execution/executable-model.ts").ExecutableModel[] =
        [];
    for (const operator of manifest.operators) {
      const { revision, build, model } = await this.exact(
        operator,
        await load(operator.repositoryVersion),
      );
      if (
        revision.sourceDigest !== operator.sourceDigest ||
        canonical(build) !== canonical(operator.build) ||
        !(await this.options.vault.getVerified(build.artifactDigest))
      ) throw new Error("Retained build differs");
      models.push(model);
      for (const tool of operator.tools) {
        const binding = tool.sourceBinding;
        if (!binding || !this.exactTool(model, tool)) {
          throw new Error("Retained tool selection differs");
        }
        // Binding resolution checks today's source visibility; never invoke it.
        const content = await this.options.resolveTool(
          tool,
          operator.operatorId,
        );
        if (
          await toolDraftDigest(
            content as Parameters<typeof toolDraftDigest>[0],
          ) !== tool.digest
        ) throw new Error("Retained tool bytes differ");
      }
    }
    await this.visible(manifest.origin);
    return models;
  }
}
