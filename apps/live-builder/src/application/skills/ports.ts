import type { ClockPort } from "../work/runtime/ports.ts";
import type {
  SkillAuthority,
  SkillPermission,
  SkillPolicy,
} from "../../domain/skills/context-skills.ts";
import type { ArtifactSourceServicePort } from "../work/artifacts/publication.ts";
import type {
  SkillCatalogRecord,
} from "../../domain/skills/records/catalog.ts";

export interface SkillStorePort {
  load(ownerId: string): Promise<SkillCatalogRecord | null>;
  /** The complete owner catalog is one CAS, including loaded limits and the
   * invocation ledger. null creates a catalog only. */
  save(
    record: SkillCatalogRecord,
    expectedRevision: number | null,
  ): Promise<void>;
}
export interface SkillDownload {
  content: string;
  requestedUrl: string;
  finalUrl: string;
  byteLength: number;
}
export interface SkillDownloadPort {
  download(url: string, policy: SkillPolicy): Promise<SkillDownload>;
}
export interface ContextSkillsPorts extends ClockPort {
  store: SkillStorePort;
  download: SkillDownloadPort;
  /** Host-resolved owner scope; never reuse the primary operator's binding scope
   * for another owner or infer authority from a retained source reference. */
  artifactSources(
    ownerId: string,
  ): Promise<Pick<ArtifactSourceServicePort, "publishSkill" | "resolveSkill">>;
  assertCurrentAuthority(
    authority: SkillAuthority,
    permission: SkillPermission,
  ): Promise<void>;
}
