import { NativeToolkitPanicError } from "../../src/adapters/out/sysml-toolkit/runtime/native-addon.ts";
import assert from "node:assert/strict";
import type {
  ToolkitElement,
  ToolkitRuntime,
  ToolkitSession,
} from "../../src/adapters/out/sysml-toolkit/runtime/loader.ts";

export interface ToolkitCall {
  method: string;
  handles: number;
  batch: boolean;
}

interface Allocation {
  method: string;
  call: number;
  frees: number;
}

/** Account for JS wrappers, not element ids: two wrappers for the same native
 * element still each need one free. The runtime and session use the native
 * facade. Injected panics exercise disposal without poisoning the addon. */
export function accountToolkitHandles(
  base: ToolkitRuntime,
  injection?: { call: number; trap: boolean },
) {
  const calls: ToolkitCall[] = [];
  const allocations: Allocation[] = [];
  const wrapped = new WeakMap<ToolkitElement, ToolkitElement>();
  const original = new WeakMap<object, ToolkitElement>();
  let sessions = 0;
  let sessionFrees = 0;
  let invalidations = 0;
  let injected = false;

  const handle = (value: ToolkitElement, method: string): ToolkitElement => {
    const known = wrapped.get(value);
    if (known) return known;
    const allocation = { method, call: calls.length, frees: 0 };
    allocations.push(allocation);
    const proxy = new Proxy(value, {
      get(target, property) {
        const member: unknown = Reflect.get(target, property, target);
        if (property === "free") {
          return () => {
            allocation.frees++;
            target.free();
          };
        }
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    wrapped.set(value, proxy);
    original.set(proxy, value);
    return proxy;
  };
  const isHandle = (value: unknown): value is ToolkitElement =>
    typeof value === "object" && value !== null && "free" in value &&
    typeof value.free === "function";
  const session = (target: ToolkitSession): ToolkitSession => {
    sessions++;
    return new Proxy(target, {
      get(target, property) {
        const member: unknown = Reflect.get(target, property, target);
        if (typeof member !== "function") return member;
        if (property === "free") {
          return () => {
            sessionFrees++;
            target.free();
          };
        }
        return (...args: unknown[]) => {
          const call: ToolkitCall = {
            method: String(property),
            handles: 0,
            batch: false,
          };
          calls.push(call);
          if (calls.length === injection?.call) {
            injected = true;
            throw injection.trap
              ? new NativeToolkitPanicError("injected handle inspection trap")
              : new Error("injected handle acquisition/inspection failure");
          }
          const result: unknown = Reflect.apply(
            member,
            target,
            args.map((arg) =>
              typeof arg === "object" && arg !== null
                ? original.get(arg) ?? arg
                : arg
            ),
          );
          const wrap = (value: unknown) => {
            if (!isHandle(value)) return value;
            call.handles++;
            return handle(value, call.method);
          };
          call.batch = Array.isArray(result);
          return Array.isArray(result) ? result.map(wrap) : wrap(result);
        };
      },
    });
  };
  const runtime: ToolkitRuntime = {
    ...base,
    createSession: (sources) => session(base.createSession(sources)),
    invalidate: () => {
      // This synthetic panic does not poison the actual native addon.
      invalidations++;
    },
  };
  return {
    runtime,
    calls,
    allocations,
    assertDisposed(label: string) {
      assert.equal(sessions, 1, `${label}: real session acquired`);
      assert.equal(sessionFrees, 1, `${label}: session freed exactly once`);
      assert.deepEqual(
        allocations.filter((allocation) => allocation.frees !== 1),
        [],
        `${label}: every allocated wrapper freed exactly once`,
      );
      if (injection) {
        assert.ok(injected, `${label}: requested failure was reached`);
        if (injection.trap) {
          assert.ok(invalidations > 0, `${label}: trap invalidates runtime`);
        }
      }
    },
  };
}
