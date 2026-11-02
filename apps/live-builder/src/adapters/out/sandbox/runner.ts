import type { RunnableTool } from "../../../application/work/tools/active-tools.ts";
import { TOOL_KINDS } from "../../../domain/shared-kernel/tool-kind.ts";
import type { ToolRunnerPort } from "../../../application/work/runtime/ports.ts";
import type {
  PageResult,
  TestReport,
  ToolDraft,
} from "../../../domain/work/candidates.ts";
import type {
  NetworkScope,
} from "../../../domain/governance/records/system-configuration.ts";
import type { ToolFailure } from "../../../domain/work/dialogue.ts";

import {
  networkScopeFor,
  normalizeNetworkHost,
  validateNetworkScope,
} from "../../../domain/governance/policies/network-policy.ts";

import { ToolInvocationError } from "../../../domain/work/errors/tool-invocation.ts";
export { ToolInvocationError } from "../../../domain/work/errors/tool-invocation.ts";

interface InvocationPolicy {
  toolId: string;
  allowedHosts: string[];
  requestedUrl?: string;
}

const MAX_HTML = 2 * 1024 * 1024;
const MAX_CODE = 64 * 1024;
const MAX_OUTPUT = 128 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ToolRunnerOptions {
  denoPath?: string;
  /** Trusted operator configuration; exact public DNS names, no wildcard matching. */
  allowHosts?: string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  fetchTimeoutMs?: number;
}

/**
 * Local macOS demo isolation: a fresh sandbox-exec process plus Deno permission
 * denials. This is not a microVM or a portable production untrusted-code service.
 * OS read restrictions are necessary: Deno static imports bypass --deny-read.
 * The V8 heap cap is not an operating-system RSS limit. Hostname allowlisting
 * trusts the configured sites' DNS; fetch does not pin DNS against rebinding.
 */
export class DenoToolRunner implements ToolRunnerPort {
  private readonly options: ToolRunnerOptions;
  private readonly defaultScope: NetworkScope;

  constructor(options: ToolRunnerOptions = {}) {
    this.options = options;
    this.defaultScope = validateNetworkScope(
      options.allowHosts === undefined
        ? networkScopeFor()
        : { allowedHosts: options.allowHosts },
    );
  }

  async inspectReadiness(): Promise<
    | { status: "ready" }
    | {
      status: "unavailable";
      reason: "unsupported-platform" | "sandbox-launch-failed";
    }
  > {
    if (Deno.build.os !== "darwin") {
      return { status: "unavailable", reason: "unsupported-platform" };
    }
    try {
      const result = await this.execute(
        'export default () => ({ title: "Assembly readiness", text: "Sandbox launch ready" });',
        { url: "", html: "" },
      );
      if (
        result.title === "Assembly readiness" &&
        result.text === "Sandbox launch ready"
      ) return { status: "ready" };
    } catch { /* Return only the sanitized readiness failure. */ }
    return { status: "unavailable", reason: "sandbox-launch-failed" };
  }

  async test(draft: ToolDraft): Promise<TestReport> {
    if (!TOOL_KINDS.includes(draft.kind)) {
      return {
        passed: false,
        checks: [{
          name: "supported contract",
          passed: false,
          detail: "Unsupported tool contract",
        }],
      };
    }
    if (draft.kind === "read_web_page_outline") return this.testOutline(draft);
    const fixtures = [
      {
        title: "Fixture Alpha",
        body: "Orchard paths preserve useful details.",
        html:
          "<!doctype html><html><head><title>Fixture Alpha</title><script>SECRET_SCRIPT_SENTINEL</script></head><body><main><h1>Orchard paths</h1><p>preserve useful details.</p></main></body></html>",
      },
      {
        title: "Fixture Beta",
        body: "River stones and bridges stay readable.",
        html:
          '<HTML><HEAD><TITLE>Fixture Beta</TITLE></HEAD><BODY><style>SECRET_STYLE_SENTINEL</style><article><p>River <strong>stones</strong> and bridges stay readable.</p><script type="text/javascript">SECRET_SCRIPT_SENTINEL</script></article></BODY></HTML>',
      },
      {
        title: "Fixture Gamma",
        body: "Harbor visitors count seven boats.",
        html:
          "<html><head><title>Fixture Gamma</title></head><body><nav>Index</nav><article><h2>Harbor visitors</h2><p>count <em>seven</em> boats.</p></article><!-- SECRET_COMMENT_SENTINEL --><script>SECRET_SCRIPT_SENTINEL</script></body></html>",
      },
    ];
    const checks: TestReport["checks"] = [];
    for (const [index, fixture] of fixtures.entries()) {
      try {
        const result = await this.execute(draft.code, {
          url: "https://example.org/fixture",
          html: fixture.html,
        });
        const passed = result.title === fixture.title &&
          fixture.body.split(/\s+/).every((word) =>
            result.text.includes(word)
          ) &&
          !/SECRET_(?:SCRIPT|STYLE|COMMENT)_SENTINEL/.test(result.text);
        checks.push({
          name: `extraction fixture ${index + 1}`,
          passed,
          detail: passed
            ? "Title and meaningful body preserved; script/style/comment content excluded"
            : "Extraction did not match the fixture's title and body expectations",
        });
      } catch {
        checks.push({
          name: `extraction fixture ${index + 1}`,
          passed: false,
          detail: "Generated module failed within the local execution limits",
        });
      }
    }
    return { passed: checks.every((check) => check.passed), checks };
  }

  private async testOutline(draft: ToolDraft): Promise<TestReport> {
    const checks: TestReport["checks"] = [];
    for (const [index, fixture] of OUTLINE_FIXTURES.entries()) {
      try {
        const result = await this.execute(draft.code, fixture);
        const positions = fixture.headings.map((heading) =>
          result.text.indexOf(heading)
        );
        const urls = result.text.match(/https?:\/\/[^\s<>"'`\)\]]+/g) ?? [];
        const passed = result.title === fixture.title &&
          positions.every((position, i) =>
            position >= 0 && (i === 0 || position > positions[i - 1]!)
          ) &&
          JSON.stringify(urls) === JSON.stringify(fixture.links) &&
          !/SECRET_(?:SCRIPT|STYLE|COMMENT)_SENTINEL|javascript:|data:text|mailto:|#(?:local-only|intro|again)/i
            .test(result.text);
        checks.push({
          name: `outline fixture ${index + 1}`,
          passed,
          detail: passed
            ? "Title, ordered h1-h6 headings and canonical deduplicated http(s) links extracted; unsafe and non-content data excluded"
            : "Outline did not match title, ordered headings, canonical distinct links or excluded-content expectations",
        });
      } catch {
        checks.push({
          name: `outline fixture ${index + 1}`,
          passed: false,
          detail: "Generated module failed within the local execution limits",
        });
      }
    }
    return { passed: checks.every((check) => check.passed), checks };
  }

  async run(
    candidate: RunnableTool,
    input: { url: string },
    policy?: NetworkScope,
  ): Promise<PageResult> {
    const context: InvocationPolicy = {
      toolId: cleanText(candidate.id, 128),
      allowedHosts: [],
    };
    try {
      // Copy once before the first await: concurrent runs never share mutable scope.
      context.allowedHosts = validateNetworkScope(policy ?? this.defaultScope)
        .allowedHosts;
    } catch {
      throw invocationFailure(
        context,
        "URL_INVALID",
        "Invalid invocation network scope",
      );
    }
    if (!TOOL_KINDS.includes(candidate.kind)) {
      throw invocationFailure(
        context,
        "TOOL_EXECUTION_FAILED",
        "Unsupported tool contract",
      );
    }
    const { url, html } = await this.fetchPage(input.url, context);
    try {
      return { url, ...await this.execute(candidate.code, { url, html }) };
    } catch {
      throw invocationFailure(
        context,
        "TOOL_EXECUTION_FAILED",
        "Generated tool failed or exceeded local execution limits",
        new URL(url),
      );
    }
  }

  private checkedUrl(
    raw: string,
    context: InvocationPolicy,
    initial = false,
  ): URL {
    let url: URL;
    try {
      if (raw.length > 4096) throw new Error("Page URL exceeds the limit");
      url = new URL(raw);
      if (
        url.protocol !== "https:" || url.username || url.password ||
        (url.port && url.port !== "443") ||
        normalizeNetworkHost(url.hostname) !== url.hostname
      ) throw new Error("Invalid page URL");
    } catch {
      throw invocationFailure(
        context,
        "URL_INVALID",
        "Page URL must use HTTPS on an exact public DNS host, port 443, without credentials",
      );
    }
    url.hash = "";
    if (initial) context.requestedUrl = url.href;
    if (!context.allowedHosts.includes(url.hostname)) {
      throw new ToolInvocationError({
        ...invocationFailure(
          context,
          "NETWORK_SCOPE_DENIED",
          `Network permission is required for ${url.hostname}`,
          url,
        ).failure,
        missingPermission: { kind: "network-host", host: url.hostname },
      });
    }
    return url;
  }

  private async fetchPage(
    raw: string,
    context: InvocationPolicy,
  ): Promise<{ url: string; html: string }> {
    let url = this.checkedUrl(raw, context, true);
    const controller = new AbortController();
    let timedOut = false;
    let bodyExceeded = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.fetchTimeoutMs ?? 10_000);
    try {
      for (let hop = 0; hop <= 4; hop++) {
        const response = await (this.options.fetch ?? fetch)(url, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { Accept: "text/html,application/xhtml+xml" },
          credentials: "omit",
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get("location");
          if (!location || hop === 4) {
            throw invocationFailure(
              context,
              "FETCH_FAILED",
              "Page redirect limit exceeded or destination missing",
              url,
            );
          }
          let destination: string;
          try {
            destination = new URL(location, url).href;
          } catch {
            throw invocationFailure(
              context,
              "URL_INVALID",
              "Invalid page redirect destination",
            );
          }
          url = this.checkedUrl(destination, context);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw invocationFailure(
            context,
            "FETCH_FAILED",
            "Page request returned an unsuccessful status",
            url,
            true,
          );
        }
        const type = response.headers.get("content-type")?.split(";")[0]
          ?.trim();
        if (type !== "text/html" && type !== "application/xhtml+xml") {
          await response.body?.cancel();
          throw invocationFailure(
            context,
            "FETCH_FAILED",
            "Page response must be HTML",
            url,
          );
        }
        const bytes = await readBounded(response.body, MAX_HTML, () => {
          bodyExceeded = true;
          controller.abort();
        });
        return { url: url.href, html: decoder.decode(bytes) };
      }
      throw invocationFailure(
        context,
        "FETCH_FAILED",
        "Page redirect limit exceeded",
        url,
      );
    } catch (error) {
      if (error instanceof ToolInvocationError) throw error;
      if (bodyExceeded) {
        throw invocationFailure(
          context,
          "FETCH_FAILED",
          "Page response exceeded the body limit",
          url,
        );
      }
      if (timedOut) {
        throw invocationFailure(
          context,
          "FETCH_TIMEOUT",
          "Page request timed out",
          url,
          true,
        );
      }
      throw invocationFailure(
        context,
        "FETCH_FAILED",
        "Page request failed",
        url,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async execute(
    code: string,
    input: { url: string; html: string },
  ): Promise<Omit<PageResult, "url">> {
    if (encoder.encode(code).length > MAX_CODE) {
      throw new Error("Generated module exceeds the code limit");
    }
    if (Deno.build.os !== "darwin") {
      throw new Error("Local generated tools require macOS sandbox-exec");
    }
    const dir = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "assembly-tool-" }),
    );
    let child: Deno.ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let terminated = false;
    const stop = () => {
      terminated = true;
      try {
        child?.kill("SIGKILL");
      } catch { /* already reaped */ }
    };
    try {
      const executable = await Deno.realPath(
        this.options.denoPath ?? Deno.execPath(),
      );
      const wrapper = `${dir}/runner.ts`;
      // The entry module contains only trusted code. The candidate arrives over
      // stdin as data and is imported inside the OS sandbox, never in this host.
      await Deno.writeTextFile(wrapper, CHILD_WRAPPER);
      const profile = `(version 1)(deny default)
        (allow process-exec (literal ${JSON.stringify(executable)}))
        (allow file-read-metadata)
        (allow file-read* (literal "/") (literal ${JSON.stringify(executable)})
          (subpath ${JSON.stringify(dir)}) (subpath "/System/Library")
          (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/System/Cryptexes/OS")
          (subpath "/usr/lib") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))
        (allow file-write* (subpath ${JSON.stringify(dir)}))
        (allow sysctl-read)(allow mach-lookup)`;
      child = new Deno.Command("/usr/bin/sandbox-exec", {
        args: [
          "-p",
          profile,
          executable,
          "run",
          "--no-prompt",
          "--no-config",
          "--no-lock",
          "--no-remote",
          "--no-npm",
          "--no-code-cache",
          "--deny-read",
          "--deny-write",
          "--deny-net",
          "--deny-env",
          "--deny-run",
          "--deny-ffi",
          "--deny-sys",
          "--deny-import",
          "--v8-flags=--max-old-space-size=64",
          wrapper,
        ],
        cwd: dir,
        clearEnv: true,
        env: { HOME: dir, TMPDIR: dir, DENO_DIR: `${dir}/cache` },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      timer = setTimeout(stop, this.options.timeoutMs ?? 2_000);
      const writer = child.stdin.getWriter();
      const writing = writer.write(
        encoder.encode(JSON.stringify({ code, input })),
      )
        .then(() => writer.close()).catch(
          () => {/* child may reject before stdin closes */},
        );
      const results = await Promise.allSettled([
        readBounded(child.stdout, MAX_OUTPUT, stop),
        readBounded(child.stderr, 8 * 1024, stop),
        child.status,
        writing,
      ]);
      const [stdout, stderr, status] = results;
      if (
        terminated || stdout?.status !== "fulfilled" ||
        stderr?.status !== "fulfilled" ||
        status?.status !== "fulfilled" || !status.value.success
      ) {
        throw new Error(
          "Generated module failed or exceeded local execution limits",
        );
      }
      let output: unknown;
      try {
        output = JSON.parse(decoder.decode(stdout.value));
      } catch {
        throw new Error("Generated module returned invalid output");
      }
      if (
        !output || typeof output !== "object" || !("title" in output) ||
        !("text" in output) ||
        typeof output.title !== "string" || typeof output.text !== "string" ||
        !output.title.trim() || !output.text.trim()
      ) throw new Error("Generated module must return nonempty title and text");
      const result = {
        title: cleanText(output.title, 300),
        text: cleanText(output.text, 20_000),
      };
      if (!result.title || !result.text) {
        throw new Error(
          "Generated module returned empty text after sanitization",
        );
      }
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // No descendants can survive: OS process-fork is denied and Deno run is denied.
      try {
        child?.kill("SIGKILL");
      } catch { /* already reaped */ }
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function invocationFailure(
  context: InvocationPolicy,
  code: ToolFailure["code"],
  message: string,
  url?: URL,
  retryable = false,
): ToolInvocationError {
  return new ToolInvocationError({
    code,
    message,
    retryable,
    toolId: context.toolId,
    // Resume targets come from the validated request, never from redirect headers.
    ...(context.requestedUrl
      ? { url: context.requestedUrl }
      : url
      ? { url: url.origin }
      : {}),
    allowedHosts: [...context.allowedHosts],
  });
}

/** Host-owned examples exercise semantics, not a candidate's parser implementation. */
const OUTLINE_FIXTURES = [
  {
    url: "https://example.org/guides/start.html",
    title: "Orchard & routes",
    headings: ["Orchard & routes", "Getting started"],
    links: [
      "https://example.org/overview",
      "https://example.org/guides/start.html?mode=compact&view=all",
    ],
    html: `<!doctype html><html><head><title>Orchard &amp; routes</title>
      <script>SECRET_SCRIPT_SENTINEL <h3>Hidden</h3><a href="https://hidden.example/script">ignore</a></script></head>
      <body><h1>Orchard &amp; routes</h1><p>Long article prose is optional in an outline.</p>
      <h2>Getting <em>started</em></h2><a href="../overview#intro">Overview</a>
      <a href="https://example.org/overview#again">Duplicate</a>
      <a href="?mode=compact&amp;view=all">Compact view</a><a href="#local-only">Section</a>
      <a href="javascript:alert(1)">Script</a><a href="data:text/plain,hidden">Data</a>
      <a href="mailto:hello@example.org">Mail</a><a href="">Empty</a></body></html>`,
  },
  {
    url: "https://example.org/river/index.html?old=1",
    title: "River atlas",
    headings: ["Northern river", "Bridges & crossings"],
    links: [
      "https://docs.deno.com/api?x=1",
      "http://example.net/guide",
    ],
    html: `<HTML><HEAD><TITLE>River atlas</TITLE></HEAD><BODY>
      <STYLE>SECRET_STYLE_SENTINEL <H1>Hidden</H1><a href="https://hidden.example/style">ignore</a></STYLE>
      <H3 class=top>Northern <strong>river</strong></H3><H4>Bridges &amp; crossings</H4>
      <A HREF='//docs.deno.com/runtime/../api?x=1#intro'>API</A>
      <A href=http://example.net:80/a/../guide>Guide</A>
      <A href="https://docs.deno.com/api?x=1#again">API again</A>
      <A href='#local-only'>Local</A><A HREF="MAILTO:river@example.org">Mail</A>
      <p>Full paragraphs need not be retained.</p></BODY></HTML>`,
  },
  {
    url: "https://example.org/harbor/deep/",
    title: "Harbor 7",
    headings: ["Harbor visitors", "Seven boats"],
    links: [
      "https://example.org/harbor/boats?sort=name&limit=7",
      "https://example.org/dock",
    ],
    html: `<html><head><title>Harbor &#55;</title></head><body>
      <!-- SECRET_COMMENT_SENTINEL <h1>Hidden</h1><a href="https://hidden.example/comment">ignore</a> -->
      <h5>Harbor visitors</h5><p>See the port.</p><h6>Seven <span>boats</span></h6>
      <a class="detail" href="../boats?sort=name&amp;limit=7#intro">Boats</a>
      <a href="/dock">Dock</a><a href="../../dock#again">Same dock</a>
      <a href="tel:+1234">Telephone</a><a href="#local-only">Local</a>
      <script>SECRET_SCRIPT_SENTINEL</script></body></html>`,
  },
];

async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  onLimit: () => void,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        onLimit();
        await reader.cancel();
        throw new Error("Output/body limit exceeded");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function cleanText(value: string, limit: number): string {
  return value.replace(
    // deno-lint-ignore no-control-regex -- Strip control characters from generated text intentionally.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,
    "",
  )
    .replace(/\r\n?/g, "\n").trim().slice(0, limit);
}

const CHILD_WRAPPER = `
const encoder = new TextEncoder();
const write = Deno.stdout.write.bind(Deno.stdout);
const exit = Deno.exit.bind(Deno);
try {
  const raw = await new Response(Deno.stdin.readable).text();
  const {code, input} = JSON.parse(raw);
  const module = await import("data:application/typescript," + encodeURIComponent(code));
  const result = await module.default(input);
  const bytes = encoder.encode(JSON.stringify(result));
  let offset = 0;
  while(offset < bytes.length) offset += await write(bytes.subarray(offset));
  exit(0);
} catch { exit(1); }
`;
