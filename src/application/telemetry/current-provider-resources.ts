import { matchesExactRevision } from "../../domain/shared-kernel/revision-id.ts";
import type { SpaceControlPort } from "../work/request-spaces/ports.ts";
import type { RequestCaseExecutionReader } from "../work/request-spaces/conversations.ts";
import type { ClockPort } from "../work/runtime/ports.ts";
import {
  RequestSpaceError,
  requestSpaceIdentity,
} from "../../domain/work/request-spaces.ts";
import type { ProviderCallHostScope } from "./provider-call.ts";
import {
  assertProviderResourceQuery,
  type ProviderResourceQuery,
  type ProviderResourceReader,
  type ProviderResourceReadout,
} from "./provider-resource-readout.ts";

export interface CurrentProviderExecution {
  readonly operatorId: string;
  readonly runtimeRevision: number;
  readonly modelVersion: {
    readonly digest: string;
    readonly repositoryVersion?: string;
  };
}
interface CurrentProviderResourceSelection {
  readonly caseId?: string;
  /** A consistency guard, never authorization to consult another version. */
  readonly expectedVersion?: string;
}
export interface CurrentProviderResourceReadout {
  readonly schemaVersion: 1;
  readonly execution: {
    readonly kind: "main" | "case";
    readonly caseId?: string;
    readonly operatorId: string;
    readonly runtimeRevision: number;
    readonly modelVersion: {
      readonly digest: string;
      readonly repositoryVersion: string;
    };
  };
  readonly resources: ProviderResourceReadout;
}
type ProviderResourceAccessCode =
  | "PROVIDER_RESOURCE_INVALID_SELECTION"
  | "PROVIDER_RESOURCE_FORBIDDEN"
  | "PROVIDER_RESOURCE_VERSION_MISMATCH"
  | "PROVIDER_RESOURCE_UNAVAILABLE";
const messages: Record<ProviderResourceAccessCode, string> = {
  PROVIDER_RESOURCE_INVALID_SELECTION:
    "An exact supported performance selection is required.",
  PROVIDER_RESOURCE_FORBIDDEN:
    "A current authorized local session is required.",
  PROVIDER_RESOURCE_VERSION_MISMATCH:
    "Measurements for the inspected version are unavailable.",
  PROVIDER_RESOURCE_UNAVAILABLE: "Observed provider resources are unavailable.",
};
export class ProviderResourceAccessError extends Error {
  constructor(readonly code: ProviderResourceAccessCode) {
    super(messages[code]);
    this.name = "ProviderResourceAccessError";
  }
}
const unavailable = () =>
  new ProviderResourceAccessError("PROVIDER_RESOURCE_UNAVAILABLE");
const forbidden = () =>
  new ProviderResourceAccessError("PROVIDER_RESOURCE_FORBIDDEN");

/** Current executed configuration only. Host scope is injected independently of
 * model/native state IDs; read authority is checked before and after aggregation. */
export class CurrentProviderResources {
  readonly #scope: ProviderCallHostScope;
  readonly #mainSpace: string;
  constructor(
    private readonly options: {
      scope: ProviderCallHostScope;
      mainExecutionSpaceId: string;
      main(): CurrentProviderExecution | null;
      cases: RequestCaseExecutionReader;
      control: SpaceControlPort;
      reader: ProviderResourceReader;
      clock: ClockPort;
    },
  ) {
    this.#scope = Object.freeze({
      projectId: options.scope.projectId,
      systemId: options.scope.systemId,
    });
    this.#mainSpace = options.mainExecutionSpaceId;
  }

  async read(
    secret: string,
    requested: CurrentProviderResourceSelection = {},
  ): Promise<CurrentProviderResourceReadout> {
    // Copy only supported locators before the first async boundary.
    const { caseId, expectedVersion } = requested;
    if (
      (caseId !== undefined && !requestSpaceIdentity(caseId)) ||
      (expectedVersion !== undefined &&
        !matchesExactRevision(expectedVersion))
    ) {
      throw new ProviderResourceAccessError(
        "PROVIDER_RESOURCE_INVALID_SELECTION",
      );
    }
    try {
      const controller = await this.options.control.authenticateSession(secret);
      let executionSpaceId = this.#mainSpace;
      let source: CurrentProviderExecution | null;
      if (caseId === undefined) source = this.options.main();
      else {
        const selected = await this.options.cases.execution(secret, caseId);
        if (
          selected.caseId !== caseId ||
          selected.scope.projectId !== this.#scope.projectId ||
          selected.scope.systemId !== this.#scope.systemId ||
          selected.executionSpaceId === this.#mainSpace
        ) {
          throw unavailable();
        }
        executionSpaceId = selected.executionSpaceId;
        source = selected;
      }
      if (!source) throw unavailable();
      // Native runtime IDs and board projection digests do not enter this pin.
      const pin = Object.freeze({
        kind: caseId === undefined ? "main" as const : "case" as const,
        ...(caseId === undefined ? {} : { caseId }),
        operatorId: source.operatorId,
        runtimeRevision: source.runtimeRevision,
        modelVersion: Object.freeze({
          digest: source.modelVersion.digest,
          repositoryVersion: source.modelVersion.repositoryVersion ?? "",
        }),
      });
      const query: ProviderResourceQuery = Object.freeze({
        ...this.#scope,
        executionSpaceId,
        repositoryVersion: pin.modelVersion.repositoryVersion,
        modelDigest: pin.modelVersion.digest,
        endedThrough: this.options.clock.now(),
        ...(caseId === undefined ? {} : { caseId }),
      });
      assertProviderResourceQuery(query);
      if (
        typeof pin.operatorId !== "string" || !pin.operatorId.trim() ||
        pin.operatorId.length > 1024 || pin.operatorId.includes("://") ||
        // deno-lint-ignore no-control-regex -- Opaque model references exclude control characters.
        /[\u0000-\u001f\u007f]/.test(pin.operatorId) ||
        !Number.isSafeInteger(pin.runtimeRevision) || pin.runtimeRevision < 0
      ) {
        throw unavailable();
      }
      if (
        expectedVersion !== undefined &&
        expectedVersion !== query.repositoryVersion
      ) {
        throw new ProviderResourceAccessError(
          "PROVIDER_RESOURCE_VERSION_MISMATCH",
        );
      }
      await this.options.control.revalidate(controller);
      const resources = await this.options.reader.read(query);
      // A miswired port must not publish a different selection under this pin.
      if (
        Object.keys(query).some((key) =>
          resources.selection[key as keyof ProviderResourceQuery] !==
            query[key as keyof ProviderResourceQuery]
        ) || resources.selection.caseId !== query.caseId
      ) throw unavailable();
      // Resolve the actual executing binding again after the aggregate. A source
      // selection or the earlier read cannot prove that execution is still R0.
      const current = caseId === undefined
        ? this.options.main()
        : await this.options.cases.execution(secret, caseId);
      if (!current) throw unavailable();
      if (caseId !== undefined) {
        const scoped = current as Awaited<
          ReturnType<RequestCaseExecutionReader["execution"]>
        >;
        if (
          scoped.caseId !== caseId ||
          scoped.scope.projectId !== this.#scope.projectId ||
          scoped.scope.systemId !== this.#scope.systemId ||
          scoped.executionSpaceId !== executionSpaceId
        ) {
          throw new ProviderResourceAccessError(
            "PROVIDER_RESOURCE_VERSION_MISMATCH",
          );
        }
      }
      if (
        current.operatorId !== pin.operatorId ||
        current.modelVersion.digest !== pin.modelVersion.digest ||
        current.modelVersion.repositoryVersion !==
          pin.modelVersion.repositoryVersion
      ) {
        throw new ProviderResourceAccessError(
          "PROVIDER_RESOURCE_VERSION_MISMATCH",
        );
      }
      await this.options.control.revalidate(controller);
      return Object.freeze({ schemaVersion: 1, execution: pin, resources });
    } catch (error) {
      if (error instanceof ProviderResourceAccessError) throw error;
      if (
        error instanceof RequestSpaceError &&
        ["FORBIDDEN", "ADMISSION_REFUSED"].includes(error.code)
      ) throw forbidden();
      throw unavailable();
    }
  }
}
