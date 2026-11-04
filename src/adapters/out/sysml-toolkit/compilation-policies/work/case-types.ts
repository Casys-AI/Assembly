import { persistedOrder } from "../../../../../domain/primitives/persisted-order.ts";
import { sameProductName } from "../../../../../domain/model/sysml-product-names.ts";
import type { NativeCaseType } from "../../../../../domain/work/records/case-types.ts";
import {
  type CaseSchedule,
  validateCaseSchedule,
} from "../../../../../domain/work/value-objects/case-schedule.ts";
import { CaseError } from "../../../../../domain/work/errors/case.ts";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../domain/model/records/snapshot.ts";
import type { ModelIdentity } from "../../../../../domain/shared-kernel/model-identity.ts";
import { sourceValueReaders } from "../../../../../domain/model/value-objects/readers.ts";
import type { SourceValueEntry } from "../../../../../domain/model/value-objects/expressions.ts";

function requireValue(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Invalid native case type: ${reason}`);
}

/** Compile explicit local CaseType occurrences from native typed values only.
 * Importing the library alone is inert, preserving historical contract digests.
 */
export function compileCaseTypes(
  snapshot: ModelSnapshot,
  values: SourceValueEntry[],
  identity: ModelIdentity,
): NativeCaseType[] {
  const byId = new Map(
    snapshot.elements.map((element) => [element.id, element]),
  );
  const definitions = snapshot.elements.filter((element) =>
    sameProductName(element.qualifiedName, "AssemblyCases::CaseType")
  );
  if (!definitions.length) return [];
  requireValue(byId.size === snapshot.elements.length, "duplicate identity");
  requireValue(
    definitions.length === 1 && definitions[0].metaclass === "PartDefinition" &&
      sameProductName(
        byId.get(definitions[0].ownerId)?.qualifiedName,
        "AssemblyCases",
      ),
    "CaseType definition",
  );
  const definition = definitions[0];
  const fields = snapshot.elements.filter((element) =>
    element.ownerId === definition.id
  );
  const specs = {
    envelope: ["AttributeUsage", "AssemblyCases::EnvelopeKind"],
    behavior: ["ActionUsage", "Actions::Action"],
    owner: ["PartUsage", "AssemblyCore::SoftwareOperator"],
    maxInvocations: ["AttributeUsage", "ScalarValues::Integer"],
    schedule: ["AttributeUsage", "AssemblyCases::Schedule"],
  } as const;
  requireValue(fields.length === 5, "exact CaseType fields");
  for (const [name, [metaclass, type]] of Object.entries(specs)) {
    const matches = fields.filter((element) => element.name === name);
    requireValue(matches.length === 1, `declaration ${name}`);
    const field = matches[0];
    requireValue(
      field.metaclass === metaclass && field.typeIds.length === 1 &&
        (!byId.has(field.typeIds[0]) ||
          sameProductName(byId.get(field.typeIds[0])?.qualifiedName, type)) &&
        (name !== "behavior" && name !== "owner" || field.isReference),
      `declaration type ${name}`,
    );
  }
  const belongsToSystem = (element: ElementRecord): boolean => {
    const seen = new Set<string>();
    let current: ElementRecord | undefined = element;
    while (current) {
      requireValue(!seen.has(current.id), "cyclic ownership");
      seen.add(current.id);
      if (current.id === identity.systemId) return true;
      if (
        current.typeIds.some((id) =>
          sameProductName(
            byId.get(id)?.qualifiedName,
            "AssemblyLiveBuilder::ConversationSystem",
          )
        ) || /Definition$/.test(current.metaclass)
      ) return false;
      current = byId.get(current.ownerId);
    }
    return false;
  };
  const readers = sourceValueReaders(values);
  const compiled = snapshot.elements.filter((element) =>
    element.typeIds.includes(definition.id) && belongsToSystem(element)
  ).map((occurrence): NativeCaseType => {
    requireValue(
      occurrence.metaclass === "PartUsage" && !occurrence.isReference &&
        occurrence.typeIds.length === 1 &&
        occurrence.ownerId === identity.systemId,
      "CaseType must be owned directly by its system",
    );
    const members = snapshot.elements.filter((element) =>
      element.ownerId === occurrence.id
    );
    requireValue(
      members.length >= 3 && members.length <= 5 &&
        members.every((element) => Object.hasOwn(specs, element.name)),
      "exact occurrence fields",
    );
    const sourceIds = new Set([
      definition.id,
      definition.ownerId,
      occurrence.id,
      identity.systemId,
    ]);
    const read = (name: keyof typeof specs): SourceValueEntry => {
      const own = members.filter((element) => element.name === name);
      const entries = values.filter((entry) =>
        entry.owner === occurrence.id && entry.name === name
      );
      requireValue(own.length === 1 && entries.length === 1, `value ${name}`);
      const member = own[0], entry = entries[0];
      const base = fields.find((element) => element.name === name)!;
      requireValue(
        member.metaclass === base.metaclass &&
          member.typeIds.length === 1 &&
          member.typeIds[0] === base.typeIds[0] &&
          member.redefinedIds.length === 1 &&
          member.redefinedIds[0] === base.id &&
          entry.featureId === member.id &&
          (entry.multiplicity === "single" ||
            // SysML's structural [1..1] default does not cover action usages.
            // A direct native reference still identifies one exact behavior.
            name === "behavior" && entry.multiplicity === "unknown") &&
          entry.typeIds.length === 1 && entry.typeIds[0] === base.typeIds[0] &&
          entry.typeNames.length === 1 &&
          sameProductName(entry.typeNames[0], specs[name][1]) &&
          !!entry.expressionId && !!entry.featureValueId,
        `typed value ${name}`,
      );
      for (
        const id of [
          base.id,
          ...base.typeIds,
          member.id,
          entry.expressionId,
          entry.featureValueId,
        ]
      ) sourceIds.add(id);
      return entry;
    };
    const envelopeEntry = read("envelope");
    const envelope = readers.enumValue(occurrence.id, "envelope", {
      enumQualifiedName: envelopeEntry.typeNames[0],
      literals: ["conversational", "deterministic", "reassessment"],
    }) as NativeCaseType["envelope"];
    requireValue(envelopeEntry.value.kind === "enum", "native envelope enum");
    requireValue(
      envelopeEntry.value.enumId === envelopeEntry.typeIds[0],
      "envelope enum identity",
    );
    sourceIds.add(envelopeEntry.value.enumId);
    const reference = (name: "behavior" | "owner"): ElementRecord => {
      const value = read(name).value;
      requireValue(value.kind === "reference", `native reference ${name}`);
      const target = byId.get(value.elementId);
      requireValue(
        target && belongsToSystem(target),
        `local reference ${name}`,
      );
      sourceIds.add(target.id);
      return target;
    };
    const behavior = reference("behavior"), owner = reference("owner");
    requireValue(
      ["ActionUsage", "PerformActionUsage"].includes(behavior.metaclass),
      "behavior must reference an action occurrence",
    );
    const isOperator = (id: string, seen = new Set<string>()): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);
      const element = byId.get(id);
      return sameProductName(
        element?.qualifiedName,
        "AssemblyCore::SoftwareOperator",
      ) ||
        !!element?.generalIds.some((parent) => isOperator(parent, seen));
    };
    requireValue(
      owner.metaclass === "PartUsage" && !owner.isReference &&
        owner.typeIds.some((type) => isOperator(type)),
      "owner must reference a local software operator",
    );
    let maxInvocations: number | undefined;
    if (members.some((member) => member.name === "maxInvocations")) {
      const value = read("maxInvocations").value;
      requireValue(
        value.kind === "LiteralInteger" &&
          /^(0|[1-9][0-9]*)$/.test(value.value),
        "maxInvocations must be a nonnegative Integer",
      );
      maxInvocations = Number(value.value);
      requireValue(
        Number.isSafeInteger(maxInvocations),
        "maxInvocations range",
      );
    }
    let schedule: CaseSchedule | undefined;
    if (members.some((member) => member.name === "schedule")) {
      const context = { caseTypeId: occurrence.id, featureName: "schedule" };
      try {
        requireValue(
          envelope !== "conversational",
          "schedule requires a Job or Watch envelope",
        );
        const own = members.filter((member) => member.name === "schedule");
        const base = fields.find((field) => field.name === "schedule")!;
        requireValue(own.length === 1, "one native schedule");
        const member = own[0];
        const scheduleType = byId.get(member.typeIds[0]);
        const kind =
          sameProductName(scheduleType?.qualifiedName, "AssemblyCases::Every")
            ? "every"
            : sameProductName(
                scheduleType?.qualifiedName,
                "AssemblyCases::DailyAt",
              )
            ? "daily-at"
            : undefined;
        requireValue(
          member.metaclass === "AttributeUsage" &&
            member.typeIds.length === 1 && member.redefinedIds.length === 1 &&
            member.redefinedIds[0] === base.id &&
            scheduleType?.metaclass === "AttributeDefinition" &&
            scheduleType.ownerId === definition.ownerId && kind &&
            scheduleType.generalIds.length === 1 &&
            scheduleType.generalIds[0] === base.typeIds[0] &&
            !values.some((entry) =>
              entry.owner === occurrence.id && entry.name === "schedule"
            ),
          "native Every or DailyAt schedule",
        );
        for (
          const id of [base.id, ...base.typeIds, member.id, scheduleType.id]
        ) sourceIds.add(id);
        const names = kind === "every" ? ["count", "unit"] : ["hour", "minute"];
        const declarations = snapshot.elements.filter((element) =>
          element.ownerId === scheduleType.id
        );
        const children = snapshot.elements.filter((element) =>
          element.ownerId === member.id
        );
        requireValue(
          declarations.length === 2 && children.length === 2,
          "exact schedule fields",
        );
        for (const name of names) {
          const expected = name === "unit"
            ? "AssemblyCases::ScheduleUnit"
            : "ScalarValues::Natural";
          const bases = declarations.filter((element) => element.name === name);
          const owns = children.filter((element) => element.name === name);
          const entries = values.filter((entry) =>
            entry.owner === member.id && entry.name === name
          );
          requireValue(
            bases.length === 1 && owns.length === 1 && entries.length === 1,
            `schedule field ${name}`,
          );
          const declared = bases[0], child = owns[0], entry = entries[0];
          requireValue(
            declared.metaclass === "AttributeUsage" &&
              declared.typeIds.length === 1 &&
              (!byId.has(declared.typeIds[0]) ||
                sameProductName(
                  byId.get(declared.typeIds[0])?.qualifiedName,
                  expected,
                )) &&
              ["AttributeUsage", "ReferenceUsage"].includes(child.metaclass) &&
              child.typeIds.length === 1 &&
              child.typeIds[0] === declared.typeIds[0] &&
              child.redefinedIds.length === 1 &&
              child.redefinedIds[0] === declared.id &&
              entry.featureId === child.id && entry.multiplicity === "single" &&
              entry.typeIds.length === 1 &&
              entry.typeIds[0] === declared.typeIds[0] &&
              entry.typeNames.length === 1 &&
              sameProductName(entry.typeNames[0], expected) &&
              !!entry.expressionId && !!entry.featureValueId,
            `typed schedule field ${name}`,
          );
          if (name === "unit") {
            requireValue(
              entry.value.kind === "enum" &&
                entry.value.enumId === declared.typeIds[0],
              "native ScheduleUnit identity",
            );
          }
          for (
            const id of [
              declared.id,
              ...declared.typeIds,
              child.id,
              entry.expressionId,
              entry.featureValueId,
            ]
          ) sourceIds.add(id);
        }
        schedule = validateCaseSchedule(
          kind === "every"
            ? {
              kind,
              count: readers.natural(member.id, "count"),
              unit: readers.enumValue(member.id, "unit", {
                enumQualifiedName: values.find((entry) =>
                  entry.owner === member.id && entry.name === "unit"
                )!.typeNames[0]!,
                literals: ["minute", "hour", "day"],
              }),
            }
            : {
              kind,
              hour: readers.natural(member.id, "hour"),
              minute: readers.natural(member.id, "minute"),
            },
          context,
        );
      } catch (cause) {
        if (cause instanceof CaseError) throw cause;
        throw new CaseError(
          "INVALID_SCHEDULE",
          cause instanceof Error
            ? cause.message
            : "Invalid native Case schedule",
          context,
          "Declare one native Every (count >= 1, ScheduleUnit minute/hour/day) or DailyAt (hour 0..23, minute 0..59 UTC) on a Job or Watch CaseType.",
        );
      }
    }
    return {
      id: occurrence.id,
      name: occurrence.name,
      type: envelope === "conversational"
        ? "request"
        : envelope === "deterministic"
        ? "job"
        : "watch",
      envelope,
      behaviorId: behavior.id,
      ownerId: owner.id,
      ...(maxInvocations === undefined ? {} : { maxInvocations }),
      ...(schedule === undefined ? {} : { schedule }),
      sourceIds: [...sourceIds].sort(),
    };
  });
  return compiled.sort((left, right) => persistedOrder(left.id, right.id));
}
