/** Post-publication notification boundary: head invalidation, advisory
 * announcement and background refresh stay outside the notification
 * scheduler. */
export interface ModelRevisionNotificationPorts {
  invalidateHead(): void;
  announce(): Promise<void>;
  refresh(version: string): Promise<void>;
  onError(stage: "announce" | "refresh", error: unknown): void;
}
