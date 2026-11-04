import type { ValidatedSourceExecutables } from "../../domain/model/records/source-executables.ts";
import type { ScopedExecutableModel } from "../../domain/model/evolution/semantic-effects.ts";
import type { SourceRevision } from "../../domain/model/records/source-revision.ts";
import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";

export interface SourceCompilationPort {
  compile(
    revision: SourceRevision,
    projectId: string,
    systemQualifiedName?: string,
  ): Promise<ExecutableModel>;
}

export interface SourceEvolutionCompilationPort {
  compile(
    revision: SourceRevision,
    projectId: string,
  ): Promise<ScopedExecutableModel[]>;
}

export interface SourceExecutablesCompilationPort {
  compile(
    revision: SourceRevision,
    projectId: string,
  ): Promise<ValidatedSourceExecutables>;
}
