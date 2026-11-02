export interface SkillInstallation {
  id: string;
  url: string;
  expectedDigest?: string;
}
export interface BundledSkillInstallation {
  id: string;
  content: string;
  source: string;
  expectedDigest: string;
  /** Only a source-admitted initial seed may request atomic initial loading. */
  loaded?: boolean;
}
export interface SkillSelection {
  id: string;
  expectedDigest: string;
}
