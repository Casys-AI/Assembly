import type {
  BoardItem,
  BoardLoop,
  BoardStep,
} from "../../../../src/domain/model/records/board.ts";
import type { BoardElement, BoardIndex } from "../board/lookup.ts";
import { type StepKind, stepKind } from "../board/words.ts";

/**
 * A flow read as the thread it is: the board lists a flow's steps flat, in
 * the order the Toolkit walks them, each with the `depth` it sits at and, for
 * the first step of a branch, the `branch` it opens (`if`, `else`, `parallel`,
 * `then`) and its `guard`. Here they become a tree: a step that splits the
 * thread (a decision, a fork) owns the branches that start one level deeper,
 * each branch owns the steps of its body, and a step in sequence owns none.
 * The shape is the model's own order; nothing is reordered or dropped. Pure.
 */

/** One branch of a step that splits the thread. */
export interface FlowBranch {
  /** What opens the branch: `if`, `else`, `parallel`, `then`. */
  label: string;
  /** The guard the branch is taken on, as the model writes it. */
  guard?: string;
  body: readonly FlowNode[];
}

/** A step of the flow, a jump out of it, a merge or its end, where it stands. */
export interface FlowNode {
  /** The board's id of the step: what an address selects. */
  id: string;
  step: BoardStep;
  /** The step's kind; none for a kind the pages do not know (drawn as a plain step). */
  kind: StepKind | undefined;
  /**
   * What performs it, by allocation, among the elements of the unit the flow is
   * declared for; an allocation the board cannot resolve is left out.
   */
  performers: readonly BoardElement[];
  /** The steps it loops back to. */
  loops: readonly BoardLoop[];
  /** The thread splits here, one branch after the other; none for a step in sequence. */
  branches: readonly FlowBranch[];
}

/** The depth a step sits at; a board that does not say puts it at the thread. */
const depthOf = (step: BoardStep): number =>
  Math.max(0, Math.trunc(step.depth ?? 0));

/**
 * Who performs a step. A link allocates a step by its own id, whoever the
 * performer is (another unit's operator, a machine no unit claims: the model
 * says so), or by the Toolkit's id of the element it declares, which a flow
 * declared in several units shares among its twins. Through that shared id
 * the performers are those the flow's own unit holds, so a twin never borrows
 * another unit's operator. A flow without a unit keeps every performer.
 */
function performersFor(
  index: BoardIndex,
  unit: string | undefined,
): (step: BoardStep) => readonly BoardElement[] {
  const byStep = new Map<string, BoardElement[]>();
  const byElement = new Map<string, BoardElement[]>();
  const put = (
    held: Map<string, BoardElement[]>,
    key: string,
    performer: BoardElement,
  ) => {
    const list = held.get(key) ?? [];
    held.set(key, list);
    if (!list.includes(performer)) list.push(performer);
  };
  for (const { link, from, to } of index.linked("allocate")) {
    const performer = index.get(to);
    if (!performer) continue;
    if (link.from === from) {
      // The link names the step itself.
      put(byStep, from, performer);
      continue;
    }
    // It names the element the step declares (`from` is the first twin's step).
    const key = index.get(from)?.element;
    if (
      key !== undefined && (unit === undefined || index.unitOf(to) === unit)
    ) {
      put(byElement, key, performer);
    }
  }
  return (step) => {
    const found = new Map<string, BoardElement>();
    const named = [
      ...byStep.get(step.id) ?? [],
      ...(step.element === undefined ? [] : byElement.get(step.element) ?? []),
    ];
    for (const performer of named) found.set(performer.id, performer);
    return [...found.values()];
  };
}

/**
 * The tree of a flow's steps. A step opens branches when the steps right after
 * it sit one level deeper and each start with a branch mark; the branch ends
 * where a step sits shallower, or where another branch of the same split
 * starts at its own depth. A step deeper than where it is met, with no split
 * to own it, is kept in the sequence rather than lost. The library's start is
 * not a step: the thread draws its own.
 */
export function flowTreeOf(
  index: BoardIndex,
  flow: Pick<BoardItem, "steps" | "scope">,
): readonly FlowNode[] {
  const steps = flow.steps ?? [];
  const performers = performersFor(index, flow.scope);

  const parse = (from: number, depth: number) => {
    const nodes: FlowNode[] = [];
    let at = from;
    while (at < steps.length) {
      const step = steps[at];
      const here = depthOf(step);
      if (here < depth) break;
      // Another branch of the split this body is in.
      if (
        nodes.length > 0 && depth > 0 && here === depth &&
        step.branch !== undefined
      ) break;
      at++;
      const branches: FlowBranch[] = [];
      while (
        at < steps.length && depthOf(steps[at]) === depth + 1 &&
        steps[at].branch !== undefined
      ) {
        const first = steps[at];
        const body = parse(at, depth + 1);
        branches.push({
          label: first.branch!,
          ...(first.guard !== undefined ? { guard: first.guard } : {}),
          body: body.nodes,
        });
        at = body.next;
      }
      const kind = stepKind(step);
      if (kind === "start") continue;
      nodes.push({
        id: step.id,
        step,
        kind,
        performers: performers(step),
        loops: step.loops ?? [],
        branches,
      });
    }
    return { nodes, next: at };
  };
  return parse(0, 0).nodes;
}

/**
 * Whether a person can choose the node: a step, a decision or a merge can. A
 * jump only says where the thread goes and the end only ends it; neither is
 * an element of the model worth opening.
 */
export const choosable = (node: FlowNode): boolean =>
  node.kind !== "goto" && node.kind !== "end" && node.kind !== "done";

/** Every node of the tree, branches included, in the order the thread is read. */
export function flattened(nodes: readonly FlowNode[]): readonly FlowNode[] {
  return nodes.flatMap((node) => [
    node,
    ...node.branches.flatMap((branch) => flattened(branch.body)),
  ]);
}
