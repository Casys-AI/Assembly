/** Real Toolkit facts and source-version linting; no Git mutation or AI provider. */
import assert from "node:assert/strict";
import { ModelDiagnosticsService } from "../../src/application/model/diagnostics/service.ts";
import type { ModelDiagnosticMask } from "../../src/application/model/diagnostics/commands/inputs.ts";
import { SourceModelDiagnosticsReader } from "../../src/adapters/model/diagnostics/source.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { createModelDiagnosticsHandler } from "../../src/adapters/in/http/diagnostics/diagnostics.ts";
import { broadcastSse } from "../../src/infrastructure/http/sse.ts";
import { revalidateModelDiagnostics } from "../../src/application/model/diagnostics/events.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");

Deno.test({
  name:
    "native diagnostics track source versions, exact positions and persistent instance masks",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sources = await loadInitialSources(undefined, { information: false });
    const compiler = new ToolkitCompiler({ packageDir: packageDir! });
    const first = {
      ...await compiler.compile(sources),
      version: "commit:before",
    };
    const withBudget = {
      ...sources,
      "configuration.sysml": sources["configuration.sysml"]!.replace(
        "part liveBuilder : ConversationSystem {",
        `part liveBuilder : ConversationSystem {
          part budget : APEWorkBudget::InvocationBudgetPolicy {
            attribute :>> id = "diagnostic-budget";
            attribute :>> revision = 1;
            attribute :>> unit = "agent-invocation";
            attribute :>> limit = 12;
            attribute :>> onExhausted = "wait";
            attribute :>> exhaustionRecipient = "local-control";
          }`,
      ),
    };
    const second = {
      ...await compiler.compile(withBudget),
      version: "commit:proposal",
    };
    let current = first;
    let artifactReads = 0;
    const reader = new SourceModelDiagnosticsReader({
      current() {
        throw new Error(
          "Diagnostic headers must not hydrate the current model",
        );
      },
      history: () =>
        Promise.resolve({
          headVersion: current.version,
          commits: [],
          truncated: false,
        }),
      header(version) {
        const revision = version === "commit:before" ? first : second;
        return Promise.resolve({
          version,
          sources: revision.sources,
          sourceDigest: revision.sourceDigest,
        });
      },
      at(version: string) {
        artifactReads++;
        assert(
          ["commit:before", "commit:proposal", "commit:adopted"].includes(
            version,
          ),
        );
        return Promise.resolve(
          version === "commit:before" ? first : { ...second, version },
        );
      },
    }, "git:5a313952-a19e-56a6-9de3-bae38a428958");
    const masks: ModelDiagnosticMask[] = [];
    const service = new ModelDiagnosticsService(reader, {
      list: () => Promise.resolve(masks),
      set(change) {
        assert.equal(change.masked, true);
        masks.push({ code: change.code, elementId: change.elementId });
        return Promise.resolve();
      },
    });
    const before = await service.list();
    assert.equal(artifactReads, 1);
    assert.equal(before.version, "commit:before");
    assert.equal(before.diagnostics.length, 2);
    const budget = before.diagnostics.find((d) =>
      d.code === "LOOP_WITHOUT_BUDGET"
    )!;
    assert(budget);
    assert.equal(budget.masked, false);
    assert.equal(budget.qualifiedName, "AssemblyLiveBuilder::liveBuilder");
    assert.equal(budget.source?.file, "configuration.sysml");
    assert(budget.source && budget.source.line > 0 && budget.source.column > 0);
    assert(
      sources[budget.source.file]!.split("\n")[budget.source.line - 1]!
        .includes("part liveBuilder"),
    );
    await service.setMask({
      code: budget.code,
      elementId: budget.elementId,
      masked: true,
    });
    const masked = await service.list();
    assert.equal(artifactReads, 1);
    assert.equal(masked.diagnostics.length, 2);
    assert.equal(
      masked.diagnostics.find((d) => d.code === budget.code)?.masked,
      true,
    );
    // A proposal is readable before adoption and does not change the current view.
    const handle = createModelDiagnosticsHandler(service);
    const response = await handle(
      new Request(
        "http://localhost/api/model/diagnostics?version=commit:proposal",
      ),
    );
    assert.equal(response?.status, 200);
    const proposed = await response!.json();
    assert.equal(artifactReads, 2);
    assert.equal(proposed.version, "commit:proposal");
    assert.equal(typeof proposed.sourceDigest, "string");
    assert.deepEqual(
      proposed.diagnostics.map((d: { code: string }) => d.code),
      ["NO_ACCOUNTABLE_OWNER"],
    );
    assert.equal((await service.list()).version, "commit:before");
    assert.equal(artifactReads, 2);

    // Exercise the same event payload and SSE transport used by /api/events.
    const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        clients.add(controller);
      },
    });
    const eventReader = stream.getReader();
    const emit = (event: string, value: unknown) =>
      broadcastSse(clients, event, value);
    try {
      await revalidateModelDiagnostics(service, "commit:proposal", emit);
      const frame = new TextDecoder().decode((await eventReader.read()).value);
      assert.equal(
        frame,
        `event: diagnostics\ndata: ${
          JSON.stringify({
            version: proposed.version,
            sourceDigest: proposed.sourceDigest,
            counts: { error: 0, warning: 1, info: 0 },
          })
        }\n\n`,
      );
      current = { ...second, version: "commit:adopted" };
      await revalidateModelDiagnostics(service, current.version, emit);
      const adoptedFrame = new TextDecoder().decode(
        (await eventReader.read()).value,
      );
      assert(adoptedFrame.includes('"version":"commit:adopted"'));
      assert(
        adoptedFrame.includes(`"sourceDigest":"${proposed.sourceDigest}"`),
      );
    } finally {
      await eventReader.cancel();
      eventReader.releaseLock();
    }
    const after = await service.list();
    assert.equal(after.version, "commit:adopted");
    assert.notEqual(after.sourceDigest, before.sourceDigest);
    assert.deepEqual(after.diagnostics.map((d) => d.code), [
      "NO_ACCOUNTABLE_OWNER",
    ]);
    assert.equal(after.diagnostics[0]!.finding, "indeterminate");
    const historical = await service.list("commit:before");
    assert.equal(historical.sourceDigest, before.sourceDigest);
    assert.equal(
      historical.diagnostics.find((d) => d.code === budget.code)?.masked,
      true,
    );
  },
});
