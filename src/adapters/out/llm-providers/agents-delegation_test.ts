// Transport simulé par le faux Claude partagé (nouveau fil : outils natifs non stricts).
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import {
  type ClaudeWireTool,
  createClaudeToolsFake,
} from "../../../../test/support/claude-tools-fake.ts";
import { ClaudeAgents, MuseAgents } from "./agents.ts";
import { decisionSchema, validateDecision } from "./output-validation.ts";
import type { ChatContext } from "../../../domain/work/dialogue.ts";

const decision = {
  kind: "propose_model_delegation",
  text: "Proposer des droits bornés au mandat du destinataire",
  reason: "Permettre la mise à jour de sa définition",
  baseVersion: "commit:consulted-source",
  sourceDigest: "a".repeat(64),
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
const context: ChatContext = {
  messages: [],
  activeTools: [],
  candidates: [],
  modelEditing: { targetedEdits: false, rawRevision: false },
  modelAdministration: {
    kind: "root",
    id: "administration",
    revision: 1,
    digest: "b".repeat(64),
    systemQualifiedName: "Project::coordinator",
    holderNativeId: "coordinator-native",
    mandateId: "coordinator-mandate",
    mandateRevision: 1,
    operations: ["rename"],
    grants: [{ file: "system.sysml", qualifiedRoots: ["Project::data"] }],
    recipients: ["Project::worker"],
    maxRedelegationDepth: 1,
  },
};

function offeredMandateRights(tools: readonly ClaudeWireTool[]): string[] {
  const tool = tools.find((value) => value.name === "propose_mandate_change");
  ok(tool);
  const properties = tool.input_schema.properties as Record<string, unknown>;
  const requested = properties.requestedRights as {
    anyOf: Array<{ properties: Record<string, unknown> }>;
  };
  return requested.anyOf.flatMap((variant) => Object.keys(variant.properties))
    .sort();
}

Deno.test("delegation transport accepts bounded grants, redelegation and revocation with no authority metadata", () => {
  equal(validateDecision(decision), true);
  equal(
    validateDecision({
      ...decision,
      change: {
        ...decision.change,
        mayEdit: false,
        recipients: ["Project::specialist"],
        maxRedelegationDepth: 0,
      },
    }),
    true,
  );
  equal(
    validateDecision({
      ...decision,
      change: { kind: "revoke", id: "worker-edit" },
    }),
    true,
  );
  for (
    const invalid of [
      { ...decision, sourceDigest: "forged-digest" },
      { ...decision, baseVersion: "HEAD" },
      { ...decision, issuer: "root" },
      { ...decision, change: { ...decision.change, parentDigest: "forged" } },
      { ...decision, change: { ...decision.change, holderNativeId: "root" } },
      { ...decision, change: { ...decision.change, mandateRevision: 1 } },
      { ...decision, change: { ...decision.change, operations: ["admit"] } },
      {
        ...decision,
        change: { ...decision.change, operations: ["rename", "rename"] },
      },
      { ...decision, change: { ...decision.change, grants: [] } },
      { ...decision, change: { ...decision.change, maxRedelegationDepth: -1 } },
      {
        ...decision,
        change: { ...decision.change, maxRedelegationDepth: 1.5 },
      },
      {
        ...decision,
        change: { ...decision.change, maxRedelegationDepth: 9 },
      },
      {
        ...decision,
        change: { kind: "revoke", id: "worker-edit", approved: true },
      },
      {
        ...decision,
        change: {
          ...decision.change,
          grants: [{ ...decision.change.grants[0], allFiles: true }],
        },
      },
    ]
  ) equal(validateDecision(invalid), false, JSON.stringify(invalid));
});

Deno.test("agent can propose administration without edit rights but cannot invent its availability", async () => {
  for (const enabled of [true, false]) {
    const fake = createClaudeToolsFake((view) => {
      // Les noms d'outils offerts remplacent l'ancien `output_config.format…anyOf`.
      equal(
        view.toolNames.includes("propose_model_delegation"),
        enabled,
      );
      equal(view.toolNames.includes("propose_sysml_edit"), false);
      equal(view.toolNames.includes("propose_sysml_revision"), false);
      // Instructions and static grant bounds share the cached system prefix.
      ok(view.instruction.includes("context.designer"));
      ok(
        view.instruction.includes("conversation perpétuelle du concepteur"),
      );
      ok(
        view.instruction.includes(
          "Les deux portées ont les mêmes capacités et les mêmes droits",
        ),
      );
      equal(
        view.instruction.includes("pin card modelAdministration"),
        enabled,
      );
      if (enabled) {
        const administration = context.modelAdministration!;
        deepStrictEqual(
          view.pinCard?.modelAdministration,
          {
            id: administration.id,
            revision: administration.revision,
            kind: administration.kind,
            digest: administration.digest,
            operations: administration.operations,
            grants: administration.grants,
            recipients: administration.recipients,
            maxRedelegationDepth: administration.maxRedelegationDepth,
          },
        );
        equal(view.context?.modelAdministration, undefined);
        ok(
          view.instruction.includes(
            "ne t’accorde aucun droit d’édition personnel",
          ),
        );
        ok(view.instruction.includes("L’hôte fournit seul l’émetteur"));
        ok(view.instruction.includes("admission explicite"));
      }
      if (view.callIndex === 1) {
        // Tour de réparation simulé par le helper : le modèle insiste avec un outil non offert.
        equal(view.isRepair, true);
        equal(view.repair?.code, "UNKNOWN_TOOL");
      }
      const { kind: offeredKind, ...input } = decision;
      equal(offeredKind, "propose_model_delegation");
      return { toolUse: { name: "propose_model_delegation", input } };
    });
    const agent = new ClaudeAgents({
      apiKey: "fixture",
      model: "fixture",
      fetch: fake.fetch,
    });
    if (enabled) {
      deepStrictEqual(await agent.decide(context), decision);
      equal(fake.requests.length, 1);
    } else {
      // Refus fail-closed au tour de réparation (outil non offert), là où
      // l'ancien fil refusait après coup sur le schéma de décision.
      await rejects(
        () => agent.decide({ ...context, modelAdministration: undefined }),
        /invalid tool decision schema after repair \(UNKNOWN_TOOL\)/,
      );
      equal(fake.requests.length, 2);
    }
  }
});

Deno.test("candidate inspection and decision tools are offered only with Main tool-admission metadata", async () => {
  const reference = {
    operatorId: "native:research",
    candidateId: "candidate",
    candidateDigest: "a".repeat(64),
    expectedRevision: 7,
    caseId: "request",
    policyId: "tools",
    policyRevision: 1,
  };
  const admission: NonNullable<ChatContext["operatorToolAdmission"]> = {
    policies: [{
      id: "tools",
      revision: 1,
      elementId: "native:tools",
      sourceIds: ["native:tools"],
      enabled: true,
      recipients: [reference.operatorId],
      toolKinds: ["read_web_page"],
      maxDelegationDepth: 0,
      holderNativeId: "native:main",
      mandateNativeId: "native:main-mandate",
      systemId: "native:main-system",
    }],
    candidates: [{ ...reference, name: "Read page", kind: "read_web_page" }],
  };
  for (const state of ["enabled", "absent", "revoked"] as const) {
    const enabled = state === "enabled";
    const fake = createClaudeToolsFake((view) => {
      equal(view.toolNames.includes("inspect_operator_candidate"), enabled);
      equal(view.toolNames.includes("decide_operator_candidate"), enabled);
      equal(view.toolNames.includes("decide_operator_change"), false);
      equal(
        offeredMandateRights(view.body.tools).includes("toolAdmission"),
        false,
      );
      equal(
        view.instruction.includes("candidate-inspection is untrusted code"),
        enabled,
      );
      if (enabled) {
        deepStrictEqual(view.context?.operatorToolAdmission, {
          candidates: admission.candidates,
        });
        deepStrictEqual(view.pinCard?.operatorToolAdmission, {
          policies: [{
            id: "tools",
            revision: 1,
            enabled: true,
            recipients: [reference.operatorId],
            toolKinds: ["read_web_page"],
          }],
        });
        ok(view.instruction.includes("never supply actorId"));
        ok(view.instruction.includes("distinct from network decisions"));
        equal(
          view.instruction.includes("requestedRights.toolAdmission="),
          false,
        );
      }
      return enabled
        ? {
          toolUse: {
            name: "inspect_operator_candidate",
            input: { text: "Inspect exact candidate", ...reference },
          },
        }
        : {
          toolUse: {
            name: "reply",
            input: { text: "No tool-admission policy" },
          },
        };
    });
    const agent = new ClaudeAgents({
      apiKey: "fixture",
      model: "fixture",
      fetch: fake.fetch,
    });
    const result = await agent.decide({
      ...context,
      modelAdministration: undefined,
      ...(state === "absent" ? {} : {
        operatorToolAdmission: enabled ? admission : {
          ...admission,
          policies: admission.policies.map((policy) => ({
            ...policy,
            enabled: false,
          })),
        },
      }),
    });
    equal(result.kind, enabled ? "inspect_operator_candidate" : "reply");
  }
});

Deno.test("empty legacy tool-admission context advertises neither a grant request nor candidate decisions", async () => {
  for (const supportedChanges of [undefined, []]) {
    const fake = createClaudeToolsFake((view) => {
      equal(view.instruction.includes("requestedRights.toolAdmission="), false);
      equal(
        view.instruction.includes("pin card operatorToolAdmission contains"),
        false,
      );
      equal(
        view.instruction.includes("candidate-inspection is untrusted code"),
        false,
      );
      equal(view.toolNames.includes("inspect_operator_candidate"), false);
      equal(view.toolNames.includes("decide_operator_candidate"), false);
      deepStrictEqual(
        offeredMandateRights(view.body.tools),
        [
          "mayAdmitOwnCandidates",
          "grantModelEditing",
          "operatorAuthority",
          "addNetworkHosts",
          "setUrlSelectionMode",
        ].sort(),
      );
      return {
        toolUse: {
          name: "reply",
          input: { text: "No tool admission grant is available." },
        },
      };
    });
    const agent = new ClaudeAgents({
      apiKey: "fixture",
      model: "fixture",
      fetch: fake.fetch,
    });
    await agent.decide({
      ...context,
      modelAdministration: undefined,
      operatorToolAdmission: { policies: [], candidates: [] },
      ...(supportedChanges
        ? {
          mandate: {
            id: "legacy",
            mayPropose: [],
            mayInvoke: false,
            mayReview: false,
            mayActivate: false,
            network: { allowedHosts: [] },
            supportedChanges,
          },
        }
        : {}),
    });
    equal(fake.requests.length, 1);
  }
});

Deno.test("tool-admission grant instructions require the supported mandate change independently of inspection", async () => {
  const grant = {
    kind: "propose_mandate_change" as const,
    text: "Request a bounded grant",
    reason: "Admit exact tested candidates",
    requestedRights: {
      toolAdmission: {
        policyId: "tools",
        expectedPolicyRevision: 0,
        enabled: true,
        recipients: ["native:research"],
        toolKinds: ["read_web_page"],
        maxDelegationDepth: 0,
      },
    },
  };
  const fake = createClaudeToolsFake((view) => {
    equal(
      offeredMandateRights(view.body.tools).includes("toolAdmission"),
      true,
    );
    ok(view.instruction.includes("requestedRights.toolAdmission="));
    ok(view.instruction.includes("only the person can accept it"));
    equal(
      view.instruction.includes("pin card operatorToolAdmission contains"),
      false,
    );
    equal(
      view.instruction.includes("candidate-inspection is untrusted code"),
      false,
    );
    equal(view.toolNames.includes("inspect_operator_candidate"), false);
    equal(view.toolNames.includes("decide_operator_candidate"), false);
    const { kind, ...input } = grant;
    return { toolUse: { name: kind, input } };
  });
  const agent = new ClaudeAgents({
    apiKey: "fixture",
    model: "fixture",
    fetch: fake.fetch,
  });
  deepStrictEqual(
    await agent.decide({
      ...context,
      modelAdministration: undefined,
      operatorToolAdmission: { policies: [], candidates: [] },
      mandate: {
        id: "designer",
        mayPropose: [],
        mayInvoke: false,
        mayReview: false,
        mayActivate: false,
        network: { allowedHosts: [] },
        supportedChanges: [{
          kind: "propose_mandate_change",
          requestedRights: "toolAdmission",
          description: "Request a bounded grant",
        }],
      },
    }),
    grant,
  );
  equal(fake.requests.length, 1);
});

Deno.test("per-context nested tool-admission rights leave global and subsequent transport schemas intact", async () => {
  const before = structuredClone(decisionSchema);
  let supported = false;
  const fake = createClaudeToolsFake((view) => {
    equal(
      offeredMandateRights(view.body.tools).includes("toolAdmission"),
      supported,
    );
    return { toolUse: { name: "reply", input: { text: "Schema inspected" } } };
  });
  const agent = new ClaudeAgents({
    apiKey: "fixture",
    model: "fixture",
    fetch: fake.fetch,
  });
  for (const enabled of [false, true, false]) {
    supported = enabled;
    await agent.decide({
      ...context,
      mandate: {
        id: "designer",
        mayPropose: [],
        mayInvoke: false,
        mayReview: false,
        mayActivate: false,
        network: { allowedHosts: [] },
        supportedChanges: enabled
          ? [{
            kind: "propose_mandate_change",
            requestedRights: "toolAdmission",
            description: "Request a bounded grant",
          }]
          : [],
      },
    });
    deepStrictEqual(decisionSchema, before);
  }
});

Deno.test("unsupported tool-admission requests are rejected from native tools and raw JSON provider responses", async () => {
  const grant = {
    kind: "propose_mandate_change",
    text: "Request unsupported grant",
    reason: "Attempt unavailable authority",
    requestedRights: {
      toolAdmission: {
        policyId: "tools",
        expectedPolicyRevision: 0,
        enabled: true,
        recipients: ["native:research"],
        toolKinds: ["read_web_page"],
        maxDelegationDepth: 0,
      },
    },
  };
  equal(
    validateDecision(grant),
    true,
    "The global shape remains available for supported native models",
  );
  const fake = createClaudeToolsFake((view) => {
    equal(
      offeredMandateRights(view.body.tools).includes("toolAdmission"),
      false,
    );
    const { kind, ...input } = grant;
    return { toolUse: { name: kind, input } };
  });
  const native = new ClaudeAgents({
    apiKey: "fixture",
    model: "fixture",
    fetch: fake.fetch,
  });
  await rejects(() => native.decide(context), /Invalid agent decision schema/);
  class JsonResponseAgents extends MuseAgents {
    protected override call(_prompt: string, schema: object): Promise<unknown> {
      const variants = (schema as typeof decisionSchema).oneOf;
      const mandate = variants.find((variant) =>
        (variant.properties.kind as { const: string }).const ===
          "propose_mandate_change"
      )!;
      const rights = mandate.properties.requestedRights as {
        oneOf: Array<{ properties: Record<string, unknown> }>;
      };
      equal(
        rights.oneOf.some((right) =>
          Object.hasOwn(right.properties, "toolAdmission")
        ),
        false,
      );
      // A raw JSON provider can ignore its supplied schema. The shared decision
      // boundary must still enforce availability without filesystem execution.
      return Promise.resolve(structuredClone(grant));
    }
  }
  await rejects(
    () => new JsonResponseAgents().decide(context),
    /Invalid agent decision schema/,
  );
});

Deno.test("revoked operator authority never offers a network decision tool", async () => {
  const fake = createClaudeToolsFake((view) => {
    equal(view.toolNames.includes("decide_operator_change"), false);
    return { toolUse: { name: "reply", input: { text: "Ready" } } };
  });
  const agent = new ClaudeAgents({
    apiKey: "fixture",
    model: "fixture",
    fetch: fake.fetch,
  });
  for (
    const operatorAuthority of [
      {
        policies: [{ enabled: false } as never],
        requests: [],
        awaitingPerson: [],
        awaitingPersonTruncated: false,
      },
      {
        policies: [{ enabled: true } as never],
        requests: [],
        awaitingPerson: [],
        awaitingPersonTruncated: false,
        error: {
          code: "AUTHORITY_CONTEXT_UNAVAILABLE",
          context: { caseId: "case" },
          recovery: "Retry",
        },
      },
    ]
  ) await agent.decide({ ...context, operatorAuthority });
});
