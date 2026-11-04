import { equal } from "node:assert/strict";
import { versionLabel, versionStatus } from "./version-label.ts";

const base = `commit:${"a".repeat(40)}`;
const modified = `commit:${"b".repeat(40)}`;

Deno.test("Main uses the exact commit date in English and UTC, or omits an unavailable date", () => {
  equal(
    versionLabel({
      source: { kind: "main" },
      createdAt: "2026-11-03T23:30:00Z",
    }),
    "Main · 3 Nov",
  );
  for (const createdAt of [undefined, "invalid"]) {
    equal(versionLabel({ source: { kind: "main" }, createdAt }), "Main");
  }
});

Deno.test("a Request is modified only against its known immutable birth source", () => {
  const source = { kind: "request" as const, number: 1, baseVersion: base };
  equal(versionLabel({ source, version: modified }), "Request 1 · modified");
  equal(
    versionLabel({ source, version: base.replace("commit:", "") }),
    "Request 1",
  );
  equal(
    versionLabel({
      source: { ...source, baseVersion: undefined },
      version: modified,
    }),
    "Request 1",
  );
  equal(versionLabel({ source: { kind: "request" } }), "Request");
});

Deno.test("a Release keeps its authored name without deriving a version number", () => {
  equal(
    versionLabel({
      source: { kind: "release", name: "Accroches v1", id: "release-id" },
      version: modified,
    }),
    "Accroches v1",
  );
});

Deno.test("service status separates running, admitted but not running, past and unknown versions", () => {
  const info = {
    source: { kind: "main" as const },
    inService: base,
    headVersion: modified,
  };
  equal(versionStatus({ ...info, version: base }), "in-service");
  equal(versionStatus({ ...info, version: modified }), "not-in-service");
  equal(versionStatus({ ...info, version: "commit:older" }), "past");
  equal(
    versionStatus({ ...info, version: modified, inService: undefined }),
    "service-unknown",
  );
  equal(versionStatus(info), "version-unavailable");
});
