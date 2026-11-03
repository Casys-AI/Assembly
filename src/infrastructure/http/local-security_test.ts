import assert from "node:assert/strict";
import { requireLocalJsonCommand } from "./local-security.ts";

const backend = "http://127.0.0.1:4399";
const dev = { servedOrigin: backend, environment: "development" as const };
function command(origin: string, host = "127.0.0.1:4399") {
  return new Request(`${backend}/api/messages`, {
    method: "POST",
    headers: { host, origin, "content-type": "application/json" },
    body: "{}",
  });
}
Deno.test("development permits only HTTP loopback origins and local Host", () => {
  for (
    const origin of [
      "http://localhost:5173",
      "http://127.0.0.1:5174",
      "http://127.0.0.1:4399",
    ]
  ) {
    assert.doesNotThrow(() => requireLocalJsonCommand(command(origin), dev));
  }
  for (
    const origin of [
      "https://localhost:5173",
      "http://localhost.evil.example:5173",
      "http://evil.example",
      "null",
    ]
  ) {
    assert.throws(() => requireLocalJsonCommand(command(origin), dev));
  }
  assert.throws(() =>
    requireLocalJsonCommand(
      command("http://localhost:5173", "evil.example"),
      dev,
    )
  );
});
Deno.test("production keeps the exact served-origin requirement", () => {
  assert.doesNotThrow(() => requireLocalJsonCommand(command(backend), backend));
  assert.throws(() =>
    requireLocalJsonCommand(command("http://localhost:5173"), backend)
  );
  assert.throws(() =>
    requireLocalJsonCommand(command(backend, "evil.example"), backend)
  );
});
