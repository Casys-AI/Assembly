import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { ToolInvocationError } from "./tool-invocation.ts";
import type { ToolFailure } from "./tool-invocation.ts";

// Characterization (R14 C0): pins the current bounding and URL rules before
// this error leaves domain/work. No behaviour is defined here, only observed.

function input(overrides: Partial<ToolFailure> = {}): ToolFailure {
  return {
    code: "FETCH_FAILED",
    message: "boom",
    retryable: true,
    toolId: "tool-1",
    ...overrides,
  };
}

Deno.test("the error keeps its name, code, retryable flag and bounded message", () => {
  const error = new ToolInvocationError(input());
  ok(error instanceof Error);
  equal(error.name, "ToolInvocationError");
  equal(error.message, "boom");
  deepStrictEqual(error.failure, {
    code: "FETCH_FAILED",
    message: "boom",
    retryable: true,
    toolId: "tool-1",
  });
  equal(Object.hasOwn(error.failure, "url"), false);
  equal(Object.hasOwn(error.failure, "missingPermission"), false);
  equal(Object.hasOwn(error.failure, "allowedHosts"), false);
});

Deno.test("text fields replace control characters, trim, then truncate", () => {
  const [nul, unit, del, bidi, isolate] = [0x00, 0x1f, 0x7f, 0x202e, 0x2066]
    .map((code) => String.fromCharCode(code));
  const error = new ToolInvocationError(
    input({
      message: `  a${nul}b${unit}c${del}d${bidi}e${isolate}f  `,
      toolId: "\ttabbed\n",
    }),
  );
  equal(error.failure.message, "a b c d e f");
  equal(error.message, "a b c d e f");
  equal(error.failure.toolId, "tabbed");

  const long = new ToolInvocationError(
    input({ message: "m".repeat(500), toolId: "t".repeat(200) }),
  );
  equal(long.failure.message, "m".repeat(400));
  equal(long.failure.toolId, "t".repeat(128));

  const blank = new ToolInvocationError(
    input({ message: String.fromCharCode(1, 2) + " " }),
  );
  equal(blank.failure.message, "");
  equal(blank.message, "");
});

Deno.test("only bounded credential-free https URLs survive, without a fragment", () => {
  const kept = new ToolInvocationError(
    input({ url: "https://example.com/path?q=1#frag" }),
  );
  equal(kept.failure.url, "https://example.com/path?q=1");

  const defaultPort = new ToolInvocationError(
    input({ url: "https://example.com:443/a" }),
  );
  equal(defaultPort.failure.url, "https://example.com/a");

  const exact = "https://example.com/" + "a".repeat(4096 - 20);
  equal(new ToolInvocationError(input({ url: exact })).failure.url, exact);
});

Deno.test("unsafe or malformed URLs become an explicitly undefined url", () => {
  for (
    const url of [
      "http://example.com/",
      "https://user:pass@example.com/",
      "https://user@example.com/",
      "https://example.com:8443/",
      "not a url",
      "https://example.com/" + "a".repeat(4096),
    ]
  ) {
    const error = new ToolInvocationError(input({ url }));
    equal(Object.hasOwn(error.failure, "url"), true, url);
    equal(error.failure.url, undefined, url);
  }
});

Deno.test("the missing permission host is bounded to a DNS name length", () => {
  const error = new ToolInvocationError(
    input({
      missingPermission: { kind: "network-host", host: "h".repeat(300) },
    }),
  );
  deepStrictEqual(error.failure.missingPermission, {
    kind: "network-host",
    host: "h".repeat(253),
  });
});

Deno.test("allowed hosts keep at most 32 entries, each bounded", () => {
  const hosts = Array.from({ length: 40 }, (_, i) => `host-${i}.example`);
  hosts[0] = "h".repeat(300);
  const error = new ToolInvocationError(input({ allowedHosts: hosts }));
  equal(error.failure.allowedHosts?.length, 32);
  equal(error.failure.allowedHosts?.[0], "h".repeat(253));
  equal(error.failure.allowedHosts?.[31], "host-31.example");

  const empty = new ToolInvocationError(input({ allowedHosts: [] }));
  deepStrictEqual(empty.failure.allowedHosts, []);
});
