import type {
  ModelToolingDescription,
  ModelToolingDiagnostic,
  ModelToolingPort,
} from "../../src/application/model/tooling.ts";
import type { CompiledModel } from "../../src/domain/model/records/compiled-model.ts";
import type { ModelToolingTarget } from "../../src/domain/model/editing/tooling.ts";

/** Read-only fixture provider, never a SysML parser or compiler.
 * Every read requires explicitly supplied fixture data, otherwise TEST_TOOLING_READ.
 * query ignores expression/source and returns a clone of its fixture; check returns
 * a clone of its diagnostics fixture. describe selects by qualified name and
 * compile/snapshot require the exact supplied sources. All returned data is cloned.
 * Every edit raises TEST_TOOLING_WRITE. The host writer's providerFailure maps
 * that code to TOOLKIT_REFUSED while retaining the message, so SourceModel tests
 * assert the refusal message. Tests that perform writes use SysmlToolkitAdapter.
 */
export class ExplicitTooling implements ModelToolingPort {
  constructor(
    readonly fixtures: {
      query?: unknown;
      check?: ModelToolingDiagnostic[];
      compiled?: CompiledModel;
      descriptions?: Record<string, ModelToolingDescription>;
    } = {},
  ) {}

  query(): Promise<unknown> {
    if (!Object.hasOwn(this.fixtures, "query")) throw this.#missing("query");
    return Promise.resolve(structuredClone(this.fixtures.query));
  }

  check() {
    if (!this.fixtures.check) throw this.#missing("check");
    return Promise.resolve(structuredClone(this.fixtures.check));
  }

  describe(_sources: Record<string, string>, target: ModelToolingTarget) {
    const description = this.fixtures.descriptions?.[target.qualifiedName];
    if (!description) throw this.#missing("description");
    return Promise.resolve(structuredClone(description));
  }

  compile(sources: Record<string, string>) {
    const compiled = this.fixtures.compiled;
    if (
      !compiled || JSON.stringify(sources) !== JSON.stringify(compiled.sources)
    ) {
      throw this.#missing("compilation for these exact sources");
    }
    return Promise.resolve(structuredClone(compiled));
  }

  async snapshot(sources: Record<string, string>) {
    const compiled = await this.compile(sources);
    return { ...compiled, version: `test:${compiled.sourceDigest}` };
  }

  edit(): never {
    throw Object.assign(
      new Error("Explicit test tooling forbids source writes"),
      {
        code: "TEST_TOOLING_WRITE",
      },
    );
  }

  #missing(read: string) {
    return Object.assign(
      new Error(`Explicit test tooling has no ${read} fixture`),
      {
        code: "TEST_TOOLING_READ",
      },
    );
  }
}
