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
export interface ModelDiagnosticFacts {
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
