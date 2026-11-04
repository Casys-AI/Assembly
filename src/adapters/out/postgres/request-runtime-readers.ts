import type {
  ExecutionSpaceLifecycleReader,
  RequestAdmittedSourceReader,
  WaitingExecutionRunReader,
} from "../../../application/work/request-spaces/runtime-ports.ts";
import type { PrismaClient } from "./client.ts";
import { PostgresRequestSourceAdmissionStore } from "./request-source-admission-store.ts";

export function createRequestRuntimeReaders(client: PrismaClient): {
  admittedSource: RequestAdmittedSourceReader;
  lifecycle: ExecutionSpaceLifecycleReader;
  waitingRuns: WaitingExecutionRunReader;
} {
  return {
    admittedSource: {
      async read(record) {
        const journal = new PostgresRequestSourceAdmissionStore(client);
        const chain = await client.$transaction(
          (tx) => journal.readAdmittedSource(tx, record),
          { isolationLevel: "RepeatableRead" },
        );
        return {
          execution: {
            adoptions: chain.execution.adoptions.map((
              { manifest, receipt },
            ) => ({
              manifest: {
                commandId: manifest.commandId,
                intent: manifest.intent,
                nativeRetirement: {
                  predecessorThreadIds:
                    manifest.nativeRetirement.predecessorThreadIds,
                  successorThreadIds:
                    manifest.nativeRetirement.successorThreadIds,
                },
              },
              receipt,
            })),
          },
        };
      },
    },
    lifecycle: {
      async read(record) {
        const space = await client.executionSpace.findUnique({
          where: {
            projectId_systemId_executionSpaceId: {
              ...record.scope,
              executionSpaceId: record.executionSpaceId,
            },
          },
        });
        return space === null ? null : {
          caseId: space.caseId,
          parentExecutionSpaceId: space.parentExecutionSpaceId,
          lifecycle: space.lifecycle,
          closedAt: space.closedAt,
        };
      },
    },
    waitingRuns: {
      async read(scope, target) {
        const runs = await client.executionRun.findMany({
          where: { ...scope, ...target, status: "waiting" },
        });
        return runs.map(({ snapshotJson }) => ({ snapshotJson }));
      },
    },
  };
}
