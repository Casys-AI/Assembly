import { ModelContextLink } from "../../view/ModelContextLink.tsx";
import type { ModelBoard } from "../../../../src/domain/model/records/board.ts";
import type { Detail } from "../../../lib/system/board/detail.ts";
import {
  type PartNode,
  partsOf,
  type PortLine,
  type UnitParts,
} from "../../../lib/system/views/parts.ts";
import { Empty } from "../../view/Empty.tsx";
import { DetailSlot, DetailUnderTitle } from "../DetailSlot.tsx";
import { PanelGrid, PartHead, Ports } from "./PartPanel.tsx";
import { Why } from "../Why.tsx";

/** Every id the page draws an element for: units, parts at any depth, their ports. */
function idsOf(units: readonly UnitParts[]): Set<string> {
  const ids = new Set<string>();
  const port = (line: PortLine) => ids.add(line.port.id);
  const part = (node: PartNode) => {
    ids.add(node.item.id);
    node.ports.forEach(port);
    node.parts.forEach(part);
  };
  for (const { unit, ports, operators, platform } of units) {
    ids.add(unit.id);
    ports.forEach(port);
    [...operators, ...platform].forEach(part);
  }
  return ids;
}

/**
 * The connections that start inside a unit, as a table of what joins what.
 * The ends are told, not links: a port opens its detail in its own panel
 * above, under the port, and one detail is open at a time, so a link here
 * would open it away from where it was chosen.
 */
function Connections(
  { connections, detail }: {
    connections: UnitParts["connections"];
    detail: Detail;
  },
) {
  if (connections.length === 0) return null;
  // A port is told by the part it belongs to; an end the board does not hold, by its id.
  const end = (id: string) => {
    const element = detail.index.get(id);
    return element
      ? (
        <span title={element.qname ?? undefined} data-end={id}>
          {detail.endpoints([element])[0].name}
        </span>
      )
      : <span class="faint" data-end={id}>{id}</span>;
  };
  return (
    <table class="part-conns">
      <thead>
        <tr>
          <th>Connection</th>
          <th>From</th>
          <th>To</th>
        </tr>
      </thead>
      <tbody>
        {connections.map((connection) => {
          const { class: state } = detail.standing([
            connection.from,
            connection.to,
          ]);
          return (
            <tr key={connection.id} class={state}>
              <td>
                <span class="kind-kw">connect</span>
              </td>
              <td>{end(connection.from)}</td>
              <td>{end(connection.to)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Unit({ parts, detail }: { parts: UnitParts; detail: Detail }) {
  const { unit } = parts;
  const { chosen, why, class: state } = detail.standing([unit.id], "own");
  return (
    <>
      <section class={`part-unit ${state}`}>
        <ModelContextLink
          class="part-link"
          href={detail.toggle([unit.id])}
          aria-current={chosen ? "true" : "false"}
          data-id={unit.id}
          title={unit.qname ?? undefined}
        >
          <PartHead item={unit} detail={detail} />
        </ModelContextLink>
        <Why labels={why} />
        <Ports lines={parts.ports} detail={detail} />
        {parts.operators.length > 0 && (
          <>
            <div class="kind-kw part-kind">Operators</div>
            <PanelGrid nodes={parts.operators} detail={detail} />
          </>
        )}
        {parts.platform.length > 0 && (
          <>
            <div
              class="kind-kw part-kind"
              title="Environments, catalogs and gates the operators rely on"
            >
              Platform
            </div>
            <PanelGrid nodes={parts.platform} detail={detail} platform />
          </>
        )}
        <Connections connections={parts.connections} detail={detail} />
      </section>
      <DetailSlot ids={[unit.id]} detail={detail} />
    </>
  );
}

/**
 * System > Parts: how each unit is built. The operators and the platform they
 * rely on, nested as the model nests them, with the ports of every part
 * (open ones are said so) and what the model connects. Every unit, part and
 * port is a link that opens in place; the detail of a part follows its row.
 */
export function PartsPage(
  { board, detail }: { board: ModelBoard; detail: Detail },
) {
  const units = partsOf(board);
  if (units.length === 0) {
    return <Empty code="no-structure">No system structure yet</Empty>;
  }
  return (
    <div class={`parts${detail.selected ? " has-selection" : ""}`}>
      <DetailUnderTitle detail={detail} carried={idsOf(units)} />
      {units.map((parts) => (
        <Unit key={parts.unit.id} parts={parts} detail={detail} />
      ))}
    </div>
  );
}
