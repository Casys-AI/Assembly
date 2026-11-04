/** Passive, bounded observation of the owned source-publication witness. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { openModelBackend } from "../../src/composition/model-backend.ts";
import type {
  RequestSourceWriteFacade,
  RequestSourceWriteResolver,
} from "../../src/application/model/publication/ports/out/request-source-publication.port.ts";

type Backend = Pick<
  Awaited<ReturnType<typeof openModelBackend>>,
  "compiler" | "buildService" | "queue"
>;

/** Keep plain worker envelopes and their causes useful without dumping payloads. */
export function sourcePublicationError(error: unknown) {
  const scrub = (value: string, limit = 1200) =>
    value.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, (url) => {
      const source = url.match(
        /^file:\/\/\/(?:[^?#]*\/)?([A-Za-z0-9_.-]+\.(?:[cm]?[jt]s|[jt]sx)):(\d+):(\d+)(\)?)$/i,
      );
      return source
        ? `[source ${source[1]}:${source[2]}:${source[3]}]${source[4]}`
        : "[redacted URL]";
    })
      .slice(0, limit);
  const pending = [{ path: "error", value: error }];
  const seen = new Set<object>();
  const causes: Array<Record<string, unknown>> = [];
  while (pending.length && causes.length < 6) {
    const { path, value } = pending.shift()!;
    if (!value || typeof value !== "object") {
      try {
        causes.push({ path, value: scrub(String(value)) });
      } catch {
        causes.push({ path, inspectionUnavailable: true });
      }
      continue;
    }
    if (seen.has(value)) {
      causes.push({ path, cycle: true });
      continue;
    }
    seen.add(value);
    try {
      const item = value as Record<string, unknown>;
      const detail: Record<string, unknown> = {
        path,
        keys: Object.keys(item).slice(0, 12).map((key) => scrub(key, 80)),
      };
      for (const field of ["name", "code", "message", "stack", "recovery"]) {
        const entry = item[field];
        if (typeof entry === "string") {
          detail[field] = scrub(entry, field === "stack" ? 4000 : 1200);
        }
      }
      if (item.context && typeof item.context === "object") {
        const context = item.context as Record<string, unknown>;
        const retained: Record<string, string> = {};
        for (const key of ["reason", "code", "recovery"]) {
          const entry = context[key];
          if (typeof entry === "string") {
            retained[key] = scrub(entry);
          }
        }
        detail.context = retained;
      }
      if (item.meta && typeof item.meta === "object") {
        const meta = item.meta as Record<string, unknown>;
        const retained: Record<string, unknown> = {};
        for (
          const key of ["operation", "timeout", "timeTaken", "code", "message"]
        ) {
          const entry = meta[key];
          if (typeof entry === "string") retained[key] = scrub(entry);
          else if (
            typeof entry === "number" && Number.isFinite(entry) ||
            typeof entry === "boolean"
          ) retained[key] = entry;
        }
        detail.meta = retained;
      }
      for (const key of ["cause", "error"]) {
        if (item[key] !== undefined && pending.length < 6) {
          pending.push({ path: `${path}.${key}`, value: item[key] });
        }
      }
      if (value instanceof AggregateError) {
        for (
          let index = 0;
          index < value.errors.length && pending.length < 6;
          index++
        ) {
          pending.push({
            path: `${path}.errors[${index}]`,
            value: value.errors[index],
          });
        }
      }
      causes.push(detail);
    } catch {
      causes.push({ path, inspectionUnavailable: true });
    }
  }
  return { causes, truncated: pending.length > 0 };
}

/** Decorate only shared test-owned public instances; never replace an outcome. */
export function observeSourcePublication(
  backend: Backend,
  resolver: RequestSourceWriteResolver,
) {
  const scope = new AsyncLocalStorage<string>();
  const active = new Map<number, Record<string, unknown>>();
  const events: Array<Record<string, unknown>> = [];
  const restores: Array<() => void> = [];
  let sequence = 0, eventCount = 0, omittedActive = 0;
  const preserve = (target: object, property: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    restores.push(() => {
      if (descriptor) Object.defineProperty(target, property, descriptor);
      else Reflect.deleteProperty(target, property);
    });
  };
  const compilerStats = () => {
    try {
      return backend.compiler.stats();
    } catch {
      return { unavailable: true };
    }
  };
  const initialCompilerStats = compilerStats();
  const record = (event: Record<string, unknown>) => {
    const observed = { ...event, eventSequence: ++eventCount };
    events.push(observed);
    if (events.length > 64) events.shift();
    if (eventCount <= 64) {
      try {
        console.info(
          "Owned source publication phase",
          JSON.stringify(observed),
        );
      } catch { /* Observation must not change the original operation. */ }
    }
  };
  async function observe<T>(
    phase: string,
    operation: () => Promise<T>,
    commandId = scope.getStore(),
  ): Promise<T> {
    const id = ++sequence, started = performance.now();
    const entry = {
      id,
      phase,
      commandId,
      started,
      utc: new Date().toISOString(),
      ...(phase === "compiler.compile" ? { compiler: compilerStats() } : {}),
    };
    const retained = active.size < 64;
    if (retained) active.set(id, entry);
    else omittedActive++;
    record({ ...entry, event: "begin" });
    try {
      const result = await operation();
      record({
        ...entry,
        event: "end",
        utc: new Date().toISOString(),
        elapsedMs: performance.now() - started,
        ...(phase === "compiler.compile" ? { compiler: compilerStats() } : {}),
      });
      return result;
    } catch (error) {
      record({
        ...entry,
        event: "error",
        utc: new Date().toISOString(),
        elapsedMs: performance.now() - started,
        error: sourcePublicationError(error),
        ...(phase === "compiler.compile" ? { compiler: compilerStats() } : {}),
      });
      throw error;
    } finally {
      if (retained) active.delete(id);
      else omittedActive--;
    }
  }
  preserve(backend.compiler, "compile");
  const compile = backend.compiler.compile;
  backend.compiler.compile = (...args) =>
    observe(
      "compiler.compile",
      () => Reflect.apply(compile, backend.compiler, args),
    );
  preserve(backend.buildService, "ensure");
  const ensure = backend.buildService.ensure;
  backend.buildService.ensure = (...args) =>
    observe(
      "build.ensure",
      () => Reflect.apply(ensure, backend.buildService, args),
    );
  preserve(backend.buildService, "resolve");
  const resolveBuild = backend.buildService.resolve;
  backend.buildService.resolve = (...args) =>
    observe(
      "build.resolve",
      () => Reflect.apply(resolveBuild, backend.buildService, args),
    );

  preserve(backend.queue, "guardPublication");
  const guard = backend.queue.guardPublication;
  backend.queue.guardPublication = ((lease, leaseMs, operation) =>
    observe(
      "queue.guardPublication",
      () =>
        Reflect.apply(guard, backend.queue, [
          lease,
          leaseMs,
          () => observe("queue.gitEffect", operation, lease.commandId),
        ]),
      lease.commandId,
    )) as typeof guard;
  // V2 Request publication calls this entry directly, not guardPublication.
  preserve(backend.queue, "guardRequestPublication");
  const requestGuard = backend.queue.guardRequestPublication;
  backend.queue.guardRequestPublication = (
    lease,
    leaseMs,
    context,
    operation,
  ) =>
    observe(
      "queue.guardRequestPublication",
      () =>
        Reflect.apply(requestGuard, backend.queue, [
          lease,
          leaseMs,
          context,
          () => observe("queue.requestGitEffect", operation, lease.commandId),
        ]),
      lease.commandId,
    );

  preserve(resolver, "resolve");
  const resolveSource = resolver.resolve;
  resolver.resolve = async (...args) => {
    const commandId = args[0].command.commandId;
    const facade = await scope.run(
      commandId,
      () =>
        observe(
          "repository.resolve",
          () => Reflect.apply(resolveSource, resolver, args),
        ),
    );
    const wrapped: RequestSourceWriteFacade = {
      get destination() {
        return facade.destination;
      },
      at: (...input) => Reflect.apply(facade.at, facade, input),
      current: (...input) => Reflect.apply(facade.current, facade, input),
      proposal: (...input) => Reflect.apply(facade.proposal, facade, input),
      accept: (...input) =>
        scope.run(
          commandId,
          () =>
            observe("repository.accept", () =>
              Reflect.apply(facade.accept, facade, input)),
        ),
      recover: (...input) =>
        scope.run(
          commandId,
          () =>
            observe("repository.recover", () =>
              Reflect.apply(facade.recover, facade, input)),
        ),
    };
    return wrapped;
  };
  return {
    snapshot() {
      const now = performance.now();
      return {
        observedAt: new Date().toISOString(),
        sequence,
        eventCount,
        initialCompilerStats,
        compiler: compilerStats(),
        active: [...active.values()].map((entry) => ({
          ...entry,
          elapsedMs: now - Number(entry.started),
        })),
        omittedActive,
        events: [...events],
      };
    },
    restore() {
      for (const restore of restores.splice(0).reverse()) restore();
    },
  };
}
