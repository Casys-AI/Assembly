import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { dirname } from "node:path";
import { deepEqual, equal, rejects } from "node:assert/strict";
import {
  SYSML_TOOLKIT_VERSION,
  toolkitBundleFilesFor,
  type ToolkitBundleProvenance,
  toolkitBundleProvenance,
} from "../../src/adapters/out/sysml-toolkit/runtime/loader.ts";
import { runSysmlToolkitWorker } from "../../src/adapters/out/sysml-toolkit/worker-client.ts";
import { DenoRuntimeProvenanceCollector } from "../../src/infrastructure/runtime-provenance.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";

import { toolkitNativePlatform } from "../../src/adapters/sysml-toolkit-pin.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const bundleFiles = toolkitBundleFilesFor(
  toolkitNativePlatform(Deno.build.os, Deno.build.arch)!,
);

Deno.test({
  name: "toolkit startup worker reports the exact loaded bundle fingerprint",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const actual = await runSysmlToolkitWorker<ToolkitBundleProvenance>(
      packageDir!,
      { operation: "provenance" },
    );
    const files = Object.fromEntries(
      await Promise.all(bundleFiles.map(async (name) => [
        name,
        await Deno.readFile(`${packageDir}/${name}`),
      ])),
    );
    deepEqual(
      actual,
      await toolkitBundleProvenance(SYSML_TOOLKIT_VERSION, files),
    );
  },
});

for (const replacement of ["redirect-link", "replace-bytes"] as const) {
  Deno.test({
    name:
      `toolkit workers refuse ${replacement} after startup provenance at the same version`,
    ignore: !toolkitIntegrationEnabled,
    async fn() {
      const root = await Deno.makeTempDir({ prefix: "ase-toolkit-pin-" });
      try {
        for (const name of ["first", "second"]) {
          await Deno.mkdir(`${root}/${name}/stdlib`, { recursive: true });
          for (const file of bundleFiles) {
            await Deno.mkdir(dirname(`${root}/${name}/${file}`), {
              recursive: true,
            });
            await Deno.copyFile(
              `${packageDir}/${file}`,
              `${root}/${name}/${file}`,
            );
          }
        }
        const link = `${root}/selected`;
        await Deno.symlink(`${root}/first`, link);
        const collector = new DenoRuntimeProvenanceCollector({
          applicationDirectory: root,
          toolkitPackageDirectory: link,
          agents: { provider: "muse", model: "configured-model" },
        }, {
          runGit: (args) =>
            Promise.resolve(args[0] === "rev-parse" ? "a".repeat(40) : ""),
        });
        const startup = await collector.collect();
        equal(startup.provenance.toolkit.version, SYSML_TOOLKIT_VERSION);
        const tooling = new SysmlToolkitAdapter({ packageDir: link });
        deepEqual(await tooling.check({ "model.sysml": "package Demo;" }), []);
        if (replacement === "redirect-link") {
          // Even an identical same-version bundle at another path is refused.
          await Deno.remove(link);
          await Deno.symlink(`${root}/second`, link);
        } else {
          await Deno.writeTextFile(
            `${root}/first/LICENSE`,
            "\nFingerprint drift fixture\n",
            {
              append: true,
            },
          );
        }
        await rejects(
          () =>
            new ToolkitCompiler({ packageDir: link }).compile({
              "model.sysml": "package Demo;",
            }),
          { code: "TOOLKIT_BUNDLE_DRIFT" },
        );
        await rejects(
          () => tooling.check({ "model.sysml": "package Demo;" }),
          { code: "TOOLKIT_BUNDLE_DRIFT" },
        );
        deepEqual(await collector.collect(), startup);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    },
  });
}
