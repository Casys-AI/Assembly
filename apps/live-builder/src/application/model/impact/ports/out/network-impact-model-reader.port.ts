import type { NetworkImpactFrame } from "../../../../../domain/model/consultation/network-impact.ts";

export interface NetworkImpactModelReader {
  read(
    version: string,
    operatorId: string,
    host: string,
    signal?: AbortSignal,
  ): Promise<NetworkImpactFrame>;
}
