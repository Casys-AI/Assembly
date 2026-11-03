import type {
  BoardItem,
  BoardPort,
  ModelBoard,
} from "../../../../src/domain/model/records/board.ts";
import { indexBoard } from "../board/lookup.ts";

/**
 * What System > Parts lays out: each unit of the model with the parts inside
 * it (operators first, then the platform they rely on: environments, catalogs
 * and gates), the ports of every part, and the connections between ports.
 * Pure.
 */

export interface PortLine {
  port: BoardPort;
  /**
   * A connection reaches the port: the board counts one (`linked`), or a
   * `connect` link of the model ends at it. A port nothing reaches is open.
   */
  connected: boolean;
}

/** A part, the ports it declares and the parts nested inside it. */
export interface PartNode {
  item: BoardItem;
  ports: readonly PortLine[];
  parts: readonly PartNode[];
}

/** A `connect` of the model: the ids of the two ports (or parts) it joins. */
export interface Connection {
  id: string;
  from: string;
  to: string;
}

export interface UnitParts {
  unit: BoardItem;
  /** The ports the unit declares itself. */
  ports: readonly PortLine[];
  operators: readonly PartNode[];
  platform: readonly PartNode[];
  /** The connections that start inside the unit. */
  connections: readonly Connection[];
}

export function partsOf(board: ModelBoard): readonly UnitParts[] {
  const index = indexBoard(board);
  const connects = index.linked("connect");
  const reached = new Set(connects.flatMap(({ from, to }) => [from, to]));
  const portsOf = (item: BoardItem): readonly PortLine[] =>
    (item.ports ?? []).map((port) => ({
      port,
      connected: (port.linked ?? 0) > 0 || reached.has(port.id),
    }));
  const nodeOf = (item: BoardItem): PartNode => ({
    item,
    ports: portsOf(item),
    parts: (item.children ?? []).map(nodeOf),
  });
  return index.units.map((unit) => {
    const parts = (unit.children ?? []).map(nodeOf);
    return {
      unit,
      ports: portsOf(unit),
      operators: parts.filter((part) => part.item.kind === "operator"),
      platform: parts.filter((part) => part.item.kind !== "operator"),
      connections: connects
        // It starts where the board holds an end: a connection to or from
        // something it does not hold is still the unit's that holds the other.
        .filter(({ from, to }) =>
          index.within(index.get(from) ? from : to, unit.id)
        )
        .map(({ link, from, to }) => ({ id: link.id, from, to })),
    };
  });
}
