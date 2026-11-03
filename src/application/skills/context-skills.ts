import { executionDigest } from "../../domain/primitives/execution-digest.ts";
import {
  requireSkill,
  requireSkillAuthority,
  requireSkillContent,
  requireSkillUrl,
  type SkillAuthority,
  skillContentDigest,
  skillDigest,
  skillDisplay,
  skillIdentity,
  type SkillLoadReceipt,
  skillMetadata,
  type SkillPermission,
  type SkillReceipt,
} from "../../domain/skills/context-skills.ts";
import type {
  SkillCatalogRecord,
  SkillOperation,
} from "../../domain/skills/records/catalog.ts";
import type {
  SkillGuidance,
  SkillMetadata,
  SkillRecord,
  SkillSource,
} from "../../domain/skills/entities/skill.ts";
import type { ContextSkillsPorts } from "./ports.ts";
import type {
  BundledSkillInstallation,
  SkillInstallation,
  SkillLoadSelection,
  SkillSelection,
} from "./commands/inputs.ts";
import {
  type ArtifactSourceBindingReference,
  validateSourceBindingReference,
} from "../../domain/work/artifacts/source-reference.ts";

/** Installed instructions remain immutable and separate from executable tools.
 * Only an explicit load returns exact instruction text. Installation, listing
 * and unloading retain metadata-only receipts. */
export class ContextSkillsService {
  constructor(readonly ports: ContextSkillsPorts) {}

  async install(
    authority: SkillAuthority,
    input: SkillInstallation,
  ): Promise<SkillReceipt> {
    const auth = structuredClone(authority);
    requireSkillAuthority(auth, "install");
    this.#id(input?.id);
    requireSkill(
      input.expectedDigest === undefined || skillDigest(input.expectedDigest),
      "invalid",
      "expectedDigest must be an exact SHA-256 digest",
    );
    const request = structuredClone(input);
    await this.#current(auth, "install");
    const url = requireSkillUrl(request.url, auth.policy).href;
    const requestDigest = await this.#requestDigest(auth, "install", {
      ...request,
      url,
    });
    const catalog = await this.#catalog(auth);
    const replay = this.#replay(catalog, auth, requestDigest);
    if (replay) {
      await this.#sourceContent(
        catalog.skills.find((skill) => skill.id === replay.skill.id)!,
        auth.policy.ownerId,
      );
      await this.#current(auth, "install");
      return replay;
    }
    this.#installLimit(catalog, request.id, auth);
    const downloaded = await this.ports.download.download(url, auth.policy);
    requireSkill(
      downloaded.requestedUrl === url && downloaded.finalUrl === url,
      "integrity",
      "download provenance does not match the admitted request",
    );
    const byteLength = requireSkillContent(
      downloaded.content,
      auth.policy.maxSkillBytes,
    );
    requireSkill(
      downloaded.byteLength === byteLength,
      "integrity",
      "download byte count does not match its exact text",
    );
    const at = this.#now();
    return await this.#install(
      catalog,
      auth,
      request.id,
      downloaded.content,
      request.expectedDigest,
      {
        kind: "https",
        location: url,
        requestedUrl: url,
        finalUrl: downloaded.finalUrl,
        acquiredAt: at,
        modelVersion: structuredClone(auth.modelVersion),
      },
      requestDigest,
      at,
      false,
    );
  }

  /** The caller must first resolve this seed from an admitted immutable source.
   * This entry grants neither a default seed nor automatic activation. */
  async installBundled(
    authority: SkillAuthority,
    input: BundledSkillInstallation,
  ): Promise<SkillReceipt> {
    const auth = structuredClone(authority);
    requireSkillAuthority(auth, "install");
    this.#id(input?.id);
    requireSkill(
      skillIdentity(input.source) && skillDigest(input.expectedDigest),
      "invalid",
      "bundled instructions need an explicit source and exact digest",
    );
    requireSkillContent(input.content, auth.policy.maxSkillBytes);
    requireSkill(
      input.loaded === undefined || typeof input.loaded === "boolean",
      "invalid",
      "initial loading must be an explicit Boolean",
    );
    if (input.loaded) {
      requireSkillAuthority(auth, "list");
      requireSkillAuthority(auth, "load");
    }
    const request = structuredClone(input);
    await this.#current(auth, "install");
    const requestDigest = await this.#requestDigest(auth, "install", request);
    const catalog = await this.#catalog(auth);
    const replay = this.#replay(catalog, auth, requestDigest);
    if (replay) {
      await this.#sourceContent(
        catalog.skills.find((skill) => skill.id === replay.skill.id)!,
        auth.policy.ownerId,
      );
      await this.#current(auth, "install");
      return replay;
    }
    this.#installLimit(catalog, request.id, auth);
    const at = this.#now();
    return await this.#install(
      catalog,
      auth,
      request.id,
      request.content,
      request.expectedDigest,
      {
        kind: "bundled",
        location: request.source,
        acquiredAt: at,
        modelVersion: structuredClone(auth.modelVersion),
      },
      requestDigest,
      at,
      request.loaded === true,
    );
  }

  async list(authority: SkillAuthority): Promise<SkillMetadata[]> {
    const auth = structuredClone(authority);
    requireSkillAuthority(auth, "list");
    await this.#current(auth, "list");
    const catalog = await this.#catalog(auth);
    await this.#current(auth, "list");
    return catalog.skills.map(skillMetadata);
  }

  async load(
    authority: SkillAuthority,
    input: SkillLoadSelection,
  ): Promise<SkillLoadReceipt> {
    requireSkill(
      (input?.offset === undefined ||
        Number.isSafeInteger(input.offset) && input.offset >= 0) &&
        (input?.limit === undefined ||
          Number.isSafeInteger(input.limit) && input.limit >= 1 &&
            input.limit <= 4096),
      "invalid",
      "skill page offset must be nonnegative and limit must be between 1 and 4096 characters",
    );
    return await this.#select(authority, input, true);
  }

  async unload(
    authority: SkillAuthority,
    input: SkillSelection,
  ): Promise<SkillReceipt> {
    return await this.#select(authority, input, false);
  }

  async guidance(authority: SkillAuthority): Promise<SkillGuidance[]> {
    const auth = structuredClone(authority);
    requireSkillAuthority(auth, "list");
    requireSkillAuthority(auth, "load");
    await this.#current(auth, "load");
    const loaded = (await this.#catalog(auth)).skills.filter((skill) =>
      skill.loaded
    );
    this.#loadedLimits(loaded, auth);
    for (const skill of loaded) {
      skill.content = await this.#sourceContent(skill, auth.policy.ownerId);
    }
    await this.#current(auth, "load");
    return structuredClone(loaded);
  }

  async #select(
    authority: SkillAuthority,
    input: SkillLoadSelection,
    loaded: boolean,
  ): Promise<SkillLoadReceipt> {
    const auth = structuredClone(authority);
    const kind = loaded ? "load" : "unload";
    requireSkillAuthority(auth, kind);
    requireSkillAuthority(auth, "list");
    this.#id(input?.id);
    requireSkill(
      skillDigest(input.expectedDigest),
      "invalid",
      "selection needs the exact installed digest",
    );
    const request = structuredClone(input);
    await this.#current(auth, kind);
    const requestDigest = await this.#requestDigest(auth, kind, request);
    const catalog = await this.#catalog(auth);
    const replay = this.#replay(catalog, auth, requestDigest);
    if (replay) {
      const content = loaded
        ? await this.#sourceContent(
          catalog.skills.find((skill) => skill.id === replay.skill.id)!,
          auth.policy.ownerId,
        )
        : undefined;
      await this.#current(auth, kind);
      return loaded && replay.skill.loaded ? { ...replay, content } : replay;
    }
    const skill = catalog.skills.find((skill) => skill.id === request.id);
    requireSkill(skill, "not-found", "local skill was not found");
    requireSkill(
      skill.digest === request.expectedDigest,
      "conflict",
      "the selected installed version differs from expectedDigest",
    );
    if (loaded && request.offset !== undefined) {
      requireSkill(
        request.offset <= skill.content.length,
        "invalid",
        "skill page offset exceeds the exact instruction length",
      );
    }
    const content = loaded
      ? await this.#sourceContent(skill, auth.policy.ownerId)
      : undefined;
    skill.loaded = loaded;
    const at = this.#now();
    if (loaded) {
      skill.loadedAt = at;
      skill.loadedBy = structuredClone(auth.modelVersion);
      this.#loadedLimits(catalog.skills.filter((skill) => skill.loaded), auth);
    } else {
      delete skill.loadedAt;
      delete skill.loadedBy;
    }
    const receipt = await this.#commit(
      catalog,
      auth,
      skill,
      kind,
      requestDigest,
      at,
    );
    return loaded ? { ...receipt, content } : receipt;
  }

  async #install(
    catalog: SkillCatalogRecord,
    auth: SkillAuthority,
    id: string,
    content: string,
    expectedDigest: string | undefined,
    source: SkillSource,
    requestDigest: string,
    at: string,
    initialLoaded: boolean,
  ): Promise<SkillReceipt> {
    const digest = await skillContentDigest(content);
    requireSkill(
      expectedDigest === undefined || expectedDigest === digest,
      "integrity",
      "downloaded content does not match expectedDigest",
    );
    let skill = catalog.skills.find((skill) => skill.id === id);
    const newSkill = !skill;
    if (skill) {
      requireSkill(
        skill.digest === digest && skill.content === content &&
          skill.source.kind === source.kind &&
          skill.source.location === source.location,
        "conflict",
        "installed identities are immutable; choose another skill identity",
      );
      await this.#sourceContent(skill, auth.policy.ownerId);
    } else {
      const candidate: SkillRecord = {
        id,
        ...skillDisplay(content, id),
        digest,
        byteLength: requireSkillContent(content, auth.policy.maxSkillBytes),
        content,
        source,
        installedAt: at,
        loaded: initialLoaded,
        ...(initialLoaded
          ? { loadedAt: at, loadedBy: structuredClone(auth.modelVersion) }
          : {}),
      };
      if (initialLoaded) {
        this.#loadedLimits([
          ...catalog.skills.filter((entry) => entry.loaded),
          candidate,
        ], auth);
      }
      await this.#current(auth, "install");
      const sources = await this.#sources(auth.policy.ownerId);
      const artifactId = `skill:${await executionDigest({
        ownerId: auth.policy.ownerId,
        id,
      })}`;
      const sourceBinding = await sources.publishSkill({
        artifactId,
        ownerId: auth.policy.ownerId,
        localArtifactId: id,
        invocationId: auth.invocationId,
        baseVersion: auth.modelVersion.repositoryVersion!,
        expectedDigest: digest,
        content,
        proof: { kind: "skill-authority", authority: structuredClone(auth) },
      });
      this.#binding(sourceBinding, auth.policy.ownerId, id, digest);
      requireSkill(
        sourceBinding.invocationId === auth.invocationId &&
          sourceBinding.reference.artifactId === artifactId,
        "integrity",
        "retained skill receipt differs from the installation",
      );
      skill = { ...candidate, sourceBinding: structuredClone(sourceBinding) };
      catalog.skills.push(skill);
    }
    return await this.#commit(
      catalog,
      auth,
      skill,
      "install",
      requestDigest,
      at,
      newSkill && initialLoaded ? true : undefined,
    );
  }

  #installLimit(
    catalog: SkillCatalogRecord,
    id: string,
    auth: SkillAuthority,
  ) {
    requireSkill(
      catalog.skills.some((skill) => skill.id === id) ||
        catalog.skills.length < auth.policy.maxInstalledSkills,
      "limit",
      "installed skill count exceeds the admitted policy",
    );
  }

  #loadedLimits(skills: SkillRecord[], auth: SkillAuthority): void {
    requireSkill(
      skills.length <= auth.policy.maxLoadedSkills &&
        skills.reduce((sum, skill) => sum + skill.content.length, 0) <=
          auth.policy.maxLoadedCharacters &&
        skills.every((skill) => skill.byteLength <= auth.policy.maxSkillBytes),
      "limit",
      "loaded instructions exceed the current admitted policy",
    );
  }

  async #catalog(auth: SkillAuthority): Promise<SkillCatalogRecord> {
    const catalog = await this.ports.store.load(auth.policy.ownerId);
    if (!catalog) {
      return {
        ownerId: auth.policy.ownerId,
        revision: 0,
        skills: [],
        operations: [],
      };
    }
    requireSkill(
      catalog.ownerId === auth.policy.ownerId,
      "integrity",
      "catalog belongs to another owner",
    );
    const copied = structuredClone(catalog);
    for (const skill of copied.skills) {
      requireSkill(
        await skillContentDigest(skill.content) === skill.digest &&
          new TextEncoder().encode(skill.content).length === skill.byteLength,
        "integrity",
        "installed instruction text differs from its digest",
      );
    }
    return copied;
  }

  #replay(
    catalog: SkillCatalogRecord,
    auth: SkillAuthority,
    requestDigest: string,
  ): SkillReceipt | undefined {
    const operation = catalog.operations.find((operation) =>
      operation.callerId === auth.callerId &&
      operation.invocationId === auth.invocationId
    );
    if (!operation) return undefined;
    requireSkill(
      operation.requestDigest === requestDigest,
      "conflict",
      "native invocation was committed with another request",
    );
    const skill = catalog.skills.find((skill) =>
      skill.id === operation.skillId
    );
    requireSkill(skill, "integrity", "operation refers to a missing skill");
    return {
      skill: skillMetadata(skill),
      catalogRevision: catalog.revision,
      replayed: true,
      operation: structuredClone(operation),
    };
  }

  async #commit(
    catalog: SkillCatalogRecord,
    auth: SkillAuthority,
    skill: SkillRecord,
    kind: SkillOperation["kind"],
    requestDigest: string,
    at: string,
    initiallyLoaded?: boolean,
  ): Promise<SkillReceipt> {
    await this.#current(auth, kind);
    const expected = catalog.revision || null;
    catalog.revision++;
    const operation: SkillOperation = {
      kind,
      skillId: skill.id,
      skillDigest: skill.digest,
      callerId: auth.callerId,
      behaviorId: auth.behaviorId,
      invocationId: auth.invocationId,
      requestDigest,
      policyId: auth.policy.id,
      modelVersion: structuredClone(auth.modelVersion),
      at,
      revision: catalog.revision,
      ...(initiallyLoaded === undefined ? {} : { initiallyLoaded }),
    };
    catalog.operations.push(operation);
    await this.ports.store.save(structuredClone(catalog), expected);
    return {
      skill: skillMetadata(skill),
      catalogRevision: catalog.revision,
      replayed: false,
      operation: structuredClone(operation),
    };
  }

  async #current(
    auth: SkillAuthority,
    permission: SkillPermission,
  ): Promise<void> {
    requireSkill(
      typeof this.ports.assertCurrentAuthority === "function",
      "forbidden",
      "the current skill authority resolver is unavailable",
    );
    await this.ports.assertCurrentAuthority(structuredClone(auth), permission);
  }

  async #sources(ownerId: string) {
    requireSkill(
      typeof this.ports.artifactSources === "function",
      "integrity",
      "the exact skill source service is unavailable",
    );
    const sources = await this.ports.artifactSources(ownerId);
    requireSkill(
      sources && typeof sources.publishSkill === "function" &&
        typeof sources.resolveSkill === "function",
      "integrity",
      "the exact skill source service is unavailable",
    );
    return sources;
  }

  #binding(
    value: unknown,
    ownerId: string,
    id: string,
    digest: string,
  ): asserts value is ArtifactSourceBindingReference {
    try {
      validateSourceBindingReference(value);
    } catch {
      requireSkill(
        false,
        "integrity",
        "the installed skill has no valid retained source binding",
      );
    }
    const binding = value as ArtifactSourceBindingReference;
    requireSkill(
      binding.ownerId === ownerId && binding.localArtifactId === id &&
        binding.reference.kind === "skill-document" &&
        binding.reference.contentDigest === digest,
      "integrity",
      "the installed skill source binding differs from its owner or exact content",
    );
  }

  async #sourceContent(skill: SkillRecord, ownerId: string): Promise<string> {
    const binding = skill.sourceBinding;
    this.#binding(binding, ownerId, skill.id, skill.digest);
    const sources = await this.#sources(ownerId);
    const content = await sources.resolveSkill({
      expectedBinding: structuredClone(binding),
      bindingId: binding.bindingId,
      ownerId,
      localArtifactId: skill.id,
      expectedDigest: skill.digest,
      reference: structuredClone(binding.reference),
    });
    requireSkill(
      content === skill.content &&
        await skillContentDigest(content) === skill.digest &&
        new TextEncoder().encode(content).length === skill.byteLength,
      "integrity",
      "retained instruction text differs from the verified installed representation",
    );
    return content;
  }

  async #requestDigest(
    auth: SkillAuthority,
    kind: SkillOperation["kind"],
    input: unknown,
  ) {
    return await executionDigest({
      kind,
      input,
      callerId: auth.callerId,
      behaviorId: auth.behaviorId,
      invocationId: auth.invocationId,
      policyId: auth.policy.id,
      modelVersion: auth.modelVersion,
    });
  }

  #id(id: unknown): asserts id is string {
    requireSkill(
      typeof id === "string" && /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(id) &&
        id.length <= 120,
      "invalid",
      "skill identity must be a bounded lowercase local name",
    );
  }

  #now(): string {
    const at = this.ports.now();
    requireSkill(
      typeof at === "string" && at.length <= 64 &&
        Number.isFinite(Date.parse(at)),
      "invalid",
      "clock must return an explicit timestamp",
    );
    return at;
  }
}
