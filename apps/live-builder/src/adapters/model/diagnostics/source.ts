/** Project only facts recognized by the existing executable model compilers. */
import type {
  ModelDiagnosticFacts,
  ModelDiagnosticLocation,
} from "../../../domain/model/policies/diagnostics.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { OperatorEntry } from "../../../domain/model/records/operator-entry.ts";
import type { ModelDiagnosticsReader } from "../../../application/model/diagnostics/ports/out/diagnostics-reader.port.ts";
import {
  type SourceRepository,
  type SourceRevision,
  validateSourceExecutables,
} from "../sources/source-model.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import type { ModelRevisionHeader } from "../../../domain/model/records/revision.ts";

// These registered primitives write instance state or propose an artifact.
// An inbox, arbitrary action, or plan alone says nothing about its task's effect.
const effects: Partial<
  Record<OperatorEntry["kind"], "construction" | "write">
> = {
  "reuse-tool": "construction",
  "memory-capture": "write",
  "memory-revise": "write",
  "memory-review": "write",
  "memory-withdraw": "write",
  "skill-install": "write",
  "skill-load": "write",
  "skill-unload": "write",
};

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
  const entries = new Map(
    models.flatMap((model) =>
      (model.operatorEntries ?? []).map((entry) =>
        [
          entry.id,
          { entry, ownerId: model.identity.builderId },
        ] as const
      )
    ),
  );
  const plans = new Map<string, ModelDiagnosticFacts["units"][number]>();
  for (const model of models) {
    units.push({
      location: location(model.identity.systemId),
      kind: "conversation",
      hasInvocationBudget: !!model.workBudgetPolicy,
      admissionMode: model.configuration.builder.admissionAuthority,
      // ConfiguredMandate declares a software holder, not an accountable human.
      // Neither admissionMode=human nor humanInput identifies a responsible person.
      accountableHumanDeclared: false,
    });
    for (const behavior of model.behaviors ?? []) {
      const target = entries.get(behavior.targetNativeId);
      if (!target) continue;
      const { entry, ownerId } = target;
      // Plans and effectful primitives execute only through their native owner's
      // own unambiguous exposure (WorkPlan, ToolReuse, Information, Skills).
      if (
        ownerId !== behavior.callerNativeId ||
        behavior.callerNativeId !== model.identity.builderId ||
        model.behaviors!.filter((candidate) =>
            candidate.id === behavior.id &&
            candidate.callerNativeId === model.identity.builderId
          ).length !== 1
      ) continue;
      if (entry.kind === "work-plan") {
        const plan = plans.get(entry.id);
        // WorkPlanBehavior admits only the native owner's exact exposure.
        // Foreign exposures cannot execute this plan or supply its budget.
        if (plan) {
          plan.hasInvocationBudget &&= !!model.workBudgetPolicy;
        } else {
          plans.set(entry.id, {
            location: location(entry.id),
            kind: "plan",
            hasInvocationBudget: !!model.workBudgetPolicy,
            accountableHumanDeclared: false,
          });
        }
      }
      const effect = effects[entry.kind];
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
      networkCapabilities.push({
        location: location(model.skillPolicy.elementId),
        allowedHosts: model.skillPolicy.allowedHosts,
        mandateHosts: model.configuration.network?.allowedHosts ?? [],
      });
    }
  }
  units.push(...plans.values());
  return { units, effects: effectFacts, networkCapabilities };
}

/** The source digest includes all scopes and line moves, unlike an execution digest. */
export class SourceModelDiagnosticsReader implements ModelDiagnosticsReader {
  constructor(
    private readonly repository: Pick<
      SourceRepository,
      "current" | "at" | "header" | "history"
    >,
    private readonly projectId: string,
  ) {}

  async read(version?: string) {
    let header: ModelRevisionHeader | undefined;
    let revision: SourceRevision | undefined;
    if (
      this.repository.header &&
      (version !== undefined || this.repository.history)
    ) {
      header = await this.repository.header(
        version ?? (await this.repository.history!({ limit: 1 })).headVersion,
      );
    } else {
      revision = version === undefined
        ? await this.repository.current()
        : await this.repository.at(version);
    }
    return {
      version: header?.version ?? revision!.version,
      digest: header?.sourceDigest ??
        await modelSourceDigest(revision!.sources),
      input: async () => {
        const source = revision ?? await this.repository.at(header!.version);
        const compiled = await validateSourceExecutables(
          source,
          this.projectId,
        );
        return projectModelDiagnosticFacts(
          source,
          compiled.map((c) => c.model),
        );
      },
    };
  }
}
