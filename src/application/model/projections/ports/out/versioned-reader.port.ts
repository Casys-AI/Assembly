export interface VersionedReader<T> {
  read(version: string): Promise<T>;
}
