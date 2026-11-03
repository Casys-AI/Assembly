import type {
  NetworkImpactEvidenceRead,
  NetworkImpactLimits,
} from "../../../../../domain/model/consultation/network-impact.ts";

export interface NetworkImpactEvidenceReader {
  read(
    input: {
      operatorId: string;
      host: string;
      limits: NetworkImpactLimits;
      signal?: AbortSignal;
    },
  ): Promise<NetworkImpactEvidenceRead>;
}
