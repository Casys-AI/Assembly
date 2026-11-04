import { unexpectedModelAuthoring } from "../../../../test/support/model-authoring.ts";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import type { SkillRecord } from "../../../domain/skills/entities/skill.ts";
import type { ChatContext } from "../conversation/chat-context.ts";
import type { SystemRuntimeState } from "./state.ts";
import { SystemRuntime } from "../../../../test/support/system-runtime.ts";
import type { DecisionInformationPort } from "../context/information-ports.ts";
import type { ModelPort, StorePort } from "./ports.ts";

function fixture(information?: DecisionInformationPort) {
  const model = artifactModel("builder");
  model.policy.mayProposeSysmlRevision = true;
  model.skillPolicy = {
    kind: "lazy-skills",
    id: "source-skills",
    revision: 1,
    elementId: "skill-policy",
    sourceIds: ["skill-source"],
    ownerId: "builder",
    allowedHosts: [],
    maxSkillBytes: 65536,
    maxInstalledSkills: 8,
    maxLoadedSkills: 4,
    maxLoadedCharacters: 48000,
  };
  model.contextPolicy = {
    kind: "separated-context",
    pattern: "5.1",
    id: "source-context",
    revision: 1,
    elementId: "context-policy",
    sourceIds: ["context-source"],
    recentMessages: 1,
    maxMessageCharacters: 256,
    maxCollectionItems: 1,
    maxContextCharacters: 50000,
  };
  let state: SystemRuntimeState | null = null;
  const store: StorePort = {
    load: () => Promise.resolve(structuredClone(state)),
    save(next, expected) {
      equal(state?.revision ?? null, expected);
      state = structuredClone(next);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
  const native: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize: () => Promise.resolve(structuredClone(model.identity)),
    readExecutableModel: () => Promise.resolve(structuredClone(model)),
    readSourceRevision: () =>
      Promise.resolve({
        version: model.version.repositoryVersion!,
        sources: {
          "configuration.sysml":
            'package Source { part aseSkill { attribute source = "bundle:ase-modeling"; attribute digest = "pinned-skill-digest"; } }',
        },
      }),
    applyApprovedChange() {
      throw new Error("No source mutation");
    },
    activateCandidate() {
      throw new Error("No activation");
    },
    graph: () => Promise.resolve({}),
  };
  const contexts: ChatContext[] = [];
  const service = new SystemRuntime({
    model: native,
    store,
    ...(information ? { information } : {}),
    agents: {
      label: "fixture",
      decide(context) {
        contexts.push(structuredClone(context));
        return Promise.resolve({ kind: "reply", text: "Réponse ordinaire" });
      },
      review() {
        throw new Error("No review");
      },
    },
    runner: {
      run() {
        throw new Error("No effect");
      },
      test() {
        throw new Error("No test");
      },
    },
  });
  return { model, contexts, service };
}

function skill(): SkillRecord {
  const modelVersion = {
    digest: "loaded-source-digest",
    repositoryVersion: "branch:loaded",
  };
  return {
    id: "ase-modeling",
    name: "ase-modeling",
    description: "Source-owned modeling",
    content: "Instructions exactes à préserver. ".repeat(100),
    digest: "a".repeat(64),
    byteLength: 4000,
    source: {
      kind: "bundled",
      location: "source:ase-modeling",
      acquiredAt: "2026-10-22T00:00:00.000Z",
      modelVersion,
    },
    installedAt: "2026-10-22T00:00:00.000Z",
    loaded: true,
    loadedAt: "2026-10-22T00:00:00.000Z",
    loadedBy: modelVersion,
  };
}

Deno.test("skills-only admitted policy reads current instructions before projection and removes unloaded text on the next decision", async () => {
  const loaded = skill();
  let enabled = true, reads = 0;
  const f = fixture({
    read(model) {
      reads++;
      equal(model.memoryPolicy, undefined);
      const source = model.skillPolicy!;
      const policy = {
        id: source.id,
        ownerId: source.ownerId,
        allowedHosts: source.allowedHosts,
        maxSkillBytes: source.maxSkillBytes,
        maxInstalledSkills: source.maxInstalledSkills,
        maxLoadedSkills: source.maxLoadedSkills,
        maxLoadedCharacters: source.maxLoadedCharacters,
      };
      const { content: _content, ...metadata } = loaded;
      return Promise.resolve({
        memoryGuidance: [],
        skills: {
          policy,
          catalog: [{ ...metadata, loaded: enabled }],
          loaded: enabled ? [loaded] : [],
        },
      });
    },
  });
  await f.service.initialize();
  await f.service.submit("Utilise les instructions disponibles.");
  await f.service.idle();
  equal(f.contexts.length, 1);
  equal(f.contexts[0]!.skills!.loaded[0]!.content, loaded.content);
  ok(
    f.contexts[0]!.modelSources!.sources["configuration.sysml"]!.includes(
      "bundle:ase-modeling",
    ),
  );
  equal(f.contexts[0]!.contextEvidence!.policy.maxMessageCharacters, 256);
  equal(
    f.service.snapshot.messages.some((message) =>
      message.text.includes(loaded.content)
    ),
    false,
  );
  enabled = false;
  await f.service.submit("Réponds après déchargement.");
  await f.service.idle();
  equal(reads, 2);
  deepStrictEqual(f.contexts[1]!.skills!.loaded, []);
  equal(JSON.stringify(f.contexts[1]).includes(loaded.content), false);
  equal(
    JSON.stringify(f.contexts[1]).includes("Instructions exactes à préserver"),
    false,
  );
  equal(f.service.snapshot.error, undefined);
});

Deno.test("skills-only policy fails before provider when its current information reader is missing", async () => {
  const f = fixture();
  await f.service.initialize();
  await f.service.submit("Travaille.");
  const message = "Le modèle d’information admis exige son lecteur local.";
  await rejects(() => f.service.idle(), { name: "Error", message });
  equal(f.contexts.length, 0);
  equal(f.service.snapshot.error, message);
  equal(f.model.memoryPolicy, undefined);
});

Deno.test("a memory-only reader cannot silently satisfy an admitted skills policy", async () => {
  const f = fixture({ read: () => Promise.resolve({ memoryGuidance: [] }) });
  await f.service.initialize();
  await f.service.submit("Travaille.");
  const message = "Le modèle de skills admis exige son contexte local courant.";
  await rejects(() => f.service.idle(), { name: "Error", message });
  equal(f.contexts.length, 0);
  equal(f.service.snapshot.error, message);
  equal(f.model.memoryPolicy, undefined);
});
