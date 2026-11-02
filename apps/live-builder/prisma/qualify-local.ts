import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

/** Explicit opt-in real PostgreSQL qualification. Never runs during imports. */
export async function qualifyLocalPostgres(
  binaryDirectory: string,
  testFiles = ["test/integration/postgres-foundation_test.ts"],
  options: {
    denoConfig?: string;
    allowRun?: string[];
    allowWrite?: string[];
    allowSys?: string[];
  } = {},
): Promise<void> {
  if (Deno.version.deno !== "2.9.7") {
    throw new Error("PostgreSQL qualification requires Deno 2.9.7");
  }
  const binaries = resolve(binaryDirectory);
  const workbench = dirname(dirname(fileURLToPath(import.meta.url)));
  const temporaryBase = Deno.env.get("TMPDIR");
  if (!temporaryBase) {
    throw new Error(
      "Set TMPDIR to a directory on the checkout's volume for PostgreSQL qualification",
    );
  }
  const realTemporaryBase = await Deno.realPath(temporaryBase);
  if (
    (await Deno.stat(realTemporaryBase)).dev !==
      (await Deno.stat(workbench)).dev
  ) {
    throw new Error(
      "PostgreSQL qualification temporary storage must be on the checkout's volume",
    );
  }
  const directory = await Deno.makeTempDir({
    dir: realTemporaryBase,
    prefix: "assembly-pg1-",
  });
  const data = join(directory, "data");
  const log = join(directory, "postgres.log");
  let started = false;
  let success = false;
  const execute = async (binary: string, args: string[]): Promise<void> => {
    const output = await new Deno.Command(join(binaries, binary), {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) {
      await Deno.writeFile(
        join(directory, `${binary}-failure.log`),
        new Uint8Array([...output.stdout, ...output.stderr]),
      );
      throw new Error(
        `Local PostgreSQL ${binary} failed; evidence retained in ${directory}`,
      );
    }
  };
  try {
    const version = await new Deno.Command(join(binaries, "postgres"), {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!version.success) throw new Error("PostgreSQL binary is unavailable");
    console.log(new TextDecoder().decode(version.stdout).trim());
    const reservation = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (reservation.addr as Deno.NetAddr).port;
    reservation.close();
    await execute("initdb", [
      "-D",
      data,
      "--username=assembly_pg1",
      "--auth-local=trust",
      "--auth-host=trust",
      "--no-locale",
      "--encoding=UTF8",
    ]);
    started = true;
    await execute("pg_ctl", [
      "-D",
      data,
      "-l",
      log,
      "-w",
      "-t",
      "20",
      "-o",
      `-h 127.0.0.1 -p ${port} -c unix_socket_directories='' -c shared_buffers=16MB -c max_connections=16 -c work_mem=1MB -c maintenance_work_mem=16MB`,
      "start",
    ]);
    const administrator = new Client({
      connectionString: `postgresql://assembly_pg1@127.0.0.1:${port}/postgres`,
      connectionTimeoutMillis: 5_000,
    });
    try {
      await administrator.connect();
      await administrator.query('CREATE DATABASE "assembly_pg1_test"');
      const settings = await administrator.query(
        "SELECT current_setting('server_version') AS version, current_setting('shared_buffers') AS shared_buffers, current_setting('max_connections') AS max_connections, current_setting('listen_addresses') AS listen_addresses",
      );
      console.log(JSON.stringify({ postgresSettings: settings.rows[0] }));
    } finally {
      await administrator.end();
    }
    const url = `postgresql://assembly_pg1@127.0.0.1:${port}/assembly_pg1_test`;
    // Exercise the documented real migration procedure and its idempotent rerun
    // in this newly created disposable database before isolated-schema fixtures.
    for (let pass = 1; pass <= 2; pass++) {
      const migration = await new Deno.Command("node", {
        cwd: workbench,
        signal: AbortSignal.timeout(60_000),
        args: [
          "node_modules/prisma/build/index.js",
          "migrate",
          "deploy",
          "--config",
          "prisma/prisma.config.ts",
        ],
        env: { ASSEMBLY_DATABASE_DIRECT_URL: url },
        stdout: "inherit",
        stderr: "inherit",
      }).spawn().status;
      if (!migration.success) {
        throw new Error(`PostgreSQL migration deployment pass ${pass} failed`);
      }
    }
    const tests = await new Deno.Command(Deno.execPath(), {
      cwd: workbench,
      signal: AbortSignal.timeout(120_000),
      args: [
        "test",
        ...(options.denoConfig ? ["--config", options.denoConfig] : []),
        "--no-prompt",
        "--frozen",
        "--allow-read",
        "--allow-env",
        "--allow-net=127.0.0.1",
        ...(options.allowRun?.length ? [`--allow-run=${options.allowRun.join(",")}`] : []),
        ...(options.allowWrite?.length ? [`--allow-write=${options.allowWrite.join(",")}`] : []),
        ...(options.allowSys?.length ? [`--allow-sys=${options.allowSys.join(",")}`] : []),
        ...testFiles,
      ],
      env: { ASSEMBLY_POSTGRES_TEST_URL: url },
      stdout: "inherit",
      stderr: "inherit",
    }).spawn().status;
    if (!tests.success) {
      throw new Error(
        `PostgreSQL qualification failed; evidence retained in ${directory}`,
      );
    }
    success = true;
  } finally {
    if (started) {
      const status = await new Deno.Command(join(binaries, "pg_ctl"), {
        args: ["-D", data, "status"],
        stdout: "null",
        stderr: "null",
      }).output();
      if (status.success) {
        await execute("pg_ctl", [
          "-D",
          data,
          "-m",
          "fast",
          "-w",
          "-t",
          "20",
          "stop",
        ]);
      }
    }
    if (success) await Deno.remove(directory, { recursive: true });
    else console.error(`PostgreSQL qualification evidence: ${directory}`);
  }
}

if (import.meta.main) {
  const binaries = Deno.env.get("ASSEMBLY_POSTGRES_BIN_DIR");
  if (!binaries) {
    throw new Error(
      "Set ASSEMBLY_POSTGRES_BIN_DIR to the qualified local PostgreSQL binaries",
    );
  }
  await qualifyLocalPostgres(
    binaries,
    Deno.args.length ? Deno.args : undefined,
  );
}
