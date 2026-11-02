import { equal, throws } from "node:assert/strict";
import {
  compareWorkResult,
  instantiateWorkResultContract,
  validateResolvedWorkResultContract,
  validateWorkResultContract,
  validateWorkResultContractTemplate,
  type WorkResultContract,
  type WorkResultExpression,
} from "./verified-effect-closure.ts";
const path = (
  root: "expected" | "observed",
  name: string,
): WorkResultExpression => ({ kind: "path", root, path: [name] });
const schema = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const subject = {
  callerId: "caller",
  workInvocationId: "invocation",
  workBehaviorId: "work",
  workInputDigest: "input",
  modelVersion: { digest: "model", repositoryVersion: "commit" },
};
const contract: WorkResultContract = {
  schemaVersion: "verified-effect-closure/v2",
  id: "c",
  callerNativeId: "caller",
  workBehaviorId: "work",
  observationBehaviorId: "read",
  maxObservations: 2,
  sourceIds: ["source"],
  expected: {
    typeId: "expected",
    schema: schema({ name: { type: "string" }, active: { type: "boolean" } }),
    values: { name: "report", active: true },
  },
  observed: {
    typeId: "observed",
    schema: schema({ name: { type: "string" }, active: { type: "boolean" } }),
  },
  condition: {
    nativeId: "condition",
    sourceIds: ["condition"],
    expression: {
      kind: "binary",
      op: "and",
      left: {
        kind: "binary",
        op: "==",
        left: path("observed", "name"),
        right: path("expected", "name"),
      },
      right: {
        kind: "binary",
        op: "==",
        left: path("observed", "active"),
        right: path("expected", "active"),
      },
    },
  },
};
const observation = {
  ...subject,
  available: true,
  source: { id: "record", revision: "snapshot:1" },
  values: { name: "report", active: true },
};
Deno.test("generic native publication predicate uses typed facts and exact correlation", () => {
  validateWorkResultContract(contract);
  equal(compareWorkResult(contract, observation, subject), "verified");
  for (
    const patch of [
      { available: false },
      { source: undefined },
      { values: undefined },
      { values: { name: "report", active: "true" } },
    ]
  ) {
    equal(
      compareWorkResult(contract, { ...observation, ...patch }, subject),
      "unknown",
    );
  }
  // A key outside the contract is ignored, not an unproven effect.
  equal(
    compareWorkResult(contract, {
      ...observation,
      values: { name: "report", active: true, extra: 1 },
    }, subject),
    "verified",
  );
  // Missing or mistyped data for a contract field is never "verified".
  for (
    const values of [
      { active: true },
      { name: "report" },
      { name: 42, active: true },
      { name: "report", active: "true" },
    ]
  ) {
    equal(
      compareWorkResult(contract, { ...observation, values }, subject),
      "unknown",
    );
  }
  for (
    const patch of [{ values: { name: "report", active: false } }, {
      workInputDigest: "foreign",
    }, { callerId: "foreign" }]
  ) {
    equal(
      compareWorkResult(contract, { ...observation, ...patch }, subject),
      "contradicted",
    );
  }
});
Deno.test("an invalid completion predicate fails loudly instead of returning unknown", () => {
  const invalid: WorkResultContract = {
    ...contract,
    condition: {
      nativeId: "condition",
      sourceIds: ["condition"],
      expression: {
        kind: "binary",
        op: "==",
        left: path("observed", "name"),
        right: path("expected", "active"),
      },
    },
  };
  throws(
    () => compareWorkResult(invalid, observation, subject),
    /different types/,
  );
  const unsupported: WorkResultContract = {
    ...contract,
    condition: {
      nativeId: "condition",
      sourceIds: ["condition"],
      expression: {
        kind: "binary",
        op: "xor" as never,
        left: path("observed", "active"),
        right: path("expected", "active"),
      },
    },
  };
  throws(() => compareWorkResult(unsupported, observation, subject));
});

Deno.test("same evaluator executes a record status and numeric amount predicate; native predicate change changes result", () => {
  const record: WorkResultContract = {
    ...contract,
    expected: {
      typeId: "recordExpected",
      schema: schema({
        status: { type: "string" },
        amount: { type: "number" },
      }),
      values: { status: "saved", amount: 10 },
    },
    observed: {
      typeId: "recordObserved",
      schema: schema({
        status: { type: "string" },
        amount: { type: "number" },
      }),
    },
    condition: {
      nativeId: "recordCondition",
      sourceIds: ["recordCondition"],
      expression: {
        kind: "binary",
        op: "and",
        left: {
          kind: "binary",
          op: "==",
          left: path("observed", "status"),
          right: path("expected", "status"),
        },
        right: {
          kind: "binary",
          op: ">=",
          left: path("observed", "amount"),
          right: path("expected", "amount"),
        },
      },
    },
  };
  validateWorkResultContract(record);
  const facts = { ...observation, values: { status: "saved", amount: 12 } };
  equal(compareWorkResult(record, facts, subject), "verified");
  record.condition.expression = {
    kind: "binary",
    op: "==",
    left: path("observed", "amount"),
    right: path("expected", "amount"),
  };
  equal(compareWorkResult(record, facts, subject), "contradicted");
  equal(
    compareWorkResult(record, {
      ...facts,
      values: { status: "saved", amount: NaN },
    }, subject),
    "unknown",
  );
});
Deno.test("malformed predicates, unsupported native schemas, legacy specialization and unbounded observation refuse admission", () => {
  for (const maxObservations of [0, 9, 1.2, NaN]) {
    throws(() => validateWorkResultContract({ ...contract, maxObservations }));
  }
  throws(
    () =>
      validateWorkResultContract(
        {
          ...contract,
          schemaVersion: undefined,
        } as unknown as WorkResultContract,
      ),
    /Legacy/,
  );
  throws(() =>
    validateWorkResultContract({
      ...contract,
      condition: {
        ...contract.condition,
        expression: { kind: "path", root: "observed", path: ["missing"] },
      },
    })
  );
  throws(() =>
    validateWorkResultContract({
      ...contract,
      observed: {
        ...contract.observed,
        schema: schema({ nested: { type: "object" } }),
      },
    })
  );
});

Deno.test("native scalar bindings instantiate required amount and observation record identity from admitted work input", () => {
  const inputSchema = schema({
    amount: { type: "number" },
    recordId: { type: "string" },
  });
  const template: WorkResultContract = {
    ...contract,
    input: {
      typeId: "writeInput",
      schema: inputSchema,
      sourceIds: ["work-input"],
    },
    expected: {
      typeId: "expectedAmount",
      schema: schema({ amount: { type: "number" } }),
      values: {},
    },
    observed: {
      typeId: "observedAmount",
      schema: schema({ amount: { type: "number" } }),
    },
    query: {
      typeId: "recordQuery",
      schema: schema({ recordId: { type: "string" } }),
      values: {},
    },
    valueBindings: [{
      target: "expected",
      targetField: "amount",
      inputField: "amount",
      sourceIds: ["bindAmount"],
    }, {
      target: "query",
      targetField: "recordId",
      inputField: "recordId",
      sourceIds: ["bindRecord"],
    }],
    condition: {
      nativeId: "amountCondition",
      sourceIds: ["amountCondition"],
      expression: {
        kind: "binary",
        op: ">=",
        left: path("observed", "amount"),
        right: path("expected", "amount"),
      },
    },
  };
  validateWorkResultContractTemplate(template);
  throws(() => validateWorkResultContract(template));
  const resolved = instantiateWorkResultContract(template, {
    amount: 50,
    recordId: "invoice:17",
  });
  equal(resolved.expected.values.amount, 50);
  equal(resolved.query!.values.recordId, "invoice:17");
  equal(template.expected.values.amount, undefined);
  validateResolvedWorkResultContract(resolved, {
    amount: 50,
    recordId: "invoice:17",
  });
  equal(
    compareWorkResult(
      resolved,
      { ...observation, values: { amount: 49 } },
      subject,
    ),
    "contradicted",
  );
  equal(
    compareWorkResult(
      resolved,
      { ...observation, values: { amount: 50 } },
      subject,
    ),
    "verified",
  );
  throws(
    () =>
      validateResolvedWorkResultContract(resolved, {
        amount: 100,
        recordId: "invoice:17",
      }),
    /differs/,
  );
  const tampered = structuredClone(resolved);
  tampered.expected.values.amount = 0;
  throws(
    () =>
      validateResolvedWorkResultContract(tampered, {
        amount: 50,
        recordId: "invoice:17",
      }),
    /differs/,
  );
  throws(
    () =>
      instantiateWorkResultContract(template, {
        amount: "50",
        recordId: "invoice:17",
      }),
    /input/,
  );
  const duplicate = structuredClone(template);
  duplicate.valueBindings!.push(duplicate.valueBindings![0]!);
  throws(() => validateWorkResultContractTemplate(duplicate), /Duplicate/);
  const literalConflict = structuredClone(template);
  literalConflict.expected.values.amount = 1;
  throws(
    () => validateWorkResultContractTemplate(literalConflict),
    /conflicts/,
  );
  const missingBinding = structuredClone(template);
  missingBinding.valueBindings!.shift();
  throws(() => validateWorkResultContractTemplate(missingBinding));
  const wrongField = structuredClone(template);
  wrongField.valueBindings![0]!.inputField = "recordId";
  throws(() => validateWorkResultContractTemplate(wrongField), /types differ/);
});
