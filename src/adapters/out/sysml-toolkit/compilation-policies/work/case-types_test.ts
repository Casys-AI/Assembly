import { canonicalProductName } from "../../../../../domain/model/sysml-product-names.ts";
import assert from "node:assert/strict";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../domain/model/records/snapshot.ts";
import type { ModelIdentity } from "../../../../../domain/shared-kernel/model-identity.ts";
import type { SourceValueEntry } from "../../../../../domain/model/value-objects/expressions.ts";
import { compileCaseTypes } from "./case-types.ts";
import { CaseError } from "../../../../../domain/work/errors/case.ts";

function fixture() {
  const snapshot: ModelSnapshot = {
    rootId: "root",
    elements: [],
    connectors: [],
    invocations: [],
    patternIds: [],
  };
  const add = (
    id: string,
    qualifiedName: string,
    metaclass: string,
    ownerId: string,
    typeIds: string[] = [],
  ): ElementRecord => {
    const element: ElementRecord = {
      id,
      qualifiedName,
      name: qualifiedName.split("::").at(-1)!,
      metaclass,
      ownerId,
      typeIds,
      direction: "",
      generalIds: [],
      isReference: false,
      redefinedIds: [],
      multiplicity: "",
      doc: "",
    };
    snapshot.elements.push(element);
    return element;
  };
  add("pkg", "ASECases", "Package", "root");
  add("def", "ASECases::CaseType", "PartDefinition", "pkg");
  add("enum", "ASECases::EnvelopeKind", "EnumerationDefinition", "pkg");
  add("action", "Actions::Action", "ActionDefinition", "root");
  add("operator", "ASECore::SoftwareOperator", "PartDefinition", "root");
  add("integer", "ScalarValues::Integer", "DataType", "root");
  add("natural", "ScalarValues::Natural", "DataType", "root");
  add("schedule", "ASECases::Schedule", "AttributeDefinition", "pkg");
  add("base-schedule", "schedule", "AttributeUsage", "def", ["schedule"]);
  add(
    "system-type",
    "ASELiveBuilder::ConversationSystem",
    "PartDefinition",
    "root",
  );
  add("system", "system", "PartUsage", "root", ["system-type"]);
  add("builder", "builder", "PartUsage", "system", ["operator"]);
  add("conversation", "conversation", "PerformActionUsage", "system", [
    "action",
  ]);
  add("request", "request", "PartUsage", "system", ["def"]);
  const values: SourceValueEntry[] = [];
  for (
    const [name, metaclass, type, value] of [
      ["envelope", "AttributeUsage", "enum", {
        kind: "enum",
        enumId: "enum",
        enumQualifiedName: "ASECases::EnvelopeKind",
        literal: "conversational",
      }],
      ["behavior", "ActionUsage", "action", {
        kind: "reference",
        elementId: "conversation",
        qualifiedName: "conversation",
      }],
      ["owner", "PartUsage", "operator", {
        kind: "reference",
        elementId: "builder",
        qualifiedName: "builder",
      }],
      ["maxInvocations", "AttributeUsage", "integer", {
        kind: "LiteralInteger",
        value: "12",
      }],
    ] as const
  ) {
    const base = add(`base-${name}`, name, metaclass, "def", [type]);
    base.isReference = name === "behavior" || name === "owner";
    const own = add(`own-${name}`, name, metaclass, "request", [type]);
    own.redefinedIds = [base.id];
    values.push({
      owner: "request",
      name,
      featureId: own.id,
      expressionId: `expression-${name}`,
      featureValueId: `value-${name}`,
      qualifiedName: `system::request::${name}`,
      typeIds: [type],
      typeNames: [
        snapshot.elements.find((element) => element.id === type)!.qualifiedName,
      ],
      multiplicity: "single",
      value,
    });
  }
  const identity = {
    systemId: "system",
    builderId: "builder",
  } as ModelIdentity;
  return { snapshot, values, identity };
}

type ScheduleInput = { kind: "every"; count: number; unit: string } | {
  kind: "daily-at";
  hour: number;
  minute: number;
};
function scheduledFixture(schedule: ScheduleInput, envelope = "deterministic") {
  const f = fixture();
  f.values.find((entry) => entry.name === "envelope")!.value = {
    kind: "enum",
    enumId: "enum",
    enumQualifiedName: "ASECases::EnvelopeKind",
    literal: envelope,
  };
  const template = f.snapshot.elements.find((entry) =>
    entry.id === "own-maxInvocations"
  )!;
  const add = (
    id: string,
    name: string,
    metaclass: string,
    ownerId: string,
    typeIds: string[] = [],
    redefinedIds: string[] = [],
  ) => {
    const element = {
      ...structuredClone(template),
      id,
      name,
      qualifiedName: id,
      metaclass,
      ownerId,
      typeIds,
      redefinedIds,
    };
    f.snapshot.elements.push(element);
    return element;
  };
  add("unit-enum", "ScheduleUnit", "EnumerationDefinition", "pkg")
    .qualifiedName = "ASECases::ScheduleUnit";
  const definition = add("schedule-type", "", "AttributeDefinition", "pkg");
  definition.qualifiedName = schedule.kind === "every"
    ? "ASECases::Every"
    : "ASECases::DailyAt";
  definition.generalIds = ["schedule"];
  add(
    "own-schedule",
    "schedule",
    "AttributeUsage",
    "request",
    [definition.id],
    ["base-schedule"],
  );
  const fields = schedule.kind === "every"
    ? [["count", schedule.count], ["unit", schedule.unit]] as const
    : [["hour", schedule.hour], ["minute", schedule.minute]] as const;
  for (const [name, value] of fields) {
    const type = name === "unit" ? "unit-enum" : "natural";
    add(`schedule-base-${name}`, name, "AttributeUsage", definition.id, [type]);
    add(
      `schedule-own-${name}`,
      name,
      "AttributeUsage",
      "own-schedule",
      [type],
      [`schedule-base-${name}`],
    );
    f.values.push({
      owner: "own-schedule",
      name,
      featureId: `schedule-own-${name}`,
      expressionId: `expression-${name}`,
      featureValueId: `value-${name}`,
      qualifiedName: `request::schedule::${name}`,
      typeIds: [type],
      typeNames: [
        name === "unit" ? "ASECases::ScheduleUnit" : "ScalarValues::Natural",
      ],
      multiplicity: "single",
      value: name === "unit"
        ? {
          kind: "enum",
          enumId: type,
          enumQualifiedName: "ASECases::ScheduleUnit",
          literal: String(value),
        }
        : { kind: "LiteralInteger", value: String(value) },
    });
  }
  return f;
}

Deno.test("case types compile typed source enum reference and optional budget", () => {
  const f = fixture();
  const [type] = compileCaseTypes(f.snapshot, f.values, f.identity);
  assert.equal(type.type, "request");
  assert.equal(type.ownerId, "builder");
  assert.equal(type.behaviorId, "conversation");
  assert.equal(type.maxInvocations, 12);
  assert(type.sourceIds.includes("value-behavior"));
  f.snapshot.elements = f.snapshot.elements.filter((element) =>
    element.id !== "own-maxInvocations"
  );
  f.values = f.values.filter((value) => value.name !== "maxInvocations");
  assert.equal(
    compileCaseTypes(f.snapshot, f.values, f.identity)[0].maxInvocations,
    undefined,
  );
});

Deno.test("deterministic and reassessment envelopes declare job and watch Case types", () => {
  for (
    const [envelope, kind] of [["deterministic", "job"], [
      "reassessment",
      "watch",
    ]]
  ) {
    const f = fixture();
    f.values.find((entry) => entry.name === "envelope")!.value = {
      kind: "enum",
      enumId: "enum",
      enumQualifiedName: "ASECases::EnvelopeKind",
      literal: envelope,
    };
    const [type] = compileCaseTypes(f.snapshot, f.values, f.identity);
    assert.equal(type.type, kind);
    assert.equal(type.envelope, envelope);
  }
});

Deno.test("case library and another system do not opt an existing system into case encodings", () => {
  const f = fixture();
  assert.deepEqual(
    compileCaseTypes(f.snapshot, f.values, {
      ...f.identity,
      systemId: "another",
    }),
    [],
  );
  f.snapshot.elements = f.snapshot.elements.filter((element) =>
    element.id !== "request" && element.ownerId !== "request"
  );
  assert.deepEqual(compileCaseTypes(f.snapshot, [], f.identity), []);
});

Deno.test("case declarations reject spoofed enums, broken references and invalid budgets", () => {
  for (
    const [name, value] of [
      ["envelope", { kind: "LiteralString", value: "conversational" }],
      ["envelope", {
        kind: "enum",
        enumId: "foreign",
        enumQualifiedName: "Other::EnvelopeKind",
        literal: "conversational",
      }],
      ["behavior", {
        kind: "reference",
        elementId: "builder",
        qualifiedName: "builder",
      }],
      ["owner", {
        kind: "reference",
        elementId: "foreign",
        qualifiedName: "foreign",
      }],
      ["maxInvocations", { kind: "LiteralInteger", value: "-1" }],
      ["maxInvocations", {
        kind: "LiteralInteger",
        value: "9007199254740992",
      }],
      ["maxInvocations", { kind: "LiteralReal", value: "1.5" }],
    ] as const
  ) {
    const f = fixture();
    f.values.find((entry) => entry.name === name)!.value = value;
    assert.throws(() => compileCaseTypes(f.snapshot, f.values, f.identity));
  }
});

Deno.test("case declarations retain zero as an exhausted invocation ceiling", () => {
  const f = fixture();
  f.values.find((entry) => entry.name === "maxInvocations")!.value = {
    kind: "LiteralInteger",
    value: "0",
  };
  assert.equal(
    compileCaseTypes(f.snapshot, f.values, f.identity)[0].maxInvocations,
    0,
  );
});

Deno.test("case declarations fail closed on duplicate values and missing owner", () => {
  const f = fixture();
  f.values.push(f.values[0]);
  assert.throws(
    () => compileCaseTypes(f.snapshot, f.values, f.identity),
    /value envelope/,
  );
  f.values.pop();
  f.values = f.values.filter((entry) => entry.name !== "owner");
  assert.throws(
    () => compileCaseTypes(f.snapshot, f.values, f.identity),
    /value owner/,
  );
});

Deno.test("CaseType reads native structured schedules and keeps scalar and enum provenance", () => {
  for (const envelope of ["deterministic", "reassessment"]) {
    for (
      const schedule of [
        { kind: "every", count: 15, unit: "minute" },
        { kind: "every", count: 2, unit: "day" },
        { kind: "daily-at", hour: 0, minute: 0 },
        { kind: "daily-at", hour: 23, minute: 59 },
      ] as ScheduleInput[]
    ) {
      const f = scheduledFixture(schedule, envelope);
      const [type] = compileCaseTypes(f.snapshot, f.values, f.identity);
      assert.deepEqual(type.schedule, schedule);
      for (
        const id of [
          "base-schedule",
          "schedule-type",
          schedule.kind === "every" ? "expression-count" : "expression-hour",
        ]
      ) {
        assert(type.sourceIds.includes(id));
      }
    }
  }
});

Deno.test("CaseType rejects invalid native schedules with context and recovery", () => {
  const invalid = (error: unknown) =>
    error instanceof CaseError && error.code === "INVALID_SCHEDULE" &&
    error.context?.caseTypeId === "request" && !!error.recovery;
  for (
    const schedule of [
      { kind: "every", count: 0, unit: "minute" },
      { kind: "every", count: -1, unit: "hour" },
      { kind: "every", count: 1.5, unit: "day" },
      { kind: "every", count: 1, unit: "week" },
      { kind: "every", count: Number.MAX_SAFE_INTEGER, unit: "day" },
      { kind: "daily-at", hour: 24, minute: 0 },
      { kind: "daily-at", hour: 9, minute: 60 },
    ] as ScheduleInput[]
  ) {
    const f = scheduledFixture(schedule);
    assert.throws(
      () => compileCaseTypes(f.snapshot, f.values, f.identity),
      invalid,
    );
  }
  for (
    const mutate of [
      (f: ReturnType<typeof scheduledFixture>) => {
        f.values.find((entry) => entry.name === "count")!.value = {
          kind: "LiteralString",
          value: "15",
        };
      },
      (f: ReturnType<typeof scheduledFixture>) => {
        f.values.push(f.values.find((entry) => entry.name === "count")!);
      },
      (f: ReturnType<typeof scheduledFixture>) => {
        f.values.find((entry) => entry.name === "unit")!.value = {
          kind: "enum",
          enumId: "foreign",
          enumQualifiedName: "ASECases::ScheduleUnit",
          literal: "minute",
        };
      },
      (f: ReturnType<typeof scheduledFixture>) => {
        f.values = f.values.filter((entry) => entry.name !== "count");
      },
      (f: ReturnType<typeof scheduledFixture>) => {
        f.snapshot.elements.find((entry) => entry.id === "own-schedule")!
          .typeIds = ["schedule"];
      },
      (f: ReturnType<typeof scheduledFixture>) => {
        f.snapshot.elements.find((entry) => entry.id === "schedule-type")!
          .generalIds = [];
      },
    ]
  ) {
    const f = scheduledFixture({ kind: "every", count: 15, unit: "minute" });
    mutate(f);
    assert.throws(
      () => compileCaseTypes(f.snapshot, f.values, f.identity),
      invalid,
    );
  }
  const request = scheduledFixture(
    { kind: "every", count: 15, unit: "minute" },
    "conversational",
  );
  assert.throws(
    () => compileCaseTypes(request.snapshot, request.values, request.identity),
    invalid,
  );
});

Deno.test("Assembly case declarations preserve native IDs and schedule provenance", () => {
  for (
    const f of [
      fixture(),
      scheduledFixture({ kind: "every", count: 15, unit: "minute" }),
      scheduledFixture({ kind: "daily-at", hour: 8, minute: 30 }),
    ]
  ) {
    const before = JSON.stringify({ snapshot: f.snapshot, values: f.values });
    const legacy = compileCaseTypes(f.snapshot, f.values, f.identity);
    const current = structuredClone({ snapshot: f.snapshot, values: f.values });
    for (const element of current.snapshot.elements) {
      element.qualifiedName = canonicalProductName(element.qualifiedName);
    }
    for (const entry of current.values) {
      entry.typeNames = entry.typeNames.map(canonicalProductName);
      if (entry.value.kind === "enum") {
        entry.value.enumQualifiedName = canonicalProductName(
          entry.value.enumQualifiedName,
        );
      }
    }
    assert.deepEqual(
      compileCaseTypes(current.snapshot, current.values, f.identity),
      legacy,
    );
    assert.equal(
      JSON.stringify({ snapshot: f.snapshot, values: f.values }),
      before,
    );
  }
});
