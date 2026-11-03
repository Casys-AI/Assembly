import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { projectSourceSequences } from "../../src/domain/model/projections/sequence.ts";
import { projectSourceGraph } from "../../src/adapters/model/projections/graph/source.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  validateSourceExecutable,
} from "../../src/adapters/model/sources/source-model.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const source = await Deno.readTextFile(
  new URL("../fixtures/sequence-view.sysml", import.meta.url),
);
let compiled: ReturnType<ToolkitCompiler["compile"]> | undefined;
function fixture() {
  return compiled ??= new ToolkitCompiler({ packageDir: packageDir! }).compile({
    "sequence-view.sysml": source,
  });
}

Deno.test({
  name:
    "real native sequence preserves identities and orders messages by event successions",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const model = await fixture();
    const before = JSON.stringify(model.elements);
    const { sequences, diagnostics } = projectSourceSequences(
      model.elements,
    );
    equal(sequences.length, 1);
    const seq = sequences[0];
    equal(seq.qualifiedName, "ASESequenceExample::Exchange");
    deepStrictEqual(seq.lifelines.map((line) => line.name), [
      "caller",
      "worker",
    ]);
    deepStrictEqual(seq.messages.map((message) => message.name), [
      "request",
      "response",
    ]);
    equal(seq.ordering, "native-partial-order");
    deepStrictEqual(diagnostics, []);
    const nativeIds = new Set(model.elements.map((element) => element["@id"]));
    for (const entry of [seq, ...seq.lifelines, ...seq.messages]) {
      ok(
        nativeIds.has(entry.id),
        "Sequence presentation replaced a native identity",
      );
    }
    for (const message of seq.messages) {
      ok(nativeIds.has(message.sourceEventId));
      ok(nativeIds.has(message.targetEventId));
      ok(nativeIds.has(message.payloadId));
      ok(message.sourceIds.every((entry) => nativeIds.has(entry)));
    }
    equal(JSON.stringify(model.elements), before);
    deepStrictEqual(projectSourceSequences([...model.elements].reverse()), {
      sequences,
      diagnostics,
    });
  },
});

Deno.test({
  name:
    "native house-view projection exposes the same sequence without changing executable flows",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const model = await fixture();
    const graph = projectSourceGraph(model.elements, {
      projectId: "sequence-fixture",
      editingContextId: "sequence-fixture",
      rootId: "root",
      systemId: "system",
      catalogId: "catalog",
      builderId: "builder",
    });
    equal(graph.sequences.length, 1);
    deepStrictEqual(
      graph.sequences,
      projectSourceSequences(model.elements).sequences,
    );
    deepStrictEqual(graph.sequenceDiagnostics, []);
  },
});

Deno.test({
  name:
    "a broken native message end is diagnosed and never retargeted by its label",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const model = await fixture();
    const elements = structuredClone(model.elements);
    const response = elements.find((entry) =>
      entry.declaredName === "response" && entry["@type"] === "FlowUsage"
    )!;
    const feature = response.sourceOutputFeature as { "@id": string };
    const end = elements.find((entry) => entry["@id"] === feature["@id"])!;
    end.ownedReferenceSubsetting = { "@id": "missing-native-subsetting" };
    const result = projectSourceSequences(elements);
    deepStrictEqual(
      result.sequences[0].messages.map((message) => message.name),
      ["request"],
    );
    ok(
      result.diagnostics.some((diagnostic) =>
        diagnostic.includes("unresolved or off-scope")
      ),
    );
  },
});

Deno.test({
  name:
    "a real native succession cycle is visible and uses explicit declaration fallback",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const model = await new ToolkitCompiler({ packageDir: packageDir! })
      .compile({
        "sequence-view.sysml": source.replace(
          "message request of Request from caller.sent to worker.received;",
          "message request of Request from caller.sent to worker.received;\n        succession first caller.received then caller.sent;",
        ),
      });
    const { sequences, diagnostics } = projectSourceSequences(
      model.elements,
    );
    equal(sequences[0].ordering, "cyclic");
    deepStrictEqual(sequences[0].messages.map((message) => message.name), [
      "response",
      "request",
    ]);
    ok(
      diagnostics.some((diagnostic) => diagnostic.includes("succession cycle")),
    );
  },
});

Deno.test("an action-flow-only model does not invent interaction messages", () => {
  const result = projectSourceSequences([
    {
      "@id": "action",
      "@type": "ActionDefinition",
      declaredName: "ConversationCase",
    },
    { "@id": "flow", "@type": "FlowUsage", owner: { "@id": "action" } },
  ]);
  deepStrictEqual(result.sequences, []);
  ok(result.diagnostics[0].includes("flux d’actions"));
});

Deno.test({
  name:
    "a nested interaction keeps its own participants instead of becoming a parent self-message",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const model = await new ToolkitCompiler({ packageDir: packageDir! })
      .compile({
        "nested.sysml": `package NestedSequence {
        occurrence def Outer {
          part group {
            part a { event occurrence sent; }
            part b { event occurrence received; }
            message nested from a.sent to b.received;
          }
        }
      }`,
      });
    const { sequences, diagnostics } = projectSourceSequences(
      model.elements,
    );
    equal(sequences.length, 1);
    equal(sequences[0].qualifiedName, "NestedSequence::Outer::group");
    deepStrictEqual(sequences[0].lifelines.map((line) => line.name), [
      "a",
      "b",
    ]);
    const message = sequences[0].messages[0];
    equal(message.from, sequences[0].lifelines[0].id);
    equal(message.to, sequences[0].lifelines[1].id);
    ok(message.from !== message.to);
    deepStrictEqual(diagnostics, []);
  },
});

Deno.test({
  name: "a real native self-succession is diagnosed as a chronology cycle",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const model = await new ToolkitCompiler({ packageDir: packageDir! })
      .compile({
        "sequence-view.sysml": source.replace(
          "message request of Request from caller.sent to worker.received;",
          "message request of Request from caller.sent to worker.received;\n        succession first caller.sent then caller.sent;",
        ),
      });
    const result = projectSourceSequences(model.elements);
    equal(result.sequences[0].ordering, "cyclic");
    ok(
      result.diagnostics.some((diagnostic) =>
        diagnostic.includes("succession cycle")
      ),
    );
  },
});

Deno.test({
  name:
    "sequence views on the initial workshop pass the unchanged executable admission checks",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const compiler = new ToolkitCompiler({ packageDir: packageDir! });
    const initialSources = await loadInitialSources(undefined, {
      information: false,
    });
    const baseline = await compiler.compile(initialSources);
    const initial = await validateSourceExecutable({
      ...baseline,
      version: "commit:initial",
    }, "git:801cff2c-6154-5eb4-a8be-87c220ae2e1d");
    const workshopSource = await Deno.readTextFile(
      new URL("../fixtures/sequence-workshop.sysml", import.meta.url),
    );
    for (
      const [path, sequenceSource] of [
        ["sequence-view.sysml", source],
        ["sequence-workshop.sysml", workshopSource],
      ]
    ) {
      const compiled = await compiler.compile({
        ...initialSources,
        [path]: sequenceSource,
      });
      const executable = await validateSourceExecutable({
        ...compiled,
        version: "commit:sequence",
      }, "git:801cff2c-6154-5eb4-a8be-87c220ae2e1d");
      equal(executable.version.digest, initial.version.digest);
      deepStrictEqual(executable.flows, initial.flows);
      deepStrictEqual(executable.configuration, initial.configuration);
      const projection = projectSourceSequences(compiled.elements);
      equal(projection.sequences.length, 1);
      deepStrictEqual(projection.diagnostics, []);
      if (path === "sequence-workshop.sysml") {
        const sequence = projection.sequences[0];
        equal(
          sequence.qualifiedName,
          "ASEWorkshopSequence::PromotionAvecAdmissionHumaine",
        );
        equal(sequence.messages.length, 11);
        deepStrictEqual(sequence.lifelines.map((line) => line.name), [
          "humain",
          "constructeur",
          "Banc de test",
          "Controle admission",
          "catalogue",
        ]);
      }
    }
  },
});

Deno.test({
  name:
    "asynchronous send and receive orders do not invent a one-row message chronology",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const model = await new ToolkitCompiler({ packageDir: packageDir! })
      .compile({
        "asynchronous.sysml": `package AsyncSequence {
        occurrence def Exchange {
          part sender {
            event occurrence sentFirst;
            then event occurrence sentSecond;
          }
          part receiver {
            event occurrence receivedSecond;
            then event occurrence receivedFirst;
          }
          message msgOne from sender.sentFirst to receiver.receivedFirst;
          message msgTwo from sender.sentSecond to receiver.receivedSecond;
        }
      }`,
      });
    const { sequences, diagnostics } = projectSourceSequences(
      model.elements,
    );
    equal(sequences.length, 1);
    equal(sequences[0].ordering, "non-linearizable");
    deepStrictEqual(sequences[0].messages.map((message) => message.name), [
      "msgOne",
      "msgTwo",
    ]);
    ok(
      diagnostics.some((diagnostic) =>
        diagnostic.includes("asynchronous send/receive orders")
      ),
    );
    ok(
      !diagnostics.some((diagnostic) =>
        diagnostic.includes("succession cycle")
      ),
    );
    ok(
      sequences[0].messages.every((message) =>
        message.sourceEventId && message.targetEventId
      ),
    );
  },
});

Deno.test({
  name: "native message directions and endpoint cardinality fail closed",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const model = await fixture();
    for (const mutation of ["direction", "cardinality"] as const) {
      const elements = structuredClone(model.elements);
      const response = elements.find((e) =>
        e.declaredName === "response" && e["@type"] === "FlowUsage"
      )!;
      const output = response.sourceOutputFeature as { "@id": string };
      if (mutation === "direction") {
        elements.find((e) => e["@id"] === output["@id"])!.direction = "in";
      } else {response.sourceOutputFeature = [
          output,
          response.targetInputFeature,
        ];}
      const projection = projectSourceSequences(elements);
      deepStrictEqual(projection.sequences[0].messages.map((e) => e.name), [
        "request",
      ]);
      ok(projection.diagnostics.some((e) => e.includes("directed")));
    }
  },
});
