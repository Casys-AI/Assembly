import { ModelContextLink } from "../../view/ModelContextLink.tsx";
import type { BoardItem } from "../../../../src/domain/model/records/board.ts";
import type { Detail } from "../../../lib/system/board/detail.ts";
import { ownSummary } from "../../../lib/system/board/words.ts";
import type { PartNode, PortLine } from "../../../lib/system/views/parts.ts";
import { DetailSlot } from "../DetailSlot.tsx";
import { KindMark } from "../KindMark.tsx";
import { Why } from "../Why.tsx";

/** What a port carries, one arrow per item: `← candidate : CandidateIdentity`. */
const carried = (line: PortLine) =>
  line.port.items
    .map((item) =>
      `${item.dir === "in" ? "←" : "→"} ${item.title}${
        item.type ? ` : ${item.type}` : ""
      }`
    )
    .join(" · ");

/**
 * One port of a part: a square (hollow when the port is conjugated), its name
 * and type, what it carries, and "not connected" when nothing reaches it. It is
 * a link: its detail opens right under it.
 */
function Port({ line, detail }: { line: PortLine; detail: Detail }) {
  const { port, connected } = line;
  const { chosen, why, class: state } = detail.standing([port.id], "own");
  const items = carried(line);
  return (
    <>
      <ModelContextLink
        class={`port ${state}${port.conjugated ? " is-conjugated" : ""}${
          connected ? "" : " is-open"
        }`}
        href={detail.toggle([port.id])}
        aria-current={chosen ? "true" : "false"}
        data-id={port.id}
        title={port.qname}
      >
        <span class="port-sq" aria-hidden="true" />
        <span class="port-name">
          {detail.sysml && <span class="kind-kw">{port.keyword}</span>}
          {port.title}
          {port.type && (
            <span class="port-ty">
              {` : ${port.conjugated ? "~" : ""}${port.type.title}`}
            </span>
          )}
        </span>
        {(items || !connected) && (
          <span class="port-flow">
            {items}
            {!connected && (
              <span class="port-warn">
                {items ? " · not connected" : "not connected"}
              </span>
            )}
          </span>
        )}
        <Why labels={why} />
      </ModelContextLink>
      <DetailSlot ids={[port.id]} detail={detail} />
    </>
  );
}

/** The ports of a part, or of a unit: nothing when it has none. */
export function Ports(
  { lines, detail }: { lines: readonly PortLine[]; detail: Detail },
) {
  if (lines.length === 0) return null;
  return (
    <div class="ports">
      {lines.map((line) => (
        <Port key={line.port.id} line={line} detail={detail} />
      ))}
    </div>
  );
}

/** What names a part: its kind, its name and its type. */
export function PartHead(
  { item, detail }: { item: BoardItem; detail: Detail },
) {
  const summary = ownSummary(item);
  return (
    <>
      <span class="part-head">
        <KindMark element={item} sysml={detail.sysml} />
        <span class="part-t">{detail.nameOf(item.id)}</span>
        {item.type && <span class="part-ty">: {item.type.title}</span>}
      </span>
      {summary && <span class="part-sum">{summary}</span>}
    </>
  );
}

/**
 * A part: its head (a link that opens it), its ports, and the parts nested
 * inside it.
 */
function Panel({ node, detail }: { node: PartNode; detail: Detail }) {
  const { item } = node;
  const { chosen, why, class: state } = detail.standing([item.id], "own");
  return (
    <section class={`panel ${state}`}>
      <ModelContextLink
        class="part-link"
        href={detail.toggle([item.id])}
        aria-current={chosen ? "true" : "false"}
        data-id={item.id}
        title={item.qname ?? undefined}
      >
        <PartHead item={item} detail={detail} />
      </ModelContextLink>
      <Why labels={why} />
      <Ports lines={node.ports} detail={detail} />
      {node.parts.length > 0 && (
        <PanelGrid nodes={node.parts} detail={detail} nested />
      )}
    </section>
  );
}

/**
 * A row of parts side by side. The detail of one of them follows the whole
 * row, not the part: it is as wide as the row, and the row of its neighbours
 * stays whole.
 */
export function PanelGrid(
  { nodes, detail, nested, platform }: {
    nodes: readonly PartNode[];
    detail: Detail;
    nested?: boolean;
    platform?: boolean;
  },
) {
  return (
    <>
      <div
        class={`panels${nested ? " is-nested" : ""}${
          platform ? " is-platform" : ""
        }`}
      >
        {nodes.map((node) => (
          <Panel key={node.item.id} node={node} detail={detail} />
        ))}
      </div>
      <DetailSlot ids={nodes.map((node) => node.item.id)} detail={detail} />
    </>
  );
}
