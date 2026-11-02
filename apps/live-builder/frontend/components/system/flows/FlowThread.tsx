import { ModelContextLink } from "../../view/ModelContextLink.tsx";
import type { BoardElement } from "../../../lib/system/board/lookup.ts";
import type { Detail } from "../../../lib/system/board/detail.ts";
import {
  choosable,
  type FlowBranch,
  type FlowNode,
} from "../../../lib/system/views/flow-tree.ts";
import { DetailSlot } from "../DetailSlot.tsx";
import { Why } from "../Why.tsx";

/**
 * Who performs a step. An operator is the unit it works in, as the team calls
 * it (SysML's words give the operator's own identifier); anything else is what
 * it is called. A filled dot is an operator, a ring a part of the platform.
 */
function Who(
  { performer, detail }: { performer: BoardElement; detail: Detail },
) {
  const operator = performer.kind === "operator";
  const unit = operator ? detail.index.unitOf(performer.id) : null;
  const name = operator && unit && !detail.sysml
    ? detail.nameOf(unit)
    : detail.nameOf(performer.id);
  return (
    <span
      class={`who${operator ? "" : " is-platform"}`}
      title={performer.qname ?? undefined}
      data-performer={performer.id}
    >
      <i />
      {name}
    </span>
  );
}

/** The steps a step loops back to, one line each. */
function Loops({ node, detail }: { node: FlowNode; detail: Detail }) {
  return (
    <>
      {node.loops.map((loop) => (
        <span key={loop.to} class="vloop">
          ↺ back to {detail.said(loop.toTitle)}
        </span>
      ))}
    </>
  );
}

/** The branches a step splits the thread into, side by side. */
function Branches(
  { branches, detail }: {
    branches: readonly FlowBranch[];
    detail: Detail;
  },
) {
  if (branches.length === 0) return null;
  return (
    <div class="vbranches">
      {branches.map((branch, at) => (
        <div key={at} class="vbranch" data-branch={branch.label}>
          <span class="vlabel" title={branch.guard ?? branch.label}>
            {detail.sysml && branch.guard
              ? `${branch.label} ${branch.guard}`
              : branch.label}
          </span>
          <Thread nodes={branch.body} detail={detail} />
        </div>
      ))}
    </div>
  );
}

/** What a step is drawn as: the card of a step, the diamond of a decision, the name of a merge. */
function Mark(
  { node, detail }: { node: FlowNode; detail: Detail },
) {
  const { step } = node;
  const { chosen, why, class: state } = detail.standing([node.id]);
  // The name the step's own detail goes by.
  const name = detail.nameOf(node.id);
  const lost = step.unreachable ? " is-unreachable" : "";
  const link = {
    href: detail.toggle([node.id]),
    "aria-current": chosen ? "true" : "false",
  } as const;
  const note = step.unreachable
    ? "no path from the start reaches it"
    : undefined;
  if (node.kind === "decision") {
    return (
      <ModelContextLink
        class={`vpick ${state}${lost}`}
        {...link}
        aria-label={name}
        title={note ?? name}
      >
        <span class="vdiamond" />
      </ModelContextLink>
    );
  }
  if (node.kind === "merge") {
    return (
      <ModelContextLink
        class={`vname ${state}${lost}`}
        {...link}
        title={note ?? name}
      >
        {detail.sysml && <span class="kind-kw">{step.keyword}</span>}
        {name}
        <Why labels={why} />
      </ModelContextLink>
    );
  }
  return (
    <ModelContextLink
      class={`vcard ${state}${lost}`}
      {...link}
      title={note ?? (detail.sysml ? undefined : step.type?.title)}
    >
      {detail.sysml && step.keyword && (
        <span class="kind-kw">{step.keyword}</span>
      )}
      <b>
        {name}
        {detail.sysml && step.type && (
          <span class="vty">: {step.type.title}</span>
        )}
      </b>
      {node.performers.length > 0 && (
        <span class="vwho">
          {node.performers.map((performer) => (
            <Who key={performer.id} performer={performer} detail={detail} />
          ))}
        </span>
      )}
      <Why labels={why} />
    </ModelContextLink>
  );
}

/**
 * One step of the thread. A step, a decision and a merge are links: choosing
 * one opens its detail right under it. A jump and the end are marks of the
 * thread and are not chosen. A step that splits the thread draws its branches
 * after itself, whatever it is.
 */
function Step({ node, detail }: { node: FlowNode; detail: Detail }) {
  if (node.kind === "goto") {
    return (
      <li class="vgoto" data-step={node.id}>
        → {detail.said(node.step.toTitle ?? node.step.title ?? "")}
      </li>
    );
  }
  if (!choosable(node)) {
    return <li class="vend" title="done" data-step={node.id} />;
  }
  return (
    <li
      class={node.kind === "decision"
        ? "vdecision"
        : node.kind === "merge"
        ? "vmerge"
        : "vstep"}
      data-step={node.id}
    >
      <Mark node={node} detail={detail} />
      <Loops node={node} detail={detail} />
      <DetailSlot ids={[node.id]} detail={detail} />
      <Branches branches={node.branches} detail={detail} />
    </li>
  );
}

/** A run of steps, one after the other. */
function Thread(
  { nodes, detail }: { nodes: readonly FlowNode[]; detail: Detail },
) {
  return (
    <ol class="vflow">
      {nodes.map((node) => <Step key={node.id} node={node} detail={detail} />)}
    </ol>
  );
}

/**
 * A flow as a thread of page elements, not a diagram: a start, the steps as
 * cards one after the other, a decision as a diamond that splits the thread
 * into branches side by side (each says `if`, `else`, ... and keeps its guard
 * for the tooltip), a jump that says where it goes, a loop that says where it
 * returns, the end. It is the model's own order. A thread wider than the page
 * scrolls sideways inside its own box.
 */
export function FlowThread(
  { nodes, detail }: { nodes: readonly FlowNode[]; detail: Detail },
) {
  return (
    <ol class="vflow is-root" aria-label="Flow">
      <li class="vstart" aria-hidden="true" />
      {nodes.map((node) => <Step key={node.id} node={node} detail={detail} />)}
    </ol>
  );
}
