import type {
  SpaceControlAdoptedState,
  SpaceControlAuthority,
  SpaceController,
  SpaceExecutionAdmission,
} from "../../../domain/work/request-spaces.ts";
export interface SpaceControlCredential {
  id: string;
  kind: "capability" | "session";
  ownerId: string;
  parentCapabilityId: string | null;
  authority: SpaceControlAuthority;
  secretHash: string;
  revision: number;
  status: "active" | "revoked";
  expiresAt: string;
  createdAt: string;
}
export interface SpaceCredentialStorePort {
  insert(
    credential: SpaceControlCredential & { kind: "capability" },
    witness: SpaceControlAdoptedState,
  ): Promise<void>;
  insert(
    credential: SpaceControlCredential & { kind: "session" },
  ): Promise<void>;
  findHash(hash: string): Promise<SpaceControlCredential | null>;
  get(id: string): Promise<SpaceControlCredential | null>;
  /** Locks capability before any derived admissions; revocation is monotonic. */
  revokeCapability(
    id: string,
    ownerId: string,
    expectedRevision: number,
  ): Promise<SpaceControlCredential>;
}
export interface SpaceAdmissionStorePort {
  /** Transaction checks capability scope/owner/current revision and locks it
   * before the admission. Returns an existing admission unchanged on retry. */
  admit(
    input: Omit<SpaceExecutionAdmission, "revision" | "status" | "createdAt">,
  ): Promise<SpaceExecutionAdmission>;
  get(id: string): Promise<SpaceExecutionAdmission | null>;
  revoke(
    id: string,
    controller: SpaceController,
  ): Promise<SpaceExecutionAdmission>;
}
export interface SpaceSecretPort {
  randomSecret(): string;
}
