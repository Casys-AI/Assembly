// Second tour : faux Claude partagé (nouveau fil `tools`, bloc `tool_use`).
import { equal, ok, rejects } from "node:assert/strict";
import { ClaudeAgents } from "./agents.ts";
import type { Candidate } from "../../../domain/work/candidates.ts";
import type {
  ChatContext,
  ChatDecision,
} from "../../../domain/work/dialogue.ts";
import { createClaudeToolsFake } from "../../../../test/support/claude-tools-fake.ts";
import { modelContextTools } from "../../../domain/model/consultation/context.ts";

const context: ChatContext = {
  modelEditing: {
    targetedEdits: true,
    rawRevision: true,
    policy: {
      id: "edit",
      revision: 1,
      elementId: "edit-policy",
      sourceIds: [],
      holderNativeId: "builder",
      mandateNativeId: "mandate",
      mandateId: "mandate",
      mandateRevision: 1,
      operations: [
        "set-value",
        "rename",
        "insert-member",
        "remove",
        "replace-source",
      ],
      grants: [{ file: "system.sysml", qualifiedRoots: ["Exact"] }],
    },
  },
  messages: [],
  activeTools: [],
  candidates: [],
  modelSources: {
    version: "branch:exact-base",
    sources: { "core.sysml": "package Core {}" },
  },
};
// Décision canonique : `sources` en carte ; le helper la transporte en liste
// `[{path, content}]` et le transport la recanonise.
const proposal: ChatDecision = {
  kind: "propose_sysml_revision",
  text: "Une proposition à examiner",
  reason: "Documenter le système",
  baseVersion: "branch:exact-base",
  sources: { "core.sysml": "package Core { doc /* Reviewed */ }" },
};

Deno.test("recurring requests propose native CaseType edits and never bypass missing grants", async () => {
  for (const enabled of [true, false]) {
    const edit: ChatDecision = {
      kind: "propose_sysml_edit",
      text: "Un résumé à examiner dans Evolution.",
      reason: "Produire le résumé chaque matin en UTC.",
      baseVersion: "branch:exact-base",
      sourceDigest: "a".repeat(64),
      edits: [{
        kind: "insert-member",
        elementId: "native-system",
        text: `part 'Morning summary' : ASECases::CaseType {
  attribute :>> envelope = ASECases::EnvelopeKind::deterministic;
  ref action :>> behavior = conversation;
  ref part :>> owner = builder;
  attribute :>> maxInvocations = 8;
  attribute :>> schedule : ASECases::DailyAt { :>> hour = 8; :>> minute = 0; }
}`,
      }],
    };
    const fake = createClaudeToolsFake((view) => {
      for (
        const phrase of [
          "propose_sysml_edit",
          "insert-member",
          "AssemblyCases::CaseType",
          "EnvelopeKind::reassessment",
          "AssemblyCases::DailyAt",
          "AssemblyCases::Every",
          "ScheduleUnit::minute",
          "watch-notification",
          "trust=untrusted",
          "l’humain accepte la révision",
          "propose_mandate_change",
          "n’invente aucun requestedRights",
          "Ne contourne jamais le refus",
          "watchResult={changed:boolean,summary:string}",
        ]
      ) ok(view.instruction.includes(phrase), phrase);
      equal(view.toolNames.includes("propose_sysml_edit"), enabled);
      return {
        decision: enabled ? edit : {
          kind: "reply",
          text:
            "Mon mandat ne permet pas cette proposition ; demandons l’octroi à l’autorité humaine.",
        },
      };
    });
    const agent = new ClaudeAgents({
      apiKey: "fixture",
      model: "fixture",
      fetch: fake.fetch,
    });
    equal(
      (await agent.decide({
        ...context,
        ...(enabled ? {} : { modelEditing: undefined }),
      })).kind,
      enabled ? "propose_sysml_edit" : "reply",
    );
    equal(fake.views.length, 1);
  }
});

Deno.test("designer diagnostics prompt proposes authorized revisions without making APE patterns mandatory", async () => {
  for (
    const diagnostics of [undefined, [{
      code: "NO_ACCOUNTABLE_OWNER",
      severity: "warning" as const,
      pattern: "6.3",
      finding: "indeterminate" as const,
      message: "Aucun responsable humain déclaré.",
    }]]
  ) {
    const fake = createClaudeToolsFake((view) => {
      // Guidance remains in the prefix even when diagnostics change; findings
      // and their exact-source link must be read on demand.
      equal(view.context?.modelDiagnostics, undefined);
      equal(view.context?.modelDiagnosticsView, undefined);
      ok(view.instruction.includes("at most once per conversation"));
      ok(view.instruction.includes("clickable Markdown link"));
      ok(view.instruction.includes("context.modelDiagnosticsView.href"));
      ok(
        view.instruction.includes(
          "Preserve the entire relative URL, version and caseBranch",
        ),
      );
      ok(
        view.instruction.includes(
          "do not invent one or promise an available report",
        ),
      );
      ok(view.instruction.includes("operations actually authorized"));
      ok(view.instruction.includes("addresses: [{code, elementId}]"));
      ok(view.instruction.includes("proposal's baseVersion"));
      ok(
        view.instruction.includes("APE pattern is never mandatory"),
      );
      ok(
        view.instruction.includes(
          "indeterminate does not prove absence",
        ),
      );
      equal(view.toolNames.includes("propose_sysml_edit"), false);
      equal(view.toolNames.includes("propose_sysml_revision"), false);
      return { decision: { kind: "reply", text: "Constat à examiner." } };
    });
    const agent = new ClaudeAgents({
      apiKey: "fixture",
      model: "fixture",
      fetch: fake.fetch,
    });
    await agent.decide({
      messages: [],
      activeTools: [],
      candidates: [],
      modelTools: modelContextTools(),
      ...(diagnostics
        ? {
          modelDiagnostics: diagnostics,
          modelDiagnosticsView: {
            version: `commit:${"a".repeat(40)}`,
            href: `/system?page=diagnostics&version=commit%3A${"a".repeat(40)}`,
          },
        }
        : {}),
    });
    equal(fake.views.length, 1);
  }
});

Deno.test("Claude source-file map has a closed transport schema and canonical validated result", async () => {
  const fake = createClaudeToolsFake((view) => {
    equal(view.body.max_tokens, 16384);
    const tool = view.body.tools.find((entry) =>
      entry.name === "propose_sysml_revision"
    )!;
    ok(tool !== undefined);
    const sources = (tool.input_schema as {
      properties: { sources: { type: string; items: Record<string, unknown> } };
    }).properties.sources;
    equal(sources.type, "array");
    equal(sources.items.additionalProperties, false);
    ok(
      !JSON.stringify(tool.input_schema).includes(
        "propertyNames",
      ),
    );
    equal(view.context?.modelReadVersion, "branch:exact-base");
    equal(view.context?.modelSources, undefined);
    ok(view.instruction.includes("UNIQUEMENT les fichiers modifiés"));
    return { decision: proposal };
  });
  const agent = new ClaudeAgents({
    apiKey: "fixture",
    model: "fixture",
    fetch: fake.fetch,
  });
  const result = await agent.decide(context);
  equal(result.kind, "propose_sysml_revision");
  if (result.kind === "propose_sysml_revision") {
    equal(result.sources["core.sysml"], "package Core { doc /* Reviewed */ }");
    equal(result.baseVersion, "branch:exact-base");
  }
  equal(fake.views.length, 1);
});

Deno.test("Claude source transport rejects duplicate files, unsafe paths and injected fields", async () => {
  for (
    const sources of [
      [{ path: "core.sysml", content: "package Core {}" }, {
        path: "core.sysml",
        content: "package Core {}",
      }],
      [{ path: "../core.sysml", content: "package Core {}" }],
      [{ path: "core.sysml", content: "package Core {}", approved: true }],
      [],
    ]
  ) {
    const fake = createClaudeToolsFake(() => ({
      // Appel brut : contourne la conversion canonique du helper pour
      // exercer le rejet du transport (réparation bornée puis refus codé).
      toolUse: {
        name: "propose_sysml_revision",
        input: {
          text: "Une proposition à examiner",
          reason: "Documenter le système",
          baseVersion: "branch:exact-base",
          sources,
        },
      },
    }));
    const agent = new ClaudeAgents({
      apiKey: "fixture",
      model: "fixture",
      fetch: fake.fetch,
    });
    await rejects(() => agent.decide(context), /source file|schema/);
    // Une seule réparation : deux appels puis refus, jamais de boucle.
    equal(fake.views.length, 2);
  }
});

Deno.test("targeted authoring is advertised and accepted only with the optional host capability", async () => {
  const edit: ChatDecision = {
    kind: "propose_sysml_edit",
    text: "Une édition à examiner",
    reason: "Renommer le membre inspecté",
    baseVersion: "branch:exact-base",
    sourceDigest: "a".repeat(64),
    edits: [{ kind: "rename", elementId: "exact-native-id", name: "Revised" }],
  };
  for (const enabled of [false, true]) {
    const fake = createClaudeToolsFake((view) => {
      equal(view.toolNames.includes("propose_sysml_edit"), enabled);
      equal(
        view.instruction.includes("pin card editing provides"),
        enabled,
      );
      // Sans l'outil offert, la décision brute déclenche UNKNOWN_TOOL puis
      // le refus codé après réparation, comme une édition non autorisée.
      return enabled ? { decision: edit } : {
        toolUse: {
          name: "propose_sysml_edit",
          input: {
            text: edit.text,
            reason: edit.reason,
            baseVersion: edit.baseVersion,
            sourceDigest: edit.sourceDigest,
            edits: edit.edits,
          },
        },
      };
    });
    const agent = new ClaudeAgents({
      apiKey: "fixture",
      model: "fixture",
      fetch: fake.fetch,
    });
    if (enabled) {
      const result = await agent.decide({
        ...context,
        modelEditing: context.modelEditing,
      });
      equal(result.kind, "propose_sysml_edit");
      equal(fake.views.length, 1);
    } else {
      await rejects(
        () => agent.decide({ ...context, modelEditing: undefined }),
        /decision schema/,
      );
      equal(fake.views.length, 2);
    }
  }
});

Deno.test("review and admission receive the exact capability contract from the admitted model", async () => {
  const candidate: Candidate = {
    id: "c",
    name: "reader",
    description: "reader",
    kind: "read_web_page",
    digest: "e".repeat(64),
    code: "export default () => ({title:'x',text:'x'})",
    stage: "reviewing",
    createdAt: "now",
    baseCatalogRevision: 0,
  };
  const contract = {
    kind: "read_web_page" as const,
    module: "default({url,html}) => {title,text}" as const,
    acceptanceCriteria: [
      "A criterion supplied exclusively by the selected SysML revision",
    ],
  };
  const version = { digest: "a".repeat(64), repositoryVersion: "branch:model" };
  const fake = createClaudeToolsFake((view) => {
    const payload = view.payload as unknown as {
      contract: unknown;
      modelVersion: { digest: string };
    };
    equal(
      JSON.stringify(payload.contract),
      JSON.stringify(contract),
    );
    equal(payload.modelVersion.digest, version.digest);
    return {
      decision: {
        candidateDigest: candidate.digest,
        verdict: "approve",
        reason: "Exact model contract",
      },
    };
  });
  const agent = new ClaudeAgents({
    apiKey: "fixture",
    model: "fixture",
    fetch: fake.fetch,
  });
  const tests = { passed: true, checks: [] };
  await agent.review(candidate, tests, {
    reviewerId: "reviewer",
    mandate: {
      mayReviewExactCandidate: true,
      mayAdmitReviewedCandidates: true,
      mayActivate: false,
    },
    contract,
    modelVersion: version,
  });
  await agent.admit(candidate, tests, {
    builderId: "builder",
    mayAdmitOwnCandidates: true,
    mandateRevision: 1,
    configurationRevision: 1,
    contract,
    modelVersion: version,
  });
  await rejects(
    () =>
      agent.review(candidate, tests, {
        reviewerId: "reviewer",
        mandate: {
          mayReviewExactCandidate: true,
          mayAdmitReviewedCandidates: true,
          mayActivate: false,
        },
        modelVersion: version,
      }),
    /Missing admitted model/,
  );
  equal(fake.views.length, 2);
});

Deno.test("provider receives source status and scoped evidence once through native results", async () => {
  const current: ChatContext = {
    ...context,
    operator: {
      nativeId: "coordinator",
      name: "Coordinateur",
      instruction: "Coordonner",
    },
    modelVersion: {
      digest: "same-executable",
      repositoryVersion: "branch:head",
    },
    admittedModelVersion: {
      digest: "same-executable",
      repositoryVersion: "branch:own-admission",
    },
    modelSources: {
      version: "branch:head",
      sources: { "system.sysml": "package System {}" },
      publishedRevisions: {
        limit: 32,
        proposalLimit: 64,
        truncated: true,
        commits: [{
          version: "branch:head",
          sourceDigest: "accepted-peer-source",
          author: "human:operator",
          createdAt: "2026-10-21T08:00:00Z",
          proposals: [
            { id: "peer-proposal", author: "agent:worker" },
            { id: "peer-same-content", author: "agent:other-worker" },
          ],
        }],
      },
    },
    sourceProposals: [{
      id: "own-proposal",
      baseVersion: "branch:base",
      status: "accepted",
      acceptedVersion: "branch:merge",
    }],
    artifacts: [],
    messages: [{
      id: "historic-message",
      role: "assistant",
      at: "before-adoption",
      text: "La proposition own-proposal est pending.",
    }, {
      id: "peer-receipt",
      role: "tool",
      at: "after-peer-work",
      text: JSON.stringify({
        agentId: "worker",
        candidateIds: ["peer-reader"],
        artifacts: [{
          id: "peer-reader",
          localStage: "active",
          activationConfirmed: true,
          tests: { passed: true, checks: [] },
        }],
      }),
    }],
  };
  const observation = {
    sourceProposals: current.sourceProposals,
    publishedRevisions: current.modelSources!.publishedRevisions,
    peer: JSON.parse(current.messages[1]!.text),
  };
  current.toolCallHistory = [{
    assistantBlocks: [{
      type: "tool_use",
      id: "source-read",
      name: "consult_model",
      input: { text: "Read current source evidence", inputJson: "{}" },
    }],
    results: [{ id: "source-read", result: JSON.stringify(observation) }],
  }];
  const fake = createClaudeToolsFake((view) => {
    const result = view.body.messages.flatMap((message) => message.content)
      .find((block) =>
        block.type === "tool_result" && block.tool_use_id === "source-read"
      )!;
    const seen = JSON.parse(String(result.content)) as typeof observation;
    equal(seen.sourceProposals![0]!.status, "accepted");
    const published = seen.publishedRevisions!;
    equal(
      published.commits[0]!.proposals![0]!.id,
      "peer-proposal",
    );
    equal(
      published.commits[0]!.proposals![0]!.author,
      "agent:worker",
    );
    equal(published.truncated, true);
    equal(published.proposalLimit, 64);
    equal(
      published.commits[0]!.proposals!.length,
      2,
    );
    equal((view.pinCard!.pin as { digest: string }).digest, "same-executable");
    equal(view.context?.modelReadVersion, "branch:head");
    equal((view.context?.activeTools as unknown[]).length, 0);
    equal(view.context?.sourceProposals, undefined);
    equal(view.context?.artifacts, undefined);
    equal(view.context?.messages, undefined);
    equal(seen.peer.artifacts[0].activationConfirmed, true);
    equal(
      JSON.stringify(view.body.messages).split("peer-proposal").length - 1,
      1,
    );
    ok(
      view.instruction.includes("ne retire pas une admission déjà acquise"),
    );
    ok(
      view.instruction.includes("uniquement ton catalogue local invocable"),
    );
    ok(
      view.instruction.includes(
        "prime sur un ancien message disant pending",
      ),
    );
    ok(view.instruction.includes("ne t’accorde aucun droit d’usage"));
    ok(
      view.instruction.includes(
        "ne nie pas sa publication dans ce journal partagé",
      ),
    );
    ok(view.instruction.includes("sans accorder l’adoption exécutable"));
    return {
      decision: {
        kind: "reply",
        text: "Le reçu du pair atteste ses essais ; mon catalogue reste local.",
      },
    };
  });
  const agent = new ClaudeAgents({
    apiKey: "fixture",
    model: "fixture",
    fetch: fake.fetch,
  });
  equal((await agent.decide(current)).kind, "reply");
  equal(fake.views.length, 1);
});

Deno.test("raw source revisions are omitted and rejected without replace-source permission", async () => {
  const seen = createClaudeToolsFake((view) => {
    equal(view.toolNames.includes("propose_sysml_revision"), false);
    // Outil non offert dans ce contexte : UNKNOWN_TOOL puis refus codé
    // après l'unique réparation, comme une révision non autorisée.
    return {
      toolUse: {
        name: "propose_sysml_revision",
        input: {
          text: "Une proposition à examiner",
          reason: "Documenter le système",
          baseVersion: "branch:exact-base",
          sources: [{
            path: "core.sysml",
            content: "package Core { doc /* Reviewed */ }",
          }],
        },
      },
    };
  });
  await rejects(
    () =>
      new ClaudeAgents({
        apiKey: "fixture",
        model: "fixture",
        fetch: seen.fetch,
      }).decide({
        ...context,
        modelEditing: {
          targetedEdits: true,
          rawRevision: true,
          policy: { ...context.modelEditing!.policy!, operations: ["rename"] },
        },
      }),
    /decision schema/,
  );
  equal(seen.views.length, 2);
});

Deno.test("targeted type edits use the exact provider shape and explicit grant guidance", async () => {
  const decision: ChatDecision = {
    kind: "propose_sysml_edit",
    text: "Retype the inspected occurrence",
    reason: "Use the admitted private flow",
    baseVersion: "branch:exact-base",
    sourceDigest: "a".repeat(64),
    edits: [{
      kind: "set-type",
      elementId: "native-conversation",
      typeName: "Flows::Private",
    }],
  };
  const current = structuredClone(context);
  current.modelEditing!.policy!.operations = ["set-type"];
  const fake = createClaudeToolsFake((view) => {
    ok(view.instruction.includes("{kind:set-type,elementId,typeName}"));
    ok(
      view.instruction.includes(
        "set-type needs an explicit grant",
      ),
    );
    return { decision };
  });
  const agent = new ClaudeAgents({
    apiKey: "fixture",
    model: "fixture",
    fetch: fake.fetch,
  });
  const result = await agent.decide(current);
  equal(JSON.stringify(result), JSON.stringify(decision));
});
