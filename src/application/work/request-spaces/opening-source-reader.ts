import type { ModelRepositoryPort } from "../../model/repository.ts";

/** Immutable source reads needed to resolve an opening's retained base. */
export interface RequestOpeningSourceReaderPort
  extends Pick<ModelRepositoryPort, "at"> {
  readonly repositoryId: string;
}

/** Host eligibility reads the admitted Main source independently of a runtime pin. */
export interface RequestOpeningHostSourceReaderPort
  extends RequestOpeningSourceReaderPort {
  admittedMainSource(
    version: string,
  ): Promise<{ headVersion: string; sourceDigest: string }>;
}
