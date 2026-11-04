import { legacyProductName } from "../../src/domain/model/sysml-product-names.ts";
/** Synthetic source fixtures adapted from the B0 scratchpad matrix-fixtures.ts
 * (session 34422f06-997d-42d8-8297-3e654b079992, copied 2026-10-25).
 * Build from repository sources in memory; never write a model repository. */
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
import type { ModelDelegationRecord } from "../../src/domain/governance/policies/model-delegation.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { loadSysmlToolkit } from "../../src/adapters/out/sysml-toolkit/runtime/loader.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { validateSourceExecutables } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { type SourceRevision } from "../../src/domain/model/records/source-revision.ts";
import { delegationIdentity } from "../../src/application/governance/model-access/delegation/state.ts";
import { renderModelDelegations } from "../../src/domain/governance/policies/model-delegation-ledger.ts";

export interface MatrixFixtureContext {
  packageDir: string;
  projectId: string;
}
export type MatrixSourceFixtureName =
  | "fixture-reviewer-policies"
  | "fixture-delegation";

const json = (value: unknown) => JSON.stringify(JSON.stringify(value));

function insertAfter(text: string, marker: string, fragment: string): string {
  const parts = text.split(marker);
  if (parts.length !== 2) throw new Error(`Expected exactly one ${marker}`);
  return parts[0] + marker + "\n" + fragment + parts[1];
}

async function compileRevision(
  ctx: MatrixFixtureContext,
  sources: Sources,
): Promise<SourceRevision> {
  const compiler = new ToolkitCompiler({
    packageDir: ctx.packageDir,
    loadRuntime: () => loadSysmlToolkit(ctx.packageDir),
  });
  const compiled = await compiler.compile(sources);
  return { version: "fixture", sources, elements: compiled.elements };
}

/** initial + independent reviewer + edit policy + administration policy + a disabled exposure. */
async function reviewerAndPolicies(
  _ctx: MatrixFixtureContext,
): Promise<Sources> {
  const sources: Sources = await loadInitialSources();
  const marker = "part liveBuilder : ConversationSystem {";
  let reviewer = await Deno.readTextFile(
    new URL("../../models/configuration-reviewer.sysml", import.meta.url),
  );
  reviewer = reviewer.replace(
    "part reviewer : AssemblyLiveBuilder::IndependentReviewer;",
    `part reviewer : IndependentReviewer { attribute operatorId : ScalarValues::String = "reviewer-1"; attribute configuredName : ScalarValues::String = "Independent reviewer"; }`,
  );
  const reviewerAccess = `
part reviewerListsSkills : AssemblyInvocations::BehaviorAccess {
    attribute :>> name = "ReviewerListsSkills";
    attribute :>> description = "The reviewer lists installed skills.";
    attribute :>> enabled = true;
    ref item :>> input : APESkills::ListSkillsRequest;
}
bind reviewerListsSkills.caller = reviewer;
bind reviewerListsSkills.target = context.skills.list;
`;
  const editPolicy = `
part modelEditing : AssemblyModelEditing::ModelEditPolicy {
  attribute :>> id = "edit-policy-v1";
  attribute :>> revision = 1;
  attribute :>> operations = ${json(["set-value", "insert-member"])};
  attribute :>> grants = ${
    json([{
      file: "configuration.sysml",
      qualifiedRoots: ["AssemblyLiveBuilder::liveBuilder"],
    }])
  };
}
bind modelEditing.holder = builder;
bind modelEditing.mandate = builderMandate;
bind modelEditing.issuer = owner.ownerMandate.rootAuthority;
part modelAdministration : AssemblyModelAdministration::ModelAdministrationPolicy {
  attribute :>> id = "admin-policy-v1";
  attribute :>> revision = 1;
  attribute :>> operations = ${json(["set-value"])};
  attribute :>> recipients = ${json(["AssemblyLiveBuilder::mandatePeer"])};
  attribute :>> maxRedelegationDepth = 2;
  attribute :>> grants = ${
    json([{
      file: "configuration.sysml",
      qualifiedRoots: ["AssemblyLiveBuilder::liveBuilder"],
    }])
  };
}
bind modelAdministration.holder = builder;
bind modelAdministration.mandate = builderMandate;
bind modelAdministration.issuer = owner.ownerMandate.rootAuthority;
`;
  let configuration = sources["configuration.sysml"]!;
  configuration = insertAfter(
    configuration,
    marker,
    reviewer + reviewerAccess + editPolicy,
  );
  configuration = configuration.replace(
    'attribute admissionMode : String = "human";',
    'attribute admissionMode : String = "reviewer";',
  );
  // disable RetirerMemoire (ListerSkills cannot be disabled: loaded initial skills require it)
  const at = configuration.indexOf('"RetirerMemoire"');
  const enabled = configuration.indexOf("enabled = true", at);
  if (at < 0 || enabled < 0) {
    throw new Error("RetirerMemoire exposure not found");
  }
  configuration = configuration.slice(0, enabled) + "enabled = false" +
    configuration.slice(enabled + "enabled = true".length);
  // the reviewer view that ASE's reviewer change always adds (and migrates)
  const views = (await Deno.readTextFile(
    new URL(
      "../../models/configuration-reviewer-views.sysml",
      import.meta.url,
    ),
  )).trim();
  configuration = insertAfter(
    configuration,
    "view agentOverview : StandardViewDefinitions::GeneralView {",
    "    expose reviewerActions;",
  );
  const close = configuration.lastIndexOf("}");
  configuration = configuration.slice(0, close) + "\n" + views + "\n" +
    configuration.slice(close);
  // Build the reviewed promotion before validation: current Toolkit rejects the
  // old scratch fixture's temporary references to a not-yet-created review.
  const promotion = await Deno.readTextFile(
    new URL(
      "../../models/configuration-reviewed-promotion.sysml",
      import.meta.url,
    ),
  );
  configuration = configuration.replace(marker, promotion + "\n" + marker)
    .replace(
      "perform action promotion : CapabilityPromotion;",
      "perform action promotion : ReviewedCapabilityPromotion;",
    );
  sources["configuration.sysml"] = configuration;
  return sources;
}

/** commercial-watch where the coordinator administers and delegates edit rights to the collector. */
async function delegation(ctx: MatrixFixtureContext): Promise<Sources> {
  const base: Sources = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../fixtures/commercial-watch/sources.json",
        import.meta.url,
      ),
    ),
  );
  const sources: Sources = { ...base };
  // Keep the historical example source family. Adapt only fresh shared
  // library imports in this temporary input, preserving its ASE native roots.
  for (const name of ["core", "authority", "model-administration"]) {
    sources[`${name}.sysml`] = (await Deno.readTextFile(
      new URL(`../../models/${name}.sysml`, import.meta.url),
    )).replace(/\bAssembly[A-Za-z]+\b/g, legacyProductName);
  }
  // the collector loses its own edit policy; it will receive one by delegation
  const collect = sources["collect.sysml"]!;
  const start = collect.indexOf(
    "part modelEditing : ASEModelEditing::ModelEditPolicy {",
  );
  const end = collect.indexOf("bind modelEditing.mandate = builderMandate;");
  if (start < 0 || end < 0) throw new Error("collector edit policy not found");
  sources["collect.sysml"] = collect.slice(0, start) +
    collect.slice(end + "bind modelEditing.mandate = builderMandate;".length);
  sources["collect.sysml"] = sources["collect.sysml"]!.replace(
    "        bind modelEditing.holder = builder;\n",
    "",
  );
  const admin = `
part modelAdministration : ASEModelAdministration::ModelAdministrationPolicy {
  attribute :>> id = "coordinator-administration";
  attribute :>> revision = 1;
  attribute :>> operations = ${json(["set-value", "rename"])};
  attribute :>> recipients = ${json(["ASECollect::collector"])};
  attribute :>> maxRedelegationDepth = 1;
  attribute :>> grants = ${
    json([{
      file: "mission.sysml",
      qualifiedRoots: ["CommercialWatchMission::sourcePolicy"],
    }])
  };
}
bind modelAdministration.holder = builder;
bind modelAdministration.mandate = builderMandate;
`;
  sources["configuration.sysml"] = insertAfter(
    sources["configuration.sysml"]!,
    "part liveBuilder : ConversationSystem {",
    admin,
  );
  // pass 1: obtain the root authority digest and the recipient identity
  const first = await compileRevision(ctx, sources);
  const units = await validateSourceExecutables(first, ctx.projectId);
  const issuer = units.find((u) =>
    u.unit.systemQualifiedName === "ASELiveBuilder::liveBuilder"
  )!;
  const target = units.find((u) =>
    u.unit.systemQualifiedName === "ASECollect::collector"
  )!;
  const root = issuer.model.modelAdministration;
  if (!root) throw new Error("root authority missing in pass 1");
  const identity = delegationIdentity(
    "ASECollect::collector",
    target.model,
    first,
  );
  const record: ModelDelegationRecord = {
    id: "delegation-collector-1",
    revision: 1,
    issuerSystem: "ASELiveBuilder::liveBuilder",
    targetSystem: "ASECollect::collector",
    targetHolderNativeId: identity.holderNativeId,
    targetMandateId: identity.mandateId,
    targetMandateRevision: identity.mandateRevision,
    parent: {
      kind: "root",
      id: root.id,
      revision: root.revision,
      digest: root.digest,
    },
    operations: ["set-value"],
    grants: [{
      file: "mission.sysml",
      qualifiedRoots: ["CommercialWatchMission::sourcePolicy"],
    }],
    mayEdit: true,
    recipients: [],
    maxRedelegationDepth: null,
    revoked: false,
  };
  sources["model-delegations.sysml"] = renderModelDelegations([record]);
  return sources;
}

export const matrixSourceFixtures: Record<
  MatrixSourceFixtureName,
  (ctx: MatrixFixtureContext) => Promise<Sources>
> = {
  "fixture-reviewer-policies": reviewerAndPolicies,
  "fixture-delegation": delegation,
};
