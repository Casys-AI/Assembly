import type { StorePort } from "../../src/application/work/runtime/ports.ts";
import type { SystemRuntimeState } from "../../src/application/work/runtime/state.ts";

/** Cloned CAS port for explicitly memory-tier scenarios. It has no durable
 * history, recovery, or database qualification semantics. */
export class MemoryStateStore implements StorePort {
  private state: SystemRuntimeState | null = null;
  private closed = false;

  load(): Promise<SystemRuntimeState | null> {
    this.assertOpen();
    return Promise.resolve(structuredClone(this.state));
  }

  save(
    state: SystemRuntimeState,
    expectedRevision: number | null,
  ): Promise<void> {
    this.assertOpen();
    const snapshot = structuredClone(state);
    if ((this.state?.revision ?? null) !== expectedRevision) {
      return Promise.reject(new Error("State revision conflict"));
    }
    if (
      !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
      (snapshot.revision !==
        (expectedRevision === null ? 0 : expectedRevision + 1))
    ) {
      return Promise.reject(new Error("Invalid state revision"));
    }
    if (this.state && snapshot.id !== this.state.id) {
      return Promise.reject(new Error("State identity changed"));
    }
    this.state = snapshot;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Memory state store closed");
  }
}
