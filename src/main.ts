/** Atelier entry point (`deno task serve`). Thin by design: it reads its
 * configuration, runs the toolkit gate, delegates the assembly to
 * `composition/`, wires the HTTP server, starts the advisory pre-warms after
 * listening, and registers the ordered shutdown. Startup/shutdown order is
 * load-bearing: toolkit gate, listen, advisory pre-warms, ordered `stop()`. */
import {
  requireToolkitPackage,
  toolkitPackageDir,
  ToolkitRequiredError,
} from "./composition/model-backend.ts";
import { assembleAssembly, startAdvisoryPrewarms } from "./composition/root.ts";
import { createOrderedStop } from "./composition/lifecycle.ts";
import { resolveProviderConfiguration } from "./composition/provider-configuration.ts";
import { createHttpServeHandler } from "./adapters/in/http/app.ts";
import { closeSysmlToolkitWorkers } from "./adapters/out/sysml-toolkit/worker-client.ts";
import { publicPostgresFailure } from "./adapters/out/postgres/host-storage.ts";
import {
  readAssemblyEnv,
  resolveAssemblyEnvironment,
  resolveAssemblyHostname,
} from "./infrastructure/environment.ts";
import {
  configureTechnicalLogging,
  errorLogProperties,
  technicalLogger,
} from "./infrastructure/logging.ts";

const compositionLog = technicalLogger("composition");
const schedulerLog = technicalLogger("scheduler");
await configureTechnicalLogging();

const port = Number(Deno.env.get("PORT") ?? "4311");
const environment = resolveAssemblyEnvironment(readAssemblyEnv("ASSEMBLY_ENV"));
const hostname = resolveAssemblyHostname(
  environment,
  readAssemblyEnv("ASSEMBLY_HOST"),
);
const servedOrigin = `http://127.0.0.1:${port}`;
const { provider, agentModel, agentEffort, decisionMaxTokens } =
  resolveProviderConfiguration((key) => Deno.env.get(key));
const dataDir = readAssemblyEnv("ASSEMBLY_DEMO_DATA_DIR") ??
  new URL("../.data/demo/", import.meta.url).pathname;
// Nothing starts without the SysML Toolkit.
await requireToolkitPackage(toolkitPackageDir()).catch((error) => {
  if (!(error instanceof ToolkitRequiredError)) throw error;
  const { code, message, context, recovery } = error;
  compositionLog.error(message, { code, context, recovery });
  Deno.exit(2);
});
const assembly = await assembleAssembly({
  dataDir,
  servedOrigin,
  environment,
  provider,
  agentModel,
  agentEffort,
  decisionMaxTokens,
});
const handleRequest = createHttpServeHandler(assembly);
const server = Deno.serve({ hostname, port }, handleRequest);
startAdvisoryPrewarms(assembly);
const tickCases = () =>
  assembly.operatorWorkspace.tickCases().catch((error) =>
    schedulerLog.error("Case scheduler:", errorLogProperties(error))
  );
const casePoll = setInterval(tickCases, 1_000);
void tickCases();
compositionLog.info(
  `Atelier disponible sur http://127.0.0.1:${port} · ${assembly.agents.label}`,
);
const stop = createOrderedStop({
  assembly,
  server,
  casePoll,
  log: compositionLog,
  closeToolkitWorkers: closeSysmlToolkitWorkers,
});
const stopAndExit = () => {
  void stop().then(() => Deno.exit(0), (error) => {
    compositionLog.error(
      "Shutdown failed",
      errorLogProperties(publicPostgresFailure(error) ?? error),
    );
    Deno.exit(1);
  });
};
Deno.addSignalListener("SIGINT", stopAndExit);
Deno.addSignalListener("SIGTERM", stopAndExit);
