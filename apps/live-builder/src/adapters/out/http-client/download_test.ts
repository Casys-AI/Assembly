import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import type { SkillPolicy } from "../../../domain/skills/context-skills.ts";
import { SkillError } from "../../../domain/skills/context-skills.ts";
import { HttpsSkillDownloader } from "./download.ts";

const url = "https://raw.githubusercontent.com/ase/patterns/main/SKILL.md";
function policy(maxSkillBytes = 1024): SkillPolicy {
  return {
    id: "context-skills",
    ownerId: "builder",
    allowedHosts: ["raw.githubusercontent.com"],
    maxSkillBytes,
    maxInstalledSkills: 8,
    maxLoadedSkills: 2,
    maxLoadedCharacters: 2048,
  };
}
function fetcher(
  callback: (input: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return ((input, init) =>
    Promise.resolve(callback(String(input), init))) as typeof globalThis.fetch;
}
const error = (code: SkillError["code"], pattern: RegExp) => (value: unknown) =>
  value instanceof SkillError && value.code === code &&
  pattern.test(value.message);

Deno.test("skill download returns exact UTF-8 bytes without executing or following content", async () => {
  const content =
    "\uFEFF---\nname: ase\n---\n# Vérifier\n```sh\nrm example\n```\nhttps://another.example/SKILL.md\n";
  const encoded = new TextEncoder().encode(content);
  let calls = 0;
  const download = new HttpsSkillDownloader({
    fetch: fetcher((input, init) => {
      calls++;
      equal(input, url);
      equal(init?.redirect, "manual");
      equal(init?.signal?.aborted, false);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            // The character é is split across transport chunks.
            const split = encoded.indexOf(0xc3) + 1;
            controller.enqueue(encoded.slice(0, split));
            controller.enqueue(encoded.slice(split));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/markdown; charset=utf-8" } },
      );
    }),
  });
  deepStrictEqual(await download.download(url, policy()), {
    content,
    requestedUrl: url,
    finalUrl: url,
    byteLength: encoded.byteLength,
  });
  equal(calls, 1);
});

Deno.test("skill download rejects unadmitted targets before transport", async () => {
  let calls = 0;
  const download = new HttpsSkillDownloader({
    fetch: fetcher(() => {
      calls++;
      return new Response("# Instructions");
    }),
  });
  for (
    const target of [
      "http://raw.githubusercontent.com/a/SKILL.md",
      "https://other.example/SKILL.md",
      "https://user:pass@raw.githubusercontent.com/a/SKILL.md",
      "https://raw.githubusercontent.com:444/a/SKILL.md",
      "https://raw.githubusercontent.com/a/archive.zip",
      "https://raw.githubusercontent.com/a/SKILL.md#fragment",
      "https://127.0.0.1/SKILL.md",
    ]
  ) {
    await rejects(
      download.download(target, policy()),
      error("forbidden", /URL/),
    );
  }
  equal(calls, 0);
});

Deno.test("skill download refuses redirects and changed response targets", async () => {
  let cancelled = 0;
  const redirected = new HttpsSkillDownloader({
    fetch: fetcher(() =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        {
          status: 302,
          headers: { location: "https://other.example/SKILL.md" },
        },
      )
    ),
  });
  await rejects(
    redirected.download(url, policy()),
    error("forbidden", /redirects/),
  );
  equal(cancelled, 1);
  const response = new Response("# Instructions");
  Object.defineProperty(response, "url", {
    value: "https://other.example/SKILL.md",
  });
  await rejects(
    new HttpsSkillDownloader({ fetch: fetcher(() => response) }).download(
      url,
      policy(),
    ),
    error("forbidden", /requested URL/),
  );
});

Deno.test("skill download bounds bytes actually streamed despite smaller announced length", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(200).fill(65));
      controller.enqueue(new Uint8Array(100).fill(66));
    },
    cancel() {
      cancelled = true;
    },
  });
  const download = new HttpsSkillDownloader({
    fetch: fetcher(() =>
      new Response(stream, { headers: { "content-length": "1" } })
    ),
  });
  await rejects(
    download.download(url, policy(256)),
    error("limit", /byte limit/),
  );
  equal(cancelled, true);
});

Deno.test("skill download rejects invalid payloads and error responses", async () => {
  const cases: Array<[Response, SkillError["code"], RegExp]> = [
    [new Response("Not found", { status: 404 }), "invalid", /server/],
    [new Response(null), "invalid", /no body/],
    [
      new Response("<html>not a skill</html>", {
        headers: { "content-type": "text/html" },
      }),
      "invalid",
      /raw instruction/,
    ],
    [
      new Response("{}", { headers: { "content-type": "application/json" } }),
      "invalid",
      /raw instruction/,
    ],
    [
      new Response("PK", { headers: { "content-type": "application/zip" } }),
      "invalid",
      /raw instruction/,
    ],
    [new Response(new Uint8Array([0xc3, 0x28])), "invalid", /UTF-8/],
    [new Response(" "), "invalid", /nonempty/],
    [new Response("# null\u0000text"), "invalid", /nonempty/],
    [
      new Response("# Header", { headers: { "content-length": "2048" } }),
      "limit",
      /byte limit/,
    ],
    [
      new Response("# Header", { headers: { "content-length": "x" } }),
      "invalid",
      /length/,
    ],
  ];
  for (const [response, code, pattern] of cases) {
    await rejects(
      new HttpsSkillDownloader({ fetch: fetcher(() => response) }).download(
        url,
        policy(),
      ),
      error(code, pattern),
    );
  }
});

Deno.test("skill download timeout covers a stalled body and cancels it", async () => {
  let cancelled = false;
  let signal: AbortSignal | undefined;
  const download = new HttpsSkillDownloader({
    timeoutMs: 10,
    fetch: fetcher((_input, init) => {
      signal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      );
    }),
  });
  await rejects(
    download.download(url, policy()),
    error("invalid", /timed out/),
  );
  equal(cancelled, true);
  equal(signal?.aborted, true);
});

Deno.test("skill download deadline also bounds a transport ignoring AbortSignal", async () => {
  const download = new HttpsSkillDownloader({
    timeoutMs: 10,
    fetch: (() => new Promise<Response>(() => {})) as typeof globalThis.fetch,
  });
  await rejects(
    download.download(url, policy()),
    error("invalid", /timed out/),
  );
});

Deno.test("skill downloader validates timeout and normalizes transport errors", async () => {
  for (const timeoutMs of [0, -1, 0.5, 120001, NaN]) {
    throws(() => new HttpsSkillDownloader({ timeoutMs }), SkillError);
  }
  const download = new HttpsSkillDownloader({
    fetch: (() =>
      Promise.reject(new TypeError("network"))) as typeof globalThis.fetch,
  });
  await rejects(
    download.download(url, policy()),
    error("invalid", /download failed/),
  );
});
