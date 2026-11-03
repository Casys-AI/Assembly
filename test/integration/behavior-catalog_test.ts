import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import {
  type BehaviorSourceRevision,
  compileBehaviorCatalog,
  compileBehaviorDeclarationProvenance,
} from "../../src/adapters/out/sysml-toolkit/compilation-policies/work/behavior-catalog.ts";
import { closeSysmlToolkitWorkers } from "../../src/adapters/out/sysml-toolkit/worker-client.ts";
import { admitBehaviorCall } from "../../src/application/governance/behavior-call-admission.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  sourceModelIdentity,
  validateSourceEvolutionExecutables,
} from "../../src/adapters/model/sources/source-model.ts";
import { classifyEvolutionEffects } from "../../src/domain/model/evolution/semantic-effects.ts";
import {
  sourceRefs,
  sourceSnapshot,
} from "../../src/adapters/model/projections/graph/source.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const access = (name = "echoAccess", enabled = true, caller = "builder") =>
  [
    "part " + name + " : AssemblyInvocations::BehaviorAccess {",
    'attribute :>> name = "' + name + '";',
    'attribute :>> description = "Echo supplied facts; no domain predicate is supplied by the host."; ',
    "attribute :>> enabled = " + enabled + ";",
    "ref item :>> input : BehaviorExample::EchoInput;",
    "}",
    "bind " + name + ".caller = " + caller + ";",
    "bind " + name + ".target = BehaviorExample::system.echo;",
  ].join("\n");
async function sources(declarations = access()) {
  const baseline = await loadInitialSources(undefined, { information: false });
  baseline["behavior-invocations.sysml"] = await Deno.readTextFile(
    new URL("../../models/behavior-invocations.sysml", import.meta.url),
  );
  baseline["behavior-example.sysml"] = await Deno.readTextFile(
    new URL("../fixtures/behavior-echo.sysml", import.meta.url),
  );
  baseline["configuration.sysml"] = baseline["configuration.sysml"]!.replace(
    "part builder : ConversationBuilder;",
    "part builder : ConversationBuilder;\n" + declarations,
  );
  return baseline;
}
async function compile(declarations = access()) {
  return {
    ...await new ToolkitCompiler({ packageDir: packageDir! }).compile(
      await sources(declarations),
    ),
    version: "commit:behavior-test",
  };
}
let baselinePromise: ReturnType<typeof compile> | undefined;
const baseline = () => baselinePromise ??= compile();
const identity = (revision: BehaviorSourceRevision) =>
  sourceModelIdentity(revision, "git:192196f5-58f4-5485-b2be-7b1d3bb13568");

function raw(revision: BehaviorSourceRevision, name: string) {
  const found = revision.elements.find((element) =>
    element.qualifiedName === name
  );
  assert(found, "Fixture declaration absent: " + name);
  return found;
}
function binding(
  revision: BehaviorSourceRevision,
  accessId: string,
  name: string,
) {
  const snapshot = sourceSnapshot(
    revision.elements,
    identity(revision).rootId,
  );
  const result = snapshot.connectors.find((connector) =>
    connector.metaclass === "BindingConnectorAsUsage" &&
    connector.ends.some((end) =>
      end.chain.at(-1)?.name === name &&
      end.chain.some((segment) => segment.id === accessId)
    )
  );
  assert(result, "Fixture binding absent");
  return result;
}

Deno.test({
  name:
    "native behavior exposure resolves exact caller, performed target and optional typed input schema",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const revision = await baseline(), modelIdentity = identity(revision);
    const contracts = compileBehaviorCatalog(revision, modelIdentity);
    assert.equal(contracts.length, 1);
    const contract = contracts[0]!;
    assert.equal(contract.callerNativeId, modelIdentity.builderId);
    assert.equal(
      contract.targetNativeId,
      raw(revision, "BehaviorExample::system::echo")["@id"],
    );
    assert.equal(
      contract.targetTypeId,
      raw(revision, "BehaviorExample::EchoFlow")["@id"],
    );
    assert.equal(
      contract.inputTypeId,
      raw(revision, "BehaviorExample::EchoInput")["@id"],
    );
    assert.deepEqual(contract.inputSchema.required, ["text"]);
    const validate = new Ajv({ strict: true }).compile(contract.inputSchema);
    assert(validate({ text: "hello" }));
    assert(validate({ text: "", times: -2, loud: false }));
    assert(!validate({ times: 1 }));
    assert(!validate({ text: "hello", times: "2" }));
    assert(!validate({ text: "hello", extra: true }));
    assert(!validate({ text: "hello", times: Number.MAX_SAFE_INTEGER + 1 }));
    for (
      const name of [
        "BehaviorExample::EchoInput::times",
        "BehaviorExample::EchoInput::loud",
      ]
    ) {
      const attribute = raw(revision, name);
      const range = revision.elements.find((element) =>
        element["@id"] === sourceRefs(attribute.multiplicity)[0]
      )!;
      for (
        const id of [
          ...sourceRefs(attribute.multiplicity),
          ...sourceRefs(range.lowerBound),
          ...sourceRefs(range.upperBound),
        ]
      ) {
        assert(contract.sourceIds.includes(id), "Multiplicity proof omitted");
      }
    }
    assert(contract.sourceIds.includes(contract.id));
    assert(contract.sourceIds.includes(contract.targetNativeId));
    assert(contract.sourceIds.includes(contract.inputTypeId));
  },
});

Deno.test({
  name:
    "native disabled exposures and another operator's bindings do not grant this builder authority",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const disabled = await compile(access("echoAccess", false));
    assert.deepEqual(compileBehaviorCatalog(disabled, identity(disabled)), []);
    const other = await compile(
      "part otherCaller : ConversationBuilder;\n" +
        access("echoAccess", true, "otherCaller"),
    );
    assert.deepEqual(compileBehaviorCatalog(other, identity(other)), []);
    const none = await compile("");
    assert.deepEqual(compileBehaviorCatalog(none, identity(none)), []);
    const legacySources = await loadInitialSources(undefined, {
      information: false,
    });
    delete legacySources["behavior-invocations.sysml"];
    delete legacySources["verified-effect-closure.sysml"];
    const legacy = {
      ...await new ToolkitCompiler({ packageDir: packageDir! }).compile(
        legacySources,
      ),
      version: "commit:legacy",
    };
    assert.deepEqual(compileBehaviorCatalog(legacy, identity(legacy)), []);
  },
});

Deno.test({
  name:
    "behavior bindings require unique complete exposure paths, not inherited references shared by another access",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const original = await baseline();
    const accessId = String(
      raw(original, "AssemblyLiveBuilder::liveBuilder::echoAccess")["@id"],
    );
    const caller = binding(original, accessId, "caller");
    const missing = structuredClone(original);
    missing.elements = missing.elements.filter((element) =>
      element["@id"] !== caller.id
    );
    assert.throws(
      () => compileBehaviorCatalog(missing, identity(missing)),
      /Missing or ambiguous native behavior binding caller/,
    );
    const duplicate = structuredClone(original);
    duplicate.elements.push({
      ...duplicate.elements.find((element) => element["@id"] === caller.id)!,
      "@id": crypto.randomUUID(),
    });
    assert.throws(
      () => compileBehaviorCatalog(duplicate, identity(duplicate)),
      /Missing or ambiguous native behavior binding caller/,
    );
    const two = await compile(
      access("firstAccess") + "\n" + access("secondAccess"),
    );
    assert.equal(compileBehaviorCatalog(two, identity(two)).length, 2);
    const first = String(
      raw(two, "AssemblyLiveBuilder::liveBuilder::firstAccess")["@id"],
    );
    const firstBinding = binding(two, first, "caller");
    two.elements = two.elements.filter((element) =>
      element["@id"] !== firstBinding.id
    );
    assert.throws(
      () => compileBehaviorCatalog(two, identity(two)),
      /Missing or ambiguous native behavior binding caller/,
    );
  },
});

Deno.test({
  name:
    "native behavior bindings reject foreign roots, forged ownership prefixes and non-performed targets",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const original = await baseline();
    const alias = structuredClone(original);
    raw(alias, "AssemblyLiveBuilder::liveBuilder")["sysx:declaredReference"] =
      true;
    assert.throws(
      () => compileBehaviorCatalog(alias, identity(alias)),
      /concrete native conversation system|invocation system/,
    );
    const nestedAlias = structuredClone(original);
    raw(nestedAlias, "AssemblyLiveBuilder::liveBuilder::builder").isReference =
      true;
    assert.throws(
      () => compileBehaviorCatalog(nestedAlias, identity(nestedAlias)),
      /actual native usage/,
    );
    const foreign = structuredClone(original);
    raw(foreign, "AssemblyLiveBuilder::liveBuilder::echoAccess").owner = {
      "@id": raw(foreign, "BehaviorExample")["@id"],
    };
    assert.throws(
      () => compileBehaviorCatalog(foreign, identity(foreign)),
      /outside the managed system/,
    );
    const nonPerformed = structuredClone(original);
    raw(nonPerformed, "BehaviorExample::system::echo")["@type"] = "ActionUsage";
    assert.throws(
      () => compileBehaviorCatalog(nonPerformed, identity(nonPerformed)),
      /Behavior binding must target an actual native usage/,
    );
    const forged = structuredClone(original);
    const id = String(
      raw(forged, "AssemblyLiveBuilder::liveBuilder::echoAccess")["@id"],
    );
    const targetBinding = binding(forged, id, "target");
    const connector = forged.elements.find((element) =>
      element["@id"] === targetBinding.id
    )!;
    const end = forged.elements.find((element) =>
      element["@id"] === sourceRefs(connector.connectorEnd)[1]
    )!;
    const subset = forged.elements.find((element) =>
      element["@id"] === sourceRefs(end.ownedReferenceSubsetting)[0]
    )!;
    const feature = forged.elements.find((element) =>
      element["@id"] === sourceRefs(subset.referencedFeature)[0]
    )!;
    assert(Array.isArray(feature.chainingFeature));
    const path = sourceRefs(feature.chainingFeature);
    assert.equal(path.length, 2);
    feature.chainingFeature = [{ "@id": identity(forged).systemId }, {
      "@id": path[1],
    }];
    assert.throws(
      () => compileBehaviorCatalog(forged, identity(forged)),
      /binding context target/,
    );
  },
});

Deno.test({
  name:
    "effective native caller and action reference types constrain their actual binding targets",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const targetMismatch = await compile(
      access().replace(
        "ref item :>> input : BehaviorExample::EchoInput;",
        "ref item :>> input : BehaviorExample::EchoInput;\nref action :>> target : AssemblyConversation::ConversationCase;",
      ),
    );
    assert.throws(
      () => compileBehaviorCatalog(targetMismatch, identity(targetMismatch)),
      /Native behavior target violates its reference type/,
    );
    const callerMismatch = await compile(
      access().replace(
        "ref item :>> input : BehaviorExample::EchoInput;",
        "ref item :>> input : BehaviorExample::EchoInput;\nref part :>> caller : AssemblyLiveBuilder::ToolCatalog;",
      ),
    );
    assert.throws(
      () => compileBehaviorCatalog(callerMismatch, identity(callerMismatch)),
      /Native behavior caller violates its reference type/,
    );
  },
});

Deno.test({
  name:
    "native nested input schemas retain optionality and allocation alone never authorizes a behavior",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const input = await sources();
    input["behavior-example.sysml"] = input["behavior-example.sysml"]!.replace(
      "item def EchoInput {",
      "item def EchoContext { attribute label : String; }\nitem def EchoInput { item context : EchoContext [0..1];",
    );
    const nested = {
      ...await new ToolkitCompiler({ packageDir: packageDir! }).compile(input),
      version: "commit:nested",
    };
    const contract = compileBehaviorCatalog(nested, identity(nested))[0]!;
    const validate = new Ajv({ strict: true }).compile(contract.inputSchema);
    assert(validate({ text: "hello" }));
    assert(validate({ text: "hello", context: { label: "a" } }));
    assert(!validate({ text: "hello", context: {} }));
    assert(!validate({ text: "hello", context: { label: "a", extra: 1 } }));
    const allocated = await compile(
      access().replace(
        "bind echoAccess.caller = builder;",
        "allocate BehaviorExample::system.echo to builder;",
      ),
    );
    assert.throws(
      () => compileBehaviorCatalog(allocated, identity(allocated)),
      /Missing or ambiguous native behavior binding caller/,
    );
    const genericInput = await compile(
      access().replace(
        "ref item :>> input : BehaviorExample::EchoInput;",
        "",
      ),
    );
    assert.throws(
      () => compileBehaviorCatalog(genericInput, identity(genericInput)),
      /Behavior input must refine/,
    );
  },
});

Deno.test({
  name:
    "native behavior input rejects unsupported multiplicities, unsafe field names and recursive schemas",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const original = await baseline();
    const unsupported = structuredClone(original);
    const times = raw(unsupported, "BehaviorExample::EchoInput::times");
    const range = unsupported.elements.find((element) =>
      element["@id"] === sourceRefs(times.multiplicity)[0]
    )!;
    unsupported.elements.find((element) =>
      element["@id"] === sourceRefs(range.upperBound)[0]
    )!.value = 2;
    assert.throws(
      () => compileBehaviorCatalog(unsupported, identity(unsupported)),
      /input multiplicity times/,
    );
    const unsafe = structuredClone(original);
    raw(unsafe, "BehaviorExample::EchoInput::text").declaredName = "__proto__";
    assert.throws(
      () => compileBehaviorCatalog(unsafe, identity(unsafe)),
      /Unsafe or ambiguous native behavior input field/,
    );
    const recursive = structuredClone(original);
    const text = raw(recursive, "BehaviorExample::EchoInput::text");
    text["@type"] = "ItemUsage";
    text.isReference = false;
    text.type = [{
      "@id": raw(recursive, "BehaviorExample::EchoInput")["@id"],
    }];
    for (const relationId of sourceRefs(text.ownedTyping)) {
      const relation = recursive.elements.find((element) =>
        element["@id"] === relationId
      )!;
      relation.type = text.type;
      relation.target = text.type;
    }
    assert.throws(
      () => compileBehaviorCatalog(recursive, identity(recursive)),
      /Recursive or excessive native behavior input schema/,
    );
    const inheritedSources = await sources(
      access().replace(
        "ref item :>> input : BehaviorExample::EchoInput;",
        "ref item :>> input : BehaviorExample::ChildInput;",
      ),
    );
    inheritedSources["behavior-example.sysml"] =
      inheritedSources["behavior-example.sysml"]!.replace(
        "action def EchoFlow",
        "item def ChildInput :> EchoInput { attribute extra : String; }\naction def EchoFlow",
      );
    const inherited = {
      ...await new ToolkitCompiler({ packageDir: packageDir! }).compile(
        inheritedSources,
      ),
      version: "commit:inherited",
    };
    assert.throws(
      () => compileBehaviorCatalog(inherited, identity(inherited)),
      /Unsupported inherited native behavior input schema/,
    );
  },
});

// Keep this test last: it owns final shutdown of this module's shared native
// worker scheduler, including when selected alone by the qualification filter.
Deno.test({
  name:
    "disabling a valid native exposure retains its contracts provenance without callable authority",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    try {
      const projectId = "git:192196f5-58f4-5485-b2be-7b1d3bb13568";
      const enabled = await baseline();
      const disabled = await compile(access("echoAccess", false));
      const before = await validateSourceEvolutionExecutables(
        enabled,
        projectId,
      );
      const after = await validateSourceEvolutionExecutables(
        disabled,
        projectId,
      );
      const prior = before.find((scope) =>
        scope.model.identity.builderId === identity(enabled).builderId
      )!;
      const next = after.find((scope) =>
        scope.model.identity.builderId === prior.model.identity.builderId
      )!;
      assert.equal(prior.model.behaviors?.length, 1);
      const accessId = prior.model.behaviors![0].id;
      assert.deepEqual(next.model.behaviors ?? [], []);
      assert.deepEqual(
        compileBehaviorCatalog(disabled, identity(disabled)),
        [],
      );
      assert.equal(next.evidence.behaviorDeclarations?.length, 1);
      assert.equal(next.evidence.behaviorDeclarations![0].id, accessId);
      assert.equal(next.evidence.behaviorDeclarations![0].enabled, false);
      assert.equal(next.evidence.sourceCategories[accessId], "contracts");
      const effects = classifyEvolutionEffects(before, after);
      assert.deepEqual(
        effects.map((effect) => ({
          targetNativeId: effect.targetNativeId,
          category: effect.category,
        })),
        [{
          targetNativeId: prior.model.identity.builderId,
          category: "contracts",
        }],
      );
      assert.deepEqual(
        classifyEvolutionEffects(after, before).map((effect) =>
          effect.category
        ),
        ["contracts"],
      );
      const admission = await admitBehaviorCall(
        {
          behaviorId: accessId,
          inputJson: JSON.stringify({ text: "hello" }),
        },
        next.model,
        {
          validate() {
            throw new Error("Disabled admission must precede input validation");
          },
        },
        {
          supports() {
            throw new Error(
              "Disabled admission must precede executor selection",
            );
          },
          invoke() {
            throw new Error("A disabled access cannot invoke an executor");
          },
        },
      );
      assert.equal(admission.failure?.code, "BEHAVIOR_NOT_AUTHORIZED");
      // A disabled entry historically skips target/schema validation at runtime.
      // Evolution cannot classify that declaration unless the full binding proof
      // also succeeds; malformed disabled declarations therefore stay refused.
      const malformed = structuredClone(disabled);
      raw(malformed, "BehaviorExample::system::echo")["@type"] = "PartUsage";
      assert.deepEqual(
        compileBehaviorCatalog(malformed, identity(malformed)),
        [],
      );
      assert.deepEqual(
        compileBehaviorDeclarationProvenance(malformed, identity(malformed)),
        [],
      );
    } finally {
      await closeSysmlToolkitWorkers();
    }
  },
});
