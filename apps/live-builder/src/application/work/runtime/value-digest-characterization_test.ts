import { equal } from "node:assert/strict";
import { valueDigest } from "./values.ts";

Deno.test("valueDigest preserves insertion-order JSON UTF-8 bytes", async () => {
  const vectors = [
    {
      value: { b: 2, a: "é" },
      json: '{"b":2,"a":"é"}',
      digest:
        "fed41dc707052b02c4f8cbd205f90a4b16d099266a34e2a7f278b75e76b5e31d",
    },
    {
      value: { a: "é", b: 2 },
      json: '{"a":"é","b":2}',
      digest:
        "06c264c46ad5ada9493abd3aa2383fb205ae99d7d0bad40b03a43bfec8a1b8de",
    },
  ];
  for (const { value, json, digest } of vectors) {
    equal(JSON.stringify(value), json);
    equal(await valueDigest(value), digest);
  }
});

Deno.test("valueDigest preserves JSON and TextEncoder boundary encodings", async () => {
  // TextEncoder encodes a top-level undefined JSON result as an empty byte array.
  equal(
    await valueDigest(undefined),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  equal(
    await valueDigest(NaN),
    "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
  );
  equal(
    await valueDigest([undefined, NaN, { b: 2, absent: undefined, a: 1 }]),
    "0d88ce5d9c3294f8c53023743122669434589ba29f65cd4ab32e6d14d97f6777",
  );
});
