import { type CasesSnapshot } from "../../../domain/work/entities/cases.ts";
import { CaseError } from "../../../domain/work/errors/case.ts";

interface CaseRuntime {
  readonly cases: CasesSnapshot;
  closeCase(id: string, outcome: "done" | "abandoned"): Promise<void>;
  runCase(id: string): Promise<void>;
  pauseCase(id: string): Promise<void>;
  resumeCase(id: string): Promise<void>;
  stopCase(id: string): Promise<void>;
}

/** One read/command surface for the Cases owned by all registered operators. */
export class OperatorCases {
  constructor(
    private readonly source: {
      systemId(): string;
      runtimes(): readonly CaseRuntime[];
      onChange(listener: () => void): () => void;
    },
  ) {}

  get cases(): CasesSnapshot {
    return {
      systemId: this.source.systemId(),
      cases: this.source.runtimes().flatMap((runtime) =>
        runtime.cases.cases.map((record) => {
          const visible = structuredClone(record);
          delete visible.scheduling;
          return visible;
        })
      ),
    };
  }

  async closeCase(id: string, outcome: "done" | "abandoned"): Promise<void> {
    await this.runtimeFor(id).closeCase(id, outcome);
  }

  async runCase(id: string): Promise<void> {
    await this.runtimeFor(id).runCase(id);
  }

  async pauseCase(id: string): Promise<void> {
    await this.runtimeFor(id).pauseCase(id);
  }

  async resumeCase(id: string): Promise<void> {
    await this.runtimeFor(id).resumeCase(id);
  }

  async stopCase(id: string): Promise<void> {
    await this.runtimeFor(id).stopCase(id);
  }

  private runtimeFor(id: string): CaseRuntime {
    const runtime = this.source.runtimes().find((runtime) =>
      runtime.cases.cases.some((entry) => entry.id === id)
    );
    if (!runtime) {
      throw new CaseError(
        "NOT_FOUND",
        "Unknown Case",
        { caseId: id },
        "Refresh the Cases collection and select an existing Case.",
      );
    }
    return runtime;
  }

  onChange(listener: (snapshot: CasesSnapshot) => void): () => void {
    return this.source.onChange(() => listener(this.cases));
  }
}
