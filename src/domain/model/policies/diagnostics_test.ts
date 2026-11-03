import {
  lintModelDiagnostics,
  type ModelDiagnostic,
  type ModelDiagnosticFacts,
} from "./diagnostics.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

const location = {
  elementId: "unit-1",
  qualifiedName: "Workshop::builder",
  source: { file: "configuration.sysml", line: 42, column: 5 },
};
const unit: ModelDiagnosticFacts["units"][number] = {
  location,
  kind: "conversation",
  hasInvocationBudget: true,
  admissionMode: "human",
  accountableHumanDeclared: true,
};

function lint(
  changes: Partial<ModelDiagnosticFacts> = {},
): ModelDiagnostic[] {
  return lintModelDiagnostics({
    units: [],
    effects: [],
    networkCapabilities: [],
    ...changes,
  });
}

Deno.test("model diagnostics: conversation and plan lack an invocation budget", () => {
  for (const kind of ["conversation", "plan"] as const) {
    const diagnostics = lint({
      units: [{ ...unit, kind, hasInvocationBudget: false }],
    });
    equal(diagnostics.length, 1);
    const diagnostic = diagnostics[0]!;
    equal(diagnostic.code, "LOOP_WITHOUT_BUDGET");
    equal(diagnostic.severity, "warning");
    equal(diagnostic.pattern, "3.6");
    equal(diagnostic.finding, "absent");
    equal(diagnostic.elementId, location.elementId);
    equal(diagnostic.qualifiedName, location.qualifiedName);
    equal(diagnostic.source, location.source);
    equal(diagnostic.remedy, {
      kind: "revision-template",
      template: "work-budget",
    });
    equal(lint({ units: [{ ...unit, kind }] }), []);
  }
});

Deno.test("model diagnostics: every proven effect requires its own result contract", () => {
  for (const effect of ["construction", "publication", "write"] as const) {
    const diagnostics = lint({
      effects: [{ location, effect, hasWorkResultContract: false }],
    });
    equal(diagnostics.length, 1);
    equal(diagnostics[0]!.code, "EFFECT_NOT_VERIFIED");
    equal(diagnostics[0]!.severity, "warning");
    equal(diagnostics[0]!.pattern, "3.4");
    equal(diagnostics[0]!.finding, "absent");
    equal(
      lint({ effects: [{ location, effect, hasWorkResultContract: true }] }),
      [],
    );
  }
});

Deno.test("model diagnostics: a skill host outside the exact mandate is reported", () => {
  const diagnostics = lint({
    networkCapabilities: [{
      location,
      allowedHosts: ["z.example.org", "example.org", "a.example.org"],
      mandateHosts: ["example.org"],
    }],
  });
  equal(diagnostics.length, 1);
  equal(diagnostics[0]!.code, "CAPABILITY_BEYOND_MANDATE");
  equal(diagnostics[0]!.severity, "warning");
  equal(diagnostics[0]!.pattern, "6.2");
  equal(diagnostics[0]!.finding, "present");
  equal(
    diagnostics[0]!.message,
    "SkillPolicy allows hosts outside the network mandate: a.example.org, z.example.org.",
  );
  equal(
    lint({
      networkCapabilities: [{
        location,
        allowedHosts: ["example.org"],
        mandateHosts: ["example.org", "docs.example.org"],
      }],
    }),
    [],
  );
  equal(
    lint({
      networkCapabilities: [{ location, allowedHosts: [], mandateHosts: [] }],
    }),
    [],
  );
});

Deno.test("model diagnostics: builder admission is information without a remedy", () => {
  const diagnostics = lint({
    units: [{ ...unit, admissionMode: "builder" }],
  });
  equal(diagnostics.length, 1);
  equal(diagnostics[0]!.code, "SELF_ADMINISTERED");
  equal(diagnostics[0]!.severity, "info");
  equal(diagnostics[0]!.pattern, "2.1");
  equal(diagnostics[0]!.finding, "present");
  equal(diagnostics[0]!.remedy, undefined);
  for (const admissionMode of ["human", "reviewer", undefined] as const) {
    equal(lint({ units: [{ ...unit, admissionMode }] }), []);
  }
});

Deno.test("model diagnostics: absent human accountability remains indeterminate", () => {
  const diagnostics = lint({
    units: [{ ...unit, accountableHumanDeclared: false }],
  });
  equal(diagnostics.length, 1);
  equal(diagnostics[0]!.code, "NO_ACCOUNTABLE_OWNER");
  equal(diagnostics[0]!.severity, "warning");
  equal(diagnostics[0]!.pattern, "6.3");
  equal(diagnostics[0]!.finding, "indeterminate");
  // A human admission choice does not itself declare an accountable owner.
  equal(unit.admissionMode, "human");
  equal(lint({ units: [unit] }), []);
});

Deno.test("model diagnostics: deterministic ordering and independent returned locations", () => {
  const facts: ModelDiagnosticFacts = {
    units: ["z", "a"].map((elementId) => ({
      ...unit,
      location: { ...location, elementId },
      admissionMode: "builder",
      hasInvocationBudget: false,
      accountableHumanDeclared: false,
    })),
    effects: ["z", "a"].map((elementId) => ({
      location: { ...location, elementId },
      effect: "write",
      hasWorkResultContract: false,
    })),
    networkCapabilities: [{
      location,
      allowedHosts: ["z.example.org", "a.example.org", "z.example.org"],
      mandateHosts: [],
    }],
  };
  const before = JSON.stringify(facts);
  const diagnostics = lintModelDiagnostics(facts);
  equal(
    diagnostics,
    lintModelDiagnostics({
      units: [...facts.units].reverse(),
      effects: [...facts.effects].reverse(),
      networkCapabilities: [{
        ...facts.networkCapabilities[0]!,
        allowedHosts: [...facts.networkCapabilities[0]!.allowedHosts].reverse(),
      }],
    }),
  );
  equal(JSON.stringify(facts), before);
  equal(
    diagnostics.map(({ code, elementId }) => [code, elementId]),
    [
      ["CAPABILITY_BEYOND_MANDATE", "unit-1"],
      ["EFFECT_NOT_VERIFIED", "a"],
      ["EFFECT_NOT_VERIFIED", "z"],
      ["LOOP_WITHOUT_BUDGET", "a"],
      ["LOOP_WITHOUT_BUDGET", "z"],
      ["NO_ACCOUNTABLE_OWNER", "a"],
      ["NO_ACCOUNTABLE_OWNER", "z"],
      ["SELF_ADMINISTERED", "a"],
      ["SELF_ADMINISTERED", "z"],
    ],
  );
  diagnostics[0]!.source!.line = 99;
  equal(location.source.line, 42);
  equal(JSON.stringify(facts), before);
});

Deno.test("model diagnostics: empty facts never manufacture compilation errors", () => {
  equal(lint(), []);
});
