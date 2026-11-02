import type {
  SavedSystemCapture,
  SavedSystemManifest,
  SavedSystemRecord,
  SavedSystemScope,
  SavedSystemSourceEvidence,
  SavedSystemSourceSelection,
} from "../../../domain/work/saved-systems.ts";

/** Source/local-admission facts only. Neither this port nor ownership grants
 * retain-release, open-request or an execution admission. */
export interface RequestReleaseProvenancePort {
  capture(
    selection: SavedSystemSourceSelection,
    scope: SavedSystemScope,
  ): Promise<SavedSystemSourceEvidence>;
  /** Only an existing durable accepted capture may enter recovery. */
  assertAccepted(
    capture: SavedSystemCapture,
    scope: SavedSystemScope,
  ): Promise<void>;
  /** Fresh immutable origin/ancestry and source visibility only. No model or
   * physical asset inspection: callers must independently verify exact bytes. */
  assertOriginRelation(manifest: SavedSystemManifest): Promise<void>;
  /** Retained origin may be closed and its live branch may later advance. */
  assertManifest(manifest: SavedSystemManifest): Promise<void>;
}

export interface ScopedSavedSystemRecord {
  scope: SavedSystemScope;
  record: SavedSystemRecord;
}

/** One bounded projection of existing records. Host scope is constructor-owned;
 * owner is the server-authenticated controller, never a browser field. */
export interface RequestReleaseCataloguePort {
  listOwned(
    ownerId: string,
    caseId?: string,
  ): Promise<ScopedSavedSystemRecord[]>;
  selected(
    ownerId: string,
    id: string,
  ): Promise<ScopedSavedSystemRecord | null>;
}
