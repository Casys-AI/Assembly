import type { ScopedSoftwareAdmissionReaderPort } from "../../../application/model/source-admission/scoped-software-admission-reader.ts";
import type { OpeningRecord } from "../../../domain/work/request-spaces/opening.ts";
import type { PrismaClient } from "./client.ts";
import type { PostgresRequestSourceAdmissionStore } from "./request-source-admission-store.ts";

export class PostgresScopedSoftwareAdmissionReader
  implements ScopedSoftwareAdmissionReaderPort {
  constructor(
    private readonly client: PrismaClient,
    private readonly journal: PostgresRequestSourceAdmissionStore,
  ) {}

  read(opening: OpeningRecord) {
    return this.client.$transaction(
      (tx) => this.journal.readAdmittedSource(tx, opening),
      { isolationLevel: "RepeatableRead" },
    );
  }
}
