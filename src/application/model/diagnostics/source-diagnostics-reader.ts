import { projectModelDiagnosticFacts } from "../../../domain/model/policies/diagnostics.ts";
import type { ModelDiagnosticsReader } from "./ports/out/diagnostics-reader.port.ts";
import type { SourceExecutablesCompilationPort } from "../source-compilation.ts";
import type { ModelRepositoryPort } from "../repository.ts";
import { type SourceRepository } from "../source-repository.ts";
import { type SourceRevision } from "../../../domain/model/records/source-revision.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import type { ModelRevisionHeader } from "../../../domain/model/records/revision.ts";

/** The source digest includes all scopes and line moves, unlike an execution digest. */
export class SourceModelDiagnosticsReader implements ModelDiagnosticsReader {
  constructor(
    private readonly repository:
      & Pick<SourceRepository, "current" | "at" | "history">
      & Partial<Pick<ModelRepositoryPort, "header">>,
    private readonly projectId: string,
    private readonly compilation: SourceExecutablesCompilationPort,
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
        const compiled = await this.compilation.compile(
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
