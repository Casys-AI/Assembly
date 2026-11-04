import type { ReleasePublicationEvent } from "../../../domain/work/records/release-publication.ts";
import type { SpaceController } from "../../../domain/work/request-spaces/space-control.ts";
import type { ReleaseRetentionAuthorization } from "../../../domain/work/records/release-retention.ts";
import type { ReleaseCreationAuthorizationPort } from "./creation-authorization.ts";
import {
  assertReleaseTagBinding,
  assertReleaseTagName,
  assertReleaseTagSelection,
  type ModelTagCreation,
  type ModelTagCreationCommand,
  type ReleaseTagBinding,
  type ReleaseTagSelection,
  type SavedSystemTag,
} from "../../../domain/work/records/release-tags.ts";
import {
  assertSavedCapture,
  assertSavedSourceSelection,
  assertSaveKey,
  savedManifest,
  savedSystemDigest,
  SavedSystemError,
  type SavedSystemMetadata,
  savedSystemMetadata,
  type SavedSystemRecord,
  type SavedSystemScope,
  type SavedSystemSourceSelection,
} from "../../../domain/work/records/saved-systems.ts";
import { type SavedSystemView, savedSystemView } from "./release-view.ts";
import type {
  ModelTagMutationPort,
  ReleaseTagsPort,
  SavedSystemAssetsPort,
  SavedSystemRegistryPort,
  SavedSystemStorePort,
  SavedSystemVisibilityPort,
} from "./ports.ts";

class SupersededPreparation extends Error {
  constructor(readonly record: SavedSystemRecord) {
    super("Release preparation superseded");
  }
}
/** Saving retains a selection; this service has no execution/adoption/Case ports. */
export class SavedSystemsService {
  constructor(
    private readonly store: SavedSystemStorePort,
    private readonly assets: SavedSystemAssetsPort,
    private readonly visibility: SavedSystemVisibilityPort,
    private readonly scope: SavedSystemScope,
    private readonly registry: SavedSystemRegistryPort,
    private readonly creation?: ReleaseCreationAuthorizationPort,
    private readonly tags?: ReleaseTagsPort,
    private readonly tagMutation?: ModelTagMutationPort,
  ) {}

  private async visible(ids: readonly string[] = []): Promise<void> {
    if (!await this.visibility.canRead(this.scope, ids)) {
      throw new SavedSystemError(
        "FORBIDDEN",
        "This release is unavailable in the current source scope.",
      );
    }
  }
  private ids(record: SavedSystemRecord): readonly string[] {
    return record.capture.admission?.operatorIds ?? [];
  }
  private async verifiedView(
    record: SavedSystemRecord,
  ): Promise<SavedSystemView> {
    const view = savedSystemView(record);
    if (record.tag) {
      view.tagAvailability = record.tag.verified && this.tags
        ? await this.tags.inspect(record.tag.binding).catch(() =>
          "unavailable" as const
        )
        : "unavailable";
      if (view.tagAvailability === "unavailable") {
        view.issues = [...new Set([...view.issues, "TAG_UNAVAILABLE"])];
      }
    }
    if (!record.manifest && record.issues.includes("EXACT_ASSET_UNAVAILABLE")) {
      view.assetAvailability = "unavailable";
    }
    if (record.manifest) {
      try {
        if (
          !record.capture.admission ||
          await savedSystemDigest(record.manifest) !== record.digest ||
          await savedSystemDigest(record.capture.source ?? null) !==
            await savedSystemDigest(record.manifest.source ?? null)
        ) throw new Error("manifest");
        await this.assets.inspect(record.manifest);
        view.assetAvailability = "verified";
      } catch {
        view.assetAvailability = "unavailable";
        view.issues = [...new Set([...view.issues, "EXACT_ASSET_UNAVAILABLE"])];
      }
    }
    await this.visible(this.ids(record));
    return view;
  }
  async save(
    input: SavedSystemMetadata & {
      saveKey: string;
      source: SavedSystemSourceSelection;
      tag?: ReleaseTagSelection;
    },
    controller?: SpaceController,
  ): Promise<SavedSystemView> {
    assertSaveKey(input.saveKey);
    assertSavedSourceSelection(input.source);
    const metadata = savedSystemMetadata(input);
    if (input.tag !== undefined) assertReleaseTagSelection(input.tag);
    const tagSelection = input.tag === undefined
      ? undefined
      : structuredClone(input.tag);
    const source = structuredClone(input.source);
    const saveKey = input.saveKey;
    const commandDigest = await savedSystemDigest({
      scope: this.scope,
      saveKey,
      metadata,
      source,
      ...(tagSelection ? { tag: tagSelection } : {}),
    });
    if (this.creation && !controller) {
      throw new SavedSystemError(
        "FORBIDDEN",
        "An authenticated current controller is required for this save command.",
      );
    }
    await this.visible();
    const accepted = await this.store.find?.(this.scope, saveKey);
    if (accepted && accepted.commandDigest !== commandDigest) {
      throw new SavedSystemError(
        "SAVE_KEY_CONFLICT",
        "The save key belongs to a different command.",
      );
    }
    if (!accepted && !tagSelection) {
      throw new SavedSystemError(
        "INVALID_COMMAND",
        "Select a tag for this Release.",
      );
    }
    if (accepted) await this.visible(this.ids(accepted));
    // Completed same-key retry is a read, not a fresh retention grant or recapture.
    if (accepted?.status === "retained") {
      return await this.verifiedView(accepted);
    }
    if (accepted?.status === "conflict") return savedSystemView(accepted);
    let capture = accepted
      ? structuredClone(accepted.capture)
      : await this.registry.resolveSource(source, this.scope);
    assertSavedCapture(capture);
    if (
      !capture.source ||
      capture.source.sourceVersion !== source.sourceVersion ||
      await savedSystemDigest(capture.source.branch) !==
        await savedSystemDigest(source.branch) ||
      await savedSystemDigest(capture.origin) !==
        await savedSystemDigest(this.scope)
    ) {
      throw new SavedSystemError(
        "UNAVAILABLE",
        "The selected model source could not be resolved exactly.",
      );
    }
    let creationAuthorization: ReleaseRetentionAuthorization | undefined;
    if (this.creation) {
      creationAuthorization = await this.creation.authorize({
        scope: this.scope,
        saveKey,
        commandDigest,
        source: capture.source,
      }, controller!);
    }
    const revalidateCreation = async () => {
      if (creationAuthorization) {
        await this.creation!.revalidate(creationAuthorization);
      }
    };
    const rejectUnacceptedCreation = async (error: unknown) => {
      if (
        accepted || !tagSelection || !this.store.rejectTag ||
        !(error instanceof SavedSystemError &&
          (error.code === "TAG_UNAVAILABLE" || error.code === "SOURCE_STALE"))
      ) {
        throw error;
      }
      await this.visible(capture.admission?.operatorIds);
      await revalidateCreation();
      // The store serializes this terminal acknowledgement with all late
      // begin calls. An already accepted same-command row always wins intact.
      const winner = await this.store.rejectTag({
        scope: this.scope,
        saveKey,
        commandDigest,
        metadata,
        capture,
        tag: tagSelection,
        reason: error.code,
        ...(creationAuthorization
          ? { authorization: creationAuthorization }
          : {}),
      });
      await this.visible(this.ids(winner));
      return await this.verifiedView(winner);
    };
    let tag: SavedSystemTag | undefined = accepted?.tag
      ? structuredClone(accepted.tag)
      : undefined;
    if (!accepted && tagSelection) {
      if (!this.tags || !this.store.confirmTag) {
        throw new SavedSystemError(
          "UNAVAILABLE",
          "Release tag publication is unavailable.",
        );
      }
      try {
        if (tagSelection.mode !== "existing") {
          throw new SavedSystemError(
            "TAG_UNAVAILABLE",
            "Create the tag from its exact commit before publishing a Release.",
          );
        }
        const binding = await this.tags.prepare(tagSelection, capture.source);
        assertReleaseTagBinding(binding, source.sourceVersion);
        if (binding.name !== tagSelection.name) {
          throw new SavedSystemError(
            "TAG_UNAVAILABLE",
            "The exact Release tag is unavailable.",
          );
        }
        tag = { selection: tagSelection, binding, verified: false };
      } catch (error) {
        return await rejectUnacceptedCreation(error);
      }
    }
    if (
      accepted &&
      capture.prerequisites.some((entry) => entry.kind === "missing-asset")
    ) {
      await revalidateCreation();
      const selected = accepted.capture.source!;
      capture = this.registry.recoverSource
        ? await this.registry.recoverSource(
          structuredClone(accepted.capture),
          this.scope,
        )
        : await this.registry.resolveSource({
          branch: selected.branch,
          sourceVersion: selected.sourceVersion,
        }, this.scope);
      assertSavedCapture(capture);
      const { admittedHeadVersion: _acceptedHead, ...acceptedSource } =
        selected;
      const { admittedHeadVersion: _observedHead, ...resolvedSource } =
        capture.source ?? {};
      if (
        await savedSystemDigest(resolvedSource) !==
          await savedSystemDigest(acceptedSource) ||
        await savedSystemDigest(capture.origin) !==
          await savedSystemDigest(this.scope)
      ) {
        throw new SavedSystemError(
          "CAPTURE_CONFLICT",
          "Recovery must preserve the accepted exact source.",
        );
      }
      capture.source = structuredClone(selected);
    }
    await this.visible(capture.admission?.operatorIds);
    await revalidateCreation();
    let record: SavedSystemRecord;
    try {
      record = await this.store.begin({
        scope: this.scope,
        saveKey,
        commandDigest,
        metadata,
        capture,
        ...(tag ? { tag } : {}),
        ...(creationAuthorization
          ? { authorization: creationAuthorization }
          : {}),
      });
    } catch (error) {
      return await rejectUnacceptedCreation(error);
    }
    assertSavedCapture(record.capture);
    await this.visible(this.ids(record));
    if (record.status === "retained") return await this.verifiedView(record);
    if (record.status === "conflict") return savedSystemView(record);
    const preparationId = crypto.randomUUID();
    let phase: "tag" | "asset" | "technical" = record.tag ? "tag" : "asset";
    const observe = async (
      event: Omit<ReleasePublicationEvent, "sequence" | "attempt" | "at">,
      start = false,
    ) => {
      if (!this.store.progress) return; // Historical/test ports do not invent logs.
      await this.visible(this.ids(record));
      await revalidateCreation();
      const priorRevision = record.revision;
      const nextSequence = record.publication?.nextSequence ?? 1;
      const next = await this.store.progress({
        id: record.id,
        scope: this.scope,
        expectedRevision: priorRevision,
        runId: preparationId,
        start,
        event,
        outcome: "preparing",
        ...(creationAuthorization
          ? { authorization: creationAuthorization }
          : {}),
      });
      if (
        next.publication?.runId !== preparationId ||
        next.revision !== priorRevision + 1 ||
        next.publication.nextSequence !== nextSequence + 1 ||
        next.publication.outcome !== "preparing"
      ) {
        throw new SupersededPreparation(next);
      }
      record = next;
    };
    try {
      // An explicit same-key retry starts a new fenced run. Earlier work may
      // finish an idempotent byte copy but cannot append/finalize this new run.
      // No worker liveness or failed interruption is inferred from old progress.
      await observe({
        step: record.publication?.attempt ? "recovery" : "preparation",
        status: "started",
      }, true);
      if (record.tag) {
        await observe({ step: "tag-verification", status: "started" });
        if (!this.tags || !this.store.confirmTag) {
          throw new SavedSystemError(
            "TAG_UNAVAILABLE",
            "Release tag publication is unavailable.",
          );
        }
        const selectedTag = structuredClone(record.tag);
        assertReleaseTagBinding(
          selectedTag.binding,
          record.capture.source!.sourceVersion,
        );
        record = await this.tags.runExclusive(async () => {
          await this.visible(this.ids(record));
          await revalidateCreation();
          return await this.store.confirmTag!({
            scope: this.scope,
            id: record.id,
            expectedRevision: record.revision,
            preparationId,
            ...(creationAuthorization
              ? { authorization: creationAuthorization }
              : {}),
            ensure: (signal) =>
              this.tags!.ensure(
                selectedTag.verified
                  ? { ...selectedTag.selection, mode: "existing" }
                  : selectedTag.selection,
                selectedTag.binding,
                signal,
              ),
          });
        });
        if (record.status === "retained") {
          return await this.verifiedView(record);
        }
        if (
          !record.tag?.verified ||
          await this.tags.inspect(record.tag.binding) !== "verified"
        ) {
          throw new SavedSystemError(
            "TAG_UNAVAILABLE",
            "The exact Release tag is unavailable.",
          );
        }
      }
      if (record.tag) {
        await observe({ step: "tag-verification", status: "completed" });
      }
      phase = "asset";
      const admission = record.capture.admission;
      if (!admission) throw new Error("Admission selection unavailable");
      const operators = [];
      for (const [member, operatorId] of admission.operatorIds.entries()) {
        await observe({ step: "asset-retention", status: "started", member });
        const operator = record.capture.operators.find((entry) =>
          entry.operatorId === operatorId
        );
        if (!operator) throw new Error("Admitted state unavailable");
        await this.visible(admission.operatorIds);
        await revalidateCreation();
        operators.push(await this.assets.retain(operator));
        await revalidateCreation();
        await this.visible(admission.operatorIds);
        await observe({ step: "asset-retention", status: "completed", member });
      }
      const prerequisites = [
        ...record.capture.prerequisites.filter((entry) =>
          !entry.operatorId || admission.operatorIds.includes(entry.operatorId)
        ),
        ...admission.prerequisites,
      ];
      const manifest = savedManifest({
        origin: record.capture.origin,
        source: record.capture.source,
        registeredOperatorIds: record.capture.registeredOperatorIds,
        operators,
        prerequisites,
      });
      const incomplete = !operators.length ||
        prerequisites.some((entry) => entry.kind !== "host-runtime");
      await this.visible(admission.operatorIds);
      await revalidateCreation();
      phase = "technical";
      await observe({ step: "manifest-finalization", status: "started" });
      record = await this.store.finalize({
        id: record.id,
        scope: this.scope,
        expectedRevision: record.revision,
        preparationId,
        capture: record.capture,
        ...(creationAuthorization
          ? { authorization: creationAuthorization }
          : {}),
        manifest,
        digest: await savedSystemDigest(manifest),
        status: incomplete ? "incomplete" : "retained",
        issues: incomplete ? ["PREREQUISITES_REQUIRED"] : [],
      });
    } catch (error) {
      if (error instanceof SupersededPreparation) {
        return await this.verifiedView(error.record);
      }
      if (
        error instanceof SavedSystemError &&
        (error.code === "FORBIDDEN" || error.code === "CAPTURE_CONFLICT")
      ) throw error;
      await revalidateCreation();
      record = await this.store.markIncomplete({
        id: record.id,
        scope: this.scope,
        expectedRevision: record.revision,
        preparationId,
        failure: phase,
        issues: [
          phase === "tag" ||
            error instanceof SavedSystemError &&
              error.code === "TAG_UNAVAILABLE"
            ? "TAG_UNAVAILABLE"
            : phase === "technical"
            ? "PUBLICATION_FAILED"
            : "EXACT_ASSET_UNAVAILABLE",
        ],
        ...(creationAuthorization
          ? { authorization: creationAuthorization }
          : {}),
      });
    }
    await this.visible(this.ids(record));
    // A CAS may return another attempt's repaired capture and manifest. Only
    // inspection of that exact returned winner establishes its availability.
    return await this.verifiedView(record);
  }
  /** Independent tag creation: no SavedSystem intention or asset retention.
   * Request selection deliberately keeps the current admitted-head boundary. */
  async createTag(
    command: ModelTagCreationCommand,
    controller: SpaceController,
  ): Promise<ModelTagCreation> {
    assertSavedSourceSelection(command.source);
    assertReleaseTagName(command.name);
    const selected = structuredClone(command);
    await this.visible();
    if (!controller || !this.creation || !this.tags || !this.tagMutation) {
      throw new SavedSystemError(
        "FORBIDDEN",
        "Current exact tag creation authority is unavailable.",
      );
    }
    const capture = await this.resolveSelection(selected.source);
    const source = capture.source!;
    const commandDigest = await savedSystemDigest({
      operation: "create-model-tag",
      scope: this.scope,
      ...selected,
    });
    const authorization = await this.creation.authorize({
      scope: this.scope,
      saveKey: `tag_${commandDigest}`,
      commandDigest,
      source,
    }, controller);
    const selection = { mode: "create" as const, name: selected.name };
    const binding = await this.tags.runExclusive(async () => {
      await this.creation!.revalidate(authorization);
      let expected: ReleaseTagBinding;
      try {
        expected = await this.tags!.prepare(selection, source);
      } catch (error) {
        if (
          !(error instanceof SavedSystemError &&
            error.code === "TAG_UNAVAILABLE")
        ) throw error;
        // The same direct lightweight ref may already exist after reply loss.
        // An annotation at the same commit is a different raw object and refuses.
        expected = await this.tags!.prepare({
          mode: "existing",
          name: selected.name,
        }, source);
      }
      assertReleaseTagBinding(expected, source.sourceVersion);
      if (
        expected.name !== selected.name ||
        expected.refOid !== expected.commitOid
      ) {
        throw new SavedSystemError(
          "TAG_UNAVAILABLE",
          "The exact standalone tag is unavailable.",
        );
      }
      await this.tagMutation!.run(
        authorization,
        (signal) => this.tags!.ensure(selection, expected, signal),
      );
      return expected;
    });
    await this.visible(capture.admission?.operatorIds);
    await this.creation.revalidate(authorization);
    return structuredClone({ source, tag: binding });
  }
  private async resolveSelection(selection: SavedSystemSourceSelection) {
    const capture = await this.registry.resolveSource(selection, this.scope);
    assertSavedCapture(capture);
    if (
      !capture.source ||
      capture.source.sourceVersion !== selection.sourceVersion ||
      await savedSystemDigest(capture.source.branch) !==
        await savedSystemDigest(selection.branch) ||
      await savedSystemDigest(capture.origin) !==
        await savedSystemDigest(this.scope)
    ) {
      throw new SavedSystemError(
        "UNAVAILABLE",
        "The exact model source is unavailable.",
      );
    }
    await this.visible(capture.admission?.operatorIds);
    return capture;
  }
  /** Authorized exact-source read; never prepares or creates a tag. */
  async listTags(selection: SavedSystemSourceSelection) {
    assertSavedSourceSelection(selection);
    await this.visible();
    if (!this.tags || !this.store.availableTags) {
      throw new SavedSystemError(
        "UNAVAILABLE",
        "Release tag selection is unavailable.",
      );
    }
    const capture = await this.resolveSelection(selection);
    const tags = await this.tags.list(capture.source!);
    for (const binding of tags) {
      assertReleaseTagBinding(binding, selection.sourceVersion);
    }
    const available = new Set(
      await this.store.availableTags(
        this.scope,
        capture.source!.repositoryId,
        tags.map((binding) => binding.name),
      ),
    );
    await this.visible(capture.admission?.operatorIds);
    return { tags: tags.filter((binding) => available.has(binding.name)) };
  }
  async list(): Promise<SavedSystemView[]> {
    await this.visible();
    const records = await this.store.list(this.scope);
    const result: SavedSystemView[] = [];
    for (const record of records) {
      if (await this.visibility.canRead(this.scope, this.ids(record))) {
        result.push(savedSystemView(record));
      }
    }
    await this.visible();
    for (
      const record of records.filter((entry) =>
        result.some((view) => view.id === entry.id)
      )
    ) await this.visible(this.ids(record));
    // Catalogue status is retention history. Availability is deliberately
    // unchecked here; only an explicit selected inspect/retry reads its assets.
    return result;
  }
  async readTool(
    id: string,
    operatorId: string,
    candidateId: string,
  ): Promise<
    import("../../../domain/work/records/artifact-source-inspection.ts").ArtifactSourceInspection
  > {
    await this.visible();
    const record = await this.store.get(this.scope, id);
    if (
      !record?.manifest ||
      !record.capture.admission?.operatorIds.includes(operatorId) ||
      await savedSystemDigest(record.manifest) !== record.digest
    ) {
      throw new SavedSystemError(
        "UNAVAILABLE",
        "The release source is unavailable.",
      );
    }
    const tool = record.manifest.operators.find((entry) =>
      entry.operatorId === operatorId
    )?.tools.find((entry) => entry.candidateId === candidateId);
    if (!tool?.sourceBinding) {
      throw new SavedSystemError(
        "UNAVAILABLE",
        "The release source is unavailable.",
      );
    }
    await this.visible(this.ids(record));
    const content = await this.assets.readTool(
      record.manifest,
      operatorId,
      candidateId,
    );
    await this.visible(this.ids(record));
    return {
      sources: [{ binding: structuredClone(tool.sourceBinding), content }],
    };
  }
  async inspect(id: string): Promise<SavedSystemView> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
      throw new SavedSystemError(
        "UNAVAILABLE",
        "The release is unavailable.",
      );
    }
    await this.visible();
    const record = await this.store.get(this.scope, id);
    if (!record) {
      throw new SavedSystemError(
        "UNAVAILABLE",
        "The release is unavailable.",
      );
    }
    await this.visible(this.ids(record));
    return await this.verifiedView(record);
  }
}
