import { unexpectedModelAuthoring } from "../../../../test/support/model-authoring.ts";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import type { ModelDelegationRequest } from "../../../domain/governance/records/model-delegation-request.ts";
import type {
  ChatContext,
  ChatDecision,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import type { ModelPort } from "./ports.ts";
import { SystemRuntime } from "../../../../test/support/system-runtime.ts";

const baseVersion = "commit:consulted-source";
const sourceDigest = "a".repeat(64);
const request: ModelDelegationRequest = {
  baseVersion,
  sourceDigest,
  reason: "Déléguer une édition bornée",
  change: {
    kind: "grant",
    id: "worker-edit",
    targetSystem: "Project::worker",
    operations: ["rename"],
    grants: [{ file: "system.sysml", qualifiedRoots: ["Project::data"] }],
    mayEdit: true,
    recipients: [],
    maxRedelegationDepth: null,
  },
};

function fixture(options: {
  authority?: boolean;
  tooling?: boolean;
  permission?: boolean;
  decision?: () => ChatDecision;
} = {}) {
  const model = artifactModel("coordinator");
  model.policy.mayProposeSysmlRevision = options.permission !== false;
  if (options.authority !== false) {
    model.modelAdministration = {
      kind: "root",
      id: "administration",
      revision: 1,
      digest: "b".repeat(64),
      systemQualifiedName: "Project::coordinator",
      holderNativeId: model.identity.builderId,
      mandateId: "coordinator-mandate",
      mandateRevision: 1,
      operations: ["rename"],
      grants: [{ file: "system.sysml", qualifiedRoots: ["Project::data"] }],
      recipients: ["Project::worker"],
      maxRedelegationDepth: 1,
    };
  }
  let persisted: SystemRuntimeState | null = null;
  const contexts: ChatContext[] = [];
  const proposals: Array<
    { request: ModelDelegationRequest; expectedDigest: string }
  > = [];
  const forbidden = () => {
    throw new Error("Unexpected external effect or automatic admission");
  };
  const native: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize: () => Promise.resolve(structuredClone(model.identity)),
    readExecutableModel: () => Promise.resolve(structuredClone(model)),
    applyApprovedChange: forbidden,
    activateCandidate: forbidden,
    graph: () => Promise.resolve({}),
    ...(options.tooling !== false
      ? {
        proposeDelegation: (_identity, proposed, expectedDigest) => {
          proposals.push({
            request: structuredClone(proposed),
            expectedDigest,
          });
          return Promise.resolve({
            id: "delegation-proposal",
            baseVersion: proposed.baseVersion,
            status: "pending" as const,
          });
        },
      } satisfies Pick<ModelPort, "proposeDelegation">
      : {}),
  };
  const service = new SystemRuntime({
    model: native,
    information: {
      consultModel: forbidden,
      read: () =>
        Promise.resolve({
          memoryGuidance: [],
          modelContext: {
            version: baseVersion,
            sourceDigest,
            loadedSources: [],
            maxLoadedCharacters: 120000,
            files: [],
            roots: { items: [], total: 0, truncated: false },
            limits: {
              maxPageSize: 50,
              maxSourceBytes: 131072,
              maxInspectSourceBytes: 24576,
            },
            coverage: "bounded-discovery-not-exhaustive-impact",
          },
          modelSources: { version: baseVersion, sources: {} },
        }),
    },
    store: {
      load: () => Promise.resolve(structuredClone(persisted)),
      save(next, expected) {
        equal(persisted?.revision ?? null, expected);
        persisted = structuredClone(next);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    },
    agents: {
      label: "delegation-fixture",
      decide(context) {
        contexts.push(structuredClone(context));
        return Promise.resolve(
          options.decision?.() ?? {
            kind: "propose_model_delegation",
            text: "Droits à examiner",
            ...structuredClone(request),
          },
        );
      },
      review: forbidden,
    },
    runner: { run: forbidden, test: forbidden },
  });
  return { service, model, contexts, proposals };
}

Deno.test("delegated administration requires no personal editing right and records only an exact source proposal", async () => {
  for (
    const change of [request.change, {
      kind: "revoke",
      id: "worker-edit",
    }] as const
  ) {
    const f = fixture({
      decision: () => ({
        ...request,
        change,
        kind: "propose_model_delegation",
        text: "Proposer",
      }),
    });
    await f.service.initialize();
    const admitted = structuredClone(f.service.snapshot.executionModel);
    await f.service.submit("Administrer les droits du mandat du destinataire");
    await f.service.idle();
    equal(f.service.snapshot.error, undefined);
    equal(f.contexts[0]!.modelEditing!.targetedEdits, false);
    equal(f.contexts[0]!.modelEditing!.rawRevision, false);
    deepStrictEqual(
      f.contexts[0]!.modelAdministration,
      f.model.modelAdministration,
    );
    deepStrictEqual(f.proposals, [{
      request: { ...request, change },
      expectedDigest: admitted!.version.digest,
    }]);
    deepStrictEqual(f.service.snapshot.executionModel, admitted);
    equal(f.service.snapshot.candidates.length, 0);
    equal(
      f.service.snapshot.events.filter((event) =>
        event.kind === "model-revision-proposed"
      ).length,
      1,
    );
    ok(
      f.service.snapshot.messages.some((message) =>
        message.text.includes("aucun droit n’est encore modifié")
      ),
    );
  }
});

Deno.test("administration cannot bypass missing native authority, policy or host tooling", async () => {
  for (const denied of ["authority", "permission", "tooling"] as const) {
    const f = fixture({ [denied]: false });
    await f.service.initialize();
    await f.service.submit("Proposer une délégation");
    const message =
      "Le modèle natif ne permet pas de proposer une administration déléguée.";
    await rejects(() => f.service.idle(), {
      name: "ModelRightsError",
      message,
      code: "MODEL_REVISION_AUTHORITY",
      context: {
        field: "mayProposeSysmlRevision",
        operation: "propose_model_delegation",
      },
    });
    equal(
      f.contexts.length,
      1,
      "An authority refusal does not consume a corrective provider decision",
    );
    equal(f.contexts[0].modelAdministration, undefined);
    equal(
      f.service.snapshot.messages.filter((entry) =>
        entry.text.startsWith(
          "Host refusal while preparing or applying your proposal",
        )
      ).length,
      0,
    );
    equal(f.proposals.length, 0);
    equal(f.service.snapshot.error, message);
  }
});

Deno.test("administration refuses stale consulted bases, digests and execution authority before any proposal", async () => {
  for (const changed of ["base", "digest", "execution"] as const) {
    let changeExecution = () => {};
    const f = fixture({
      decision: () => {
        if (changed === "execution") changeExecution();
        return {
          ...request,
          kind: "propose_model_delegation",
          text: "Refuser une base différente",
          baseVersion: changed === "base" ? "commit:unconsulted" : baseVersion,
          sourceDigest: changed === "digest" ? "c".repeat(64) : sourceDigest,
        };
      },
    });
    changeExecution = () => {
      f.model.version.digest = "new-unadmitted-digest";
    };
    await f.service.initialize();
    const admitted = structuredClone(f.service.snapshot.executionModel);
    await f.service.submit("Proposer une délégation");
    const message = changed === "execution"
      ? "Le modèle natif a changé ; une admission explicite de sa version est requise avant toute décision ou effet."
      : "La proposition de délégation doit conserver la version et le digest des sources consultées.";
    await rejects(() => f.service.idle(), { name: "Error", message });
    equal(f.contexts.length, 1);
    equal(f.proposals.length, 0);
    equal(f.service.snapshot.error, message);
    deepStrictEqual(f.service.snapshot.executionModel, admitted);
    equal(
      f.service.snapshot.events.filter((event) =>
        event.kind === "model-revision-proposed"
      ).length,
      0,
    );
  }
});
