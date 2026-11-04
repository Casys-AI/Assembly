import type { ExecutableModel } from "../execution/executable-model.ts";
import type { SourceRevision } from "../records/source-revision.ts";
import { sourceSnapshot } from "../projections/source-facts.ts";
import {
  accountabilityLibrary,
  declaresAccountableHuman,
} from "./accountability.ts";
import { compareCodeUnits as compareText } from "../../primitives/canonical-json.ts";
/** Advisory model linting. These findings never grant or deny execution. */
export interface ModelDiagnosticLocation {
  elementId?: string;
  qualifiedName?: string;
  source?: { file: string; line: number; column: number };
}

export interface ModelDiagnostic extends ModelDiagnosticLocation {
  code: string;
  severity: "error" | "warning" | "info";
  pattern?: string;
  finding: "absent" | "indeterminate" | "present";
  message: string;
  remedy?: { kind: "revision-template"; template: string };
}

/** Proven source/compiled facts only; names and prose do not classify effects. */
export interface DiagnosticGraphContext {
  readonly units: readonly {
    readonly elementId: string;
    readonly kind: "conversation" | "plan";
    readonly ownerSystemId: string;
    readonly budgetPolicyId?: string;
  }[];
  readonly capabilities: readonly {
    readonly policyElementId: string;
    readonly ownerSystemId: string;
    /** Missing provenance is refused by graph validation, never synthesized. */
    readonly allowedHostsAttributeId?: string;
    readonly networkHostsAttributeId?: string;
  }[];
}

export interface ModelDiagnosticFacts {
  /** Compiler-proven associations, never business verdicts. Required for graph validation. */
  readonly graphContext?: DiagnosticGraphContext;
  units: readonly {
    location: ModelDiagnosticLocation;
    kind: "conversation" | "plan";
    hasInvocationBudget: boolean;
    admissionMode?: "human" | "builder" | "reviewer";
    /** A declaration does not establish the person's acceptance of the role. */
    accountableHumanDeclared: boolean;
  }[];
  effects: readonly {
    location: ModelDiagnosticLocation;
    effect: "construction" | "publication" | "write";
    /** Must cover this exact exposed work behavior, not another local effect. */
    hasWorkResultContract: boolean;
  }[];
  networkCapabilities: readonly {
    /** Disambiguates a policy exposed by multiple compiled systems. */
    ownerSystemId?: string;
    location: ModelDiagnosticLocation;
    /** Canonical exact hosts from an admitted SkillPolicy. */
    allowedHosts: readonly string[];
    /** Effective network scope of that policy's operator. */
    mandateHosts: readonly string[];
  }[];
}

function location(value: ModelDiagnosticLocation): ModelDiagnosticLocation {
  return {
    ...(value.elementId === undefined ? {} : { elementId: value.elementId }),
    ...(value.qualifiedName === undefined
      ? {}
      : { qualifiedName: value.qualifiedName }),
    ...(value.source === undefined ? {} : { source: { ...value.source } }),
  };
}

const severityOrder = { error: 0, warning: 1, info: 2 } as const;

function compareDiagnostics(left: ModelDiagnostic, right: ModelDiagnostic) {
  return severityOrder[left.severity] - severityOrder[right.severity] ||
    compareText(left.code, right.code) ||
    compareText(left.elementId ?? "", right.elementId ?? "") ||
    compareText(left.qualifiedName ?? "", right.qualifiedName ?? "") ||
    compareText(left.source?.file ?? "", right.source?.file ?? "") ||
    (left.source?.line ?? 0) - (right.source?.line ?? 0) ||
    (left.source?.column ?? 0) - (right.source?.column ?? 0) ||
    compareText(left.message, right.message);
}

/** Stable across input ordering and host locale; never mutates supplied facts. */
export function lintModelDiagnostics(
  facts: ModelDiagnosticFacts,
): ModelDiagnostic[] {
  const diagnostics: ModelDiagnostic[] = [];
  for (const unit of facts.units) {
    if (!unit.hasInvocationBudget) {
      diagnostics.push({
        ...location(unit.location),
        code: "LOOP_WITHOUT_BUDGET",
        severity: "warning",
        pattern: "3.6",
        finding: "absent",
        message: unit.kind === "conversation"
          ? "Conversation unit has no invocation budget policy."
          : "Executable plan has no invocation budget policy.",
        remedy: { kind: "revision-template", template: "work-budget" },
      });
    }
    if (unit.admissionMode === "builder") {
      diagnostics.push({
        ...location(unit.location),
        code: "SELF_ADMINISTERED",
        severity: "info",
        pattern: "2.1",
        finding: "present",
        message: "The operator can admit its own candidates.",
      });
    }
    if (!unit.accountableHumanDeclared) {
      diagnostics.push({
        ...location(unit.location),
        code: "NO_ACCOUNTABLE_OWNER",
        severity: "warning",
        pattern: "6.3",
        finding: "indeterminate",
        message:
          "No accountable human is declared for this unit; the model cannot establish accepted accountability.",
      });
    }
  }
  for (const effect of facts.effects) {
    if (effect.hasWorkResultContract) continue;
    const label = {
      construction: "construction",
      publication: "publication",
      write: "write",
    }[effect.effect];
    diagnostics.push({
      ...location(effect.location),
      code: "EFFECT_NOT_VERIFIED",
      severity: "warning",
      pattern: "3.4",
      finding: "absent",
      message:
        `Exposed behavior with a ${label} effect has no associated WorkResultContract.`,
      remedy: {
        kind: "revision-template",
        template: "verified-effect-closure",
      },
    });
  }
  for (const capability of facts.networkCapabilities) {
    const covered = new Set(capability.mandateHosts);
    const outside = [...new Set(capability.allowedHosts)]
      .filter((host) => !covered.has(host)).sort(compareText);
    if (!outside.length) continue;
    diagnostics.push({
      ...location(capability.location),
      code: "CAPABILITY_BEYOND_MANDATE",
      severity: "warning",
      pattern: "6.2",
      finding: "present",
      message: `SkillPolicy allows hosts outside the network mandate: ${
        outside.join(", ")
      }.`,
    });
  }
  return diagnostics.sort(compareDiagnostics);
}

/** Project compiled executable facts and explicit typed diagnostic declarations. */
// Tool reuse proposes an artifact whose later work effect needs its contract.
// Native memory/skill state commands instead await their atomic store commit
// with an audited receipt; they do not need a second WorkResultContract for it.
// An inbox, arbitrary action, or plan alone says nothing about its task's effect.
export function projectModelDiagnosticFacts(
  revision: SourceRevision,
  models: readonly ExecutableModel[],
): ModelDiagnosticFacts {
  const byId = new Map(revision.elements.map((e) => [String(e["@id"]), e]));
  const location = (elementId: string): ModelDiagnosticLocation => {
    const element = byId.get(elementId);
    const file = element?.["sysx:sourceDocument"];
    const line = element?.["sysx:sourceLine"];
    const column = element?.["sysx:sourceColumn"];
    return {
      elementId,
      ...(typeof element?.qualifiedName === "string"
        ? { qualifiedName: element.qualifiedName }
        : {}),
      ...(typeof file === "string" && Object.hasOwn(revision.sources, file) &&
          typeof line === "number" && Number.isSafeInteger(line) && line > 0 &&
          typeof column === "number" && Number.isSafeInteger(column) &&
          column > 0
        ? { source: { file, line, column } }
        : {}),
    };
  };
  const units: Array<ModelDiagnosticFacts["units"][number]> = [];
  const effectFacts: Array<ModelDiagnosticFacts["effects"][number]> = [];
  const networkCapabilities: Array<
    ModelDiagnosticFacts["networkCapabilities"][number]
  > = [];
  const graphUnits: Array<DiagnosticGraphContext["units"][number]> = [];
  const graphCapabilities: Array<
    DiagnosticGraphContext["capabilities"][number]
  > = [];
  const graphContext = () => ({
    units: [
      ...new Map(graphUnits.map((entry) => [JSON.stringify(entry), entry]))
        .values(),
    ]
      .sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b))),
    capabilities: [
      ...new Map(
        graphCapabilities.map((entry) => [JSON.stringify(entry), entry]),
      ).values(),
    ]
      .sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b))),
  });
  const plans = new Map<string, ModelDiagnosticFacts["units"][number]>();
  const firstModel = models[0];
  if (!firstModel) {
    return {
      units,
      effects: effectFacts,
      networkCapabilities,
      graphContext: graphContext(),
    };
  }
  const snapshot = sourceSnapshot(
    revision.elements,
    firstModel.identity.rootId,
  );
  const library = accountabilityLibrary(snapshot);
  // Reuse canonical source names (including native redefinitions), once per
  // snapshot. The query receives identities, never host values or verdicts.
  const attributes = new Map<string, string[]>();
  const attributeKey = (owner: string, name: string) =>
    JSON.stringify([owner, name]);
  for (const element of snapshot.elements) {
    if (element.metaclass !== "AttributeUsage") continue;
    const key = attributeKey(element.ownerId, element.name);
    const ids = attributes.get(key) ?? [];
    ids.push(element.id);
    attributes.set(key, ids);
  }
  const attributeId = (owner: string, name: string): string | undefined => {
    const ids = attributes.get(attributeKey(owner, name));
    if (ids && ids.length > 1) {
      throw new Error("Ambiguous compiled diagnostic attribute provenance");
    }
    return ids?.[0];
  };
  for (const model of models) {
    const association = {
      ownerSystemId: model.identity.systemId,
      ...(model.workBudgetPolicy
        ? { budgetPolicyId: model.workBudgetPolicy.elementId }
        : {}),
    };
    graphUnits.push({
      elementId: model.identity.systemId,
      kind: "conversation",
      ...association,
    });
    // Resolve within each compiled owner: a shared entry must retain every
    // admitted exposure rather than the last model in input ordering.
    const entries = new Map(
      (model.operatorEntries ?? []).map((entry) => [entry.id, entry]),
    );
    units.push({
      location: location(model.identity.systemId),
      kind: "conversation",
      hasInvocationBudget: !!model.workBudgetPolicy,
      admissionMode: model.configuration.builder.admissionAuthority,
      accountableHumanDeclared: declaresAccountableHuman(
        snapshot,
        library,
        model.identity.systemId,
      ),
    });
    for (const behavior of model.behaviors ?? []) {
      const entry = entries.get(behavior.targetNativeId);
      if (!entry) continue;
      // Plans and effectful primitives execute only through their native owner's
      // own unambiguous exposure (WorkPlan, ToolReuse, Information, Skills).
      if (
        behavior.callerNativeId !== model.identity.builderId ||
        model.behaviors!.filter((candidate) =>
            candidate.id === behavior.id &&
            candidate.callerNativeId === model.identity.builderId
          ).length !== 1
      ) continue;
      if (entry.kind === "work-plan") {
        graphUnits.push({ elementId: entry.id, kind: "plan", ...association });
        const plan = plans.get(entry.id);
        // WorkPlanBehavior admits only the native owner's exact exposure.
        // Foreign exposures cannot execute this plan or supply its budget.
        if (plan) {
          plan.hasInvocationBudget &&= !!model.workBudgetPolicy;
          plan.accountableHumanDeclared &&= declaresAccountableHuman(
            snapshot,
            library,
            entry.id,
            model.identity.systemId,
          );
        } else {
          plans.set(entry.id, {
            location: location(entry.id),
            kind: "plan",
            hasInvocationBudget: !!model.workBudgetPolicy,
            accountableHumanDeclared: declaresAccountableHuman(
              snapshot,
              library,
              entry.id,
              model.identity.systemId,
            ),
          });
        }
      }
      const effect = entry.kind === "reuse-tool" ? "construction" : undefined;
      if (effect) {
        effectFacts.push({
          location: location(behavior.id),
          effect,
          hasWorkResultContract: (model.workResultContracts ?? []).some((c) =>
            c.workBehaviorId === behavior.id &&
            c.callerNativeId === behavior.callerNativeId
          ),
        });
      }
    }
    if (model.skillPolicy) {
      const allowedHostsAttributeId = attributeId(
        model.skillPolicy.elementId,
        "allowedHosts",
      );
      const networkHostsAttributeId = attributeId(
        model.identity.systemId,
        "networkHosts",
      );
      if (
        networkHostsAttributeId === undefined &&
        (model.configuration.network?.allowedHosts.length ?? 0) > 0
      ) {
        throw new Error(
          "Compiled network hosts have no source attribute provenance",
        );
      }
      graphCapabilities.push({
        policyElementId: model.skillPolicy.elementId,
        ownerSystemId: model.identity.systemId,
        ...(allowedHostsAttributeId === undefined
          ? {}
          : { allowedHostsAttributeId }),
        ...(networkHostsAttributeId === undefined
          ? {}
          : { networkHostsAttributeId }),
      });
      networkCapabilities.push({
        ownerSystemId: model.identity.systemId,
        location: location(model.skillPolicy.elementId),
        allowedHosts: model.skillPolicy.allowedHosts,
        mandateHosts: model.configuration.network?.allowedHosts ?? [],
      });
    }
  }
  units.push(...plans.values());
  return {
    units,
    effects: effectFacts,
    networkCapabilities,
    graphContext: graphContext(),
  };
}
