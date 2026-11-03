import assert from "node:assert/strict";
import {
  createDevelopmentSessionIssuer,
  createSpaceSessionHandler,
  SPACE_SESSION_COOKIE,
} from "./space-session.ts";

const servedOrigin = "http://127.0.0.1:4399";
const policy = { servedOrigin, environment: "development" as const };
const expiresAt = "2099-01-01T00:00:00.000Z";
const sessionSecret = "a".repeat(64);
Deno.test("development issuer resolves modeled owner and exchanges its real capability", async () => {
  const calls: string[] = [];
  const issue = createDevelopmentSessionIssuer({
    issueCapability(ownerId) {
      calls.push(`issue:${ownerId}`);
      return Promise.resolve({
        secret: "b".repeat(64),
        credentialId: "credential",
        expiresAt,
      });
    },
    exchange(secret) {
      calls.push(`exchange:${secret}`);
      return Promise.resolve({ secret: sessionSecret, expiresAt });
    },
  }, () => Promise.resolve("modeled-owner"));
  assert.deepEqual(await issue(), { secret: sessionSecret, expiresAt });
  assert.deepEqual(calls, [
    "issue:modeled-owner",
    `exchange:${"b".repeat(64)}`,
  ]);
});
function post(origin: string, body: string, host = "127.0.0.1:4399") {
  return new Request(`${servedOrigin}/api/space-session/local`, {
    method: "POST",
    headers: { host, origin, "content-type": "application/json" },
    body,
  });
}
Deno.test("development local bootstrap sets only a host-only HttpOnly Strict session cookie", async () => {
  let calls = 0;
  const handler = createSpaceSessionHandler(
    { exchange: () => Promise.reject(new Error("unexpected exchange")) },
    policy,
    () => {
      calls++;
      return Promise.resolve({ secret: sessionSecret, expiresAt });
    },
  );
  const response = await handler(post("http://localhost:5173", "{}"));
  assert.equal(response?.status, 200);
  assert.deepEqual(await response!.json(), { expiresAt });
  const cookie = response!.headers.get("set-cookie")!;
  assert.match(
    cookie,
    new RegExp(`^${SPACE_SESSION_COOKIE}=${sessionSecret};`),
  );
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.equal(calls, 1);
  assert.equal((await handler(post("http://evil.example", "{}")))?.status, 403);
  assert.equal(
    (await handler(post("http://localhost:5173", "{}", "evil.example")))
      ?.status,
    403,
  );
  assert.equal(
    (await handler(post("http://localhost:5173", '{"ownerId":"other"}')))
      ?.status,
    400,
  );
  assert.equal(calls, 1);
});
Deno.test("production exposes no automatic local bootstrap", async () => {
  let calls = 0;
  const handler = createSpaceSessionHandler(
    { exchange: () => Promise.reject(new Error("unexpected exchange")) },
    { servedOrigin, environment: "production" },
    () => {
      calls++;
      return Promise.resolve({ secret: sessionSecret, expiresAt });
    },
  );
  assert.equal(await handler(post(servedOrigin, "{}")), null);
  assert.equal(calls, 0);
});
Deno.test("development local bootstraps do not consume the secret exchange quota", async () => {
  const handler = createSpaceSessionHandler(
    { exchange: () => Promise.resolve({ secret: sessionSecret, expiresAt }) },
    policy,
    () => Promise.resolve({ secret: sessionSecret, expiresAt }),
  );
  for (let i = 0; i < 13; i++) {
    assert.equal((await handler(post(servedOrigin, "{}")))?.status, 200);
  }
  const exchange = new Request(`${servedOrigin}/api/space-session/exchange`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:4399",
      origin: servedOrigin,
      "content-type": "application/json",
    },
    body: JSON.stringify({ capabilitySecret: "b".repeat(64) }),
  });
  assert.equal((await handler(exchange))?.status, 200);
});
Deno.test("production secret exchange keeps the twelve attempts per minute gate", async () => {
  let calls = 0;
  const handler = createSpaceSessionHandler(
    {
      exchange: () => {
        calls++;
        return Promise.resolve({ secret: sessionSecret, expiresAt });
      },
    },
    servedOrigin,
  );
  for (let i = 0; i < 13; i++) {
    const request = new Request(`${servedOrigin}/api/space-session/exchange`, {
      method: "POST",
      headers: {
        host: "127.0.0.1:4399",
        origin: servedOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ capabilitySecret: "b".repeat(64) }),
    });
    const response = await handler(request);
    assert.equal(response?.status, i < 12 ? 200 : 429);
    if (i === 12) assert.equal(response?.headers.get("retry-after"), "60");
  }
  assert.equal(calls, 12);
});
