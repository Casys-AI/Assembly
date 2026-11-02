/**
 * Tokens LSP : le parcours exact de `toolkit-source-tokens.ts`
 * (initialize UTF-16, légende, tokens complets) contre
 * `NativeLspServer`, avec preuve UTF-16 sur une ligne contenant un
 * emoji ; variantes bibliothèque et cycle de vie du serveur.
 *
 * Usage: deno run -A tests/lsp-tokens.ts --addon PATH.node [--out JSON]
 */
import {
  assert,
  assertEqual,
  expectCode,
  finish,
  loadAddon,
  type NativeLspServer,
  requiredArg,
  test,
} from "./support.ts";

const addon = await loadAddon(requiredArg("--addon"));
const baseline = addon.nativeResourceCounts();

type Message = Record<string, unknown>;

function send(server: NativeLspServer, message: Message): Message[] {
  return server
    .handle(JSON.stringify({ jsonrpc: "2.0", ...message }))
    .map((reply) => JSON.parse(reply) as Message);
}

function response(
  server: NativeLspServer,
  id: number,
  method: string,
  params: unknown,
): Record<string, unknown> {
  const reply = send(server, { id, method, params }).find((m) => m.id === id);
  assert(
    reply && !reply.error && "result" in reply,
    `LSP ${method} must reply`,
  );
  return reply.result as Record<string, unknown>;
}

/** Décode les tokens delta contre les unités UTF-16 du texte. */
function decodeTokens(
  data: number[],
  text: string,
): Array<{ line: number; start: number; length: number; slice: string }> {
  const lines = text.split("\n").map((line) => {
    const units: number[] = [];
    for (let i = 0; i < line.length; i++) units.push(line.charCodeAt(i));
    return units;
  });
  const out: Array<
    { line: number; start: number; length: number; slice: string }
  > = [];
  let line = 0;
  let start = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    if (data[i] === 0) start += data[i + 1]!;
    else {
      line += data[i]!;
      start = data[i + 1]!;
    }
    const length = data[i + 2]!;
    const units = lines[line] ?? [];
    out.push({
      line,
      start,
      length,
      slice: String.fromCharCode(...units.slice(start, start + length)),
    });
  }
  return out;
}

function utf16Offset(text: string, byteFreeIndex: number): number {
  // `byteFreeIndex` est un indice UTF-16 JS (String.indexOf) : c'est
  // déjà le compteur UTF-16 attendu côté LSP.
  return text.slice(0, byteFreeIndex).length;
}

test("semantic tokens full: UTF-16 negotiation, legend and emoji offsets", () => {
  const server = new addon.NativeLspServer();
  try {
    const initialized = response(server, 1, "initialize", {
      processId: null,
      rootUri: null,
      capabilities: { general: { positionEncodings: ["utf-16"] } },
      workspaceFolders: null,
    }) as { capabilities: Record<string, unknown> };
    const encoding = initialized.capabilities.positionEncoding;
    assert(
      encoding === undefined || encoding === "utf-16",
      `positions must be UTF-16, got ${String(encoding)}`,
    );
    const provider = initialized.capabilities.semanticTokensProvider as {
      legend?: { tokenTypes?: unknown };
      full?: unknown;
    };
    assert(Array.isArray(provider?.legend?.tokenTypes), "legend advertised");
    assert(
      provider.full === true ||
        (typeof provider.full === "object" && provider.full !== null),
      "full tokens advertised",
    );
    send(server, { method: "initialized", params: {} });
    const text = "package P { /* \u{1F600} */ part def Wheel; }\n";
    const uri = "file:///ase-syntax/p.sysml";
    send(server, {
      method: "textDocument/didOpen",
      params: {
        textDocument: { uri, languageId: "sysml", version: 1, text },
      },
    });
    const result = response(server, 2, "textDocument/semanticTokens/full", {
      textDocument: { uri },
    }) as { data: number[] };
    assert(Array.isArray(result.data) && result.data.length > 0, "token data");
    const tokens = decodeTokens(result.data, text);
    const wheelStart = utf16Offset(text, text.indexOf("Wheel"));
    const wheelBytes =
      new TextEncoder().encode(text.slice(0, text.indexOf("Wheel"))).length;
    assert(wheelStart !== wheelBytes, "fixture separates UTF-16 from bytes");
    assert(
      tokens.some((t) => t.slice === "Wheel" && t.start === wheelStart),
      `Wheel token at UTF-16 ${wheelStart}: ${JSON.stringify(tokens)}`,
    );
  } finally {
    server.close();
  }
});

test("library-backed server answers; closed server refuses with LSP_CLOSED", () => {
  const server = addon.NativeLspServer.withLibrarySources([
    { name: "lib.sysml", text: "package Lib { part def Wheel; }" },
  ]);
  const initialized = response(server, 1, "initialize", {
    processId: null,
    rootUri: null,
    capabilities: {},
    workspaceFolders: null,
  });
  assert(initialized !== null, "library server initializes");
  const refresh = server.setWorkspace([
    { name: "file:///m.sysml", text: "package M { part w : Lib::Wheel; }" },
  ]);
  assert(Array.isArray(refresh), "setWorkspace returns relay messages");
  server.close();
  assertEqual(server.isClosed, true, "server closed");
  server.close();
  expectCode(() => server.handle("{}"), "LSP_CLOSED", "handle after close");
  const after = addon.nativeResourceCounts();
  assertEqual(
    after.lspServersAlive,
    baseline.lspServersAlive,
    "lsp counts baseline",
  );
});

test("prepared-library server factory keeps its own library reference", () => {
  const library = new addon.ToolkitLibrary([
    { name: "lib.sysml", text: "package Lib { part def Wheel; }" },
  ]);
  const server = addon.NativeLspServer.withPreparedLibrary(library);
  library.close();
  const initialized = response(server, 1, "initialize", {
    processId: null,
    rootUri: null,
    capabilities: {},
    workspaceFolders: null,
  });
  assert(initialized !== null, "server outlives the library handle");
  server.close();
  expectCode(
    () => addon.NativeLspServer.withPreparedLibrary(library),
    "LIBRARY_CLOSED",
    "closed library refuses new servers",
  );
});

await finish("lsp-tokens.ts");
