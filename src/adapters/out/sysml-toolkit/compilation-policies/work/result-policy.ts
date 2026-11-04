import { persistedOrder } from "../../../../../domain/primitives/persisted-order.ts";
import { sameProductName } from "../../../../../domain/model/sysml-product-names.ts";
/** Compile source-owned typed expected state and native verification constraints. */
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../domain/model/records/snapshot.ts";
import type { NativeLiteral } from "../../../../../domain/model/records/native-literal.ts";
import type { NativeBehaviorContract } from "../../../../../domain/model/execution/native-contracts.ts";
import type { ModelIdentity } from "../../../../../domain/shared-kernel/model-identity.ts";
import { canonical } from "../../../../../domain/primitives/canonical-json.ts";
import { compileNativeResultCondition } from "./result-condition.ts";
import { validateWorkResultContractTemplate } from "../../../../../domain/work/policies/verified-effect-closure.ts";
import type { WorkResultContract } from "../../../../../domain/work/policies/verified-effect-closure.ts";

function check(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(`Invalid native work result contract: ${message}`);
  }
}
export function compileWorkResultContracts(
  snapshot: ModelSnapshot,
  literals: NativeLiteral[],
  identity: ModelIdentity,
  behaviors: NativeBehaviorContract[],
  rawElements: Record<string, unknown>[],
): WorkResultContract[] {
  const byId = new Map(snapshot.elements.map((e) => [e.id, e]));
  const definitions = snapshot.elements.filter((e) =>
    e.qualifiedName === "APEVerifiedEffectClosure::WorkResultContract"
  );
  if (!definitions.length) return [];
  check(
    definitions.length === 1 && definitions[0]!.metaclass === "PartDefinition",
    "definition",
  );
  const definition = definitions[0]!;
  const members = snapshot.elements.filter((e) => e.ownerId === definition.id);
  const names = [
    "work",
    "observation",
    "expected",
    "observed",
    "condition",
    "query",
    "input",
    "maxObservations",
  ];
  check(
    members.length === names.length &&
      names.every((name) =>
        members.filter((e) => e.name === name).length === 1
      ),
    "exact declaration fields",
  );
  const rawById = new Map(rawElements.map((e) => [String(e["@id"]), e]));
  for (const member of members) {
    if (member.name === "condition") {
      check(
        member.metaclass === "ConstraintUsage",
        "native condition declaration",
      );
      continue;
    }
    check(member.typeIds.length === 1, "unambiguous declaration typing");
    const typeName = rawById.get(member.typeIds[0]!)?.qualifiedName;
    if (["work", "observation"].includes(member.name)) {
      check(
        member.metaclass === "PartUsage" && member.isReference &&
          sameProductName(typeName, "AssemblyInvocations::BehaviorAccess"),
        "native access declaration",
      );
    } else if (member.name === "maxObservations") {
      check(
        member.metaclass === "AttributeUsage" &&
          typeName === "ScalarValues::Integer",
        "native observation bound declaration",
      );
    } else {
      check(
        member.metaclass === "ItemUsage" &&
          member.isReference ===
            (["observed", "input"].includes(member.name)) &&
          typeName === "Items::Item",
        "generic native result item declaration",
      );
    }
  }
  const path = (element: ElementRecord) => {
    const ids: string[] = [], seen = new Set<string>();
    let current: ElementRecord | undefined = element;
    while (current && !/Package$/.test(current.metaclass)) {
      check(!seen.has(current.id), "cyclic owner");
      seen.add(current.id);
      ids.unshift(current.id);
      current = byId.get(current.ownerId);
    }
    return ids;
  };
  const exact = (a: string[], b: string[]) =>
    a.length === b.length && a.every((id, i) => id === b[i]);
  const suffix = (a: string[], b: string[]) =>
    a.length >= 2 && a.length <= b.length && exact(a, b.slice(-a.length));
  const contracts: WorkResultContract[] = [];
  for (
    const occurrence of snapshot.elements.filter((e) =>
      e.typeIds.includes(definition.id)
    )
  ) {
    const ownerPath = path(occurrence);
    const nearest = ownerPath.slice(0, -1).reverse().map((id) => byId.get(id)!)
      .find((e) =>
        e.typeIds.some((id) =>
          sameProductName(
            byId.get(id)?.qualifiedName,
            "AssemblyLiveBuilder::ConversationSystem",
          )
        )
      );
    check(nearest, "concrete caller owner");
    if (nearest.id !== identity.systemId) continue;
    check(
      occurrence.ownerId === identity.systemId &&
        occurrence.metaclass === "PartUsage" && !occurrence.isReference &&
        occurrence.typeIds.length === 1,
      "direct caller occurrence",
    );
    const own = snapshot.elements.filter((e) => e.ownerId === occurrence.id);
    check(
      own.every((e) => names.includes(e.name)) &&
        new Set(own.map((e) => e.name)).size === own.length,
      "exact instance fields",
    );
    const ids = new Set([
      definition.ownerId,
      definition.id,
      occurrence.id,
      identity.systemId,
      identity.builderId,
    ]);
    const feature = (name: string) => {
      const base = members.find((e) => e.name === name)!;
      const matches = own.filter((e) => e.name === name);
      check(matches.length === 1, `missing ${name}`);
      const f = matches[0]!;
      check(
        f.metaclass === base.metaclass &&
          f.redefinedIds.length === 1 && f.redefinedIds[0] === base.id &&
          (name === "condition" || f.typeIds.length === 1),
        `redefinition ${name}`,
      );
      ids.add(base.id);
      ids.add(f.id);
      f.typeIds.forEach((id) => ids.add(id));
      return f;
    };
    const reference = (name: string) => {
      const f = feature(name);
      check(
        f.isReference &&
          sameProductName(
            byId.get(f.typeIds[0]!)?.qualifiedName,
            "AssemblyInvocations::BehaviorAccess",
          ),
        `reference ${name}`,
      );
      const matches = snapshot.connectors.filter((c) =>
        c.metaclass === "BindingConnectorAsUsage" &&
        c.ends.some((end) =>
          suffix(end.chain.map((e) => e.id), [...ownerPath, f.id])
        )
      );
      check(
        matches.length === 1 && matches[0]!.ends.length === 2,
        `binding ${name}`,
      );
      const c = matches[0]!;
      const others = c.ends.filter((end) =>
        !suffix(end.chain.map((e) => e.id), [...ownerPath, f.id])
      );
      check(others.length === 1, `self binding ${name}`);
      const target = byId.get(others[0]!.chain.at(-1)!.id);
      check(
        target && exact(others[0]!.chain.map((e) => e.id), path(target)),
        `qualified binding ${name}`,
      );
      const behavior = behaviors.find((b) => b.id === target.id);
      check(
        behavior && behavior.callerNativeId === identity.builderId,
        `caller access ${name}`,
      );
      ids.add(c.id);
      c.ends.flatMap((e) => e.chain).forEach((e) => ids.add(e.id));
      behavior.sourceIds.forEach((id) => ids.add(id));
      return behavior;
    };
    const work = reference("work"), observation = reference("observation");
    check(work.id !== observation.id, "distinct observation access");
    const inputSourceIds: string[] = [];
    const inputFeature = own.some((e) => e.name === "input")
      ? feature("input")
      : undefined;
    if (inputFeature) {
      check(
        inputFeature.isReference && inputFeature.typeIds.length === 1 &&
          inputFeature.typeIds[0] === work.inputTypeId,
        "exact work input refinement",
      );
      const workInputs = snapshot.elements.filter((e) =>
        e.ownerId === work.id && e.name === "input" && e.isReference &&
        e.typeIds.length === 1 && e.typeIds[0] === work.inputTypeId
      );
      check(workInputs.length === 1, "exact work access input feature");
      check(
        !snapshot.connectors.some((connector) =>
          connector.metaclass === "BindingConnectorAsUsage" &&
          connector.ends.some((end) =>
            end.chain.some((segment, index) =>
              segment.id === workInputs[0]!.id && index < end.chain.length - 1
            )
          )
        ),
        "work input schema fields cannot bind mutable case facts",
      );

      const bindings = snapshot.connectors.filter((c) =>
        c.metaclass === "BindingConnectorAsUsage" &&
        c.ends.some((end) =>
          suffix(end.chain.map((segment) => segment.id), [
            ...ownerPath,
            inputFeature.id,
          ])
        )
      );
      check(
        bindings.length === 1 && bindings[0]!.ends.length === 2,
        "exact admitted work input binding",
      );
      const other = bindings[0]!.ends.filter((end) =>
        !suffix(end.chain.map((segment) => segment.id), [
          ...ownerPath,
          inputFeature.id,
        ])
      );
      check(
        other.length === 1 && exact(
          other[0]!.chain.map((segment) => segment.id),
          [...path(byId.get(work.id)!), workInputs[0]!.id],
        ),
        "qualified admitted work input reference",
      );
      inputSourceIds.push(
        bindings[0]!.id,
        work.id,
        workInputs[0]!.id,
        ...bindings[0]!.ends.flatMap((end) =>
          end.chain.map((segment) => segment.id)
        ),
      );
      inputSourceIds.forEach((id) => ids.add(id));
    }
    const compiledCondition = compileNativeResultCondition(
      snapshot,
      literals,
      rawElements,
      feature("expected"),
      feature("observed"),
      feature("condition"),
      own.some((e) => e.name === "query") ? feature("query") : undefined,
      inputFeature,
    );
    compiledCondition.sourceIds.forEach((id) => ids.add(id));
    if (compiledCondition.input) {
      check(
        canonical(compiledCondition.input.schema) ===
          canonical(work.inputSchema),
        "input schema must equal admitted work input schema",
      );
      compiledCondition.input.sourceIds = [
        ...new Set([...compiledCondition.input.sourceIds, ...inputSourceIds]),
      ].sort();
    }

    const outputParameters = snapshot.elements.filter((element) =>
      element.ownerId === observation.targetTypeId &&
      rawById.get(element.id)?.direction === "out"
    );
    check(
      outputParameters.length === 1 &&
        ["ItemUsage", "ReferenceUsage"].includes(
          outputParameters[0]!.metaclass,
        ) &&
        ["", "1", "1..1"].includes(outputParameters[0]!.multiplicity) &&
        outputParameters[0]!.typeIds.length === 1 &&
        outputParameters[0]!.typeIds[0] === compiledCondition.observed.typeId,
      "observation action output must match observed item type",
    );
    check(
      !snapshot.elements.some((element) =>
        element.ownerId === observation.targetNativeId &&
        rawById.get(element.id)?.direction === "out"
      ),
      "unsupported overridden observation output",
    );
    ids.add(observation.targetNativeId);
    ids.add(observation.targetTypeId);
    ids.add(outputParameters[0]!.id);
    ids.add(compiledCondition.observed.typeId);

    if (compiledCondition.query) {
      const properties = observation.inputSchema.properties as
        | Record<string, unknown>
        | undefined;
      for (
        const [name, schema] of Object.entries(
          compiledCondition.query.schema.properties,
        )
      ) {
        check(
          !["workInvocationId", "workBehaviorId", "workInputDigest"].includes(
            name,
          ) &&
            properties && Object.hasOwn(properties, name) &&
            JSON.stringify(properties[name]) === JSON.stringify(schema),
          "query must match observer input schema",
        );
      }
    }
    const value = (name: string, scalar: string, optional = false) => {
      if (optional && !own.some((e) => e.name === name)) return undefined;
      const f = feature(name),
        matches = literals.filter((l) =>
          l.owner === occurrence.id && l.name === name
        );
      check(matches.length === 1, `literal ${name}`);
      const l = matches[0]!;
      check(
        l.attributeId === f.id && l.kind === `Literal${scalar}` &&
          l.typeIds.length === 1 && l.typeIds[0] === f.typeIds[0] &&
          l.typeNames.length === 1 &&
          l.typeNames[0] === `ScalarValues::${scalar}`,
        `typed literal ${name}`,
      );
      ids.add(l.literalId);
      return l.value;
    };
    const raw = value("maxObservations", "Integer")!;
    check(/^[1-8]$/.test(raw), "observation budget");
    contracts.push({
      id: occurrence.id,
      callerNativeId: identity.builderId,
      workBehaviorId: work.id,
      observationBehaviorId: observation.id,
      schemaVersion: "verified-effect-closure/v2",
      expected: compiledCondition.expected,
      observed: compiledCondition.observed,
      condition: compiledCondition.condition,
      ...(compiledCondition.input ? { input: compiledCondition.input } : {}),
      ...(compiledCondition.valueBindings
        ? { valueBindings: compiledCondition.valueBindings }
        : {}),
      ...(compiledCondition.query ? { query: compiledCondition.query } : {}),
      maxObservations: Number(raw),
      sourceIds: [...ids].sort(),
    });
  }
  check(
    new Set(contracts.map((c) => c.workBehaviorId)).size === contracts.length,
    "ambiguous work contract",
  );
  contracts.forEach(validateWorkResultContractTemplate);
  return contracts.sort((a, b) => persistedOrder(a.id, b.id));
}
