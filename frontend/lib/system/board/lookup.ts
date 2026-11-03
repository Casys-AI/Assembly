import type {
  BoardClause,
  BoardColumnId,
  BoardItem,
  BoardLink,
  BoardPort,
  BoardRef,
  BoardStep,
  BoardTrackState,
  BoardValueEntry,
  ModelBoard,
} from "../../../../src/domain/model/records/board.ts";

/**
 * The board read by the id of one element: what the System pages need to open
 * an element in place, light what it is related to, and send a person to the
 * page that shows it. Pure: the same board always gives the same index, and it
 * is built once per board.
 *
 * The board holds its elements at several depths (items, the parts and ports
 * inside them, the steps of a flow, the clauses of a requirement, the states
 * of a lifecycle) and links them by id. Here they are one registry, with the
 * chain of parents that says which element is inside which.
 */

/**
 * The page that shows an element as its subject, by the name the model gives
 * the concept: the page itself is chosen where the pages are (desk.ts), since
 * some do not exist yet.
 */
export type ElementHome =
  | "team"
  | "structure"
  | "behavior"
  | "requirements"
  | "explore";

/** What the pages read of any element, whatever depth the board holds it at. */
export interface BoardElement {
  /** The id the board's links and the address use. */
  id: string;
  /** The id the Toolkit gives the element: a port's is not its board id. */
  element?: string;
  /** The item's kind, or `port`, `clause`, `state`, or the kind of a step. */
  kind: string;
  keyword: string;
  title: string;
  qname?: string | null;
  file?: string;
  line?: number;
  type?: BoardRef;
  summary?: string;
  summarySource?: string;
  values?: readonly BoardValueEntry[];
  /** The guard of a step. */
  guard?: string;
  /** The expression of a requirement or of one of its clauses. */
  expression?: string | null;
  home: ElementHome;
  column: BoardColumnId;
  /** The element this one is inside, when the board nests it. */
  parent?: string;
  /** The unit an item of a column other than the team's is declared for. */
  scope?: string;
}

/** How an element is related to another, said from the element's side. */
export interface Relation {
  link: BoardLink;
  /** The element at the other end: its id, resolved when the board knows it. */
  other: string;
  /** From `meta.linkLabels`, in the direction of the link; the link's key otherwise. */
  label: string;
}

/** The relations of an element that share a label, and who they lead to. */
export interface RelationGroup {
  label: string;
  others: readonly BoardElement[];
}

/**
 * What a selection lights on a page: the elements related to it (and why), and
 * the ones around it (what contains it, what it contains).
 */
export interface Lens {
  selected: string;
  /** The labels of the relations that lead from the selection to `id`; none when unrelated. */
  labels(id: string): readonly string[];
  /**
   * `labels`, for the relations that end at `id` itself: not those that end at
   * something inside it, nor at something that holds it.
   */
  own(id: string): readonly string[];
  /** `id` contains the selection or is contained by it. */
  context(id: string): boolean;
}

/** One link of the board, its two ends read as the elements the board holds. */
export interface Linked {
  link: BoardLink;
  /** The element at the `from` end: its id, or the link's own text when the board does not hold it. */
  from: string;
  to: string;
}

export interface BoardIndex {
  /** The units of the system: the items of the team column, in the board's order. */
  units: readonly BoardItem[];
  get(id: string): BoardElement | undefined;
  /**
   * The id of the element a name designates: its board id, the id the Toolkit
   * gives it, or the card that holds it (`board.index`). None when the board
   * does not hold it.
   */
  resolve(id: string): string | null;
  /** `id` is `root` or is inside it. */
  within(id: string, root: string): boolean;
  /**
   * The unit an element belongs to: the unit it is inside or, for what a unit
   * declares outside its structure (a tool, a rule, a flow and its steps), the
   * unit it is declared for. None when the board does not say.
   */
  unitOf(id: string): string | null;
  /** The flow that holds a step; none for anything that is not a step of a flow. */
  flowOf(id: string): string | null;
  /** The links of a kind, in the board's order, each with its ends resolved. */
  linked(kind: BoardLink["kind"]): readonly Linked[];
  /**
   * The relations of an element, or of what it contains. The links of strength
   * `scope` (every element of a unit points to the unit) and ownership links
   * say nothing a person asked for and are left out. A link whose two ends are
   * both inside the element, or both outside, is not a relation of it.
   */
  relations(id: string): readonly Relation[];
  /**
   * `relations`, grouped by label, each element once, those the board does not
   * hold left out. A state of a lifecycle adds the states its transitions lead
   * to (`leads to`) and the states that lead to it (`reached from`), which the
   * lens lights too: they are relations of the lifecycle, not links of the board.
   */
  groups(id: string): readonly RelationGroup[];
  lens(id: string): Lens;
}

/** Where the items of each column live; what a unit holds is its structure. */
const COLUMN_HOME: Record<
  BoardColumnId,
  (item: BoardItem, root: boolean) => ElementHome
> = {
  team: (_item, root) => root ? "team" : "structure",
  cando: (item) => item.steps?.length ? "behavior" : "explore",
  rules: () => "explore",
  guarantees: (item) =>
    item.track
      ? "behavior"
      : item.kind === "requirement" || item.kind === "constraint"
      ? "requirements"
      : "explore",
  information: () => "explore",
};

function ofItem(
  item: BoardItem,
  column: BoardColumnId,
  home: ElementHome,
  parent: string | undefined,
): BoardElement {
  return {
    id: item.id,
    element: item.element,
    kind: item.kind,
    keyword: item.keyword,
    title: item.title,
    qname: item.qname,
    file: item.file,
    line: item.line,
    type: item.type,
    summary: item.summary,
    summarySource: item.summarySource,
    values: item.values,
    expression: item.expression,
    home,
    column,
    parent,
    scope: item.scope,
  };
}

const ofPort = (
  port: BoardPort,
  column: BoardColumnId,
  parent: string,
): BoardElement => ({
  id: port.id,
  element: port.element,
  kind: "port",
  keyword: port.keyword,
  title: port.title,
  qname: port.qname,
  file: port.file,
  line: port.line,
  type: port.type,
  home: "structure",
  column,
  parent,
});

const ofStep = (
  step: BoardStep,
  column: BoardColumnId,
  parent: string,
): BoardElement => ({
  id: step.id,
  element: step.element,
  kind: step.kind,
  keyword: step.keyword ?? "",
  title: step.title ?? step.toTitle ?? step.kind,
  qname: step.qname,
  file: step.file,
  line: step.line,
  type: step.type,
  guard: step.guard,
  home: "behavior",
  column,
  parent,
});

const ofClause = (
  clause: BoardClause,
  column: BoardColumnId,
  parent: string,
): BoardElement => ({
  id: clause.id,
  element: clause.element,
  kind: "clause",
  keyword: clause.keyword,
  title: clause.title,
  qname: clause.qname,
  file: clause.file,
  line: clause.line,
  expression: clause.expression,
  home: "requirements",
  column,
  parent,
});

const ofState = (
  state: BoardTrackState,
  column: BoardColumnId,
  parent: string,
): BoardElement => ({
  id: state.id,
  element: state.element,
  kind: "state",
  keyword: state.keyword,
  title: state.title,
  qname: state.qname,
  file: state.file,
  line: state.line,
  home: "behavior",
  column,
  parent,
});

function build(board: ModelBoard): BoardIndex {
  const elements = new Map<string, BoardElement>();
  // The steps among the elements: a step is the one element whose parent is its flow.
  const steps = new Set<string>();
  const add = (element: BoardElement) => {
    // The first declaration of an id is the element; a repeat is a twin of it.
    if (!elements.has(element.id)) elements.set(element.id, element);
  };
  // The transitions of the lifecycles: the states each leads to, and is reached from.
  const leadsTo = new Map<string, string[]>();
  const reachedFrom = new Map<string, string[]>();
  const walk = (
    item: BoardItem,
    column: BoardColumnId,
    parent: string | undefined,
  ) => {
    const home = COLUMN_HOME[column](item, parent === undefined);
    add(ofItem(item, column, home, parent));
    for (const port of item.ports ?? []) add(ofPort(port, column, item.id));
    for (const step of item.steps ?? []) {
      add(ofStep(step, column, item.id));
      steps.add(step.id);
    }
    for (const clause of item.clauses ?? []) {
      add(ofClause(clause, column, item.id));
    }
    for (const state of item.track?.states ?? []) {
      add(ofState(state, column, item.id));
      for (const transition of state.out) {
        (leadsTo.get(state.id) ?? leadsTo.set(state.id, []).get(state.id)!)
          .push(transition.to);
        (reachedFrom.get(transition.to) ??
          reachedFrom.set(transition.to, []).get(transition.to)!)
          .push(state.id);
      }
    }
    for (const child of item.children ?? []) walk(child, column, item.id);
  };
  for (const column of board.columns) {
    for (const item of column.items) walk(item, column.id, undefined);
  }

  const byElement = new Map<string, string>();
  for (const [id, element] of elements) {
    if (element.element && !byElement.has(element.element)) {
      byElement.set(element.element, id);
    }
  }
  const resolve = (id: string): string | null => {
    if (elements.has(id)) return id;
    const native = byElement.get(id);
    if (native !== undefined) return native;
    const card = Object.hasOwn(board.index, id)
      ? board.index[id].card
      : undefined;
    return card !== undefined && elements.has(card) ? card : null;
  };

  const within = (id: string, root: string): boolean => {
    // The chain is a tree; the bound keeps a board that is not one from looping.
    let at: string | undefined = id;
    for (let steps = 0; at !== undefined && steps <= elements.size; steps++) {
      if (at === root) return true;
      at = elements.get(at)?.parent;
    }
    return false;
  };

  // The units are the items of the team column; everything else answers to one.
  const units = board.columns.filter((column) => column.id === "team")
    .flatMap((column) => column.items);
  const unitIds = new Set(units.map((unit) => unit.id));
  const unitOf = (name: string): string | null => {
    let at: string | undefined = resolve(name) ?? name;
    for (let steps = 0; at !== undefined && steps <= elements.size; steps++) {
      if (unitIds.has(at)) return at;
      const element = elements.get(at);
      if (element?.scope !== undefined && unitIds.has(element.scope)) {
        return element.scope;
      }
      at = element?.parent;
    }
    return null;
  };

  const ends = board.links.map((link) => ({
    link,
    from: resolve(link.from) ?? link.from,
    to: resolve(link.to) ?? link.to,
  }));
  const labels = board.meta.linkLabels ?? {};
  const known = new Map<string, readonly Relation[]>();
  const relations = (id: string): readonly Relation[] => {
    const held = known.get(id);
    if (held) return held;
    const out: Relation[] = [];
    for (const { link, from, to } of ends) {
      if (link.strength === "scope" || link.kind === "own") continue;
      const fromHere = within(from, id), toHere = within(to, id);
      if (fromHere === toHere) continue;
      const key = link.role ? `${link.kind}:${link.role}` : link.kind;
      const names = Object.hasOwn(labels, key) ? labels[key] : undefined;
      out.push({
        link,
        other: fromHere ? to : from,
        label: names?.[fromHere ? "forward" : "reverse"] ?? key,
      });
    }
    known.set(id, out);
    return out;
  };

  /**
   * What a state is related to by the transitions of its lifecycle: the states
   * it leads to and the states that lead to it. They are not links of the
   * board, so they are told apart from `relations`, and read the same way.
   */
  const transitionsOf = (id: string) => [
    ...(leadsTo.get(id) ?? []).map((other) => ({ other, label: "leads to" })),
    ...(reachedFrom.get(id) ?? []).map((other) => ({
      other,
      label: "reached from",
    })),
  ];

  const flowOf = (id: string): string | null =>
    steps.has(id) ? elements.get(id)?.parent ?? null : null;

  return {
    units,
    get: (id) => elements.get(id),
    resolve,
    within,
    unitOf,
    flowOf,
    linked: (kind) => ends.filter(({ link }) => link.kind === kind),
    relations,
    groups(id) {
      const byLabel = new Map<string, Map<string, BoardElement>>();
      const put = (label: string, other: string) => {
        const element = elements.get(other);
        if (!element) return;
        const group = byLabel.get(label) ?? new Map<string, BoardElement>();
        byLabel.set(label, group);
        group.set(other, element);
      };
      for (const { label, other } of relations(id)) put(label, other);
      for (const { label, other } of transitionsOf(id)) put(label, other);
      return [...byLabel].map(([label, others]) => ({
        label,
        others: [...others.values()],
      }));
    },
    lens(id) {
      const mine = [...relations(id), ...transitionsOf(id)];
      return {
        selected: id,
        labels(of) {
          const out = new Set<string>();
          for (const { other, label } of mine) {
            if (within(other, of) || within(of, other)) out.add(label);
          }
          return [...out];
        },
        own(of) {
          const out = new Set<string>();
          for (const { other, label } of mine) if (other === of) out.add(label);
          return [...out];
        },
        context: (of) => of !== id && (within(id, of) || within(of, id)),
      };
    },
  };
}

/**
 * The units that are agents: the scopes of the team column, in the board's
 * order. What else the column holds is not someone who acts.
 */
export const agentUnits = (index: Pick<BoardIndex, "units">): BoardItem[] =>
  index.units.filter((unit) => unit.kind === "scope");

const indexes = new WeakMap<ModelBoard, BoardIndex>();

/** The index of a board: built the first time, the same one after. */
export function indexBoard(board: ModelBoard): BoardIndex {
  let index = indexes.get(board);
  if (!index) indexes.set(board, index = build(board));
  return index;
}
