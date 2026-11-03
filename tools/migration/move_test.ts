import { deepStrictEqual as equal, ok } from "node:assert";
import { dirname, resolve } from "node:path";
import { parseArguments, runMigration } from "./move.ts";

async function tree(
  run: (
    root: string,
    put: (file: string, source: string) => Promise<void>,
  ) => Promise<void>,
) {
  const directory = await Deno.makeTempDir({ prefix: "migration-" });
  const root = directory;
  const put = async (file: string, source: string) => {
    const path = resolve(root, file);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, source);
  };
  await Deno.mkdir(root, { recursive: true });
  try {
    await run(root, put);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}
Deno.test("dry run plans neighboring tests and importer/target relocation without writes", () =>
  tree(async (root, put) => {
    await put("src/old.ts", 'import "./dep.ts";');
    await put("src/old_test.ts", 'import "./old.ts";');
    await put("src/dep.ts", "export {};\n");
    await put("frontend/use.ts", 'export { x } from "../src/old.ts";');
    await put("src/unrelated.ts", 'import "./nested/../dep.ts";');
    const report = await runMigration(root, [{
      from: "src/old.ts",
      to: "src/new/old.ts",
    }]);
    equal(report.errors, []);
    equal(report.moves.length, 2);
    ok(!report.rewrites.some((row) => row.file === "src/unrelated.ts"));
    const empty = await runMigration(root, []);
    equal(empty.rewrites, []);
    ok(
      report.rewrites.some((row) =>
        row.file === "src/old.ts" && row.to === "../dep.ts"
      ),
    );
    ok(
      report.rewrites.some((row) =>
        row.file === "frontend/use.ts" && row.to === "../src/new/old.ts"
      ),
    );
    equal(
      await Deno.readTextFile(resolve(root, "src/old.ts")),
      'import "./dep.ts";',
    );
  }));
Deno.test("write changes actual module literals and living links, retaining fixtures and URL paths", () =>
  tree(async (root, put) => {
    await put("src/old.ts", "export const x = 1;");
    const source =
      `// import "./old.ts";\nconst fixture = 'import("./old.ts")';\nconst template = \`import "./old.ts"\`;\nimport "./old.ts";\nexport { x } from "./old.ts";\nconst module = import("./old.ts");\nconst url = new URL("./old.ts", import.meta.url);\nconst provenance = "src/old.ts";`;
    await put("src/use.ts", source);
    const documentation = [
      "[old](../src/old.ts#anchor)",
      "[`old.ts`](../src/old.ts)",
      '[title](../src/old.ts "A title")',
      '[angle](<../src/old.ts> "An angle title")',
      '[reference]: ../src/old.ts "Reference title"',
      '[angle-reference]: <../src/old.ts> "Reference title"',
      "```md",
      "[fixture](../src/old.ts)",
      "```",
      "`[inline-code](../src/old.ts)`",
      "[unchanged](../src/nested/../dep.ts)",
      "",
    ].join("\n");
    await put("docs/guide.md", documentation);
    await put("planning/history.md", "[old](../src/old.ts)\n");
    const report = await runMigration(root, [{
      from: "src/old.ts",
      to: "src/new/old.ts",
    }], true);
    equal(report.errors, []);
    equal(report.rewrites.length, 3);
    equal(report.docLinks.length, 6);
    equal(report.importMetaUrl, ["src/use.ts"]);
    const updated = await Deno.readTextFile(resolve(root, "src/use.ts"));
    ok(updated.includes('new URL("./old.ts", import.meta.url)'));
    ok(updated.includes("const fixture = 'import(\"./old.ts\")'"));
    equal(
      await Deno.readTextFile(resolve(root, "docs/guide.md")),
      documentation.split("\n").map((line, index) =>
        index < 6 ? line.replace("../src/old.ts", "../src/new/old.ts") : line
      ).join("\n"),
    );
    equal(
      await Deno.readTextFile(resolve(root, "planning/history.md")),
      "[old](../src/old.ts)\n",
    );
  }));
Deno.test("template expressions expose imports while literal text and export bodies remain opaque", () =>
  tree(async (root, put) => {
    await put("src/old.ts", "export const x = 1;");
    const source = [
      'export function example() { const from = "./old.ts"; return from; }',
      'export default class Example { method() { const from = "./old.ts"; return from; } }',
      'const literal = `import("./old.ts")`;',
      'const actual = `prefix ${import("./old.ts")} suffix`;',
      'const nested = `outer ${`inner ${import("./old.ts")}`} tail`;',
      'const braces = `value ${{ value: import("./old.ts") }.value}`;',
      'export type { x } from "./old.ts";',
      'export * from "./old.ts";',
    ].join("\n");
    await put("src/use.ts", source);
    const report = await runMigration(root, [{
      from: "src/old.ts",
      to: "src/new/old.ts",
    }], true);
    equal(report.errors, []);
    equal(report.rewrites.length, 5);
    const updated = await Deno.readTextFile(resolve(root, "src/use.ts"));
    ok(updated.includes('const from = "./old.ts"'));
    ok(updated.includes('const literal = `import("./old.ts")`;'));
    ok(updated.includes('`inner ${import("./new/old.ts")}`'));
  }));
Deno.test("neighbor tests retain their extensions across source extensions", () =>
  tree(async (root, put) => {
    for (
      const file of [
        "src/component.tsx",
        "src/component_test.ts",
        "src/component_test.tsx",
        "src/module.ts",
        "src/module_test.tsx",
      ]
    ) await put(file, "export {};");
    const report = await runMigration(root, [
      { from: "src/component.tsx", to: "src/new/component.tsx" },
      { from: "src/module.ts", to: "src/new/module.ts" },
    ], true);
    equal(report.errors, []);
    equal(report.moves.length, 5);
    for (
      const file of [
        "component_test.ts",
        "component_test.tsx",
        "module_test.tsx",
      ]
    ) {
      equal(
        await Deno.readTextFile(resolve(root, "src/new", file)),
        "export {};",
      );
    }
  }));
Deno.test("regex expressions and object import properties remain opaque", () =>
  tree(async (root, put) => {
    await put("src/old.ts", "export {};");
    const regex = String.raw`/import(".\/old.ts")/`;
    const source = [
      ...["&&", "||", "??", "+", "-", "*", "===", "in"].map((operator) =>
        `const value = ok ${operator} ${regex};`
      ),
      ...["throw", "yield", "void", "typeof", "!", "~"].map((operator) =>
        `function* fixture() { ${operator} ${regex}; }`
      ),
      'const object = { import: { from: "./old.ts" } };',
      'const provenance = "src/old.ts";',
      'import "./old.ts";',
    ].join("\n");
    await put("src/use.ts", source);
    const report = await runMigration(root, [{
      from: "src/old.ts",
      to: "src/new/old.ts",
    }], true);
    equal(report.errors, []);
    equal(report.rewrites.length, 1);
    equal(
      await Deno.readTextFile(resolve(root, "src/use.ts")),
      source.replace('\nimport "./old.ts";', '\nimport "./new/old.ts";'),
    );
  }));
Deno.test("invalid preflight prevents every write", () =>
  tree(async (root, put) => {
    await put("src/a.ts", "a");
    await put("src/b.ts", "b");
    for (
      const [first, second, code] of [
        ["src/new.ts", "src/a.ts", "DESTINATION_EXISTS"],
        [
          "src/new/file.ts",
          "src/new/file.ts/child.ts",
          "DESTINATION_ANCESTOR_COLLISION",
        ],
        ["src/new/File.ts", "src/new/file.ts", "DUPLICATE_PATH"],
      ]
    ) {
      const report = await runMigration(root, [
        { from: "src/a.ts", to: first },
        { from: "src/b.ts", to: second },
      ], true);
      ok(report.errors.some((row) => row.code === code));
      equal(await Deno.readTextFile(resolve(root, "src/a.ts")), "a");
      equal(await Deno.readTextFile(resolve(root, "src/b.ts")), "b");
    }
  }));
Deno.test("boundary rejects unsafe paths, duplicates, configuration and incomplete workers", () =>
  tree(async (root, put) => {
    await put("src/a.ts", "source");
    await put("src/main.ts", "");
    await put("frontend/deno.json", "{}");
    await put("src/adapters/out/sysml-toolkit/worker.ts", "");
    for (
      const [manifest, code] of [
        [[{ from: "src/a.ts", to: "src/y.ts" }, {
          from: "src/A.ts",
          to: "src/z.ts",
        }], "DUPLICATE_PATH"],
        [[{ from: "../escape.ts", to: "src/x.ts" }], "INVALID_PATH"],
        [[{ from: "src/a.ts", to: "src/it's.ts" }], "INVALID_PATH"],
        [[{ from: "src/main.ts", to: "src/y.ts" }], "PROTECTED_PATH"],
        [
          [{ from: "frontend/deno.json", to: "frontend/old.json" }],
          "PROTECTED_PATH",
        ],
        [[{ from: "src/a.ts", to: "src/y.ts" }, {
          from: "src/a.ts",
          to: "src/z.ts",
        }], "DUPLICATE_PATH"],
        [[{
          from: "src/adapters/out/sysml-toolkit/worker.ts",
          to: "src/worker.ts",
        }], "INCOMPLETE_WORKER_GROUP"],
      ] as const
    ) {
      const report = await runMigration(root, manifest, true);
      ok(report.errors.some((row) => row.code === code));
      equal(await Deno.readTextFile(resolve(root, "src/a.ts")), "source");
    }
  }));
Deno.test("malformed manifests are refused without writes", () =>
  tree(async (root, put) => {
    await put("src/a.ts", "source");
    for (
      const manifest of [null, {}, [{ from: "src/a.ts" }], [{
        from: "src/a.ts",
        to: "src/b.ts",
        extra: true,
      }], [{ from: 1, to: "src/b.ts" }]]
    ) {
      const report = await runMigration(root, manifest, true);
      equal(report.errors.map((row) => row.code), ["INVALID_MANIFEST"]);
      equal(await Deno.readTextFile(resolve(root, "src/a.ts")), "source");
    }
  }));
Deno.test("JSX text and attributes are opaque while expressions retain dynamic imports", () =>
  tree(async (root, put) => {
    await put("src/old.ts", "export {};");
    const source = [
      'const view = <p>import "./old.ts"</p>;',
      `const commented = <Panel
        // The page's path includes import "./old.ts".
        /* The page's path includes import "./old.ts". */
        label='import "./old.ts"'
        data={import("./old.ts")}
      />;`,
      `const nested = <><Panel label='import "./old.ts"' data={import("./old.ts")}><span>import "./old.ts"</span>{import("./old.ts")}<Icon title='import "./old.ts"' /></Panel></>;`,
      'import "./old.ts";',
    ].join("\n");
    await put("src/use.tsx", source);
    const report = await runMigration(root, [{
      from: "src/old.ts",
      to: "src/new/old.ts",
    }], true);
    equal(report.errors, []);
    equal(report.rewrites.length, 4);
    equal(
      await Deno.readTextFile(resolve(root, "src/use.tsx")),
      source.replaceAll('import("./old.ts")', 'import("./new/old.ts")').replace(
        '\nimport "./old.ts";',
        '\nimport "./new/old.ts";',
      ),
    );
  }));
Deno.test("lexer refusal identifies the file and prevents all writes", () =>
  tree(async (root, put) => {
    await put("src/old.ts", "source");
    await put("frontend/broken.tsx", "const view = <Panel>");
    const report = await runMigration(root, [{
      from: "src/old.ts",
      to: "src/new/old.ts",
    }], true);
    equal(
      report.errors.map((error) => ({
        code: error.code,
        file: error.context.file,
      })),
      [{ code: "UNTERMINATED_JSX", file: "frontend/broken.tsx" }],
    );
    equal(report.moves, [{ from: "src/old.ts", to: "src/new/old.ts" }]);
    equal(await Deno.readTextFile(resolve(root, "src/old.ts")), "source");
  }));
Deno.test("regex following control headers cannot swallow later imports or division", () =>
  tree(async (root, put) => {
    await put("src/old.ts", "export {};");
    const source = [
      'if (ok) /"/.test(text); import "./old.ts";',
      'while (ok()) /"/.test(text); import "./old.ts";',
      'for (; ok ;) /"/.test(text); import "./old.ts";',
      'const quotient = call() / divisor; import "./old.ts";',
      'if (ok) {} /"/.test(text); import "./old.ts";',
      'function example() {} /"/.test(text); import "./old.ts";',
      'const objectDivision = {} / import("./old.ts") / 2;',
      'const functionDivision = function example() {} / import("./old.ts") / 2;',
    ].join("\n");
    await put("src/use.ts", source);
    const report = await runMigration(root, [{
      from: "src/old.ts",
      to: "src/new/old.ts",
    }], true);
    equal(report.errors, []);
    equal(report.rewrites.length, 8);
    equal(
      await Deno.readTextFile(resolve(root, "src/use.ts")),
      source.replaceAll('import "./old.ts"', 'import "./new/old.ts"')
        .replaceAll('import("./old.ts")', 'import("./new/old.ts")'),
    );
  }));
Deno.test("filesystem boundary refuses symlinks and existing case aliases", () =>
  tree(async (root, put) => {
    await put("src/a.ts", "a");
    await Deno.symlink(resolve(root, "src"), resolve(root, "linked"));
    const report = await runMigration(root, [{
      from: "src/a.ts",
      to: "linked/b.ts",
    }]);
    ok(report.errors.some((row) => row.code === "SYMLINK_PATH"));
    let aliasExists = false;
    try {
      aliasExists = (await Deno.stat(resolve(root, "SRC"))).isDirectory;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (aliasExists) {
      for (
        const move of [{ from: "SRC/a.ts", to: "src/new.ts" }, {
          from: "src/a.ts",
          to: "SRC/new.ts",
        }]
      ) {
        const aliasReport = await runMigration(root, [move], true);
        equal(aliasReport.errors.map((error) => error.code), [
          "NON_CANONICAL_PATH",
        ]);
        equal(await Deno.readTextFile(resolve(root, "src/a.ts")), "a");
      }
    }
  }));
Deno.test("hot files permit only import rewrites and refuse moves and doc changes", () =>
  tree(async (root, put) => {
    await put(
      ".codex-hot-files.txt",
      "src/use.ts\ndocs/guide.md\n",
    );
    await put("src/a.ts", "export {};");
    await put("src/use.ts", 'import "./a.ts";');
    let report = await runMigration(root, [{
      from: "src/a.ts",
      to: "src/new/a.ts",
    }]);
    equal(report.errors, []);
    equal(report.rewrites.length, 1);
    report = await runMigration(root, [{
      from: "src/use.ts",
      to: "src/new/use.ts",
    }]);
    ok(report.errors.some((row) => row.code === "HOT_FILE_MOVE"));
    await put("docs/guide.md", "[a](../src/a.ts)");
    report = await runMigration(root, [{
      from: "src/a.ts",
      to: "src/new/a.ts",
    }], true);
    ok(report.errors.some((row) => row.code === "HOT_DOC_EDIT"));
    equal(
      await Deno.readTextFile(resolve(root, "src/use.ts")),
      'import "./a.ts";',
    );
  }));
Deno.test("CLI accepts only explicit manifest and write options", () => {
  equal(parseArguments(["--manifest=a.json", "--write"]), {
    manifest: "a.json",
    write: true,
  });
  for (
    const args of [[], ["--wat"], ["--manifest", "a", "--write", "--write"]]
  ) {
    let thrown: unknown;
    try {
      parseArguments(args);
    } catch (error) {
      thrown = error;
    }
    ok(thrown && typeof thrown === "object" && "code" in thrown);
  }
});
