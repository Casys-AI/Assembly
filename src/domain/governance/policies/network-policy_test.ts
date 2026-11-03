import { deepStrictEqual, equal, throws } from "node:assert/strict";
import {
  LEGACY_NETWORK_HOSTS,
  networkScopeFor,
  normalizeNetworkHost,
  validateNetworkScope,
} from "./network-policy.ts";

Deno.test("legacy network scope is exact and detached; explicit scopes never inherit baseline hosts", () => {
  deepStrictEqual(networkScopeFor().allowedHosts, [
    "example.org",
    "docs.deno.com",
    "doc.mbse-syson.org",
  ]);
  const legacy = networkScopeFor();
  legacy.allowedHosts.push("example.net");
  deepStrictEqual(networkScopeFor().allowedHosts, [...LEGACY_NETWORK_HOSTS]);
  const network = { allowedHosts: ["example.net"] };
  const scope = networkScopeFor({ network });
  deepStrictEqual(scope, network);
  scope.allowedHosts.push("other.example.net");
  deepStrictEqual(network.allowedHosts, ["example.net"]);
  deepStrictEqual(networkScopeFor({ network: { allowedHosts: [] } }), {
    allowedHosts: [],
  });
});

Deno.test("hostname normalization accepts only exact public-style DNS hosts", () => {
  equal(normalizeNetworkHost(" Docs.Example.NET. "), "docs.example.net");
  equal(
    normalizeNetworkHost("xn--bcher-kva.example.net"),
    "xn--bcher-kva.example.net",
  );
  for (
    const host of [
      "",
      "example",
      "localhost",
      "a.localhost",
      "a.local",
      "a.internal",
      "a.invalid",
      "a.test",
      "a.lan",
      "a.home",
      "a.corp",
      "a.onion",
      "co.uk",
      "com.tw",
      "127.0.0.1",
      "2130706433",
      "0x7f000001",
      "[::1]",
      "::1",
      "*.example.net",
      "example.net:443",
      "user@example.net",
      "https://example.net",
      "example.net/path",
      "example..net",
      "-bad.example.net",
      "bad-.example.net",
      "a_b.example.net",
      "a.example.net..",
      "a".repeat(64) + ".example.net",
      "a.".repeat(125) + "example.net",
      42,
      null,
    ]
  ) {
    throws(() => normalizeNetworkHost(host), Error, String(host));
  }
});

Deno.test("network scope requires exact unique canonical hosts and bounded exact rights", () => {
  deepStrictEqual(validateNetworkScope({ allowedHosts: ["example.net"] }), {
    allowedHosts: ["example.net"],
  });
  for (
    const value of [
      null,
      [],
      {},
      { allowedHosts: "example.net" },
      { allowedHosts: ["example.net"], allowSubdomains: true },
      { allowedHosts: ["EXAMPLE.NET"] },
      { allowedHosts: [" example.net"] },
      { allowedHosts: ["example.net."] },
      { allowedHosts: ["example.net", "example.net"] },
      {
        allowedHosts: Array.from(
          { length: 33 },
          (_, index) => `host${index}.example.net`,
        ),
      },
    ]
  ) throws(() => validateNetworkScope(value));
});
