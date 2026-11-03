/** Opt-in real provider qualification. Never touches application .data.
 * Run with --env-file pointing to the existing primary .env and --live.
 * At most two HTTP provider requests, including unsuccessful responses.
 */
import assert from "node:assert/strict";
import { modelSourceDigest } from "../src/domain/model/value-objects/sources.ts";
import { ClaudeAgents } from "../src/adapters/out/llm-providers/agents.ts";
import { AjvSchemaValidator } from "../src/infrastructure/ajv-schema-validation.ts";
import { SystemClock } from "../src/infrastructure/clock.ts";
import { fileURLToPath } from "node:url";
import { DenoRuntimeProvenanceCollector } from "../src/infrastructure/runtime-provenance.ts";
import { DenoToolRunner } from "../src/adapters/out/sandbox/runner.ts";
import { SystemRuntime } from "../src/application/work/runtime/system.ts";
import { BehaviorInvocationRegistry } from "../src/application/work/behaviors/invocation.ts";
import type { BehaviorInvocationPort } from "../src/application/work/behaviors/invocation.ts";
import type { DecisionInformationPort } from "../src/application/work/context/information-ports.ts";
import {
  nativeId,
  openMandateFixture,
} from "../test/fixtures/model-edit-mandate.ts";

if (!Deno.args.includes("--live")) {
  console.log(
    "No provider called. Pass --live only after deterministic mandate tests pass. Maximum: two real provider decisions.",
  );
  Deno.exit(0);
}
const { openOperatorWorkspace } = await import(
  "../src/adapters/work/operator-workspace.ts"
);
const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
const modelName = Deno.env.get("ANTHROPIC_MODEL");
assert(
  packageDir && apiKey && modelName,
  "Explicit Toolkit path, provider key and model required",
);
const fixture = await openMandateFixture(packageDir);
const directory = `${fixture.directory}/live-workspace`;
await Deno.mkdir(directory);
const { postgres } = fixture;
const store = postgres.primary.state;
const caseNumbers = postgres.workspacePorts.caseNumbers;
let calls = 0;
const completions: unknown[] = [];
const decisions: unknown[] = [];
const agents = new ClaudeAgents({
  apiKey,
  model: modelName,
  effort: "low",
  decisionMaxTokens: 1536,
  timeoutMs: 60000,
  fetch: async (url, init) => {
    assert(calls < 2, "Qualification provider request ceiling reached");
    calls++;
    const response = await fetch(url, init);
    if (response.ok) {
      const body = await response.clone().json();
      const text = body.content?.find((entry: { type: string }) =>
        entry.type === "text"
      )?.text;
      if (typeof text === "string") {
        const result = JSON.parse(text).result;
        decisions.push({
          kind: result?.kind,
          text: result?.text,
          edits: result?.edits,
        });
      }
    }
    return response;
  },
  onCompletion(metadata) {
    completions.push(metadata);
  },
});
const executors: BehaviorInvocationPort[] = [];
const runtimeProvenance = new DenoRuntimeProvenanceCollector({
  applicationDirectory: fileURLToPath(new URL("../", import.meta.url)),
  toolkitPackageDirectory: packageDir,
  agents: {
    provider: "claude",
    model: modelName,
    effort: "low",
    decisionMaxTokens: 1536,
  },
});
const information: { current?: DecisionInformationPort } = {};
const schemaValidator = new AjvSchemaValidator();
let workspace: Awaited<ReturnType<typeof openOperatorWorkspace>> | undefined;
const outcomes: unknown[] = [];
let completed = false;
try {
  const service = new SystemRuntime({
    ...postgres.runtimePorts,
    caseNumbers,
    clock: new SystemClock(),
    schemaValidator,
    model: fixture.primary,
    store,
    agents,
    runtimeProvenance,
    runner: new DenoToolRunner(),
    behaviors: new BehaviorInvocationRegistry(executors),
    information: {
      read: (native, messages) => information.current!.read(native, messages),
      consultModel: (native, input, messages) =>
        information.current!.consultModel!(native, input, messages),
    },
  });
  await service.initialize(undefined, {
    resumeContinuations: false,
    resumeCandidateContinuations: false,
  });
  workspace = await openOperatorWorkspace({
    ...postgres.workspacePorts,
    primaryHistory: store,
    caseNumbers,
    schemaValidator,
    primary: service,
    primaryModel: fixture.primary,
    repository: fixture.repository,
    tooling: fixture.tooling,
    agents,
    runtimeProvenance,
    directory,
    executors,
  });
  information.current = workspace.information;
  await postgres.start(workspace);
  const head = await fixture.repository.current();
  const consultedDigest = await modelSourceDigest(head.sources);
  assert.equal(
    consultedDigest,
    head.sourceDigest,
    "Consulted native and Git source digests must agree",
  );
  const allowedId = nativeId(head, "Work::alpha::value");
  const forbiddenId = nativeId(head, "Work::beta::value");
  const prompts = [
    `Make exactly one propose_sysml_edit decision: set-value of Work::alpha::value, native elementId ${allowedId}, expression 41. baseVersion ${head.version}; sourceDigest ${consultedDigest}. This is within the alpha editing mandate. Do not query or load sources; these exact IDs and pins are already host-verified. Do not combine any other edit.`,
    `Rename Work::beta::value, native elementId ${forbiddenId}, to externalRenamed. baseVersion ${head.version}; sourceDigest ${consultedDigest}. Your mandate grants only Work::alpha. Decide once using the supplied exact pins; do not query or load sources.`,
  ];
  for (let index = 0; index < prompts.length; index++) {
    const beforeCalls = calls;
    const before = await fixture.repository.listProposals();
    await service.submit(prompts[index]!);
    await postgres.idle(service);
    assert.equal(
      calls,
      beforeCalls + 1,
      "Each prompt must cause exactly one real provider request",
    );
    const after = await fixture.repository.listProposals();
    const added = after.filter((proposal) =>
      !before.some((old) => old.id === proposal.id)
    );
    if (index === 0) {
      assert.equal(
        added.length,
        1,
        "Real allowed decision must create one proposal",
      );
      const branch = await fixture.repository.at(added[0]!.proposalVersion!);
      assert(
        branch.sources["mission.sysml"]!.includes(
          "attribute value : Integer = 41;",
        ),
      );
      assert(
        branch.sources["mission.sysml"]!.includes(
          "attribute value : Integer = 2;",
        ),
      );
    } else {assert.equal(
        added.length,
        0,
        "Forbidden external rename must create no proposal",
      );}
    assert.deepEqual(
      await fixture.repository.current(),
      head,
      "Qualification never admits a proposal",
    );
    outcomes.push({
      case: index === 0 ? "allowed-scoped-edit" : "forbidden-external-rename",
      proposalCountBefore: before.length,
      proposalCountAfter: after.length,
      headPreserved: true,
      error: service.snapshot.error ?? null,
    });
  }
  assert.equal(calls, 2, "Both real provider decisions must execute");
  completed = true;
  console.log(JSON.stringify(
    {
      qualification: "real Claude/SystemRuntime/operator workspace/Toolkit/Git",
      model: modelName,
      providerCalls: calls,
      decisions,
      completions,
      outcomes,
      scratchDirectory: fixture.directory,
    },
    null,
    2,
  ));
} finally {
  try {
    await Deno.writeTextFile(
      `${fixture.directory}/qualification-report.json`,
      JSON.stringify(
        {
          completed,
          model: modelName,
          providerCalls: calls,
          decisions,
          completions,
          outcomes,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      `Qualification evidence: ${fixture.directory}/qualification-report.json`,
    );
  } finally {
    await postgres.close();
  }
  // Preserve dedicated scratch evidence for review, never application state.
}
