import assert from "node:assert/strict";
import { modelDiagnosticMaskKey, ModelDiagnosticsService } from "./service.ts";
import type { ModelDiagnosticMask } from "./commands/inputs.ts";
import type { ModelDiagnosticMaskStore } from "./ports/out/diagnostic-mask-store.port.ts";
import {
  type ModelDiagnostic,
  type ModelDiagnosticFacts,
} from "../../../domain/model/policies/diagnostics.ts";

function memoryMasks(): ModelDiagnosticMaskStore {
  const entries = new Map<string, ModelDiagnosticMask>();
  return {
    list: () => Promise.resolve([...entries.values()]),
    set(change) {
      const key = modelDiagnosticMaskKey(change);
      if (change.masked) entries.set(key, { ...change });
      else entries.delete(key);
      return Promise.resolve();
    },
  };
}

function facts(hasInvocationBudget = false): ModelDiagnosticFacts {
  return {
    units: [{
      location: {
        elementId: "operator-a",
        source: { file: "main.sysml", line: 2, column: 3 },
      },
      kind: "conversation",
      hasInvocationBudget,
      accountableHumanDeclared: true,
    }],
    effects: [],
    networkCapabilities: [],
  };
}

Deno.test("diagnostics cache computes each digest once, including concurrent reads and version aliases", async () => {
  let computations = 0;
  let digest = "source-a";
  const service = new ModelDiagnosticsService({
    read: (version) =>
      Promise.resolve({
        version: version ?? "commit:a",
        digest,
        input: () => {
          computations++;
          return Promise.resolve(facts());
        },
      }),
  }, memoryMasks());
  const [first, alias] = await Promise.all([
    service.list(),
    service.list("branch:preview"),
  ]);
  assert.equal(computations, 1);
  assert.equal(alias.version, "branch:preview");
  first.diagnostics[0].source!.line = 999;
  assert.equal((await service.list()).diagnostics[0].source?.line, 2);
  digest = "source-b";
  await service.list();
  assert.equal(computations, 2);
});

Deno.test("a failed diagnostics computation is retried and never converted to a finding", async () => {
  let computations = 0;
  const service = new ModelDiagnosticsService({
    read: () =>
      Promise.resolve({
        version: "commit:a",
        digest: "source-a",
        input: () => {
          if (++computations === 1) {
            return Promise.reject(new Error("compiler"));
          }
          return Promise.resolve(facts());
        },
      }),
  }, memoryMasks());
  await assert.rejects(() => service.list(), /compiler/);
  assert.equal((await service.list()).diagnostics.length, 1);
  assert.equal(computations, 2);
});

Deno.test("masking preserves the listed warning across versions until its cause disappears", async () => {
  const masks = memoryMasks();
  let digest = "without-budget";
  const service = new ModelDiagnosticsService({
    read: () =>
      Promise.resolve({
        version: `commit:${digest}`,
        digest,
        input: facts(digest === "with-budget"),
      }),
  }, masks);
  const target = { code: "LOOP_WITHOUT_BUDGET", elementId: "operator-a" };
  assert.equal((await service.list()).diagnostics[0].masked, false);
  await service.setMask({ ...target, masked: true });
  const masked = (await service.list()).diagnostics;
  assert.equal(masked.length, 1);
  assert.equal(masked[0].masked, true);
  assert.deepEqual(await service.forAgent(), []);
  digest = "other-version-without-budget";
  assert.equal((await service.list()).diagnostics[0].masked, true);
  digest = "with-budget";
  assert.deepEqual((await service.list()).diagnostics, []);
  assert.equal((await masks.list()).length, 1);
  await service.setMask({ ...target, masked: false });
  digest = "without-budget";
  assert.equal((await service.list()).diagnostics[0].masked, false);
});

Deno.test("diagnostic masks are scoped to the instance and exact element", async () => {
  const reader = {
    read: () =>
      Promise.resolve({
        version: "commit:a",
        digest: "a",
        input: {
          ...facts(),
          units: [
            ...facts().units,
            { ...facts().units[0], location: { elementId: "operator-b" } },
          ],
        },
      }),
  };
  const first = new ModelDiagnosticsService(reader, memoryMasks());
  const second = new ModelDiagnosticsService(reader, memoryMasks());
  await first.setMask({
    code: "LOOP_WITHOUT_BUDGET",
    elementId: "operator-a",
    masked: true,
  });
  assert.deepEqual((await first.list()).diagnostics.map((d) => d.masked), [
    true,
    false,
  ]);
  assert.deepEqual((await second.list()).diagnostics.map((d) => d.masked), [
    false,
    false,
  ]);
});

Deno.test("only existing non-error diagnostics are maskable; agent context excludes info and is bounded", async () => {
  const diagnostics: ModelDiagnostic[] = [
    { code: "ERROR", severity: "error", finding: "present", message: "Error" },
    {
      code: "INFO",
      severity: "info",
      finding: "present",
      message: "Information",
    },
    ...Array.from({ length: 25 }, (_, index): ModelDiagnostic => ({
      code: "WARNING",
      elementId: `element-${index}`,
      severity: "warning",
      finding: "absent",
      message: "Warning",
    })),
  ];
  const service = new ModelDiagnosticsService(
    {
      read: () =>
        Promise.resolve({ version: "commit:a", digest: "a", input: facts() }),
    },
    memoryMasks(),
    () => diagnostics,
  );
  await assert.rejects(() => service.setMask({ code: "ERROR", masked: true }), {
    code: "DIAGNOSTIC_NOT_MASKABLE",
    message: "Error diagnostics cannot be masked.",
  });
  await service.setMask({ code: "INFO", masked: true });
  assert.equal((await service.list()).diagnostics[1].masked, true);
  await assert.rejects(
    () => service.setMask({ code: "UNKNOWN", masked: true }),
    {
      code: "DIAGNOSTIC_NOT_FOUND",
    },
  );
  await service.setMask({
    code: "WARNING",
    elementId: "element-0",
    masked: true,
  });
  const context = await service.forAgent();
  assert.equal(context.length, 20);
  assert.equal(context[0].severity, "error");
  assert(!context.some((d) => d.severity === "info" || d.masked));
});

Deno.test("diagnostics return a source-pinned envelope for current, historical and proposal versions", async () => {
  const reads: Array<string | undefined> = [];
  const service = new ModelDiagnosticsService({
    read(version) {
      reads.push(version);
      const selected = version ?? "commit:current";
      return Promise.resolve({
        version: selected,
        digest: `source-${selected}`,
        input: facts(selected === "branch:proposal"),
      });
    },
  }, memoryMasks());
  const current = await service.list();
  assert.deepEqual(Object.keys(current).sort(), [
    "diagnostics",
    "sourceDigest",
    "version",
  ]);
  assert.equal(current.version, "commit:current");
  assert.equal(current.sourceDigest, "source-commit:current");
  const proposed = await service.list("branch:proposal");
  assert.equal(proposed.version, "branch:proposal");
  assert.equal(proposed.sourceDigest, "source-branch:proposal");
  assert.deepEqual(proposed.diagnostics, []);
  const historical = await service.list("commit:historical");
  assert.equal(historical.diagnostics[0].code, "LOOP_WITHOUT_BUDGET");
  assert.deepEqual(reads, [undefined, "branch:proposal", "commit:historical"]);
});

Deno.test("model-wide code masks cover all matching elements and info and persist across versions", async () => {
  let version = "commit:a";
  const reader = {
    read: () =>
      Promise.resolve({
        version,
        digest: version,
        input: {
          ...facts(),
          units: [
            { ...facts().units[0], admissionMode: "builder" as const },
            {
              ...facts().units[0],
              admissionMode: "builder" as const,
              location: { elementId: "operator-b" },
            },
          ],
        },
      }),
  };
  const service = new ModelDiagnosticsService(reader, memoryMasks());
  await service.setMask({ code: "LOOP_WITHOUT_BUDGET", masked: true });
  await service.setMask({
    code: "SELF_ADMINISTERED",
    elementId: "operator-a",
    masked: true,
  });
  assert.deepEqual((await service.list()).diagnostics.map((d) => d.masked), [
    true,
    true,
    true,
    false,
  ]);
  await service.setMask({
    code: "SELF_ADMINISTERED",
    elementId: null,
    masked: true,
  });
  version = "commit:b";
  assert((await service.list()).diagnostics.every((d) => d.masked));
  await service.setMask({
    code: "LOOP_WITHOUT_BUDGET",
    elementId: null,
    masked: false,
  });
  await service.setMask({ code: "SELF_ADMINISTERED", masked: false });
  assert.deepEqual((await service.list()).diagnostics.map((d) => d.masked), [
    false,
    false,
    true,
    false,
  ]);
});

Deno.test("error diagnostics cannot be hidden by exact or model-wide masks, even if preferences are stale", async () => {
  const masks = memoryMasks();
  await masks.set({ code: "MIXED", masked: true });
  await masks.set({ code: "MIXED", elementId: "error", masked: true });
  const service = new ModelDiagnosticsService(
    {
      read: () =>
        Promise.resolve({ version: "commit:a", digest: "a", input: facts() }),
    },
    masks,
    () => [
      {
        code: "MIXED",
        elementId: "error",
        severity: "error",
        finding: "present",
        message: "Error",
      },
      {
        code: "MIXED",
        elementId: "warning",
        severity: "warning",
        finding: "present",
        message: "Warning",
      },
    ],
  );
  assert.deepEqual((await service.list()).diagnostics.map((d) => d.masked), [
    false,
    true,
  ]);
  for (const elementId of [undefined, null, "error"]) {
    await assert.rejects(
      () => service.setMask({ code: "MIXED", elementId, masked: true }),
      { code: "DIAGNOSTIC_NOT_MASKABLE" },
    );
  }
  await service.setMask({ code: "MIXED", elementId: "warning", masked: true });
  assert.deepEqual((await service.forAgent()).map((d) => d.elementId), [
    "error",
  ]);
});
