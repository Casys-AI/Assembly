/** Test composition preserves existing scenarios while supplying technical ports. */
import { AjvSchemaValidator } from "../../src/infrastructure/ajv-schema-validation.ts";
import { SystemRuntime as Runtime } from "../../src/application/work/runtime/system.ts";
import type { SchemaValidationPort } from "../../src/application/work/behaviors/schema-validation.ts";
import { createTestNativeExecution } from "./native-execution.ts";

export { draftDigest } from "../../src/application/work/runtime/system.ts";

export class SystemRuntime extends Runtime {
  private readonly nativeFixture: ReturnType<typeof createTestNativeExecution>;
  private readonly usesFixtureDispatch: boolean;
  constructor(
    ports:
      & Omit<
        ConstructorParameters<typeof Runtime>[0],
        "schemaValidator" | "clock" | "caseNumbers"
      >
      & {
        schemaValidator?: SchemaValidationPort;
        caseNumbers?:
          import("../../src/application/work/cases/ports/out/case-number.port.ts").CaseNumberPort;
        clock?: import("../../src/application/work/runtime/ports.ts").ClockPort;
      },
  ) {
    let number = 0;
    const native = createTestNativeExecution(ports.store);
    super({
      caseNumbers: {
        allocate: async () => {
          const saved = await ports.store.load();
          number = Math.max(
            number,
            ...(saved?.cases ?? []).map((record) => record.number),
          );
          return ++number;
        },
      },
      clock: { now: () => "2026-10-24T00:00:00.000Z" },
      schemaValidator: new AjvSchemaValidator(),
      ...ports,
      store: native.store,
      execution: ports.execution ?? native.execution,
      dispatch: ports.dispatch ?? native.dispatch,
      stateHistory: ports.stateHistory ?? native.stateHistory,
      // The memory double only fills an absent port; an explicitly composed
      // host (PostgreSQL/Git) always supplies its own retained sources.
      artifactSources: ports.artifactSources ?? native.artifactSources,
    });
    this.nativeFixture = native;
    this.usesFixtureDispatch = !ports.dispatch;
  }

  override async initialize(
    ...args: Parameters<Runtime["initialize"]>
  ): Promise<void> {
    await super.initialize(...args);
    if (this.usesFixtureDispatch) {
      this.nativeFixture.bind(this);
      // The fixture's worker queue and the facade's control queue are distinct.
      this.idle = async () => {
        await super.idle();
        await this.nativeFixture.idle();
        await super.idle();
      };
    }
  }
}
