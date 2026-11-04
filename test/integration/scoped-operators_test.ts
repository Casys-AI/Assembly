import { createSourceModel } from "../../src/composition/source-model-services.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { isHostEdit } from "../../src/domain/model/publication/compatibility.ts";
import { MemorySourceRepository } from "../support/memory-source-repository.ts";
import { applyApprovedSourceChange } from "../support/approved-source-change.ts";
/** Multiple native scopes share source commits, never their local authority. */
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import assert from "node:assert/strict";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { validateSourceExecutable } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { discoverConversationUnits } from "../../src/domain/model/records/source-identity.ts";
import type { Candidate } from "../../src/domain/work/records/candidates.ts";
import { toolDraftDigest } from "../../src/application/work/artifacts/catalog.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const projectId = "git:5157347f-effe-5006-bc16-5c8de23f1a3b";

function twoUnits(sources: Record<string, string>, unitName = "collector") {
  const source = sources["configuration.sysml"]!;
  const code = source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"/g,
    (text) => text.replace(/[^\n]/g, " "),
  );
  const start = code.indexOf("part liveBuilder : ConversationSystem {");
  assert(start >= 0);
  const open = code.indexOf("{", start);
  let end = open + 1, depth = 1;
  while (depth && end < code.length) {
    if (code[end] === "{") depth++;
    if (code[end] === "}") depth--;
    end++;
  }
  assert.equal(depth, 0);
  const unit = source.slice(start, end)
    .replace(
      "part liveBuilder : ConversationSystem {",
      `part ${unitName} : ConversationSystem {
        attribute operatorName : String = "Collecteur";
        attribute operatorInstruction : String = "Examiner le dossier reçu et ses sources autorisées.";
        attribute primaryContact : Boolean = false;
        attribute humanInputEnabled : Boolean = false;`,
    )
    .replace(
      'configurationId : String = "live-builder-native"',
      `configurationId : String = "${unitName}-native"`,
    ) // B11: cloned unit keeps its own endpoint; drop the copied designer fields.
    .replace(
      /\n *attribute operatorName : String = "(?:Designer|Main Operator)";/,
      "",
    )
    .replace(
      /\n *attribute operatorInstruction : String = "Design and evolve this system with the person, and create operators to handle Requests\.";/,
      "",
    )
    .replace(/\n *attribute primaryContact : Boolean = true;/, "")
    .replace(/\n *attribute humanInputEnabled : Boolean = true;/, "");
  const close = source.lastIndexOf("\n}");
  assert(close > end);
  return {
    ...sources,
    "configuration.sysml": source.slice(0, close) + "\n    " + unit + "\n" +
      source.slice(close),
  };
}

/** Keep the shared executable admission gate in this repository fixture. */
function scopedCompiler() {
  const toolkit = new ToolkitCompiler({ packageDir: packageDir! });
  return {
    async compile(sources: Record<string, string>) {
      const compiled = await toolkit.compile(sources);
      await validateSourceExecutable({
        ...compiled,
        version: "compiled-before-publication",
      }, projectId);
      return compiled;
    },
    recipe: () => toolkit.recipe(),
  };
}

Deno.test({
  name:
    "native conversation scopes keep identities, authority and catalog observations separate",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sources = await loadInitialSources(undefined, { information: false });
    const compiler = new ToolkitCompiler({ packageDir: packageDir! });
    const legacy = await validateSourceExecutable({
      ...await compiler.compile(sources),
      version: "branch:legacy",
    }, projectId);
    // The canonical initial unit declares the Main Operator endpoint.
    assert.deepEqual(legacy.operator, {
      name: "Main Operator",
      instruction:
        "Design and evolve this system with the person, and create operators to handle Requests.",
      primary: true,
      humanInput: true,
    });
    assert.equal(legacy.identity.systemQualifiedName, undefined);
    const repository = new MemorySourceRepository(scopedCompiler());
    const primary = createSourceModel({
      tooling: new SysmlToolkitAdapter({
        packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
      }),
      repository,
      projectId,
      initialSources: twoUnits(sources),
    });
    const collector = createSourceModel({
      tooling: new SysmlToolkitAdapter({
        packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
      }),
      repository,
      projectId,
      systemQualifiedName: "AssemblyLiveBuilder::collector",
    });
    const primaryIdentity = await primary.initialize();
    const collectorIdentity = await collector.initialize();
    const units = discoverConversationUnits(
      await repository.current(),
      projectId,
    );
    assert.equal(units.length, 2);
    assert.notEqual(primaryIdentity.systemId, collectorIdentity.systemId);
    assert.notEqual(primaryIdentity.catalogId, collectorIdentity.catalogId);
    assert.notEqual(primaryIdentity.builderId, collectorIdentity.builderId);
    assert.equal(
      collectorIdentity.systemQualifiedName,
      "AssemblyLiveBuilder::collector",
    );
    const primaryBefore = await primary.readExecutableModel(primaryIdentity);
    const collectorBefore = await collector.readExecutableModel(
      collectorIdentity,
    );
    assert.notEqual(primaryBefore.version.digest, legacy.version.digest);
    const projected = await primary.graph(primaryIdentity);
    assert((projected.viewDiagnostics?.length ?? 0) > 0);
    assert.deepEqual(projected.executionDiagnostics, []);
    assert(
      projected.diagnostics.every((message) =>
        projected.viewDiagnostics!.includes(message)
      ),
    );
    assert.deepEqual(collectorBefore.operator, {
      name: "Collecteur",
      instruction: "Examiner le dossier reçu et ses sources autorisées.",
      primary: false,
      humanInput: false,
    });
    assert(
      primaryBefore.contracts.every((contract) =>
        !collectorBefore.contracts.some((other) =>
          other.nativeId === contract.nativeId
        )
      ),
    );
    await assert.rejects(
      () => primary.readExecutableModel(collectorIdentity),
      /Native model identity drift|Native conversation scope changed/,
    );
    const draft = {
      name: "extractor",
      description: "Scoped contract fixture",
      kind: "read_web_page" as const,
      code: "export default () => ({title:'Title',text:'Text'})",
    };
    const digest = await toolDraftDigest(draft);
    const candidate: Candidate = {
      ...draft,
      id: "shared-bytes-scoped-occurrences",
      digest,
      stage: "active",
      createdAt: "2026-10-21T00:00:00Z",
      baseCatalogRevision: 0,
      tests: { passed: true, checks: [] },
      admission: {
        candidateId: "shared-bytes-scoped-occurrences",
        candidateDigest: digest,
        mandateRevision: primaryBefore.configuration.builder.mandateRevision,
        configurationRevision: primaryBefore.configuration.revision,
        authority: "human",
        actorId: "owner",
        reason: "Scoped fixture activation",
        at: "2026-10-21T00:00:01Z",
      },
    };
    const primaryBinding = await primary.activateCandidate(
      primaryIdentity,
      candidate,
      primaryBefore.version.digest,
    );
    const collectorBinding = await collector.activateCandidate(
      collectorIdentity,
      candidate,
      collectorBefore.version.digest,
    );
    assert.notEqual(primaryBinding.elementId, collectorBinding.elementId);
    assert.match(collectorBinding.graphPath, /^collector\.catalog\./);
    assert.equal(
      (await primary.readExecutableModel(primaryIdentity)).catalog[0]!.status,
      "active",
    );
    assert.equal(
      (await collector.readExecutableModel(collectorIdentity)).catalog[0]!
        .status,
      "active",
    );
    assert.equal(
      (await primary.readExecutableModel(primaryIdentity)).version.digest,
      primaryBefore.version.digest,
    );
    assert.equal(
      (await collector.readExecutableModel(collectorIdentity)).version.digest,
      collectorBefore.version.digest,
    );
    const accepted = await repository.current();
    const changed = {
      ...accepted.sources,
      "configuration.sysml": accepted.sources["configuration.sysml"]!.replace(
        "Examiner le dossier reçu et ses sources autorisées.",
        "Examiner strictement le dossier transmis.",
      ),
    };
    const revised = await repository.publishSystemSources(
      changed,
      accepted.version,
      "qualification:instruction",
    );
    assert.equal(
      (await primary.validateRevision(revised)).version.digest,
      primaryBefore.version.digest,
    );
    assert.notEqual(
      (await collector.validateRevision(revised)).version.digest,
      collectorBefore.version.digest,
    );
    const collectorCurrent = await collector.readExecutableModel(
      collectorIdentity,
    );
    const reviewed = await applyApprovedSourceChange(
      collector,
      collectorIdentity,
      {
        id: crypto.randomUUID(),
        kind: "reviewer-creation",
        status: "approved",
        baseRevision: collectorCurrent.configuration.revision,
        baseModelDigest: collectorCurrent.version.digest,
        authorityExercise: exerciseOwnerAuthority(
          collectorCurrent,
          "mandate-change",
        ),
        reason: "Scoped reviewer qualification",
        requestedAt: "2026-10-21T00:00:00Z",
        decidedAt: "2026-10-21T00:01:00Z",
        authority: "human",
        role: "reviewer",
        name: "Scoped reviewer",
        mandate: {
          mayReviewExactCandidate: true,
          mayAdmitReviewedCandidates: true,
        },
      },
      collectorCurrent.version.digest,
    );
    assert.equal(reviewed.configuration.reviewer?.name, "Scoped reviewer");
    assert.equal(reviewed.configuration.builder.admissionAuthority, "reviewer");
    const primaryAfterReview = await primary.readExecutableModel(
      primaryIdentity,
    );
    assert.equal(primaryAfterReview.configuration.reviewer, undefined);
    assert.notEqual(
      primaryAfterReview.version.digest,
      primaryBefore.version.digest,
    );
    // The original endpoint can reuse the shared reviewed flow definitions without
    // rewriting the sibling's source-owned reviewer or creating duplicate types.
    const primaryReviewed = await applyApprovedSourceChange(
      primary,
      primaryIdentity,
      {
        id: crypto.randomUUID(),
        kind: "reviewer-creation",
        status: "approved",
        baseRevision: primaryAfterReview.configuration.revision,
        baseModelDigest: primaryAfterReview.version.digest,
        authorityExercise: exerciseOwnerAuthority(
          primaryAfterReview,
          "mandate-change",
        ),
        reason: "Second scoped reviewer qualification",
        requestedAt: "2026-10-21T00:02:00Z",
        decidedAt: "2026-10-21T00:03:00Z",
        authority: "human",
        role: "reviewer",
        name: "Primary reviewer",
        mandate: {
          mayReviewExactCandidate: true,
          mayAdmitReviewedCandidates: true,
        },
      },
      primaryAfterReview.version.digest,
    );
    assert.equal(
      primaryReviewed.configuration.reviewer?.name,
      "Primary reviewer",
    );
    assert.equal(
      (await collector.readExecutableModel(reviewed.identity)).configuration
        .reviewer?.name,
      "Scoped reviewer",
    );
  },
});

Deno.test({
  name:
    "shared revision validation refuses invalid sibling policy and partial endpoint metadata before publication",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sources = twoUnits(
      await loadInitialSources(undefined, { information: false }),
    );
    const repository = new MemorySourceRepository(scopedCompiler());
    const accepted = await repository.initialize(sources);
    const marker = sources["configuration.sysml"]!.indexOf(
      "part collector : ConversationSystem",
    );
    const before = sources["configuration.sysml"]!.slice(0, marker);
    const sibling = sources["configuration.sysml"]!.slice(marker);
    for (
      const [changed, expected] of [
        [
          sibling.replace("maxAgentDecisions = 7", "maxAgentDecisions = 0"),
          /Invalid native Integer maxAgentDecisions/,
        ],
        [
          sibling.replace("attribute humanInputEnabled : Boolean = false;", ""),
          /Incomplete native operator endpoint metadata/,
        ],
        [
          sibling.replace(
            "primaryContact : Boolean = false",
            "primaryContact : Boolean = true",
          ),
          /Invalid native operator endpoint metadata/,
        ],
        [
          sibling.replace(
            "humanInputEnabled : Boolean = false",
            'humanInputEnabled : String = "false"',
          ),
          /Invalid typed native literal humanInputEnabled/,
        ],
      ] as const
    ) {
      await assert.rejects(
        () =>
          repository.publishSystemSources(
            { ...sources, "configuration.sysml": before + changed },
            accepted.version,
            "qualification:invalid",
          ),
        expected,
      );
      assert.equal((await repository.current()).version, accepted.version);
      assert.equal(repository.versions.size, 1);
    }
  },
});

Deno.test({
  name:
    "main admission identity covers operator membership and human inbox grants without importing peer state",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const compiler = new ToolkitCompiler({ packageDir: packageDir! });
    const sources = twoUnits(
      await loadInitialSources(undefined, { information: false }),
    );
    const compile = async (set: Record<string, string>, scope?: string) =>
      await validateSourceExecutable(
        {
          ...await compiler.compile(set),
          version: "branch:membership-proof",
        },
        projectId,
        scope,
      );
    const primary = await compile(sources);
    const collector = await compile(sources, "AssemblyLiveBuilder::collector");
    const granted = {
      ...sources,
      "configuration.sysml": sources["configuration.sysml"]!.replace(
        "humanInputEnabled : Boolean = false",
        "humanInputEnabled : Boolean = true",
      ),
    };
    assert.notEqual(
      (await compile(granted)).version.digest,
      primary.version.digest,
    );
    const expanded = twoUnits(sources, "observer");
    assert.notEqual(
      (await compile(expanded)).version.digest,
      primary.version.digest,
    );
    assert.equal(
      (await compile(expanded, "AssemblyLiveBuilder::collector")).version
        .digest,
      collector.version.digest,
    );
    // Retiring the extra unit restores the same membership identity.
    assert.equal(
      (await compile(sources)).version.digest,
      primary.version.digest,
    );
    const renamedPeer = {
      ...sources,
      "configuration.sysml": sources["configuration.sysml"]!.replace(
        'operatorName : String = "Collecteur"',
        'operatorName : String = "Collecteur des sources"',
      ),
    };
    assert.equal(
      (await compile(renamedPeer)).version.digest,
      primary.version.digest,
    );
    assert.notEqual(
      (await compile(renamedPeer, "AssemblyLiveBuilder::collector")).version
        .digest,
      collector.version.digest,
    );
  },
});

Deno.test({
  name:
    "reviewer host operations preserve fully qualified types outside AssemblyLiveBuilder",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sources = await loadInitialSources(undefined, { information: false });
    const compiler = new ToolkitCompiler({ packageDir: packageDir! });
    const initial = await compiler.compile(sources);
    const system = initial.elements.find((e) =>
      e.qualifiedName === "AssemblyLiveBuilder::liveBuilder"
    )!;
    assert.equal(typeof system["sysx:sourceText"], "string");
    const declaration = String(system["sysx:sourceText"])
      .replace(
        "part liveBuilder : ConversationSystem {",
        `part foreign : AssemblyLiveBuilder::ConversationSystem {
        attribute operatorName : String = "Foreign operator";
        attribute operatorInstruction : String = "Review only the foreign scope.";
        attribute primaryContact : Boolean = false;
        attribute humanInputEnabled : Boolean = false;`,
      )
      .replace(
        'configurationId : String = "live-builder-native"',
        'configurationId : String = "foreign-native"',
      )
      // B11: cloned unit keeps its own endpoint; drop the copied designer fields.
      .replace(
        /\n *attribute operatorName : String = "(?:Designer|Main Operator)";/,
        "",
      )
      .replace(
        /\n *attribute operatorInstruction : String = "Design and evolve this system with the person, and create operators to handle Requests\.";/,
        "",
      )
      .replace(/\n *attribute primaryContact : Boolean = true;/, "")
      .replace(/\n *attribute humanInputEnabled : Boolean = true;/, "");
    const repository = new MemorySourceRepository(scopedCompiler());
    const tooling = new SysmlToolkitAdapter({ packageDir: packageDir! });
    const model = createSourceModel({
      repository,
      tooling,
      projectId,
      systemQualifiedName: "Foreign::foreign",
      initialSources: {
        ...sources,
        "foreign.sysml": `package Foreign {
    private import ScalarValues::*;
    private import AssemblyCore::*;
    private import AssemblyConversation::*;
    private import AssemblyExecution::*;
    private import APEPromotion::*;
    private import AssemblyLifecycle::*;
    private import AssemblyRequirements::*;
    private import AssemblyLiveBuilder::*;
${declaration}
}`,
      },
    });
    const identity = await model.initialize();
    const before = await model.readExecutableModel(identity);
    const changeId = crypto.randomUUID();
    const reviewed = await applyApprovedSourceChange(model, identity, {
      id: changeId,
      kind: "reviewer-creation",
      status: "approved",
      baseRevision: before.configuration.revision,
      baseModelDigest: before.version.digest,
      authorityExercise: exerciseOwnerAuthority(before, "mandate-change"),
      reason: "Foreign scope reviewer",
      requestedAt: "now",
      decidedAt: "later",
      authority: "human",
      role: "reviewer",
      name: "Foreign reviewer",
      mandate: {
        mayReviewExactCandidate: true,
        mayAdmitReviewedCandidates: true,
      },
    }, before.version.digest);
    assert.equal(reviewed.configuration.reviewer?.name, "Foreign reviewer");
    assert.equal(
      reviewed.flows.promotion.nodes.find((node) =>
        node.mechanism === "review_candidate"
      )!.performerId,
      reviewed.identity.reviewerId,
    );
    const current = await repository.current();
    assert(
      current.sources["foreign.sysml"]!.includes(
        "part reviewer : AssemblyLiveBuilder::IndependentReviewer",
      ),
    );
    assert(
      current.sources["foreign.sysml"]!.includes(
        "item reviewerMandate : AssemblyCore::ConfiguredMandate",
      ),
    );
    assert(
      current.sources["foreign.sysml"]!.includes(
        "perform action promotion : AssemblyLiveBuilder::ReviewedCapabilityPromotion;",
      ),
    );
    assert.equal(
      current.elements.some((e) =>
        e.qualifiedName === "AssemblyLiveBuilder::reviewerActions"
      ),
      false,
    );
    assert.equal(
      (await validateSourceExecutable(current, projectId)).configuration
        .reviewer,
      undefined,
    );
    const receipt = (await repository.findPublication(changeId))!.receipt;
    assert(receipt.edits.every((edit) => "op" in edit));
    assert.equal(
      receipt.edits.reduce(
        (count, edit) =>
          count +
          (isHostEdit(edit) && edit.op === "insertMember"
            ? edit.expect.length
            : 0),
        0,
      ),
      16,
    );
  },
});
