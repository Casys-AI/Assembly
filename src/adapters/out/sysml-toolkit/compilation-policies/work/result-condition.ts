/** Native typed scalar items and ConstraintUsage expressions, without source parsing. */
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../domain/model/records/snapshot.ts";
import type { NativeLiteral } from "../../../../../domain/model/records/native-literal.ts";
import { sourceRefs } from "../../../../../domain/model/projections/source-facts.ts";

import type { WorkResultExpression as NativeResultExpression } from "../../../../../domain/work/policies/verified-effect-closure.ts";
function check(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(`Invalid native work result contract: ${message}`);
  }
}
const safeName = (name: string) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
  !["__proto__", "prototype", "constructor"].includes(name);
export function compileNativeResultCondition(
  snapshot: ModelSnapshot,
  literals: NativeLiteral[],
  rawElements: Record<string, unknown>[],
  expected: ElementRecord,
  observed: ElementRecord,
  condition: ElementRecord,
  query?: ElementRecord,
  input?: ElementRecord,
) {
  const byId = new Map(snapshot.elements.map((e) => [e.id, e])),
    raw = new Map(rawElements.map((e) => [String(e["@id"]), e]));
  const ids = new Set<string>([expected.id, observed.id, condition.id]);
  // Toolkit preserves KerML decimal literals as LiteralRational. Retain that
  // native metaclass locally rather than widening historical source encodings.
  const rationalLiterals: NativeLiteral[] = rawElements.flatMap(
    (featureValue) => {
      if (featureValue["@type"] !== "FeatureValue") return [];
      const attributes = sourceRefs(featureValue.featureWithValue),
        values = sourceRefs(featureValue.value);
      if (attributes.length !== 1 || values.length !== 1) return [];
      const attribute = byId.get(attributes[0]!), literal = raw.get(values[0]!);
      if (!attribute || literal?.["@type"] !== "LiteralRational") return [];
      check(
        typeof literal.value === "number" && Number.isFinite(literal.value),
        "finite native rational literal",
      );
      return [{
        owner: attribute.ownerId,
        name: attribute.name,
        attributeId: attribute.id,
        literalId: values[0]!,
        kind: "LiteralRational",
        value: String(literal.value),
        typeIds: attribute.typeIds,
        typeNames: attribute.typeIds.map((id) =>
          String(raw.get(id)?.qualifiedName ?? "")
        ),
      }];
    },
  );
  const resultLiterals = [...literals, ...rationalLiterals];

  const consumedValueBindings = new Set<string>();
  const valueBindings: {
    target: "expected" | "query";
    targetField: string;
    inputField: string;
    sourceIds: string[];
  }[] = [];
  let inputFields: ElementRecord[] = [];
  const nativePath = (element: ElementRecord): string[] => {
    const path: string[] = [];
    const seen = new Set<string>();
    let current: ElementRecord | undefined = element;
    while (current && !/Package$/.test(current.metaclass)) {
      check(!seen.has(current.id), "cyclic native binding owner");
      seen.add(current.id);
      path.unshift(current.id);
      current = byId.get(current.ownerId);
    }
    return path;
  };
  const matchesPath = (chain: string[], full: string[]) =>
    chain.length >= 3 && chain.length <= full.length &&
    chain.every((id, i) => id === full[full.length - chain.length + i]);
  const item = (usage: ElementRecord, expectedValues: boolean) => {
    check(
      usage.metaclass === "ItemUsage" &&
        ["", "1", "1..1"].includes(usage.multiplicity) &&
        usage.typeIds.length === 1 &&
        usage.isReference === !expectedValues,
      "typed result item",
    );
    const type = byId.get(usage.typeIds[0]!);
    check(type?.metaclass === "ItemDefinition", "result item definition");
    check(
      type.generalIds.every((id) =>
        raw.get(id)?.qualifiedName === "Items::Item"
      ),
      "result item inheritance",
    );
    ids.add(type.id);
    const fields = snapshot.elements.filter((e) => e.ownerId === type.id);
    check(
      fields.length > 0 && fields.length <= 32 &&
        new Set(fields.map((f) => f.name)).size === fields.length,
      "bounded unique result fields",
    );
    const properties: Record<string, Record<string, unknown>> = {},
      values: Record<string, unknown> = {};
    const own = snapshot.elements.filter((e) => e.ownerId === usage.id);
    check(
      expectedValues
        ? own.length <= fields.length &&
          own.every((e) => fields.some((f) => f.name === e.name))
        : own.length === 0,
      "result item instance fields",
    );
    for (const f of fields) {
      check(
        f.metaclass === "AttributeUsage" &&
          ["", "1", "1..1"].includes(f.multiplicity) && safeName(f.name) &&
          f.typeIds.length === 1 && f.redefinedIds.length === 0,
        "result scalar field",
      );
      const scalar = raw.get(f.typeIds[0]!)?.qualifiedName;
      check(
        [
          "ScalarValues::String",
          "ScalarValues::Integer",
          "ScalarValues::Boolean",
          "ScalarValues::Real",
        ].includes(String(scalar)),
        "result scalar type",
      );
      ids.add(f.id);
      ids.add(f.typeIds[0]!);
      properties[f.name] = scalar === "ScalarValues::String"
        ? { type: "string", maxLength: 20000 }
        : scalar === "ScalarValues::Boolean"
        ? { type: "boolean" }
        : scalar === "ScalarValues::Integer"
        ? {
          type: "integer",
          minimum: Number.MIN_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER,
        }
        : { type: "number" };
      if (expectedValues) {
        const attrs = own.filter((e) => e.name === f.name),
          ls = resultLiterals.filter((l) =>
            l.owner === usage.id && l.name === f.name
          );
        check(attrs.length <= 1, "unambiguous expected field declaration");
        if (attrs[0]) {
          check(
            ["", "1", "1..1"].includes(attrs[0].multiplicity),
            "singleton result field redefinition",
          );
        }
        const targetField = attrs[0] ?? f;
        const targetPath = [...nativePath(usage), targetField.id];
        const bindings = snapshot.connectors.filter((c) =>
          c.metaclass === "BindingConnectorAsUsage" &&
          c.ends.some((end) =>
            matchesPath(end.chain.map((segment) => segment.id), targetPath)
          )
        );
        if (bindings.length) {
          check(
            input && bindings.length === 1 && bindings[0]!.ends.length === 2 &&
              ls.length === 0,
            "unique input binding without literal",
          );
          if (attrs[0]) {
            check(
              attrs[0].metaclass === "AttributeUsage" &&
                attrs[0].redefinedIds.length === 1 &&
                attrs[0].redefinedIds[0] === f.id &&
                attrs[0].typeIds.length === 1 &&
                attrs[0].typeIds[0] === f.typeIds[0],
              "typed bound target field",
            );
          }
          const binding = bindings[0]!;
          consumedValueBindings.add(binding.id);
          const other = binding.ends.filter((end) =>
            !matchesPath(end.chain.map((segment) => segment.id), targetPath)
          );
          check(other.length === 1, "non-self input binding");
          const source = other[0]!.chain.map((segment) => segment.id);
          const inputField = inputFields.find((field) =>
            matchesPath(source, [...nativePath(input!), field.id])
          );
          check(
            inputField && inputField.typeIds.length === 1 &&
              inputField.typeIds[0] === f.typeIds[0],
            "exact admitted input scalar binding type and path",
          );
          const sourceIds = [
            binding.id,
            ...binding.ends.flatMap((end) =>
              end.chain.map((segment) => segment.id)
            ),
            f.id,
            inputField.id,
          ];
          sourceIds.forEach((id) => ids.add(id));
          check(
            usage.name === "expected" || usage.name === "query",
            "binding target item",
          );
          valueBindings.push({
            target: usage.name,
            targetField: f.name,
            inputField: inputField.name,
            sourceIds: [...new Set(sourceIds)].sort(),
          });
          continue;
        }
        check(attrs.length === 1 && ls.length === 1, "expected field value");
        const a = attrs[0]!, l = ls[0]!;
        check(
          a.metaclass === "AttributeUsage" && a.redefinedIds.length === 1 &&
            a.redefinedIds[0] === f.id && a.typeIds.length === 1 &&
            a.typeIds[0] === f.typeIds[0] && l.attributeId === a.id &&
            l.typeIds.length === 1 && l.typeIds[0] === f.typeIds[0] &&
            l.typeNames.length === 1 && l.typeNames[0] === scalar &&
            (scalar === "ScalarValues::Real"
              ? ["LiteralReal", "LiteralRational", "LiteralInteger"].includes(
                l.kind,
              )
              : l.kind === `Literal${String(scalar).split("::").at(-1)}`),
          "typed expected value",
        );
        const value = scalar === "ScalarValues::String"
          ? l.value
          : scalar === "ScalarValues::Boolean"
          ? l.value === "true"
          : Number(l.value);
        check(
          scalar !== "ScalarValues::Boolean" ||
            ["true", "false"].includes(l.value),
          "expected Boolean",
        );
        check(
          typeof value !== "number" ||
            Number.isFinite(value) &&
              (scalar !== "ScalarValues::Integer" ||
                Number.isSafeInteger(value)),
          "expected number",
        );
        check(
          typeof value !== "string" || value.length <= 20000,
          "expected string bound",
        );
        values[f.name] = value;
        ids.add(a.id);
        ids.add(l.literalId);
      }
    }
    return {
      typeId: type.id,
      schema: {
        type: "object",
        properties,
        required: fields.map((f) => f.name).sort(),
        additionalProperties: false,
      },
      values,
      fields,
    };
  };
  const inputItem = input ? item(input, false) : undefined;
  inputFields = inputItem?.fields ?? [];
  const expectedItem = item(expected, true),
    observedItem = item(observed, false);
  const queryItem = query ? item(query, true) : undefined;
  for (const connector of snapshot.connectors) {
    if (connector.metaclass !== "BindingConnectorAsUsage") continue;
    if (
      input &&
      connector.ends.some((end) =>
        end.chain.some((segment, index) =>
          segment.id === input.id && index < end.chain.length - 1
        )
      )
    ) {
      check(
        consumedValueBindings.has(connector.id),
        "input fields cannot acquire foreign or cyclic bindings",
      );
    }
    if (
      connector.ends.some((end) =>
        end.chain.some((segment) =>
          segment.id === expected.id || segment.id === query?.id
        )
      )
    ) {
      check(
        consumedValueBindings.has(connector.id),
        "unsupported or foreign expected/query binding",
      );
    }
  }

  check(condition.metaclass === "ConstraintUsage", "native constraint");
  const constraint = raw.get(condition.id);
  check(constraint, "native constraint source");
  const memberships = rawElements.filter((e) =>
    e["@type"] === "ResultExpressionMembership" &&
    sourceRefs(e.owningRelatedElement).includes(condition.id)
  );
  const roots = [
    ...new Set([
      ...sourceRefs(constraint.resultExpression),
      ...memberships.flatMap((e) => sourceRefs(e.memberElement)),
    ]),
  ];
  check(roots.length === 1, "unique native constraint expression");
  memberships.forEach((e) => ids.add(String(e["@id"])));
  let count = 0;
  const usedRoots = new Set<string>();
  const compile = (
    id: string,
    seen = new Set<string>(),
  ): NativeResultExpression => {
    check(
      ++count <= 256 && seen.size < 32 && !seen.has(id),
      "bounded acyclic native expression",
    );
    seen = new Set([...seen, id]);
    ids.add(id);
    const e = raw.get(id);
    check(e, "resolved native expression");
    const meta = String(e["@type"]);
    if (
      [
        "LiteralString",
        "LiteralInteger",
        "LiteralReal",
        "LiteralRational",
        "LiteralBoolean",
      ]
        .includes(meta)
    ) {
      check(
        meta === "LiteralString"
          ? typeof e.value === "string"
          : meta === "LiteralBoolean"
          ? typeof e.value === "boolean"
          : typeof e.value === "number" && Number.isFinite(e.value) &&
            (meta !== "LiteralInteger" || Number.isSafeInteger(e.value)),
        "typed native expression literal",
      );
      return { kind: "literal", value: e.value as string | number | boolean };
    }
    if (meta === "FeatureReferenceExpression") {
      const refs = sourceRefs(e.referent);
      check(refs.length === 1, "unique native referent");
      const ref = byId.get(refs[0]!);
      check(
        ref && (ref.id === expected.id || ref.id === observed.id),
        "expression root must be expected or observed",
      );
      ids.add(ref.id);
      usedRoots.add(ref.name);
      return {
        kind: "path",
        root: ref.name as "expected" | "observed",
        path: [],
        sourceIds: [ref.id],
      };
    }
    const args = sourceRefs(e.argument);
    if (meta === "FeatureChainExpression") {
      check(args.length === 1, "native feature chain arity");
      const base = compile(args[0]!, seen),
        targets = sourceRefs(e.targetFeature);
      check(
        base.kind === "path" && base.path.length === 0 && targets.length === 1,
        "bounded typed native feature chain",
      );
      const target = byId.get(targets[0]!),
        fields = base.root === "expected"
          ? expectedItem.fields
          : observedItem.fields;
      check(
        target && fields.some((f) =>
          f.id === target.id ||
          base.root === "expected" && target.ownerId === expected.id &&
            target.name === f.name && target.redefinedIds.length === 1 &&
            target.redefinedIds[0] === f.id
        ),
        "native chain belongs to typed result item",
      );
      ids.add(target.id);
      return {
        kind: "path",
        root: base.root,
        path: [...base.path, target.name],
        sourceIds: [...(base.sourceIds ?? []), target.id],
      };
    }
    check(meta === "OperatorExpression", "supported native expression");
    const op = String(e.operator);
    if (op === "not") {
      check(args.length === 1, "not arity");
      return { kind: "unary", op: "not", operand: compile(args[0]!, seen) };
    }
    check(
      ["and", "or", "implies", "==", "!=", "<", "<=", ">", ">="].includes(op) &&
        args.length === 2,
      "supported binary native operator",
    );
    return {
      kind: "binary",
      op: op as
        | "and"
        | "or"
        | "implies"
        | "=="
        | "!="
        | "<"
        | "<="
        | ">"
        | ">=",
      left: compile(args[0]!, seen),
      right: compile(args[1]!, seen),
    };
  };
  const expression = compile(roots[0]!);
  const expressionType = (node: NativeResultExpression): string => {
    if (node.kind === "literal") return typeof node.value;
    if (node.kind === "path") {
      check(node.path.length === 1, "scalar native expression path");
      const properties = node.root === "expected"
        ? expectedItem.schema.properties
        : observedItem.schema.properties;
      const type = properties[node.path[0]!]!.type;
      return type === "integer" ? "number" : String(type);
    }
    if (node.kind === "unary") {
      check(
        expressionType(node.operand) === "boolean",
        "Boolean native not operand",
      );
      return "boolean";
    }
    const left = expressionType(node.left), right = expressionType(node.right);
    if (["and", "or", "implies"].includes(node.op)) {
      check(
        left === "boolean" && right === "boolean",
        "Boolean native logical operands",
      );
    } else if (["==", "!="].includes(node.op)) {
      check(left === right, "matching native equality types");
    } else {
      check(
        left === "number" && right === "number",
        "numeric native ordering operands",
      );
    }
    return "boolean";
  };
  check(expressionType(expression) === "boolean", "Boolean native condition");
  check(
    usedRoots.has("expected") && usedRoots.has("observed"),
    "constraint must compare expected and observed",
  );
  return {
    ...(inputItem
      ? {
        input: {
          typeId: inputItem.typeId,
          schema: inputItem.schema,
          sourceIds: [
            input!.id,
            inputItem.typeId,
            ...inputFields.flatMap((field) => [field.id, ...field.typeIds]),
          ].sort(),
        },
      }
      : {}),
    ...(valueBindings.length ? { valueBindings } : {}),
    ...(queryItem
      ? {
        query: {
          typeId: queryItem.typeId,
          schema: queryItem.schema,
          values: queryItem.values,
        },
      }
      : {}),
    expected: {
      typeId: expectedItem.typeId,
      schema: expectedItem.schema,
      values: expectedItem.values,
    },
    observed: { typeId: observedItem.typeId, schema: observedItem.schema },
    condition: {
      nativeId: condition.id,
      expression,
      sourceIds: [...ids].sort(),
    },
    sourceIds: [...ids].sort(),
  };
}
