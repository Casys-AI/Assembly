import type { ModelBoard } from "../../../../../domain/model/records/board.ts";

export interface ModelBoardReader {
  read(version: string): Promise<ModelBoard>;
}
