/** Shared transport for the atelier's existing event streams. */
export type SseClient = ReadableStreamDefaultController<Uint8Array>;

const encoder = new TextEncoder();
const encode = (event: string, value: unknown) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);

export function broadcastSse(
  clients: Set<SseClient>,
  event: string,
  value: unknown,
): void {
  const bytes = encode(event, value);
  for (const client of clients) {
    try {
      client.enqueue(bytes);
    } catch {
      clients.delete(client);
    }
  }
}

/**
 * The streams opened for someone (a Request owner's session): an event sent
 * to the audience reaches only the members `admit` accepts, judged at
 * delivery, so a member no longer admitted hears nothing more. A stream joins
 * when it opens and leaves when it closes.
 */
export class SseAudience<Member> {
  readonly #members = new Map<SseClient, Member>();

  join(client: SseClient, member: Member): void {
    this.#members.set(client, member);
  }

  leave(client: SseClient): void {
    this.#members.delete(client);
  }

  async send(
    admit: (member: Member) => boolean | Promise<boolean>,
    event: string,
    value: unknown,
  ): Promise<void> {
    const bytes = encode(event, value);
    for (const [client, member] of [...this.#members]) {
      let admitted = false;
      try {
        admitted = await admit(member);
      } catch {
        admitted = false;
      }
      if (!admitted || !this.#members.has(client)) continue;
      try {
        client.enqueue(bytes);
      } catch {
        this.#members.delete(client);
      }
    }
  }
}
