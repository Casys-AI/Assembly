import { join } from "node:path";

/** Private host identity; distinct from a native conversation/operator identity. */
export async function resolveHostSystemId(
  directory: string,
  configured?: string,
): Promise<string> {
  const valid = (value: unknown): value is string =>
    typeof value === "string" &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
  if (configured !== undefined) {
    if (!valid(configured)) {
      throw new Error("Invalid Assembly host system identity");
    }
    return configured;
  }
  const path = join(directory, "host-system.json");
  const read = async () => {
    const value = JSON.parse(await Deno.readTextFile(path));
    if (value?.format !== 1 || !valid(value.systemId)) {
      throw new Error("Invalid Assembly host system identity file");
    }
    return value.systemId as string;
  };
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const systemId = crypto.randomUUID();
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({ format: 1, systemId }) + "\n",
      {
        createNew: true,
        mode: 0o600,
      },
    );
    return systemId;
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    return await read();
  }
}

/** A persistence locator, never admission authority. Reopen the admitted owner's
 * state before consulting a possibly newer source HEAD. */
export async function resolveHostPrimaryOperator(options: {
  directory: string;
  projectId: string;
  systemId: string;
  hasPersistedRuntimes(): Promise<boolean>;
  initialize(): Promise<string>;
}): Promise<string> {
  const path = join(options.directory, "main-runtime-owner.json");
  const read = async () => {
    const value = JSON.parse(await Deno.readTextFile(path));
    if (
      value?.format !== 1 || value.projectId !== options.projectId ||
      value.systemId !== options.systemId ||
      typeof value.operatorId !== "string" ||
      !value.operatorId.trim() || value.operatorId.includes("\0")
    ) {
      throw new Error(
        "The persisted main runtime owner does not match this host system",
      );
    }
    return value.operatorId as string;
  };
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (await options.hasPersistedRuntimes()) {
    throw new Error(
      "The main runtime owner locator is missing; restore the host files before reopening persisted state",
    );
  }
  const operatorId = await options.initialize();
  if (
    typeof operatorId !== "string" || !operatorId.trim() ||
    operatorId.includes("\0")
  ) {
    throw new Error("Invalid initial main runtime owner");
  }
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        format: 1,
        projectId: options.projectId,
        systemId: options.systemId,
        operatorId,
      }) + "\n",
      { createNew: true, mode: 0o600 },
    );
    return operatorId;
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    return await read();
  }
}
