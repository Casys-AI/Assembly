import type { ModelRevisionNotificationPorts } from "./ports/out/revision-notifications.port.ts";

/** Post-publication work is advisory. Announce the admitted head before
 * scheduling expensive diagnostics; a burst keeps only its latest pending
 * revision. Historical diagnostics remain available through the read API. */
export class ModelRevisionNotifications {
  #pending: string | undefined;
  #running: Promise<void> | undefined;
  #closed = false;

  constructor(
    private readonly ports: ModelRevisionNotificationPorts,
  ) {}

  async notify(version: string): Promise<void> {
    if (this.#closed) return;
    this.ports.invalidateHead();
    try {
      await this.ports.announce();
    } catch (error) {
      this.ports.onError("announce", error);
    }
    if (this.#closed) return;
    this.#pending = version;
    this.#start();
  }

  #start(): void {
    if (this.#running || this.#closed) return;
    // Defer refresh so even synchronous work before its first await cannot
    // extend the successful publication response.
    const run = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(
      async () => {
        while (this.#pending && !this.#closed) {
          const version = this.#pending;
          this.#pending = undefined;
          try {
            await this.ports.refresh(version);
          } catch (error) {
            this.ports.onError("refresh", error);
          }
        }
      },
    );
    this.#running = run;
    void run.finally(() => {
      this.#running = undefined;
      if (this.#pending && !this.#closed) this.#start();
    });
  }

  /** Drain the active refresh; discard work that has not started. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#pending = undefined;
    await this.#running;
  }
}
