import { equal, throws } from "node:assert/strict";
import {
  readAssemblyEnv,
  resolveAssemblyEnvironment,
  resolveAssemblyHostname,
} from "./environment.ts";

Deno.test("Assembly defaults to production and development binds only 127.0.0.1", () => {
  equal(resolveAssemblyEnvironment(undefined), "production");
  equal(resolveAssemblyEnvironment("production"), "production");
  equal(resolveAssemblyEnvironment("development"), "development");
  throws(() => resolveAssemblyEnvironment("dev"));
  throws(() => resolveAssemblyEnvironment(""));
  equal(resolveAssemblyHostname("development"), "127.0.0.1");
  equal(resolveAssemblyHostname("development", "127.0.0.1"), "127.0.0.1");
  throws(() => resolveAssemblyHostname("development", "0.0.0.0"));
  throws(() => resolveAssemblyHostname("development", "localhost"));
  equal(resolveAssemblyHostname("production", "0.0.0.0"), "127.0.0.1");
});

Deno.test("Assembly environment uses canonical defined values before legacy aliases", () => {
  const values: Record<string, string> = {
    ASSEMBLY_MODEL_PROJECT_DIR: "canonical",
    ASE_MODEL_PROJECT_DIR: "legacy",
  };
  const read = (key: string) => values[key];
  equal(readAssemblyEnv("ASSEMBLY_MODEL_PROJECT_DIR", read), "canonical");
  values.ASSEMBLY_MODEL_PROJECT_DIR = "";
  equal(readAssemblyEnv("ASSEMBLY_MODEL_PROJECT_DIR", read), "");
  delete values.ASSEMBLY_MODEL_PROJECT_DIR;
  equal(readAssemblyEnv("ASSEMBLY_MODEL_PROJECT_DIR", read), "legacy");
  delete values.ASE_MODEL_PROJECT_DIR;
  equal(readAssemblyEnv("ASSEMBLY_MODEL_PROJECT_DIR", read), undefined);
});

Deno.test("Assembly environment permits a legacy-only environment grant", () => {
  equal(
    readAssemblyEnv("ASSEMBLY_RUST_BIN_DIR", (key) => {
      if (key.startsWith("ASSEMBLY_")) throw new Deno.errors.NotCapable();
      return "legacy-toolchain";
    }),
    "legacy-toolchain",
  );
  equal(
    readAssemblyEnv("ASSEMBLY_RUST_BIN_DIR", () => {
      throw new Deno.errors.PermissionDenied();
    }),
    undefined,
  );
});

Deno.test("Assembly environment does not mask unrelated read failures", () => {
  throws(
    () =>
      readAssemblyEnv("ASSEMBLY_RUST_BIN_DIR", () => {
        throw new Error("unexpected failure");
      }),
    /unexpected failure/,
  );
});
