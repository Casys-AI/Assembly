import type { RequestOperatorDetailsObservationPort } from "../../../application/work/request-spaces/operator-details.ts";
import type { RequestExecutionBindingPort } from "../../../application/model/evolution/request-adoption-ports.ts";
import type { OpeningRecord } from "../../../domain/work/request-spaces/opening.ts";
import type { PrismaClient } from "./client.ts";
import { PostgresContextSkillsStore } from "./skill-store.ts";

/** Direct persisted readers only. Constructing a skill handle performs no upsert. */
export class PostgresRequestOperatorDetailsObservations
  implements RequestOperatorDetailsObservationPort {
  constructor(
    private readonly client: PrismaClient,
    private readonly bindings: RequestExecutionBindingPort,
  ) {}
  binding(record: OpeningRecord) {
    return this.bindings.read(record);
  }
  async skills(record: OpeningRecord) {
    const operatorId = record.base!.requestOwner.operatorId;
    const store = new PostgresContextSkillsStore(this.client, {
      ...record.scope,
      executionSpaceId: record.executionSpaceId,
      operatorId,
    });
    try {
      return await store.load(operatorId);
    } finally {
      await store.close();
    }
  }
}
