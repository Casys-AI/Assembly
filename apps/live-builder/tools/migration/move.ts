import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Move {
  from: string;
  to: string;
}
export interface MigrationError {
  code: string;
  context: Record<string, unknown>;
  recovery: string;
}
export interface MigrationReport {
  moves: Move[];
  rewrites: { file: string; from: string; to: string }[];
  importMetaUrl: string[];
  docLinks: { file: string; line: number; target: string }[];
  errors: MigrationError[];
}
const groups = [
  [
    "src/adapters/out/sysml-toolkit/worker.ts",
    "src/adapters/out/sysml-toolkit/native-process.ts",
    "src/adapters/out/sysml-toolkit/worker-client.ts",
    "test/fixtures/sysml-toolkit-worker-fixture.ts",
  ],
  [
    "src/adapters/out/sysml-toolkit/projections/authority-matrix/process.ts",
    "src/adapters/out/sysml-toolkit/projections/authority-matrix/worker-client.ts",
    "test/fixtures/authority-matrix-no-compile-worker.ts",
    "test/fixtures/sysml-toolkit-worker-fixture.ts",
  ],
  [
    "src/adapters/out/oxigraph/process.ts",
    "src/adapters/out/oxigraph/process-client.ts",
    ...["hang", "crash", "permission-probe", "stall-after-commit"].map((name) =>
      `test/support/semantic-projection-${name}.ts`
    ),
  ],
];
function issue(
  code: string,
  context: Record<string, unknown>,
  recovery: string,
): MigrationError {
  return { code, context, recovery };
}
async function stat(path: string): Promise<Deno.FileInfo | undefined> {
  try {
    return await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}
function validPath(path: string): boolean {
  return path.split("/").every((part) =>
    /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== ".."
  );
}
async function pathBoundary(
  root: string,
  path: string,
): Promise<MigrationError | undefined> {
  let current = root;
  for (const part of path.split("/")) {
    current = resolve(current, part);
    const info = await stat(current);
    if (!info) break;
    if (info.isSymlink) {
      return issue(
        "SYMLINK_PATH",
        { path },
        "Use paths without symlink components.",
      );
    }
    const canonical = await Deno.realPath(current);
    if (canonical !== current) {
      return issue("NON_CANONICAL_PATH", {
        path,
        component: relative(root, current),
        canonical: relative(root, canonical),
      }, "Use the exact filesystem spelling shown by the canonical path.");
    }
  }
}
async function files(root: string, directory: string): Promise<string[]> {
  if (!(await stat(resolve(root, directory)))?.isDirectory) return [];
  const result: string[] = [];
  for await (const entry of Deno.readDir(resolve(root, directory))) {
    if (
      entry.isSymlink ||
      ["node_modules", ".git", ".data", "_fresh"].includes(entry.name)
    ) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) result.push(...await files(root, path));
    else if (entry.isFile) result.push(path);
  }
  return result.sort();
}
interface Token {
  value: string;
  start: number;
  end: number;
  string?: boolean;
}
// Literal text is opaque; template interpolations re-enter the code scanner.
function tokens(source: string, jsxEnabled: boolean): Token[] {
  const result: Token[] = [];
  let i = 0;
  function skipComment(): boolean {
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      return true;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      return true;
    }
    return false;
  }
  function template() {
    result.push({ value: "", start: i, end: i + 1 });
    i++;
    while (i < source.length) {
      if (source[i] === "\\") {
        i += 2;
        continue;
      }
      if (source[i] === "`") {
        i++;
        break;
      }
      if (source.startsWith("${", i)) {
        result.push({ value: "{", start: i, end: i + 2 });
        i += 2;
        code(true);
        continue;
      }
      i++;
    }
    result.push({ value: "", start: i, end: i });
  }
  function expressionStart(): boolean {
    const previous = result.at(-1);
    if (!previous) return true;
    if (previous.string) return false;
    return [
      "(",
      "[",
      "{",
      ",",
      ":",
      ";",
      "return",
      "case",
      "throw",
      "yield",
      "await",
      "typeof",
      "void",
      "delete",
      "in",
      "instanceof",
      "of",
      "new",
    ].includes(previous.value) ||
      (/^(?:=>|[=!*%&|^~?:<>+\/-]+)$/.test(previous.value) &&
        !["++", "--"].includes(previous.value));
  }
  function regexEnd(start: number): number | undefined {
    let position = start + 1;
    let characterClass = false;
    while (position < source.length && !/[\r\n]/.test(source[position])) {
      if (source[position] === "\\") {
        position += 2;
        continue;
      }
      if (source[position] === "[") characterClass = true;
      else if (source[position] === "]") characterClass = false;
      else if (source[position] === "/" && !characterClass) {
        position++;
        while (position < source.length && /[a-z]/i.test(source[position])) {
          position++;
        }
        return position;
      }
      position++;
    }
  }
  function jsxExpression() {
    result.push({ value: "{", start: i, end: i + 1 });
    i++;
    code(true);
  }
  function jsxElement() {
    const start = i;
    result.push({ value: "", start, end: start });
    i++;
    // Names, tag delimiters and quoted attributes are opaque JSX syntax.
    while (i < source.length) {
      if (skipComment()) continue;
      if (source.startsWith("/>", i)) {
        i += 2;
        return;
      }
      if (source[i] === ">") {
        i++;
        break;
      }
      if (source[i] === "{") {
        jsxExpression();
        continue;
      }
      if (source[i] === '"' || source[i] === "'") {
        const quote = source[i++];
        while (i < source.length && source[i] !== quote) i++;
        i++;
        continue;
      }
      i++;
    }
    while (i < source.length) {
      if (source.startsWith("</", i)) {
        const end = source.indexOf(">", i + 2);
        if (end < 0) break;
        i = end + 1;
        result.push({ value: "", start, end: i });
        return;
      }
      if (source[i] === "<") {
        jsxElement();
        continue;
      }
      if (source[i] === "{") {
        jsxExpression();
        continue;
      }
      i++;
    }
    throw issue(
      "UNTERMINATED_JSX",
      { offset: start },
      "Use valid JSX or review this unsupported JSX/TypeScript lexical form before moving files.",
    );
  }
  function declarationParameters(): boolean {
    let functionIndex = result.length - 1;
    if (result[functionIndex]?.value !== "function") functionIndex--;
    if (result[functionIndex]?.value === "*") functionIndex--;
    if (result[functionIndex]?.value !== "function") return false;
    let preceding = functionIndex - 1;
    if (result[preceding]?.value === "async") preceding--;
    return preceding < 0 ||
      [";", "{", "}", "export", "default"].includes(result[preceding].value);
  }
  function code(interpolation = false) {
    const braces: boolean[] = [];
    const parentheses: boolean[] = [];
    let afterStatementHeader = false;
    let afterStatementBlock = false;
    while (i < source.length) {
      const start = i;
      const c = source[i];
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (skipComment()) continue;
      if (c === "`") {
        afterStatementHeader = false;
        afterStatementBlock = false;
        template();
        continue;
      }
      if (
        jsxEnabled && c === "<" && expressionStart() &&
        /^<(?:>|[A-Za-z_$][\w.$:-]*(?=[\s/>]))/.test(source.slice(i))
      ) {
        afterStatementHeader = false;
        afterStatementBlock = false;
        jsxElement();
        result.push({ value: "", start, end: i });
        continue;
      }
      if (
        c === "/" &&
        (afterStatementHeader || afterStatementBlock || expressionStart())
      ) {
        const end = regexEnd(i);
        if (end !== undefined) {
          i = end;
          afterStatementHeader = false;
          afterStatementBlock = false;
          result.push({ value: "", start, end: i });
          continue;
        }
      }
      const previous = result.at(-1)?.value;
      const opensStatementBlock = c === "{" &&
        (afterStatementHeader || afterStatementBlock ||
          previous === undefined ||
          [";", "else", "try", "finally", "do"].includes(previous) ||
          (previous === "{" && braces.at(-1) === true));
      afterStatementBlock = false;
      if (c === "(") {
        parentheses.push(
          ["if", "while", "for", "with", "switch", "catch"].includes(
            previous ?? "",
          ) || (previous === "await" && result.at(-2)?.value === "for") ||
            declarationParameters(),
        );
      }
      afterStatementHeader = c === ")" && parentheses.pop() === true;
      if (c === '"' || c === "'") {
        i++;
        while (i < source.length) {
          if (source[i] === "\\") i += 2;
          else if (source[i++] === c) break;
        }
        result.push({
          value: source.slice(start + 1, i - 1),
          start,
          end: i,
          string: true,
        });
        continue;
      }
      if (/[\w$]/.test(c)) {
        while (i < source.length && /[\w$]/.test(source[i])) {
          i++;
        }
      } else {
        const operator =
          /^(?:===|!==|>>>|\*\*=|&&=|\|\|=|\?\?=|=>|\+\+|--|==|!=|<=|>=|&&|\|\||\?\?|\*\*|<<|>>|[+\-*%&|^/]=)/
            .exec(source.slice(i));
        i += operator?.[0].length ?? 1;
      }
      result.push({ value: source.slice(start, i), start, end: i });
      if (c === "{") braces.push(opensStatementBlock);
      if (c === "}") {
        if (interpolation && braces.length === 0) return;
        afterStatementBlock = braces.pop() === true;
      }
    }
  }
  code();
  return result;
}
function imports(ts: Token[]): Token[] {
  const result: Token[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (
      ts[i].string || !["import", "export"].includes(ts[i].value) ||
      [".", "?"].includes(ts[i - 1]?.value)
    ) continue;
    if (ts[i].value === "import" && ts[i + 1]?.string) {
      result.push(ts[i + 1]);
      continue;
    }
    if (ts[i + 1]?.value === "(") {
      if (ts[i + 2]?.string && [")", ","].includes(ts[i + 3]?.value)) {
        result.push(ts[i + 2]);
      }
      continue;
    }
    if (ts[i + 1]?.value === ".") continue;
    const declaration = ts[i + 1]?.value === "type" ? i + 2 : i + 1;
    if (ts[i].value === "export") {
      let j = declaration;
      if (ts[j]?.value === "{") {
        let depth = 1;
        while (++j < ts.length && depth) {
          if (!ts[j].string && ts[j].value === "{") depth++;
          if (!ts[j].string && ts[j].value === "}") depth--;
        }
      } else if (ts[j]?.value === "*") {
        j++;
        if (ts[j]?.value === "as") j += 2;
      } else continue;
      if (ts[j]?.value === "from" && ts[j + 1]?.string) result.push(ts[j + 1]);
      continue;
    }
    if (
      !["{", "*"].includes(ts[declaration]?.value) &&
      !/^[A-Za-z_$][\w$]*$/.test(ts[declaration]?.value ?? "")
    ) continue;
    for (
      let j = i + 1;
      j < ts.length && ![";", "import", "export", "="].includes(ts[j].value);
      j++
    ) {
      if (!ts[j].string && ts[j].value === "from" && ts[j + 1]?.string) {
        result.push(ts[j + 1]);
        break;
      }
    }
  }
  return result;
}
function relocatedSpecifier(
  root: string,
  file: string,
  destination: string,
  specifier: string,
  mapping: Map<string, string>,
): string {
  const split = specifier.search(/[?#]/);
  const base = split < 0 ? specifier : specifier.slice(0, split);
  const suffix = split < 0 ? "" : specifier.slice(split);
  const target = relative(root, resolve(root, dirname(file), base));
  if (destination === file && !mapping.has(target)) return specifier;
  const changed = mapping.get(target) ?? target;
  const next = relative(
    resolve(root, dirname(destination)),
    resolve(root, changed),
  );
  return (next.startsWith(".") ? next : `./${next}`) + suffix;
}
function rewriteMarkdown(
  source: string,
  rewrite: (target: string, line: number) => string,
): string {
  let fence: { marker: string; length: number } | undefined;
  return source.split("\n").map((line, index) => {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        delimiter && delimiter[1][0] === fence.marker &&
        delimiter[1].length >= fence.length &&
        /^\s*$/.test(line.slice(delimiter[0].length))
      ) fence = undefined;
      return line;
    }
    if (delimiter) {
      fence = { marker: delimiter[1][0], length: delimiter[1].length };
      return line;
    }
    if (/^(?: {4}|\t)/.test(line)) return line;
    const destination = (whole: string, prefix: string, target: string) => {
      const angle = target.startsWith("<") && target.endsWith(">");
      const value = angle ? target.slice(1, -1) : target;
      const next = rewrite(value, index + 1);
      return prefix + (angle ? `<${next}>` : next) +
        whole.slice(prefix.length + target.length);
    };
    const references = line.replace(
      /^([ \t]{0,3}\[[^\]\n]+\]:[ \t]*)(<[^>\n]+>|[^\s]+)/,
      destination,
    );
    // Match the first complete token: a link may contain a code-styled label,
    // while a code span enclosing link syntax remains literal.
    return references.replace(
      /(`+)[\s\S]*?\1|(!?\[[^\]\n]*\]\([ \t]*)(<[^>\n]+>|[^\s)]+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*\)/g,
      (whole, code: string | undefined, prefix: string, target: string) =>
        code === undefined ? destination(whole, prefix, target) : whole,
    );
  }).join("\n");
}
function collisionKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function protectedPath(path: string): boolean {
  return path === "src/main.ts" || path.endsWith("sysml-toolkit-pin.ts") ||
    /^(?:\.data|vendor|native|models|prototypes|frontend\/(?:routes|_fresh))(?:\/|$)/
      .test(path) ||
    /^(?:frontend\/)?(?:deno\.(?:jsonc?|lock)|\.deno-version)$/.test(path);
}
export async function runMigration(
  root: string,
  input: unknown,
  write = false,
): Promise<MigrationReport> {
  root = await Deno.realPath(resolve(root));
  const report: MigrationReport = {
    moves: [],
    rewrites: [],
    importMetaUrl: [],
    docLinks: [],
    errors: [],
  };
  const fail = (
    code: string,
    context: Record<string, unknown>,
    recovery: string,
  ) => report.errors.push(issue(code, context, recovery));
  if (
    !Array.isArray(input) ||
    input.some((row) =>
      !row || typeof row !== "object" ||
      Object.keys(row).sort().join() !== "from,to" ||
      typeof row.from !== "string" || typeof row.to !== "string"
    )
  ) {
    fail(
      "INVALID_MANIFEST",
      {},
      "Supply an array of objects containing only string from and to fields.",
    );
    return report;
  }
  let hotText = "";
  const hotFile = resolve(root, "../../.codex-hot-files.txt");
  if (await stat(hotFile)) hotText = await Deno.readTextFile(hotFile);
  const hot = new Set(
    hotText.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
      line && !line.startsWith("#")
    ).map((path) => path.replace(/^apps\/live-builder\//, "")),
  );
  for (const move of input as Move[]) {
    if (!validPath(move.from) || !validPath(move.to)) {
      fail(
        "INVALID_PATH",
        { ...move },
        "Use relative paths of ASCII segments [A-Za-z0-9_.-]+ separated by /; no empty, . or .. segments.",
      );
    }
  }
  if (report.errors.length) return report;
  const moves: Move[] = [...input];
  for (const move of input as Move[]) {
    if (/\.tsx?$/.test(move.from) && !/_test\.tsx?$/.test(move.from)) {
      for (const extension of ["ts", "tsx"]) {
        const neighbor = move.from.replace(/\.tsx?$/, `_test.${extension}`);
        if (
          (await stat(resolve(root, neighbor)))?.isFile &&
          !moves.some((row) => row.from === neighbor)
        ) {
          moves.push({
            from: neighbor,
            to: move.to.replace(/\.tsx?$/, `_test.${extension}`),
          });
        }
      }
    }
  }
  const sources = new Set<string>();
  const sourceKeys = new Set<string>();
  const destinations = new Set<string>();
  for (const move of moves) {
    const normalizedDestination = collisionKey(move.to);
    if (
      sourceKeys.has(collisionKey(move.from)) ||
      destinations.has(normalizedDestination)
    ) {
      fail(
        "DUPLICATE_PATH",
        { ...move },
        "Use each source and destination once.",
      );
    }
    sources.add(move.from);
    sourceKeys.add(collisionKey(move.from));
    for (const destination of destinations) {
      if (
        normalizedDestination.startsWith(destination + "/") ||
        destination.startsWith(normalizedDestination + "/")
      ) {
        fail("DESTINATION_ANCESTOR_COLLISION", {
          to: move.to,
          other: destination,
        }, "Choose destinations that are not parents of one another.");
      }
    }
    destinations.add(normalizedDestination);
    if (protectedPath(move.from) || protectedPath(move.to)) {
      fail(
        "PROTECTED_PATH",
        { ...move },
        "Keep entry points, pins, configuration, route and data paths in place.",
      );
    }
    if (hot.has(move.from) || hot.has(move.to)) {
      fail(
        "HOT_FILE_MOVE",
        { ...move },
        "Remove this move from the manifest; hot files cannot move.",
      );
    }
    const boundaryFailure = await pathBoundary(root, move.from) ??
      await pathBoundary(root, move.to);
    if (boundaryFailure) {
      report.errors.push(boundaryFailure);
      continue;
    }
    if (!(await stat(resolve(root, move.from)))?.isFile) {
      fail(
        "SOURCE_NOT_FILE",
        { from: move.from },
        "Select an existing regular source file.",
      );
    }
    for (
      let parent = dirname(move.to);
      parent !== ".";
      parent = dirname(parent)
    ) {
      const info = await stat(resolve(root, parent));
      if (info && !info.isDirectory) {
        fail(
          "DESTINATION_PARENT_NOT_DIRECTORY",
          { path: parent },
          "Choose a destination with directory parents.",
        );
        break;
      }
    }
    if (await stat(resolve(root, move.to))) {
      fail(
        "DESTINATION_EXISTS",
        { to: move.to },
        "Choose a destination that does not exist.",
      );
    }
  }
  const protectedGroups = [...groups, [
    "src/adapters/out/shacl/ase-diagnostics-shapes.ttl",
    "src/adapters/out/shacl/diagnostics.ts",
  ]];
  for (const group of protectedGroups) {
    if (
      group.some((path) => sources.has(path)) &&
      !group.every((path) => sources.has(path))
    ) {
      fail(
        "INCOMPLETE_WORKER_GROUP",
        { required: group },
        "Move the worker, client and all listed fixtures together.",
      );
    }
  }
  if (report.errors.length) return report;
  report.moves = moves.sort((a, b) => compare(a.from, b.from));
  const mapping = new Map(moves.map((move) => [move.from, move.to]));
  const edits = new Map<string, string>();
  for (const directory of ["src", "test", "tools", "frontend", "examples"]) {
    for (const file of await files(root, directory)) {
      if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
      const source = await Deno.readTextFile(resolve(root, file));
      let ts: Token[];
      try {
        ts = tokens(source, /\.[jt]sx$/.test(file));
      } catch (error) {
        if (
          error && typeof error === "object" && "code" in error &&
          error.code === "UNTERMINATED_JSX"
        ) {
          const failure = error as MigrationError;
          report.errors.push({
            ...failure,
            context: { ...failure.context, file },
          });
          return report;
        }
        throw error;
      }
      if (
        ts.some((token, i) =>
          token.value === "import" &&
          ts.slice(i + 1, i + 5).map((t) => t.value).join("") === ".meta.url"
        )
      ) report.importMetaUrl.push(file);
      const replacements: { start: number; end: number; text: string }[] = [];
      for (const token of imports(ts)) {
        if (!token.value.startsWith(".") || token.value.includes("\\")) {
          continue;
        }
        const next = relocatedSpecifier(
          root,
          file,
          mapping.get(file) ?? file,
          token.value,
          mapping,
        );
        if (next === token.value) continue;
        report.rewrites.push({ file, from: token.value, to: next });
        replacements.push({
          start: token.start + 1,
          end: token.end - 1,
          text: next,
        });
      }
      let updated = source;
      for (const change of replacements.sort((a, b) => b.start - a.start)) {
        updated = updated.slice(0, change.start) + change.text +
          updated.slice(change.end);
      }
      if (updated !== source) edits.set(file, updated);
    }
  }
  const docs = [
    ...await files(root, "docs"),
    "src/README.md",
    "AGENTS.md",
    "../../CONTRIBUTING.md",
  ].filter((path) => path.endsWith(".md"));
  for (const file of [...new Set(docs)].sort()) {
    if (!(await stat(resolve(root, file)))?.isFile) continue;
    const source = await Deno.readTextFile(resolve(root, file));
    const updated = rewriteMarkdown(source, (target, line) => {
      if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(target)) return target;
      const next = relocatedSpecifier(
        root,
        file,
        mapping.get(file) ?? file,
        target,
        mapping,
      );
      if (next === target || next === `./${target}`) return target;
      if (
        hot.has(file) ||
        hot.has(relative(resolve(root, "../.."), resolve(root, file)))
      ) {
        fail(
          "HOT_DOC_EDIT",
          {
            file,
            target,
            movedTarget: relative(
              root,
              resolve(root, dirname(file), target.split(/[?#]/)[0]),
            ),
            proposedTarget: next,
          },
          "Update this protected documentation separately after coordination.",
        );
        return target;
      }
      report.docLinks.push({ file, line, target: next });
      return next;
    });
    if (updated !== source) edits.set(file, updated);
  }
  report.rewrites.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  report.importMetaUrl.sort();
  report.docLinks.sort((a, b) =>
    compare(a.file, b.file) || a.line - b.line || compare(a.target, b.target)
  );
  if (write && !report.errors.length) {
    for (const move of report.moves) {
      await Deno.mkdir(dirname(resolve(root, move.to)), { recursive: true });
      await Deno.rename(resolve(root, move.from), resolve(root, move.to));
    }
    for (
      const [file, content] of [...edits].sort(([a], [b]) => compare(a, b))
    ) {
      await Deno.writeTextFile(
        resolve(root, mapping.get(file) ?? file),
        content,
      );
    }
  }
  return report;
}
export function parseArguments(
  args: string[],
): { manifest: string; write: boolean } {
  let manifest = "";
  let write = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--write" && !write) write = true;
    else if (
      args[i] === "--manifest" && !manifest && args[i + 1] &&
      !args[i + 1].startsWith("--")
    ) manifest = args[++i];
    else if (
      args[i].startsWith("--manifest=") && !manifest && args[i].slice(11)
    ) manifest = args[i].slice(11);
    else {
      throw issue(
        "INVALID_ARGUMENT",
        { argument: args[i] },
        "Use --manifest <file.json> once and optionally --write once.",
      );
    }
  }
  if (!manifest) {
    throw issue("MANIFEST_REQUIRED", {}, "Supply --manifest <file.json>.");
  }
  return { manifest, write };
}
if (import.meta.main) {
  try {
    const args = parseArguments(Deno.args);
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const report = await runMigration(
      root,
      JSON.parse(await Deno.readTextFile(args.manifest)),
      args.write,
    );
    console.log(JSON.stringify(report, null, 2));
    if (report.errors.length) Deno.exitCode = 1;
  } catch (error) {
    const failure = error && typeof error === "object" && "code" in error &&
        "recovery" in error
      ? error
      : issue(
        "MIGRATION_FAILED",
        { message: error instanceof Error ? error.message : String(error) },
        "Correct the input or filesystem error, inspect any partial write, and rerun the dry run.",
      );
    console.log(
      JSON.stringify(
        {
          moves: [],
          rewrites: [],
          importMetaUrl: [],
          docLinks: [],
          errors: [failure],
        },
        null,
        2,
      ),
    );
    Deno.exitCode = 1;
  }
}
