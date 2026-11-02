import { equal, rejects } from "node:assert/strict";
import { join } from "node:path";
import {
  requireToolkitPackage,
  ToolkitRequiredError,
} from "../../src/composition/model-backend.ts";

Deno.test("nothing starts without the SysML Toolkit package", async () => {
  const empty = await Deno.makeTempDir();
  try {
    await rejects(
      () => requireToolkitPackage(join(empty, "missing")),
      (error: ToolkitRequiredError) => {
        equal(error.code, "TOOLKIT_REQUIRED");
        equal(error.context.packageDir, join(empty, "missing"));
        equal(error.recovery.includes("model:toolkit:setup"), true);
        return true;
      },
    );
    // A directory without its package.json is not a Toolkit either.
    await rejects(() => requireToolkitPackage(empty), ToolkitRequiredError);
    await Deno.writeTextFile(join(empty, "package.json"), "{}");
    await requireToolkitPackage(empty);
  } finally {
    await Deno.remove(empty, { recursive: true });
  }
});
