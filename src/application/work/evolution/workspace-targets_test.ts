import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
  createWorkspaceEvolutionTargets,
  finalizeWorkspaceEvolution,
  type WorkspaceEvolutionPorts,
} from "./workspace-targets.ts";
import {
  type EvolutionDossier,
  EvolutionError,
} from "../../model/evolution/ports.ts";
import type { SystemRuntime } from "../runtime/system.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import type { WorkspaceRuntime } from "../operators/workspace-registry.ts";

function fixture() {
  const events: string[] = [];
  const runtimes = new Map<string, WorkspaceRuntime>();
  for (const id of ["z", "a"]) {
    const reserve = async <T>(kind: string, operation: () => Promise<T>) => {
      events.push(`${kind}:${id}`);
      try {
        return await operation();
      } finally {
        events.push(`release:${id}`);
      }
    };
    const runtime = {
      snapshot: {
        executionModel: { identity: { builderId: id } },
      } as SystemRuntimeState,
      withEvolutionArming: <T>(operation: () => Promise<T>) =>
        reserve("arming", operation),
      withEvolutionReservation: <T>(_id: string, operation: () => Promise<T>) =>
        reserve("reserved", operation),
      evolutionBoundary: () => Promise.resolve({ safe: true, blockers: [] }),
      idle: () => {
        events.push(`idle:${id}`);
        return Promise.resolve();
      },
    } as unknown as SystemRuntime;
    runtimes.set(id, { runtime, scope: id } as WorkspaceRuntime);
  }
  const dossier = {
    id: "evolution",
    proposal: { targets: [{ operatorId: "z" }, { operatorId: "a" }] },
  } as EvolutionDossier;
  const unused = () => {
    throw new Error("Unused port");
  };
  let ports: WorkspaceEvolutionPorts | undefined;
  const service = createWorkspaceEvolutionTargets({
    runtimes,
    primaryId: "a",
    projectId: "project",
    repository: { at: unused },
    compilation: { compile: unused },
    clock: { now: () => "2026-11-04T00:00:00Z" },
    memoryRecords: unused,
    evolutionPorts: () => ports,
    withAdmission: async (operation) => {
      events.push("admission");
      try {
        return await operation();
      } finally {
        events.push("admission-release");
      }
    },
    manifest: unused,
    reconcileRegistry: () => {
      events.push("reconcile-registry");
      return Promise.resolve();
    },
  });
  return {
    service,
    dossier,
    events,
    runtimes,
    setPorts: (value: WorkspaceEvolutionPorts) => {
      ports = value;
    },
  };
}

Deno.test("workspace arming nests lexical targets without conversation admission", async () => {
  const f = fixture();
  const result = await f.service.targets.withArmingTargets(f.dossier, () => {
    f.events.push("armed");
    return Promise.resolve(42);
  });
  equal(result, 42);
  deepStrictEqual(f.events, [
    "arming:a",
    "arming:z",
    "armed",
    "release:z",
    "release:a",
  ]);
});

Deno.test("workspace adoption reconciles registry before releasing lexical runtime and conversation reservations", async () => {
  const f = fixture();
  const result = await f.service.targets.withReservedTargets(
    f.dossier,
    (checkpoint) => {
      equal(checkpoint.safe, true);
      f.events.push("adopt");
      return Promise.resolve(42);
    },
  );
  equal(result, 42);
  deepStrictEqual(f.events, [
    "admission",
    "reserved:a",
    "reserved:z",
    "adopt",
    "reconcile-registry",
    "release:z",
    "release:a",
    "admission-release",
  ]);
});

Deno.test("workspace busy reservation returns the existing unsafe checkpoint", async () => {
  const f = fixture();
  f.runtimes.get("a")!.runtime.withEvolutionReservation = () => {
    throw new EvolutionError("EVOLUTION_RUNTIME_BUSY", "busy");
  };
  await f.service.targets.withReservedTargets(f.dossier, (checkpoint) => {
    equal(checkpoint.safe, false);
    equal(checkpoint.blockers[0].code, "EVOLUTION_RUNTIME_BUSY");
    return Promise.resolve();
  });
  deepStrictEqual(f.events, ["admission", "admission-release"]);
});

Deno.test("workspace adoption reads late evolution ports before checking the durable barrier", async () => {
  const f = fixture();
  const target = f.dossier.proposal.targets[0];
  await rejects(
    f.service.targets.adoptExact(f.dossier, target, { version: "v" } as never),
    { code: "EVOLUTION_TARGET_MISSING" },
  );
  f.setPorts(
    {
      store: { targetOwner: () => Promise.resolve("another-dossier") },
    } as unknown as WorkspaceEvolutionPorts,
  );
  await rejects(
    f.service.targets.adoptExact(f.dossier, target, { version: "v" } as never),
    { code: "EVOLUTION_BARRIER_LOST" },
  );
});

Deno.test("workspace finalizer selects armed dossiers and waits for each target before finalizing", async () => {
  const f = fixture();
  const statuses = [
    "prepared",
    "accepted",
    "armed",
    "publishing",
    "published-awaiting-adoption",
  ];
  await finalizeWorkspaceEvolution({
    runtimes: f.runtimes,
    ports: {
      repositoryId: "repository",
      store: {
        listPending: () =>
          Promise.resolve(
            statuses.map((status) => ({ ...f.dossier, id: status, status })),
          ),
      },
    } as unknown as WorkspaceEvolutionPorts,
    service: {
      finalize: (id) => {
        f.events.push(`finalize:${id}`);
        return Promise.resolve(f.dossier);
      },
    },
  });
  deepStrictEqual(f.events, [
    "idle:z",
    "idle:a",
    "finalize:armed",
    "idle:z",
    "idle:a",
    "finalize:publishing",
    "idle:z",
    "idle:a",
    "finalize:published-awaiting-adoption",
  ]);
});
