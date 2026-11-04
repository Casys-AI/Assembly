import {
  ModelRepositoryError,
  type ModelRepositoryPort,
} from "../repository.ts";

export const BOARD_HEAD_CACHE_MS = 1_000;

interface ModelBoardHeadReader {
  (): Promise<string>;
  /** Called after a completed source transition, before notifying clients. */
  invalidate(): void;
}

/** Share a lightweight head read, including startup prewarming. Retain a
 * resolved head for one second unless publication invalidates it. */
export function createModelBoardHeadReader(
  repository:
    & Pick<ModelRepositoryPort, "current">
    & Partial<Pick<ModelRepositoryPort, "headVersion">>,
  now: () => number = () => performance.now(),
): ModelBoardHeadReader {
  let pending: Promise<string> | undefined;
  let cached: { version: string; expiresAt: number } | undefined;
  let epoch = 0;
  const read = () => {
    if (pending) return pending;
    if (cached && now() < cached.expiresAt) {
      return Promise.resolve(cached.version);
    }
    const startedEpoch = epoch;
    const request = Promise.resolve().then(async () => {
      if (repository.headVersion) {
        const version = await repository.headVersion();
        if (!version) {
          throw new ModelRepositoryError("NOT_FOUND", "No admitted model head");
        }
        return version;
      }
      return (await repository.current()).version;
    }).then(
      (version) => {
        if (epoch === startedEpoch) {
          cached = { version, expiresAt: now() + BOARD_HEAD_CACHE_MS };
        }
        return version;
      },
    ).finally(() => {
      if (pending === request) pending = undefined;
    });
    pending = request;
    return pending;
  };
  return Object.assign(read, {
    invalidate() {
      epoch++;
      cached = undefined;
      pending = undefined;
    },
  });
}
