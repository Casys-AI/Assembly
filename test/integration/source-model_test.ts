import { createSourceModel } from "../../src/composition/source-model-services.ts";
import { ExplicitTooling } from "../support/explicit-tooling.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { MemorySourceRepository } from "../support/memory-source-repository.ts";
import { applyApprovedSourceChange } from "../support/approved-source-change.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { validateSourceExecutable } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { type SourceRepository } from "../../src/application/model/source-repository.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { sourceSnapshot } from "../../src/domain/model/projections/source-facts.ts";
import type { Candidate } from "../../src/domain/work/records/candidates.ts";
import type { ModelIdentity } from "../../src/domain/shared-kernel/model-identity.ts";
import type {
  PendingChange,
} from "../../src/domain/governance/records/pending-change.ts";
import type { ExecutableModel } from "../../src/domain/model/execution/executable-model.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { DYNAMIC_MANDATE_SOURCE } from "../../src/domain/governance/mandates.ts";

/** A view's members, whitespace and order aside: the contract of the writer's read-back. */
function sameMembers(actual: string, expected: string): boolean {
  const members = (text: string) =>
    text.split("\n").map((line) => line.trim()).filter(Boolean).sort().join(
      "\n",
    );
  return members(actual) === members(expected);
}
const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(
  action: () => Promise<unknown>,
  message: string,
  code?: string,
) {
  try {
    await action();
  } catch (error) {
    assert(String(error).includes(message), String(error));
    if (code) {
      assert(
        error && typeof error === "object" && "code" in error &&
          error.code === code,
      );
      assert("recovery" in error && error.recovery === "refuse");
      assert(
        "context" in error && error.context &&
          typeof error.context === "object",
      );
    }
    return;
  }
  throw new Error(`Expected rejection: ${message}`);
}

/** Real compiler, isolated in-memory repository: adapter tests do not depend on
 * a running SysON or mutate any persistent project. Repository durability has
 * its own integration proof. */

class ProposalRepository extends MemorySourceRepository {
  initializations = 0;
  proposals: Array<
    {
      baseVersion: string;
      sources: Record<string, string>;
      author: string;
      reason: string;
    }
  > = [];
  override async initialize(sources: Record<string, string>) {
    this.initializations++;
    return await super.initialize(sources);
  }
  override async propose(request: Parameters<SourceRepository["propose"]>[0]) {
    await this.compiler.compile(request.sources);
    this.proposals.push(structuredClone(request));
    return {
      id: "proposal-1",
      baseVersion: request.baseVersion,
      status: "proposed" as const,
    };
  }
}
function approved(
  base: ExecutableModel,
  requestedRights: PendingChange["requestedRights"],
): PendingChange {
  return {
    id: crypto.randomUUID(),
    kind: "mandate-change",
    status: "approved",
    baseRevision: base.configuration.revision,
    baseModelDigest: base.version.digest,
    authorityExercise: exerciseOwnerAuthority(base, "mandate-change"),
    reason: "Exact approval fixture",
    requestedAt: "2026-10-21T00:00:00Z",
    requestedRights,
    authority: "human",
    decidedAt: "2026-10-21T00:01:00Z",
  };
}

function admitted(
  candidate: Candidate,
  model: ExecutableModel,
  identity: ModelIdentity,
): Candidate {
  const authority = model.configuration.builder.admissionAuthority;
  return {
    ...candidate,
    tests: { passed: true, checks: [] },
    admission: {
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      mandateRevision: model.configuration.builder.mandateRevision,
      configurationRevision: model.configuration.revision,
      authority,
      actorId: authority === "builder"
        ? identity.builderId
        : authority === "reviewer"
        ? identity.reviewerId!
        : identity.rootId,
      reason: "Approved exact candidate in adapter fixture",
      at: "2026-10-21T00:01:00Z",
    },
  };
}

Deno.test({
  name:
    "Toolkit adapter uses source authority, exact approved changes and immutable candidate bindings",
  ignore: !toolkitIntegrationEnabled,
  fn: async () => {
    const repository = new ProposalRepository(
      new ToolkitCompiler({ packageDir: packageDir! }),
    );
    const model = createSourceModel({
      tooling: new SysmlToolkitAdapter({
        packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
      }),
      repository,
      projectId: "git:cdc1ab4f-083e-533c-90ca-953c38b63a92",
    });
    const identity = await model.initialize();
    const initial = await model.readExecutableModel(identity);
    assert(initial.configuration.builder.admissionAuthority === "human");
    assert(
      identity.rootId !== identity.systemId &&
        identity.rootId.endsWith("/root"),
    );
    const raw = await model.readSourceRevision(identity);
    const expectations = structuredClone(initial.configuration);
    expectations.network = { allowedHosts: ["casys.ai"] };
    await rejects(
      () => model.syncConfiguration(identity, expectations),
      "differs from admitted SysML",
    );
    assert(
      (await repository.current()).version === raw.version,
      "Runtime expectations rewrote sources",
    );
    const foreignApproval = approved(initial, {
      addNetworkHosts: ["casys.ai"],
    });
    foreignApproval.authorityExercise!.rootGrantId = "another-root";
    await rejects(
      () =>
        applyApprovedSourceChange(
          model,
          identity,
          foreignApproval,
          initial.version.digest,
        ),
      "prior model",
    );
    const noBase = approved(initial, { addNetworkHosts: ["casys.ai"] });
    delete noBase.baseModelDigest;
    await rejects(
      () =>
        applyApprovedSourceChange(
          model,
          identity,
          noBase,
          initial.version.digest,
        ),
      "prior model",
    );
    assert(
      (await repository.current()).version === raw.version,
      "Rejected owner authority rewrote sources",
    );

    const network = await applyApprovedSourceChange(
      model,
      identity,
      approved(initial, {
        addNetworkHosts: ["casys.ai"],
      }),
      initial.version.digest,
    );
    assert(network.configuration.network!.allowedHosts.join() === "casys.ai");
    assert(
      network.configuration.revision === initial.configuration.revision + 1,
    );
    await rejects(
      () =>
        applyApprovedSourceChange(
          model,
          identity,
          approved(initial, {
            mayAdmitOwnCandidates: true,
          }),
          initial.version.digest,
        ),
      "changed before source approval",
    );
    const delegated = await applyApprovedSourceChange(
      model,
      identity,
      approved(network, { mayAdmitOwnCandidates: true }),
      network.version.digest,
    );
    assert(
      delegated.configuration.builder.admissionAuthority === "builder" &&
        delegated.mandate.mayAdmitOwnCandidates === true,
    );

    const candidate: Candidate = {
      id: "candidate-model-adapter",
      digest: "a".repeat(64),
      name: 'Quoted "tool" ; } // value',
      description: "A source string",
      kind: "read_web_page",
      code: "export default () => ({title:'Title',text:'Text'})",
      stage: "proposed",
      createdAt: "2026-10-21T00:00:00Z",
      baseCatalogRevision: 0,
      requiredAuthority: "builder",
      proposedConfigurationRevision: delegated.configuration.revision,
    };
    const beforeActivation = await repository.current();
    assert((await model.readExecutableModel(identity)).catalog.length === 0);
    assert((await model.findCandidate(identity, candidate)) === null);
    const binding = await model.activateCandidate(
      identity,
      admitted(candidate, delegated, identity),
      delegated.version.digest,
    );
    assert(
      (await model.findCandidate(identity, candidate))?.elementId ===
        binding.elementId,
    );
    const afterActivation = await model.readExecutableModel(identity);
    assert(
      afterActivation.catalog[0]!.kind === candidate.kind &&
        afterActivation.catalog[0]!.status === "active",
    );
    assert(
      afterActivation.version.digest === delegated.version.digest,
      "Catalog activation changed execution-structure digest",
    );
    assert(
      !((await repository.current()).sources["configuration.sysml"] ?? "")
        .includes("attribute status : ScalarValues::String"),
      "A new activation must not write an operational status into SysML",
    );
    assert((await repository.current()).version !== beforeActivation.version);
    assert(
      JSON.stringify(
        await model.activateCandidate(identity, {
          ...admitted(candidate, delegated, identity),
          stage: "reviewing",
        }, delegated.version.digest),
      ) === JSON.stringify(binding),
      "A repeated activation must reuse the same native binding",
    );
    const graph = await model.graph(identity);
    // No status attribute was written, and the absence still reads as active.
    assert(
      graph.nodes.some((node) =>
        node.nativeId === binding.elementId && node.modelStage === "active"
      ),
      "A newly active tool must show its model state, not an unread one",
    );
  },
});

Deno.test({
  name: "initial model declares the Main Operator as primary operator (B11)",
  ignore: !toolkitIntegrationEnabled,
  fn: async () => {
    const repository = new ProposalRepository(
      new ToolkitCompiler({ packageDir: packageDir! }),
    );
    const model = createSourceModel({
      tooling: new SysmlToolkitAdapter({
        packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
      }),
      repository,
      projectId: "git:cdc1ab4f-083e-533c-90ca-953c38b63a92",
      initialSources: await loadInitialSources(undefined, {
        information: false,
      }),
    });
    const identity = await model.initialize();
    const executable = await model.readExecutableModel(identity);
    assert(executable.operator?.primary === true, "designer must be primary");
    assert(
      executable.operator?.humanInput === true,
      "designer must accept human input",
    );
    assert(executable.operator?.name === "Main Operator");
    assert(
      executable.operator?.instruction ===
        "Design and evolve this system with the person, and create operators to handle Requests.",
    );
  },
});

Deno.test({
  name:
    "Toolkit adapter writes native contract bindings to catalog-owned contracts and rejects a removed link",
  ignore: !toolkitIntegrationEnabled,
  fn: async () => {
    const sources = await loadInitialSources(undefined, { information: false });
    sources["configuration.sysml"] = sources["configuration.sysml"]!.replace(
      "item readWebPageContract : CapabilityContract",
      "item admittedHtmlContract : CapabilityContract",
    );
    const repository = new ProposalRepository(
      new ToolkitCompiler({ packageDir: packageDir! }),
    );
    const model = createSourceModel({
      tooling: new SysmlToolkitAdapter({
        packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
      }),
      repository,
      projectId: "git:3cdd6d04-2d48-576e-a1cc-db11aef7df02",
      initialSources: sources,
    });
    const identity = await model.initialize();
    const candidates: Candidate[] = [];
    for (const kind of ["read_web_page", "read_web_page_outline"] as const) {
      const candidate: Candidate = {
        id: `candidate-${kind}`,
        digest: "b".repeat(64),
        name: `native-${kind}`,
        description: "Native contract writer fixture",
        kind,
        code: "export default () => ({title:'Title',text:'Text'})",
        stage: "proposed",
        createdAt: "2026-10-21T00:00:00Z",
        baseCatalogRevision: 0,
      };
      candidates.push(candidate);
      const admittedModel = await model.readExecutableModel(identity);
      const binding = await model.activateCandidate(
        identity,
        admitted(candidate, admittedModel, identity),
        admittedModel.version.digest,
      );
      const revision = await repository.current();
      const executable = await model.readExecutableModel(identity);
      const entry = executable.catalog.find((entry) =>
        entry.nativeId === binding.elementId
      );
      const contract = executable.contracts.find((contract) =>
        contract.nativeId === entry?.contractId
      );
      assert(contract?.kind === kind, "Writer bound the wrong native contract");
      const snapshot = sourceSnapshot(revision.elements, identity.rootId);
      const occurrence = snapshot.elements.find((element) =>
        element.id === contract.nativeId
      );
      assert(
        occurrence?.ownerId === identity.catalogId &&
          occurrence.metaclass === "ItemUsage" && !occurrence.isReference,
        "Contract is not an owned catalog occurrence",
      );
      if (kind === "read_web_page") {
        assert(occurrence.name === "admittedHtmlContract");
      }
      const feature = snapshot.elements.find((element) =>
        element.qualifiedName === "AssemblyLiveBuilder::ToolCandidate::contract"
      );
      assert(feature?.isReference, "ToolCandidate contract is not a reference");
      const links = snapshot.connectors.filter((connector) =>
        connector.ownerId === binding.elementId &&
        connector.metaclass === "BindingConnectorAsUsage"
      );
      assert(links.length === 1, "Writer did not emit exactly one native link");
      assert(
        JSON.stringify(
          links[0]!.ends.map((end) => end.chain.map((segment) => segment.id)),
        ) === JSON.stringify([
          [feature.id],
          [identity.systemId, identity.catalogId, contract.nativeId],
        ]),
        "Compiled binding does not reference the exact catalog contract",
      );
    }
    const before = await repository.current();
    await repository.publishSystemSources(
      {
        ...before.sources,
        "configuration.sysml": before.sources["configuration.sysml"]!.replace(
          /\s*bind contract = AssemblyLiveBuilder::liveBuilder\.catalog\.admittedHtmlContract;/,
          "",
        ),
      },
      before.version,
      "test:remove-explicit-contract-link",
    );
    await rejects(
      () => model.findCandidate(identity, candidates[0]!),
      "contract binding",
    );
  },
});

Deno.test({
  name: "legacy non-active catalog occurrence activates with one status edit",
  ignore: !toolkitIntegrationEnabled,
  fn: async () => {
    const candidate: Candidate = {
      id: "legacy-candidate-for-activation",
      name: "Legacy page reader",
      description: "Historical catalog occurrence",
      kind: "read_web_page",
      code: "export default () => ({title:'Title',text:'Text'})",
      digest: "c".repeat(64),
      stage: "awaiting-admission",
      createdAt: "2026-10-21T00:00:00Z",
      baseCatalogRevision: 0,
    };
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(candidate.id),
      ),
    );
    const name = "tool_" +
      Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
        .slice(0, 24);
    const sources = await loadInitialSources(undefined, { information: false });
    const marker = "part catalog : ToolCatalog {";
    assert(sources["configuration.sysml"]!.includes(marker));
    sources["configuration.sysml"] = sources["configuration.sysml"]!.replace(
      marker,
      `${marker}\n            part ${name} : AssemblyLiveBuilder::ToolCandidate {
                attribute candidateId : ScalarValues::String = ${
        JSON.stringify(candidate.id)
      };
                attribute name : ScalarValues::String = ${
        JSON.stringify(candidate.name)
      };
                attribute kind : ScalarValues::String = ${
        JSON.stringify(candidate.kind)
      };
                attribute digest : ScalarValues::String = ${
        JSON.stringify(candidate.digest)
      };
                attribute status : ScalarValues::String = "awaiting-admission";
                bind contract = AssemblyLiveBuilder::liveBuilder.catalog.readWebPageContract;
            }`,
    );
    const repository = new ProposalRepository(
      new ToolkitCompiler({ packageDir: packageDir! }),
    );
    const model = createSourceModel({
      repository,
      tooling: new SysmlToolkitAdapter({ packageDir: packageDir! }),
      projectId: `git:${crypto.randomUUID()}`,
      initialSources: sources,
    });
    const identity = await model.initialize();
    const before = await model.readExecutableModel(identity);
    assert(before.catalog.length === 1);
    assert(before.catalog[0]!.status === "awaiting-admission");
    const existing = await model.findCandidate(identity, candidate);
    assert(existing);
    assert(
      (await model.graph(identity)).nodes.some((node) =>
        node.nativeId === existing.elementId &&
        node.modelStage === "awaiting-admission"
      ),
      "A legacy status is still shown as the model state",
    );
    const binding = await model.activateCandidate(
      identity,
      admitted(candidate, before, identity),
      before.version.digest,
    );
    assert(binding.elementId === existing.elementId);
    assert(
      (await model.readExecutableModel(identity)).catalog[0]!.status ===
        "active",
    );
    assert(
      (await model.graph(identity)).nodes.some((node) =>
        node.nativeId === existing.elementId && node.modelStage === "active"
      ),
    );
    const publications = [...repository.publications.values()];
    assert(publications.length === 1);
    const receipt = publications[0]!.receipt;
    assert(receipt.type === "candidate-activation");
    assert(receipt.edits.length === 1);
    assert(
      "op" in receipt.edits[0]! &&
        receipt.edits[0]!.op === "setFeatureValue",
    );
  },
});

Deno.test({
  name:
    "Toolkit adapter creates exact approved reviewer and preserves source-only proposals",
  ignore: !toolkitIntegrationEnabled,
  fn: async () => {
    const repository = new ProposalRepository(
      new ToolkitCompiler({ packageDir: packageDir! }),
    );
    const model = createSourceModel({
      tooling: new SysmlToolkitAdapter({
        packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
      }),
      repository,
      projectId: "git:5d4258ab-6121-58ab-b1ec-ad9e13d294e3",
      initialSources: await loadInitialSources(undefined, {
        information: false,
      }),
    });
    const identity = await model.initialize();
    const base = await model.readExecutableModel(identity);
    const networkChange = approved(base, {
      addNetworkHosts: ["recovery.example"],
    });
    const initial = await applyApprovedSourceChange(
      model,
      identity,
      networkChange,
      base.version.digest,
    );
    const change: PendingChange = {
      id: "reviewer-change-1",
      kind: "reviewer-creation",
      status: "approved",
      baseRevision: initial.configuration.revision,
      baseModelDigest: initial.version.digest,
      authorityExercise: exerciseOwnerAuthority(initial, "mandate-change"),
      reason: "Independent review",
      requestedAt: "2026-10-21T00:00:00Z",
      role: "reviewer",
      name: "Reviewer source",
      mandate: {
        mayReviewExactCandidate: true,
        mayAdmitReviewedCandidates: true,
      },
      decidedAt: "2026-10-21T00:01:00Z",
      authority: "human",
    };
    const reviewed = await applyApprovedSourceChange(
      model,
      identity,
      change,
      initial.version.digest,
    );
    assert(
      reviewed.identity.reviewerId &&
        reviewed.configuration.reviewer?.name === "Reviewer source",
    );
    assert(reviewed.configuration.builder.admissionAuthority === "reviewer");
    // B1: adoption has installed reviewerId; recovering the older publication
    // must neither load its base nor rerun the source transformer.
    const originalAt = repository.at.bind(repository);
    repository.at = () => {
      throw new Error("Historical base must not be loaded");
    };
    const recovered = await model.findApprovedChange(
      reviewed.identity,
      networkChange.id,
    );
    assert(recovered?.model.version.digest === initial.version.digest);
    assert(
      recovered.receipt?.authorityExercise.rootGrantId ===
        networkChange.authorityExercise?.rootGrantId,
    );
    repository.at = originalAt;

    assert(
      repository.versions.size === 3,
      "Reviewer creation was not one atomic revision",
    );
    const admitted = await repository.current();
    const reviewerSource = admitted.sources["configuration.sysml"]!;
    assert(
      reviewerSource.includes(
        `attribute :>> source = ${JSON.stringify(DYNAMIC_MANDATE_SOURCE)};`,
      ),
    );
    assert(
      reviewerSource.includes(
        "perform action promotion : AssemblyLiveBuilder::ReviewedCapabilityPromotion;",
      ),
    );
    assert(reviewerSource.includes("allocate promotion.review to reviewer;"));
    assert(!reviewerSource.includes("perform action review :"));
    assert(reviewerSource.includes("bind admit.review = review.decision;"));
    assert(reviewerSource.includes("if review.decision.approved then admit;"));
    assert(
      reviewerSource.includes(
        "expose liveBuilder::promotion::review::decision;",
      ),
    );
    // S12: creation exposes the reviewer view from the agent overview.
    const overviewAt = reviewerSource.indexOf("view agentOverview");
    assert(overviewAt >= 0, "agentOverview view is missing after creation");
    assert(
      reviewerSource.slice(overviewAt, reviewerSource.indexOf("}", overviewAt))
        .includes("expose reviewerActions;"),
      "Creation did not add 'expose reviewerActions;' to agentOverview",
    );
    // C4: the builderActions view is restored, member for member.
    const builderBlock = (text: string) => {
      const start = text.indexOf("view builderActions");
      assert(start >= 0, "builderActions view is missing");
      return text.slice(start, text.indexOf("}", start) + 1);
    };
    const initialSources = await loadInitialSources(undefined, {
      information: false,
    });
    assert(
      sameMembers(
        builderBlock(reviewerSource),
        builderBlock(initialSources["configuration.sysml"]!),
      ),
      "Creation did not restore builderActions",
    );
    const snapshot = sourceSnapshot(
      admitted.elements,
      reviewed.identity.rootId,
    );
    const review = snapshot.elements.find((element) =>
      element.qualifiedName ===
        "AssemblyLiveBuilder::ReviewedCapabilityPromotion::review"
    );
    assert(
      review?.metaclass === "ActionUsage",
      "Review is not a native flow action",
    );
    assert(
      !snapshot.elements.some((element) =>
        element.qualifiedName === "AssemblyLiveBuilder::liveBuilder::review"
      ),
      "An isolated review action survived creation",
    );
    const current = await model.readSourceRevision(reviewed.identity);
    await rejects(() =>
      model.proposeRevision(reviewed.identity, {
        baseVersion: current.version,
        reason: "Improve explanatory text without an edit mandate",
        sources: {
          "core.sysml": current.sources["core.sysml"]!.replace(
            "Neutral structural primitives",
            "Shared structural primitives",
          ),
        },
      }, reviewed.version.digest), "ne délègue aucun périmètre");
    assert(repository.proposals.length === 0, "Denied edit created a proposal");
    assert(
      (await repository.current()).version === current.version,
      "Denied edit mutated admitted main",
    );
    await rejects(() =>
      model.proposeRevision(reviewed.identity, {
        baseVersion: current.version,
        reason: "Stale execution proposal",
        sources: {},
      }, initial.version.digest), "Execution model changed");
  },
});

Deno.test({
  name:
    "Toolkit approved URL selection change uses the canonical setUrlSelectionMode request",
  ignore: !toolkitIntegrationEnabled,
  fn: async () => {
    const repository = new ProposalRepository(
      new ToolkitCompiler({ packageDir: packageDir! }),
    );
    const model = createSourceModel({
      tooling: new SysmlToolkitAdapter({
        packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
      }),
      repository,
      projectId: "git:2e0cad02-376b-5b29-81ab-acfa92841d86",
    });
    const identity = await model.initialize();
    const before = await model.readExecutableModel(identity);
    assert(before.policy.urlSelectionMode === "user-provided");
    const after = await applyApprovedSourceChange(
      model,
      identity,
      approved(before, {
        setUrlSelectionMode: "authorized-host",
      }),
      before.version.digest,
    );
    assert(after.policy.urlSelectionMode === "authorized-host");
    const revision = await repository.current();
    const snapshot = sourceSnapshot(revision.elements, identity.rootId);
    const conversation = snapshot.elements.find((element) =>
      element.qualifiedName === "AssemblyLiveBuilder::liveBuilder::conversation"
    );
    const policy = snapshot.elements.find((element) =>
      element.qualifiedName ===
        "AssemblyLiveBuilder::liveBuilder::conversation::executionPolicy"
    );
    assert(
      conversation?.metaclass === "PerformActionUsage" &&
        policy?.ownerId === conversation.id && policy.metaclass === "ItemUsage",
      "URL policy edit did not retain native ownership under ConversationCase",
    );
    assert(
      after.version.digest !== before.version.digest,
      "Source URL policy change was not reflected in the execution contract",
    );
    assert(
      JSON.stringify(after.configuration.network) ===
        JSON.stringify(before.configuration.network),
      "Changing URL selection added network scope",
    );
  },
});

Deno.test({
  name:
    "Toolkit adapter explicitly refuses a legacy SysON identity before provisioning",
  ignore: !toolkitIntegrationEnabled,
  fn: async () => {
    const repository = new ProposalRepository(
      new ToolkitCompiler({ packageDir: packageDir! }),
    );
    const model = createSourceModel({
      tooling: new SysmlToolkitAdapter({
        packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
      }),
      repository,
      projectId: "git:67486ee4-3982-56a3-9983-99a7dcca878e",
    });
    await rejects(
      () =>
        model.initialize({
          projectId: "syson-project",
          editingContextId: "syson-context",
          rootId: "root",
          systemId: "system",
          builderId: "builder",
          catalogId: "catalog",
        }),
      // A SysON-era identity is foreign to a Toolkit project instance.
      "Foreign model identity",
    );
    assert(
      repository.initializations === 0,
      "Legacy restore provisioned a new repository silently",
    );
  },
});

Deno.test({
  name:
    "Toolkit executable admission gate rejects valid SysML with unsupported execution policy before publication",
  ignore: !toolkitIntegrationEnabled,
  fn: async () => {
    const repository = new ProposalRepository(
      new ToolkitCompiler({ packageDir: packageDir! }),
    );
    const model = createSourceModel({
      tooling: new SysmlToolkitAdapter({
        packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
      }),
      repository,
      projectId: "git:8dda1076-b051-5966-be5d-f2e077dc38d9",
    });
    const identity = await model.initialize();
    const before = await repository.current();
    const sources = {
      ...before.sources,
      "configuration.sysml": before.sources["configuration.sysml"]!.replace(
        "maxAgentDecisions = 7",
        "maxAgentDecisions = 0",
      ),
    };
    assert(
      sources["configuration.sysml"] !== before.sources["configuration.sysml"],
      "Policy anchor missing",
    );
    const compiled = await repository.compiler.compile(sources);
    await rejects(
      () =>
        validateSourceExecutable({
          ...compiled,
          version: "compiled-unpublished",
        }, identity.projectId),
      "Invalid native Integer maxAgentDecisions",
    );
    assert(
      (await repository.current()).version === before.version,
      "Validation gate admitted an unsupported model",
    );
  },
});

Deno.test({
  name:
    "Toolkit initial source loader composes complete modules and native views",
  fn: async () => {
    const sources = await loadInitialSources();
    assert(Object.keys(sources).includes("execution.sysml"));
    assert(sources["configuration.sysml"]!.includes("view agentOverview"));
    assert(!Object.keys(sources).includes("configuration-views.sysml"));
    assert(!Object.keys(sources).includes("system.sysml"));
  },
});

Deno.test({
  name:
    "Toolkit initialization provisions only an empty configuration identity and keeps it on restart",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sources = await loadInitialSources(undefined, { information: false });
    sources["configuration.sysml"] = sources["configuration.sysml"]!.replace(
      'configurationId : String = "live-builder-native"',
      'configurationId : String = ""',
    );
    const repository = new MemorySourceRepository(
      new ToolkitCompiler({ packageDir: packageDir! }),
    );
    const model = createSourceModel({
      repository,
      tooling: new SysmlToolkitAdapter({ packageDir: packageDir! }),
      initialSources: sources,
      projectId: "git:00000000-0000-4000-8000-000000000002",
    });
    const identity = await model.initialize();
    const executable = await model.readExecutableModel(identity);
    assert(executable.configuration.id.length > 0);
    assert(executable.configuration.revision === 0);
    assert(repository.versions.size === 2);
    const initial = await repository.at("memory:1");
    const current = await repository.current();
    // The rest of the source text remains byte-for-byte identical.
    assert(
      current.sources["configuration.sysml"] ===
        initial.sources["configuration.sysml"]!.replace(
          'configurationId : String = ""',
          `configurationId : String = ${
            JSON.stringify(executable.configuration.id)
          }`,
        ),
    );
    for (
      const path of Object.keys(initial.sources).filter((path) =>
        path !== "configuration.sysml"
      )
    ) assert(current.sources[path] === initial.sources[path]);
    const reopened = createSourceModel({
      tooling: new ExplicitTooling(),
      repository,
      initialSources: sources,
      projectId: identity.projectId,
    });
    await reopened.initialize(identity);
    assert((await repository.current()).version === current.version);
    assert(repository.versions.size === 2);
    assert(
      (await model.readExecutableModel(identity)).configuration.id ===
        executable.configuration.id,
    );
  },
});

Deno.test({
  name:
    "Explicit read-only tooling refuses provisioning and leaves the repository head unchanged",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sources = await loadInitialSources(undefined, { information: false });
    sources["configuration.sysml"] = sources["configuration.sysml"]!.replace(
      'configurationId : String = "live-builder-native"',
      'configurationId : String = ""',
    );
    const repository = new MemorySourceRepository(
      new ToolkitCompiler({ packageDir: packageDir! }),
    );
    const head = await repository.initialize(sources);
    const model = createSourceModel({
      tooling: new ExplicitTooling(),
      repository,
      initialSources: sources,
      projectId: "git:00000000-0000-4000-8000-000000000002",
    });
    await rejects(
      () => model.initialize(),
      "Explicit test tooling forbids source writes",
    );
    assert((await repository.current()).version === head.version);
    assert(repository.versions.size === 1);
  },
});
