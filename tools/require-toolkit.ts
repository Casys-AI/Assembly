/** Fail fast before the real-Toolkit suite instead of skipping it silently. */
import {
  TOOLKIT_DIRECTORY,
  TOOLKIT_PACKAGE_NAME,
  TOOLKIT_RELEASE,
  toolkitAddonPath,
  toolkitNativePlatform,
} from "../src/adapters/sysml-toolkit-pin.ts";

const dir = Deno.env.get("SYSML_TOOLKIT_DIR");
const fail = (code: string, message: string, recovery: string) => {
  console.error(JSON.stringify({ code, message, recovery }));
  Deno.exit(2);
};
const recovery =
  "Run deno task model:toolkit:setup, then set SYSML_TOOLKIT_DIR to the package path printed by setup.";
if (!dir) {
  fail(
    "TOOLKIT_DIR_MISSING",
    "SYSML_TOOLKIT_DIR is not set; the real-Toolkit tests would be skipped.",
    recovery,
  );
} else {
  const platform = toolkitNativePlatform(Deno.build.os, Deno.build.arch);
  if (!platform) {
    fail(
      "TOOLKIT_PLATFORM_UNSUPPORTED",
      `No native SysML Toolkit addon is declared for ${Deno.build.os}-${Deno.build.arch}.`,
      `Declared toolchains install under .data/toolchains/${TOOLKIT_DIRECTORY}/package`,
    );
  }
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(`${dir}/package.json`),
    );
    if (
      manifest.name !== TOOLKIT_PACKAGE_NAME ||
      manifest.version !== TOOLKIT_RELEASE
    ) throw new Error("identity");
    if (!(await Deno.stat(`${dir}/${toolkitAddonPath(platform!)}`)).isFile) {
      throw new Error("addon");
    }
    if (
      !(await Deno.stat(`${dir}/stdlib/sysml-library.prepared.gz`)).isFile ||
      !(await Deno.stat(`${dir}/buildinfo.json`)).isFile
    ) throw new Error("stdlib");
  } catch {
    fail(
      "TOOLKIT_DIR_INVALID",
      `SYSML_TOOLKIT_DIR does not point to an installed native SysML Toolkit package: ${dir}`,
      recovery,
    );
  }
}
