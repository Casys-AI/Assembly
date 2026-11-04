import type { OpeningRecord } from "../../../domain/work/request-spaces.ts";
import type { ScopedSoftwareSourceAdmissionV2 } from "./scoped-software-source-admission.ts";

export interface ScopedSoftwareAdmissionReaderPort {
  /** Reads the admitted source chain in one repeatable-read snapshot. */
  read(opening: OpeningRecord): Promise<{
    readonly softwareReceipts: readonly {
      readonly revision: number;
      readonly manifestDigest: string;
      readonly payload: ScopedSoftwareSourceAdmissionV2;
    }[];
  }>;
}
