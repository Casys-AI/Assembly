import {
  deepStrictEqual,
  equal,
  rejects,
  strictEqual,
  throws,
} from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { sourceModelIdentity } from "../../../domain/model/records/source-identity.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";
import type { OperatorEntry } from "../../../domain/model/records/operator-entry.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import { conversationUnit } from "./conversations.ts";
import {
  assertWorkspaceRuntimeAvailable,
  createWorkspaceRegistry,
  requireWorkspacePrimary,
  type WorkspaceRuntime,
} from "./workspace-registry.ts";

const projectId = "git:eaa8ee83-b912-5b8d-b114-db28a72570bd";
function revision(version: string, names: string[]): ModelRevision {
  return {
    version,
    sources: {},
    documents: [],
    sourceDigest: version,
    semanticDigest: version,
    provenanceDigest: version,
    sourceHashes: {},
    engineVersion: "fixture",
    elements: [
      {
        "@id": "package",
        "@type": "Package",
        declaredName: "Team",
        qualifiedName: "Team",
      },
      {
        "@id": "definition",
        "@type": "PartDefinition",
        declaredName: "ConversationSystem",
        qualifiedName: "Team::ConversationSystem",
        owner: { "@id": "package" },
      },
      ...names.flatMap((name) => [
        {
          "@id": `${name}-system`,
          "@type": "PartUsage",
          declaredName: name,
          qualifiedName: `Team::${name}`,
          owner: { "@id": "package" },
          type: [{ "@id": "definition" }],
        },
        ...["catalog", "builder"].map((part) => ({
          "@id": `${name}-${part}`,
          "@type": "PartUsage",
          declaredName: part,
          qualifiedName: `Team::${name}::${part}`,
          owner: { "@id": `${name}-system` },
        })),
      ]),
    ],
  };
}
function model(source: ModelRevision, name: string): ExecutableModel {
  const result = executableFixture(
    sourceModelIdentity(source, projectId, `Team::${name}`),
  );
  result.version = {
    ...result.version,
    digest: `${source.version}:${name}`,
    repositoryVersion: source.version,
  };
  result.operator = {
    name,
    instruction: name,
    humanInput: name === "main",
    primary: name === "main",
  };
  result.operatorEntries = ([
    "inbox",
    "inspect-work-artifacts",
    "reuse-tool",
    "work-plan",
    "published-tools",
    "context-evidence",
    "memory-recall",
    "skill-list",
  ] as OperatorEntry["kind"][]).map((kind) => ({
    id: `${source.version}:${name}:${kind}`,
    kind,
    typeId: kind,
    performerId: result.identity.builderId,
    allocationId: kind,
    sourceIds: [],
  }));
  return result;
}
function fixture() {
  const first = revision("first", ["main", "peer"]);
  const next = revision("next", ["main"]);
  const independent = revision("independent", ["peer"]);
  const models = new Map(
    [first, next, independent].flatMap((source) =>
      ["main", "peer"].filter((name) =>
        source.elements.some((value) => value["@id"] === `${name}-system`)
      ).map((name) =>
        [`${source.version}:${name}`, model(source, name)] as const
      )
    ),
  );
  const revisions = new Map(
    [first, next, independent].map((source) => [source.version, source]),
  );
  const effects: string[] = [];
  const runtimes = new Map<string, WorkspaceRuntime>();
  const add = (value: ExecutableModel) => {
    const state = { executionModel: value } as SystemRuntimeState;
    runtimes.set(
      value.identity.builderId,
      {
        scope: `Team::${value.operator!.name}`,
        runtime: {
          get snapshot() {
            return state;
          },
          prepareInitialTools() {
            effects.push(`tools:${value.identity.builderId}`);
            return Promise.resolve();
          },
        },
      } as WorkspaceRuntime,
    );
    return state;
  };
  const primary = add(models.get("first:main")!);
  add(models.get("independent:peer")!);
  const pins = new Map<string, Promise<ExecutableModel | null>>();
  let reserved = false;
  let active = true;
  const registry = createWorkspaceRegistry({
    projectId,
    primaryId: "main-builder",
    primary: () => primary.executionModel!,
    runtimes,
    pins,
    repository: {
      at(version) {
        effects.push(`read:${version}`);
        return Promise.resolve(revisions.get(version)!);
      },
    },
    compilation: {
      compile(source, _project, scope) {
        effects.push(`compile:${source.version}:${scope}`);
        return Promise.resolve(
          models.get(`${source.version}:${scope!.split("::").at(-1)}`)!,
        );
      },
    },
    loadOperatorState: () => {
      throw new Error("Unexpected store load");
    },
    conversations: () => ({
      async withAdmission(operation) {
        equal(reserved, false);
        reserved = true;
        effects.push("reserve");
        try {
          return await operation();
        } finally {
          effects.push("release");
          reserved = false;
        }
      },
      reconcileUnits(manifest) {
        effects.push("reconcile");
        equal(reserved, true);
        for (const id of runtimes.keys()) {
          if (
            !manifest.units.some((unit) => unit.model.identity.builderId === id)
          ) runtimes.delete(id);
        }
        return Promise.resolve();
      },
      resumeCandidateContinuations() {
        effects.push("resume");
        equal(pins.size, 0);
        return Promise.resolve();
      },
    }),
    initializeSkills(value) {
      effects.push(`skills:${value.identity.builderId}`);
      equal(reserved, true);
      equal(pins.size, 0);
      return Promise.resolve();
    },
    ensurePlanner() {
      effects.push("planner");
      return Promise.resolve();
    },
    deliveriesActive: () => active,
  });
  return {
    registry,
    models,
    effects,
    primary,
    pins,
    runtimes,
    reserved: () => reserved,
    setActive: (value: boolean) => {
      active = value;
    },
  };
}

Deno.test("workspace registry retains independent admitted pins and shared target collections", async () => {
  const f = fixture();
  const manifest = await f.registry.manifest();
  deepStrictEqual(
    manifest.units.map((unit) => unit.model.version.repositoryVersion),
    ["first", "independent"],
  );
  f.registry.registerTargets(manifest.units);
  const retained = { ...f.registry };
  const next = f.models.get("next:main")!;
  f.registry.registerTargets([conversationUnit("Team::main", next)]);
  for (
    const name of [
      "targets",
      "observationOwners",
      "reuseOwners",
      "planOwners",
      "informationEntries",
      "publishedTargets",
      "reuseTargets",
      "planTargets",
      "workTargets",
    ] as const
  ) {
    strictEqual(f.registry[name], retained[name]);
    equal(
      [...retained[name].keys()].some((key) => key.includes(":peer:")),
      false,
    );
    equal(
      [...retained[name].keys()].every((key) => key.startsWith("next:main:")),
      true,
    );
  }
});

Deno.test("workspace adoption validates first then reconciles and clears pins before admission release", async () => {
  const f = fixture();
  const prospective = f.models.get("next:main")!;
  f.pins.set("old", Promise.resolve(null));
  await f.registry.adopt({
    expectedVersion: "next",
    expectedDigest: prospective.version.digest,
  }, () => {
    equal(f.reserved(), true);
    equal(f.effects.at(-1), "read:next");
    f.effects.push("mutate");
    f.primary.executionModel = prospective;
    return Promise.resolve();
  });
  deepStrictEqual(f.effects, [
    "reserve",
    "read:next",
    "compile:next:Team::main",
    "read:next",
    "mutate",
    "read:next",
    "reconcile",
    "skills:main-builder",
    "tools:main-builder",
    "planner",
    "resume",
    "release",
  ]);
  equal(f.registry.targets.get("next:main:inbox"), "main-builder");
  equal(f.runtimes.has("peer-builder"), false);
});

Deno.test("workspace registry rejects changed contracts and admission guards retain errors", async () => {
  const f = fixture();
  await rejects(
    f.registry.adopt(
      { expectedVersion: "next", expectedDigest: "stale" },
      () => {
        throw new Error("Mutation must not run");
      },
    ),
    { code: "MODEL_MISMATCH" },
  );
  throws(
    () => requireWorkspacePrimary(undefined),
    /Missing admitted operator source pin/,
  );
  throws(() => assertWorkspaceRuntimeAvailable(f.runtimes, "main-builder"), {
    code: "EVOLUTION_DUPLICATE_RUNTIME",
  });
  strictEqual(
    requireWorkspacePrimary(f.primary.executionModel),
    f.primary.executionModel,
  );
});
