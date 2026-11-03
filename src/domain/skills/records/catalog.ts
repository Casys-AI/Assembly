import type { BehaviorModelVersion } from "../../shared-kernel/behavior-model-version.ts";
import type { SkillRecord } from "../entities/skill.ts";

export interface SkillOperation {
  kind: "install" | "load" | "unload";
  skillId: string;
  skillDigest: string;
  callerId: string;
  behaviorId: string;
  invocationId: string;
  requestDigest: string;
  policyId: string;
  modelVersion: BehaviorModelVersion;
  at: string;
  revision: number;
  /** Initial source-owned installation may atomically select its instructions. */
  initiallyLoaded?: boolean;
}

/** Persisted owner catalog state; this record is not an encapsulated root. */
export interface SkillCatalogRecord {
  ownerId: string;
  revision: number;
  skills: SkillRecord[];
  operations: SkillOperation[];
}
