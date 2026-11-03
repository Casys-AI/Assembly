/** One durable sequence shared by every operator runtime in a system. */
export interface CaseNumberPort {
  allocate(): Promise<number>;
}
