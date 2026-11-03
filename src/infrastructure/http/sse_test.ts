import { deepStrictEqual } from "node:assert/strict";
import { SseAudience, type SseClient } from "./sse.ts";

function client(log: string[], name: string, closed = false): SseClient {
  return {
    enqueue(bytes: Uint8Array) {
      if (closed) throw new TypeError("closed");
      log.push(`${name}:${new TextDecoder().decode(bytes)}`);
    },
  } as unknown as SseClient;
}

Deno.test("an audience event reaches only the members admitted at delivery", async () => {
  const log: string[] = [];
  const audience = new SseAudience<{ ownerId: string; valid: boolean }>();
  const owner = client(log, "owner");
  const foreign = client(log, "foreign");
  const expired = client(log, "expired");
  const gone = client(log, "gone", true);
  audience.join(owner, { ownerId: "A", valid: true });
  audience.join(foreign, { ownerId: "B", valid: true });
  audience.join(expired, { ownerId: "A", valid: false });
  audience.join(gone, { ownerId: "A", valid: true });
  const admit = (member: { ownerId: string; valid: boolean }) => {
    if (!member.valid) throw new Error("session expired");
    return member.ownerId === "A";
  };
  await audience.send(admit, "case-model-version", { caseId: "c" });
  deepStrictEqual(log, [
    'owner:event: case-model-version\ndata: {"caseId":"c"}\n\n',
  ]);
  audience.leave(owner);
  await audience.send(admit, "case-model-version", { caseId: "d" });
  deepStrictEqual(log.length, 1, "a stream that left hears nothing");
});
