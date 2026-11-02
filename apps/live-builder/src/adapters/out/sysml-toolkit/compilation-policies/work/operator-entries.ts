import { assert as requireValue } from "../../../../../domain/primitives/assert.ts";
import { persistedOrder } from "../../../../../domain/primitives/persisted-order.ts";
import type { ModelIdentity } from "../../../../../domain/work/dialogue.ts";
import type { OperatorEntry } from "../../../../../domain/model/records/operator-entry.ts";
import { sourceSnapshot } from "../../../../model/projections/graph/source.ts";
import { sameProductName } from "../../../../../domain/model/sysml-product-names.ts";

const signatures = {
  "AssemblyWork::InspectWorkArtifacts": [
    "inspect-work-artifacts",
    "AssemblyWork::WorkArtifactQuery",
    "catalog",
  ],
  "AssemblyWork::AgentInbox": ["inbox", "AssemblyWork::WorkRequest", "builder"],
  "AssemblyWork::ReuseTool": [
    "reuse-tool",
    "AssemblyWork::ReuseToolRequest",
    "catalog",
  ],
  "AssemblyWork::ListPublishedTools": [
    "published-tools",
    "AssemblyWork::EmptyRequest",
    "catalog",
  ],
  "AssemblyWorkPlans::ExecuteClosedPlan": [
    "work-plan",
    "AssemblyWorkPlans::WorkPlanRequest",
    "admissionGate",
  ],
  "APEContext::ReadContextEvidence": [
    "context-evidence",
    "APEContext::ContextEvidenceRequest",
    "admissionGate",
  ],
  "APEMemory::CaptureMemory": [
    "memory-capture",
    "APEMemory::CaptureMemoryRequest",
    "admissionGate",
  ],
  "APEMemory::RecallMemory": [
    "memory-recall",
    "APEMemory::RecallMemoryRequest",
    "admissionGate",
  ],
  "APEMemory::ReviseMemory": [
    "memory-revise",
    "APEMemory::ReviseMemoryRequest",
    "admissionGate",
  ],
  "APEMemory::ReviewMemory": [
    "memory-review",
    "APEMemory::ReviewMemoryRequest",
    "admissionGate",
  ],
  "APEMemory::WithdrawMemory": [
    "memory-withdraw",
    "APEMemory::WithdrawMemoryRequest",
    "admissionGate",
  ],
  "APESkills::InstallSkill": [
    "skill-install",
    "APESkills::InstallSkillRequest",
    "admissionGate",
  ],
  "APESkills::ListSkills": [
    "skill-list",
    "APESkills::ListSkillsRequest",
    "admissionGate",
  ],
  "APESkills::LoadSkill": [
    "skill-load",
    "APESkills::LoadSkillRequest",
    "admissionGate",
  ],
  "APESkills::UnloadSkill": [
    "skill-unload",
    "APESkills::UnloadSkillRequest",
    "admissionGate",
  ],
} as const;

/** Every registered occurrence carries its exact input, owner and allocation. */
export function compileOperatorEntries(
  elements: Record<string, unknown>[],
  identity: ModelIdentity,
): OperatorEntry[] {
  const snapshot = sourceSnapshot(elements, identity.rootId);
  const byId = new Map(
    snapshot.elements.map((element) => [element.id, element]),
  );
  const rawById = new Map(
    elements.map((element) => [String(element["@id"]), element]),
  );
  const typeMap = new Map<string, keyof typeof signatures>();
  for (
    const name of Object.keys(signatures) as Array<keyof typeof signatures>
  ) {
    const types = snapshot.elements.filter((element) =>
      sameProductName(element.qualifiedName, name) &&
      element.metaclass === "ActionDefinition"
    );
    requireValue(types.length <= 1, `Ambiguous operator primitive ${name}`);
    if (types[0]) typeMap.set(types[0].id, name);
  }
  const path = (id: string) => {
    const result: string[] = [], seen = new Set<string>();
    let element = byId.get(id);
    while (element && !/Package$/.test(element.metaclass)) {
      requireValue(!seen.has(element.id), "Cyclic native operator owner");
      seen.add(element.id);
      result.unshift(element.id);
      element = byId.get(element.ownerId);
    }
    return result;
  };
  const suffix = (chain: string[], full: string[]) =>
    chain.length > 0 && chain.length <= full.length &&
    chain.every((id, index) => id === full[full.length - chain.length + index]);
  const entries: OperatorEntry[] = [];
  for (const occurrence of snapshot.elements) {
    if (
      occurrence.metaclass !== "PerformActionUsage" ||
      occurrence.typeIds.length !== 1 || !typeMap.has(occurrence.typeIds[0]!)
    ) continue;
    const ownPath = path(occurrence.id);
    if (!ownPath.includes(identity.systemId)) continue;
    const typeId = occurrence.typeIds[0]!;
    const [kind, inputName, performerName] = signatures[typeMap.get(typeId)!];
    const parameters = snapshot.elements.filter((element) =>
      element.ownerId === typeId &&
      ["ItemUsage", "ReferenceUsage"].includes(element.metaclass)
    );
    const outputs = kind === "inspect-work-artifacts"
      ? parameters.filter((element) =>
        rawById.get(element.id)?.direction === "out"
      )
      : [];
    requireValue(
      kind !== "inspect-work-artifacts" ||
        outputs.length === 1 && outputs[0]!.name === "result" &&
          outputs[0]!.typeIds.length === 1 &&
          sameProductName(
            byId.get(outputs[0]!.typeIds[0]!)?.qualifiedName,
            "AssemblyToolPublicationResult::PublicationObservation",
          ),
      "Unsupported operator observation result type",
    );
    const inputs = parameters.filter((element) => !outputs.includes(element));
    requireValue(
      inputs.length === 1 && inputs[0]!.name === "request" &&
        rawById.get(inputs[0]!.id)?.direction === "in" &&
        inputs[0]!.typeIds.length === 1 &&
        sameProductName(
          byId.get(inputs[0]!.typeIds[0]!)?.qualifiedName,
          inputName,
        ),
      `Unsupported operator primitive input ${occurrence.qualifiedName}`,
    );
    const performers = snapshot.elements.filter((element) =>
      element.ownerId === identity.systemId && element.name === performerName &&
      element.metaclass === "PartUsage" && !element.isReference
    );
    requireValue(
      performers.length === 1,
      `Missing operator primitive performer ${performerName}`,
    );
    const performer = performers[0]!;
    requireValue(
      performerName !== "builder" || performer.id === identity.builderId,
      "Operator inbox is allocated to another actor",
    );
    requireValue(
      performerName !== "catalog" || performer.id === identity.catalogId,
      "Operator entry is allocated to another catalog",
    );
    const performerPath = path(performer.id);
    const allocations = snapshot.connectors.filter((connector) => {
      if (
        !/Allocation/.test(connector.metaclass) ||
        connector.ownerId !== identity.systemId || connector.ends.length !== 2
      ) return false;
      const a = connector.ends[0]!.chain.map((segment) => segment.id),
        b = connector.ends[1]!.chain.map((segment) => segment.id);
      return suffix(a, ownPath) || suffix(b, ownPath);
    });
    requireValue(
      allocations.length === 1,
      `Operator primitive requires one exact native allocation: ${occurrence.qualifiedName}`,
    );
    const a = allocations[0]!.ends[0]!.chain.map((segment) => segment.id),
      b = allocations[0]!.ends[1]!.chain.map((segment) => segment.id);
    requireValue(
      suffix(a, ownPath) && suffix(b, performerPath) ||
        suffix(b, ownPath) && suffix(a, performerPath),
      `Operator primitive requires one exact native allocation: ${occurrence.qualifiedName}`,
    );
    entries.push({
      id: occurrence.id,
      kind,
      typeId,
      performerId: performer.id,
      allocationId: allocations[0]!.id,
      sourceIds: [
        identity.systemId,
        occurrence.id,
        typeId,
        inputs[0]!.id,
        inputs[0]!.typeIds[0]!,
        ...outputs.flatMap((output) => [output.id, ...output.typeIds]),
        performer.id,
        allocations[0]!.id,
      ].toSorted(),
    });
  }
  return entries.toSorted((a, b) => persistedOrder(a.id, b.id));
}
