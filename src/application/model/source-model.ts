import { projectSourceGraph } from "../../domain/model/projections/source-graph.ts";
import {
  applyEdits,
  assertSourceSplices,
  incarnationInventory,
  verifyEdits,
} from "./editing/host-writer.ts";
import type { SourceModelServices } from "./source-model-services.ts";
import { matchesExactRevision } from "../../domain/shared-kernel/revision-id.ts";
import {
  assertReinsertedMembers,
  declareReviewer,
  type RemovedMember,
  reviewerPromotionEdits,
} from "./migrations/reviewer.ts";
import {
  DEFAULT_SYSTEM,
  discoverConversationUnits,
  sourceModelIdentity,
} from "../../domain/model/records/source-identity.ts";
import {
  id,
  literal,
  one,
  owned,
  reference,
  references,
} from "../../domain/model/value-objects/source-elements.ts";
import { candidateName } from "../../domain/work/value-objects/candidate-name.ts";
import type { SourceModelOptions } from "./source-model-options.ts";
import type { SourceRepository } from "./source-repository.ts";
import type { SourceRevision } from "../../domain/model/records/source-revision.ts";
import { assert } from "../../domain/primitives/assert.ts";
import {
  canonicalProductName,
  productNameInModel,
  productSourceForModel,
  sameProductName,
} from "../../domain/model/sysml-product-names.ts";

import { DYNAMIC_MANDATE_SOURCE } from "../../domain/governance/mandates.ts";
import { assertCandidateDelegationReceipt } from "../../domain/governance/policies/tool-admission-policy.ts";
import { verifyPublicationReadback } from "../../domain/model/publication/compatibility.ts";
import { canonical } from "../../domain/primitives/canonical-json.ts";
import { buildOperationJournal } from "../../domain/model/editing/write-command.ts";
import { parseModelRevisionRef } from "../../domain/model/value-objects/element-ref.ts";
import {
  buildActivationCommand,
  buildApprovedChangeCommand,
} from "./publication/write-queue.ts";
import type { ModelWriteSubmissionPort } from "./publication/submission.ts";
import {
  isTeamOperatorSpec,
  mainExecutionSpace,
} from "../../domain/governance/operator-authority.ts";
import {
  assertCreationWithinPolicy,
  assertOperatorCreationCapacity,
  creationPreviewExercise,
  exactChildCreationGrant,
  mainCreationScope,
  matchesTeamProvision,
  requestedCreationPolicyId,
} from "../../domain/governance/policies/operator-creation-policy.ts";
import { compareModelSources } from "./revisions/source-diff.ts";
import {
  OperatorAuthorityError,
  type PreparedChangeDiff,
} from "../../domain/governance/operator-authority.ts";
import {
  HostEditError,
  type HostEditRequest,
  hostEditTarget,
  spelling,
} from "../../domain/model/editing/host-edit.ts";
import {
  CandidateActivationError,
  requireActivation,
} from "../../domain/work/policies/candidate-activation.ts";
import {
  APPROVAL_RECEIPT_RESERVE_BYTES,
  type ApprovedChangePublication,
  assertPublicationMatches,
  assertPublicationSize,
  type CandidateActivationPublication,
  type ChangePublication,
  changePublication,
  ChangePublicationError,
  publicationFailure,
  publicationSourceVersion,
  type SourcePublication,
} from "../../domain/model/publication/change.ts";

import {
  assertApprovable,
  assertChangeAuthorityReceipt,
} from "../../domain/governance/policies/change-approvability.ts";
import { executionDigest } from "../../domain/primitives/execution-digest.ts";
import {
  type AuthorityExercise,
  AuthorityInvariantError,
  exerciseOwnerAuthority,
} from "../../domain/governance/authority.ts";
import type { ModelPort } from "../work/runtime/ports.ts";
import type { ModelToolingPort } from "./tooling.ts";
import type { ModelEditRequest } from "../../domain/model/editing/tooling.ts";
import type { ModelEditOperation } from "../../domain/governance/policies/model-edit-policy.ts";
import type { ModelDelegationRequest } from "../../domain/governance/records/model-delegation-request.ts";

import { modelSourceDigest } from "../../domain/model/value-objects/sources.ts";
import {
  modelToolingTarget,
  resolveModelEdits,
} from "../../domain/model/editing/source-index.ts";
import type { Candidate, ModelBinding } from "../../domain/work/candidates.ts";
import type {
  ModelRevisionProposal,
  ModelRevisionRequest,
  ModelSourceProposalStatus,
  ModelSourceRevision,
} from "../../domain/work/dialogue.ts";
import type { ModelIdentity } from "../../domain/shared-kernel/model-identity.ts";
import type { PendingChange } from "../../domain/governance/records/pending-change.ts";
import type { SystemConfiguration } from "../../domain/governance/records/system-configuration.ts";
import { sourceLiterals } from "../../domain/model/projections/source-facts.ts";
import { isPrimaryDesigner } from "../../domain/model/records/primary-designer.ts";

import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";
import { validateNetworkScope } from "../../domain/governance/policies/network-policy.ts";
import { PinnedExecutableCache } from "../support/pinned-executable-cache.ts";

type Element = Record<string, unknown>;
type Sources = Record<string, string>;

/** Check the immutable published revision, including when the updater was skipped. */
async function assertPublishedEdits(
  revision: SourceRevision,
  receipt: SourcePublication,
  systemId: string,
): Promise<void> {
  try {
    await verifyPublicationReadback(receipt.edits, {
      scalarTarget: (edit) => {
        let attribute = revision.elements.find((element) =>
          element["@id"] === edit.owner
        );
        assert(attribute, `Missing publication owner: ${edit.owner}`);
        for (const name of edit.name.split("::")) {
          attribute = owned(revision, id(attribute), name);
        }
        const target = modelToolingTarget(revision, id(attribute));
        return {
          id: id(attribute),
          qualifiedName: target.qualifiedName,
          metaclass: target.metaclass,
          preimage: "", // Historical scalar receipts have no preparation preimage.
        };
      },
      verify: (edits) => verifyEdits(revision, edits),
    });
  } catch (error) {
    throw new ChangePublicationError("PUBLICATION_RECEIPT_MISMATCH", {
      changeId: receipt.changeId,
      systemId,
    }, error instanceof Error ? error.message : String(error));
  }
}

/** Source-authoritative model orchestration. Provider data is read from an admitted
 * immutable Git revision; writes publish complete SysML source sets. */
export class SourceModel implements ModelPort {
  readonly repository: SourceRepository;
  readonly #services: SourceModelServices;
  readonly proposeEdit: ModelPort["proposeEdit"];
  readonly #projectId: string;
  #systemQualifiedName: string;
  readonly #seed?: Sources;
  readonly #recordedDelegation?: { exercise: AuthorityExercise };
  readonly #creationScope?: SourceModelOptions["creationScope"];
  readonly #tooling: ModelToolingPort;
  readonly #writer?: ModelWriteSubmissionPort;
  readonly #executablePins = new PinnedExecutableCache<{
    identity: ModelIdentity;
    model: ExecutableModel;
  }>(16);

  constructor(options: SourceModelOptions) {
    assert(
      /^git:[a-f0-9-]{36}$/.test(options.projectId),
      "Model identity must belong to a local Git project",
    );
    this.repository = options.repository;
    this.#services = options.services;
    this.#tooling = options.tooling;
    this.#writer = options.writer;
    this.#projectId = options.projectId;
    this.#systemQualifiedName = options.systemQualifiedName ??
      canonicalProductName(DEFAULT_SYSTEM);
    this.#seed = options.initialSources
      ? structuredClone(options.initialSources)
      : undefined;
    this.#recordedDelegation = options.recordedDelegation;
    this.#creationScope = options.creationScope
      ? structuredClone(options.creationScope)
      : undefined;
    this.proposeEdit = (identity, request, expectedDigest) =>
      this.#proposeEdit(this.#tooling, identity, request, expectedDigest);
  }

  /** Where creation policies are read for this model: the caller's branch
   * scope on a branch preview/publication, the main scope otherwise. */
  #scopeFor(current: Pick<ExecutableModel, "identity">) {
    return this.#creationScope ?? mainCreationScope(current.identity);
  }

  async #proposeEdit(
    tooling: ModelToolingPort,
    identity: ModelIdentity,
    input: ModelEditRequest,
    expectedDigest: string,
  ): Promise<ModelRevisionProposal> {
    const request = structuredClone(input);
    const current = await this.readExecutableModel(identity);
    assert(
      current.version.digest === expectedDigest,
      "Execution model changed before targeted source proposal",
    );
    assert(
      current.policy.mayProposeSysmlRevision === true,
      "The admitted model does not permit SysML revision proposals",
    );
    const base = await this.repository.at(request.baseVersion);
    this.#verify(identity, base);
    // Check operation authority before invoking the editor. The repository checks
    // the complete compiled output, including every rewritten reference, afterwards.
    await this.#services.authority.authorizeEdit(
      current,
      await this.repository.at(current.version.repositoryVersion!),
      request.edits.map((edit) => edit.kind),
    );
    assert(
      typeof request.sourceDigest === "string" &&
        request.sourceDigest === await modelSourceDigest(base.sources),
      "Source digest differs from the consulted source version",
    );
    const result = await tooling.edit(
      base.sources,
      resolveModelEdits(base, request.edits),
    );
    assertSourceSplices(base.sources, result, {
      // This checks the whole call, including rename and general expressions;
      // no individual Host operation can accurately identify the divergence.
      opIndex: -1,
      op: "proposeEdit",
      target: { qualifiedName: this.#systemQualifiedName },
    });
    // The ordinary path rechecks the current authority, compiles with the embedded Toolkit,
    // and writes an isolated proposal. It never adopts or activates the edit.
    return await this.#proposeSourceChanges(
      identity,
      {
        baseVersion: request.baseVersion,
        sources: result.sources,
        reason: request.reason,
        ...(request.addresses !== undefined
          ? { addresses: request.addresses }
          : {}),
      },
      expectedDigest,
      request.edits.map((edit) => edit.kind),
    );
  }

  async proposeDelegation(
    identity: ModelIdentity,
    input: ModelDelegationRequest,
    expectedDigest: string,
  ): Promise<ModelRevisionProposal> {
    const request = structuredClone(input);
    const current = await this.readExecutableModel(identity);
    assert(
      current.version.digest === expectedDigest,
      "Execution model changed before administration proposal",
    );
    const base = await this.repository.at(request.baseVersion);
    this.#verify(identity, base);
    assert(
      request.sourceDigest === await modelSourceDigest(base.sources),
      "Source digest differs from the consulted source version",
    );
    const prepared = await this.#services.authority.administer(
      base,
      this.#projectId,
      current,
      request.change,
    );
    const record = await this.repository.propose({
      baseVersion: request.baseVersion,
      sources: prepared.sources,
      author: `agent:${identity.builderId}`,
      reason: request.reason,
      authorization: prepared.authorization,
    });
    assert(
      record.status === "proposed",
      "Repository did not persist an administration proposal",
    );
    return {
      id: record.id,
      baseVersion: record.baseVersion,
      status: "pending",
    };
  }

  async #initialSources(): Promise<Sources> {
    return await this.#services.files.initialSources();
  }

  #identity(revision: SourceRevision): ModelIdentity {
    const identity = sourceModelIdentity(
      revision,
      this.#projectId,
      this.#systemQualifiedName,
    );
    this.#systemQualifiedName = identity.systemQualifiedName ?? DEFAULT_SYSTEM;
    return identity;
  }

  #verifyStable(identity: ModelIdentity, revision: SourceRevision): void {
    this.#verifyStableIdentity(identity, this.#identity(revision));
  }

  #verifyProject(identity: ModelIdentity): void {
    assert(
      identity.projectId === this.#projectId &&
        identity.editingContextId === `${this.#projectId}/main`,
      "Foreign model identity: use a separate project instance",
    );
  }

  #verifyStableIdentity(identity: ModelIdentity, actual: ModelIdentity): void {
    this.#verifyProject(identity);
    assert(
      !identity.systemQualifiedName ||
        identity.systemQualifiedName ===
          (actual.systemQualifiedName ?? DEFAULT_SYSTEM),
      "Native conversation scope changed",
    );
    for (
      const field of ["rootId", "systemId", "catalogId", "builderId"] as const
    ) {
      assert(
        actual[field] === identity[field],
        `Native model identity drift: ${field}`,
      );
    }
  }

  #verify(identity: ModelIdentity, revision: SourceRevision): void {
    this.#verifyStable(identity, revision);
    const actual = this.#identity(revision);
    if (identity.reviewerId) {
      assert(
        actual.reviewerId === identity.reviewerId,
        "Native reviewer identity drift",
      );
    }
  }

  async initialize(
    existing?: ModelIdentity,
    configuration?: SystemConfiguration,
  ): Promise<ModelIdentity> {
    if (existing) {
      assert(
        existing.projectId === this.#projectId,
        "Foreign model identity: use a separate project instance",
      );
    }
    await this.repository.initialize(
      this.#seed ?? await this.#initialSources(),
    );
    // An empty instance identifier is a technical provisioning value. Declared
    // behavior, rights, scope and policy are retained exactly from the sources.
    let prepared:
      | Awaited<ReturnType<typeof applyEdits>>
      | undefined;
    let head: SourceRevision;
    let expectedId: string;
    const revision = await this.repository.updateSystemSources(
      async (revision) => {
        head = revision;
        const identity = this.#identity(revision);
        if (existing) this.#verify(existing, revision);
        const configId = owned(revision, identity.systemId, "configurationId");
        if (literal(revision, configId).value !== "") return revision.sources;
        expectedId = configuration?.id ?? crypto.randomUUID();
        prepared = await applyEdits(this.#tooling, revision, [
          {
            op: "setFeatureValue",
            target: { elementId: id(configId) },
            value: expectedId,
          },
        ]);
        return prepared.sources;
      },
      "ase:provision-instance-id",
      {
        verify: async (candidate) => {
          if (!prepared) return;
          await verifyEdits(candidate, prepared.edits, {
            base: head,
          });
          const executable = await this.#executable(candidate);
          if (executable.configuration.id !== expectedId) {
            throw new HostEditError("READ_BACK_MISMATCH", {
              opIndex: 0,
              op: prepared.edits[0]!.op,
              target: hostEditTarget(prepared.edits[0]!),
            }, "Provisioned configuration identity differs");
          }
        },
      },
    );
    return this.#identity(revision);
  }

  async currentRevision(identity: ModelIdentity): Promise<SourceRevision> {
    const revision = await this.repository.current();
    this.#verify(identity, revision);
    return revision;
  }

  async #executable(revision: SourceRevision): Promise<ExecutableModel> {
    return await this.#services.compilation.compile(
      revision,
      this.#projectId,
      this.#systemQualifiedName,
    );
  }

  async validateRevision(
    revision: SourceRevision,
  ): Promise<ExecutableModel> {
    return await this.#executable(revision);
  }

  async readExecutableModel(
    identity: ModelIdentity,
    repositoryVersion?: string,
  ): Promise<ExecutableModel> {
    this.#verifyProject(identity);
    const version = repositoryVersion ?? await this.repository.headVersion?.();
    if (version && matchesExactRevision(version)) {
      const value = await this.#executablePins.read(version, async () => {
        const revision = await this.repository.at(version);
        assert(
          revision.version === version,
          "Loaded model revision differs from requested pin",
        );
        this.#verify(identity, revision);
        const actual = this.#identity(revision);
        return { identity: actual, model: await this.#executable(revision) };
      }, ({ identity: actual }) => {
        this.#verifyStableIdentity(identity, actual);
        if (identity.reviewerId) {
          assert(
            actual.reviewerId === identity.reviewerId,
            "Native reviewer identity drift",
          );
        }
      });
      return value.model;
    }
    const revision = repositoryVersion
      ? await this.repository.at(repositoryVersion)
      : await this.currentRevision(identity);
    this.#verify(identity, revision);
    return await this.#executable(revision);
  }

  async readSourceRevision(
    identity: ModelIdentity,
  ): Promise<ModelSourceRevision> {
    let revision = await this.currentRevision(identity);
    if (!this.repository.history) {
      return {
        version: revision.version,
        sources: structuredClone(revision.sources),
      };
    }
    const limit = 32;
    const history = await this.repository.history({ limit });
    if (history.headVersion !== revision.version) {
      revision = await this.repository.at(history.headVersion);
      this.#verify(identity, revision);
      assert(
        revision.version === history.headVersion,
        "Source snapshot does not match the publication history head",
      );
    }
    const proposals = this.repository.listProposals
      ? await this.repository.listProposals()
      : [];
    const proposalLimit = 64;
    let remainingProposals = proposalLimit;
    let proposalsTruncated = false;
    const commits = history.commits.slice(0, limit).map((commit) => {
      const accepted = proposals.filter((proposal) =>
        proposal.status === "accepted" &&
        proposal.acceptedVersion === commit.version
      );
      const selected = accepted.slice(0, remainingProposals);
      remainingProposals -= selected.length;
      if (selected.length < accepted.length) proposalsTruncated = true;
      return {
        version: commit.version,
        sourceDigest: commit.sourceDigest,
        author: commit.author,
        createdAt: commit.createdAt,
        ...(selected.length > 0
          ? {
            proposals: selected.map(({ id, author }) => ({ id, author })),
          }
          : {}),
      };
    });
    return structuredClone({
      version: revision.version,
      sources: revision.sources,
      publishedRevisions: {
        limit,
        proposalLimit,
        truncated: history.truncated || history.commits.length > limit ||
          proposalsTruncated,
        commits,
      },
    });
  }

  async readSourceProposals(
    identity: ModelIdentity,
  ): Promise<ModelSourceProposalStatus[]> {
    await this.currentRevision(identity);
    if (!this.repository.listProposals) return [];
    const proposals = await this.repository.listProposals();
    return structuredClone(
      proposals.filter((proposal) =>
        proposal.author === `agent:${identity.builderId}`
      ).map((proposal) => ({
        id: proposal.id,
        baseVersion: proposal.baseVersion,
        status: proposal.status,
        ...(proposal.addresses !== undefined
          ? { addresses: proposal.addresses }
          : {}),
        ...(proposal.acceptedVersion !== undefined
          ? { acceptedVersion: proposal.acceptedVersion }
          : {}),
      })),
    );
  }

  async proposeRevision(
    identity: ModelIdentity,
    request: ModelRevisionRequest,
    expectedDigest: string,
  ): Promise<ModelRevisionProposal> {
    return await this.#proposeSourceChanges(identity, request, expectedDigest, [
      "replace-source",
    ]);
  }

  async #proposeSourceChanges(
    identity: ModelIdentity,
    input: ModelRevisionRequest,
    expectedDigest: string,
    operations: readonly ModelEditOperation[],
  ): Promise<ModelRevisionProposal> {
    const request = structuredClone(input);
    const current = await this.readExecutableModel(identity);
    assert(
      current.version.digest === expectedDigest,
      "Execution model changed before source proposal",
    );
    assert(
      current.policy.mayProposeSysmlRevision === true,
      "The admitted model does not permit SysML revision proposals",
    );
    const base = await this.repository.at(request.baseVersion);
    this.#verify(identity, base);
    const authorization = await this.#services.authority.authorizeEdit(
      current,
      await this.repository.at(current.version.repositoryVersion!),
      operations,
    );
    const sources = { ...base.sources, ...request.sources };
    const record = await this.repository.propose({
      baseVersion: request.baseVersion,
      sources,
      author: `agent:${identity.builderId}`,
      reason: request.reason,
      authorization,
      ...(request.addresses !== undefined
        ? { addresses: request.addresses }
        : {}),
    });
    assert(
      record.status === "proposed",
      "Repository did not persist a validated source proposal",
    );
    return {
      id: record.id,
      baseVersion: record.baseVersion,
      status: "pending",
      ...(request.addresses !== undefined
        ? { addresses: request.addresses }
        : {}),
    };
  }

  async findApprovedChange(
    identity: ModelIdentity,
    changeId: string,
  ): Promise<ApprovedChangePublication | null> {
    const published = await this.repository.findPublication(changeId);
    if (!published) return null;
    assert(
      published.receipt?.type !== "candidate-activation",
      "Expected a mandate publication",
    );
    this.#verifyStable(identity, published.revision);
    if (published.receipt) {
      await assertPublishedEdits(
        published.revision,
        published.receipt,
        identity.systemId,
      );
    }
    return {
      model: await this.#executable(published.revision),
      receipt: published.receipt,
    };
  }

  async #prepareApprovedChange(
    identity: ModelIdentity,
    revision: SourceRevision,
    change: PendingChange,
    expectedDigest: string,
    preview = false,
  ) {
    const requirePriorAuthority = (condition: unknown, message: string) => {
      if (!condition) {
        throw new AuthorityInvariantError(
          3,
          "ADMISSION_NOT_AUTHORIZED",
          message,
        );
      }
    };
    const edits: Array<
      { owner: string; name: string; value: string | boolean | number }
    > = [];
    this.#verify(identity, revision);
    if (change.kind === "operator-creation") {
      assertOperatorCreationCapacity(
        discoverConversationUnits(revision, identity.projectId).length,
      );
    }
    const current = await this.#executable(revision);
    if (
      current.version.digest !== expectedDigest ||
      current.configuration.revision !== change.baseRevision ||
      (change.baseModelDigest !== undefined &&
        change.baseModelDigest !== current.version.digest)
    ) {
      throw new AuthorityInvariantError(
        3,
        "STALE_PROPOSAL",
        "Execution model changed before source approval",
      );
    }
    if (!preview) {
      assertChangeAuthorityReceipt(
        current,
        change,
        this.#scopeFor(current),
        this.#recordedDelegation,
      );
    }
    if (
      !preview && change.kind === "operator-creation" && change.operator &&
      !isTeamOperatorSpec(change.operator) && change.operator.creationGrant &&
      (change.authority !== "human" ||
        change.authorityExercise?.creationDelegation)
    ) {
      throw new OperatorAuthorityError(
        "AUTHORITY_OUT_OF_BOUNDS",
        "An independent operator's initial creation grant requires its explicit human creation decision",
      );
    }
    assertApprovable(current, change, this.#scopeFor(current));
    if (
      !preview && change.requestedRights &&
      ("operatorAuthority" in change.requestedRights ||
        "toolAdmission" in change.requestedRights ||
        "operatorCreation" in change.requestedRights) &&
      !change.diff
    ) {
      throw new OperatorAuthorityError(
        "CHANGE_PREVIEW_MISMATCH",
        "Operator policy approval requires the displayed source diff",
        { changeId: change.id },
      );
    }
    if (
      change.kind === "operator-creation" ||
      change.requestedRights &&
        ("grantModelEditing" in change.requestedRights ||
          "operatorAuthority" in change.requestedRights ||
          "toolAdmission" in change.requestedRights ||
          "operatorCreation" in change.requestedRights)
    ) {
      return await this.#prepareOperatorAuthorityChange(
        revision,
        current,
        change,
      );
    }
    const mandate = owned(revision, identity.systemId, "builderMandate");
    const mandateId = id(mandate);
    const operations: HostEditRequest[] = [];
    let removedMembers: RemovedMember[] = [];
    if (change.kind === "mandate-change") {
      const rights = change.requestedRights;
      assert(
        rights && Object.keys(rights).length === 1,
        "Unsupported exact mandate change",
      );
      if ("addNetworkHosts" in rights) {
        requirePriorAuthority(
          current.policy.mayAddNetworkHosts,
          "Source policy forbids network additions",
        );
        const additions =
          validateNetworkScope({ allowedHosts: rights.addNetworkHosts })
            .allowedHosts;
        assert(
          additions.length > 0 && additions.length <= 8 &&
            additions.every((host) =>
              !current.configuration.network!.allowedHosts.includes(host)
            ),
          "Network addition is not exact and new",
        );
        const network = validateNetworkScope({
          allowedHosts: [
            ...current.configuration.network!.allowedHosts,
            ...additions,
          ],
        });
        edits.push({
          owner: identity.systemId,
          name: "networkHosts",
          value: JSON.stringify(network.allowedHosts),
        });
      } else if (
        "mayAdmitOwnCandidates" in rights &&
        rights.mayAdmitOwnCandidates === true
      ) {
        requirePriorAuthority(
          current.policy.mayDelegateOwnAdmission &&
            current.configuration.builder.admissionAuthority === "human",
          "Source policy forbids own-admission delegation",
        );
        edits.push({ owner: mandateId, name: "mayAdmit", value: true }, {
          owner: identity.systemId,
          name: "admissionMode",
          value: "builder",
        });
      } else if ("setUrlSelectionMode" in rights) {
        requirePriorAuthority(
          current.policy.mayChangeUrlSelection &&
            ["user-provided", "authorized-host"].includes(
              String(rights.setUrlSelectionMode),
            ),
          "Source policy forbids this URL selection change",
        );
        const conversation = owned(
          revision,
          identity.systemId,
          "conversation",
        );
        const policy = owned(revision, id(conversation), "executionPolicy");
        edits.push({
          owner: id(policy),
          name: "urlSelectionMode",
          value: String(rights.setUrlSelectionMode),
        });
      } else throw new Error("Unsupported exact mandate change");
    } else if (change.kind === "reviewer-creation") {
      requirePriorAuthority(
        current.policy.mayCreateReviewer &&
          !current.configuration.reviewer &&
          change.role === "reviewer" && change.name?.trim() &&
          change.name.length <= 80 && change.mandate &&
          Object.keys(change.mandate).length === 2 &&
          change.mandate.mayReviewExactCandidate === true &&
          change.mandate.mayAdmitReviewedCandidates === true,
        "Source policy forbids this exact reviewer declaration",
      );
      const reviewer = declareReviewer(
        await this.#services.files.template(
          "configuration-reviewer.sysml",
        ),
        change.id,
        change.name,
      );
      {
        const migration = await reviewerPromotionEdits(
          this.#tooling,
          revision,
          this.#services.files,
          this.#systemQualifiedName,
        );
        operations.push(...migration.requests);
        removedMembers = migration.removedMembers;
      }
      operations.push({
        op: "insertMember",
        batch: 1,
        owner: { qualifiedName: this.#systemQualifiedName },
        text: productSourceForModel(reviewer, revision.elements),
        expect: [],
      });
      if (sameProductName(this.#systemQualifiedName, DEFAULT_SYSTEM)) {
        operations.push({
          op: "insertMember",
          batch: 1,
          owner: {
            qualifiedName: productNameInModel(
              revision.elements,
              "AssemblyLiveBuilder",
            ),
          },
          text: productSourceForModel(
            await this.#services.files.template(
              "configuration-reviewer-views.sysml",
            ),
            revision.elements,
          ),
          expect: [],
        });
        // Batch 2: the overview may itself be a removed and reinserted
        // dependent, so its new exposure lands after reinsertion (the host
        // writer defers it until the overview exists in that batch).
        operations.push({
          op: "insertMember",
          batch: 2,
          owner: {
            qualifiedName: productNameInModel(
              revision.elements,
              "AssemblyLiveBuilder::agentOverview",
            ),
          },
          text: "expose reviewerActions;",
          expect: [],
        });
      }
      edits.push({ owner: mandateId, name: "mayAdmit", value: false }, {
        owner: identity.systemId,
        name: "admissionMode",
        value: "reviewer",
      });
    } else throw new Error("Unsupported exact source change");
    const next = current.configuration.builder.mandateRevision + 1;
    edits.push({ owner: mandateId, name: "version", value: String(next) }, {
      owner: mandateId,
      name: "id",
      value: `builder-v${next}`,
    }, {
      owner: identity.systemId,
      name: "configurationRevision",
      value: String(current.configuration.revision + 1),
    });
    if (change.kind === "reviewer-creation") {
      for (
        const [owner, values] of Object.entries({
          reviewer: {
            operatorId: change.id,
            configuredName: change.name!,
          },
          reviewerMandate: {
            id: "reviewer-v1",
            version: "1",
            scope:
              "Review the exact tested candidate and admit the reviewed candidate",
            source: DYNAMIC_MANDATE_SOURCE,
            evidenceLevel: "configured",
            grantingOperator: "unknown",
            mayProposeReadWebPage: false,
            mayProposeReadWebPageOutline: false,
            mayInvokeActiveCatalog: false,
            mayReviewExactCandidate: change.mandate!.mayReviewExactCandidate,
            mayAdmit: change.mandate!.mayAdmitReviewedCandidates,
            mayActivate: false,
            mayChangeOwnMandate: false,
            mayCreateAgents: false,
          },
        })
      ) {
        for (const [name, value] of Object.entries(values)) {
          const insertion = operations.find((op) =>
            op.op === "insertMember" && op.owner &&
            "qualifiedName" in op.owner &&
            op.owner.qualifiedName === this.#systemQualifiedName &&
            op.text.includes("part reviewer :")
          );
          assert(
            insertion?.op === "insertMember",
            "Missing reviewer insertion",
          );
          insertion.expect.push({ path: `${owner}::${name}`, value });
        }
      }
    }
    {
      const prepared = await applyEdits(
        this.#tooling,
        revision,
        [
          ...operations,
          ...edits.map((edit) => ({
            op: "setFeatureValue" as const,
            target: { elementId: id(owned(revision, edit.owner, edit.name)) },
            value: edit.value,
          })),
        ],
      );
      return {
        ...prepared,
        removedMembers,
        expected: {
          reviewer: change.kind === "reviewer-creation"
            ? { id: change.id, name: change.name! }
            : undefined,
          configurationId: current.configuration.id,
          configurationRevision: current.configuration.revision + 1,
          mandateRevision: next,
          allowedHosts: change.requestedRights &&
              "addNetworkHosts" in change.requestedRights &&
              change.requestedRights.addNetworkHosts
            ? [
              ...current.configuration.network!.allowedHosts,
              ...change.requestedRights.addNetworkHosts,
            ]
            : current.configuration.network!.allowedHosts,
          admissionAuthority: change.requestedRights &&
              "mayAdmitOwnCandidates" in change.requestedRights &&
              change.requestedRights.mayAdmitOwnCandidates === true
            ? "builder"
            : change.kind === "reviewer-creation"
            ? "reviewer" as const
            : current.configuration.builder.admissionAuthority,
          urlSelectionMode: change.requestedRights &&
              "setUrlSelectionMode" in change.requestedRights
            ? change.requestedRights.setUrlSelectionMode
            : current.policy.urlSelectionMode,
        },
      };
    }
  }

  async #compilePrepared(
    sources: Sources,
    version: string,
  ): Promise<SourceRevision> {
    return { ...await this.#tooling.compile(sources), version };
  }

  async #prepareOperatorAuthorityChange(
    base: SourceRevision,
    current: ExecutableModel,
    change: PendingChange,
  ) {
    const mandate = `${this.#systemQualifiedName}::builderMandate`;
    const next = current.configuration.builder.mandateRevision + 1;
    const scalarRequests: HostEditRequest[] = [
      {
        op: "setFeatureValue",
        target: { qualifiedName: `${mandate}::version` },
        value: String(next),
      },
      {
        op: "setFeatureValue",
        target: { qualifiedName: `${mandate}::id` },
        value: `builder-v${next}`,
      },
      {
        op: "setFeatureValue",
        target: {
          qualifiedName: `${this.#systemQualifiedName}::configurationRevision`,
        },
        value: String(current.configuration.revision + 1),
      },
    ];
    const common = {
      systemName: this.#systemQualifiedName,
      changeId: change.id,
    };
    const policyRequest = change.requestedRights &&
        "operatorAuthority" in change.requestedRights
      ? change.requestedRights.operatorAuthority
      : undefined;
    const toolPolicyRequest =
      change.requestedRights && "toolAdmission" in change.requestedRights
        ? change.requestedRights.toolAdmission
        : undefined;
    const creationPolicyRequest = change.requestedRights &&
        "operatorCreation" in change.requestedRights
      ? change.requestedRights.operatorCreation
      : undefined;
    if (
      (policyRequest || toolPolicyRequest) && !isPrimaryDesigner(
        current,
        this.#systemQualifiedName,
        sourceLiterals(base.elements),
      )
    ) {
      throw new OperatorAuthorityError(
        "AUTHORITY_POLICY_FORBIDDEN",
        "Only the Main Operator can request a policy",
      );
    }
    const teamCreation = change.kind === "operator-creation" &&
      change.operator && isTeamOperatorSpec(change.operator);
    const creationReceipt = change.authorityExercise?.creationDelegation;
    const creationPolicy = teamCreation &&
        (creationReceipt ||
          current.operatorCreationPolicies?.some((policy) =>
            policy.enabled &&
            policy.holderNativeId === current.identity.builderId
          ))
      ? assertCreationWithinPolicy(
        current,
        change.operator!,
        creationReceipt,
        this.#scopeFor(current),
      )
      : undefined;
    if (
      teamCreation &&
      (change.requestedBy !== current.identity.builderId || !change.teamOrigin)
    ) {
      throw new OperatorAuthorityError(
        "INVALID_OPERATOR_REQUEST",
        "A teammate creation requires its exact creator and originating Request",
      );
    }
    const request = change.kind === "operator-creation"
      ? {
        ...common,
        op: "createRequestOperator" as const,
        name: change.name!,
        operator: change.operator!,
        ...(teamCreation
          ? {
            teamOrigin: change.teamOrigin!,
            parentOperatorId: current.identity.builderId,
            creatorMayAddNetworkHosts: current.policy.mayAddNetworkHosts,
            ...(creationPolicy
              ? {
                creationPolicy: {
                  id: creationPolicy.id,
                  revision: creationPolicy.revision,
                  elementId: creationPolicy.elementId,
                },
              }
              : {}),
          }
          : {}),
      }
      : creationPolicyRequest
      ? {
        ...common,
        op: "publishOperatorCreationPolicy" as const,
        policy: creationPolicyRequest,
      }
      : toolPolicyRequest
      ? {
        ...common,
        op: "publishToolAdmissionPolicy" as const,
        policy: toolPolicyRequest,
      }
      : policyRequest
      ? {
        ...common,
        op: "publishOperatorAuthorityPolicy" as const,
        policy: policyRequest,
      }
      : {
        ...common,
        op: "grantModelEditing" as const,
        grant: (change.requestedRights as {
          grantModelEditing:
            import("../../domain/governance/operator-authority.ts").ModelEditingGrant;
        }).grantModelEditing,
      };
    // One changeset, one immutable base: all preimages now share that base.
    const declaration = await this.#services.authority.requests(base, request);
    const requests = [...scalarRequests, ...declaration.requests];
    const { compiledRevision, ...prepared } = await applyEdits(
      this.#tooling,
      base,
      requests,
      {
        compile: (sources) => this.#compilePrepared(sources, base.version),
        retainCompiledRevision: true,
      },
    );
    const systemQualifiedName = declaration.systemQualifiedName;
    const verify = async (candidate: SourceRevision) => {
      await verifyEdits(candidate, prepared.edits, { base });
      const actual = await this.#executable(candidate);
      if (
        actual.configuration.revision !== current.configuration.revision + 1 ||
        actual.configuration.builder.mandateRevision !== next ||
        JSON.stringify(actual.configuration.network) !==
          JSON.stringify(current.configuration.network) ||
        actual.configuration.builder.admissionAuthority !==
          current.configuration.builder.admissionAuthority
      ) {
        throw new OperatorAuthorityError(
          "CHANGE_PREVIEW_MISMATCH",
          "The prepared authority edit changed unrelated permissions",
          { changeId: change.id },
        );
      }
      if (creationPolicyRequest) {
        const policyId = await requestedCreationPolicyId(change.id);
        const policy = actual.operatorCreationPolicies?.find((p) =>
          p.id === policyId
        );
        if (
          !policy || policy.revision !== 1 || !policy.enabled ||
          policy.holderNativeId !== current.identity.builderId ||
          policy.systemId !== current.identity.systemId ||
          policy.parentPolicyElementId !== undefined ||
          policy.children.length !== 0 || policy.maxDelegationDepth !== 0 ||
          policy.maxChildren !== creationPolicyRequest.maxChildren ||
          policy.mode !== creationPolicyRequest.mode ||
          canonical(policy.networkHosts) !==
            canonical(creationPolicyRequest.networkHosts)
        ) {
          throw new OperatorAuthorityError(
            "CHANGE_PREVIEW_MISMATCH",
            "The compiled creation authority differs from the approved policy",
            { changeId: change.id },
          );
        }
      }
      if (policyRequest) {
        const policy = actual.operatorAuthorityPolicies?.find((p) =>
          p.id === policyRequest.policyId
        );
        if (
          !policy ||
          policy.revision !== policyRequest.expectedPolicyRevision + 1 ||
          policy.enabled !== policyRequest.enabled ||
          policy.holderNativeId !== current.identity.builderId ||
          canonical(policy.recipients) !==
            canonical(policyRequest.recipients) ||
          policy.recipientExecutionSpaceId !==
            policyRequest.recipientExecutionSpaceId ||
          canonical(policy.acts) !== canonical(policyRequest.acts) ||
          canonical(policy.networkHosts) !==
            canonical(policyRequest.networkHosts) ||
          canonical(policy.toolIds) !== canonical(policyRequest.toolIds) ||
          policy.maxDelegationDepth !== policyRequest.maxDelegationDepth
        ) {
          throw new OperatorAuthorityError(
            "CHANGE_PREVIEW_MISMATCH",
            "The compiled operator authority differs from the approved policy",
            { changeId: change.id },
          );
        }
      }
      if (toolPolicyRequest) {
        const policy = actual.toolAdmissionPolicies?.find((p) =>
          p.id === toolPolicyRequest.policyId
        );
        if (
          !policy ||
          policy.revision !== toolPolicyRequest.expectedPolicyRevision + 1 ||
          policy.enabled !== toolPolicyRequest.enabled ||
          policy.holderNativeId !== current.identity.builderId ||
          canonical(policy.recipients) !==
            canonical(toolPolicyRequest.recipients) ||
          policy.recipientExecutionSpaceId !==
            toolPolicyRequest.recipientExecutionSpaceId ||
          canonical(policy.toolKinds) !==
            canonical(toolPolicyRequest.toolKinds) ||
          policy.maxDelegationDepth !== toolPolicyRequest.maxDelegationDepth
        ) {
          throw new OperatorAuthorityError(
            "CHANGE_PREVIEW_MISMATCH",
            "The compiled tool admission differs from the approved policy",
            { changeId: change.id },
          );
        }
      }
      const created = await this.#services.compilation.compile(
        candidate,
        current.identity.projectId,
        systemQualifiedName,
      );
      if (change.kind === "operator-creation" && change.operator) {
        const spec = change.operator;
        assertOperatorCreationCapacity(
          discoverConversationUnits(base, current.identity.projectId).length,
          discoverConversationUnits(candidate, current.identity.projectId)
            .length,
        );
        if (
          !exactChildCreationGrant(
            created,
            spec.creationGrant,
            creationPolicy?.elementId,
          )
        ) {
          throw new OperatorAuthorityError(
            "CHANGE_PREVIEW_MISMATCH",
            "The native child creation grant differs from its explicit transmission",
          );
        }
      }
      if (teamCreation) {
        const spec = change.operator!;
        if (
          !isTeamOperatorSpec(spec) || created.caseTypes?.length ||
          created.operator?.instruction !== spec.instruction ||
          !matchesTeamProvision(created, spec.provision)
        ) {
          throw new OperatorAuthorityError(
            "CHANGE_PREVIEW_MISMATCH",
            "The native teammate differs from its exact approved rights and shared Request contract",
          );
        }
        if (creationPolicy) {
          const updatedPolicy = actual.operatorCreationPolicies?.find((
            policy,
          ) => policy.id === creationPolicy.id);
          if (
            !updatedPolicy ||
            updatedPolicy.children.length !==
              creationPolicy.children.length + 1 ||
            !updatedPolicy.children.includes(created.identity.systemId)
          ) {
            throw new OperatorAuthorityError(
              "CHANGE_PREVIEW_MISMATCH",
              "The native creation did not consume exactly one child slot",
            );
          }
        }
      }
    };
    await verify(
      compiledRevision ??
        await this.#compilePrepared(prepared.sources, base.version),
    );
    return {
      ...prepared,
      verify,
    };
  }

  async previewApprovedChange(
    identity: ModelIdentity,
    change: PendingChange,
    expectedDigest: string,
  ): Promise<PreparedChangeDiff> {
    return (await this.prepareApprovedChangeAt(
      identity,
      await this.repository.current(),
      change,
      expectedDigest,
    )).diff;
  }

  /** Pure exact-revision preparation. It never reads HEAD or publishes sources. */
  async prepareApprovedChangeAt(
    identity: ModelIdentity,
    revision: SourceRevision,
    change: PendingChange,
    expectedDigest: string,
  ): Promise<{ diff: PreparedChangeDiff; sources: Sources }> {
    const base = structuredClone(revision);
    const prepared = await this.#prepareApprovedChange(
      identity,
      base,
      change,
      expectedDigest,
      true,
    );
    // The native compiler also rejects structurally invalid legacy/scalar candidates before display.
    const candidate = "verify" in prepared
      ? undefined
      : await this.#compilePrepared(prepared.sources, base.version);
    if (candidate) await this.#executable(candidate);
    const preview = {
      title: change.kind === "operator-creation"
        ? `Create operator: ${change.name}`
        : change.reason,
      author: change.requestedBy ?? identity.builderId,
      base: {
        repositoryVersion: base.version,
        modelDigest: expectedDigest,
        sourceDigest: await modelSourceDigest(base.sources),
      },
      sourceDigest: await modelSourceDigest(prepared.sources),
      ...compareModelSources(base.sources, prepared.sources),
    };
    // Budget the actual prepared receipt before the proposal is persisted or a
    // person is asked to approve it. Publication still checks the exact trailer.
    const current = await this.#executable(base);
    const budget = changePublication({
      ...change,
      diff: preview,
      status: "approved",
      decidedAt: "2000-01-01T00:00:00.000Z",
      authorityExercise: change.kind === "operator-creation" &&
          change.operator && isTeamOperatorSpec(change.operator)
        ? creationPreviewExercise(current, change, this.#scopeFor(current))
        : exerciseOwnerAuthority(current, "mandate-change"),
    }, current.version);
    budget.edits = prepared.edits;
    assertPublicationSize(budget, APPROVAL_RECEIPT_RESERVE_BYTES);
    return { diff: preview, sources: structuredClone(prepared.sources) };
  }

  async #operationJournal(
    base: SourceRevision,
    candidate: SourceRevision,
    prepared: {
      edits: import("../../domain/model/editing/host-edit.ts").HostEdit[];
      idMap?: readonly (readonly [string, string])[];
    },
  ) {
    const introducedNames = prepared.edits.flatMap((edit) =>
      edit.op === "insertMember"
        ? (edit.introduced ?? []).map((member) => member.qualifiedName)
        : []
    );
    const nativeIds = candidate.elements.filter((element) =>
      introducedNames.includes(String(element.qualifiedName))
    ).map((element) => String(element["@id"]));
    const inventory = await incarnationInventory(
      candidate,
      {
        nativeIds,
        qualifiedNames: introducedNames,
      },
    );
    const introducedIds = new Map(
      inventory.incarnations.map((
        entry,
      ) => [entry.qualifiedName, {
        nativeId: entry.nativeId,
        preimageDigest: entry.preimageDigest,
      }]),
    );
    return buildOperationJournal({
      base: parseModelRevisionRef({
        repositoryId: this.#writer!.repositoryId,
        version: base.version,
      }),
      baseSourceDigest: await modelSourceDigest(base.sources),
      edits: prepared.edits,
      idMap: prepared.idMap,
      introducedIds,
    });
  }

  async applyApprovedChange(
    identity: ModelIdentity,
    change: PendingChange,
    expectedDigest: string,
    originalPublication: ChangePublication,
  ): Promise<ExecutableModel> {
    assertPublicationMatches(change, originalPublication);
    const publication = this.#writer
      ? structuredClone(originalPublication)
      : originalPublication;
    if (this.#writer) {
      const resumed = await this.#writer.resume(change.id, originalPublication);
      if (resumed) {
        this.#verifyStable(identity, resumed);
        return await this.#executable(resumed);
      }
    }
    let verifyPrepared:
      | ((candidate: SourceRevision) => Promise<void>)
      | undefined;
    let captured: {
      edits: import("../../domain/model/editing/host-edit.ts").HostEdit[];
      idMap?: readonly (readonly [string, string])[];
    } | undefined;
    const prepare = async (revision: SourceRevision) => {
      try {
        if (
          originalPublication.approvedSourceBase && (
            revision.version !==
              originalPublication.approvedSourceBase.repositoryVersion ||
            await modelSourceDigest(revision.sources) !==
              originalPublication.approvedSourceBase.sourceDigest ||
            expectedDigest !==
              originalPublication.approvedSourceBase.modelDigest
          )
        ) {
          throw new OperatorAuthorityError(
            "CHANGE_PREVIEW_MISMATCH",
            "The source base differs from the exact displayed approval",
            { changeId: change.id },
          );
        } else if (
          !this.#writer &&
          !originalPublication.approvedSourceBase &&
          originalPublication.adoptedPin?.repositoryVersion !== undefined &&
          revision.version !==
            originalPublication.adoptedPin.repositoryVersion
        ) {
          throw new OperatorAuthorityError(
            "CHANGE_PREVIEW_MISMATCH",
            "The adopted source pin moved after the displayed approval; reopen the change on the current pin",
            { changeId: change.id },
          );
        }
        const prepared = await this.#prepareApprovedChange(
          identity,
          revision,
          change,
          expectedDigest,
        );
        captured = prepared;
        const actualDiff = change.diff
          ? compareModelSources(revision.sources, prepared.sources)
          : undefined;
        if (
          change.diff && actualDiff &&
          (canonical(change.diff.files) !== canonical(actualDiff.files) ||
            change.diff.patch !== actualDiff.patch)
        ) {
          throw new OperatorAuthorityError(
            "CHANGE_PREVIEW_MISMATCH",
            "Sources differ from the displayed proposal",
            { changeId: change.id },
          );
        }
        if ("verify" in prepared) {
          publication.edits = prepared.edits;
          verifyPrepared = prepared.verify;
        } else if ("expected" in prepared) {
          publication.edits = prepared.edits;
          verifyPrepared = async (candidate) => {
            await verifyEdits(candidate, prepared.edits, {
              base: revision,
            });
            await assertReinsertedMembers(
              this.#tooling,
              candidate,
              prepared.removedMembers,
            );
            const actual = await this.#executable(candidate);
            const expected = prepared.expected;
            if (
              actual.configuration.id !== expected.configurationId ||
              actual.configuration.revision !==
                expected.configurationRevision ||
              actual.configuration.builder.mandateRevision !==
                expected.mandateRevision ||
              JSON.stringify(actual.configuration.network!.allowedHosts) !==
                JSON.stringify(expected.allowedHosts) ||
              actual.configuration.builder.admissionAuthority !==
                expected.admissionAuthority ||
              actual.policy.urlSelectionMode !== expected.urlSelectionMode ||
              expected.reviewer && (
                  actual.configuration.reviewer?.id !==
                    expected.reviewer.id ||
                  actual.configuration.reviewer?.name !==
                    expected.reviewer.name ||
                  !actual.identity.reviewerId ||
                  !actual.flows.promotion?.nodes.some((node) =>
                    node.mechanism === "review_candidate" &&
                    node.performerId === actual.identity.reviewerId
                  )
                )
            ) {
              throw new HostEditError("READ_BACK_MISMATCH", {
                opIndex: -1,
                op: "setFeatureValue",
                target: hostEditTarget(prepared.edits[0]!),
              }, "Compiled executable differs from the approved host change");
            }
          };
        }
        return prepared.sources;
      } catch (error) {
        throw publicationFailure(error, {
          changeId: change.id,
          systemId: identity.systemId,
        }, "refuse");
      }
    };
    const execute = async () => {
      if (!this.#writer) {
        return await this.repository.updateSystemSources(
          prepare,
          `ase:approved-change:${change.id}`,
          { publication, verify: (candidate) => verifyPrepared?.(candidate) },
        );
      }
      const approvedVersion = publicationSourceVersion(originalPublication);
      assert(approvedVersion, "Approved source base is required");
      const base = await this.repository.at(approvedVersion);
      const sources = await prepare(base);
      const candidate = await this.#compilePrepared(sources, base.version);
      await verifyPrepared?.(candidate);
      const pin = {
        ...(await this.#executable(base)).version,
        repositoryVersion: base.version,
      };
      const dossier = await buildApprovedChangeCommand({
        repositoryId: this.#writer.repositoryId,
        change,
        pin,
        journal: await this.#operationJournal(base, candidate, captured!),
        recipeDigest: await this.#writer.recipeDigest(),
        approval: originalPublication,
      });
      return await this.#writer.publish(dossier);
    };
    const updated = await execute().catch((error) => {
      throw publicationFailure(error, {
        changeId: change.id,
        systemId: identity.systemId,
      }, "retry");
    });
    await assertPublishedEdits(
      updated,
      publication,
      identity.systemId,
    );
    return await this.#executable(updated);
  }

  /** Compatibility verification only: runtime expectations never rewrite sources. */
  async syncConfiguration(
    identity: ModelIdentity,
    configuration: SystemConfiguration,
  ): Promise<ModelIdentity> {
    const executable = await this.readExecutableModel(identity);
    const actual = executable.configuration;
    const shape = (value: SystemConfiguration) => ({
      id: value.id,
      revision: value.revision,
      envelope: value.envelope,
      network: value.network,
      builder: value.builder,
      reviewer: value.reviewer,
    });
    assert(
      JSON.stringify(shape(actual)) === JSON.stringify(shape(configuration)),
      "Runtime configuration differs from admitted SysML; apply an exact approved source change",
    );
    return executable.identity;
  }

  async #binding(
    revision: SourceRevision,
    identity: ModelIdentity,
    candidate: Candidate,
    element: Element,
    active = false,
  ): Promise<ModelBinding> {
    assert(
      element["@type"] === "PartUsage" &&
        reference(element.owner) === identity.catalogId,
      "Candidate does not belong to the bound catalog",
    );
    const type = one(
      revision,
      "AssemblyLiveBuilder::ToolCandidate",
      "PartDefinition",
    );
    assert(
      references(element.type).includes(id(type)),
      "Candidate has the wrong model type",
    );
    const executable = await this.#executable(revision);
    const entry = executable.catalog.find((entry) =>
      entry.nativeId === id(element)
    );
    const contract = executable.contracts.find((contract) =>
      contract.nativeId === entry?.contractId
    );
    assert(
      entry && contract && contract.kind === candidate.kind,
      "Candidate has no matching native contract binding",
    );
    for (
      const [name, expected] of [["name", candidate.name], [
        "kind",
        candidate.kind,
      ], [
        "digest",
        candidate.digest,
      ], ["candidateId", candidate.id]] as const
    ) {
      assert(
        literal(revision, owned(revision, id(element), name)).value ===
          expected,
        `Candidate ${name} read-back mismatch`,
      );
    }
    if (active) {
      assert(
        entry.status === "active",
        "Candidate activation read-back mismatch",
      );
    }
    if (candidate.requiredAuthority) {
      assert(
        literal(revision, owned(revision, id(element), "requiredAuthority"))
          .value === candidate.requiredAuthority,
        "Candidate required authority mismatch",
      );
    }
    if (candidate.proposedConfigurationRevision !== undefined) {
      assert(
        literal(revision, owned(revision, id(element), "configurationRevision"))
          .value === String(candidate.proposedConfigurationRevision),
        "Candidate configuration revision mismatch",
      );
    }
    const qualified = String(element.qualifiedName);
    return {
      elementId: id(element),
      graphPath: qualified.split("::").slice(1).join("."),
    };
  }

  async findCandidate(
    identity: ModelIdentity,
    candidate: Candidate,
  ): Promise<ModelBinding | null> {
    const revision = await this.currentRevision(identity);
    const name = await candidateName(candidate);
    const found = revision.elements.filter((element) =>
      element.declaredName === name &&
      reference(element.owner) === identity.catalogId
    );
    assert(found.length <= 1, "Ambiguous candidate identity");
    return found[0]
      ? this.#binding(revision, identity, candidate, found[0])
      : null;
  }

  async activateCandidate(
    identity: ModelIdentity,
    candidate: Candidate,
    admittedModelDigest: string,
  ): Promise<ModelBinding> {
    const name = await candidateName(candidate);
    const qualifiedName = `${this.#systemQualifiedName}::catalog::${name}`;
    const context = { candidateId: candidate.id, systemId: identity.systemId };
    const head = await this.currentRevision(identity);
    const current = await this.#executable(head);
    const existing = head.elements.filter((element) =>
      element.qualifiedName === qualifiedName
    );
    requireActivation(
      existing.length <= 1,
      "CANDIDATE_AMBIGUOUS",
      context,
      "Ambiguous candidate identity",
    );
    if (existing[0]) {
      const binding = await this.#binding(
        head,
        identity,
        candidate,
        existing[0],
      );
      if (
        current.catalog.some((entry) =>
          entry.nativeId === binding.elementId && entry.status === "active"
        )
      ) return binding;
    }
    // Tests, review and admission were made under one contract. Whatever the
    // authority, a publication under another digest would claim a proof it does
    // not have. The same pin is checked again under the repository lock.
    requireActivation(
      current.version.digest === admittedModelDigest,
      "ADMITTED_MODEL_CHANGED",
      {
        ...context,
        admittedDigest: admittedModelDigest,
        currentDigest: current.version.digest,
      },
      "The model changed after the candidate was admitted",
    );
    const admission = candidate.admission;
    requireActivation(
      admission,
      "ADMISSION_MISSING",
      context,
      "The candidate has no recorded admission",
    );
    requireActivation(
      candidate.tests?.passed === true,
      "TESTS_NOT_PASSED",
      context,
      "The candidate has no successful test report",
    );
    requireActivation(
      admission.candidateId === candidate.id &&
        admission.candidateDigest === candidate.digest,
      "ADMISSION_CANDIDATE_MISMATCH",
      context,
      "The admission targets another candidate or digest",
    );
    requireActivation(
      admission.configurationRevision === current.configuration.revision,
      "ADMISSION_CONFIGURATION_CHANGED",
      {
        ...context,
        admittedRevision: admission.configurationRevision,
        currentRevision: current.configuration.revision,
      },
      "The configuration changed after the candidate was admitted",
    );
    requireActivation(
      ["human", "builder", "reviewer", "delegate"].includes(
        admission.authority,
      ),
      "ADMISSION_AUTHORITY_INVALID",
      context,
      "The admission names an unknown authority",
    );
    requireActivation(
      admission.actorId && admission.reason.trim() && admission.at,
      "ADMISSION_RECORD_INCOMPLETE",
      context,
      "The admission lacks its actor, reason or date",
    );
    const validateDelegation = (model: ExecutableModel) => {
      if (
        admission.authority !== "delegate" &&
        !admission.authorityExercise?.candidateDelegation &&
        !candidate.admissionDecision?.authorityExercise?.candidateDelegation
      ) return;
      try {
        assertCandidateDelegationReceipt(
          model,
          candidate,
          mainExecutionSpace(model.identity),
        );
      } catch (error) {
        throw new CandidateActivationError(
          "ADMISSION_EXERCISE_MISMATCH",
          context,
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    validateDelegation(current);
    const exercise = admission.authorityExercise;
    if (exercise) {
      requireActivation(
        exercise.action === "candidate-admission" &&
          exercise.systemId === identity.systemId,
        "ADMISSION_EXERCISE_MISMATCH",
        context,
        "The authority exercise is not a candidate admission of this system",
      );
      requireActivation(
        exercise.baseModelDigest === admittedModelDigest,
        "ADMITTED_MODEL_CHANGED",
        {
          ...context,
          admittedDigest: admittedModelDigest,
          exerciseDigest: exercise.baseModelDigest,
        },
        "The authority exercise was made under another model digest",
      );
    }
    // A system-scoped stable publication key also prevents a retry from undoing
    // a later explicit removal. No separate candidate store is introduced.
    const key = await executionDigest({
      system: identity.systemId,
      candidate: candidate.id,
      purpose: "candidate-activation",
    });
    const changeId = [
      key.slice(0, 8),
      key.slice(8, 12),
      key.slice(12, 16),
      key.slice(16, 20),
      key.slice(20, 32),
    ].join("-");
    const publication: CandidateActivationPublication = {
      type: "candidate-activation",
      changeId,
      systemId: identity.systemId,
      builderId: identity.builderId,
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      admission: structuredClone(admission),
      baseModelDigest: current.version.digest,
      baseRevision: current.configuration.revision,
      adoptedPin: {
        digest: current.version.digest,
        repositoryVersion: current.version.repositoryVersion,
      },
      decidedAt: admission.at,
      edits: [],
    };
    const originalPublication = structuredClone(publication);
    if (this.#writer) {
      const resumed = await this.#writer.resume(changeId, originalPublication);
      if (resumed) {
        const latest = await this.currentRevision(identity);
        return await this.#binding(
          latest,
          identity,
          candidate,
          one(latest, qualifiedName, "PartUsage"),
          true,
        );
      }
    }
    let prepared:
      | Awaited<ReturnType<typeof applyEdits>>
      | undefined;
    let base: SourceRevision;
    // The repository classifies every error raised here as a receipt refusal.
    // Keep the coded refusal so the caller can still read its code.
    let refusal: CandidateActivationError | undefined;
    const coded = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof CandidateActivationError) refusal = error;
        throw error;
      }
    };
    const verify = (revision: SourceRevision) =>
      coded(async () => {
        if (prepared) {
          await verifyEdits(revision, prepared.edits, {
            base,
          });
        }
        const element = one(revision, qualifiedName, "PartUsage");
        await this.#binding(revision, identity, candidate, element, true);
        requireActivation(
          (await this.#executable(revision)).version.digest ===
            admittedModelDigest,
          "ACTIVATION_CHANGED_CONTRACT",
          context,
          "Candidate activation changed the execution contract",
        );
      });
    const prepare = (revision: SourceRevision) =>
      coded(async () => {
        this.#verify(identity, revision);
        base = revision;
        const executable = await this.#executable(revision);
        requireActivation(
          executable.version.digest === admittedModelDigest,
          "ADMITTED_MODEL_CHANGED",
          {
            ...context,
            admittedDigest: admittedModelDigest,
            currentDigest: executable.version.digest,
          },
          "The model changed while the activation was being prepared",
        );
        const found = revision.elements.filter((element) =>
          element.qualifiedName === qualifiedName
        );
        requireActivation(
          found.length <= 1,
          "CANDIDATE_AMBIGUOUS",
          context,
          "Ambiguous candidate identity",
        );
        let requests: HostEditRequest[];
        if (found[0]) {
          const binding = await this.#binding(
            revision,
            identity,
            candidate,
            found[0],
          );
          const entry = executable.catalog.find((entry) =>
            entry.nativeId === binding.elementId
          )!;
          if (entry.status === "active") return revision.sources;
          validateDelegation(executable);
          requests = [{
            op: "setFeatureValue",
            target: { qualifiedName: `${qualifiedName}::status` },
            value: "active",
          }];
        } else {
          validateDelegation(executable);
          const contracts = executable.contracts.filter((contract) =>
            contract.kind === candidate.kind
          );
          requireActivation(
            contracts.length === 1,
            "CONTRACT_NOT_UNIQUE",
            { ...context, kind: candidate.kind, count: contracts.length },
            "Expected one admitted candidate contract",
          );
          const contract = revision.elements.find((element) =>
            element["@id"] === contracts[0]!.nativeId &&
            element["@type"] === "ItemUsage" &&
            reference(element.owner) === identity.catalogId
          );
          requireActivation(
            contract,
            "CONTRACT_NOT_OWNED",
            context,
            "Candidate contract is not owned by the bound catalog",
          );
          const path = String(contract.qualifiedName).split("::");
          requireActivation(
            path.length >= 4 && String(contract.qualifiedName).startsWith(
              `${this.#systemQualifiedName}::catalog::`,
            ) &&
              path.every((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part)),
            "CONTRACT_PATH_UNSUPPORTED",
            context,
            "Candidate contract requires a supported absolute native feature path",
          );
          const contractPath = `${path[0]}::${path.slice(1).join(".")}`;
          const values: Array<[string, string]> = [
            ["name", candidate.name],
            ["kind", candidate.kind],
            ["digest", candidate.digest],
            ["candidateId", candidate.id],
          ];
          if (candidate.requiredAuthority) {
            values.push(["requiredAuthority", candidate.requiredAuthority]);
          }
          if (candidate.proposedConfigurationRevision !== undefined) {
            values.push([
              "configurationRevision",
              String(candidate.proposedConfigurationRevision),
            ]);
          }
          const declaration = `part ${name} : ${
            productNameInModel(
              revision.elements,
              "AssemblyLiveBuilder::ToolCandidate",
            )
          } {\n${
            values.map(([key, value]) =>
              `    attribute ${key} : ScalarValues::String = ${
                spelling(value)
              };`
            ).join("\n")
          }\n    bind contract = ${contractPath};\n}`;
          requests = [{
            op: "insertMember",
            owner: { qualifiedName: `${this.#systemQualifiedName}::catalog` },
            text: declaration,
            expect: values.map(([key, value]) => ({
              kind: "literal",
              path: `${name}::${key}`,
              value,
            })),
          }];
        }
        prepared = await applyEdits(
          this.#tooling,
          revision,
          requests,
          {
            compile: (sources) =>
              this.#compilePrepared(sources, revision.version),
          },
        );
        publication.edits = prepared.edits;
        assertPublicationSize(publication);
        return prepared.sources;
      });
    let revision: SourceRevision;
    try {
      if (this.#writer) {
        const sources = await prepare(head);
        const compiled = await this.#compilePrepared(sources, head.version);
        await verify(compiled);
        const dossier = await buildActivationCommand({
          repositoryId: this.#writer.repositoryId,
          approval: originalPublication,
          candidate,
          journal: await this.#operationJournal(head, compiled, prepared!),
          recipeDigest: await this.#writer.recipeDigest(),
        });
        revision = await this.#writer.publish(dossier);
      } else {
        revision = await this.repository.updateSystemSources(
          prepare,
          `ase:activate-candidate:${identity.builderId}`,
          { publication, verify },
        );
      }
    } catch (error) {
      if (refusal) throw refusal;
      // Two callers can pin different repository heads for the same unchanged
      // contract before either publishes. Recover only an exact active HEAD;
      // a removed or changed occurrence still propagates the receipt refusal.
      if (
        error instanceof ChangePublicationError &&
        error.code === "PUBLICATION_RECEIPT_MISMATCH"
      ) {
        try {
          const latest = await this.currentRevision(identity);
          return await this.#binding(
            latest,
            identity,
            candidate,
            one(latest, qualifiedName, "PartUsage"),
            true,
          );
        } catch { /* Preserve the original publication refusal. */ }
      }
      throw error;
    }
    if (publication.edits.length) {
      await assertPublishedEdits(
        revision,
        publication,
        identity.systemId,
      );
    }
    // The repository may have recovered an immutable publication. Read HEAD too:
    // a subsequent remove or replacement must never be undone by this retry.
    const latest = await this.currentRevision(identity);
    return await this.#binding(
      latest,
      identity,
      candidate,
      one(latest, qualifiedName, "PartUsage"),
      true,
    );
  }

  async graph(identity: ModelIdentity) {
    const revision = await this.currentRevision(identity);
    const graph = projectSourceGraph(
      revision.elements,
      this.#identity(revision),
    );
    // The declaration carries a status only for legacy or non-active entries;
    // its absence means active, exactly as the executable model reads it.
    const type = one(
      revision,
      "AssemblyLiveBuilder::ToolCandidate",
      "PartDefinition",
    );
    const implicit = new Set(
      revision.elements.filter((element) =>
        element["@type"] === "PartUsage" &&
        reference(element.owner) === identity.catalogId &&
        references(element.type).includes(id(type)) &&
        !revision.elements.some((entry) =>
          reference(entry.owner) === id(element) &&
          entry.declaredName === "status"
        )
      ).map((element) => id(element)),
    );
    return {
      ...graph,
      nodes: graph.nodes.map((node) =>
        implicit.has(node.nativeId) && node.modelStage === undefined
          ? { ...node, modelStage: "active" }
          : node
      ),
      modelRevision: revision.version,
    };
  }
}
