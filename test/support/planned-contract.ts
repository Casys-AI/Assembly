/** Test-first access to a contract that a spec plans but the code does not yet
 * provide. A missing export, module or signature fails with a coded error that
 * names the spec step, instead of a module-link error, so a red test states its
 * real reason. Replace each use by a static import once the step lands. */
export class PlannedContractMissing extends Error {
  readonly code = "PLANNED_CONTRACT_MISSING";
  readonly recovery = { action: "implement-spec-step" } as const;
  constructor(
    readonly context: {
      step: string;
      module: string;
      name: string;
      reason: "module-absent" | "export-absent" | "signature-differs";
      detail?: string;
    },
  ) {
    super(
      `Planned contract missing (${context.step}): ${context.module}#${context.name} — ${context.reason}${
        context.detail ? ` (${context.detail})` : ""
      }`,
    );
    this.name = "PlannedContractMissing";
  }
}

/** Read a planned function export. `arity` guards a changed call shape, such
 * as positional arguments replaced by one input object. */
export function plannedExport<T>(
  module: object,
  name: string,
  contract: { step: string; module: string; arity?: number },
): T {
  const value = (module as Record<string, unknown>)[name];
  if (typeof value !== "function") {
    throw new PlannedContractMissing({
      step: contract.step,
      module: contract.module,
      name,
      reason: "export-absent",
    });
  }
  if (contract.arity !== undefined && value.length !== contract.arity) {
    throw new PlannedContractMissing({
      step: contract.step,
      module: contract.module,
      name,
      reason: "signature-differs",
      detail: `arity ${value.length}, planned ${contract.arity}`,
    });
  }
  return value as T;
}

/** Resolve a planned module loaded through a literal dynamic import, so the
 * module graph stays static and no read permission is needed. */
export async function plannedModule(
  load: () => Promise<unknown>,
  contract: { step: string; module: string },
): Promise<Record<string, unknown>> {
  try {
    return await load() as Record<string, unknown>;
  } catch (error) {
    if (
      error instanceof TypeError && error.message.includes("Module not found")
    ) {
      throw new PlannedContractMissing({
        step: contract.step,
        module: contract.module,
        name: "*",
        reason: "module-absent",
      });
    }
    throw error;
  }
}
