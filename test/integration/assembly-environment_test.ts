import { equal } from "node:assert/strict";

const environmentModule = new URL(
  "../../src/infrastructure/environment.ts",
  import.meta.url,
).href;

async function restrictedRead(
  grants: string[],
  values: Record<string, string>,
): Promise<string> {
  const process = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-config",
      "--no-prompt",
      ...(grants.length ? [`--allow-env=${grants.join(",")}`] : []),
      "-",
    ],
    clearEnv: true,
    env: values,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const input = process.stdin.getWriter();
  await input.write(new TextEncoder().encode(
    `import { readAssemblyEnv } from ${JSON.stringify(environmentModule)};\n` +
      'console.log(JSON.stringify(readAssemblyEnv("ASSEMBLY_DEMO_DATA_DIR") ?? null));',
  ));
  await input.close();
  const result = await process.output();
  equal(result.code, 0, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

Deno.test("product environment aliases work with actual legacy-only Deno grants", async () => {
  const values = {
    ASSEMBLY_DEMO_DATA_DIR: "canonical",
    ASE_DEMO_DATA_DIR: "legacy",
  };
  equal(
    await restrictedRead(["ASE_DEMO_DATA_DIR"], values),
    '"legacy"',
  );
  equal(
    await restrictedRead(Object.keys(values), values),
    '"canonical"',
  );
  equal(
    await restrictedRead(Object.keys(values), {
      ...values,
      ASSEMBLY_DEMO_DATA_DIR: "",
    }),
    '""',
  );
  equal(await restrictedRead([], values), "null");
});
