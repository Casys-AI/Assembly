// deno-lint-ignore-file require-await -- Async fetch-port doubles return deterministic in-memory responses.
import {
  DenoToolRunner,
  ToolInvocationError,
} from "../../src/adapters/out/sandbox/runner.ts";
import type {
  Candidate,
  ToolDraft,
} from "../../src/domain/work/records/candidates.ts";

function assert(value: unknown, message = "Assertion failed") {
  if (!value) throw new Error(message);
}
async function rejects(action: () => Promise<unknown>) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error("Expected rejection");
}
function macOSSandboxTest(name: string, fn: () => Promise<void>) {
  Deno.test({ name, ignore: Deno.build.os !== "darwin", fn });
}
const extraction = `export default ({html}: {url:string;html:string}) => {
  const title = (html.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i)?.[1] ?? "").trim();
  const body = html.match(/<body[^>]*>([\\s\\S]*?)<\\/body>/i)?.[1] ?? html;
  const text = body.replace(/<(script|style)\\b[^>]*>[\\s\\S]*?<\\/\\1>/gi," ")
    .replace(/<!--[\\s\\S]*?-->/g," ").replace(/<[^>]+>/g," ").replace(/\\s+/g," ").trim();
  return {title,text};
}`;
const outlineExtraction = String
  .raw`export default ({url,html}: {url:string;html:string}) => {
  const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
    const named: Record<string,string> = {amp:"&",lt:"<",gt:">",quot:'"',apos:"'"};
    const value = entity.slice(1,-1).toLowerCase();
    return value.startsWith("#") ? String.fromCodePoint(value[1] === "x" ? parseInt(value.slice(2),16) : Number(value.slice(1))) : named[value];
  });
  const clean = (value: string) => decode(value.replace(/<[^>]*>/g," ")).replace(/\s+/g," ").trim();
  const source = html.replace(/<!--[\s\S]*?-->/g," ").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi," ");
  const title = clean(source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const headings = [...source.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map(match => clean(match[2]));
  const links: string[] = [];
  for (const anchor of source.matchAll(/<a\b[^>]*>/gi)) {
    const match = anchor[0].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const href = decode(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
    if (!href || href.startsWith("#")) continue;
    try {
      const target = new URL(href,url);
      if (!["http:","https:"].includes(target.protocol)) continue;
      target.hash = "";
      if (!links.includes(target.href)) links.push(target.href);
    } catch { /* invalid URL */ }
  }
  return {title, text:[...headings,...links].join("\n")};
}`;
const outlineDraft: ToolDraft = {
  name: "outline_page",
  description: "Read headings and links",
  kind: "read_web_page_outline",
  code: outlineExtraction,
};
const draft: ToolDraft = {
  name: "read_page",
  description: "Read a page",
  kind: "read_web_page",
  code: extraction,
};
function candidate(code = extraction): Candidate {
  return {
    ...draft,
    code,
    id: "test",
    digest: "test",
    createdAt: "2026-10-21T00:00:00Z",
    stage: "active",
    baseCatalogRevision: 0,
  };
}
const page =
  "<html><head><title>Real extraction</title></head><body><h1>Useful body</h1><p>Several words survive.</p><script>NEVER_RETURN_THIS</script></body></html>";
const htmlResponse = (body = page) =>
  new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
const fakeFetch: typeof fetch = async () => htmlResponse();
const makeRunner = (
  options: ConstructorParameters<typeof DenoToolRunner>[0] = {},
) => new DenoToolRunner({ fetch: fakeFetch, ...options });

macOSSandboxTest(
  "readiness probes the configured Deno launch without fetching",
  async () => {
    let requests = 0;
    const runner = makeRunner({
      denoPath: Deno.execPath(),
      fetch: async () => {
        requests++;
        throw new Error("unexpected fetch");
      },
    });
    assert(
      JSON.stringify(await runner.inspectReadiness()) === '{"status":"ready"}',
    );
    assert(requests === 0);
  },
);

macOSSandboxTest(
  "readiness sanitizes a failing configured Deno launch",
  async () => {
    let requests = 0;
    const runner = makeRunner({
      denoPath: "/nonexistent-assembly-readiness-deno",
      fetch: async () => {
        requests++;
        throw new Error("unexpected fetch");
      },
    });
    assert(
      JSON.stringify(await runner.inspectReadiness()) ===
        '{"status":"unavailable","reason":"sandbox-launch-failed"}',
    );
    assert(requests === 0);
  },
);

macOSSandboxTest(
  "generated TypeScript module passes varied extraction fixtures and executes against fetched HTML",
  async () => {
    const runner = makeRunner();
    const report = await runner.test(draft);
    assert(report.passed, JSON.stringify(report));
    assert(report.checks.length === 3);
    const result = await runner.run(candidate(), {
      url: "https://example.org/page#fragment",
    });
    assert(result.url === "https://example.org/page");
    assert(result.title === "Real extraction");
    assert(result.text === "Useful body Several words survive.");
  },
);

macOSSandboxTest(
  "outline contract accepts headings and canonical links without full body prose",
  async () => {
    const runner = makeRunner();
    const report = await runner.test(outlineDraft);
    assert(report.passed, JSON.stringify(report));
    assert(report.checks.length === 3);
    assert(
      report.checks.every((check) => check.name.startsWith("outline fixture")),
    );
    const output = await runner.run({
      ...candidate(outlineExtraction),
      kind: "read_web_page_outline",
    }, {
      url: "https://example.org/page",
    });
    assert(output.title === "Real extraction");
    assert(output.text === "Useful body");
    assert(
      !(await runner.test({ ...outlineDraft, kind: "read_web_page" })).passed,
      "outline does not meet the unchanged full-body contract",
    );
  },
);

macOSSandboxTest(
  "outline checks reject full-text-only extractors and broken heading/link semantics",
  async () => {
    const runner = makeRunner();
    for (
      const code of [
        extraction,
        outlineExtraction.replace(
          "new URL(href,url)",
          'new URL(href,"https://example.org/")',
        ),
        outlineExtraction.replace('target.hash = "";', ""),
        outlineExtraction.replace(
          "if (!links.includes(target.href)) links.push(target.href);",
          "links.push(target.href);",
        ),
        outlineExtraction.replace("[1-6]", "[1-4]"),
        outlineExtraction.replace(
          'if (!href || href.startsWith("#")) continue;',
          "if (!href) continue;",
        ),
      ]
    ) {
      const report = await runner.test({ ...outlineDraft, code });
      assert(!report.passed, JSON.stringify(report));
    }
  },
);

Deno.test("unsupported contract is rejected before executing code or fetching", async () => {
  let fetched = false;
  const runner = makeRunner({
    fetch: async () => {
      fetched = true;
      return htmlResponse();
    },
  });
  const unknown = { ...draft, kind: "shell" } as unknown as ToolDraft;
  const report = await runner.test(unknown);
  assert(!report.passed && report.checks[0]?.name === "supported contract");
  await rejects(() =>
    runner.run({ ...candidate(), ...unknown }, { url: "https://example.org" })
  );
  assert(!fetched);
});

macOSSandboxTest(
  "fixture checks reject constant or empty extractors",
  async () => {
    const runner = makeRunner();
    assert(
      !(await runner.test({
        ...draft,
        code: 'export default () => ({title:"Fixture Alpha",text:"constant"})',
      })).passed,
    );
    assert(
      !(await runner.test({
        ...draft,
        code: 'export default () => ({title:"",text:""})',
      })).passed,
    );
  },
);

macOSSandboxTest(
  "module errors, infinite loops and oversized output fail within execution limits",
  async () => {
    const runner = makeRunner({ timeoutMs: 500 });
    for (
      const code of [
        'export default () => {throw new Error("private detail")}',
        "export default () => {while(true){}}",
        'export default () => ({title:"Large",text:"x".repeat(200000)})',
        'while(true) console.log("x".repeat(10000)); export default () => ({title:"x",text:"x"})',
      ]
    ) {
      const startedAt = performance.now();
      await rejects(() =>
        runner.run(candidate(code), { url: "https://example.org" })
      );
      assert(
        performance.now() - startedAt <= 3_000,
        "Generated module rejection exceeded 3000 ms",
      );
    }
  },
);

macOSSandboxTest(
  "generated code cannot read files, environment, network, write files, spawn processes or import secrets",
  async () => {
    const secret = await Deno.makeTempFile({
      suffix: ".mjs",
      prefix: "ase-secret-",
    });
    const secretSource = 'export default "HOST_SECRET_CANARY";';
    await Deno.writeTextFile(secret, secretSource);
    let server: Deno.HttpServer<Deno.NetAddr> | undefined;
    try {
      const canonicalSecret = await Deno.realPath(secret);
      const path = JSON.stringify(canonicalSecret);
      const fileUrl = new URL(`file://${canonicalSecret}`).href;
      const aliasPath = `/System/Volumes/Data${canonicalSecret}`;
      const aliasUrl = new URL(`file://${aliasPath}`).href;
      assert(aliasUrl !== fileUrl, "The secret alias must use a distinct URL");
      assert(
        await Deno.readTextFile(aliasPath) === secretSource,
        "The host must read the same secret through its Data-volume alias",
      );
      let networkRequests = 0;
      server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        () => {
          networkRequests++;
          return new Response("HOST_NETWORK_CANARY");
        },
      );
      const canaryUrl = `http://127.0.0.1:${server.addr.port}/canary`;
      const control = await fetch(canaryUrl);
      assert(await control.text() === "HOST_NETWORK_CANARY");
      assert(networkRequests === 1);
      const codes = [
        `export default async () => ({title:"x",text:await Deno.readTextFile(${path})})`,
        'export default () => ({title:"x",text:Deno.env.get("HOME")})',
        `export default async () => ({title:"x",text:await (await fetch(${
          JSON.stringify(canaryUrl)
        })).text()})`,
        `export default async () => {await Deno.writeTextFile(${path},"damaged");return {title:"x",text:"x"}}`,
        'export default async () => {await new Deno.Command("/bin/echo",{args:["unsafe"]}).output();return {title:"x",text:"x"}}',
        `import secret from ${
          JSON.stringify(fileUrl)
        };export default () => ({title:"x",text:secret})`,
        `export {default as secret} from ${
          JSON.stringify(fileUrl)
        };export default () => ({title:"x",text:"STATIC_REEXPORT_EXECUTED"})`,
        `export default async () => ({title:"x",text:(await import(${
          JSON.stringify(fileUrl)
        })).default})`,
        `import fs from "node:fs";export default () => ({title:"x",text:fs.readFileSync(${path},"utf8")})`,
        `import secret from ${
          JSON.stringify(aliasUrl)
        };export default () => ({title:"x",text:secret})`,
      ];
      for (const code of codes) {
        await rejects(() =>
          makeRunner().run(candidate(code), { url: "https://example.org" })
        );
        assert(networkRequests === 1, "Generated code reached the host canary");
      }
      assert((await Deno.readTextFile(secret)).includes("HOST_SECRET_CANARY"));
    } finally {
      try {
        await server?.shutdown();
      } finally {
        await Deno.remove(secret);
      }
    }
  },
);

macOSSandboxTest(
  "text is bounded and control characters removed, provenance is host supplied",
  async () => {
    const result = await makeRunner().run(
      candidate(
        'export default () => ({url:"https://evil.invalid",title:"Title\\u0000",text:"\\u0000"+"a".repeat(25000)})',
      ),
      { url: "https://example.org/page" },
    );
    assert(result.url === "https://example.org/page");
    assert(result.title === "Title");
    assert(result.text.length === 20000 && !result.text.includes("\0"));
  },
);

macOSSandboxTest(
  "exact HTTPS allowed host is fetched and its generated code executes",
  async () => {
    let requests = 0;
    const runner = makeRunner({
      fetch: async () => {
        requests++;
        return htmlResponse();
      },
    });
    await runner.run(candidate(), { url: "https://example.org" });
    assert(requests === 1);
  },
);

Deno.test("invalid HTTPS hosts and unsafe redirect destinations are rejected before fetching", async () => {
  let requests = 0;
  const runner = makeRunner({
    fetch: async () => {
      requests++;
      return htmlResponse();
    },
  });
  for (
    const url of [
      "http://example.org",
      "https://example.org:444",
      "https://user:pass@example.org",
      "https://127.0.0.1",
      "https://[::1]",
      "https://localhost",
      "https://example.org.evil.invalid",
      "file:///etc/passwd",
    ]
  ) {
    await rejects(() => runner.run(candidate(), { url }));
  }
  assert(requests === 0);
  const redirect = makeRunner({
    fetch: async () => {
      requests++;
      return new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
      });
    },
  });
  await rejects(() =>
    redirect.run(candidate(), { url: "https://example.org" })
  );
  assert(requests === 1);
});

Deno.test("fetch rejects oversized HTML, failed status, non-HTML and redirect loops", async () => {
  for (
    const response of [
      new Response("failure", { status: 500 }),
      new Response("application data"),
      htmlResponse("x".repeat(2 * 1024 * 1024 + 1)),
    ]
  ) {
    await rejects(() =>
      makeRunner({ fetch: async () => response }).run(candidate(), {
        url: "https://example.org",
      })
    );
  }
  let redirects = 0;
  const runner = makeRunner({
    fetch: async () => {
      redirects++;
      return new Response(null, {
        status: 302,
        headers: { location: "/again" },
      });
    },
  });
  await rejects(() => runner.run(candidate(), { url: "https://example.org" }));
  assert(redirects === 5);
});

Deno.test("fetch timeout aborts the request", async () => {
  const runner = makeRunner({
    fetchTimeoutMs: 20,
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      }),
  });
  await rejects(() => runner.run(candidate(), { url: "https://example.org" }));
});

async function failure(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    assert(
      error instanceof ToolInvocationError,
      "Expected a typed invocation failure",
    );
    return (error as ToolInvocationError).failure;
  }
  throw new Error("Expected rejection");
}

Deno.test("host-owned invocation scopes reject unapproved domains before fetching", async () => {
  const requests: string[] = [];
  const runner = makeRunner({
    fetch: async (input) => {
      requests.push(String(input));
      return htmlResponse();
    },
  });
  const input = { url: "https://arbitrary.example.net/page?token=URL_SECRET" };
  const denied = await failure(() => runner.run(candidate(), input));
  assert(denied.code === "NETWORK_SCOPE_DENIED");
  assert(denied.toolId === "test" && !denied.retryable);
  assert(denied.missingPermission?.kind === "network-host");
  assert(denied.missingPermission?.host === "arbitrary.example.net");
  assert(
    denied.allowedHosts?.join(",") ===
      "example.org,docs.deno.com,doc.mbse-syson.org",
  );
  assert(denied.url === input.url);
  assert(requests.length === 0);
  const replaced = await failure(() =>
    runner.run(candidate(), { url: "https://example.org" }, {
      allowedHosts: ["arbitrary.example.net"],
    })
  );
  assert(replaced.code === "NETWORK_SCOPE_DENIED" && requests.length === 0);
  const empty = await failure(() =>
    runner.run(candidate(), input, { allowedHosts: [] })
  );
  assert(empty.allowedHosts?.length === 0 && requests.length === 0);
});

macOSSandboxTest(
  "host-owned invocation scope admits an arbitrary domain only for that invocation",
  async () => {
    const requests: string[] = [];
    const runner = makeRunner({
      fetch: async (input) => {
        requests.push(String(input));
        return htmlResponse();
      },
    });
    const input = {
      url: "https://arbitrary.example.net/page?token=URL_SECRET",
    };
    const result = await runner.run(candidate(), input, {
      allowedHosts: ["arbitrary.example.net"],
    });
    assert(result.url === input.url && requests.length === 1);
    const again = await failure(() => runner.run(candidate(), input));
    assert(again.code === "NETWORK_SCOPE_DENIED" && requests.length === 1);
  },
);

Deno.test("redirect scope denial is typed and never fetches the unapproved destination", async () => {
  const requests: string[] = [];
  const runner = makeRunner({
    fetch: async (input) => {
      requests.push(String(input));
      return new Response(null, {
        status: 302,
        headers: {
          location:
            "https://destination.example.net/private?token=REDIRECT_SECRET",
        },
      });
    },
  });
  const denied = await failure(() =>
    runner.run(candidate(), { url: "https://arbitrary.example.net" }, {
      allowedHosts: ["arbitrary.example.net"],
    })
  );
  assert(denied.code === "NETWORK_SCOPE_DENIED");
  assert(denied.missingPermission?.host === "destination.example.net");
  assert(denied.allowedHosts?.join(",") === "arbitrary.example.net");
  assert(requests.length === 1);
  assert(!JSON.stringify(denied).includes("REDIRECT_SECRET"));
});

Deno.test("concurrent invocation scopes and caller mutations cannot expand another run", async () => {
  let release!: (response: Response) => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let requests = 0;
  const runner = makeRunner({
    fetch: () => {
      requests++;
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    },
  });
  const scope = { allowedHosts: ["arbitrary.example.net"] };
  const first = runner.run(candidate(), {
    url: "https://arbitrary.example.net",
  }, scope);
  await pending;
  scope.allowedHosts.push("destination.example.net");
  const separate = await failure(() =>
    runner.run(candidate(), { url: "https://arbitrary.example.net" }, {
      allowedHosts: ["destination.example.net"],
    })
  );
  assert(separate.code === "NETWORK_SCOPE_DENIED");
  release(
    new Response(null, {
      status: 302,
      headers: { location: "https://destination.example.net" },
    }),
  );
  const redirected = await failure(() => first);
  assert(redirected.code === "NETWORK_SCOPE_DENIED");
  assert(redirected.allowedHosts?.join(",") === "arbitrary.example.net");
  assert(requests === 1);
});

Deno.test("private names and addresses cannot be admitted through invocation scopes", async () => {
  let requests = 0;
  const runner = makeRunner({
    fetch: async () => {
      requests++;
      return htmlResponse();
    },
  });
  for (
    const host of [
      "127.0.0.1",
      "[::1]",
      "localhost",
      "service.localhost",
      "service.local",
      "service.internal",
      "service.lan",
      "service.home",
      "service.corp",
    ]
  ) {
    const invalid = await failure(() =>
      runner.run(candidate(), { url: `https://${host}` }, {
        allowedHosts: [host],
      })
    );
    assert(invalid.code === "URL_INVALID");
  }
  for (
    const url of [
      "http://arbitrary.example.net",
      "https://arbitrary.example.net:444",
      "https://user:SECRET@arbitrary.example.net",
      "arbitrary.example.net",
    ]
  ) {
    const invalid = await failure(() =>
      runner.run(candidate(), { url }, {
        allowedHosts: ["arbitrary.example.net"],
      })
    );
    assert(invalid.code === "URL_INVALID");
    assert(!JSON.stringify(invalid).includes("SECRET"));
  }
  assert(requests === 0);
});

Deno.test("fetch failures have bounded codes without raw errors or bodies", async () => {
  const thrown = await failure(() =>
    makeRunner({
      fetch: async () => {
        throw new Error("FETCH_SECRET");
      },
    }).run(candidate(), { url: "https://example.org/private?token=URL_SECRET" })
  );
  assert(thrown.code === "FETCH_FAILED" && thrown.retryable);
  const status = await failure(() =>
    makeRunner({
      fetch: async () => new Response("BODY_SECRET", { status: 500 }),
    }).run(candidate(), { url: "https://example.org" })
  );
  assert(status.code === "FETCH_FAILED");
  const large = await failure(() =>
    makeRunner({
      fetch: async () => htmlResponse("x".repeat(2 * 1024 * 1024 + 1)),
    }).run(candidate(), { url: "https://example.org" })
  );
  assert(large.code === "FETCH_FAILED" && !large.retryable);
  const timeout = await failure(() =>
    makeRunner({
      fetchTimeoutMs: 5,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("TIMEOUT_SECRET")), { once: true })
        ),
    }).run(candidate(), { url: "https://example.org" })
  );
  assert(timeout.code === "FETCH_TIMEOUT" && timeout.retryable);
  const diagnostics = JSON.stringify([thrown, status, large, timeout]);
  assert(!/FETCH_SECRET|BODY_SECRET|TIMEOUT_SECRET/.test(diagnostics));
  assert(diagnostics.length < 4000);
});

macOSSandboxTest(
  "execution failures have bounded codes without raw errors or code",
  async () => {
    const execution = await failure(() =>
      makeRunner().run(
        candidate('export default () => {throw new Error("CODE_SECRET")}'),
        { url: "https://example.org" },
      )
    );
    assert(execution.code === "TOOL_EXECUTION_FAILED");
    const diagnostics = JSON.stringify(execution);
    assert(!diagnostics.includes("CODE_SECRET"));
    assert(diagnostics.length < 4000);
  },
);

Deno.test({
  name: "generated tools fail closed on unsupported operating systems",
  ignore: Deno.build.os === "darwin",
  async fn() {
    let requests = 0;
    const runner = makeRunner({
      fetch: async () => {
        requests++;
        return htmlResponse();
      },
    });
    assert(
      JSON.stringify(await runner.inspectReadiness()) ===
        '{"status":"unavailable","reason":"unsupported-platform"}',
    );
    assert(requests === 0);
    const report = await runner.test(draft);
    assert(!report.passed && report.checks.length === 3);
    assert(report.checks.every((check) => !check.passed));
    const rejected = await failure(() =>
      runner.run(candidate(), { url: "https://example.org" })
    );
    assert(rejected.code === "TOOL_EXECUTION_FAILED" && !rejected.retryable);
    assert(rejected.toolId === "test" && requests === 1);
  },
});

Deno.test("invocation diagnostics copy bounded fields and retain the exact safe resume URL", () => {
  const allowedHosts = ["example.org"];
  const permission = {
    kind: "network-host" as const,
    host: "arbitrary.example.net",
  };
  const error = new ToolInvocationError({
    code: "NETWORK_SCOPE_DENIED",
    message: "Denied\u0000" + "x".repeat(500),
    retryable: false,
    toolId: "candidate\n" + "x".repeat(200),
    url: "https://example.org/page?q=detail#fragment",
    missingPermission: permission,
    allowedHosts,
  });
  allowedHosts.push("arbitrary.example.net");
  permission.host = "changed.example.net";
  assert(error.message.length === 400 && !error.message.includes("\u0000"));
  assert(
    error.failure.toolId.length === 128 && !error.failure.toolId.includes("\n"),
  );
  assert(error.failure.allowedHosts?.join(",") === "example.org");
  assert(error.failure.missingPermission?.host === "arbitrary.example.net");
  assert(error.failure.url === "https://example.org/page?q=detail");
  for (
    const url of [
      "http://example.org",
      "https://user:password@example.org",
      "https://example.org:444",
    ]
  ) {
    const unsafe = new ToolInvocationError({ ...error.failure, url });
    assert(unsafe.failure.url === undefined);
  }
});
