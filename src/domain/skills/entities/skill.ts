import type { BehaviorModelVersion } from "../../shared-kernel/behavior-model-version.ts";
import type { ArtifactSourceBindingReference } from "../../work/artifacts/source-reference.ts";

export interface SkillSource {
  kind: "https" | "bundled";
  location: string;
  requestedUrl?: string;
  finalUrl?: string;
  acquiredAt: string;
  modelVersion: BehaviorModelVersion;
}

/** Installed skill entity: its id is local to the owning catalog. */
export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  digest: string;
  byteLength: number;
  content: string;
  source: SkillSource;
  /** Exact retained source and target-local SQL receipt. Historical unbound
   * metadata remains readable, but cannot supply usable instructions. */
  sourceBinding?: ArtifactSourceBindingReference;
  installedAt: string;
  loaded: boolean;
  loadedAt?: string;
  loadedBy?: BehaviorModelVersion;
}

export type SkillMetadata = Omit<SkillRecord, "content">;
export type SkillGuidance = SkillRecord;
