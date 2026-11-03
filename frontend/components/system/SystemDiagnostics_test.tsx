import { doesNotMatch, equal, match, ok } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { SystemDiagnostics } from "./SystemDiagnostics.tsx";
import type { SystemDiagnosticsRead } from "../../lib/system/diagnostics.ts";
const version = `commit:${"a".repeat(40)}`;
const active = {
  code: "D1",
  severity: "warning" as const,
  finding: "absent" as const,
  message: "Active finding",
  elementId: "node-1",
  source: { file: "lib/model.sysml", line: 17, column: 2 },
  masked: false,
};
const masked = {
  code: "D2",
  severity: "warning" as const,
  finding: "indeterminate" as const,
  message: "Masked finding",
  masked: true,
};
function read(): SystemDiagnosticsRead {
  return {
    doctor: {
      status: "ready",
      value: {
        version,
        sourceDigest: "b".repeat(64),
        diagnostics: [active, masked],
      },
    },
    shapes: { status: "unsupported", message: "SHACL is not available here." },
    attention: { status: "unavailable", message: "Attention unavailable." },
  };
}
Deno.test("Doctor findings remain visible when SHACL fails; masked findings are not active counts", () => {
  const html = renderToString(
    <SystemDiagnostics
      version={version}
      locationSearch="?caseBranch=caseA&agent=child&conversation=hidden"
      read={read()}
    />,
  );
  match(html, /1 warning/);
  doesNotMatch(html, /2 warnings/);
  match(html, /Masked findings/);
  match(html, /Masked findings/);
  match(html, /Active finding/);
  match(html, /Masked finding/);
  match(html, /SHACL is not available here/);
  doesNotMatch(html, /Conforms to the checked shapes/);
  const rawHref = html.match(/class="diagnostics-source" href="([^"]+)"/)?.[1];
  ok(rawHref);
  const href = new URL(rawHref.replaceAll("&amp;", "&"), "http://example.test");
  equal(href.pathname, "/model");
  equal(href.searchParams.get("page"), "files");
  equal(href.searchParams.get("version"), version);
  equal(href.searchParams.get("file"), "lib/model.sysml");
  equal(href.searchParams.get("line"), "17");
  equal(href.searchParams.get("caseBranch"), "caseA");
  equal(href.searchParams.get("agent"), "child");
  equal(href.searchParams.get("conversation"), "hidden");
  doesNotMatch(html, /<form|>Repair<|>Approve<|>Mask</);
});
Deno.test("unmapped SHACL results and nonconformance are explicit without a false clean report", () => {
  const data = read();
  data.shapes = {
    status: "ready",
    value: {
      version,
      report: {
        build: {
          repositoryId: "repo",
          sourceDigest: "b".repeat(64),
          recipeDigest: "c".repeat(64),
          buildKey: "d".repeat(64),
          artifactDigest: "e".repeat(64),
        },
        identity: {
          artifactDigest: "e".repeat(64),
          shapesDigest: "f".repeat(64),
          optionsDigest: "1".repeat(64),
          factsProjectorVersion: "1",
          engineId: "engine",
          engineVersion: "1",
        },
        conforms: false,
        diagnostics: [],
        unmappedResults: 2,
      },
    },
  };
  const html = renderToString(
    <SystemDiagnostics version={version} read={data} />,
  );
  match(html, /Does not conform to the checked shapes/);
  match(html, /2 validation results have no mapped finding/);
  match(html, /No mapped SHACL findings are available/);
  doesNotMatch(html, />Conforms to the checked shapes/);
});

Deno.test("findings and masked entries retain stable severity and source order regardless of input order", () => {
  const data = read();
  const first = {
    ...active,
    code: "A",
    message: "First by source",
    source: { file: "a.sysml", line: 5, column: 1 },
  };
  const second = {
    ...active,
    code: "B",
    message: "Second by source",
    source: { file: "b.sysml", line: 1, column: 1 },
  };
  const maskedA = {
    ...masked,
    code: "MA",
    message: "Masked A",
    source: { file: "a.sysml", line: 1, column: 1 },
  };
  const maskedB = {
    ...masked,
    code: "MB",
    message: "Masked B",
    source: { file: "b.sysml", line: 1, column: 1 },
  };
  if (data.doctor.status !== "ready") throw new Error("fixture");
  data.doctor.value.diagnostics = [second, maskedB, first, maskedA];
  const html = renderToString(
    <SystemDiagnostics version={version} read={data} />,
  );
  ok(html.indexOf("First by source") < html.indexOf("Second by source"));
  ok(html.indexOf("Masked A") < html.indexOf("Masked B"));
});

Deno.test("strictly identical Doctor and SHACL findings share one active row and preserve provenance", () => {
  const data = read();
  if (data.doctor.status !== "ready") throw new Error("fixture");
  data.doctor.value.diagnostics = [active];
  const { masked: _masked, ...same } = active;
  data.shapes = {
    status: "ready",
    value: {
      version,
      report: {
        build: {
          repositoryId: "repo",
          sourceDigest: "b".repeat(64),
          recipeDigest: "c".repeat(64),
          buildKey: "d".repeat(64),
          artifactDigest: "e".repeat(64),
        },
        identity: {
          artifactDigest: "e".repeat(64),
          shapesDigest: "f".repeat(64),
          optionsDigest: "1".repeat(64),
          factsProjectorVersion: "1",
          engineId: "engine",
          engineVersion: "1",
        },
        conforms: true,
        diagnostics: [same],
        unmappedResults: 0,
      },
    },
  };
  const html = renderToString(
    <SystemDiagnostics version={version} read={data} />,
  );
  equal((html.match(/class="diagnostics-finding"/g) ?? []).length, 1);
  equal((html.match(/Active finding/g) ?? []).length, 1);
  match(html, /1 warning/);
  match(html, /Doctor, SHACL/);
  equal((html.match(/<h2 id="diagnostics-findings-title"/g) ?? []).length, 1);
  doesNotMatch(
    html,
    /id="diagnostics-doctor-title"|id="diagnostics-shacl-title"/,
  );
  data.doctor.value.diagnostics = [{ ...active, masked: true }];
  const maskHtml = renderToString(
    <SystemDiagnostics version={version} read={data} />,
  );
  equal((maskHtml.match(/class="diagnostics-finding"/g) ?? []).length, 1);
  match(maskHtml, /Doctor, SHACL · Doctor masked/);
  doesNotMatch(maskHtml, /Masked findings/);
});

Deno.test("substantive differences never collapse findings from separate checks", () => {
  const data = read();
  if (data.doctor.status !== "ready") throw new Error("fixture");
  data.doctor.value.diagnostics = [active];
  const { masked: _masked, ...same } = active;
  const variants = [
    { ...same, code: "different" },
    { ...same, elementId: "other" },
    { ...same, qualifiedName: "other" },
    { ...same, source: { ...same.source, line: 18 } },
    { ...same, severity: "info" as const },
    { ...same, finding: "present" as const },
    { ...same, pattern: "another" },
    { ...same, message: "Different finding" },
    {
      ...same,
      remedy: { kind: "revision-template" as const, template: "other" },
    },
  ];
  for (const variant of variants) {
    data.shapes = {
      status: "ready",
      value: {
        version,
        report: {
          build: {
            repositoryId: "repo",
            sourceDigest: "b".repeat(64),
            recipeDigest: "c".repeat(64),
            buildKey: "d".repeat(64),
            artifactDigest: "e".repeat(64),
          },
          identity: {
            artifactDigest: "e".repeat(64),
            shapesDigest: "f".repeat(64),
            optionsDigest: "1".repeat(64),
            factsProjectorVersion: "1",
            engineId: "engine",
            engineVersion: "1",
          },
          conforms: true,
          diagnostics: [variant],
          unmappedResults: 0,
        },
      },
    };
    const html = renderToString(
      <SystemDiagnostics version={version} read={data} />,
    );
    equal((html.match(/class="diagnostics-finding"/g) ?? []).length, 2);
  }
});
