/** Real Toolkit source contracts; no repository, provider or server. */
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import assert from "node:assert/strict";
import { compileInformationPolicies } from "../../src/adapters/work/information/policy.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import {
  sourceLiterals,
  sourceRefs,
  sourceSnapshot,
} from "../../src/adapters/model/projections/graph/source.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  sourceModelIdentity,
} from "../../src/adapters/model/sources/source-model.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const contextPart = `
        part decisionContext : APEContext::DecisionContextPolicy {
            attribute :>> id = "context-v1";
            attribute :>> revision = 1;
            attribute :>> recentMessages = 8;
            attribute :>> maxMessageCharacters = 2000;
            attribute :>> maxCollectionItems = 12;
            attribute :>> maxContextCharacters = 32000;
        }
`;
const memoryPart = `
        part governedMemory : APEMemory::GovernedMemoryPolicy {
            attribute :>> id = "memory-v1";
            attribute :>> revision = 1;
            attribute :>> allowedScopes = ${
  JSON.stringify(JSON.stringify(["modeling", "operations"]))
};
            attribute :>> requireSourceRefs = true;
            attribute :>> requireKnownOutcome = true;
            attribute :>> maxValidityMs = 86400000;
            attribute :>> allowSelfAdmission = false;
        }
`;
const guidancePart = `
        part modelingAdvice : APEContext::ModelingGuidance {
            attribute :>> id = "construction-guidance";
            attribute :>> revision = 1;
            attribute :>> content = "Keep a proposal distinct from its admission.";
        }
`;
async function sources(parts: string) {
  const original = await loadInitialSources(undefined, { information: false });
  const files = await Promise.all(
    ["context.sysml", "memory.sysml"].map(async (name) =>
      [
        name,
        await Deno.readTextFile(
          new URL(`../../models/${name}`, import.meta.url),
        ),
      ] as const
    ),
  );
  return {
    ...original,
    ...Object.fromEntries(files),
    "configuration.sysml": original["configuration.sysml"].replace(
      "part liveBuilder : ConversationSystem {",
      `part liveBuilder : ConversationSystem {${parts}`,
    ),
  };
}
async function compile(
  input: Record<string, string>,
  systemQualifiedName?: string,
) {
  const compiled = await new ToolkitCompiler({ packageDir: packageDir! })
    .compile(
      input,
    );
  const revision = { ...compiled, version: "information-policy-test" };
  const identity = sourceModelIdentity(
    revision,
    "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf",
    systemQualifiedName,
  );
  return {
    compiled,
    identity,
    policies: compileInformationPolicies(
      sourceSnapshot(compiled.elements, identity.rootId),
      sourceLiterals(compiled.elements),
      identity,
    ),
  };
}

Deno.test({
  name:
    "real information library definitions alone preserve the historical contract",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const result = await compile(await sources(""));
    assert.deepEqual(result.policies, {});
    const definitions = result.compiled.elements.filter((element) =>
      element["@type"] === "ActionDefinition" &&
      [
        "APEContext::ReadContextEvidence",
        "APEMemory::CaptureMemory",
        "APEMemory::RecallMemory",
        "APEMemory::ReviseMemory",
        "APEMemory::ReviewMemory",
        "APEMemory::WithdrawMemory",
      ].includes(String(element.qualifiedName))
    );
    assert.equal(definitions.length, 6);
    const snapshot = sourceSnapshot(
      result.compiled.elements,
      result.identity.rootId,
    );
    const requestFields = {
      "APEContext::ContextEvidenceRequest": ["messageId", "messageDigest"],
      "APEMemory::CaptureMemoryRequest": ["id", "contentJson"],
      "APEMemory::RecallMemoryRequest": ["id"],
      "APEMemory::ReviseMemoryRequest": [
        "id",
        "expectedRevision",
        "expectedDigest",
        "contentJson",
      ],
      "APEMemory::ReviewMemoryRequest": [
        "id",
        "expectedRevision",
        "expectedDigest",
        "decision",
        "reason",
      ],
      "APEMemory::WithdrawMemoryRequest": [
        "id",
        "expectedRevision",
        "expectedDigest",
        "reason",
      ],
    };
    for (const [name, fields] of Object.entries(requestFields)) {
      const request = snapshot.elements.find((element) =>
        element.qualifiedName === name
      )!;
      const actual = snapshot.elements.filter((element) =>
        element.ownerId === request.id
      );
      assert(actual.every((element) => element.metaclass === "AttributeUsage"));
      assert.deepEqual(
        actual.map((element) => element.name).toSorted(),
        fields.toSorted(),
      );
    }
    const recallId = result.compiled.elements.find((element) =>
      element.qualifiedName === "APEMemory::RecallMemoryRequest::id"
    )!;
    const ranges = sourceRefs(recallId.multiplicity);
    assert.equal(ranges.length, 1);
    const range = result.compiled.elements.find((element) =>
      element["@id"] === ranges[0]
    )!;
    assert.equal(range["@type"], "MultiplicityRange");
    assert.deepEqual(sourceRefs(range.owner), [recallId["@id"]]);
    const lower = sourceRefs(range.lowerBound)[0];
    const upper = sourceRefs(range.upperBound)[0];
    assert.equal(
      result.compiled.elements.find((element) => element["@id"] === lower)!
        .value,
      0,
    );
    assert.equal(
      result.compiled.elements.find((element) => element["@id"] === upper)!
        .value,
      1,
    );
  },
});

Deno.test({
  name:
    "real native context, memory and modeling guidance compile exact explicit values",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const result = await compile(
      await sources(contextPart + memoryPart + guidancePart),
    );
    const { contextPolicy, memoryPolicy, modelingGuidance } = result.policies;
    assert.equal(contextPolicy!.id, "context-v1");
    assert.equal(contextPolicy!.recentMessages, 8);
    assert.equal(contextPolicy!.maxContextCharacters, 32_000);
    assert.equal(memoryPolicy!.ownerId, result.identity.builderId);
    assert.deepEqual(memoryPolicy!.allowedScopes, ["modeling", "operations"]);
    assert.equal(memoryPolicy!.requireSourceRefs, true);
    assert.equal(memoryPolicy!.requireKnownOutcome, true);
    assert.equal(memoryPolicy!.allowSelfAdmission, false);
    assert.equal(memoryPolicy!.maxValidityMs, 86_400_000);
    assert.equal(
      modelingGuidance![0]!.content,
      "Keep a proposal distinct from its admission.",
    );
    for (
      const policy of [contextPolicy!, memoryPolicy!, modelingGuidance![0]!]
    ) {
      assert(policy.sourceIds.includes(policy.elementId));
      assert(policy.sourceIds.includes(result.identity.systemId));
      assert(
        policy.sourceIds.every((id) =>
          result.compiled.elements.some((element) => element["@id"] === id)
        ),
      );
    }
  },
});

Deno.test({
  name:
    "real information policies reject missing values and multiple local occurrences",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    await assert.rejects(
      async () => await compile(await sourcesWithoutRecentMessages()),
      /native information policy fields|native information literal recentMessages/,
    );
    await assert.rejects(
      async () =>
        await compile(
          await sources(
            contextPart +
              contextPart.replace(
                "part decisionContext",
                "part anotherContext",
              ),
          ),
        ),
      /Ambiguous native information policy DecisionContextPolicy/,
    );
    async function sourcesWithoutRecentMessages() {
      // A declared required field without a value is legal SysML, but cannot
      // authorize an executable policy through a hidden host default.
      return await sources(
        contextPart.replace("attribute :>> recentMessages = 8;", ""),
      );
    }
  },
});

Deno.test({
  name:
    "real information policy scopes isolate sibling systems and preserve nested ownership",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const input = await sources(contextPart + guidancePart);
    input["configuration.sysml"] += `
package OtherInformationScope {
    part sibling : AssemblyLiveBuilder::ConversationSystem {
        part builder : AssemblyLiveBuilder::ConversationBuilder;
        part catalog : AssemblyLiveBuilder::ToolCatalog;
        ${contextPart.replace("recentMessages = 8", "recentMessages = 24")}
        ${guidancePart.replace("its admission", "its exact admitted digest")}
    }
}
`;
    const result = await compile(input);
    assert.equal(result.policies.contextPolicy!.recentMessages, 8);
    assert.equal(result.policies.modelingGuidance!.length, 1);
    const sibling = sourceModelIdentity(
      { ...result.compiled, version: "information-policy-test" },
      "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf",
      "OtherInformationScope::sibling",
    );
    const siblingPolicies = compileInformationPolicies(
      sourceSnapshot(result.compiled.elements, sibling.rootId),
      sourceLiterals(result.compiled.elements),
      sibling,
    );
    assert.equal(siblingPolicies.contextPolicy!.recentMessages, 24);
    assert.equal(siblingPolicies.modelingGuidance!.length, 1);
    assert.equal(
      siblingPolicies.modelingGuidance![0]!.content,
      "Keep a proposal distinct from its exact admitted digest.",
    );
    const nested = await compile(
      await sources(`part nested { ${contextPart} }`),
    );
    assert.equal(nested.policies.contextPolicy!.recentMessages, 8);
    const group = nested.compiled.elements.find((element) =>
      element.qualifiedName === "AssemblyLiveBuilder::liveBuilder::nested"
    )!;
    assert(
      nested.policies.contextPolicy!.sourceIds.includes(String(group["@id"])),
    );
    await assert.rejects(
      async () =>
        await compile(await sources(`ref part nested { ${contextPart} }`)),
      /concrete conversation system/,
    );
    const typeOwned = await sources("");
    typeOwned["configuration.sysml"] += `
package InvalidInformationOwner {
    part def Group { ${contextPart} }
}
`;
    await assert.rejects(
      async () => await compile(typeOwned),
      /concrete conversation system/,
    );
  },
});
