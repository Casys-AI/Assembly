/** Host-resolved authority, re-established by the consultation adapter on every
 * call. A source consultation right alone never supplies an evidence scope. */
export interface NetworkImpactConsultationBinding {
  projectId: string;
  callerId: string;
  contractDigest: string;
  admittedVersion: string;
  consultationVersion: string;
  requestKey: string;
  evidenceScopeId: string;
}

export interface NetworkImpactConsultationResponseBudget {
  maxResponseCharacters?: number;
  /** Include the transport envelope when applying the decision context bound. */
  responseOverheadCharacters?: number;
  signal?: AbortSignal;
}
