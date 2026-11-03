import type {
  BehaviorInvocationRequest,
  BehaviorInvocationResult,
} from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  NativeBehaviorContract,
} from "../../../domain/model/execution/native-contracts.ts";
import type { BehaviorModelVersion } from "../../../domain/shared-kernel/behavior-model-version.ts";

/** Exact flat input-schema match shared by native behaviors: an `object` with
 * no additional properties, exactly the named fields with the named scalar
 * types, and exactly the non-optional fields as `required`. Purely local: a
 * mismatch means "not supported", never an infrastructure failure. */
export function matchesNativeInputSchema(
  schema: Record<string, unknown>,
  fields: Record<string, string>,
  optional: readonly string[] = [],
): boolean {
  const properties = schema.properties;
  if (
    schema.type !== "object" || schema.additionalProperties !== false ||
    !properties || typeof properties !== "object" || Array.isArray(properties)
  ) return false;
  const actual = properties as Record<string, { type?: unknown }>;
  const names = Object.keys(fields).sort();
  const required = names.filter((name) => !optional.includes(name));
  return Object.keys(actual).sort().join() === names.join() &&
    names.every((name) => actual[name]?.type === fields[name]) &&
    (schema.required === undefined && required.length === 0 ||
      Array.isArray(schema.required) &&
        [...schema.required].sort().join() === required.join());
}

/** Pin only successful resolutions, like `sourceExecutableCache`: a rejection
 * evicts its pending entry and is rethrown, so a transient failure is never
 * cached as an unavailable result. A resolved value (including `null`, e.g.
 * "digest differs") is a success and stays pinned. */
export async function pinnedResolution<T>(
  pins: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
  capacity = 128,
): Promise<T> {
  let pending = pins.get(key);
  if (!pending) {
    pending = load();
    if (pins.size >= capacity) pins.delete(pins.keys().next().value!);
    pins.set(key, pending);
  }
  try {
    return await pending;
  } catch (error) {
    if (pins.get(key) === pending) pins.delete(key);
    throw error;
  }
}

/** Technical providers implement primitives; only the admitted model exposes a
 * provider's behavior to a particular caller. This port adds no domain rule.
 * `supports()` answers only "not supported" with `false`: a provider's
 * infrastructure failure (Toolkit, Git, timeout) propagates with its code
 * instead of being read downstream as "no unique registered executor". */
export interface BehaviorInvocationPort {
  supports(
    behavior: NativeBehaviorContract,
    version: BehaviorModelVersion,
  ): Promise<boolean>;
  invoke(
    request: BehaviorInvocationRequest,
    options?: { resume?: true },
  ): Promise<BehaviorInvocationResult>;
}

export class BehaviorInvocationRegistry implements BehaviorInvocationPort {
  constructor(readonly providers: readonly BehaviorInvocationPort[]) {}
  private async matches(
    behavior: NativeBehaviorContract,
    version: BehaviorModelVersion,
  ) {
    const available = await Promise.all(
      this.providers.map(async (provider) =>
        await provider.supports(behavior, version) ? provider : undefined
      ),
    );
    return available.filter((provider): provider is BehaviorInvocationPort =>
      !!provider
    );
  }
  async supports(
    behavior: NativeBehaviorContract,
    version: BehaviorModelVersion,
  ): Promise<boolean> {
    return (await this.matches(behavior, version)).length === 1;
  }
  async invoke(
    request: BehaviorInvocationRequest,
    options?: { resume?: true },
  ): Promise<BehaviorInvocationResult> {
    const matches = await this.matches(request.behavior, request.modelVersion);
    if (matches.length !== 1) {
      throw new Error("Modeled behavior has no unique registered executor");
    }
    return await matches[0]!.invoke(request, options);
  }
}
