/** Durable vault of verified bytes for builds whose recipe is gone. */
export interface ModelBuildVaultPort {
  /** Verified bytes, `null` when absent; throws a coded error if corrupt. */
  getVerified(artifactDigest: string): Promise<Uint8Array | null>;
  putVerified(
    artifactDigest: string,
    bytes: Uint8Array,
  ): Promise<{ stored: boolean; bytes: number; digest: string }>;
  has(artifactDigest: string): Promise<boolean>;
}
